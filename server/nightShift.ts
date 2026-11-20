import type { Hono } from "hono";
import {
  deployAlerts,
  DO_CONSOLE_URL,
  downSince,
  HEALTH_EVERY_MS,
  HEALTH_TIMEOUT_MS,
  type HealthCheck,
  healthAlerts,
  healthState,
  HISTORY_MS,
  NIGHT_SHIFT_APP_ID,
  NIGHT_SHIFT_REPO_URL,
  NIGHT_SHIFT_URL,
  type NightShiftAlert,
  type NightShiftState,
  nextStatusDelay,
  overall,
  parseStatus,
  type StatusPoll,
  STRIP_MS,
  tickResult,
  type TickRecord,
  TICKS_SHOWN,
  uptimeStrip,
} from "../core/nightShift.ts";
import type { PlannedNotification } from "../core/seen.ts";
import { originAllowed } from "./cluster.ts";
import { type Db, transaction } from "./db.ts";
import type { SeenStore } from "./store.ts";

const DO_API = "https://api.digitalocean.com/v2";
const TICK_TIMEOUT_MS = 15_000;

export interface NightShiftConfig {
  doToken: string | null;
  tickSecret: string | null;
}

/** DO_API_TOKEN (read-only) and NIGHT_SHIFT_TICK_SECRET, from Doppler project `foreman`. Empty counts as missing. */
export function loadNightShiftConfig(env: Record<string, string | undefined> = process.env): NightShiftConfig {
  return {
    doToken: env.DO_API_TOKEN?.trim() || null,
    tickSecret: env.NIGHT_SHIFT_TICK_SECRET?.trim() || null,
  };
}

// ── Storage ──────────────────────────────────────────────────────────────

export class NightShiftStore {
  constructor(private db: Db) {}

  /** Checks since `sinceIso`, oldest first. */
  health(sinceIso: string): HealthCheck[] {
    const rows = this.db
      .prepare("SELECT at, ok, status, ms, error FROM night_shift_health WHERE at > ? ORDER BY at, id")
      .all(sinceIso) as { at: string; ok: number; status: number | null; ms: number | null; error: string | null }[];
    return rows.map((r) => ({ at: r.at, ok: !!r.ok, status: r.status, ms: r.ms, error: r.error }));
  }

  addHealth(c: HealthCheck) {
    this.db
      .prepare("INSERT INTO night_shift_health (at, ok, status, ms, error) VALUES (?, ?, ?, ?, ?)")
      .run(c.at, c.ok ? 1 : 0, c.status, c.ms, c.error);
  }

  lastStatus(): StatusPoll | null {
    const row = this.db.prepare("SELECT data FROM night_shift_status ORDER BY at DESC, id DESC LIMIT 1").get() as
      | { data: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as StatusPoll;
    } catch {
      return null;
    }
  }

  addStatus(s: StatusPoll) {
    this.db.prepare("INSERT INTO night_shift_status (at, data) VALUES (?, ?)").run(s.at, JSON.stringify(s));
  }

  ticks(limit = TICKS_SHOWN): TickRecord[] {
    return this.db
      .prepare("SELECT at, result, status, message FROM night_shift_ticks ORDER BY at DESC, id DESC LIMIT ?")
      .all(limit) as unknown as TickRecord[];
  }

  addTick(t: TickRecord) {
    this.db
      .prepare("INSERT INTO night_shift_ticks (at, result, status, message) VALUES (?, ?, ?, ?)")
      .run(t.at, t.result, t.status, t.message);
  }

  prune(nowMs: number) {
    const cutoff = new Date(nowMs - HISTORY_MS).toISOString();
    transaction(this.db, () => {
      for (const t of ["night_shift_health", "night_shift_status", "night_shift_ticks"])
        this.db.prepare(`DELETE FROM ${t} WHERE at < ?`).run(cutoff);
    });
  }
}

// ── Watcher ──────────────────────────────────────────────────────────────

export interface NightShiftDeps {
  config: NightShiftConfig;
  store: NightShiftStore;
  seen: SeenStore;
  notify: (n: PlannedNotification) => void;
  dashboardUrl: string;
  /** Native macOS dialog before a manual tick; undefined skips it (tests). */
  confirm?: (title: string, message: string, button: string) => Promise<boolean>;
  fetch?: typeof fetch;
  now?: () => number;
}

type Listener = (s: NightShiftState) => void;

export type TickOutcome = { result: "cancelled" | "busy" } | TickRecord;

export class NightShiftWatcher {
  private healthTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private nextHealthMs: number | null = null;
  private nextStatusMs: number | null = null;
  private checking = 0;
  private ticking = false;
  private stopped = true;
  private listeners = new Set<Listener>();
  private fetch: typeof fetch;
  private now: () => number;

  constructor(private deps: NightShiftDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  missing(): string[] {
    const { doToken, tickSecret } = this.deps.config;
    return [!doToken && "DO_API_TOKEN", !tickSecret && "NIGHT_SHIFT_TICK_SECRET"].filter((x): x is string => !!x);
  }

  /** Both checks right away, then on their own schedules. */
  start() {
    this.stopped = false;
    void this.checkNow();
  }

  stop() {
    this.stopped = true;
    if (this.healthTimer) clearTimeout(this.healthTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.healthTimer = this.statusTimer = null;
    this.nextHealthMs = this.nextStatusMs = null;
  }

  /** Run both checks now and restart both timers from here. */
  async checkNow(): Promise<void> {
    await Promise.all([this.runHealth(), this.runStatus()]);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  state(): NightShiftState {
    const nowMs = this.now();
    const checks = this.deps.store.health(new Date(nowMs - STRIP_MS).toISOString());
    const status = this.deps.store.lastStatus();
    const hs = healthState(checks);
    const strip = uptimeStrip(checks, nowMs);
    const missing = this.missing();
    return {
      url: NIGHT_SHIFT_URL,
      appId: NIGHT_SHIFT_APP_ID,
      consoleUrl: DO_CONSOLE_URL,
      repoUrl: NIGHT_SHIFT_REPO_URL,
      missing,
      canPollStatus: !!this.deps.config.doToken,
      canTick: !!this.deps.config.tickSecret,
      overall: overall(hs, status),
      health: {
        state: hs,
        last: checks[checks.length - 1] ?? null,
        downSince: downSince(checks),
        strip: strip.cells,
        uptimePct: strip.pct,
      },
      status,
      ticks: this.deps.store.ticks(),
      nextHealthAt: this.nextHealthMs ? new Date(this.nextHealthMs).toISOString() : null,
      nextStatusAt: this.nextStatusMs ? new Date(this.nextStatusMs).toISOString() : null,
      checking: this.checking > 0,
      ticking: this.ticking,
    };
  }

  /**
   * POST /tick after a native confirm. One manual tick at a time.
   * The secret is only ever sent in the Authorization header, never logged or returned.
   */
  async tick(): Promise<TickOutcome> {
    const secret = this.deps.config.tickSecret;
    if (!secret) throw new Error("NIGHT_SHIFT_TICK_SECRET isn't set");
    if (this.ticking) return { result: "busy" };
    this.ticking = true;
    this.emit();
    try {
      if (this.deps.confirm) {
        const ok = await this.deps.confirm(
          "Night Shift",
          "Send night-shift a tick now?\n\nA scheduled tick already runs every 10 minutes. A ticket still in To Do can be sent to its implementer again.",
          "Tick now",
        );
        if (!ok) return { result: "cancelled" };
      }
      let rec: TickRecord;
      const at = new Date(this.now()).toISOString();
      try {
        const res = await this.fetch(`${NIGHT_SHIFT_URL}/tick`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(TICK_TIMEOUT_MS),
        });
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const result = tickResult(res.status);
        rec = { at, result, status: res.status, message: result === "started" ? null : (body?.error ?? res.statusText ?? null) };
      } catch (e) {
        rec = { at, result: "error", status: null, message: errorText(e) };
      }
      this.deps.store.addTick(rec);
      return rec;
    } finally {
      this.ticking = false;
      this.emit();
    }
  }

  private async runHealth() {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = null;
    this.checking++;
    this.emit();
    try {
      const nowMs = this.now();
      const before = this.deps.store.health(new Date(nowMs - STRIP_MS).toISOString());
      const check = await this.checkHealth();
      this.deps.store.addHealth(check);
      this.deps.store.prune(nowMs);
      this.alert(healthAlerts(before, [...before, check]));
    } catch (e) {
      console.error(`[night-shift] health check failed to run: ${errorText(e)}`);
    } finally {
      this.checking--;
      this.schedule("health", HEALTH_EVERY_MS);
      this.emit();
    }
  }

  private async checkHealth(): Promise<HealthCheck> {
    const started = this.now();
    const at = new Date(started).toISOString();
    try {
      const res = await this.fetch(`${NIGHT_SHIFT_URL}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      await res.arrayBuffer().catch(() => {});
      const ms = this.now() - started;
      return { at, ok: res.ok, status: res.status, ms, error: res.ok ? null : res.statusText || null };
    } catch (e) {
      return { at, ok: false, status: null, ms: null, error: errorText(e) };
    }
  }

  private async runStatus() {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    const token = this.deps.config.doToken;
    if (!token) {
      this.nextStatusMs = null;
      return;
    }
    this.checking++;
    this.emit();
    let poll: StatusPoll | null = null;
    try {
      poll = await this.pollStatus(token);
      // A failed poll keeps the last good deployment info, so the card doesn't blank out.
      const prev = poll.ok ? null : this.deps.store.lastStatus();
      if (prev) poll = { ...poll, active: prev.active, latest: prev.latest, lastActiveAt: prev.lastActiveAt };
      this.deps.store.addStatus(poll);
      if (poll.ok) this.alert(deployAlerts(poll));
    } catch (e) {
      console.error(`[night-shift] status poll failed to run: ${errorText(e)}`);
    } finally {
      this.checking--;
      this.schedule("status", nextStatusDelay(poll));
      this.emit();
    }
  }

  private async pollStatus(token: string): Promise<StatusPoll> {
    const at = new Date(this.now()).toISOString();
    const get = async (path: string) => {
      const res = await this.fetch(`${DO_API}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(`DigitalOcean ${res.status}${body?.message ? `: ${body.message}` : ""}`);
      }
      return res.json();
    };
    try {
      const [app, deps] = await Promise.all([
        get(`/apps/${NIGHT_SHIFT_APP_ID}`),
        get(`/apps/${NIGHT_SHIFT_APP_ID}/deployments?page=1&per_page=1`),
      ]);
      return parseStatus(app?.app, deps?.deployments, at);
    } catch (e) {
      return { at, ok: false, error: errorText(e).replaceAll(token, "[redacted]"), active: null, latest: null, lastActiveAt: null };
    }
  }

  private schedule(which: "health" | "status", delay: number) {
    if (this.stopped) return;
    const at = this.now() + delay;
    if (which === "health") {
      this.nextHealthMs = at;
      this.healthTimer = setTimeout(() => void this.runHealth(), delay);
    } else {
      this.nextStatusMs = at;
      this.statusTimer = setTimeout(() => void this.runStatus(), delay);
    }
  }

  private alert(alerts: NightShiftAlert[]) {
    const seen = this.deps.seen.notifiedIds();
    const fresh = alerts.filter((a) => !seen.has(a.id));
    if (!fresh.length) return;
    this.deps.seen.markNotified(fresh.map((a) => a.id));
    for (const a of fresh)
      this.deps.notify({ kind: "summary", title: a.title, message: a.message, url: `${this.deps.dashboardUrl}/night-shift` });
  }

  private emit() {
    if (!this.listeners.size) return;
    const s = this.state();
    for (const fn of this.listeners) fn(s);
  }
}

function errorText(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError") return "timed out";
  return err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
}

// ── Routes ───────────────────────────────────────────────────────────────

export function nightShiftRoutes(app: Hono, svc: NightShiftWatcher, origins: string[]) {
  app.use("/api/night-shift/*", async (c, next) => {
    if (c.req.method !== "GET" && !originAllowed(c.req.header("origin"), c.req.header("content-type"), origins)) {
      return c.json({ error: "Forbidden: Night Shift actions must come from the dashboard page." }, 403);
    }
    await next();
  });

  app.get("/api/night-shift", (c) => c.json(svc.state()));

  app.post("/api/night-shift/check", async (c) => {
    await svc.checkNow();
    return c.json(svc.state());
  });

  app.post("/api/night-shift/tick", async (c) => {
    if (!svc.state().canTick) return c.json({ error: "NIGHT_SHIFT_TICK_SECRET isn't set." }, 400);
    return c.json(await svc.tick());
  });
}
