import { afterEach, describe, expect, it, vi } from "vitest";
import { NIGHT_SHIFT_APP_ID, NIGHT_SHIFT_URL } from "../core/nightShift.ts";
import type { PlannedNotification } from "../core/seen.ts";
import { openDb } from "./db.ts";
import { NightShiftStore, NightShiftWatcher } from "./nightShift.ts";
import { SeenStore } from "./store.ts";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function setup(opts: { doToken?: string | null; tickSecret?: string | null; handler: Handler; confirm?: boolean }) {
  const db = openDb(":memory:");
  const store = new NightShiftStore(db);
  const notes: PlannedNotification[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  let nowMs = Date.parse("2026-11-20T12:00:00Z");
  const w = new NightShiftWatcher({
    config: { doToken: opts.doToken === undefined ? "do-token" : opts.doToken, tickSecret: opts.tickSecret === undefined ? "s3cret" : opts.tickSecret },
    store,
    seen: new SeenStore(db),
    notify: (n) => notes.push(n),
    dashboardUrl: "http://localhost:7896",
    confirm: opts.confirm === undefined ? undefined : async () => opts.confirm!,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return opts.handler(url, init);
    }) as typeof fetch,
    now: () => nowMs,
  });
  return { w, store, notes, calls, advance: (min: number) => (nowMs += min * 60_000) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const doHandler =
  (health: () => Response): Handler =>
  (url) => {
    if (url === `${NIGHT_SHIFT_URL}/health`) return health();
    if (url.endsWith(`/apps/${NIGHT_SHIFT_APP_ID}`))
      return json({ app: { active_deployment: { id: "a", phase: "ACTIVE", services: [{ source_commit_hash: "abc1234" }] } } });
    if (url.includes(`/apps/${NIGHT_SHIFT_APP_ID}/deployments`)) return json({ deployments: [{ id: "a", phase: "ACTIVE" }] });
    return new Response("nope", { status: 404 });
  };

afterEach(() => vi.useRealTimers());

describe("NightShiftWatcher", () => {
  it("records a health check and a status poll, and is healthy", async () => {
    const { w, calls } = setup({ handler: doHandler(() => json({ ok: true })) });
    await w.checkNow();
    const s = w.state();
    expect(s.health.state).toBe("up");
    expect(s.status?.active?.commit).toBe("abc1234");
    expect(s.overall).toBe("ok");
    const doCall = calls.find((c) => c.url.includes("api.digitalocean.com"))!;
    expect((doCall.init?.headers as Record<string, string>).authorization).toBe("Bearer do-token");
  });

  it("notifies once after two failed checks, then once on recovery", async () => {
    let up = false;
    const { w, notes, advance } = setup({ doToken: null, handler: doHandler(() => (up ? json({ ok: true }) : new Response("", { status: 503 }))) });
    await w.checkNow();
    expect(notes).toEqual([]);
    advance(10);
    await w.checkNow();
    expect(notes.map((n) => n.title)).toEqual(["Night Shift is down"]);
    expect(notes[0]!.url).toBe("http://localhost:7896/night-shift");
    advance(10);
    await w.checkNow();
    expect(notes).toHaveLength(1);
    up = true;
    advance(10);
    await w.checkNow();
    expect(notes.map((n) => n.title)).toEqual(["Night Shift is down", "Night Shift is back up"]);
  });

  it("skips the status poll and names the variable when DO_API_TOKEN is missing", async () => {
    const { w, calls } = setup({ doToken: null, handler: doHandler(() => json({ ok: true })) });
    await w.checkNow();
    expect(calls.some((c) => c.url.includes("api.digitalocean.com"))).toBe(false);
    expect(w.state()).toMatchObject({ canPollStatus: false, missing: ["DO_API_TOKEN"] });
  });

  it("keeps the last good deployment when a poll fails, without leaking the token", async () => {
    let fail = false;
    const { w } = setup({
      doToken: "do-token",
      handler: (url, init) => (fail && url.includes("api.digitalocean.com") ? json({ message: "bad do-token" }, 401) : doHandler(() => json({ ok: true }))(url, init)),
    });
    await w.checkNow();
    fail = true;
    await w.checkNow();
    const s = w.state().status!;
    expect(s.ok).toBe(false);
    expect(s.error).toContain("DigitalOcean 401");
    expect(s.error).not.toContain("do-token");
    expect(s.active?.id).toBe("a");
  });

  it("sends a tick with the bearer secret and records the reply", async () => {
    const { w, calls } = setup({ confirm: true, handler: () => json({ started: true }, 202) });
    const r = await w.tick();
    expect(r).toMatchObject({ result: "started", status: 202 });
    expect(calls[0]!.url).toBe(`${NIGHT_SHIFT_URL}/tick`);
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
    expect(w.state().ticks).toHaveLength(1);
  });

  it("records a 409 as already running", async () => {
    const { w } = setup({ handler: () => json({ error: "a tick is already running" }, 409) });
    expect(await w.tick()).toMatchObject({ result: "already-running", message: "a tick is already running" });
  });

  it("does nothing when the confirm dialog is cancelled", async () => {
    const { w, calls } = setup({ confirm: false, handler: () => json({}, 202) });
    expect(await w.tick()).toEqual({ result: "cancelled" });
    expect(calls).toEqual([]);
    expect(w.state().ticks).toEqual([]);
  });
});
