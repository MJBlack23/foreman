import { useState } from "react";
import { formatDuration, formatMinutes } from "../../core/eta.ts";
import { formatAgo } from "../../core/pr.ts";
import type { EventKind, EventView } from "../../core/types.ts";
import { markViewed, useMarkViewed } from "./hooks.ts";
import { RouteLink } from "./router.tsx";
import { Ext, hhmm } from "./ui.tsx";

type Filter = "all" | EventKind;
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "merged", label: "Merged" },
  { key: "failed", label: "CI failed" },
  { key: "complete", label: "CI complete" },
];
const KIND_LABEL: Record<EventKind, string> = { merged: "Merged", failed: "CI failed", complete: "CI complete" };

export function NotificationsPage({ events, typicalMs, now }: { events: EventView[]; typicalMs: number | null; now: number }) {
  const [filter, setFilter] = useState<Filter>("all");
  const newIds = events.filter((e) => e.isNew).map((e) => e.id);
  // Looking at this page for a few seconds counts as reading what's on it.
  useMarkViewed(newIds);

  const shown = filter === "all" ? events : events.filter((e) => e.kind === filter);
  const groups = groupByDay(shown, now);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <RouteLink to="dashboard" className="back">
            ← Dashboard
          </RouteLink>
          <h1>Notifications</h1>
          <p className="muted">
            Merges and services-build results for your PRs over the last 24 hours. Each one was also sent as a macOS
            notification.
          </p>
        </div>
        <button className="button" disabled={newIds.length === 0} onClick={() => void markViewed(newIds)}>
          Mark all as read{newIds.length ? ` (${newIds.length})` : ""}
        </button>
      </div>

      <div className="filters" role="tablist">
        {FILTERS.map((f) => {
          const n = f.key === "all" ? events.length : events.filter((e) => e.kind === f.key).length;
          return (
            <button key={f.key} role="tab" aria-selected={filter === f.key} className={filter === f.key ? "active" : ""} onClick={() => setFilter(f.key)}>
              {f.label} <span className="count">{n}</span>
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <p className="muted">Nothing here in the last 24 hours.</p>
      ) : (
        groups.map(([day, list]) => (
          <section key={day}>
            <h3 className="day">{day}</h3>
            {list.map((e) => (
              <EventCard key={e.id} e={e} typicalMs={typicalMs} now={now} />
            ))}
          </section>
        ))
      )}
    </div>
  );
}

function EventCard({ e, typicalMs, now }: { e: EventView; typicalMs: number | null; now: number }) {
  return (
    <article className={`event-card ${e.kind} ${e.isNew ? "new" : ""}`}>
      <div className="event-head">
        <span className={`pill ev-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
        <Ext className="event-title" href={e.prUrl}>
          #{e.prNumber} {e.prTitle}
        </Ext>
        {e.isNew && <span className="new-badge">New</span>}
        <span className="muted when" title={new Date(e.at).toLocaleString()}>
          {hhmm(e.at)} · {formatAgo(e.at, now)}
        </span>
      </div>

      <dl className="facts">
        <dt>Branch</dt>
        <dd>
          <code>{e.headRef}</code> → main
        </dd>

        {e.kind === "merged" && (
          <>
            <dt>Deploys to</dt>
            <dd>{e.deployProd ? "Staging and production (deploy-prod)" : "Staging only"}</dd>
          </>
        )}

        {e.run && (
          <>
            <dt>Run</dt>
            <dd>
              <Ext href={e.run.url}>#{e.run.number}</Ext>
              {e.run.status !== "completed" ? " · still running" : e.run.conclusion ? ` · ${e.run.conclusion}` : ""}
            </dd>
          </>
        )}

        {e.kind === "failed" && (
          <>
            <dt>Failed job</dt>
            <dd>
              {e.failedJob ? (
                <>
                  <Ext href={e.failedJob.url}>{e.failedJob.name}</Ext>
                  {e.failedJob.step && (
                    <>
                      {" "}
                      at step <code>{e.failedJob.step}</code>
                    </>
                  )}
                </>
              ) : (
                "The run failed; no job detail yet"
              )}
            </dd>
            {e.run?.durationMs != null && (
              <>
                <dt>Failed after</dt>
                <dd>{formatDuration(e.run.durationMs)} into the run</dd>
              </>
            )}
          </>
        )}

        {e.kind === "complete" && e.run?.durationMs != null && (
          <>
            <dt>Took</dt>
            <dd>
              {formatDuration(e.run.durationMs)}
              {typicalMs != null && <span className="muted"> · usually {formatMinutes(typicalMs)}</span>}
            </dd>
            <dt>Deployed to</dt>
            <dd>
              {e.run.conclusion === "success"
                ? e.deployProd
                  ? "Staging and production image tags updated"
                  : "Staging image tag updated"
                : "Not deployed"}
            </dd>
          </>
        )}

        {e.services.length > 0 && (
          <>
            <dt>Services</dt>
            <dd className="services">
              {e.services.map((s) => (
                <Ext key={s.name} className={`chip ${s.conclusion ?? "running"}`} href={s.url}>
                  {s.name}
                </Ext>
              ))}
            </dd>
          </>
        )}

        <dt>Notification</dt>
        <dd className="muted">
          “{e.title}” — {e.detail}
        </dd>
      </dl>

      <div className="actions">
        {e.failedJob && (
          <Ext className="button danger" href={e.failedJob.url}>
            Open failed job
          </Ext>
        )}
        {e.run && (
          <Ext className={`button ${e.failedJob ? "" : "primary"}`} href={e.run.url}>
            Open run #{e.run.number}
          </Ext>
        )}
        <Ext className={`button ${e.run ? "" : "primary"}`} href={e.prUrl}>
          Open PR #{e.prNumber}
        </Ext>
      </div>
    </article>
  );
}

function groupByDay(events: EventView[], now: number): [string, EventView[]][] {
  const today = new Date(now).toDateString();
  const yesterday = new Date(now - 86_400_000).toDateString();
  const out = new Map<string, EventView[]>();
  for (const e of events) {
    const d = new Date(e.at).toDateString();
    const label = d === today ? "Today" : d === yesterday ? "Yesterday" : new Date(e.at).toLocaleDateString();
    out.set(label, [...(out.get(label) ?? []), e]);
  }
  return [...out];
}
