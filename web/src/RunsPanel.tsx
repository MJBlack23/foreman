import { useEffect, useState } from "react";
import { computeEta, formatDuration, formatTimeLeft } from "../../core/eta.ts";
import { isRunActive } from "../../core/match.ts";
import { formatAgo } from "../../core/pr.ts";
import type { GhJob, GhStep, JobsPayload, RunSummary } from "../../core/types.ts";
import { Ext, hhmm } from "./ui.tsx";

const LIVE_POLL_MS = 10_000;
const FIRST_PAGE = 5;
const PAGE = 10;

/**
 * Right-hand panel: a hero with one run's live jobs and steps, then the list of
 * my deploy runs. The hero follows the running run (else the latest); clicking
 * a run in the list shows that run instead, until "Back to live".
 */
export function RunsPanel({
  runs,
  hidden,
  typicalMs,
  now,
}: {
  runs: RunSummary[];
  hidden: number;
  typicalMs: number | null;
  now: number;
}) {
  const [limit, setLimit] = useState(FIRST_PAGE);
  const [picked, setPicked] = useState<number | null>(null);
  const active = runs.filter((r) => isRunActive(r));
  const live = active[0] ?? runs[0] ?? null;
  const pinned = picked != null ? (runs.find((r) => r.id === picked) ?? null) : null;
  const hero = pinned ?? live;

  const pick = (id: number) => {
    setPicked(id === live?.id ? null : id);
    document.querySelector(".side")?.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <aside className="side">
      <div className="side-head">
        <h2>Deploy runs</h2>
        <span className="muted small">{active.length ? `${active.length} running` : "my branches"}</span>
      </div>
      {runs.length === 0 || !hero ? (
        <p className="muted small">No deploys on your branches in the latest 40 services-build runs.</p>
      ) : (
        <>
          <RunHero
            key={hero.id}
            run={hero}
            context={pinned && pinned.id !== live?.id ? "selected" : isRunActive(hero) ? "live" : "latest"}
            live={live}
            onBackToLive={() => setPicked(null)}
            typicalMs={typicalMs}
            now={now}
          />
          <div className="run-cards">
            {runs.slice(0, limit).map((r) => (
              <RunRow key={r.id} run={r} selected={r.id === hero.id} onPick={() => pick(r.id)} typicalMs={typicalMs} now={now} />
            ))}
            {runs.length > limit && (
              <button className="button show-more" onClick={() => setLimit(limit + PAGE)}>
                Show {Math.min(PAGE, runs.length - limit)} more
                <span className="muted"> · {runs.length - limit} older</span>
              </button>
            )}
          </div>
        </>
      )}
      {hidden > 0 && (
        <p className="muted small side-note" title="Finished in under 3 minutes, or skipped “Detect K8S targets”. Running and failed runs always show.">
          {hidden} run{hidden === 1 ? "" : "s"} that deployed nothing hidden
        </p>
      )}
    </aside>
  );
}

function runTone(r: RunSummary, failing = false) {
  if (isRunActive(r)) return failing ? "failure" : "running";
  if (r.conclusion === "success") return "success";
  if (r.conclusion === "failure") return "failure";
  return "neutral";
}

function runStatusText(run: RunSummary, typicalMs: number | null, now: number, failing = false) {
  const active = isRunActive(run);
  const eta = computeEta(run.startedAt ?? run.createdAt, active ? now : Date.parse(run.updatedAt), typicalMs);
  const status = active
    ? failing
      ? "failing"
      : (formatTimeLeft(eta) ?? "running")
    : (run.conclusion ?? "done");
  return { eta, text: `${status} · ${formatDuration(eta.elapsedMs)}` };
}

/** A compact, clickable row in the run list. */
function RunRow({
  run,
  selected,
  onPick,
  typicalMs,
  now,
}: {
  run: RunSummary;
  selected: boolean;
  onPick: () => void;
  typicalMs: number | null;
  now: number;
}) {
  const tone = runTone(run);
  const { eta, text } = runStatusText(run, typicalMs, now);
  return (
    <button className={`run-card run-row ${tone} ${selected ? "selected" : ""}`} onClick={onPick} aria-pressed={selected}>
      <span className="run-card-head">
        <span className={`status-dot ${tone}`} aria-hidden />
        <span className="run-card-main">
          <span className="run-card-title">{run.pr ? run.pr.title : (run.headBranch ?? `Run #${run.runNumber}`)}</span>
          <span className="run-card-sub">
            #{run.runNumber}
            {run.pr && ` · PR #${run.pr.number}`} · {hhmm(run.createdAt)} · {text}
          </span>
        </span>
      </span>
      {isRunActive(run) && (
        <span className="bar thin">
          <span style={{ width: `${Math.round((eta.progress ?? 0.05) * 100)}%` }} />
        </span>
      )}
    </button>
  );
}

/** The panel's top card: one run in full, with jobs and steps refreshing live. */
function RunHero({
  run,
  context,
  live,
  onBackToLive,
  typicalMs,
  now,
}: {
  run: RunSummary;
  context: "live" | "latest" | "selected";
  live: RunSummary | null;
  onBackToLive: () => void;
  typicalMs: number | null;
  now: number;
}) {
  const active = isRunActive(run);
  const { data, error } = useLiveJobs(run, true);
  const failedJob = data?.jobs.find((j) => j.conclusion === "failure");
  const tone = runTone(run, !!failedJob);
  const { eta, text } = runStatusText(run, typicalMs, now, !!failedJob);

  return (
    <article className={`run-hero ${tone}`}>
      <div className="run-hero-top">
        <span className="eyebrow">
          {context === "live" ? "● Live" : context === "latest" ? "Latest deploy" : "Selected run"}
        </span>
        {context === "selected" && live && (
          <button className="link-button" onClick={onBackToLive}>
            {isRunActive(live) ? `Back to live #${live.runNumber}` : "Back to latest"}
          </button>
        )}
      </div>
      <h3 className="run-hero-title">
        {run.pr ? <Ext href={run.pr.htmlUrl}>{run.pr.title}</Ext> : (run.headBranch ?? `Run #${run.runNumber}`)}
      </h3>
      <div className="run-card-sub">
        Run #{run.runNumber}
        {run.pr && ` · PR #${run.pr.number}`} · started {hhmm(run.createdAt)}
        {run.actor && ` · by ${run.actor}`}
      </div>
      {run.headBranch && (
        <div className="small">
          <code>{run.headBranch}</code>
        </div>
      )}

      <div className="run-hero-status">
        <strong className={tone === "failure" ? "fail-text" : ""}>{text}</strong>
        {typicalMs != null && <span className="muted small">usually {Math.round(typicalMs / 60_000)}m</span>}
      </div>
      <div className="bar">
        <div style={{ width: `${Math.round((active ? (eta.progress ?? 0.05) : 1) * 100)}%` }} />
      </div>

      {!data && !error && <p className="muted small">Loading jobs…</p>}
      {error && <p className="fail-text small">Couldn’t load jobs: {error}</p>}
      {data && (
        <ul className="job-list">
          {data.jobs.length === 0 && <li className="muted small">Waiting for jobs to start…</li>}
          {data.jobs.map((j) => (
            <JobRow key={j.id} job={j} now={now} />
          ))}
        </ul>
      )}

      <div className="run-card-foot">
        <span className="muted small">
          {data ? `${active ? "Live · " : ""}updated ${formatAgo(data.fetchedAt, now)}` : ""}
        </span>
        <span className="run-links">
          {run.pr && <Ext href={run.pr.htmlUrl}>PR #{run.pr.number}</Ext>}
          <Ext href={run.htmlUrl}>Open run ↗</Ext>
        </span>
      </div>
    </article>
  );
}

function JobRow({ job, now }: { job: GhJob; now: number }) {
  const running = job.status === "in_progress";
  const state = job.status !== "completed" ? (running ? "running" : "queued") : (job.conclusion ?? "done");
  const end = job.completedAt ? Date.parse(job.completedAt) : now;
  const took = job.startedAt && job.status !== "queued" ? formatDuration(end - Date.parse(job.startedAt)) : "";
  // Show steps for the job that's running and for a failed one; others stay one line.
  const showSteps = running || job.conclusion === "failure";

  return (
    <li className={`job ${state}`}>
      <div className="job-line">
        <StateIcon state={state} />
        <Ext className="job-name" href={job.htmlUrl}>
          {job.name}
        </Ext>
        <span className="muted small">{took}</span>
      </div>
      {showSteps && job.steps.length > 0 && (
        <ol className="steps">
          {job.steps.map((s) => (
            <StepRow key={s.number} step={s} />
          ))}
        </ol>
      )}
    </li>
  );
}

function StepRow({ step }: { step: GhStep }) {
  const state =
    step.status !== "completed" ? (step.status === "in_progress" ? "running" : "queued") : (step.conclusion ?? "done");
  return (
    <li className={`step ${state}`}>
      <StateIcon state={state} />
      <span>{step.name}</span>
    </li>
  );
}

function StateIcon({ state }: { state: string }) {
  const glyph =
    state === "success"
      ? "✓"
      : state === "failure"
        ? "✕"
        : state === "running"
          ? ""
          : state === "skipped" || state === "cancelled"
            ? "–"
            : "○";
  return (
    <span className={`state-icon ${state}`} aria-label={state}>
      {glyph}
    </span>
  );
}

/**
 * Jobs for an expanded card. Running runs re-poll every ~10s while the tab is
 * visible; finished runs load once (and again if the run changes).
 */
function useLiveJobs(run: RunSummary, open: boolean) {
  const [data, setData] = useState<JobsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = isRunActive(run);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`/api/runs/${run.id}/jobs`);
          const body = await res.json();
          if (cancelled) return;
          if (!res.ok) throw new Error(body.error ?? res.statusText);
          setData(body as JobsPayload);
          setError(null);
        } catch (e) {
          if (!cancelled) setError((e as Error).message);
        }
      }
      if (!cancelled && active) timer = setTimeout(load, LIVE_POLL_MS);
    };
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible" && active) {
        if (timer) clearTimeout(timer);
        void load();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [open, run.id, active, run.updatedAt]);

  return { data, error };
}
