import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { shortSha } from "../../core/cluster.ts";
import type { ClusterEnv, ImageChange, RestartPlan, SyncPreview } from "../../core/types.ts";
import { Ext } from "./ui.tsx";

const REPO_URL = "https://github.com/CloudSpot/cloudspot";

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

const appUrl = (env: ClusterEnv, app: string) => `/api/cluster/${env}/apps/${encodeURIComponent(app)}`;

// ── Toasts ────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "bad";
}

export function useToasts() {
  const [items, setItems] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (text: string, tone: "ok" | "bad" = "ok") => {
      const id = next.current++;
      setItems((t) => [...t, { id, text, tone }]);
      setTimeout(() => dismiss(id), tone === "bad" ? 12_000 : 6_000);
    },
    [dismiss],
  );
  return { items, push, dismiss };
}

export function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span>{t.text}</span>
          <button className="rule-x" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Dialog shell ──────────────────────────────────────────────────────────

function Dialog({ env, title, onClose, children, actions }: { env: ClusterEnv; title: string; onClose: () => void; children: ReactNode; actions: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${env}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref}>
        <div className={`dialog-env ${env}`}>{env === "prd" ? "PRODUCTION" : "STAGING"}</div>
        <div className="dialog-body">
          <h2 id="dialog-title">{title}</h2>
          {children}
        </div>
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  );
}

// ── Sync ──────────────────────────────────────────────────────────────────

/** "Refresh & sync": refresh in Argo, show the diff, sync exactly the previewed revision. Staging skips the dialog. */
export function SyncButton({ env, app, toast }: { env: ClusterEnv; app: string; toast: (t: string, tone?: "ok" | "bad") => void }) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doSync = async (p: SyncPreview) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ revision: string }>(`${appUrl(env, app)}/sync`, { previewId: p.previewId });
      toast(`Sync started: ${app} → ${r.revision ? shortSha(r.revision) : "target"}`);
      setPreview(null);
    } catch (e) {
      const msg = (e as Error).message;
      if (/Git moved|expired|Unknown preview/.test(msg)) {
        // Reload the diff so what's confirmed is what's current.
        setError(`${msg} Reloaded below.`);
        await start(true);
        return;
      }
      if (env === "prd" && preview) setError(msg);
      else toast(`Sync failed: ${msg}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  const start = async (keepError = false) => {
    setBusy(true);
    if (!keepError) setError(null);
    try {
      const p = await post<SyncPreview>(`${appUrl(env, app)}/preview`, {});
      if (env === "prd") setPreview(p);
      else if (!p.resources.length) toast(`${app} is already in sync with git.`);
      else await doSync(p);
    } catch (e) {
      toast(`Couldn’t preview the sync: ${(e as Error).message}`, "bad");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className={`button action ${env}`} onClick={() => start()} disabled={busy}>
        {busy && !preview ? "Refreshing…" : "Refresh & sync"}
      </button>
      {preview && (
        <Dialog
          env={env}
          title={preview.resources.length ? `Sync ${app} to infra ${preview.revision ? shortSha(preview.revision) : "HEAD"}?` : `${app} is in sync`}
          onClose={() => setPreview(null)}
          actions={
            <>
              <button className="button" onClick={() => setPreview(null)} data-autofocus>
                Cancel
              </button>
              <button className="button danger" disabled={busy || !preview.resources.length} onClick={() => doSync(preview)}>
                {busy ? "Syncing…" : "Sync production"}
              </button>
            </>
          }
        >
          <p className="muted small">
            Refreshed from git just now.{" "}
            {preview.resources.length
              ? `${preview.resources.length} resource${preview.resources.length === 1 ? "" : "s"} will change.`
              : "Nothing would change, so there’s nothing to sync."}
            {preview.revisionUrl && (
              <>
                {" "}
                <Ext href={preview.revisionUrl}>View the infra commit ↗</Ext>
              </>
            )}
          </p>
          {error && <p className="fail-text small">{error}</p>}
          {preview.images.map((i) => (
            <ImageChangeRow key={`${i.resource}/${i.container}`} change={i} />
          ))}
          {preview.resources.map((r) => (
            <details key={`${r.kind}/${r.name}`} className="diff" open={preview.resources.length <= 2}>
              <summary>
                <span className="muted small">{r.kind}</span> <code>{r.name}</code>{" "}
                <span className={`pill ${r.status === "OutOfSync" ? "warn" : r.status === "Missing" ? "info" : "bad"}`}>
                  {r.status === "Missing" ? "Will be created" : r.status === "Extra" ? "Will be pruned" : "Out of sync"}
                </span>
              </summary>
              <pre className="patch">
                {r.patch.split("\n").map((l, k) => (
                  <span key={k} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>
                    {l}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </details>
          ))}
          <p className="muted small">
            The sync is pinned to this revision. If git moves before you confirm, it’s refused and the diff reloads. A macOS
            dialog asks once more before Argo is called.
          </p>
        </Dialog>
      )}
    </>
  );
}

function ShaPr({ img, tone }: { img: ImageChange["from"]; tone: "add" | "del" }) {
  if (!img) return <span className="muted small">none</span>;
  return (
    <span className="image-cell">
      <code className={`sha-chip ${tone}`}>{img.sha ? shortSha(img.sha) : img.tag}</code>
      {img.pr ? (
        <Ext href={img.pr.htmlUrl}>
          #{img.pr.number} {img.pr.title}
        </Ext>
      ) : img.sha ? (
        <Ext href={`${REPO_URL}/commit/${img.sha}`}>commit ↗</Ext>
      ) : null}
    </span>
  );
}

function ImageChangeRow({ change }: { change: ImageChange }) {
  const compare = change.from?.sha && change.to?.sha ? `${REPO_URL}/compare/${change.from.sha}...${change.to.sha}` : null;
  return (
    <div className="image-change">
      <div className="small muted">
        {change.resource} · container <code>{change.container}</code>
        {compare && (
          <>
            {" · "}
            <Ext href={compare}>compare ↗</Ext>
          </>
        )}
      </div>
      <div className="image-change-grid">
        <span className="muted small">From</span>
        <ShaPr img={change.from} tone="del" />
        <span className="muted small">To</span>
        <ShaPr img={change.to} tone="add" />
      </div>
    </div>
  );
}

// ── Restart ───────────────────────────────────────────────────────────────

export function RestartButton({ env, app, toast }: { env: ClusterEnv; app: string; toast: (t: string, tone?: "ok" | "bad") => void }) {
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<RestartPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restart = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`${appUrl(env, app)}/restart`, env === "prd" ? { confirm: app } : {});
      toast(`Restart started: ${app}`);
      setPlan(null);
    } catch (e) {
      if (plan) setError((e as Error).message);
      else toast(`Restart failed: ${(e as Error).message}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (env !== "prd") return restart();
    setBusy(true);
    try {
      setPlan(await get<RestartPlan>(`${appUrl(env, app)}/restart-plan`));
    } catch (e) {
      toast(`Can’t restart: ${(e as Error).message}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className={`button action ${env}`} onClick={start} disabled={busy}>
        {busy && !plan ? "Restarting…" : "Restart"}
      </button>
      {plan && (
        <Dialog
          env={env}
          title={`Restart ${plan.deployment}?`}
          onClose={() => setPlan(null)}
          actions={
            <>
              <button className="button" onClick={() => setPlan(null)} data-autofocus>
                Cancel
              </button>
              <button className="button danger" disabled={busy} onClick={restart}>
                {busy ? "Restarting…" : "Restart in production"}
              </button>
            </>
          }
        >
          <p className="muted small">
            Kubernetes replaces the {plan.pods.length} pod{plan.pods.length === 1 ? "" : "s"} one at a time with the same image.
            {plan.sha && (
              <>
                {" "}
                The running commit stays <code>{shortSha(plan.sha)}</code>.
              </>
            )}
          </p>
          <ul className="restart-pods">
            {plan.pods.map((p) => (
              <li key={p.name}>
                <code>{p.name}</code>
                <span className={`pill ${p.isReady ? "ok" : "bad"}`}>
                  {p.phase}
                  {p.restarts ? ` · ${p.restarts} restarts` : ""}
                </span>
              </li>
            ))}
          </ul>
          {error && <p className="fail-text small">{error}</p>}
          <p className="muted small">The action is logged in Foreman’s audit log. A macOS dialog asks once more before Argo is called.</p>
        </Dialog>
      )}
    </>
  );
}
