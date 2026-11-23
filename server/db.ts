import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** `foreman.db` in the project root, unless FOREMAN_DB says otherwise. */
export const DEFAULT_DB_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "foreman.db");

/**
 * Schema steps, applied in order and tracked with `PRAGMA user_version`.
 * Add a step to change the schema; never edit one that has shipped.
 */
const MIGRATIONS: string[] = [
  /* 1 */ `
    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL            -- JSON
    );
    -- Event ids already notified (so a restart doesn't re-notify) and ids viewed in the page.
    CREATE TABLE seen (
      kind TEXT NOT NULL CHECK (kind IN ('notified', 'viewed')),
      id   TEXT NOT NULL,
      at   INTEGER NOT NULL,         -- epoch ms
      PRIMARY KEY (kind, id)
    ) WITHOUT ROWID;
    CREATE INDEX seen_at ON seen (at);
    -- Argo apps hidden from the Cluster list; one list for both environments.
    CREATE TABLE hidden_apps (
      app       TEXT PRIMARY KEY,
      hidden_at TEXT NOT NULL
    );
    -- Every sync and restart, with Argo's answer. Never holds a secret.
    CREATE TABLE cluster_actions (
      id     INTEGER PRIMARY KEY,
      at     TEXT NOT NULL,
      env    TEXT NOT NULL,
      app    TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL
    );
  `,
  /* 2 */ `
    -- Night Shift tab: every /health check, App Platform status poll and manual tick. Kept 7 days.
    CREATE TABLE night_shift_health (
      id     INTEGER PRIMARY KEY,
      at     TEXT NOT NULL,          -- ISO time
      ok     INTEGER NOT NULL,
      status INTEGER,                -- HTTP status; null when there was no response
      ms     INTEGER,
      error  TEXT
    );
    CREATE INDEX night_shift_health_at ON night_shift_health (at);
    CREATE TABLE night_shift_status (
      id   INTEGER PRIMARY KEY,
      at   TEXT NOT NULL,
      data TEXT NOT NULL             -- JSON StatusPoll
    );
    CREATE INDEX night_shift_status_at ON night_shift_status (at);
    CREATE TABLE night_shift_ticks (
      id      INTEGER PRIMARY KEY,
      at      TEXT NOT NULL,
      result  TEXT NOT NULL,
      status  INTEGER,
      message TEXT
    );
    CREATE INDEX night_shift_ticks_at ON night_shift_ticks (at);
  `,
  /* 3 */ `
    -- Idea board: things to do someday that aren't in Linear yet.
    CREATE TABLE ideas (
      id         INTEGER PRIMARY KEY,
      title      TEXT NOT NULL,
      pitch      TEXT NOT NULL DEFAULT '',
      body       TEXT NOT NULL DEFAULT '',  -- markdown
      stage      TEXT NOT NULL DEFAULT 'spark'
                 CHECK (stage IN ('spark', 'shaping', 'waiting', 'ready', 'line', 'shelved')),
      waiting_on TEXT NOT NULL DEFAULT '',
      tags       TEXT NOT NULL DEFAULT '[]',  -- JSON array
      link       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- A running thread on each idea, from Matt or from Claude.
    CREATE TABLE idea_notes (
      id      INTEGER PRIMARY KEY,
      idea_id INTEGER NOT NULL REFERENCES ideas (id),
      author  TEXT NOT NULL CHECK (author IN ('matt', 'claude')),
      body    TEXT NOT NULL,
      at      TEXT NOT NULL
    );
    CREATE INDEX idea_notes_idea ON idea_notes (idea_id, at);
  `,
];

/** node:sqlite warns that it's experimental on first load; that's noise for a local tool. */
function loadSqlite(): typeof import("node:sqlite") {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite is an experimental feature")) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

export function openDb(path: string = process.env.FOREMAN_DB || DEFAULT_DB_PATH): Db {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 2000");
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Database migration ${v + 1} failed: ${(e as Error).message}`);
    }
  }
}

export function getSetting<T>(db: Db, key: string): T | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

export function setSetting(db: Db, key: string, value: unknown) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
    key,
    JSON.stringify(value),
  );
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

const IMPORTED_KEY = "legacy_import";

/**
 * One-time copy of the old JSON files from the merge-watch data folder.
 * The files are left in place. Returns what was imported, or null if this
 * already ran (or there was nothing to import).
 */
export function importLegacy(db: Db, dir: string): string[] | null {
  if (getSetting(db, IMPORTED_KEY)) return null;
  const read = (name: string): unknown => {
    const p = join(dir, name);
    if (!existsSync(p)) return undefined;
    try {
      return name.endsWith(".json") ? JSON.parse(readFileSync(p, "utf8")) : readFileSync(p, "utf8");
    } catch (e) {
      console.warn(`[db] skipping unreadable ${p}: ${(e as Error).message}`);
      return undefined;
    }
  };
  const done: string[] = [];

  transaction(db, () => {
    const config = read("config.json") as { sound?: unknown; port?: unknown } | undefined;
    if (config) {
      if (config.sound !== undefined) setSetting(db, "sound", config.sound);
      if (typeof config.port === "number") setSetting(db, "port", config.port);
      done.push("config.json");
    }

    const prefs = read("prefs.json");
    if (prefs && typeof prefs === "object") {
      setSetting(db, "prefs", prefs);
      done.push("prefs.json");
    }

    const seen = read("seen.json") as { notified?: Record<string, number>; viewed?: Record<string, number> } | undefined;
    if (seen) {
      const ins = db.prepare("INSERT OR IGNORE INTO seen (kind, id, at) VALUES (?, ?, ?)");
      for (const kind of ["notified", "viewed"] as const)
        for (const [id, at] of Object.entries(seen[kind] ?? {})) if (typeof at === "number") ins.run(kind, id, at);
      done.push("seen.json");
    }

    const hidden = read("cluster-hidden.json") as { hidden?: unknown } | undefined;
    if (hidden && Array.isArray(hidden.hidden)) {
      const ins = db.prepare("INSERT OR IGNORE INTO hidden_apps (app, hidden_at) VALUES (?, ?)");
      const now = new Date().toISOString();
      for (const app of hidden.hidden) if (typeof app === "string") ins.run(app, now);
      done.push("cluster-hidden.json");
    }

    const log = read("cluster-actions.log");
    if (typeof log === "string") {
      const ins = db.prepare("INSERT INTO cluster_actions (at, env, app, action, result) VALUES (?, ?, ?, ?, ?)");
      for (const line of log.split("\n")) {
        try {
          const e = JSON.parse(line) as Record<string, string>;
          if (e.at && e.env && e.app && e.action) ins.run(e.at, e.env, e.app, e.action, e.result ?? "");
        } catch {}
      }
      done.push("cluster-actions.log");
    }

    setSetting(db, IMPORTED_KEY, { at: new Date().toISOString(), from: dir, files: done });
  });
  return done.length ? done : null;
}
