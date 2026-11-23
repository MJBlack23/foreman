import type { Hono } from "hono";
import {
  type BranchInfo,
  buildQueue,
  type LinearIssue,
  parseIssue,
  pickBranch,
  QUEUE_EVERY_MS,
  NIGHT_SHIFT_LABEL,
  type QueueState,
} from "../core/queue.ts";
import type { Snapshot } from "../core/types.ts";
import { originAllowed } from "./cluster.ts";

const LINEAR_API = "https://api.linear.app/graphql";

/**
 * Started or to-do issues (not backlog, not triage) that are assigned to me
 * or sit in a project I lead. Delegated issues come back assigned to me.
 */
const ISSUES_QUERY = `query Queue($after: String) {
  issues(first: 100, after: $after, filter: {
    state: { type: { in: ["started", "unstarted"] } },
    or: [{ assignee: { isMe: { eq: true } } }, { project: { lead: { isMe: { eq: true } } } }]
  }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      linearId: id identifier title url description branchName priority priorityLabel estimate dueDate
      createdAt updatedAt startedAt
      state { name type color }
      team { key }
      project { name url lead { isMe } status { name type } }
      cycle { number endsAt }
      assignee { name displayName isMe }
      parent { identifier title url state { name type } }
      labels { nodes { name } }
      attachments(filter: { sourceType: { eq: "github" } }) { nodes { url title metadata } }
    }
  }
}`;

/** LINEAR_API_KEY (a personal key) from Doppler project `foreman`. Reading needs Read; "Send to Night-Shift" needs Write. */
export function loadLinearKey(env: Record<string, string | undefined> = process.env): string | null {
  return env.LINEAR_API_KEY?.trim() || null;
}

export interface QueueDeps {
  apiKey: string | null;
  /** The PR poller's latest snapshot: its open PRs count as "has a PR" too. */
  prs: () => Snapshot["prs"];
  branchesMatching: (terms: string[]) => Promise<Map<string, BranchInfo[]>>;
  fetch?: typeof fetch;
  now?: () => number;
}

type Listener = (s: QueueState) => void;

export class QueueWatcher {
  private issues: LinearIssue[] = [];
  private branches = new Map<string, BranchInfo>();
  private polledAt: string | null = null;
  private nextMs: number | null = null;
  private error: string | null = null;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private listeners = new Set<Listener>();
  private lastSent = "";
  private sending = new Set<string>();
  private me: { id: string; name: string } | null = null;
  private labelIds = new Map<string, string>();
  private todoStates = new Map<string, { id: string; name: string; type: string; color: string }>();
  private fetch: typeof fetch;
  private now: () => number;

  constructor(private deps: QueueDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  get configured() {
    return !!this.deps.apiKey;
  }

  start() {
    this.stopped = false;
    void this.poll();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextMs = null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  state(): QueueState {
    const openPrTickets = new Set<string>();
    for (const pr of this.deps.prs()) {
      if (pr.state !== "open") continue;
      for (const t of pr.tickets) openPrTickets.add(t.id);
      for (const id of pr.ticketHints) openPrTickets.add(id);
    }
    const { items, withPr } = buildQueue({ issues: this.issues, openPrTickets, branches: this.branches, nowMs: this.now() });
    return {
      configured: this.configured,
      items,
      withPr,
      polledAt: this.polledAt,
      nextPollAt: this.nextMs ? new Date(this.nextMs).toISOString() : null,
      polling: this.polling,
      error: this.error,
    };
  }

  /** Push the state if it changed, e.g. after the PR poller sees a new PR. */
  republish() {
    this.emit();
  }

  async poll(): Promise<void> {
    if (!this.deps.apiKey || this.polling) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.polling = true;
    this.emit();
    try {
      this.issues = await this.fetchIssues(this.deps.apiKey);
      this.error = null;
      this.polledAt = new Date(this.now()).toISOString();
      try {
        this.branches = await this.findBranches();
      } catch (e) {
        // Lanes fall back to Linear's state; the issues themselves are still right.
        console.error(`[queue] branch lookup failed: ${(e as Error).message}`);
      }
    } catch (e) {
      this.error = ((e as Error).message ?? String(e)).replaceAll(this.deps.apiKey, "[redacted]");
      console.error(`[queue] Linear poll failed: ${this.error}`);
    } finally {
      this.polling = false;
      if (!this.stopped) {
        this.nextMs = this.now() + QUEUE_EVERY_MS;
        this.timer = setTimeout(() => void this.poll(), QUEUE_EVERY_MS);
      }
      this.emit();
    }
  }

  /**
   * Hand a queued issue to night-shift in one Linear write: assign it to me,
   * move it to the team's To Do, and add the team's `night-shift-ready` label.
   * night-shift picks labelled tickets up on its next tick.
   */
  async sendToNightShift(issueId: string): Promise<{ result: "sent" | "already" | "busy"; movedTo?: string }> {
    const key = this.deps.apiKey;
    if (!key) throw new HttpError(400, "LINEAR_API_KEY isn't set.");
    const issue = this.issues.find((i) => i.id === issueId);
    if (!issue) throw new HttpError(404, `${issueId} isn't in the queue.`);
    if (issue.labels.includes(NIGHT_SHIFT_LABEL)) return { result: "already" };
    if (this.sending.has(issueId)) return { result: "busy" };
    this.sending.add(issueId);
    try {
      const labelId = await this.nightShiftLabel(key, issue.team);
      const todo = await this.todoState(key, issue.team!);
      const me = await this.viewer(key);
      // One issueUpdate, so Linear applies all three or none: a tick never sees a half-sent ticket.
      const res = await this.gql<{ issueUpdate: { success: boolean } }>(
        key,
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: issue.linearId, input: { assigneeId: me.id, stateId: todo.id, addedLabelIds: [labelId] } },
      );
      if (!res.issueUpdate.success) throw new Error(`Linear didn't update ${issue.id}.`);
      const moved = issue.state.name !== todo.name;
      issue.state = { name: todo.name, type: todo.type, color: todo.color };
      issue.assignee = { name: me.name, isMe: true };
      issue.labels = [...issue.labels, NIGHT_SHIFT_LABEL];
      this.emit();
      return moved ? { result: "sent", movedTo: todo.name } : { result: "sent" };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const msg = ((e as Error).message ?? String(e)).replaceAll(key, "[redacted]");
      // A read-only key gets a permission error here.
      throw new HttpError(502, /permission|forbidden|scope|not authori[sz]ed/i.test(msg)
        ? `${msg}. The Linear key needs Write access to update issues: make a new key with Write and update LINEAR_API_KEY in Doppler.`
        : msg);
    } finally {
      this.sending.delete(issueId);
    }
  }

  /** Labels are per team (PLAT and GRO each have one), so look it up by team and cache it. */
  private async nightShiftLabel(key: string, team: string | null): Promise<string> {
    if (!team) throw new HttpError(400, "This issue has no team, so there's no night-shift-ready label for it.");
    const cached = this.labelIds.get(team);
    if (cached) return cached;
    const res = await this.gql<{ issueLabels: { nodes: { id: string }[] } }>(
      key,
      `query($name: String!, $team: String!) { issueLabels(first: 1, filter: { name: { eqIgnoreCase: $name }, team: { key: { eq: $team } } }) { nodes { id } } }`,
      { name: NIGHT_SHIFT_LABEL, team },
    );
    const id = res.issueLabels.nodes[0]?.id;
    if (!id) throw new HttpError(400, `Team ${team} has no ${NIGHT_SHIFT_LABEL} label in Linear.`);
    this.labelIds.set(team, id);
    return id;
  }

  /** The Linear user the API key belongs to: night-shift tickets get assigned to them. */
  private async viewer(key: string): Promise<{ id: string; name: string }> {
    if (this.me) return this.me;
    const res = await this.gql<{ viewer: { id: string; name: string; displayName: string } }>(key, `query { viewer { id name displayName } }`, {});
    this.me = { id: res.viewer.id, name: res.viewer.displayName || res.viewer.name };
    return this.me;
  }

  /** The team's To Do: the unstarted state named "To Do…", else its first unstarted state. */
  private async todoState(key: string, team: string): Promise<{ id: string; name: string; type: string; color: string }> {
    const cached = this.todoStates.get(team);
    if (cached) return cached;
    const res = await this.gql<{ workflowStates: { nodes: { id: string; name: string; type: string; color: string; position: number }[] } }>(
      key,
      `query($team: String!) { workflowStates(first: 50, filter: { team: { key: { eq: $team } }, type: { eq: "unstarted" } }) { nodes { id name type color position } } }`,
      { team },
    );
    const states = [...res.workflowStates.nodes].sort((a, b) => a.position - b.position);
    const todo = states.find((st) => /^to ?do\b/i.test(st.name)) ?? states[0];
    if (!todo) throw new HttpError(400, `Team ${team} has no To Do state in Linear.`);
    const { position: _, ...state } = todo;
    this.todoStates.set(team, state);
    return state;
  }

  private async gql<T>(key: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetch(LINEAR_API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
    if (!res.ok || body?.errors?.length || !body?.data) {
      throw new Error(`Linear ${res.status}: ${body?.errors?.map((e) => e.message).join("; ") || res.statusText}`);
    }
    return body.data;
  }

  private async fetchIssues(key: string): Promise<LinearIssue[]> {
    type Page = { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: unknown[] } };
    const out: LinearIssue[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const data: Page = await this.gql<Page>(key, ISSUES_QUERY, { after });
      out.push(...data.issues.nodes.map((n) => parseIssue(n as Record<string, unknown>)));
      if (!data.issues.pageInfo.hasNextPage) break;
      after = data.issues.pageInfo.endCursor;
    }
    return out;
  }

  /** Branches on GitHub for issues with no open PR. */
  private async findBranches(): Promise<Map<string, BranchInfo>> {
    const ids = this.issues.filter((i) => !i.prs.some((p) => p.open)).map((i) => i.id);
    const found = await this.deps.branchesMatching(ids.map((id) => id.toLowerCase()));
    const out = new Map<string, BranchInfo>();
    for (const i of this.issues) {
      const b = pickBranch(i, found.get(i.id.toLowerCase()) ?? []);
      if (b) out.set(i.id, b);
    }
    return out;
  }

  private emit() {
    if (!this.listeners.size) return;
    const s = this.state();
    const json = JSON.stringify(s);
    if (json === this.lastSent) return;
    this.lastSent = json;
    for (const fn of this.listeners) fn(s);
  }
}

export function queueRoutes(app: Hono, svc: QueueWatcher, origins: string[]) {
  app.get("/api/queue", (c) => c.json(svc.state()));

  app.post("/api/queue/refresh", async (c) => {
    if (!originAllowed(c.req.header("origin"), c.req.header("content-type"), origins)) {
      return c.json({ error: "Forbidden: refresh must come from the dashboard page." }, 403);
    }
    await svc.poll();
    return c.json(svc.state());
  });

  app.post("/api/queue/:id/night-shift", async (c) => {
    if (!originAllowed(c.req.header("origin"), c.req.header("content-type"), origins)) {
      return c.json({ error: "Forbidden: sending to night-shift must come from the dashboard page." }, 403);
    }
    try {
      return c.json(await svc.sendToNightShift(c.req.param("id")));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502;
      return c.json({ error: (e as Error).message }, status as 400);
    }
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
