import { useState } from "react";
import { pollProgress } from "../../core/poll.ts";
import type { Snapshot } from "../../core/types.ts";
import { useNow } from "./hooks.ts";
import { hhmm } from "./ui.tsx";

/**
 * One line in the top bar: a bar that fills toward the next PR fetch, then a
 * refresh button. Hovering or focusing the bar shows API budget and poll times.
 */
export function PollStatus({ snapshot, connected }: { snapshot: Snapshot | null; connected: boolean }) {
  const now = useNow(1000);
  const [requested, setRequested] = useState(false);
  const busy = requested || !!snapshot?.polling;
  const failed = !connected || !!snapshot?.lastError;
  const progress = busy ? 1 : pollProgress(snapshot?.prPolledAt ?? null, snapshot?.nextPrPollAt ?? null, now);
  const secsLeft = snapshot?.nextPrPollAt ? Math.max(0, Math.round((Date.parse(snapshot.nextPrPollAt) - now) / 1000)) : null;
  const rl = snapshot?.rateLimit;

  const refresh = async () => {
    if (busy || !connected) return;
    setRequested(true);
    try {
      await fetch("/api/refresh", { method: "POST" });
    } finally {
      setRequested(false);
    }
  };

  const state = !connected ? "offline" : snapshot?.lastError ? "error" : busy ? "polling" : "idle";

  return (
    <div className={`poll ${state}`}>
      <span className="poll-anchor">
        <div
          className="poll-bar"
          tabIndex={0}
          aria-describedby="poll-tip"
          role="progressbar"
          aria-label="Time until the next PR refresh"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-valuetext={busy ? "Refreshing" : secsLeft != null ? `${secsLeft} seconds until refresh` : "Waiting for first poll"}
        >
          <div className="poll-fill" style={{ transform: `scaleX(${progress})` }} />
        </div>
        <span className="poll-tip" id="poll-tip" role="tooltip">
          {!connected && <span className="poll-tip-row bad">Disconnected from the dashboard server</span>}
          {snapshot?.lastError && <span className="poll-tip-row bad">GitHub poll failed: {snapshot.lastError}</span>}
          {rl ? (
            <span className="poll-tip-row">
              API {rl.remaining.toLocaleString()}/{rl.limit.toLocaleString()} · resets {hhmm(rl.resetAt)}
            </span>
          ) : (
            <span className="poll-tip-row">API budget not known yet</span>
          )}
          <span className="poll-tip-row dim">
            {busy
              ? "Refreshing now…"
              : snapshot?.prPolledAt
                ? `PRs ${hhmm(snapshot.prPolledAt)}${secsLeft != null ? ` · next in ${secsLeft}s` : ""}`
                : "Waiting for the first poll"}
          </span>
        </span>
      </span>
      <button
        type="button"
        className={`poll-refresh ${busy ? "spinning" : ""}`}
        onClick={refresh}
        disabled={!connected}
        aria-label={busy ? "Refreshing PRs" : "Refresh PRs now"}
      >
        <RefreshIcon />
      </button>
      {failed && <span className="dot bad" aria-hidden />}
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}
