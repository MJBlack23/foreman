import { useEffect, useState } from "react";
import type { DeployTargetsPayload } from "../../core/types.ts";
import { RouteLink } from "./router.tsx";

const STATE_TEXT = { live: "live", rolling: "rolling", waiting: "waiting", replaced: "replaced", unknown: "unknown" } as const;

/**
 * The apps a finished run shipped, and whether each runs its commit yet.
 * Asks Argo once when shown (and every 15s while something is still rolling out).
 */
export function DeployTargets({ runId, done }: { runId: number; done: boolean }) {
  const [data, setData] = useState<DeployTargetsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!done) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const res = await fetch(`/api/cluster/runs/${runId}/targets`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        const p = body as DeployTargetsPayload;
        setData(p);
        setError(null);
        if (p.targets.some((t) => t.state === "rolling" || t.state === "waiting")) timer = setTimeout(load, 15_000);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, done]);

  if (!done) return null;
  if (error) return error.includes("not one of your runs") ? null : <p className="muted small">Cluster status unavailable: {error}</p>;
  if (!data) return <p className="muted small">Checking the cluster…</p>;
  if (!data.targets.length && !data.notes.length) return null;

  return (
    <div className="deploy-targets">
      <span className="section-label">Shipped to</span>
      {data.targets.map((t) => (
        <RouteLink key={`${t.env}/${t.app}`} to="cluster" search={{ env: t.env, app: t.app }} className="deploy-target" title={t.note}>
          <span className={`env-chip ${t.env}`}>{t.env.toUpperCase()}</span>
          <span className="deploy-app">{t.app}</span>
          <span className={`target-state ${t.state}`}>
            <span className="dot" aria-hidden /> {STATE_TEXT[t.state]}
          </span>
          <span className="muted small deploy-note">{t.note}</span>
        </RouteLink>
      ))}
      {data.notes.map((n) => (
        <span key={n} className="muted small">
          {n}
        </span>
      ))}
    </div>
  );
}
