import type { ReactNode } from "react";
import { riskTone } from "../../core/pr.ts";
import type { ChecksState, PrView, ReviewSummary } from "../../core/types.ts";

export const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

const isBot = (login: string) => login.endsWith("[bot]") || login === "github-actions";
const who = (logins: string[]) => logins.map((l) => (isBot(l) ? `${l.replace(/\[bot\]$/, "")} (bot)` : l)).join(", ");

export function Ext({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className} onClick={(e) => e.stopPropagation()}>
      {children}
    </a>
  );
}

export function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function RiskChip({ risk }: { risk: number | null }) {
  if (risk == null) return <span className="chip-label risk none" title="No risk label">risk ?</span>;
  return (
    <span className={`chip-label risk ${riskTone(risk)}`} title={`risk:${risk}`}>
      risk {risk}
    </span>
  );
}

export function PrLabels({ pr, showOther = true }: { pr: PrView; showOther?: boolean }) {
  return (
    <span className="labels">
      <RiskChip risk={pr.risk} />
      {pr.claudeLabels.map((l) => (
        <span key={l} className="chip-label claude">
          {l}
        </span>
      ))}
      {pr.deployProd && <span className="chip-label prod">deploy-prod</span>}
      {showOther &&
        pr.otherLabels.map((l) => (
          <span key={l} className="chip-label other">
            {l}
          </span>
        ))}
    </span>
  );
}

const REVIEW_TEXT: Record<ReviewSummary["state"], string> = {
  draft: "Draft",
  approved: "Approved",
  changes: "Changes requested",
  required: "Review required",
  none: "No reviews",
};

export function ReviewBadge({ review }: { review: ReviewSummary }) {
  const icon = review.state === "approved" ? "✓" : review.state === "changes" ? "✕" : review.state === "draft" ? "◌" : "●";
  return (
    <span className={`review ${review.state}`}>
      <span aria-hidden>{icon}</span> {REVIEW_TEXT[review.state]}
    </span>
  );
}

/** One-line reviewer detail: who approved, who wants changes, who is pending. */
export function ReviewDetail({ review }: { review: ReviewSummary }) {
  const parts: ReactNode[] = [];
  if (review.changesBy.length) parts.push(<span key="c" className="fail-text">changes by {who(review.changesBy)}</span>);
  if (review.approvedBy.length) parts.push(<span key="a">approved by {who(review.approvedBy)}</span>);
  if (review.waitingOn.length) parts.push(<span key="w">waiting on {who(review.waitingOn)}</span>);
  if (!parts.length) return null;
  return <span className="review-detail">{parts.reduce<ReactNode[]>((acc, p, i) => (i ? [...acc, " · ", p] : [p]), [])}</span>;
}

const CHECKS_TEXT: Record<NonNullable<ChecksState>, [string, string]> = {
  SUCCESS: ["ok", "Checks passing"],
  FAILURE: ["bad", "Checks failing"],
  ERROR: ["bad", "Checks errored"],
  PENDING: ["wait", "Checks running"],
  EXPECTED: ["wait", "Checks expected"],
};

export function ChecksBadge({ checks }: { checks: ChecksState }) {
  if (!checks) return null;
  const [tone, text] = CHECKS_TEXT[checks];
  return <span className={`checks ${tone}`}>{text}</span>;
}
