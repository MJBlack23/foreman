import type { GhPr, Ticket } from "./types.ts";

const ISSUE_URL = /https:\/\/linear\.app\/([\w-]+)\/issue\/([A-Z][A-Z0-9]*-\d+)/g;
const LINKBACK_SUMMARY = /<summary>\s*<a href="(https:\/\/linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]*-\d+)[^"]*)">([^<]*)<\/a>\s*<\/summary>/;
const ID_IN_TEXT = /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\b/g;

/**
 * The ticket a Linear linkback comment is about: the link in its <summary>.
 * The rest of the comment quotes the ticket's description, which can mention
 * other tickets, so only the summary counts.
 */
export function parseLinkback(body: string): Ticket | null {
  if (!body.includes("linear-linkback") && !body.includes("linear.app")) return null;
  const m = LINKBACK_SUMMARY.exec(body);
  if (!m) return null;
  const [, url, id, text] = m;
  const title = decodeEntities(text!.trim()).replace(new RegExp(`^${id}\\s*`), "") || null;
  return { id: id!, title, url: url! };
}

/**
 * Tickets attached to a PR. Linear posts one linkback comment per attached
 * issue, so those are the answer when present. Without one, fall back to
 * linear.app issue links in the description (descriptions also link related
 * tickets, so they never add to the linkbacks).
 */
export function attachedTickets(linkbackBodies: string[], description: string | null): Ticket[] {
  const out = new Map<string, Ticket>();
  for (const b of linkbackBodies) {
    const t = parseLinkback(b);
    if (t && !out.has(t.id)) out.set(t.id, t);
  }
  if (out.size) return [...out.values()];
  for (const m of (description ?? "").matchAll(ISSUE_URL)) {
    const [url, , id] = m;
    if (!out.has(id!)) out.set(id!, { id: id!, title: null, url: url! });
  }
  return [...out.values()];
}

/** Ticket-shaped IDs in a title or branch name (PLAT-2055, plat-2055-…), uppercased. */
export function ticketHints(title: string, headRef: string): string[] {
  const ids = new Set<string>();
  for (const s of [title, headRef]) for (const m of s.matchAll(ID_IN_TEXT)) ids.add(`${m[1]!.toUpperCase()}-${m[2]}`);
  return [...ids];
}

/**
 * Fill in PRs that have no attached ticket yet (Linear's comment can lag) from
 * IDs in their title or branch, but only for team keys already seen on real
 * Linear links, so "RFC-0001" in a branch name isn't taken for a ticket.
 */
export function resolveTickets(prs: GhPr[]): GhPr[] {
  const keys = new Map<string, string>(); // team key -> issue URL prefix
  for (const pr of prs) {
    for (const t of pr.tickets) {
      const m = /^(https:\/\/linear\.app\/[\w-]+\/issue\/)/.exec(t.url);
      if (m) keys.set(t.id.split("-")[0]!, m[1]!);
    }
  }
  return prs.map((pr) => {
    if (pr.tickets.length) return pr;
    const tickets = pr.ticketHints
      .filter((id) => keys.has(id.split("-")[0]!))
      .map((id) => ({ id, title: null, url: `${keys.get(id.split("-")[0]!)}${id}` }));
    return tickets.length ? { ...pr, tickets } : pr;
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Search box matching. Every word must match one of: the title, the PR number
 * ("7507" or "#7507"), or a ticket ID ("PLAT-2031", "plat-2031", or just "2031").
 */
export function matchesQuery(pr: Pick<GhPr, "number" | "title" | "tickets">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const title = pr.title.toLowerCase();
  const num = String(pr.number);
  const ids = pr.tickets.map((t) => t.id.toLowerCase());
  return words.every((w) => {
    const bare = w.replace(/^#/, "");
    if (/^\d+$/.test(bare) && (num.startsWith(bare) || ids.some((id) => id.endsWith(`-${bare}`)))) return true;
    return title.includes(w) || ids.some((id) => id.includes(w));
  });
}
