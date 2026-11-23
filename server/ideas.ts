import type { Context, Hono, Next } from "hono";
import { type Idea, type IdeaNote, type IdeaPatch, parseNote, parsePatch, type Stage } from "../core/ideas.ts";
import { type Db, transaction } from "./db.ts";

interface IdeaRow {
  id: number;
  title: string;
  pitch: string;
  body: string;
  stage: Stage;
  waiting_on: string;
  tags: string;
  link: string;
  created_at: string;
  updated_at: string;
}

interface NoteRow {
  id: number;
  idea_id: number;
  author: "matt" | "claude";
  body: string;
  at: string;
}

const COLUMNS: Record<keyof IdeaPatch, string> = {
  title: "title",
  pitch: "pitch",
  body: "body",
  stage: "stage",
  waitingOn: "waiting_on",
  tags: "tags",
  link: "link",
};

/** The `ideas` and `idea_notes` tables. Every change tells subscribers (the page, over SSE). */
export class IdeasStore {
  private listeners = new Set<(ideas: Idea[]) => void>();

  constructor(
    private db: Db,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  list(): Idea[] {
    const rows = this.db.prepare("SELECT * FROM ideas ORDER BY updated_at DESC").all() as unknown as IdeaRow[];
    const notes = this.db.prepare("SELECT * FROM idea_notes ORDER BY at, id").all() as unknown as NoteRow[];
    const byIdea = new Map<number, IdeaNote[]>();
    for (const n of notes) {
      const list = byIdea.get(n.idea_id) ?? [];
      list.push(toNote(n));
      byIdea.set(n.idea_id, list);
    }
    return rows.map((r) => toIdea(r, byIdea.get(r.id) ?? []));
  }

  get(id: number): Idea | null {
    const row = this.db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as unknown as IdeaRow | undefined;
    if (!row) return null;
    const notes = this.db.prepare("SELECT * FROM idea_notes WHERE idea_id = ? ORDER BY at, id").all(id) as unknown as NoteRow[];
    return toIdea(row, notes.map(toNote));
  }

  create(p: IdeaPatch & { title: string }): Idea {
    const at = this.now();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO ideas (title, pitch, body, stage, waiting_on, tags, link, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.title, p.pitch ?? "", p.body ?? "", p.stage ?? "spark", p.waitingOn ?? "", JSON.stringify(p.tags ?? []), p.link ?? "", at, at);
    this.emit();
    return this.get(Number(lastInsertRowid))!;
  }

  update(id: number, p: IdeaPatch): Idea | null {
    const keys = Object.keys(p) as (keyof IdeaPatch)[];
    if (!this.get(id)) return null;
    if (keys.length) {
      const sets = keys.map((k) => `${COLUMNS[k]} = ?`).join(", ");
      const values = keys.map((k) => (k === "tags" ? JSON.stringify(p.tags) : (p[k] as string)));
      this.db.prepare(`UPDATE ideas SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, this.now(), id);
      this.emit();
    }
    return this.get(id);
  }

  remove(id: number): boolean {
    const removed = transaction(this.db, () => {
      this.db.prepare("DELETE FROM idea_notes WHERE idea_id = ?").run(id);
      return this.db.prepare("DELETE FROM ideas WHERE id = ?").run(id).changes > 0;
    });
    if (removed) this.emit();
    return removed;
  }

  addNote(id: number, author: "matt" | "claude", body: string): Idea | null {
    if (!this.get(id)) return null;
    const at = this.now();
    transaction(this.db, () => {
      this.db.prepare("INSERT INTO idea_notes (idea_id, author, body, at) VALUES (?, ?, ?, ?)").run(id, author, body, at);
      this.db.prepare("UPDATE ideas SET updated_at = ? WHERE id = ?").run(at, id);
    });
    this.emit();
    return this.get(id);
  }

  removeNote(ideaId: number, noteId: number): boolean {
    const ok = this.db.prepare("DELETE FROM idea_notes WHERE id = ? AND idea_id = ?").run(noteId, ideaId).changes > 0;
    if (ok) this.emit();
    return ok;
  }

  subscribe(fn: (ideas: Idea[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    if (!this.listeners.size) return;
    const ideas = this.list();
    for (const fn of this.listeners) fn(ideas);
  }
}

function toIdea(r: IdeaRow, notes: IdeaNote[]): Idea {
  let tags: string[] = [];
  try {
    tags = JSON.parse(r.tags);
  } catch {}
  return {
    id: r.id,
    title: r.title,
    pitch: r.pitch,
    body: r.body,
    stage: r.stage,
    waitingOn: r.waiting_on,
    tags,
    link: r.link,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    notes,
  };
}

const toNote = (n: NoteRow): IdeaNote => ({ id: n.id, ideaId: n.idea_id, author: n.author, body: n.body, at: n.at });

/**
 * Writes are open to the page and to local clients such as Claude Code's curl,
 * which send no Origin. A request from any other web origin is refused, and
 * the JSON content type means a cross-site page can't send one without a CORS
 * preflight, which this server never answers.
 */
export function ideaWriteAllowed(origin: string | undefined, contentType: string | undefined, allowed: string[]): boolean {
  if (origin && !allowed.includes(origin)) return false;
  return /^application\/json\b/i.test(contentType ?? "");
}

export function ideaRoutes(app: Hono, store: IdeasStore, origins: string[]) {
  const guard = async (c: Context, next: Next) => {
    if (c.req.method !== "GET" && !ideaWriteAllowed(c.req.header("origin"), c.req.header("content-type"), origins)) {
      return c.json({ error: "Forbidden: send JSON (content-type: application/json) from the dashboard or a local client." }, 403);
    }
    await next();
  };
  app.use("/api/ideas", guard);
  app.use("/api/ideas/*", guard);

  const idParam = (s: string | undefined) => {
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);

  app.get("/api/ideas", (c) => c.json(store.list()));

  app.post("/api/ideas", async (c) => {
    const p = parsePatch(await body(c), { requireTitle: true });
    if (typeof p === "string") return c.json({ error: p }, 400);
    return c.json(store.create(p as IdeaPatch & { title: string }), 201);
  });

  app.get("/api/ideas/:id", (c) => {
    const id = idParam(c.req.param("id"));
    const idea = id && store.get(id);
    return idea ? c.json(idea) : c.json({ error: "No such idea." }, 404);
  });

  app.patch("/api/ideas/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.json({ error: "No such idea." }, 404);
    const p = parsePatch(await body(c), { requireTitle: false });
    if (typeof p === "string") return c.json({ error: p }, 400);
    const idea = store.update(id, p);
    return idea ? c.json(idea) : c.json({ error: "No such idea." }, 404);
  });

  app.delete("/api/ideas/:id", (c) => {
    const id = idParam(c.req.param("id"));
    return id && store.remove(id) ? c.json({ ok: true }) : c.json({ error: "No such idea." }, 404);
  });

  app.post("/api/ideas/:id/notes", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!id) return c.json({ error: "No such idea." }, 404);
    const n = parseNote(await body(c));
    if (typeof n === "string") return c.json({ error: n }, 400);
    const idea = store.addNote(id, n.author, n.body);
    return idea ? c.json(idea, 201) : c.json({ error: "No such idea." }, 404);
  });

  app.delete("/api/ideas/:id/notes/:noteId", (c) => {
    const id = idParam(c.req.param("id"));
    const noteId = idParam(c.req.param("noteId"));
    return id && noteId && store.removeNote(id, noteId) ? c.json({ ok: true }) : c.json({ error: "No such note." }, 404);
  });
}
