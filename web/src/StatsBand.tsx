import { useEffect, useId, useMemo, useRef, useState } from "react";
import { type DayCount, mergeStats, niceMax, rollingAverage } from "../../core/stats.ts";
import type { Snapshot } from "../../core/types.ts";

const DAYS = 90;
const AVG_WINDOW = 7;
const dayLabel = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
const longDay = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

/** Top band: merge counts for 24h / 7d / 30d and a per-day merge volume chart. */
export function StatsBand({ merges, now }: { merges: Snapshot["merges"]; now: number }) {
  // Recompute when the data changes or the day rolls over, not every second.
  const minute = Math.floor(now / 60_000);
  const stats = useMemo(() => {
    if (!merges) return null;
    // Build a few extra leading days so the average has a full window from day one, then trim.
    const s = mergeStats(merges.mergedAts, minute * 60_000, DAYS + AVG_WINDOW - 1);
    const avg = rollingAverage(s.daily.map((d) => d.count), AVG_WINDOW);
    return { ...s, daily: s.daily.slice(-DAYS), avg: avg.slice(-DAYS) };
  }, [merges, minute]);

  if (!stats) {
    return (
      <section className="stats">
        <p className="muted small">Loading merge stats…</p>
      </section>
    );
  }

  return (
    <section className="stats" aria-label="Your merged PRs">
      <div className="stat-tiles">
        <Tile label="Merged · 24 hours" value={stats.last24h} sub={"\u00a0"} />
        <Tile label="Last 7 days" value={stats.last7d} sub={`${(stats.last7d / 7).toFixed(1)} a day`} />
        <Tile label="Last 30 days" value={stats.last30d} sub={`${(stats.last30d / 30).toFixed(1)} a day`} />
      </div>
      <div className="stat-chart">
        <div className="stat-chart-head">
          <span className="stat-label">Merges per day · last {DAYS} days</span>
          <span className="legend">
            <span className="legend-item">
              <span className="swatch area" aria-hidden /> Daily
            </span>
            <span className="legend-item">
              <span className="swatch line" aria-hidden /> {AVG_WINDOW}-day average
            </span>
          </span>
        </div>
        <MergeChart daily={stats.daily} avg={stats.avg} />
      </div>
    </section>
  );
}

function Tile({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value.toLocaleString()}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

const H = 180;
const PAD = { top: 10, right: 6, bottom: 20, left: 26 };

/** Daily merge volume as a fading area, the 7-day average as a line over it, crosshair + tooltip on hover. */
function MergeChart({ daily, avg }: { daily: DayCount[]; avg: number[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();

  const n = daily.length;
  const max = niceMax(Math.max(0, ...daily.map((d) => d.count)));
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const baseline = y(0);

  const line = daily.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.count).toFixed(1)}`).join("");
  const avgLine = avg.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = n ? `${line}L${x(n - 1).toFixed(1)},${baseline}L${x(0).toFixed(1)},${baseline}Z` : "";
  const hovered = hover != null ? daily[hover] : null;

  const indexAt = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const i = Math.round(((clientX - rect.left - PAD.left) / plotW) * (n - 1));
    return Math.max(0, Math.min(n - 1, i));
  };

  // A tick every two weeks counted back from today ("Today" always gets one),
  // skipping any that would crowd the label to its right on narrow screens.
  const labelEvery = 14;
  const labelled = new Set<number>();
  for (let i = n - 1, lastX = Infinity; i >= 0; i -= labelEvery) {
    if (lastX - x(i) >= 64) {
      labelled.add(i);
      lastX = x(i);
    }
  }

  return (
    <div className="merge-chart" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={`Merges per day for the last ${n} days. Use the arrow keys to step through days.`}
          tabIndex={0}
          onMouseMove={(e) => setHover(indexAt(e.clientX))}
          onMouseLeave={() => setHover(null)}
          onFocus={() => setHover((h) => h ?? n - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
            else if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
            else return;
            e.preventDefault();
          }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="area-stop-top" />
              <stop offset="100%" className="area-stop-bottom" />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="axis" x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          <path className="area" d={area} fill={`url(#${gradientId})`} />
          <path className="line" d={line} />
          <path className="avg-line" d={avgLine} />
          {n > 0 && (
            <text className="direct-label" x={x(n - 1) - 4} y={y(avg[n - 1]!) - 8} textAnchor="end">
              avg {avg[n - 1]!.toFixed(1)}
            </text>
          )}
          {daily.map((d, i) =>
            labelled.has(i) ? (
              <text key={`x${d.day}`} className="axis" x={x(i)} y={H - 5} textAnchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"}>
                {i === n - 1 ? "Today" : dayLabel(d.day)}
              </text>
            ) : null,
          )}
          {hovered && hover != null && (
            <g className="crosshair" pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={baseline} />
              <circle className="dot-daily" cx={x(hover)} cy={y(hovered.count)} r={4} />
              <circle className="dot-avg" cx={x(hover)} cy={y(avg[hover]!)} r={5} />
            </g>
          )}
        </svg>
      )}
      {hovered && hover != null && (
        <div
          className="chart-tip"
          style={{ left: Math.min(Math.max(x(hover), 70), width - 70), top: Math.max(y(hovered.count) - 12, 0) }}
        >
          <div className="muted">{longDay(hovered.day)}</div>
          <div>
            <strong>{hovered.count}</strong> merged · <strong>{avg[hover]!.toFixed(1)}</strong> {AVG_WINDOW}-day avg
          </div>
        </div>
      )}
      <table className="sr-only">
        <caption>Merges per day</caption>
        <tbody>
          {daily.map((d, i) => (
            <tr key={d.day}>
              <th scope="row">{longDay(d.day)}</th>
              <td>{d.count} merged</td>
              <td>{avg[i]!.toFixed(1)} 7-day average</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
