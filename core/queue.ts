// Queue tab: the pure parts. Linear is the source of truth; this decides which
// issues are queued work without a PR and which lane each one goes in.

/** The label night-shift watches for. Each Linear team has its own copy. */
export const NIGHT_SHIFT_LABEL = "night-shift-ready";

/** Linear is polled this often, and on demand from the page. */
export const QUEUE_EVERY_MS = 3 * 60_000;
/** A started issue with no PR and no branch counts as stale after this long. */
export const STALE_AFTER_MS = 3 * 24 * 60 * 60_000;

export type QueueLane = "branch" | "progress" | "blocked" | "next";

export const LANES: { id: QueueLane; title: string; hint: string }[] = [
  { id: "branch", title: "Branch pushed, no PR", hint: "A branch for it is on GitHub but no PR is open." },
  { id: "progress", title: "In progress", hint: "Started, with no PR yet. Projects and parents that are in progress bring all their issues." },
  { id: "blocked", title: "Blocked", hint: "Waiting on something, or in a paused project." },
  { id: "next", title: "Up next", hint: "Not started yet." },
];

/** A GitHub PR Linear has linked to the issue. */
export interface LinkedPr {
  url: string;
  number: number | null;
  title: string | null;
  /** Linear's status: draft, open, inReview, approved, merged, closed, … */
  status: string;
  open: boolean;
  /** The PR's head branch. */
  branch: string | null;
}

export interface LinearIssue {
  id: string;
  /** Linear's UUID, for mutations. */
  linearId: string;
  title: string;
  url: string;
  description: string | null;
  branchName: string | null;
  /** Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  priorityLabel: string;
  estimate: number | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  state: { name: string; type: string; color: string };
  team: string | null;
  project: { name: string; url: string; ledByMe: boolean; status: { name: string; type: string } | null } | null;
  cycle: { number: number; endsAt: string } | null;
  assignee: { name: string; isMe: boolean } | null;
  parent: IssueRef | null;
  labels: string[];
  prs: LinkedPr[];
}

/** Enough of another issue to show and link it. */
export interface IssueRef {
  id: string;
  title: string;
  url: string;
  state: string | null;
  stateType: string | null;
}

export interface BranchInfo {
  name: string;
  url: string;
  committedAt: string | null;
}

export interface QueueItem extends LinearIssue {
  /**
   * The lane it's shown in. Issues in a project follow the project's status,
   * and sub-issues follow their parent, so a group is never split across lanes.
   */
  lane: QueueLane;
  /** The lane its own state and branch would put it in. */
  ownLane: QueueLane;
  /** How this issue reached the queue: assigned to me, or only through a project I lead. */
  via: "assigned" | "project";
  branch: BranchInfo | null;
  /** PRs that were linked once but are merged or closed (multi-PR work). */
  donePrs: LinkedPr[];
  /** Started this long ago with nothing pushed. */
  stale: boolean;
}

export interface QueueState {
  configured: boolean;
  items: QueueItem[];
  /** Issues left out because a PR is open for them. */
  withPr: number;
  polledAt: string | null;
  nextPollAt: string | null;
  polling: boolean;
  error: string | null;
}

// ── Parsing Linear's GraphQL reply ─────────────────────────────────────────

type Raw = Record<string, any>;

const CLOSED_PR = new Set(["merged", "closed"]);

export function parsePr(a: Raw): LinkedPr | null {
  const url = typeof a?.url === "string" ? a.url : null;
  if (!url || !/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) return null;
  const m = a.metadata ?? {};
  const status = typeof m.status === "string" ? m.status : "unknown";
  const open = !m.closedAt && !m.mergedAt && !CLOSED_PR.has(status);
  const number = Number(m.number ?? /\/pull\/(\d+)/.exec(url)?.[1]);
  const branch = typeof m.branch === "string" ? m.branch : null;
  return { url, number: Number.isFinite(number) ? number : null, title: m.title ?? a.title ?? null, status, open, branch };
}

export function parseIssue(n: Raw): LinearIssue {
  const prs = (n.attachments?.nodes ?? []).map(parsePr).filter((p: LinkedPr | null): p is LinkedPr => !!p);
  return {
    id: n.identifier,
    linearId: n.linearId ?? n.id ?? n.identifier,
    title: n.title,
    url: n.url,
    description: n.description ?? null,
    branchName: n.branchName || null,
    priority: n.priority ?? 0,
    priorityLabel: n.priorityLabel ?? "No priority",
    estimate: n.estimate ?? null,
    dueDate: n.dueDate ?? null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    startedAt: n.startedAt ?? null,
    state: { name: n.state?.name ?? "?", type: n.state?.type ?? "unstarted", color: n.state?.color ?? "#999" },
    team: n.team?.key ?? null,
    project: n.project
      ? {
          name: n.project.name,
          url: n.project.url,
          ledByMe: !!n.project.lead?.isMe,
          status: n.project.status ? { name: n.project.status.name, type: n.project.status.type } : null,
        }
      : null,
    cycle: n.cycle ? { number: n.cycle.number, endsAt: n.cycle.endsAt } : null,
    assignee: n.assignee ? { name: n.assignee.displayName || n.assignee.name, isMe: !!n.assignee.isMe } : null,
    parent: n.parent
      ? { id: n.parent.identifier, title: n.parent.title, url: n.parent.url, state: n.parent.state?.name ?? null, stateType: n.parent.state?.type ?? null }
      : null,
    labels: (n.labels?.nodes ?? []).map((l: Raw) => l.name).filter((x: unknown): x is string => typeof x === "string"),
    prs,
  };
}

// ── Branch matching ─────────────────────────────────────────────────────────

/** Does a branch name belong to this issue? "plat-2104" matches "feature/plat-2104-x" but not "plat-21040". */
export function branchMatches(issueId: string, branch: string): boolean {
  const id = issueId.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${id}($|[^0-9])`, "i").test(branch);
}

/** Linear's own branch name first, then the most recently committed match. */
export function pickBranch(issue: Pick<LinearIssue, "id" | "branchName">, candidates: BranchInfo[]): BranchInfo | null {
  const ok = candidates.filter((b) => branchMatches(issue.id, b.name));
  if (!ok.length) return null;
  const exact = ok.find((b) => b.name === issue.branchName);
  if (exact) return exact;
  return [...ok].sort((a, b) => Date.parse(b.committedAt ?? "0") - Date.parse(a.committedAt ?? "0"))[0]!;
}

// ── Building the queue ──────────────────────────────────────────────────────

const LANE_ORDER: Record<QueueLane, number> = { branch: 0, progress: 1, blocked: 2, next: 3 };
/** Urgent first, "no priority" last. */
const prioRank = (p: number) => (p === 0 ? 5 : p);

export function laneFor(issue: LinearIssue, branch: BranchInfo | null): QueueLane {
  if (branch) return "branch";
  if (issue.state.type === "started") return /block/i.test(issue.state.name) ? "blocked" : "progress";
  return "next";
}

export interface BuildInput {
  issues: LinearIssue[];
  /** Ticket ids with an open PR Foreman already knows about (Linear's link can lag). */
  openPrTickets: ReadonlySet<string>;
  branches: ReadonlyMap<string, BranchInfo>;
  nowMs: number;
}

export function buildQueue({ issues, openPrTickets, branches, nowMs }: BuildInput): { items: QueueItem[]; withPr: number } {
  let withPr = 0;
  const items: QueueItem[] = [];
  for (const issue of issues) {
    if (issue.prs.some((p) => p.open) || openPrTickets.has(issue.id)) {
      withPr++;
      continue;
    }
    const found = branches.get(issue.id) ?? null;
    // A merged PR's branch that was never deleted isn't new work.
    const branch = found && !issue.prs.some((p) => p.branch === found.name) ? found : null;
    const lane = laneFor(issue, branch);
    const since = issue.startedAt ?? issue.updatedAt;
    items.push({
      ...issue,
      lane,
      ownLane: lane,
      via: issue.assignee?.isMe ? "assigned" : "project",
      branch,
      donePrs: issue.prs.filter((p) => !p.open),
      stale: lane === "progress" && nowMs - Date.parse(since) > STALE_AFTER_MS,
    });
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const i of items) i.lane = groupLaneOf(i, byId);
  items.sort(
    (a, b) =>
      LANE_ORDER[a.lane] - LANE_ORDER[b.lane] ||
      LANE_ORDER[a.ownLane] - LANE_ORDER[b.ownLane] ||
      prioRank(a.priority) - prioRank(b.priority) ||
      dueRank(a) - dueRank(b) ||
      Date.parse(a.startedAt ?? a.createdAt) - Date.parse(b.startedAt ?? b.createdAt),
  );
  return { items, withPr };
}

/** Linear project status types: backlog, planned, started, paused, completed, canceled. */
export function projectLane(status: { type: string } | null | undefined): QueueLane | null {
  switch (status?.type) {
    case "started":
      return "progress";
    case "paused":
      return "blocked";
    case "planned":
    case "backlog":
      return "next";
    default:
      return null;
  }
}

/** A parent that isn't queued (it has a PR, or it's done) still has a state. */
export function stateLane(state: { name: string | null; type: string | null }): QueueLane | null {
  if (state.type === "started") return /block/i.test(state.name ?? "") ? "blocked" : "progress";
  if (state.type === "unstarted" || state.type === "backlog" || state.type === "triage") return "next";
  return null;
}

/**
 * Where an issue is shown: its project's status if it has a project, else its
 * parent's lane, else its own. Completed or unknown statuses fall through.
 */
export function groupLaneOf(item: QueueItem, byId: ReadonlyMap<string, QueueItem>, depth = 0): QueueLane {
  const fromProject = projectLane(item.project?.status);
  if (fromProject) return fromProject;
  if (item.parent && depth < 5) {
    const parent = byId.get(item.parent.id);
    if (parent) return groupLaneOf(parent, byId, depth + 1);
    const fromState = stateLane({ name: item.parent.state, type: item.parent.stateType });
    if (fromState) return fromState;
  }
  return item.ownLane;
}

const dueRank = (i: LinearIssue) => (i.dueDate ? Date.parse(i.dueDate) : Number.MAX_SAFE_INTEGER);

// ── Grouping a lane ─────────────────────────────────────────────────────────

/** A parent issue with the children that share its lane. `head` is the parent when it's in the lane too. */
export interface Family {
  kind: "family";
  parent: IssueRef;
  head: QueueItem | null;
  children: QueueItem[];
}
export type LaneEntry = { kind: "item"; item: QueueItem } | Family;
export interface ProjectGroup {
  project: { name: string; url: string } | null;
  count: number;
  entries: LaneEntry[];
}

/**
 * One lane's items (already sorted) grouped by project, then by parent issue.
 * Groups and families keep the position of their first item, so the lane's
 * priority order still reads top to bottom. Issues with no project come as one
 * group with `project: null`. Only one level of parent is shown.
 */
export function groupLane(items: QueueItem[]): ProjectGroup[] {
  const groups = new Map<string, QueueItem[]>();
  for (const i of items) {
    const key = i.project?.url ?? "";
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  return [...groups.values()].map((list) => {
    const parentIds = new Set(list.flatMap((i) => (i.parent ? [i.parent.id] : [])));
    const entries: LaneEntry[] = [];
    const families = new Map<string, Family>();
    for (const i of list) {
      const key = i.parent?.id ?? (parentIds.has(i.id) ? i.id : null);
      if (!key) {
        entries.push({ kind: "item", item: i });
        continue;
      }
      let fam = families.get(key);
      if (!fam) {
        const ref = i.id === key ? { id: i.id, title: i.title, url: i.url, state: i.state.name, stateType: i.state.type } : i.parent!;
        fam = { kind: "family", parent: ref, head: null, children: [] };
        families.set(key, fam);
        entries.push(fam);
      }
      if (i.id === key) fam.head = i;
      else fam.children.push(i);
    }
    const p = list[0]!.project;
    return { project: p ? { name: p.name, url: p.url } : null, count: list.length, entries };
  });
}

/** Count for the top-bar link: everything queued and assigned to me. */
export const queueCount = (s: QueueState | null) => s?.items.filter((i) => i.via === "assigned").length ?? 0;
