# Dashboard UI bugs from the 2026-11-19 screenshot

- Status: Open (bug 1 fixed in the working tree, not committed)
- Source: screenshot of the dashboard at 12:09, main page, "All authors"

## 1. PR card header runs past the card edge — fixed

- **Seen:** card #7597 has Open, Draft, claude[bot] and SUP-468 chips. Its `#7597` sits outside the card's right border.
- **Cause:** `.pr-head` was a flex row that could not wrap. The grid showed 3 columns whenever the list was at least 880px wide. The main column is at most about 985px wide (`main` max 1400px minus the 360px side panel), so each card was only about 310px.
- **Fix:** [web/src/styles.css](../../web/src/styles.css):
  - The grid now has at most 2 columns, and 1 column below 560px.
  - `.pr-head` now wraps.
- **Checked:** in the browser pane at 2400, 1650, 1050 and 500px wide. Every case gives 2 columns or 1, no header past its card, and no horizontal scroll.

## 2. Latest deploy says "Loading jobs…" on a finished run

- **Seen:** the Latest deploy card for run #2918 shows "success · 5m 34s" with a full progress bar, but its job list says "Loading jobs…".
- **Not reproduced:** a reload a few minutes later showed the jobs.
- **Hypothesis, unconfirmed:** the card asks for jobs from `GET /api/runs/:id/jobs` (`server/index.ts`), and the run had only just finished. Either the request was still in flight, or it failed and the card has no error or retry state.
- **To check:**
  - Make `/api/runs/:id/jobs` slow or failing, then open the dashboard.
  - "Loading jobs…" must never show for more than a few seconds.
  - A failure must show a message and a retry.

## 3. "Merged · 24 hours" tile sits lower than the other two

- **Seen:** "Last 7 days" and "Last 30 days" have a "N a day" line under the number. The 24-hour tile has none.
- **Cause:** the tiles center their content vertically (`.stat-tile` uses `justify-content: center`), so the 24-hour label and number sit lower than the others.
- **Fix idea:** align the tile contents to the top, or give the 24-hour tile a sub-line too, such as "vs 8.7 avg".

## 4. "avg 8.6" label overlaps the chart's last spike

- **Seen:** at the right edge of "Merges per day", the `avg 8.6` label sits on the daily area near today's spike.
- **Fix idea:** place the label above the higher of the 7-day-average line and the daily value at the last point, or move it into the legend.

## 5. Latest run appears twice in Deploy runs

- **Seen:** run #2918 is the Latest deploy card and also the first, selected row of the list below it.
- **Question:** is that intended? If not, start the list at the second run, or drop the selected style from that row.
