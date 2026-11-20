import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { compileRules, type FilterRule, lineMatches } from "../../core/cluster.ts";
import type { ClusterEnv, ClusterPod, LogLine } from "../../core/types.ts";

const RING = 5000;
const RENDER_MAX = 2000;

type StreamStatus = "connecting" | "streaming" | "ended" | "gone" | "error" | "disconnected";

const localTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour12: false });
};

function loadRules(key: string): FilterRule[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.text === "string") : [];
  } catch {
    return [];
  }
}

function saveRules(key: string, rules: FilterRule[]) {
  try {
    localStorage.setItem(key, JSON.stringify(rules));
  } catch {}
}

/**
 * Live tail of one pod, or every pod of a Deployment, through the dashboard
 * server. Filtering runs here on the last 5,000 lines, so changing a rule
 * re-filters what already arrived.
 */
export function LogsPanel({
  env,
  app,
  pods,
  allowAll,
  pod,
  onPod,
}: {
  env: ClusterEnv;
  app: string;
  pods: ClusterPod[];
  allowAll: boolean;
  /** "" = all pods of the Deployment; null = nothing picked yet. */
  pod: string | null;
  onPod: (pod: string | null) => void;
}) {
  const [container, setContainer] = useState("");
  const [containers, setContainers] = useState<string[]>([]);
  const [previous, setPrevious] = useState(false);
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [frozen, setFrozen] = useState<LogLine[] | null>(null);
  const [received, setReceived] = useState(0);
  const [pausedAt, setPausedAt] = useState(0);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const rulesKey = `cluster-log-rules:${app}`;
  const [rules, setRules] = useState<FilterRule[]>(() => loadRules(rulesKey));
  const [draft, setDraft] = useState<FilterRule>({ mode: "include", text: "", regex: false });
  const [wrap, setWrap] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const podInfo = pods.find((p) => p.name === pod);
  const canPrevious = !!podInfo && podInfo.restarts > 0;

  useEffect(() => saveRules(rulesKey, rules), [rulesKey, rules]);
  useEffect(() => {
    if (!canPrevious) setPrevious(false);
  }, [canPrevious]);

  // Container names for a single pod.
  useEffect(() => {
    setContainers([]);
    setContainer("");
    if (!pod) return;
    let cancelled = false;
    fetch(`/api/cluster/${env}/apps/${encodeURIComponent(app)}/pods/${encodeURIComponent(pod)}`)
      .then((r) => (r.ok ? r.json() : { containers: [] }))
      .then((b: { containers?: string[] }) => {
        if (!cancelled) setContainers(b.containers ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [env, app, pod]);

  // The stream itself.
  useEffect(() => {
    if (pod == null) return;
    setLines([]);
    setReceived(0);
    setStatus("connecting");
    setMessage(null);
    stick.current = true;
    const q = new URLSearchParams({ tail: "500", previous: previous ? "1" : "0" });
    if (pod) q.set("pod", pod);
    if (container) q.set("container", container);
    const es = new EventSource(`/api/cluster/${env}/apps/${encodeURIComponent(app)}/logs?${q}`);
    let done = false;
    es.onopen = () => setStatus((s) => (s === "connecting" ? "streaming" : s));
    es.addEventListener("lines", (e) => {
      const batch = JSON.parse((e as MessageEvent).data) as LogLine[];
      setStatus("streaming");
      setReceived((n) => n + batch.length);
      setLines((prev) => {
        const next = prev.length + batch.length > RING ? [...prev, ...batch].slice(-RING) : [...prev, ...batch];
        return next;
      });
    });
    es.addEventListener("end", (e) => {
      done = true;
      const d = JSON.parse((e as MessageEvent).data || "{}") as { gone?: boolean; message?: string };
      setStatus(d.gone ? "gone" : "ended");
      setMessage(d.message ?? null);
      es.close();
    });
    // "fail", not "error": EventSource uses "error" for its own connection errors.
    es.addEventListener("fail", (e) => {
      done = true;
      setStatus("error");
      setMessage((JSON.parse((e as MessageEvent).data) as { message?: string }).message ?? "Log stream failed");
      es.close();
    });
    // A dropped connection: don't let EventSource replay the backlog on its own.
    es.onerror = () => {
      if (done) return;
      es.close();
      setStatus("disconnected");
    };
    return () => es.close();
  }, [env, app, pod, container, previous, attempt]);

  const compiled = useMemo(() => compileRules(rules), [rules]);
  const source = paused && frozen ? frozen : lines;
  const visible = useMemo(() => source.filter((l) => lineMatches(l.text, compiled)), [source, compiled]);
  const shown = visible.length > RENDER_MAX ? visible.slice(-RENDER_MAX) : visible;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const togglePause = () => {
    if (paused) {
      setPaused(false);
      setFrozen(null);
    } else {
      setPaused(true);
      setFrozen(lines);
      setPausedAt(received);
    }
  };

  const addRule = () => {
    if (!draft.text.trim()) return;
    setRules([...rules, { ...draft, text: draft.text.trim() }]);
    setDraft({ ...draft, text: "" });
  };

  const multiPod = pod === "";
  const statusText: Record<StreamStatus, string> = {
    connecting: "Connecting…",
    streaming: previous ? "Previous container" : "Live",
    ended: previous ? "End of previous container’s log" : "Stream ended",
    gone: "Pod no longer exists",
    error: "Error",
    disconnected: "Disconnected",
  };

  return (
    <section className="cluster-card logs">
      <div className="logs-head">
        <h2 className="cluster-group-title">Logs</h2>
        <label className="field">
          <span className="sr-only">Pod</span>
          <select value={pod ?? ""} onChange={(e) => onPod(e.target.value)} aria-label="Pod">
            {allowAll && <option value="">All pods</option>}
            {!allowAll && pod == null && <option value="">Pick a pod</option>}
            {pods.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {containers.length > 1 && (
          <select value={container} onChange={(e) => setContainer(e.target.value)} aria-label="Container">
            <option value="">Default container</option>
            {containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <label className={`check ${canPrevious ? "" : "disabled"}`} title={canPrevious ? "Logs of the container before its last restart" : "Only for a pod that has restarted"}>
          <input type="checkbox" checked={previous} disabled={!canPrevious} onChange={(e) => setPrevious(e.target.checked)} /> Previous container
        </label>
        <button className="button" onClick={togglePause} disabled={status !== "streaming" && !paused}>
          {paused ? `Resume${received - pausedAt ? ` (${received - pausedAt} new)` : ""}` : "Pause"}
        </button>
        <label className="check">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
        </label>
        <span className={`stream-badge ${status === "streaming" ? "live" : status === "connecting" ? "loading" : status === "error" || status === "disconnected" ? "error" : "ended"}`}>
          <span className="dot" aria-hidden /> {statusText[status]}
        </span>
        {(status === "disconnected" || status === "error" || status === "ended") && !previous && (
          <button className="link-button" onClick={() => setAttempt((n) => n + 1)}>
            Reconnect
          </button>
        )}
      </div>

      <div className="rules">
        {compiled.map((r, i) => (
          <span key={i} className={`rule ${r.mode} ${r.error ? "invalid" : ""}`} title={r.error ?? undefined}>
            <button
              className="rule-mode"
              onClick={() => setRules(rules.map((x, j) => (j === i ? { ...x, mode: x.mode === "include" ? "exclude" : "include" } : x)))}
              title="Switch include / exclude"
            >
              {r.mode === "include" ? "+" : "−"}
            </button>
            <code>{r.regex ? `/${r.text}/` : r.text}</code>
            <button className="rule-x" onClick={() => setRules(rules.filter((_, j) => j !== i))} aria-label={`Remove rule ${r.text}`}>
              ×
            </button>
          </span>
        ))}
        <form
          className="rule-add"
          onSubmit={(e) => {
            e.preventDefault();
            addRule();
          }}
        >
          <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as FilterRule["mode"] })} aria-label="Rule mode">
            <option value="include">Include</option>
            <option value="exclude">Exclude</option>
          </select>
          <input
            type="text"
            value={draft.text}
            placeholder={draft.regex ? "regular expression" : "text"}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            aria-label="Rule text"
          />
          <label className="check">
            <input type="checkbox" checked={draft.regex} onChange={(e) => setDraft({ ...draft, regex: e.target.checked })} /> Regex
          </label>
          <button className="button" type="submit" disabled={!draft.text.trim()}>
            Add
          </button>
          {rules.length > 0 && (
            <button className="link-button" type="button" onClick={() => setRules([])}>
              Clear
            </button>
          )}
        </form>
        <span className="muted small rule-count">
          {visible.length.toLocaleString()} of {source.length.toLocaleString()} lines
        </span>
      </div>

      <div
        className={`log-view ${wrap ? "wrap" : ""}`}
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        role="log"
        aria-live="off"
      >
        {pod == null ? (
          <p className="muted small">Pick a pod to see its logs.</p>
        ) : shown.length === 0 ? (
          <p className="muted small">
            {status === "connecting" ? "Connecting…" : source.length ? "No lines match the rules." : message ?? "No log lines yet."}
          </p>
        ) : (
          shown.map((l, i) => (
            <div className="log-line" key={i}>
              {l.ts && <span className="log-ts">{localTime(l.ts)}</span>}
              {multiPod && <span className="log-pod">{l.pod.replace(`cloudspot-${app}-`, "")}</span>}
              <span className="log-text">{l.text}</span>
            </div>
          ))
        )}
        {message && shown.length > 0 && <p className={`small ${status === "error" ? "fail-text" : "muted"}`}>{message}</p>}
      </div>
    </section>
  );
}
