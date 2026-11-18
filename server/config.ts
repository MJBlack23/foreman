import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const REPO_OWNER = "CloudSpot";
export const REPO_NAME = "cloudspot";
export const WORKFLOW_FILE = "services-build-deploy-staging.yml";

export const RUNS_EVERY_MS = 30_000;
export const PRS_EVERY_MS = 60_000;
/** Side panel: an expanded running card refreshes its jobs about this often. */
export const LIVE_JOBS_MIN_AGE_MS = 8_000;
/** Merge stats (90 days of my merged PRs) change slowly. */
export const STATS_EVERY_MS = 10 * 60_000;
export const STATS_DAYS = 90;

/** `true` = macOS default sound, a string = a named sound (e.g. "Glass"), false = silent. */
export type SoundSetting = boolean | string;

export interface Config {
  port: number;
  dataDir: string;
  sound: SoundSetting;
}

/**
 * Settings come from `<dataDir>/config.json` ({ "sound": false | true | "Glass" }),
 * overridden by env: PORT, MERGE_WATCH_DATA_DIR, MERGE_WATCH_SOUND (0/1/sound name).
 */
export function loadConfig(env = process.env): Config {
  const dataDir =
    env.MERGE_WATCH_DATA_DIR ?? join(homedir(), "Library", "Application Support", "merge-watch");
  mkdirSync(dataDir, { recursive: true });

  let file: { sound?: SoundSetting; port?: number } = {};
  const path = join(dataDir, "config.json");
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      console.warn(`[config] ignoring unreadable ${path}: ${(e as Error).message}`);
    }
  }

  return {
    port: Number(env.PORT ?? file.port ?? 7896),
    dataDir,
    sound: parseSound(env.MERGE_WATCH_SOUND) ?? file.sound ?? false,
  };
}

function parseSound(v: string | undefined): SoundSetting | undefined {
  if (v == null || v === "") return undefined;
  if (["0", "false", "off", "no"].includes(v.toLowerCase())) return false;
  if (["1", "true", "on", "yes"].includes(v.toLowerCase())) return true;
  return v;
}
