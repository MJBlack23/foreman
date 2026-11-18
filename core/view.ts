import { matchRunToPr, isRunActive } from "./match.ts";
import { reviewSummary, splitLabels } from "./pr.ts";
import { findFailedJob, prStatus } from "./status.ts";
import type { GhJob, GhPr, GhRun, PrView, RunSummary, Snapshot } from "./types.ts";

export interface ViewInput {
  prs: GhPr[];
  runs: GhRun[];
  jobsByRun: ReadonlyMap<number, GhJob[]>;
  nowMs: number;
}

export function buildPrViews({ prs, runs, jobsByRun, nowMs }: ViewInput): PrView[] {
  return prs
    .map((pr): PrView => {
      const run = matchRunToPr(pr, runs);
      const jobs = run ? jobsByRun.get(run.id) : undefined;
      const failed = findFailedJob(jobs);
      return {
        ...pr,
        ...splitLabels(pr.labels),
        review: reviewSummary(pr),
        status: prStatus(pr, run, jobs, nowMs),
        run: run
          ? {
              id: run.id,
              runNumber: run.runNumber,
              htmlUrl: run.htmlUrl,
              status: run.status,
              conclusion: run.conclusion,
              createdAt: run.createdAt,
              startedAt: run.runStartedAt,
              updatedAt: run.updatedAt,
              jobs: jobs ?? [],
              failed,
            }
          : null,
        link: failed
          ? { label: `Failed: ${failed.jobName}`, url: failed.url }
          : run
            ? { label: `Run #${run.runNumber}`, url: run.htmlUrl }
            : null,
      };
    })
    .sort((a, b) => sortKey(b) - sortKey(a));
}

/** Most recent activity first: merge/close time for closed PRs, update time for open. */
function sortKey(p: PrView): number {
  return Date.parse(p.mergedAt ?? p.closedAt ?? p.updatedAt);
}

/** Cards: every merged PR whose run is still going; otherwise the latest finished run. */
export function pickFeatured(prs: PrView[]): Snapshot["featured"] {
  const active = prs.filter((p) => p.run && isRunActive(p.run));
  if (active.length) return { mode: "active", prNumbers: active.map((p) => p.number) };
  const finished = prs
    .filter((p) => p.run)
    .sort((a, b) => Date.parse(b.run!.updatedAt) - Date.parse(a.run!.updatedAt));
  if (finished[0]) return { mode: "last", prNumbers: [finished[0].number] };
  return { mode: "none", prNumbers: [] };
}

/** Finished runs shorter than this deployed nothing (no services changed). */
export const MIN_DEPLOY_RUN_MS = 3 * 60_000;
const K8S_JOB = "Detect K8S targets";

/**
 * Whether a run belongs in the side panel. Running runs always do, and so do
 * failures. Otherwise drop no-op runs: under 3 minutes, or (when its jobs are
 * known) the "Detect K8S targets" job was skipped or missing.
 */
export function isDeployRun(run: GhRun, jobs: GhJob[] | undefined): boolean {
  if (isRunActive(run)) return true;
  if (run.conclusion === "failure") return true;
  const started = run.runStartedAt ?? run.createdAt;
  if (Date.parse(run.updatedAt) - Date.parse(started) < MIN_DEPLOY_RUN_MS) return false;
  if (jobs) {
    const k8s = jobs.find((j) => j.name === K8S_JOB);
    if (!k8s || k8s.conclusion === "skipped") return false;
  }
  return true;
}

/** Runs on the head branch of one of these PRs, or triggered by `login` (null: skip that rule). */
export function myBranchRuns(runs: GhRun[], prs: GhPr[], login: string | null): GhRun[] {
  const refs = new Set(prs.map((p) => p.headRef));
  return runs.filter((r) => (r.headBranch != null && refs.has(r.headBranch)) || (login != null && r.actor === login));
}

/**
 * Side panel runs: mine, deploy runs only (see isDeployRun), newest first,
 * each linked to the newest PR with that branch. Also returns how many
 * no-op runs were left out.
 */
export function buildMyRuns(
  runs: GhRun[],
  prs: GhPr[],
  login: string | null,
  jobsByRun: ReadonlyMap<number, GhJob[]> = new Map(),
): { runs: RunSummary[]; hidden: number } {
  const prByRef = new Map<string, GhPr>();
  for (const pr of [...prs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    prByRef.set(pr.headRef, pr);
  }
  const mine = myBranchRuns(runs, prs, login);
  const kept = mine
    .filter((r) => isDeployRun(r, jobsByRun.get(r.id)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((r): RunSummary => {
      const pr = r.headBranch ? prByRef.get(r.headBranch) : undefined;
      return {
        id: r.id,
        runNumber: r.runNumber,
        htmlUrl: r.htmlUrl,
        headBranch: r.headBranch,
        status: r.status,
        conclusion: r.conclusion,
        createdAt: r.createdAt,
        startedAt: r.runStartedAt,
        updatedAt: r.updatedAt,
        actor: r.actor,
        author: pr?.author ?? "me",
        pr: pr ? { number: pr.number, title: pr.title, htmlUrl: pr.htmlUrl } : null,
      };
    });
  return { runs: kept, hidden: mine.length - kept.length };
}
