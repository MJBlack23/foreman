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

// ── Argo CD (Cluster page) ────────────────────────────────────────────────

export const INFRA_REPO = "CloudSpot/infrastructure";

export interface ArgoEnvConfig {
  url: string;
  host: string;
  token: string;
  cfClientId: string | null;
  cfClientSecret: string | null;
}

export interface ArgoConfig {
  envs: Record<"prd" | "stg", { config: ArgoEnvConfig | null; missing: string[]; host: string | null }>;
  /** Every secret value, for redaction. */
  secrets: string[];
}

/** KEY=VALUE lines; `#` comments; optional quotes and `export`. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

/**
 * Argo settings come from the process env (e.g. `doppler run`), falling back to
 * `<dataDir>/argo.env`. Empty values count as missing.
 */
export function loadArgoConfig(dataDir: string, env: Record<string, string | undefined> = process.env): ArgoConfig {
  let file: Record<string, string> = {};
  const path = join(dataDir, "argo.env");
  if (existsSync(path)) {
    try {
      file = parseEnvFile(readFileSync(path, "utf8"));
    } catch (e) {
      console.warn(`[argo] ignoring unreadable ${path}: ${(e as Error).message}`);
    }
  }
  const get = (k: string) => {
    const v = env[k]?.trim() || file[k]?.trim();
    return v || null;
  };

  const secrets: string[] = [];
  const one = (id: "prd" | "stg") => {
    const ID = id.toUpperCase();
    const url = get(`ARGO_${ID}_URL`)?.replace(/\/+$/, "") ?? null;
    const token = get(`ARGO_${ID}_TOKEN`);
    const cfClientId = get(`CF_ACCESS_${ID}_CLIENT_ID`) ?? get("CF_ACCESS_CLIENT_ID");
    const cfClientSecret = get(`CF_ACCESS_${ID}_CLIENT_SECRET`) ?? get("CF_ACCESS_CLIENT_SECRET");
    for (const s of [token, cfClientId, cfClientSecret]) if (s) secrets.push(s);
    const missing = [!url && `ARGO_${ID}_URL`, !token && `ARGO_${ID}_TOKEN`].filter((x): x is string => !!x);
    let host: string | null = null;
    if (url) {
      try {
        const u = new URL(url);
        if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) missing.push(`ARGO_${ID}_URL (must be https)`);
        host = u.host;
      } catch {
        missing.push(`ARGO_${ID}_URL (not a URL)`);
      }
    }
    const config = !missing.length && url && token && host ? { url, host, token, cfClientId, cfClientSecret } : null;
    return { config, missing, host };
  };
  return { envs: { prd: one("prd"), stg: one("stg") }, secrets };
}
