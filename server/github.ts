import { execFileSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { extractSummary } from "../core/pr.ts";
import { attachedTickets, ticketHints } from "../core/tickets.ts";
import type { AuthorKey, GhJob, GhPr, GhRun } from "../core/types.ts";
import { REPO_NAME, REPO_OWNER, WORKFLOW_FILE } from "./config.ts";

/** Read the token from the gh CLI. Kept in memory only. */
export function ghToken(): string {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Could not get a token from `gh auth token`. Run `gh auth login` first.");
  }
}

/**
 * Thin REST client that sends If-None-Match with the last ETag for each URL.
 * A 304 reuses the cached body and does not count against the rate limit.
 */
export class GitHub {
  private octokit: Octokit;
  private cache = new Map<string, { etag: string; data: unknown }>();
  /** REST core bucket only; search and GraphQL replies report other buckets. */
  rateLimit: { remaining: number; limit: number; resetAt: string } | null = null;

  constructor(token: string) {
    this.octokit = new Octokit({
      auth: token,
      userAgent: "pr-dashboard",
      // Octokit logs every request, and logs 304 "not modified" replies (our ETag
      // cache hits) as errors. Keep the terminal for real warnings and errors.
      log: {
        debug: () => {},
        info: () => {},
        warn: console.warn,
        error: (msg: unknown, ...rest: unknown[]) => {
          if (typeof msg === "string" && / - 304 with id /.test(msg)) return;
          console.error(msg, ...rest);
        },
      },
    });
  }

  async get<T>(route: string, params: Record<string, unknown> = {}): Promise<T> {
    const key = route + JSON.stringify(params);
    const cached = this.cache.get(key);
    try {
      const res = await this.octokit.request(route, {
        ...params,
        headers: cached ? { "if-none-match": cached.etag } : {},
      });
      this.noteRateLimit(res.headers);
      const etag = res.headers.etag;
      if (etag) this.cache.set(key, { etag, data: res.data });
      return res.data as T;
    } catch (e) {
      const err = e as { status?: number; response?: { headers?: Record<string, string> } };
      if (err.status === 304 && cached) {
        this.noteRateLimit(err.response?.headers);
        return cached.data as T;
      }
      throw e;
    }
  }

  forget(route: string, params: Record<string, unknown> = {}) {
    this.cache.delete(route + JSON.stringify(params));
  }

  private noteRateLimit(headers: Record<string, unknown> | undefined) {
    if (headers?.["x-ratelimit-resource"] !== "core") return;
    const remaining = headers["x-ratelimit-remaining"];
    const limit = headers["x-ratelimit-limit"];
    const reset = headers["x-ratelimit-reset"];
    if (remaining == null || limit == null || reset == null) return;
    this.rateLimit = {
      remaining: Number(remaining),
      limit: Number(limit),
      resetAt: new Date(Number(reset) * 1000).toISOString(),
    };
  }

  async login(): Promise<string> {
    const user = await this.get<{ login: string }>("GET /user");
    return user.login;
  }

  /** One author's PRs matching `query`, with reviews, labels and check state, in one GraphQL call. */
  async searchPrs(author: AuthorKey, query: string): Promise<GhPr[]> {
    const res = await this.octokit.graphql<{ search: { nodes: (GqlPr | Record<string, never>)[] } }>(PR_QUERY, {
      q: `repo:${REPO_OWNER}/${REPO_NAME} is:pr ${AUTHOR_QUERY[author]} ${query}`,
    });
    return res.search.nodes.filter((n): n is GqlPr => "number" in n).map((n) => toPr(n, author));
  }

  /** merged_at of every PR by `author` merged since `since` (YYYY-MM-DD), paging through search. */
  async mergedAtSince(author: AuthorKey, since: string, cap = 1000): Promise<string[]> {
    const out: string[] = [];
    let after: string | null = null;
    do {
      const res: MergedPage = await this.octokit.graphql<MergedPage>(MERGED_QUERY, {
        q: `repo:${REPO_OWNER}/${REPO_NAME} is:pr is:merged ${AUTHOR_QUERY[author]} merged:>=${since}`,
        after,
      });
      for (const n of res.search.nodes) if (n.mergedAt) out.push(n.mergedAt);
      after = res.search.pageInfo.hasNextPage ? res.search.pageInfo.endCursor : null;
    } while (after && out.length < cap);
    return out;
  }

  async workflowRuns(): Promise<GhRun[]> {
    const res = await this.get<{ workflow_runs: RawRun[] }>(
      "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
      { owner: REPO_OWNER, repo: REPO_NAME, workflow_id: WORKFLOW_FILE, event: "pull_request", per_page: 40 },
    );
    return res.workflow_runs.map(toRun);
  }

  async jobs(runId: number): Promise<GhJob[]> {
    const res = await this.get<{ jobs: RawJob[] }>("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
      owner: REPO_OWNER,
      repo: REPO_NAME,
      run_id: runId,
      per_page: 50,
    });
    return res.jobs.map(toJob);
  }
}

const PR_QUERY = /* GraphQL */ `
  query ($q: String!) {
    search(query: $q, type: ISSUE, first: 100) {
      nodes {
        ... on PullRequest {
          number
          title
          url
          body
          state
          isDraft
          createdAt
          updatedAt
          mergedAt
          closedAt
          headRefName
          baseRefName
          additions
          deletions
          changedFiles
          comments { totalCount }
          labels(first: 30) { nodes { name } }
          reviewDecision
          comments_first: comments(first: 2) { nodes { author { login } body } }
          latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
          reviewRequests(first: 20) {
            nodes { requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } } }
          }
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        }
      }
    }
  }
`;

/** Search qualifier per author. The Claude GitHub app's PRs are authored by claude[bot]. */
const AUTHOR_QUERY: Record<AuthorKey, string> = { me: "author:@me", claude: "author:app/claude" };

const MERGED_QUERY = /* GraphQL */ `
  query ($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest { mergedAt } }
    }
  }
`;

interface MergedPage {
  search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { mergedAt?: string | null }[] };
}

interface GqlPr {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: { totalCount: number };
  labels: { nodes: { name: string }[] };
  reviewDecision: GhPr["reviewDecision"];
  comments_first: { nodes: { author: { login: string } | null; body: string }[] };
  latestOpinionatedReviews: { nodes: { state: string; author: { login: string } | null }[] };
  reviewRequests: { nodes: { requestedReviewer: { login?: string; name?: string } | null }[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: GhPr["checks"] } | null } }[] };
}

function toPr(n: GqlPr, author: AuthorKey): GhPr {
  return {
    number: n.number,
    author,
    // Linear's GitHub integration posts a linkback comment, first or second on the PR.
    tickets: attachedTickets(
      n.comments_first.nodes.filter((c) => /linear/i.test(c.author?.login ?? "")).map((c) => c.body),
      n.body,
    ),
    ticketHints: ticketHints(n.title, n.headRefName),
    title: n.title,
    htmlUrl: n.url,
    headRef: n.headRefName,
    baseRef: n.baseRefName,
    state: n.state === "OPEN" ? "open" : "closed",
    isDraft: n.isDraft,
    createdAt: n.createdAt,
    mergedAt: n.mergedAt,
    closedAt: n.closedAt,
    updatedAt: n.updatedAt,
    labels: n.labels.nodes.map((l) => l.name),
    additions: n.additions,
    deletions: n.deletions,
    changedFiles: n.changedFiles,
    comments: n.comments.totalCount,
    reviewDecision: n.reviewDecision,
    reviews: n.latestOpinionatedReviews.nodes.map((r) => ({ login: r.author?.login ?? "ghost", state: r.state })),
    requestedReviewers: n.reviewRequests.nodes
      .map((r) => r.requestedReviewer?.login ?? r.requestedReviewer?.name)
      .filter((x): x is string => !!x),
    checks: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    summary: extractSummary(n.body),
  };
}

interface RawRun {
  id: number;
  run_number: number;
  head_branch: string | null;
  event: string;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  run_started_at?: string | null;
  updated_at: string;
  html_url: string;
  actor?: { login: string } | null;
}

interface RawJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: { number: number; name: string; status: string; conclusion: string | null }[];
}

function toRun(r: RawRun): GhRun {
  return {
    id: r.id,
    runNumber: r.run_number,
    headBranch: r.head_branch,
    event: r.event,
    status: r.status ?? "queued",
    conclusion: r.conclusion,
    createdAt: r.created_at,
    runStartedAt: r.run_started_at ?? null,
    updatedAt: r.updated_at,
    htmlUrl: r.html_url,
    actor: r.actor?.login ?? null,
  };
}

function toJob(j: RawJob): GhJob {
  return {
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    htmlUrl: j.html_url ?? "",
    startedAt: j.started_at,
    completedAt: j.completed_at,
    steps: (j.steps ?? []).map((s) => ({
      number: s.number,
      name: s.name,
      status: s.status,
      conclusion: s.conclusion,
    })),
  };
}
