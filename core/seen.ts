import type { EventKind, WatchEvent } from "./types.ts";

export interface PlannedNotification {
  kind: EventKind | "summary";
  title: string;
  message: string;
  url: string;
}

/** Events whose ids are not yet in the seen set, oldest first (notification order). */
export function diffUnseen(events: WatchEvent[], seen: ReadonlySet<string>): WatchEvent[] {
  return events
    .filter((e) => !seen.has(e.id))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Turn unseen events into notifications. On the first poll after startup,
 * several unseen events collapse into one summary instead of a burst.
 */
export function planNotifications(
  unseen: WatchEvent[],
  opts: { startup: boolean; dashboardUrl: string },
): PlannedNotification[] {
  if (unseen.length === 0) return [];
  if (opts.startup && unseen.length > 1) {
    return [
      {
        kind: "summary",
        title: "PR Dashboard",
        message: `${unseen.length} updates since you last ran this`,
        url: opts.dashboardUrl,
      },
    ];
  }
  return unseen.map((e) => ({ kind: e.kind, title: e.title, message: e.detail, url: e.url }));
}

/** Drop seen ids older than maxAgeMs so the file doesn't grow forever. */
export function pruneSeen(
  seen: Record<string, number>,
  nowMs: number,
  maxAgeMs = 7 * 24 * 60 * 60_000,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, ts] of Object.entries(seen)) if (nowMs - ts <= maxAgeMs) out[id] = ts;
  return out;
}
