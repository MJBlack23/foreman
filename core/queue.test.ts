import { describe, expect, it } from "vitest";
import {
  type BranchInfo,
  branchMatches,
  buildQueue,
  groupLane,
  type IssueRef,
  type LinearIssue,
  parseIssue,
  parsePr,
  pickBranch,
  STALE_AFTER_MS,
} from "./queue.ts";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const issue = (id: string, over: Partial<LinearIssue> = {}): LinearIssue => ({
  id,
  linearId: `uuid-${id}`,
  title: `Issue ${id}`,
  url: `https://linear.app/cloudspot/issue/${id}`,
  description: null,
  branchName: `matt/${id.toLowerCase()}-thing`,
  priority: 3,
  priorityLabel: "Medium",
  estimate: null,
  dueDate: null,
  createdAt: daysAgo(10),
  updatedAt: daysAgo(1),
  startedAt: null,
  state: { name: "To Do", type: "unstarted", color: "#ccc" },
  team: "PLAT",
  project: null,
  cycle: null,
  assignee: { name: "matt", isMe: true },
  parent: null,
  labels: [],
  prs: [],
  ...over,
});
const started = (name = "In Progress", d = 1) => ({ state: { name, type: "started", color: "#f00" }, startedAt: daysAgo(d) });
const pr = (status: string, extra: Record<string, unknown> = {}) => ({
  url: "https://github.com/CloudSpot/cloudspot/pull/7700",
  metadata: { status, number: 7700, title: "A PR", closedAt: null, mergedAt: null, ...extra },
});
const branch = (name: string, committedAt: string | null = daysAgo(1)): BranchInfo => ({ name, url: `https://github.com/x/y/tree/${name}`, committedAt });
const build = (issues: LinearIssue[], opts: { open?: string[]; branches?: [string, BranchInfo][] } = {}) =>
  buildQueue({ issues, openPrTickets: new Set(opts.open ?? []), branches: new Map(opts.branches ?? []), nowMs: NOW });

describe("parsePr", () => {
  it("treats drafts and reviews as open", () => {
    expect(parsePr(pr("draft"))?.open).toBe(true);
    expect(parsePr(pr("inReview"))?.open).toBe(true);
  });
  it("treats merged and closed as done", () => {
    expect(parsePr(pr("merged", { mergedAt: daysAgo(1), closedAt: daysAgo(1) }))?.open).toBe(false);
    expect(parsePr(pr("closed", { closedAt: daysAgo(1) }))?.open).toBe(false);
  });
  it("ignores attachments that aren't PRs", () => {
    expect(parsePr({ url: "https://github.com/CloudSpot/cloudspot/commit/abc", metadata: {} })).toBeNull();
  });
});

describe("parseIssue", () => {
  it("maps Linear's fields", () => {
    const i = parseIssue({
      identifier: "PLAT-1",
      title: "T",
      url: "u",
      priority: 2,
      state: { name: "Blocked", type: "started", color: "#000" },
      team: { key: "PLAT" },
      project: { name: "P", url: "pu", lead: { isMe: true } },
      assignee: { name: "Matt", displayName: "matt", isMe: true },
      attachments: { nodes: [pr("merged", { mergedAt: daysAgo(2) })] },
      labels: { nodes: [{ name: "night-shift-ready" }] },
      linearId: "uuid-1",
    });
    expect(i).toMatchObject({ linearId: "uuid-1", labels: ["night-shift-ready"] });
    expect(i).toMatchObject({ id: "PLAT-1", team: "PLAT", project: { ledByMe: true }, assignee: { name: "matt", isMe: true } });
    expect(i.prs).toHaveLength(1);
  });
});

describe("branch matching", () => {
  it("matches the id as a whole token", () => {
    expect(branchMatches("PLAT-2104", "feature/plat-2104-thing")).toBe(true);
    expect(branchMatches("PLAT-2104", "plat-2104")).toBe(true);
    expect(branchMatches("PLAT-2104", "plat-21040-other")).toBe(false);
    expect(branchMatches("PLAT-2104", "xplat-2104")).toBe(false);
  });
  it("prefers Linear's branch name, else the newest", () => {
    const i = issue("PLAT-5");
    const a = branch("old/plat-5", daysAgo(5));
    const b = branch("new/plat-5", daysAgo(1));
    expect(pickBranch(i, [a, b])?.name).toBe("new/plat-5");
    expect(pickBranch(i, [b, branch("matt/plat-5-thing", daysAgo(9))])?.name).toBe("matt/plat-5-thing");
    expect(pickBranch(i, [branch("plat-50")])).toBeNull();
  });
});

describe("buildQueue", () => {
  it("leaves out issues with an open PR, from Linear or from Foreman", () => {
    const { items, withPr } = build(
      [issue("PLAT-1", { prs: [parsePr(pr("draft"))!] }), issue("PLAT-2"), issue("PLAT-3")],
      { open: ["PLAT-3"] },
    );
    expect(items.map((i) => i.id)).toEqual(["PLAT-2"]);
    expect(withPr).toBe(2);
  });

  it("keeps issues whose PRs are all merged, and lists those PRs", () => {
    const { items } = build([issue("PLAT-1", { ...started(), prs: [parsePr(pr("merged", { mergedAt: daysAgo(1) }))!] })]);
    expect(items[0]!.donePrs).toHaveLength(1);
  });

  it("puts issues in lanes", () => {
    const { items } = build(
      [issue("PLAT-1"), issue("PLAT-2", started()), issue("PLAT-3", started("Blocked")), issue("PLAT-4", started())],
      { branches: [["PLAT-4", branch("plat-4")]] },
    );
    expect(Object.fromEntries(items.map((i) => [i.id, i.lane]))).toEqual({
      "PLAT-1": "next",
      "PLAT-2": "progress",
      "PLAT-3": "blocked",
      "PLAT-4": "branch",
    });
    expect(items.map((i) => i.id)).toEqual(["PLAT-4", "PLAT-2", "PLAT-3", "PLAT-1"]);
  });

  it("ignores a branch left behind by an earlier PR", () => {
    const done = parsePr(pr("merged", { mergedAt: daysAgo(1), branch: "plat-4" }))!;
    const { items } = build([issue("PLAT-4", { ...started(), prs: [done] })], { branches: [["PLAT-4", branch("plat-4")]] });
    expect(items[0]).toMatchObject({ lane: "progress", branch: null });
  });

  it("sorts by priority inside a lane, no priority last", () => {
    const { items } = build([issue("A-1", { priority: 0 }), issue("A-2", { priority: 4 }), issue("A-3", { priority: 1 })]);
    expect(items.map((i) => i.id)).toEqual(["A-3", "A-2", "A-1"]);
  });

  it("flags started work with nothing pushed as stale", () => {
    const days = STALE_AFTER_MS / 86_400_000;
    const { items } = build([issue("A-1", started("In Progress", days + 1)), issue("A-2", started("In Progress", days - 1))]);
    expect(items.map((i) => i.stale)).toEqual([true, false]);
  });

  it("marks issues reached only through a project I lead", () => {
    const { items } = build([issue("A-1", { assignee: { name: "sam", isMe: false } }), issue("A-2", { assignee: null })]);
    expect(items.map((i) => i.via)).toEqual(["project", "project"]);
  });
});

describe("groupLane", () => {
  const proj = (name: string) => ({ name, url: `https://linear.app/p/${name}`, ledByMe: false, status: null });
  const ref = (id: string): IssueRef => ({ id, title: `Issue ${id}`, url: `u/${id}`, state: "In Progress", stateType: "started" });
  const lane = (issues: LinearIssue[]) => build(issues).items;

  it("groups by project in order of first appearance, projectless together", () => {
    const groups = groupLane(lane([issue("A-1", { project: proj("x") }), issue("A-2"), issue("A-3", { project: proj("x") })]));
    expect(groups.map((g) => [g.project?.name ?? null, g.count])).toEqual([["x", 2], [null, 1]]);
  });

  it("puts children under a parent that's in the lane", () => {
    const [g] = groupLane(lane([issue("A-1"), issue("A-2", { parent: ref("A-1") }), issue("A-3", { parent: ref("A-1") }), issue("A-4")]));
    expect(g!.entries).toHaveLength(2);
    const fam = g!.entries[0]!;
    expect(fam.kind).toBe("family");
    if (fam.kind !== "family") return;
    expect(fam.head?.id).toBe("A-1");
    expect(fam.children.map((c) => c.id)).toEqual(["A-2", "A-3"]);
  });

  it("gathers children whose parent is elsewhere under the parent's name", () => {
    const [g] = groupLane(lane([issue("A-2", { parent: ref("A-9") }), issue("A-4"), issue("A-3", { parent: ref("A-9") })]));
    expect(g!.entries.map((e) => (e.kind === "item" ? e.item.id : `${e.parent.id}:${e.children.map((c) => c.id).join(",")}`))).toEqual([
      "A-9:A-2,A-3",
      "A-4",
    ]);
    expect(g!.entries[0]).toMatchObject({ head: null });
  });
});

describe("lanes follow the project or parent", () => {
  const proj = (type: string) => ({ name: "P", url: "https://linear.app/p/P", ledByMe: true, status: { name: type, type } });
  const lanes = (issues: LinearIssue[], branches: [string, BranchInfo][] = []) =>
    Object.fromEntries(build(issues, { branches }).items.map((i) => [i.id, i.lane]));

  it("keeps a project's issues together in the project's lane", () => {
    expect(
      lanes([issue("A-1", { project: proj("started") }), issue("A-2", { ...started("Blocked"), project: proj("started") })]),
    ).toEqual({ "A-1": "progress", "A-2": "progress" });
    expect(lanes([issue("A-1", { ...started(), project: proj("paused") })])).toEqual({ "A-1": "blocked" });
    expect(lanes([issue("A-1", { ...started(), project: proj("planned") })])).toEqual({ "A-1": "next" });
  });

  it("falls back to the issue's own lane for a finished project", () => {
    expect(lanes([issue("A-1", { ...started("Blocked"), project: proj("completed") })])).toEqual({ "A-1": "blocked" });
  });

  it("puts sub-issues in their queued parent's lane", () => {
    const parent = { id: "A-1", title: "P", url: "u", state: "In Progress", stateType: "started" };
    expect(
      lanes(
        [issue("A-1", started()), issue("A-2", { parent }), issue("A-3", { ...started("Blocked"), parent })],
        [["A-1", branch("a-1")]],
      ),
    ).toEqual({ "A-1": "branch", "A-2": "branch", "A-3": "branch" });
  });

  it("uses an unqueued parent's state", () => {
    const parent = (state: string, stateType: string) => ({ id: "A-9", title: "P", url: "u", state, stateType });
    expect(lanes([issue("A-2", { parent: parent("Blocked", "started") })])).toEqual({ "A-2": "blocked" });
    expect(lanes([issue("A-2", { ...started(), parent: parent("Done", "completed") })])).toEqual({ "A-2": "progress" });
  });

  it("keeps each issue's own lane for sorting inside the group", () => {
    const items = build([issue("A-1", { project: proj("started") }), issue("A-2", { ...started(), project: proj("started") })]).items;
    expect(items.map((i) => [i.id, i.ownLane])).toEqual([
      ["A-2", "progress"],
      ["A-1", "next"],
    ]);
  });
});
