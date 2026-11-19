/**
 * When the next PR fetch happens. The poller ticks every `runsEveryMs` and
 * fetches PRs on the first tick at least `prsEveryMs - slackMs` after the last
 * PR fetch, so the next PR fetch is the next tick or the one after it.
 */
export function nextPrPollMs(
  lastPrPollMs: number,
  nextTickMs: number,
  runsEveryMs: number,
  prsEveryMs: number,
  slackMs = 1000,
): number {
  let at = nextTickMs;
  while (at - lastPrPollMs < prsEveryMs - slackMs) at += runsEveryMs;
  return at;
}

/** 0..1 across the window from the last PR fetch to the next one. */
export function pollProgress(lastIso: string | null, nextIso: string | null, nowMs: number): number {
  if (!lastIso || !nextIso) return 0;
  const start = Date.parse(lastIso);
  const span = Date.parse(nextIso) - start;
  if (!(span > 0)) return 1;
  return Math.min(1, Math.max(0, (nowMs - start) / span));
}
