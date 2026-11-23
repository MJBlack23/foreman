import { describe, expect, it } from "vitest";
import { QueueWatcher } from "./queue.ts";

const issueNode = (id: string, team: string, labels: string[] = [], state = { name: "To Do", type: "unstarted", color: "#ccc" }) => ({
  linearId: `uuid-${id}`,
  identifier: id,
  title: `Issue ${id}`,
  url: `https://linear.app/x/issue/${id}`,
  priority: 3,
  createdAt: "2026-11-20T00:00:00Z",
  updatedAt: "2026-11-20T00:00:00Z",
  state,
  team: { key: team },
  assignee: { name: "matt", isMe: true },
  labels: { nodes: labels.map((name) => ({ name })) },
  attachments: { nodes: [] },
});

/** A stand-in Linear GraphQL endpoint that records what it was asked. */
function fakeLinear(opts: { nodes: unknown[]; mutationError?: string }) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body));
    calls.push({ query, variables });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (query.includes("issueLabels")) return json({ data: { issueLabels: { nodes: [{ id: `label-${variables.team}` }] } } });
    if (query.includes("workflowStates")) {
      return json({
        data: {
          workflowStates: {
            nodes: [
              { id: "state-later", name: "Ready", type: "unstarted", color: "#aaa", position: 5 },
              { id: `todo-${variables.team}`, name: "To Do (Sprint Backlog)", type: "unstarted", color: "#bbb", position: 1 },
            ],
          },
        },
      });
    }
    if (query.includes("issueUpdate")) return json({ data: { issueUpdate: { success: true } } });
    if (query.includes("issueAddLabel")) {
      return opts.mutationError ? json({ errors: [{ message: opts.mutationError }] }) : json({ data: { issueAddLabel: { success: true } } });
    }
    return json({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes: opts.nodes } } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fakeFetch, calls };
}

async function watcher(opts: Parameters<typeof fakeLinear>[0], confirm?: () => Promise<boolean>) {
  const linear = fakeLinear(opts);
  const w = new QueueWatcher({
    apiKey: "lin_api_secret",
    prs: () => [],
    branchesMatching: async () => new Map(),
    fetch: linear.fetch,
    confirm,
  });
  await w.poll();
  w.stop();
  return { w, calls: linear.calls };
}

describe("sendToNightShift", () => {
  it("adds the issue's team label by UUID and shows it at once", async () => {
    const { w, calls } = await watcher({ nodes: [issueNode("GRO-1", "GRO")] });
    expect(await w.sendToNightShift("GRO-1")).toEqual({ result: "sent" });
    const lookup = calls.find((c) => c.query.includes("issueLabels"))!;
    expect(lookup.variables).toEqual({ name: "night-shift-ready", team: "GRO" });
    const mutation = calls.find((c) => c.query.includes("issueAddLabel"))!;
    expect(mutation.variables).toEqual({ id: "uuid-GRO-1", labelId: "label-GRO" });
    expect(w.state().items[0]!.labels).toContain("night-shift-ready");
  });

  it("does nothing when the confirm is cancelled", async () => {
    const { w, calls } = await watcher({ nodes: [issueNode("PLAT-1", "PLAT")] }, async () => false);
    expect(await w.sendToNightShift("PLAT-1")).toEqual({ result: "cancelled" });
    expect(calls.some((c) => c.query.includes("issueAddLabel"))).toBe(false);
  });

  it("skips issues that already have the label", async () => {
    const { w, calls } = await watcher({ nodes: [issueNode("PLAT-1", "PLAT", ["night-shift-ready"])] });
    expect(await w.sendToNightShift("PLAT-1")).toEqual({ result: "already" });
    expect(calls.some((c) => c.query.includes("issueAddLabel"))).toBe(false);
  });

  it("refuses issues that aren't queued", async () => {
    const { w } = await watcher({ nodes: [] });
    await expect(w.sendToNightShift("PLAT-404")).rejects.toThrow("isn't in the queue");
  });

  it("explains a read-only key", async () => {
    const { w } = await watcher({ nodes: [issueNode("PLAT-1", "PLAT")], mutationError: "Forbidden: insufficient permission" });
    await expect(w.sendToNightShift("PLAT-1")).rejects.toThrow("needs Write access");
  });

  it("moves a blocked ticket to To Do before labelling it", async () => {
    const blocked = { name: "Blocked", type: "started", color: "#f00" };
    const { w, calls } = await watcher({ nodes: [issueNode("PLAT-7", "PLAT", [], blocked)] });
    expect(await w.sendToNightShift("PLAT-7")).toEqual({ result: "sent", movedTo: "To Do (Sprint Backlog)" });
    const writes = calls.filter((c) => c.query.startsWith("mutation"));
    expect(writes.map((c) => (c.query.includes("issueUpdate") ? "move" : "label"))).toEqual(["move", "label"]);
    expect(writes[0]!.variables).toEqual({ id: "uuid-PLAT-7", stateId: "todo-PLAT" });
    const item = w.state().items[0]!;
    expect(item.state.name).toBe("To Do (Sprint Backlog)");
    expect(item.ownLane).toBe("next");
  });

  it("leaves other states alone", async () => {
    const { w, calls } = await watcher({ nodes: [issueNode("PLAT-8", "PLAT", [], { name: "In Progress", type: "started", color: "#0f0" })] });
    expect(await w.sendToNightShift("PLAT-8")).toEqual({ result: "sent" });
    expect(calls.some((c) => c.query.includes("workflowStates") || c.query.includes("issueUpdate"))).toBe(false);
  });

  it("doesn't move anything when the confirm is cancelled", async () => {
    const blocked = { name: "Blocked", type: "started", color: "#f00" };
    const { w, calls } = await watcher({ nodes: [issueNode("PLAT-9", "PLAT", [], blocked)] }, async () => false);
    expect(await w.sendToNightShift("PLAT-9")).toEqual({ result: "cancelled" });
    expect(calls.some((c) => c.query.startsWith("mutation"))).toBe(false);
  });
});
