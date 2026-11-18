import { useEffect, useRef, useState } from "react";
import { AUTHOR_KEYS, AUTHOR_LABEL, type AuthorKey, type Prefs } from "../../core/types.ts";

/**
 * Top-bar "Options" dropdown. Picks whose PRs the whole dashboard shows and
 * notifies about. Saved on the server, so it also applies to macOS notifications.
 */
export function OptionsMenu({ prefs, login }: { prefs: Prefs; login: string | null }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Show the click right away; the server's push confirms it a moment later.
  const [pending, setPending] = useState<AuthorKey[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const authors = pending ?? prefs.authors;

  useEffect(() => setPending(null), [prefs]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = async (key: AuthorKey) => {
    const next = authors.includes(key) ? authors.filter((a) => a !== key) : [...authors, key];
    if (next.length === 0) return;
    setPending(next);
    setSaving(true);
    try {
      await fetch("/api/prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ authors: next }),
      });
    } finally {
      setSaving(false);
    }
  };

  const summary = authors.length === AUTHOR_KEYS.length ? "All authors" : AUTHOR_LABEL[authors[0]!];

  return (
    <div className="options" ref={ref}>
      <button className={`options-button ${open ? "active" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true">
        <GearIcon />
        <span>{summary}</span>
        <span className="caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="options-menu" role="menu">
          <div className="options-title">Show PRs by</div>
          {AUTHOR_KEYS.map((key) => {
            const on = authors.includes(key);
            const last = on && authors.length === 1;
            return (
              <label key={key} className={`options-item ${last ? "locked" : ""}`} title={last ? "At least one author stays on" : undefined}>
                <input type="checkbox" role="menuitemcheckbox" checked={on} disabled={last} onChange={() => void toggle(key)} />
                <span className="options-label">
                  {AUTHOR_LABEL[key]}
                  <span className="muted">{key === "me" ? (login ? ` @${login}` : "") : " Claude GitHub app"}</span>
                </span>
              </label>
            );
          })}
          <div className="options-foot muted">
            {saving ? "Saving…" : "Applies to the cards, stats, deploys and notifications."}
          </div>
        </div>
      )}
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  );
}
