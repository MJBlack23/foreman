import type { GhPr, GhRun } from "./types.ts";

/** Allow for clock skew between merged_at and the run's created_at. */
const MERGE_SKEW_MS = 2 * 60_000;

/**
 * Find the services-build run a merged PR triggered.
 * Rule: event is pull_request and head_branch equals the PR's head ref; on
 * several matches (re-runs) take the newest by created_at. Runs created well
 * before the merge are ignored, so a reused branch name can't match an old run.
 */
export function matchRunToPr(pr: GhPr, runs: GhRun[]): GhRun | undefined {
  if (!pr.mergedAt) return undefined;
  const earliest = Date.parse(pr.mergedAt) - MERGE_SKEW_MS;
  let best: GhRun | undefined;
  for (const run of runs) {
    if (run.event !== "pull_request" || run.headBranch !== pr.headRef) continue;
    if (Date.parse(run.createdAt) < earliest) continue;
    if (!best || Date.parse(run.createdAt) > Date.parse(best.createdAt)) best = run;
  }
  return best;
}

export function isRunActive(run: GhRun | { status: string }): boolean {
  return run.status !== "completed";
}
