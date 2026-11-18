// Shared types. The server maps GitHub REST responses into the Gh* shapes,
// runs the pure logic in core/, and pushes a Snapshot to the browser.

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
export type ChecksState = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;

export interface GhReview {
  login: string;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED */
  state: string;
}

/** Whose PRs to watch: mine (author:@me) and/or the Claude GitHub app (author:app/claude). */
export type AuthorKey = "me" | "claude";
export const AUTHOR_KEYS: AuthorKey[] = ["me", "claude"];
export const AUTHOR_LABEL: Record<AuthorKey, string> = { me: "My PRs", claude: "claude[bot]" };

export interface Prefs {
  authors: AuthorKey[];
}

export interface GhPr {
  number: number;
  author: AuthorKey;
  title: string;
  htmlUrl: string;
  headRef: string;
  baseRef: string;
  state: "open" | "closed";
  isDraft: boolean;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  labels: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  reviewDecision: ReviewDecision;
  /** Latest approving / change-requesting review per reviewer. */
  reviews: GhReview[];
  /** Users or teams still asked to review. */
  requestedReviewers: string[];
  /** Combined status of the head commit's checks. */
  checks: ChecksState;
  /** The description's Summary section (markdown), or its first paragraph. */
  summary: string | null;
}

export type RunStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "waiting"
  | "requested"
  | "pending";

export interface GhRun {
  id: number;
  runNumber: number;
  headBranch: string | null;
  event: string;
  status: RunStatus | string;
  conclusion: string | null;
  createdAt: string;
  runStartedAt: string | null;
  updatedAt: string;
  htmlUrl: string;
  /** Who triggered the run (for a merge, whoever merged). */
  actor: string | null;
}

export interface GhStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GhJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  startedAt: string | null;
  completedAt: string | null;
  steps: GhStep[];
}

export type PrStatus =
  | "open"
  | "waiting"
  | "building"
  | "failing"
  | "complete"
  | "failed"
  | "no-build"
  | "closed";

export interface FailedJobInfo {
  jobId: number;
  jobName: string;
  stepName: string | null;
  url: string;
  at: string | null;
}

export interface RunView {
  id: number;
  runNumber: number;
  htmlUrl: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  jobs: GhJob[];
  failed: FailedJobInfo | null;
}

export type ReviewState = "draft" | "approved" | "changes" | "required" | "none";

export interface ReviewSummary {
  state: ReviewState;
  approvedBy: string[];
  changesBy: string[];
  waitingOn: string[];
}

export interface PrView extends GhPr {
  deployProd: boolean;
  /** 0..5 from the risk:N label, null when unlabelled. */
  risk: number | null;
  claudeLabels: string[];
  /** Labels other than risk:*, claude-* and deploy-prod. */
  otherLabels: string[];
  review: ReviewSummary;
  status: PrStatus;
  run: RunView | null;
  /** Where the row's secondary link points: the failed job, else the run. */
  link: { label: string; url: string } | null;
}

/** A services-build run on one of my branches, for the side panel. */
export interface RunSummary {
  id: number;
  runNumber: number;
  htmlUrl: string;
  headBranch: string | null;
  status: string;
  conclusion: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  actor: string | null;
  /** The linked PR's author; runs with no linked PR were triggered by me. */
  author: AuthorKey;
  pr: { number: number; title: string; htmlUrl: string } | null;
}

export interface JobsPayload {
  runId: number;
  fetchedAt: string;
  jobs: GhJob[];
}

export type EventKind = "merged" | "failed" | "complete";

export interface WatchEvent {
  id: string;
  kind: EventKind;
  at: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  headRef: string;
  deployProd: boolean;
  /** Notification title and body, as sent. */
  title: string;
  detail: string;
  /** Where the notification click goes. */
  url: string;
  run: {
    id: number;
    number: number;
    url: string;
    status: string;
    conclusion: string | null;
    startedAt: string | null;
    /** Run time to completion, or to the failure for a failed event. */
    durationMs: number | null;
  } | null;
  failedJob: { name: string; step: string | null; url: string } | null;
  /** Services from the run's "Build <service>" jobs. */
  services: { name: string; conclusion: string | null; url: string }[];
}

export interface EventView extends WatchEvent {
  isNew: boolean;
}

/**
 * Bump when the Snapshot shape changes. The page compares it with the server's
 * so a server started from older code shows a "restart" message, not a crash.
 */
export const SNAPSHOT_SCHEMA = 6;

export interface Snapshot {
  schema: number;
  /** Which authors everything below is filtered to (saved on the server). */
  prefs: Prefs;
  login: string | null;
  repo: string;
  generatedAt: string;
  lastPollAt: string | null;
  lastError: string | null;
  /** GitHub REST core bucket (search and GraphQL have their own). */
  rateLimit: { remaining: number; limit: number; resetAt: string } | null;
  typicalMs: number | null;
  /** PR numbers shown as cards: active runs, else the most recent finished run. */
  featured: { prNumbers: number[]; mode: "active" | "last" | "none" };
  prs: PrView[];
  /** Services-build runs on my branches, newest first. */
  myRuns: RunSummary[];
  /** My runs left out of myRuns because they deployed nothing. */
  myRunsHidden: number;
  /** merged_at of my PRs over the last ~91 days, for the stats band. Null until first fetched. */
  merges: { mergedAts: string[]; fetchedAt: string } | null;
  events: EventView[];
}
