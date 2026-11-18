import { isRunActive } from "./match.ts";
import type { FailedJobInfo, GhJob, GhPr, GhRun, PrStatus } from "./types.ts";

/** A merged PR with no matching run after this long had no services to build. */
export const NO_BUILD_AFTER_MS = 5 * 60_000;

/** The first failed job (in job order) and its failed step. */
export function findFailedJob(jobs: GhJob[] | undefined): FailedJobInfo | null {
  const job = jobs?.find((j) => j.conclusion === "failure");
  if (!job) return null;
  const step = job.steps.find((s) => s.conclusion === "failure");
  return {
    jobId: job.id,
    jobName: job.name,
    stepName: step?.name ?? null,
    url: job.htmlUrl,
    at: job.completedAt,
  };
}

export function prStatus(
  pr: GhPr,
  run: GhRun | undefined,
  jobs: GhJob[] | undefined,
  nowMs: number,
): PrStatus {
  if (pr.state === "open") return "open";
  if (!pr.mergedAt) return "closed";
  if (!run) {
    return nowMs - Date.parse(pr.mergedAt) >= NO_BUILD_AFTER_MS ? "no-build" : "waiting";
  }
  const failed = findFailedJob(jobs) != null;
  if (isRunActive(run)) return failed ? "failing" : "building";
  return run.conclusion === "failure" || failed ? "failed" : "complete";
}

export const STATUS_LABEL: Record<PrStatus, string> = {
  open: "Open",
  waiting: "Waiting for CI",
  building: "Building",
  failing: "CI failing",
  complete: "CI complete",
  failed: "CI failed",
  "no-build": "No services build",
  closed: "Closed",
};
