import { execFile } from "node:child_process";
import notifier from "node-notifier";
import type { PlannedNotification } from "../core/seen.ts";
import type { SoundSetting } from "./config.ts";

/**
 * Native macOS notification. node-notifier's bundled terminal-notifier supports
 * opening a URL on click; if it fails, fall back to osascript (no click action).
 */
export function sendNotification(n: PlannedNotification, sound: SoundSetting): void {
  const soundName = sound === true ? "default" : sound || undefined;
  notifier.notify(
    {
      title: n.title,
      message: n.message || " ",
      open: n.url,
      sound: soundName ?? false,
      group: `merge-watch:${n.url}`,
      wait: false,
    } as Parameters<typeof notifier.notify>[0],
    (err) => {
      if (err) {
        console.warn(`[notify] node-notifier failed (${err.message}), using osascript`);
        osascript(n, soundName);
      }
    },
  );
}

function osascript(n: PlannedNotification, sound: string | undefined) {
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const script =
    `display notification ${q(n.message || " ")} with title ${q(n.title)}` +
    (sound ? ` sound name ${q(sound === "default" ? "Glass" : sound)}` : "");
  execFile("osascript", ["-e", script], (err) => {
    if (err) console.error(`[notify] osascript failed: ${err.message}`);
  });
}
