import { formatDuration } from "./eta.ts";
import { buildServices } from "./pr.ts";
import { findFailedJob } from "./status.ts";
import type { GhJob, GhPr, GhRun, WatchEvent } from "./types.ts";

export const EVENT_WINDOW_MS = 24 * 60 * 60_000;

export interface PrRunJobs {
  pr: GhPr;
  run?: GhRun;
  jobs?: GhJob[];
}

/**
 * Derive the notification log from current state. Only three kinds:
 *  - merged:<pr>      when merged_at is set
 *  - failed:<runId>   when any job failed, or the run completed with failure
 *  - complete:<runId> when the run completed with any other conclusion
 *                     (and no job failed: the failure event covers that run)
 * Events older than the window are dropped. Newest first.
 */
export function buildEvents(items: PrRunJobs[], nowMs: number, windowMs = EVENT_WINDOW_MS): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const { pr, run, jobs } of items) {
    if (!pr.mergedAt) continue;
    const base = {
      prNumber: pr.number,
      prTitle: pr.title,
      prUrl: pr.htmlUrl,
      headRef: pr.headRef,
      deployProd: pr.labels.includes("deploy-prod"),
    };
    events.push({
      ...base,
      id: `merged:${pr.number}`,
      kind: "merged",
      at: pr.mergedAt,
      title: `Merged #${pr.number}`,
      detail: pr.title,
      url: pr.htmlUrl,
      run: null,
      failedJob: null,
      services: [],
    });
    if (!run) continue;

    const failed = findFailedJob(jobs);
    const runFailed = run.status === "completed" && run.conclusion === "failure";
    const services = buildServices(jobs);
    const runInfo = (endIso: string | null) => ({
      id: run.id,
      number: run.runNumber,
      url: run.htmlUrl,
      status: run.status,
      conclusion: run.conclusion,
      startedAt: run.runStartedAt,
      durationMs: run.runStartedAt && endIso ? Date.parse(endIso) - Date.parse(run.runStartedAt) : null,
    });

    if (failed || runFailed) {
      const at = failed?.at ?? run.updatedAt;
      events.push({
        ...base,
        id: `failed:${run.id}`,
        kind: "failed",
        at,
        title: `CI failed · #${pr.number}`,
        detail: failed
          ? failed.stepName
            ? `${failed.jobName} — ${failed.stepName}`
            : failed.jobName
          : `Run #${run.runNumber} failed`,
        url: failed?.url ?? run.htmlUrl,
        run: runInfo(at),
        failedJob: failed ? { name: failed.jobName, step: failed.stepName, url: failed.url } : null,
        services,
      });
    } else if (run.status === "completed") {
      const info = runInfo(run.updatedAt);
      const took = info.durationMs != null ? ` in ${formatDuration(info.durationMs)}` : "";
      events.push({
        ...base,
        id: `complete:${run.id}`,
        kind: "complete",
        at: run.updatedAt,
        title: `CI complete · #${pr.number}`,
        detail: `${run.conclusion ?? "done"}${took} · ${pr.title}`,
        url: run.htmlUrl,
        run: info,
        failedJob: null,
        services,
      });
    }
  }
  return events
    .filter((e) => nowMs - Date.parse(e.at) <= windowMs)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
