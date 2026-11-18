import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { formatAgo } from "../../core/pr.ts";
import { STATUS_LABEL } from "../../core/status.ts";
import type { PrView } from "../../core/types.ts";
import { PrDetails, prTone } from "./PrDetails.tsx";
import { ChecksBadge, Ext, hhmm, PrLabels, ReviewBadge, ReviewDetail } from "./ui.tsx";

type PrTab = "open" | "done";
const TAB_KEY = "merge-watch:pr-tab";

type ViewTransitionDoc = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

/**
 * Apply a layout change with an eased morph between the old and new layout
 * (View Transitions API). Falls back to an instant change when the browser
 * lacks it or the user prefers reduced motion.
 */
function animateLayout(update: () => void): Promise<void> {
  const doc = document as ViewTransitionDoc;
  if (!doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return Promise.resolve();
  }
  return doc.startViewTransition(() => flushSync(update)).finished.catch(() => {});
}

export function PrTabs({ prs, typicalMs, now }: { prs: PrView[]; typicalMs: number | null; now: number }) {
  const [tab, setTab] = useState<PrTab>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === "done" ? "done" : "open";
    } catch {
      return "open";
    }
  });
  const [expanded, setExpanded] = useState<number | null>(null);

  const choose = (t: PrTab) => {
    setTab(t);
    setExpanded(null);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* per-viewer convenience only */
    }
  };

  const toggle = (n: number) => {
    const next = expanded === n ? null : n;
    void animateLayout(() => setExpanded(next)).then(() => {
      if (next != null) document.getElementById(`pr-${next}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  };

  // Escape closes the open card.
  useEffect(() => {
    if (expanded == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void animateLayout(() => setExpanded(null));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const open = prs.filter((p) => p.state === "open");
  const done = prs.filter((p) => p.state === "closed");
  const shown = tab === "open" ? open : done;

  return (
    <section>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "open"} className={tab === "open" ? "active" : ""} onClick={() => choose("open")}>
          Open <span className="count">{open.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "done"} className={tab === "done" ? "active" : ""} onClick={() => choose("done")}>
          Merged &amp; closed · 24h <span className="count">{done.length}</span>
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="muted">{tab === "open" ? "No open PRs." : "Nothing merged or closed in the last 24 hours."}</p>
      ) : (
        <ul className="pr-list">
          {shown.map((pr) => (
            <PrCard
              key={pr.number}
              pr={pr}
              expanded={pr.number === expanded}
              onToggle={() => toggle(pr.number)}
              typicalMs={typicalMs}
              now={now}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PrCard({
  pr,
  expanded,
  onToggle,
  typicalMs,
  now,
}: {
  pr: PrView;
  expanded: boolean;
  onToggle: () => void;
  typicalMs: number | null;
  now: number;
}) {
  return (
    <li
      id={`pr-${pr.number}`}
      className={`pr-row ${expanded ? `expanded tone-${prTone(pr)}` : ""}`}
      style={{ viewTransitionName: `pr-${pr.number}` }}
      // A collapsed card opens on click anywhere; an open one closes from its header,
      // so selecting text or clicking inside the details doesn't fold it away.
      onClick={expanded ? undefined : onToggle}
      onKeyDown={(e) => {
        if (!expanded && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onToggle();
        }
      }}
      tabIndex={expanded ? -1 : 0}
      aria-expanded={expanded}
    >
      <div className="pr-head" onClick={expanded ? onToggle : undefined}>
        <span className={`pill ${pr.status}`}>{STATUS_LABEL[pr.status]}</span>
        {pr.isDraft && pr.state === "open" && <span className="pill draft">Draft</span>}
        {pr.author === "claude" && <span className="pill bot">claude[bot]</span>}
        <span className="pr-num muted">#{pr.number}</span>
        {expanded && (
          <button
            className="close"
            aria-label="Collapse"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            ×
          </button>
        )}
      </div>

      <Ext className="pr-title" href={pr.htmlUrl}>
        {pr.title}
      </Ext>

      <div className="pr-review">
        <ReviewBadge review={pr.review} />
        {pr.state === "open" && <ChecksBadge checks={pr.checks} />}
      </div>
      <ReviewDetail review={pr.review} />

      <PrLabels pr={pr} />

      {expanded && <PrDetails pr={pr} typicalMs={typicalMs} now={now} />}

      <div className="pr-foot">
        <span className="pr-facts muted">
          <span>
            +{pr.additions.toLocaleString()} −{pr.deletions.toLocaleString()} · {plural(pr.changedFiles, "file")}
          </span>
          {pr.comments > 0 && <span>{plural(pr.comments, "comment")}</span>}
          <span>
            {pr.mergedAt
              ? `merged ${hhmm(pr.mergedAt)}`
              : pr.closedAt
                ? `closed ${hhmm(pr.closedAt)}`
                : `opened ${formatAgo(pr.createdAt, now)} · updated ${formatAgo(pr.updatedAt, now)}`}
          </span>
          {!expanded && pr.link && <Ext href={pr.link.url}>{pr.link.label}</Ext>}
        </span>
      </div>
    </li>
  );
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
