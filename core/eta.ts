import type { GhRun } from "./types.ts";

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Median of updated_at − run_started_at across the most recent successful runs
 * that actually deployed. Runs under `minMs` changed no services and would drag
 * the typical time down.
 */
export function typicalDurationMs(runs: GhRun[], limit = 20, minMs = 3 * 60_000): number | null {
  const durations = runs
    .filter((r) => r.status === "completed" && r.conclusion === "success" && r.runStartedAt)
    .map((r) => ({ r, d: Date.parse(r.updatedAt) - Date.parse(r.runStartedAt!) }))
    .filter(({ d }) => Number.isFinite(d) && d >= minMs)
    .sort((a, b) => Date.parse(b.r.createdAt) - Date.parse(a.r.createdAt))
    .slice(0, limit)
    .map(({ d }) => d);
  return median(durations);
}

export interface Eta {
  elapsedMs: number;
  /** null when there is no typical duration to compare against. */
  remainingMs: number | null;
  /** 0..1, capped below 1 while running; null without a typical duration. */
  progress: number | null;
  overdue: boolean;
}

export function computeEta(startedAt: string, nowMs: number, typicalMs: number | null): Eta {
  const elapsedMs = Math.max(0, nowMs - Date.parse(startedAt));
  if (typicalMs == null || typicalMs <= 0) {
    return { elapsedMs, remainingMs: null, progress: null, overdue: false };
  }
  const remainingMs = Math.max(0, typicalMs - elapsedMs);
  return {
    elapsedMs,
    remainingMs,
    progress: Math.min(elapsedMs / typicalMs, 0.98),
    overdue: elapsedMs > typicalMs,
  };
}

/** "7m 42s", "45s", "1h 3m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** "usually 8m" style: whole minutes, at least 1. */
export function formatMinutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

export function formatTimeLeft(eta: Eta): string | null {
  if (eta.remainingMs == null) return null;
  if (eta.overdue) return "taking longer than usual";
  if (eta.remainingMs < 60_000) return "<1 min left";
  return `~${Math.round(eta.remainingMs / 60_000)} min left`;
}
