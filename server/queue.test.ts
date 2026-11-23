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
    if (query.includes("viewer")) return json({ data: { viewer: { id: "user-me", name: "Matt Black", displayName: "matt" } } });
    if (query.includes("issueUpdate")) {
      return opts.mutationError ? json({ errors: [{ message: opts.mutationError }] }) : json({ data: { issueUpdate: { success: true } } });
    }
    return json({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes: opts.nodes } } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fakeFetch, calls };
}

async function watcher(opts: Parameters<typeof fakeLinear>[0]) {
  const linear = fakeLinear(opts);
  const w = new QueueWatcher({
    apiKey: "lin_api_secret",
    prs: () => [],
    branchesMatching: async () => new Map(),
    fetch: linear.fetch,
  });
  await w.poll();
  w.stop();
  return { w, calls: linear.calls };
}

describe("sendToNightShift", () => {
  const sendWrites = (calls: { query: string; variables: Record<string, unknown> }[]) => calls.filter((c) => c.query.startsWith("mutation"));

  it("assigns to me, moves to To Do and adds the team label in one write", async () => {
    const unassigned = { ...issueNode("GRO-1", "GRO", [], { name: "Backlog", type: "backlog", color: "#ddd" }), assignee: null };
    const { w, calls } = await watcher({ nodes: [unassigned] });
    expect(await w.sendToNightShift("GRO-1")).toEqual({ result: "sent", movedTo: "To Do (Sprint Backlog)" });
    const lookup = calls.find((c) => c.query.includes("issueLabels"))!;
    expect(lookup.variables).toEqual({ name: "night-shift-ready", team: "GRO" });
    const writes = sendWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.query).toContain("issueUpdate");
    expect(writes[0]!.variables).toEqual({
      id: "uuid-GRO-1",
      input: { assigneeId: "user-me", stateId: "todo-GRO", addedLabelIds: ["label-GRO"] },
    });
    const item = w.state().items[0]!;
    expect(item.labels).toContain("night-shift-ready");
    expect(item.state.name).toBe("To Do (Sprint Backlog)");
    expect(item.assignee).toEqual({ name: "matt", isMe: true });
  });

  it("moves a blocked or started ticket back to To Do", async () => {
    for (const state of [
      { name: "Blocked", type: "started", color: "#f00" },
      { name: "In Progress", type: "started", color: "#0f0" },
    ]) {
      const { w, calls } = await watcher({ nodes: [issueNode("PLAT-7", "PLAT", [], state)] });
      expect(await w.sendToNightShift("PLAT-7")).toEqual({ result: "sent", movedTo: "To Do (Sprint Backlog)" });
      expect(sendWrites(calls)[0]!.variables.input).toMatchObject({ stateId: "todo-PLAT" });
      expect(w.state().items[0]!.ownLane).toBe("next");
    }
  });

  it("doesn't report a move when it's already in To Do", async () => {
    const todo = { name: "To Do (Sprint Backlog)", type: "unstarted", color: "#bbb" };
    const { w } = await watcher({ nodes: [issueNode("PLAT-8", "PLAT", [], todo)] });
    expect(await w.sendToNightShift("PLAT-8")).toEqual({ result: "sent" });
  });

  it("skips issues that already have the label", async () => {
    const { w, calls } = await watcher({ nodes: [issueNode("PLAT-1", "PLAT", ["night-shift-ready"])] });
    expect(await w.sendToNightShift("PLAT-1")).toEqual({ result: "already" });
    expect(sendWrites(calls)).toHaveLength(0);
  });

  it("refuses issues that aren't queued", async () => {
    const { w } = await watcher({ nodes: [] });
    await expect(w.sendToNightShift("PLAT-404")).rejects.toThrow("isn't in the queue");
  });

  it("explains a read-only key and changes nothing locally", async () => {
    const { w } = await watcher({ nodes: [issueNode("PLAT-1", "PLAT")], mutationError: "Forbidden: insufficient permission" });
    await expect(w.sendToNightShift("PLAT-1")).rejects.toThrow("needs Write access");
    expect(w.state().items[0]!.labels).not.toContain("night-shift-ready");
  });
});
