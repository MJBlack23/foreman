import { useEffect, useState } from "react";
import type { Snapshot } from "../../core/types.ts";

/** Live state pushed by the server over SSE. EventSource reconnects on its own. */
export function useSnapshot(): { snapshot: Snapshot | null; connected: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("snapshot", (e) => setSnapshot(JSON.parse((e as MessageEvent).data)));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);
  return { snapshot, connected };
}

/** Re-render every `ms` so elapsed / time-left tick between polls. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Once the page has been visible and focused for a few seconds, tell the
 * server the "New" events have been seen. The badges clear on the next push.
 */
export function useMarkViewed(newIds: string[], delayMs = 4000) {
  const key = newIds.join(",");
  useEffect(() => {
    if (!key) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      timer = setTimeout(() => void markViewed(key.split(",")), delayMs);
    };
    arm();
    window.addEventListener("focus", arm);
    window.addEventListener("blur", arm);
    document.addEventListener("visibilitychange", arm);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", arm);
      window.removeEventListener("blur", arm);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [key, delayMs]);
}

export function markViewed(ids: string[]) {
  if (ids.length === 0) return Promise.resolve();
  return fetch("/api/viewed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}
