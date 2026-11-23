import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Idea } from "../core/ideas.ts";
import { openDb } from "./db.ts";
import { ideaRoutes, IdeasStore, ideaWriteAllowed } from "./ideas.ts";

const ORIGINS = ["http://localhost:7896"];

function setup() {
  let t = Date.parse("2026-11-23T10:00:00Z");
  const store = new IdeasStore(openDb(":memory:"), () => new Date((t += 1000)).toISOString());
  const app = new Hono();
  ideaRoutes(app, store, ORIGINS);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { store, call };
}

describe("ideas API", () => {
  it("creates an idea as a spark, updates it, and adds notes from Matt and Claude", async () => {
    const { call, store } = setup();
    const pushes: Idea[][] = [];
    store.subscribe((l) => pushes.push(l));

    const res = await call("POST", "/api/ideas", { title: "  Auto-review quarantined email  ", tags: ["Email", "claude", "email"] });
    expect(res.status).toBe(201);
    const idea = (await res.json()) as Idea;
    expect(idea).toMatchObject({ title: "Auto-review quarantined email", stage: "spark", tags: ["email", "claude"], notes: [] });

    const patched = (await (await call("PATCH", `/api/ideas/${idea.id}`, { stage: "waiting", waitingOn: "email rewrite" })).json()) as Idea;
    expect(patched).toMatchObject({ stage: "waiting", waitingOn: "email rewrite", title: "Auto-review quarantined email" });

    await call("POST", `/api/ideas/${idea.id}/notes`, { author: "claude", body: "Could run as a Claude routine." });
    const withNotes = (await (await call("POST", `/api/ideas/${idea.id}/notes`, { body: "Agreed" })).json()) as Idea;
    expect(withNotes.notes.map((n) => [n.author, n.body])).toEqual([
      ["claude", "Could run as a Claude routine."],
      ["matt", "Agreed"],
    ]);
    expect(withNotes.updatedAt > patched.updatedAt).toBe(true);
    expect(pushes).toHaveLength(4);
  });

  it("rejects bad input", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/ideas", { pitch: "no title" })).status).toBe(400);
    expect((await call("POST", "/api/ideas", { title: "x", stage: "done" })).status).toBe(400);
    expect((await call("POST", "/api/ideas", { title: "x", link: "javascript:alert(1)" })).status).toBe(400);
    expect((await call("PATCH", "/api/ideas/99", { title: "x" })).status).toBe(404);
    expect((await call("POST", "/api/ideas/99/notes", { body: "x" })).status).toBe(404);
  });

  it("deletes an idea with its notes", async () => {
    const { call, store } = setup();
    const { id } = store.create({ title: "x" });
    store.addNote(id, "matt", "n");
    expect((await call("DELETE", `/api/ideas/${id}`)).status).toBe(200);
    expect(store.list()).toEqual([]);
  });

  it("refuses writes from other web origins and non-JSON posts, and allows curl", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/ideas", { title: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("POST", "/api/ideas", { title: "x" }, { "content-type": "text/plain" })).status).toBe(403);
    expect((await call("POST", "/api/ideas", { title: "x" }, { origin: "http://localhost:7896" })).status).toBe(201);
    expect((await call("POST", "/api/ideas", { title: "x" })).status).toBe(201);
    expect(ideaWriteAllowed(undefined, "application/json; charset=utf-8", ORIGINS)).toBe(true);
  });
});
