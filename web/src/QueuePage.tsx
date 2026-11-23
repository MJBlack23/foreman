import { type CSSProperties, Fragment, useEffect, useState } from "react";
import { formatAgo } from "../../core/pr.ts";
import { groupLane, LANES, NIGHT_SHIFT_LABEL, type QueueItem, type QueueState } from "../../core/queue.ts";
import { Toasts, useToasts } from "./ClusterActions.tsx";
import { RouteLink } from "./router.tsx";
import { Ext, shortDate } from "./ui.tsx";

type Via = "all" | "assigned" | "project";

const PRIORITY: Record<number, { text: string; tone: string }> = {
  1: { text: "Urgent", tone: "bad" },
  2: { text: "High", tone: "warn" },
  3: { text: "Medium", tone: "grey" },
  4: { text: "Low", tone: "grey" },
};

/** /queue: Linear issues assigned to me (or in projects I lead) that don't have an open PR yet. */
export function QueuePage({ state, connected, now }: { state: QueueState | null; connected: boolean; now: number }) {
  const toasts = useToasts();
  const [refreshing, setRefreshing] = useState(false);
  const [via, setVia] = useState<Via>("all");
  const collapsed = useCollapsed();
  const [sending, setSending] = useState<Set<string>>(new Set());

  const mine = state?.items.filter((i) => i.via === "assigned").length ?? 0;
  useEffect(() => {
    document.title = mine ? `(${mine}) Queue · Foreman` : "Queue · Foreman";
  }, [mine]);

  if (!state) return <p className="muted">{connected ? "Loading…" : "Connecting to the Foreman server…"}</p>;

  if (!state.configured) {
    return (
      <div className="queue">
        <h1 className="ns-title">Queue</h1>
        <div className="banner warn">
          The server is missing <code>LINEAR_API_KEY</code>. Add a read-only personal Linear key to Doppler project <code>foreman</code> and restart Foreman.
        </div>
      </div>
    );
  }

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/queue/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? res.statusText);
    } catch (e) {
      toasts.push(`Refresh failed: ${(e as Error).message}`, "bad");
    } finally {
      setRefreshing(false);
    }
  };

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toasts.push(done);
    } catch {
      toasts.push("Couldn’t copy to the clipboard.", "bad");
    }
  };

  const sendToNightShift = async (i: QueueItem) => {
    setSending((s) => new Set(s).add(i.id));
    try {
      const res = await fetch(`/api/queue/${encodeURIComponent(i.id)}/night-shift`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await res.json().catch(() => null)) as { result?: string; movedTo?: string; error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? res.statusText);
      if (body?.result === "sent")
        toasts.push(`Sent ${i.id} to night-shift${body.movedTo ? ` and moved it to ${body.movedTo}` : ""}. It picks it up on the next tick.`);
      else if (body?.result === "already") toasts.push(`${i.id} already has ${NIGHT_SHIFT_LABEL}.`);
      else if (body?.result === "busy") toasts.push("Waiting on the confirm dialog from an earlier click.");
    } catch (e) {
      toasts.push(`Couldn’t send ${i.id}: ${(e as Error).message}`, "bad");
    } finally {
      setSending((s) => {
        const next = new Set(s);
        next.delete(i.id);
        return next;
      });
    }
  };

  const famToggle = (lane: string, parentId: string, count: number): Toggle => {
    const key = `${lane}:${parentId}`;
    return { collapsed: collapsed.has(key), count, parentId, onToggle: () => collapsed.toggle(key) };
  };

  const hasProject = state.items.some((i) => i.via === "project");
  const shown = state.items.filter((i) => via === "all" || i.via === via);
  const busy = refreshing || state.polling;

  return (
    <div className="queue">
      <div className="cluster-head">
        <h1 className="ns-title">Queue</h1>
        <span className="pill grey">{shown.length} without a PR</span>
        <span className="muted small">
          {state.polledAt ? `Linear checked ${formatAgo(state.polledAt, now)}` : "Checking Linear…"}
          {state.withPr > 0 && (
            <>
              {" · "}
              <RouteLink to="dashboard">
                {state.withPr} with an open PR {state.withPr === 1 ? "is" : "are"} on the PRs tab
              </RouteLink>
            </>
          )}
        </span>
        <div className="ns-actions">
          <button className="button" onClick={refresh} disabled={busy}>
            {busy ? "Checking…" : "Refresh"}
          </button>
        </div>
      </div>

      {state.error && <div className="banner">Linear poll failed: {state.error}</div>}

      {hasProject && (
        <div className="queue-filter" role="group" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["assigned", "Assigned to me"],
              ["project", "Projects I lead"],
            ] as [Via, string][]
          ).map(([v, label]) => (
            <button key={v} className={`tag ${via === v ? "active" : ""}`} onClick={() => setVia(v)} aria-pressed={via === v}>
              {label}
            </button>
          ))}
        </div>
      )}

      {state.polledAt && shown.length === 0 && (
        <div className="cluster-card empty-state">
          <h2>Nothing queued</h2>
          <p className="muted">Every started or to-do issue of yours has an open PR.</p>
        </div>
      )}

      {LANES.map((lane) => {
        const items = shown.filter((i) => i.lane === lane.id);
        if (!items.length) return null;
        return (
          <section key={lane.id} className={`queue-lane lane-${lane.id}`} aria-labelledby={`lane-${lane.id}`}>
            <div className="queue-lane-head">
              <h2 id={`lane-${lane.id}`}>{lane.title}</h2>
              <span className="muted small">
                {items.length} · {lane.hint}
              </span>
            </div>
            <ul className="queue-list">
              {groupLane(items).map((g) => {
                const base = g.project ? 1 : 0;
                const row = (i: QueueItem, depth: number, toggle?: Toggle) => (
                  <QueueRow
                    key={i.id}
                    item={i}
                    depth={depth}
                    toggle={toggle}
                    now={now}
                    sending={sending.has(i.id)}
                    onCopyBranch={(b) => copy(b, `Copied ${b}`)}
                    onSend={() => sendToNightShift(i)}
                  />
                );
                return (
                  <Fragment key={g.project?.url ?? "none"}>
                    {g.project && (
                      <li className="queue-group-head">
                        <ProjectIcon />
                        <Ext href={g.project.url}>{g.project.name}</Ext>
                        <span className="muted small">{g.count}</span>
                      </li>
                    )}
                    {g.entries.map((e) =>
                      e.kind === "item" ? (
                        row(e.item, base)
                      ) : (
                        <Fragment key={`fam-${e.parent.id}`}>
                          {e.head ? (
                            row(e.head, base, famToggle(lane.id, e.parent.id, e.children.length))
                          ) : (
                            <li className="queue-parent-head" style={depthStyle(base)}>
                              <Chevron {...famToggle(lane.id, e.parent.id, e.children.length)} />
                              <span className="muted small">Sub-issues of</span>
                              <Ext href={e.parent.url} className="queue-id">
                                {e.parent.id}
                              </Ext>
                              <Ext href={e.parent.url} className="queue-parent-title">
                                {e.parent.title}
                              </Ext>
                              {e.parent.state && <span className="muted small">{e.parent.state}</span>}
                            </li>
                          )}
                          {!collapsed.has(`${lane.id}:${e.parent.id}`) && e.children.map((c) => row(c, base + 1))}
                        </Fragment>
                      ),
                    )}
                  </Fragment>
                );
              })}
            </ul>
          </section>
        );
      })}
      <Toasts items={toasts.items} onDismiss={toasts.dismiss} />
    </div>
  );
}

interface Toggle {
  collapsed: boolean;
  count: number;
  parentId: string;
  onToggle: () => void;
}

const COLLAPSED_KEY = "foreman.queue.collapsed";

/** Which parents are folded, per lane ("blocked:PLAT-2104"). Kept in this browser only. */
function useCollapsed() {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    setSet((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Private window or blocked storage: folding still works until reload.
      }
      return next;
    });
  return { has: (key: string) => set.has(key), toggle };
}

/** The fold button on a parent: a chevron, plus the hidden count while folded. */
function Chevron({ collapsed, count, parentId, onToggle }: Toggle) {
  return (
    <button
      className={`queue-fold ${collapsed ? "collapsed" : ""}`}
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? "Show" : "Hide"} ${count} sub-issue${count === 1 ? "" : "s"} of ${parentId}`}
      title={collapsed ? `Show ${count} sub-issue${count === 1 ? "" : "s"}` : "Hide sub-issues"}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m6 9 6 6 6-6" />
      </svg>
      {collapsed && <span className="queue-fold-count">{count}</span>}
    </button>
  );
}

/** Rows step right by this much per level (project, then parent). */
const depthStyle = (depth: number): CSSProperties | undefined => (depth ? ({ "--depth": depth } as CSSProperties) : undefined);

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function PlaneIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />
    </svg>
  );
}

function ProjectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function QueueRow({
  item: i,
  depth,
  toggle,
  now,
  sending,
  onCopyBranch,
  onSend,
}: {
  item: QueueItem;
  depth: number;
  /** Set when this row is a parent with sub-issues below it. */
  toggle?: Toggle;
  now: number;
  sending: boolean;
  onCopyBranch: (b: string) => void;
  onSend: () => void;
}) {
  const ready = i.labels.includes(NIGHT_SHIFT_LABEL);
  const prio = PRIORITY[i.priority];
  const branch = i.branch?.name ?? i.branchName;
  const overdue = i.dueDate && Date.parse(i.dueDate) < now;
  return (
    <li className={`queue-row ${i.stale ? "stale" : ""} ${depth > 0 ? "nested" : ""}`} style={depthStyle(depth)}>
      <div className="queue-main">
        <div className="queue-title-line">
          {toggle && <Chevron {...toggle} />}
          <Ext href={i.url} className="queue-id">
            {i.id}
          </Ext>
          <Ext href={i.url} className="queue-title">
            {i.title}
          </Ext>
        </div>
        <div className="queue-meta small">
          <span className="queue-state">
            <span className="queue-state-dot" style={{ background: i.state.color }} aria-hidden />
            {i.state.name}
          </span>
          {prio && <span className={`pill ${prio.tone}`}>{prio.text}</span>}
          {i.stale && <span className="pill warn" title="Started a while ago with no branch or PR">Stale</span>}
          {i.estimate != null && <span className="muted">{i.estimate} pt</span>}
          <span className="muted">
            {i.startedAt ? `started ${formatAgo(i.startedAt, now)}` : `created ${formatAgo(i.createdAt, now)}`}
          </span>
          {i.dueDate && <span className={overdue ? "fail-text" : "muted"}>due {shortDate(i.dueDate)}</span>}
          {i.via === "project" && <span className="pill info">{i.assignee ? i.assignee.name : "Unassigned"}</span>}
          {i.branch && (
            <Ext href={i.branch.url} className="queue-branch">
              <code>{i.branch.name}</code>
              {i.branch.committedAt && <span className="muted"> · pushed {formatAgo(i.branch.committedAt, now)}</span>}
            </Ext>
          )}
          {i.donePrs.length > 0 && (
            <span className="muted" title={i.donePrs.map((p) => `#${p.number ?? "?"} ${p.status}`).join(", ")}>
              {i.donePrs.length} earlier PR{i.donePrs.length > 1 ? "s" : ""} {i.donePrs.every((p) => p.status === "merged") ? "merged" : "closed"}
            </span>
          )}
        </div>
      </div>
      <div className="queue-actions">
        {branch && (
          <button className="icon-btn" onClick={() => onCopyBranch(branch)} title={`Copy branch name: ${branch}`} aria-label={`Copy branch name ${branch}`}>
            <CopyIcon />
          </button>
        )}
        {ready ? (
          <span className="ns-ready" title={`Has the ${NIGHT_SHIFT_LABEL} label in Linear`}>
            <PlaneIcon /> With Night-Shift
          </span>
        ) : (
          <button
            className="button ns-send small-btn"
            onClick={onSend}
            disabled={sending}
            title={
              /block/i.test(i.state.name)
                ? `Move it to To Do and add the ${NIGHT_SHIFT_LABEL} label in Linear so night-shift picks it up`
                : `Add the ${NIGHT_SHIFT_LABEL} label in Linear so night-shift picks it up`
            }
          >
            <PlaneIcon />
            {sending ? "Sending…" : "Send to Night-Shift"}
          </button>
        )}
      </div>
    </li>
  );
}
