import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { formatAgo } from "../../core/pr.ts";
import { STATUS_LABEL } from "../../core/status.ts";
import { matchesQuery } from "../../core/tickets.ts";
import type { PrView, Ticket } from "../../core/types.ts";
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
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" jumps to the search box, like GitHub.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const matching = prs.filter((p) => matchesQuery(p, query));
  const open = matching.filter((p) => p.state === "open");
  const done = matching.filter((p) => p.state === "closed");
  const shown = tab === "open" ? open : done;
  const other = tab === "open" ? done : open;
  const searching = query.trim().length > 0;

  return (
    <section>
      <div className="search">
        <SearchIcon />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search by title, PR number or Linear ticket"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setExpanded(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              e.currentTarget.blur();
            }
          }}
          aria-label="Search PRs"
        />
        {searching ? (
          <span className="search-meta">
            {matching.length} of {prs.length}
          </span>
        ) : (
          <kbd className="search-meta">/</kbd>
        )}
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "open"} className={tab === "open" ? "active" : ""} onClick={() => choose("open")}>
          Open <span className="count">{open.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "done"} className={tab === "done" ? "active" : ""} onClick={() => choose("done")}>
          Merged &amp; closed · 24h <span className="count">{done.length}</span>
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="muted">
          {searching ? (
            <>
              No {tab === "open" ? "open" : "merged or closed"} PRs match “{query.trim()}”.
              {other.length > 0 && (
                <>
                  {" "}
                  <button className="link-button" onClick={() => choose(tab === "open" ? "done" : "open")}>
                    {other.length} in {tab === "open" ? "Merged & closed" : "Open"}
                  </button>
                </>
              )}
            </>
          ) : tab === "open" ? (
            "No open PRs."
          ) : (
            "Nothing merged or closed in the last 24 hours."
          )}
        </p>
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
        <TicketChips tickets={pr.tickets} />
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

/** The Linear ticket(s) as links, or a red "No ticket" when nothing is attached. */
function TicketChips({ tickets }: { tickets: Ticket[] }) {
  if (tickets.length === 0) {
    return (
      <span className="ticket none" title="No Linear ticket attached to this PR">
        No ticket
      </span>
    );
  }
  return (
    <>
      {tickets.map((t) => (
        <Ext key={t.id} className="ticket" href={t.url}>
          <LinearIcon />
          <span title={t.title ?? undefined}>{t.id}</span>
        </Ext>
      ))}
    </>
  );
}

function LinearIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 100 100" aria-hidden fill="currentColor">
      <path d="M1.2 61.5c-.2-.9.9-1.5 1.6-.8l36.5 36.5c.7.7.1 1.8-.8 1.6C20 94.9 5.1 80 1.2 61.5ZM0 46.9c0 .4.1.7.4 1l51.7 51.7c.3.3.6.4 1 .4 2.3-.1 4.6-.4 6.8-.8.8-.2 1.1-1.1.5-1.7L2.5 39.6c-.6-.6-1.5-.3-1.7.5-.4 2.2-.7 4.5-.8 6.8Zm4.2-17.1c-.2.4-.1.9.2 1.2l64.6 64.6c.3.3.8.4 1.2.2 1.8-.8 3.5-1.7 5.1-2.7.6-.4.7-1.2.2-1.7L8.6 24.5c-.5-.5-1.3-.4-1.7.2-1 1.6-1.9 3.3-2.7 5.1Zm8.5-11.6c-.4-.4-.4-1 0-1.4C21.8 6.5 35.2 0 50 0c27.6 0 50 22.4 50 50 0 14.8-6.4 28.2-16.7 37.3-.4.4-1 .4-1.4 0L12.7 18.2Z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
