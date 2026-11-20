import { type ReactNode, useEffect, useMemo, useState } from "react";
import { formatAge, needsAttention, shortSha, sortApps } from "../../core/cluster.ts";
import { formatAgo } from "../../core/pr.ts";
import type {
  ClusterApp,
  ClusterAppsPayload,
  ClusterEnv,
  ClusterEnvInfo,
  ClusterPod,
  ClusterTreePayload,
  ImageRef,
  PrRef,
} from "../../core/types.ts";
import { LogsPanel } from "./LogsPanel.tsx";
import { RestartButton, SyncButton, Toasts, useToasts } from "./ClusterActions.tsx";
import { RouteLink, useSearch } from "./router.tsx";
import { Ext } from "./ui.tsx";

const REPO_URL = "https://github.com/CloudSpot/cloudspot";
const INFRA_URL = "https://github.com/CloudSpot/infrastructure";

/** /cluster?env=prd|stg&app=<name>: Argo apps, pods and logs for one environment. */
export function ClusterPage({ now }: { now: number }) {
  const search = useSearch();
  const env: ClusterEnv = search.get("env") === "stg" ? "stg" : "prd";
  const app = search.get("app");
  const tab = search.get("tab") === "jobs" ? "job" : "svc";
  const [envs, setEnvs] = useState<ClusterEnvInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();

  useEffect(() => {
    fetch("/api/cluster/config")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((b: { envs: ClusterEnvInfo[] }) => setEnvs(b.envs))
      .catch((e) => setError(`Couldn’t load the cluster settings: ${(e as Error).message}. Restart the server to pick up the Cluster page.`));
  }, []);

  useEffect(() => {
    document.title = `${app ? `${app} · ` : ""}${env === "prd" ? "Prod" : "Staging"} · Cluster`;
  }, [env, app]);

  const info = envs?.find((e) => e.id === env);
  return (
    <div className={`cluster env-${env}`}>
      <div className="cluster-head">
        <div className="env-tabs" role="tablist" aria-label="Environment">
          {(envs ?? [{ id: "prd", label: "Prod" }, { id: "stg", label: "Staging" }]).map((e) => (
            <RouteLink
              key={e.id}
              to="cluster"
              search={{ env: e.id, tab: !app && tab === "job" ? "jobs" : null }}
              role="tab"
              aria-selected={e.id === env}
              className={`env-tab ${e.id} ${e.id === env ? "active" : ""}`}
            >
              {e.label}
              {"configured" in e && !e.configured && <span className="muted small"> · not set up</span>}
            </RouteLink>
          ))}
        </div>
        {info?.host && <span className="muted small env-host">{info.host}</span>}
      </div>

      {error && <div className="banner">{error}</div>}
      {!envs && !error && <p className="muted">Loading…</p>}
      {info && !info.configured && <NotConfigured info={info} />}
      {info?.configured && (app ? (
        <AppDetail key={`${env}/${app}`} env={env} app={app} now={now} toast={toasts.push} />
      ) : (
        <AppList key={env} env={env} tab={tab} now={now} toast={toasts.push} />
      ))}
      <Toasts items={toasts.items} onDismiss={toasts.dismiss} />
    </div>
  );
}

function NotConfigured({ info }: { info: ClusterEnvInfo }) {
  return (
    <section className="cluster-card empty-state">
      <h2>{info.label} isn’t set up</h2>
      <p>The server is missing {info.missing.map((m, i) => <span key={m}>{i ? ", " : ""}<code>{m}</code></span>)}.</p>
      <p className="muted small">
        Start the server with the Argo variables in its environment, for example{" "}
        <code>doppler run --project matt-pr-dashboard --config prd -- pnpm start</code>, or put them in{" "}
        <code>~/Library/Application Support/merge-watch/argo.env</code>. See <code>docs/specs/cluster-page.md</code>.
      </p>
    </section>
  );
}

// ── App list ──────────────────────────────────────────────────────────────

export function useClusterApps(env: ClusterEnv) {
  const [payload, setPayload] = useState<ClusterAppsPayload | null>(null);
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const es = new EventSource(`/api/cluster/${env}/events`);
    es.addEventListener("apps", (e) => {
      setPayload(JSON.parse((e as MessageEvent).data));
      setConnected(true);
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [env]);
  return { payload, connected };
}

function StreamBadge({ state, message, connected }: { state: string; message: string | null; connected: boolean }) {
  const s = !connected ? "reconnecting" : state;
  const text = s === "live" ? "Live" : s === "loading" ? "Connecting to Argo…" : s === "reconnecting" ? "Reconnecting…" : "Error";
  return (
    <span className={`stream-badge ${s}`} title={message ?? undefined}>
      <span className="dot" aria-hidden /> {text}
    </span>
  );
}

type ListTab = "svc" | "job";

async function setHidden(app: string, hidden: boolean) {
  const res = await fetch("/api/cluster/hidden", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app, hidden }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
}

function AppList({ env, tab, now, toast }: { env: ClusterEnv; tab: ListTab; now: number; toast: (t: string, tone?: "ok" | "bad") => void }) {
  const { payload, connected } = useClusterApps(env);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  // Applied at once, before the server's push arrives.
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const hiddenSet = useMemo(() => {
    const set = new Set(payload?.hidden ?? []);
    for (const [app, h] of Object.entries(pending)) h ? set.add(app) : set.delete(app);
    return set;
  }, [payload, pending]);
  useEffect(() => setPending({}), [payload?.hidden.join(",")]);

  const all = payload?.apps ?? [];
  const q = query.trim().toLowerCase();
  const inTab = useMemo(
    () => sortApps(all.filter((a) => a.group === tab && (!q || a.name.includes(q) || a.image?.pr?.title.toLowerCase().includes(q)))),
    [all, tab, q],
  );
  const visible = inTab.filter((a) => !hiddenSet.has(a.name));
  const hidden = inTab.filter((a) => hiddenSet.has(a.name));
  const count = (g: ListTab) => {
    const apps = all.filter((a) => a.group === g && !hiddenSet.has(a.name));
    return { total: apps.length, attention: apps.filter(needsAttention).length };
  };

  const toggle = async (app: string, hide: boolean) => {
    setPending((p) => ({ ...p, [app]: hide }));
    try {
      await setHidden(app, hide);
    } catch (e) {
      setPending((p) => {
        const { [app]: _, ...rest } = p;
        return rest;
      });
      toast(`Couldn’t ${hide ? "hide" : "unhide"} ${app}: ${(e as Error).message}`, "bad");
    }
  };

  return (
    <>
      <div className="cluster-toolbar">
        <div className="list-tabs" role="tablist" aria-label="App type">
          {(["svc", "job"] as const).map((g) => {
            const c = count(g);
            return (
              <RouteLink
                key={g}
                to="cluster"
                search={{ env, tab: g === "job" ? "jobs" : null }}
                role="tab"
                aria-selected={tab === g}
                className={`list-tab ${tab === g ? "active" : ""}`}
              >
                {g === "svc" ? "Services" : "Jobs"} <span className="muted small">{payload ? c.total : ""}</span>
                {c.attention > 0 && (
                  <span className="attention-count" title={needsAttentionText(c.attention).slice(3)}>
                    {c.attention}
                  </span>
                )}
              </RouteLink>
            );
          })}
        </div>
        <StreamBadge state={payload?.state ?? "loading"} message={payload?.message ?? null} connected={connected} />
        <input
          className="cluster-search"
          type="search"
          placeholder="Filter apps"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter apps"
        />
      </div>
      {payload?.message && <div className="banner">{payload.message}</div>}
      {!payload || (payload.state === "loading" && !payload.apps.length) ? (
        <p className="muted">Loading apps from Argo…</p>
      ) : (
        <section className="cluster-card">
          {visible.length === 0 ? (
            <p className="muted small">
              {q ? "No apps match the filter." : hidden.length ? `Every ${tab === "svc" ? "service" : "job"} is hidden.` : "No apps."}
            </p>
          ) : (
            <AppTable apps={visible} env={env} now={now} action={(a) => (
              <button className="icon-button" onClick={() => toggle(a.name, true)} title={`Hide ${a.name}`} aria-label={`Hide ${a.name}`}>
                <EyeOffIcon />
              </button>
            )} />
          )}
          {hidden.length > 0 && (
            <div className="hidden-apps">
              <button className="link-button" onClick={() => setShowHidden(!showHidden)} aria-expanded={showHidden}>
                {showHidden ? "Hide" : "Show"} {hidden.length} hidden {tab === "svc" ? "service" : "job"}
                {hidden.length === 1 ? "" : "s"}
                {!showHidden && needsAttentionText(hidden.filter(needsAttention).length)}
              </button>
              {showHidden && (
                <AppTable apps={hidden} env={env} now={now} dim action={(a) => (
                  <button className="link-button" onClick={() => toggle(a.name, false)}>
                    Unhide
                  </button>
                )} />
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

const needsAttentionText = (n: number) => (n ? ` · ${n} need${n === 1 ? "s" : ""} attention` : "");

function AppTable({
  apps,
  env,
  now,
  action,
  dim = false,
}: {
  apps: ClusterApp[];
  env: ClusterEnv;
  now: number;
  action: (a: ClusterApp) => ReactNode;
  dim?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className={`app-table list-table ${dim ? "dim" : ""}`}>
        <colgroup>
          <col className="c-app" />
          <col className="c-health" />
          <col className="c-sync" />
          <col className="c-pods" />
          <col className="c-restarts" />
          <col className="c-age" />
          <col />
          <col className="c-action" />
        </colgroup>
        <thead>
          <tr>
            <th>App</th>
            <th>Health</th>
            <th>Sync</th>
            <th className="num">Pods</th>
            <th className="num">Restarts</th>
            <th className="num" title="Since the newest pod started: the last rollout or restart">Age</th>
            <th>Running</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {apps.map((a) => (
            <AppRow key={a.name} app={a} env={env} now={now} action={action(a)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}

function AppRow({ app, env, now, action }: { app: ClusterApp; env: ClusterEnv; now: number; action: ReactNode }) {
  const op = app.operation;
  return (
    <tr className={`app-row rank-${needsAttention(app) ? "attention" : "ok"}`}>
      <td>
        <RouteLink to="cluster" search={{ env, app: app.name }} className="app-name">
          {app.name}
        </RouteLink>
        {(app.problem || (op && op.phase !== "Succeeded")) && (
          <div className="small muted app-note">
            {op && op.phase !== "Succeeded" && (
              <span className={op.phase === "Running" ? "" : "fail-text"}>
                Sync {op.phase.toLowerCase()}
                {op.startedAt && ` · ${formatAgo(op.startedAt, now)}`}
              </span>
            )}
            {op && op.phase !== "Succeeded" && app.problem && " · "}
            {app.problem}
          </div>
        )}
      </td>
      <td>
        <HealthPill health={app.health} />
      </td>
      <td>
        <SyncPill sync={app.sync} />
      </td>
      <td className="num">{app.pods ? (app.pods.total ? `${app.pods.ready}/${app.pods.total}` : "—") : "…"}</td>
      <td className={`num ${app.pods?.restarts ? "warn-text" : ""}`}>{app.pods ? app.pods.restarts : "…"}</td>
      <td className="num muted" title={app.newestPodAt ? new Date(app.newestPodAt).toLocaleString() : undefined}>
        {app.pods ? formatAge(app.newestPodAt, now) : "…"}
      </td>
      <td>
        <ImageCell image={app.image} mixed={app.image?.mixed} />
      </td>
      <td className="row-action">{action}</td>
    </tr>
  );
}

const HEALTH_TONE: Record<string, string> = {
  Healthy: "ok",
  Progressing: "info",
  Degraded: "bad",
  Missing: "bad",
  Suspended: "grey",
  Unknown: "grey",
};

export function HealthPill({ health }: { health: string }) {
  return <span className={`pill ${HEALTH_TONE[health] ?? "grey"}`}>{health}</span>;
}

export function SyncPill({ sync }: { sync: string }) {
  return <span className={`pill ${sync === "Synced" ? "ok" : sync === "OutOfSync" ? "warn" : "grey"}`}>{sync === "OutOfSync" ? "Out of sync" : sync}</span>;
}

/** Short SHA and its PR, linked. */
export function ImageCell({ image, mixed }: { image: (ImageRef & { pr: PrRef | null }) | null; mixed?: boolean }) {
  if (!image) return <span className="muted small">—</span>;
  if (!image.sha)
    return (
      <span className="small">
        <code>{image.tag}</code>
      </span>
    );
  return (
    <span className="image-cell">
      <Ext href={`${REPO_URL}/commit/${image.sha}`} className="sha">
        <code>{shortSha(image.sha)}</code>
      </Ext>
      {image.pr ? (
        <Ext href={image.pr.htmlUrl} className="pr-link">
          #{image.pr.number} {image.pr.title}
        </Ext>
      ) : null}
      {mixed && <span className="pill info small-pill" title="Pods run different commits, for example during a rollout">mixed</span>}
    </span>
  );
}

// ── App detail ────────────────────────────────────────────────────────────

function useTree(env: ClusterEnv, app: string) {
  const [payload, setPayload] = useState<ClusterTreePayload | null>(null);
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const es = new EventSource(`/api/cluster/${env}/apps/${encodeURIComponent(app)}/tree`);
    es.addEventListener("tree", (e) => {
      setPayload(JSON.parse((e as MessageEvent).data));
      setConnected(true);
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [env, app]);
  return { payload, connected };
}

function AppDetail({ env, app, now, toast }: { env: ClusterEnv; app: string; now: number; toast: (t: string, tone?: "ok" | "bad") => void }) {
  const { payload: apps } = useClusterApps(env);
  const { payload, connected } = useTree(env, app);
  const summary = apps?.apps.find((a) => a.name === app) ?? null;
  const tree = payload?.tree ?? null;
  const [logPod, setLogPod] = useState<string | null>(null);
  const group = summary?.group ?? (tree?.deployment?.kind === "Deployment" ? "svc" : "job");
  const newestSha = tree?.shas[0] ?? null;

  return (
    <>
      <div className="cluster-toolbar">
        <RouteLink to="cluster" search={{ env, tab: group === "job" ? "jobs" : null }} className="link-button">
          ← All {group === "job" ? "jobs" : "services"}
        </RouteLink>
        <StreamBadge state={payload?.state ?? "loading"} message={payload?.message ?? null} connected={connected} />
      </div>
      {payload?.message && <div className="banner">{payload.message}</div>}

      <section className="cluster-card app-head">
        <div className="app-head-main">
          <h2 className="app-title">{app}</h2>
          <div className="app-pills">
            {summary && <HealthPill health={summary.health} />}
            {summary && <SyncPill sync={summary.sync} />}
            {summary?.operation && summary.operation.phase !== "Succeeded" && (
              <span className={`pill ${summary.operation.phase === "Running" ? "info" : "bad"}`} title={summary.operation.message ?? undefined}>
                Sync {summary.operation.phase.toLowerCase()}
              </span>
            )}
            {tree?.deployment && (
              <span className="muted small">
                {tree.deployment.kind} <code>{tree.deployment.name}</code>
              </span>
            )}
          </div>
          <div className="small app-facts">
            <span>
              Running <ImageCell image={summary?.image ?? null} mixed={summary?.image?.mixed} />
            </span>
            {summary?.revision && (
              <span className="muted">
                Infra{" "}
                <Ext href={`${INFRA_URL}/commit/${summary.revision}`}>
                  <code>{shortSha(summary.revision)}</code>
                </Ext>
              </span>
            )}
          </div>
          {summary?.operation?.message && summary.operation.phase !== "Succeeded" && (
            <p className="small fail-text">{summary.operation.message}</p>
          )}
        </div>
        <div className="app-actions">
          <SyncButton env={env} app={app} toast={toast} />
          {group === "svc" && <RestartButton env={env} app={app} toast={toast} />}
        </div>
      </section>

      <section className="cluster-card">
        <h2 className="cluster-group-title">
          Pods <span className="muted small">{tree ? tree.pods.length : ""}</span>
        </h2>
        {!tree ? (
          <p className="muted small">{payload?.state === "error" ? "Couldn’t read the app’s pods." : "Loading pods…"}</p>
        ) : tree.pods.length === 0 ? (
          <p className="muted small">No pods right now{group === "job" ? ". A CronJob only has pods while it runs." : "."}</p>
        ) : (
          <div className="table-scroll">
          <table className="app-table pod-table">
            <thead>
              <tr>
                <th>Pod</th>
                <th>Status</th>
                <th className="num">Ready</th>
                <th className="num">Restarts</th>
                <th>Age</th>
                <th>Commit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tree.pods.map((p) => (
                <PodRow
                  key={p.name}
                  pod={p}
                  stale={tree.shas.length > 1 && !!p.image?.sha && p.image.sha !== newestSha}
                  now={now}
                  selected={logPod === p.name}
                  onLogs={() => setLogPod(p.name)}
                />
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <LogsPanel
        env={env}
        app={app}
        pods={tree?.pods ?? []}
        allowAll={group === "svc"}
        pod={logPod ?? (group === "svc" ? "" : (tree?.pods[0]?.name ?? null))}
        onPod={setLogPod}
      />
    </>
  );
}

function PodRow({ pod, stale, now, selected, onLogs }: { pod: ClusterPod; stale: boolean; now: number; selected: boolean; onLogs: () => void }) {
  const bad = !pod.isReady && pod.phase !== "Completed" && pod.phase !== "Succeeded";
  return (
    <tr className={`${selected ? "selected" : ""}`}>
      <td>
        <code className="pod-name">{pod.name}</code>
      </td>
      <td>
        <span className={`pill ${pod.isReady ? "ok" : bad ? "bad" : "grey"}`}>{pod.phase}</span>
      </td>
      <td className="num">{pod.ready}</td>
      <td className={`num ${pod.restarts ? "warn-text" : ""}`}>{pod.restarts}</td>
      <td className="muted" title={pod.createdAt ? new Date(pod.createdAt).toLocaleString() : undefined}>
        {formatAge(pod.createdAt, now)}
      </td>
      <td>
        <ImageCell image={pod.image} />
        {stale && <span className="pill grey small-pill" title="An older commit than the newest pod">replaced</span>}
      </td>
      <td>
        <button className="link-button" onClick={onLogs}>
          Logs
        </button>
      </td>
    </tr>
  );
}

