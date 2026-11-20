import { useEffect, useState } from "react";
import {
  deployFailed,
  type Deployment,
  DOWN_AFTER_FAILURES,
  isInProgress,
  type NightShiftState,
  type Overall,
  type StripCell,
  type TickRecord,
} from "../../core/nightShift.ts";
import { formatAgo } from "../../core/pr.ts";
import { Toasts, useToasts } from "./ClusterActions.tsx";
import { Ext, hhmm } from "./ui.tsx";

const OVERALL: Record<Overall, { text: string; tone: string }> = {
  ok: { text: "Healthy", tone: "ok" },
  deploying: { text: "Deploying", tone: "warn" },
  bad: { text: "Needs attention", tone: "bad" },
  unknown: { text: "No data yet", tone: "grey" },
};

async function post<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

/** /night-shift: health, App Platform status and manual ticks for the night-shift app. */
export function NightShiftPage({ state, connected, now }: { state: NightShiftState | null; connected: boolean; now: number }) {
  const toasts = useToasts();
  const [checking, setChecking] = useState(false);
  const [ticking, setTicking] = useState(false);

  useEffect(() => {
    document.title = state?.overall === "bad" ? "(!) Night Shift · Foreman" : "Night Shift · Foreman";
  }, [state?.overall]);

  if (!state) return <p className="muted">{connected ? "Loading…" : "Connecting to the Foreman server…"}</p>;

  const checkNow = async () => {
    setChecking(true);
    try {
      await post("/api/night-shift/check");
    } catch (e) {
      toasts.push(`Check failed: ${(e as Error).message}`, "bad");
    } finally {
      setChecking(false);
    }
  };

  const tickNow = async () => {
    setTicking(true);
    try {
      const r = await post<{ result: string; status?: number | null; message?: string | null }>("/api/night-shift/tick");
      if (r.result === "started") toasts.push("Tick started. Results are in night-shift’s logs.");
      else if (r.result === "already-running") toasts.push("A tick is already running.");
      else if (r.result === "cancelled") toasts.push("Tick cancelled.");
      else if (r.result === "busy") toasts.push("Waiting on the confirm dialog from an earlier click.");
      else if (r.result === "unauthorized") toasts.push("night-shift refused the tick secret (401). Check NIGHT_SHIFT_TICK_SECRET in Doppler.", "bad");
      else toasts.push(`Tick failed: ${r.message ?? r.status ?? "unknown error"}`, "bad");
    } catch (e) {
      toasts.push(`Tick failed: ${(e as Error).message}`, "bad");
    } finally {
      setTicking(false);
    }
  };

  const o = OVERALL[state.overall];
  const busy = checking || state.checking;
  return (
    <div className="cluster night-shift">
      <div className="cluster-head">
        <h1 className="ns-title">Night Shift</h1>
        <span className={`pill ${o.tone}`}>{o.text}</span>
        <Ext href={state.url} className="muted small">
          {state.url.replace(/^https:\/\//, "")}
        </Ext>
        <div className="ns-actions">
          <button className="button" onClick={checkNow} disabled={busy}>
            {busy ? "Checking…" : "Check now"}
          </button>
          <button
            className="button"
            onClick={tickNow}
            disabled={!state.canTick || ticking || state.ticking}
            title={state.canTick ? "POST /tick, after a macOS confirm" : "Set NIGHT_SHIFT_TICK_SECRET to enable"}
          >
            {ticking || state.ticking ? "Ticking…" : "Tick now"}
          </button>
        </div>
      </div>

      {state.missing.length > 0 && (
        <div className="banner warn">
          The server is missing{" "}
          {state.missing.map((m, i) => (
            <span key={m}>
              {i ? " and " : ""}
              <code>{m}</code>
            </span>
          ))}
          . Add {state.missing.length > 1 ? "them" : "it"} to Doppler project <code>foreman</code> (as a reference to{" "}
          <code>night-shift</code>/<code>prd</code>) and restart Foreman.
        </div>
      )}

      <div className="ns-grid">
        <HealthCard state={state} now={now} />
        <DeployCard state={state} now={now} />
      </div>
      <TicksCard ticks={state.ticks} now={now} canTick={state.canTick} />
      <Toasts items={toasts.items} onDismiss={toasts.dismiss} />
    </div>
  );
}

function HealthCard({ state, now }: { state: NightShiftState; now: number }) {
  const h = state.health;
  const last = h.last;
  return (
    <section className="cluster-card">
      <div className="ns-card-head">
        <h2>Health</h2>
        <span className={`pill ${h.state === "up" ? "ok" : h.state === "down" ? "bad" : "grey"}`}>
          {h.state === "up" ? "Up" : h.state === "down" ? "Down" : "Unknown"}
        </span>
        <code className="muted">GET /health</code>
      </div>
      {last ? (
        <dl className="ns-kv">
          <dt>Last check</dt>
          <dd>
            {formatAgo(last.at, now)} · {last.ok ? "OK" : "Failed"}{" "}
            <span className="muted">
              ({last.status ? `HTTP ${last.status}` : (last.error ?? "no response")}
              {last.ms != null ? `, ${last.ms} ms` : ""})
            </span>
          </dd>
          {h.downSince && (
            <>
              <dt>Down since</dt>
              <dd className="fail-text">
                {hhmm(h.downSince)} ({formatAgo(h.downSince, now)})
              </dd>
            </>
          )}
          {!last.ok && !h.downSince && (
            <>
              <dt>Note</dt>
              <dd className="muted">One failed check. It counts as down after {DOWN_AFTER_FAILURES} in a row.</dd>
            </>
          )}
          <dt>Next check</dt>
          <dd>{state.nextHealthAt ? hhmm(state.nextHealthAt) : "—"}</dd>
        </dl>
      ) : (
        <p className="muted">No checks yet.</p>
      )}
      <UptimeStrip cells={h.strip} pct={h.uptimePct} />
    </section>
  );
}

function UptimeStrip({ cells, pct }: { cells: StripCell[]; pct: number | null }) {
  return (
    <div className="ns-strip-wrap">
      <div className="ns-strip" role="img" aria-label={`Last 24 hours: ${pct == null ? "no data" : `${pct.toFixed(1)}% of checks passed`}`}>
        {cells.map((c, i) => (
          <span key={i} className={`ns-cell ${c}`} />
        ))}
      </div>
      <div className="ns-strip-legend muted small">
        <span>24 h ago</span>
        <span>
          {pct == null ? "no data" : `${pct.toFixed(1)}% up`} · <span className="ns-cell none inline" /> no data
        </span>
        <span>now</span>
      </div>
    </div>
  );
}

function DeployCard({ state, now }: { state: NightShiftState; now: number }) {
  const s = state.status;
  if (!state.canPollStatus) {
    return (
      <section className="cluster-card">
        <div className="ns-card-head">
          <h2>App Platform</h2>
          <span className="pill grey">Not configured</span>
        </div>
        <p className="muted">
          Set <code>DO_API_TOKEN</code> (a read-only DigitalOcean token) to see deployments.
        </p>
        <Ext href={state.consoleUrl}>Open in DigitalOcean</Ext>
      </section>
    );
  }
  const latestDiffers = s?.latest && s.latest.id !== s.active?.id;
  return (
    <section className="cluster-card">
      <div className="ns-card-head">
        <h2>App Platform</h2>
        {s?.active && <PhasePill d={s.active} />}
        <Ext href={state.consoleUrl} className="small">
          Open in DigitalOcean
        </Ext>
      </div>
      {!s && <p className="muted">No status yet.</p>}
      {s && !s.ok && <p className="fail-text small">Last poll failed {formatAgo(s.at, now)}: {s.error}</p>}
      {s?.active && (
        <dl className="ns-kv">
          <dt>Live commit</dt>
          <dd>
            <Commit sha={s.active.commit} repo={state.repoUrl} />
          </dd>
          <dt>Live since</dt>
          <dd>{s.lastActiveAt ? `${hhmm(s.lastActiveAt)} (${formatAgo(s.lastActiveAt, now)})` : "—"}</dd>
          <dt>Cause</dt>
          <dd>{s.active.cause ?? "—"}</dd>
        </dl>
      )}
      {latestDiffers && s.latest && (
        <div className={`ns-latest ${deployFailed(s) ? "bad" : isInProgress(s.latest) ? "warn" : ""}`}>
          <div className="ns-card-head">
            <strong>Latest deployment</strong>
            <PhasePill d={s.latest} />
            <Ext href={`${state.consoleUrl}/deployments/${s.latest.id}`} className="small">
              {deployFailed(s) ? "Build log" : "Details"}
            </Ext>
          </div>
          <div className="small">
            <Commit sha={s.latest.commit} repo={state.repoUrl} /> · {s.latest.cause ?? "—"}
            {s.latest.createdAt && <span className="muted"> · started {formatAgo(s.latest.createdAt, now)}</span>}
          </div>
        </div>
      )}
      {s && (
        <p className="muted small">
          Polled {formatAgo(s.at, now)}
          {state.nextStatusAt && <> · next at {hhmm(state.nextStatusAt)}</>}
          {isInProgress(s.latest) && " (every minute while deploying)"}
        </p>
      )}
    </section>
  );
}

function PhasePill({ d }: { d: Deployment }) {
  const tone = d.phase === "ACTIVE" ? "ok" : d.phase === "ERROR" ? "bad" : isInProgress(d) ? "warn" : "grey";
  return <span className={`pill ${tone}`}>{d.phase.replaceAll("_", " ").toLowerCase()}</span>;
}

function Commit({ sha, repo }: { sha: string | null; repo: string }) {
  if (!sha) return <span className="muted">—</span>;
  return (
    <Ext href={`${repo}/commit/${sha}`}>
      <code>{sha.slice(0, 7)}</code>
    </Ext>
  );
}

const TICK_TEXT: Record<TickRecord["result"], { text: string; tone: string }> = {
  started: { text: "Started", tone: "ok" },
  "already-running": { text: "Already running", tone: "grey" },
  unauthorized: { text: "Unauthorized", tone: "bad" },
  error: { text: "Error", tone: "bad" },
};

function TicksCard({ ticks, now, canTick }: { ticks: TickRecord[]; now: number; canTick: boolean }) {
  return (
    <section className="cluster-card">
      <div className="ns-card-head">
        <h2>Manual ticks</h2>
        <code className="muted">POST /tick</code>
      </div>
      {!canTick && (
        <p className="muted small">
          Set <code>NIGHT_SHIFT_TICK_SECRET</code> to enable “Tick now”.
        </p>
      )}
      {ticks.length === 0 ? (
        <p className="muted small">No manual ticks in the last 7 days. night-shift also ticks itself every 10 minutes.</p>
      ) : (
        <ul className="ns-ticks">
          {ticks.map((t) => (
            <li key={`${t.at}-${t.result}`}>
              <span className={`pill ${TICK_TEXT[t.result].tone}`}>{TICK_TEXT[t.result].text}</span>
              <span>{hhmm(t.at)}</span>
              <span className="muted small">
                {formatAgo(t.at, now)}
                {t.status != null && ` · HTTP ${t.status}`}
                {t.message && ` · ${t.message}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
