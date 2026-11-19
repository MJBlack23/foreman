// Test builders. Defaults mirror the real example: PR #7475 → run #2860.
import type { GhJob, GhPr, GhRun, GhStep } from "./types.ts";

export const T0 = Date.parse("2026-11-18T14:00:00Z");
export const iso = (ms: number) => new Date(ms).toISOString();
export const min = (n: number) => n * 60_000;

export function pr(over: Partial<GhPr> = {}): GhPr {
  return {
    number: 7475,
    author: "me",
    tickets: [],
    ticketHints: [],
    title: "Tidy gateway auth",
    htmlUrl: "https://github.com/CloudSpot/cloudspot/pull/7475",
    headRef: "claude/gifted-babbage-lr6mq4",
    baseRef: "main",
    state: "closed",
    isDraft: false,
    createdAt: iso(T0 - min(120)),
    mergedAt: iso(T0),
    closedAt: iso(T0),
    updatedAt: iso(T0),
    labels: [],
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    comments: 0,
    reviewDecision: "APPROVED",
    reviews: [],
    requestedReviewers: [],
    checks: "SUCCESS",
    summary: null,
    ...over,
  };
}

export function run(over: Partial<GhRun> = {}): GhRun {
  return {
    id: 44149567802,
    runNumber: 2860,
    headBranch: "claude/gifted-babbage-lr6mq4",
    event: "pull_request",
    status: "in_progress",
    conclusion: null,
    createdAt: iso(T0 + 5_000),
    runStartedAt: iso(T0 + 5_000),
    updatedAt: iso(T0 + min(3)),
    htmlUrl: "https://github.com/CloudSpot/cloudspot/actions/runs/44149567802",
    actor: "MJBlack23",
    ...over,
  };
}

export function step(over: Partial<GhStep> = {}): GhStep {
  return { number: 1, name: "Set up job", status: "completed", conclusion: "success", ...over };
}

export function job(over: Partial<GhJob> = {}): GhJob {
  return {
    id: 1,
    name: "Detect changed services",
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/CloudSpot/cloudspot/actions/runs/44149567802/job/1",
    startedAt: iso(T0 + 10_000),
    completedAt: iso(T0 + min(2)),
    steps: [step()],
    ...over,
  };
}
