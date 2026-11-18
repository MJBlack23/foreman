import type { GhJob, GhPr, ReviewSummary } from "./types.ts";

const RISK_RE = /^risk:(\d+)$/;

/** Highest risk:N label, or null when the PR has none. */
export function riskLevel(labels: string[]): number | null {
  let best: number | null = null;
  for (const l of labels) {
    const m = RISK_RE.exec(l);
    if (m) best = Math.max(best ?? 0, Number(m[1]));
  }
  return best;
}

/** risk:0–2 can be approved by the PR gate; 3 needs a look; 4–5 is high. */
export function riskTone(risk: number): "low" | "medium" | "high" {
  return risk <= 2 ? "low" : risk === 3 ? "medium" : "high";
}

export function splitLabels(labels: string[]) {
  return {
    deployProd: labels.includes("deploy-prod"),
    risk: riskLevel(labels),
    claudeLabels: labels.filter((l) => l.startsWith("claude-")),
    otherLabels: labels.filter((l) => !RISK_RE.test(l) && !l.startsWith("claude-") && l !== "deploy-prod"),
  };
}

/**
 * Who approved, who asked for changes, and who is still asked to review.
 * GitHub's reviewDecision wins for the overall state; drafts are their own state.
 */
export function reviewSummary(pr: Pick<GhPr, "isDraft" | "reviewDecision" | "reviews" | "requestedReviewers" | "state">): ReviewSummary {
  const approvedBy = pr.reviews.filter((r) => r.state === "APPROVED").map((r) => r.login);
  const changesBy = pr.reviews.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.login);
  const waitingOn = pr.state === "open" ? pr.requestedReviewers : [];
  let state: ReviewSummary["state"];
  if (pr.state === "open" && pr.isDraft) state = "draft";
  else if (pr.reviewDecision === "CHANGES_REQUESTED" || changesBy.length) state = "changes";
  else if (pr.reviewDecision === "APPROVED") state = "approved";
  else if (pr.reviewDecision === "REVIEW_REQUIRED") state = "required";
  else state = approvedBy.length ? "approved" : "none";
  return { state, approvedBy, changesBy, waitingOn };
}

/** "Build admin-bff" jobs → services, in job order. */
export function buildServices(jobs: GhJob[] | undefined) {
  return (jobs ?? [])
    .filter((j) => j.name.startsWith("Build "))
    .map((j) => ({ name: j.name.slice("Build ".length), conclusion: j.conclusion, url: j.htmlUrl }));
}

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function formatAgo(thenIso: string, nowMs: number): string {
  const s = Math.max(0, (nowMs - Date.parse(thenIso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;

/**
 * The "Summary" section of a PR description (up to the next heading or ---).
 * Without one, the first paragraph. Null for an empty description.
 */
export function extractSummary(body: string | null | undefined, maxChars = 1500): string | null {
  if (!body?.trim()) return null;
  const lines = body.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const start = lines.findIndex((l) => /^summary\b/i.test(HEADING.exec(l.trim())?.[1] ?? ""));
  let out: string[];
  if (start >= 0) {
    out = [];
    for (const l of lines.slice(start + 1)) {
      if (HEADING.test(l.trim()) || /^(-{3,}|\*{3,}|_{3,})$/.test(l.trim())) break;
      out.push(l);
    }
  } else {
    const firstText = lines.findIndex((l) => l.trim() && !HEADING.test(l.trim()));
    if (firstText < 0) return null;
    const end = lines.findIndex((l, i) => i > firstText && !l.trim());
    out = lines.slice(firstText, end < 0 ? undefined : end);
  }
  const text = out.join("\n").trim();
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}
