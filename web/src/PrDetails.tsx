import { computeEta, formatDuration, formatMinutes, formatTimeLeft } from "../../core/eta.ts";
import { isRunActive } from "../../core/match.ts";
import { formatAgo } from "../../core/pr.ts";
import type { GhJob, PrView, RunView } from "../../core/types.ts";
import { Markdown } from "./Markdown.tsx";
import { Ext, hhmm } from "./ui.tsx";

/** "running" | "failed" | "done" for a PR with a run, else "open" | "neutral". */
export function prTone(pr: PrView): string {
  const run = pr.run;
  if (!run) return pr.state === "open" ? "open" : "neutral";
  if (run.failed != null || run.conclusion === "failure") return "failed";
  return isRunActive(run) ? "running" : "done";
}

/** What an expanded PR card adds: branch, the CI run (or why there is none), and actions. */
export function PrDetails({ pr, typicalMs, now }: { pr: PrView; typicalMs: number | null; now: number }) {
  const run = pr.run;
  return (
    <div className="pr-details">
      <div className="sub">
        <code>{pr.headRef}</code> → {pr.baseRef}
        {pr.mergedAt
          ? ` · merged ${hhmm(pr.mergedAt)}`
          : pr.closedAt
            ? ` · closed ${hhmm(pr.closedAt)}`
            : ` · opened ${formatAgo(pr.createdAt, now)}`}
        {run && ` · run #${run.runNumber}`}
      </div>

      <section className="summary">
        <div className="summary-head">
          <span className="section-label">Summary</span>
          <Ext href={pr.htmlUrl}>Full description ↗</Ext>
        </div>
        {pr.summary ? <Markdown text={pr.summary} /> : <p className="muted small">No description.</p>}
      </section>

      {run ? <RunBody run={run} typicalMs={typicalMs} now={now} /> : <NoRunBody pr={pr} now={now} />}

      <div className="actions">
        {run && (
          <Ext className="button primary" href={run.htmlUrl}>
            Open Run in GitHub
          </Ext>
        )}
        {run?.failed && (
          <Ext className="button danger" href={run.failed.url}>
            Open failed job
          </Ext>
        )}
        <Ext className={`button ${run ? "" : "primary"}`} href={pr.htmlUrl}>
          Open PR #{pr.number}
        </Ext>
        {pr.state === "open" && (
          <>
            <Ext className="button" href={`${pr.htmlUrl}/files`}>
              Files changed
            </Ext>
            <Ext className="button" href={`${pr.htmlUrl}/checks`}>
              Checks
            </Ext>
          </>
        )}
      </div>
    </div>
  );
}

function RunBody({ run, typicalMs, now }: { run: RunView; typicalMs: number | null; now: number }) {
  const active = isRunActive(run);
  const started = run.startedAt ?? run.createdAt;
  const eta = computeEta(started, active ? now : Date.parse(run.updatedAt), typicalMs);
  const failed = run.failed != null || run.conclusion === "failure";
  const progress = active ? (eta.progress ?? 0.05) : 1;
  return (
    <div className="run-body">
      <div className="timing">
        {failed ? (
          <strong className="fail-text">{active ? "Failing" : "Failed"}</strong>
        ) : active ? (
          <strong>{formatTimeLeft(eta) ?? "Running"}</strong>
        ) : (
          <strong>{run.conclusion === "success" ? "Complete" : (run.conclusion ?? "Done")}</strong>
        )}
        <span>
          {active ? "elapsed" : "took"} {formatDuration(eta.elapsedMs)}
        </span>
        {typicalMs != null && <span>usually {formatMinutes(typicalMs)}</span>}
      </div>
      <div className="bar">
        <div style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="chips">
        {run.jobs.length === 0 ? (
          <span className="muted">Waiting for jobs…</span>
        ) : (
          run.jobs.map((j) => <JobChip key={j.id} job={j} />)
        )}
      </div>
      {run.failed && (
        <div className="failure">
          <Ext href={run.failed.url}>{run.failed.jobName}</Ext> failed
          {run.failed.stepName ? (
            <>
              {" "}
              at step <code>{run.failed.stepName}</code>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function NoRunBody({ pr, now }: { pr: PrView; now: number }) {
  let text: string;
  if (pr.status === "waiting") text = `Merged ${formatAgo(pr.mergedAt!, now)}. Waiting for the services build to start…`;
  else if (pr.status === "no-build") text = "No services build ran for this merge. Only docs or non-service files changed.";
  else if (pr.status === "closed") text = "Closed without merging.";
  else text = `${pr.isDraft ? "Draft" : "Open"} · updated ${formatAgo(pr.updatedAt, now)}. CI deploys run when this merges.`;
  return <p className="detail-body">{text}</p>;
}

function JobChip({ job }: { job: GhJob }) {
  const state =
    job.status !== "completed" ? (job.status === "in_progress" ? "running" : "queued") : (job.conclusion ?? "done");
  return (
    <Ext className={`chip ${state}`} href={job.htmlUrl}>
      {job.name}
    </Ext>
  );
}
