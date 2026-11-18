export interface DayCount {
  /** Local midnight of the day, epoch ms. */
  day: number;
  count: number;
}

export interface MergeStats {
  last24h: number;
  last7d: number;
  last30d: number;
  /** One entry per local calendar day, oldest first, ending today. */
  daily: DayCount[];
}

/** Counts of merges in rolling windows, plus a per-day series for the chart. */
export function mergeStats(mergedAts: string[], nowMs: number, days = 30): MergeStats {
  const times = mergedAts.map((t) => Date.parse(t)).filter((t) => Number.isFinite(t) && t <= nowMs);
  const within = (ms: number) => times.filter((t) => nowMs - t < ms).length;

  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const daily: DayCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    daily.push({ day: d.getTime(), count: 0 });
  }
  const index = new Map(daily.map((d, i) => [d.day, i]));
  for (const t of times) {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    const i = index.get(d.getTime());
    if (i != null) daily[i]!.count++;
  }

  return { last24h: within(86_400_000), last7d: within(7 * 86_400_000), last30d: within(30 * 86_400_000), daily };
}

/** A round axis maximum at or above `max` (1, 2, 5 × 10^n), at least 4. */
export function niceMax(max: number): number {
  if (max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= max) return m * pow;
  return 10 * pow;
}

/**
 * Trailing average over `window` days: entry i averages days i-window+1..i.
 * The first window-1 entries average only the days available, so pass a few
 * extra leading days and drop them when you need a full window everywhere.
 */
export function rollingAverage(counts: number[], window = 7): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < counts.length; i++) {
    sum += counts[i]!;
    if (i >= window) sum -= counts[i - window]!;
    out.push(sum / Math.min(i + 1, window));
  }
  return out;
}
