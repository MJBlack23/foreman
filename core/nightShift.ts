// Night Shift tab: the pure parts (types, health state, the status dot, notifications, the uptime strip).

export const NIGHT_SHIFT_URL = "https://night-shift-5lcby.ondigitalocean.app";
export const NIGHT_SHIFT_APP_ID = "8749d2ce-6186-4cdb-a25f-8899cc60c7f3";
export const NIGHT_SHIFT_REPO_URL = "https://github.com/CloudSpot/night-shift";
export const DO_CONSOLE_URL = `https://cloud.digitalocean.com/apps/${NIGHT_SHIFT_APP_ID}`;

export const HEALTH_EVERY_MS = 10 * 60_000;
export const HEALTH_TIMEOUT_MS = 10_000;
export const STATUS_EVERY_MS = 30 * 60_000;
/** While a deployment is in progress, the status poll runs this often. */
export const STATUS_DEPLOYING_EVERY_MS = 60_000;
/** Health counts as down after this many failed checks in a row. */
export const DOWN_AFTER_FAILURES = 2;
export const HISTORY_MS = 7 * 24 * 60 * 60_000;
export const STRIP_MS = 24 * 60 * 60_000;
export const STRIP_BUCKET_MS = HEALTH_EVERY_MS;
export const TICKS_SHOWN = 10;

export interface HealthCheck {
  at: string;
  ok: boolean;
  /** HTTP status, or null when there was no response (timeout, DNS, connection). */
  status: number | null;
  ms: number | null;
  error: string | null;
}

export type DeployPhase =
  | "UNKNOWN"
  | "PENDING_BUILD"
  | "BUILDING"
  | "PENDING_DEPLOY"
  | "DEPLOYING"
  | "ACTIVE"
  | "SUPERSEDED"
  | "ERROR"
  | "CANCELED"
  | (string & {});

export interface Deployment {
  id: string;
  phase: DeployPhase;
  cause: string | null;
  commit: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface StatusPoll {
  at: string;
  ok: boolean;
  error: string | null;
  active: Deployment | null;
  latest: Deployment | null;
  lastActiveAt: string | null;
}

export type TickResult = "started" | "already-running" | "unauthorized" | "error";

export interface TickRecord {
  at: string;
  result: TickResult;
  status: number | null;
  message: string | null;
}

export type HealthState = "up" | "down" | "unknown";
export type Overall = "ok" | "deploying" | "bad" | "unknown";
export type StripCell = "up" | "down" | "none";

export interface NightShiftState {
  url: string;
  appId: string;
  consoleUrl: string;
  repoUrl: string;
  /** Doppler variables the server is missing. */
  missing: string[];
  canPollStatus: boolean;
  canTick: boolean;
  overall: Overall;
  health: {
    state: HealthState;
    last: HealthCheck | null;
    /** When the current run of failed checks began, while down. */
    downSince: string | null;
    strip: StripCell[];
    uptimePct: number | null;
  };
  status: StatusPoll | null;
  ticks: TickRecord[];
  nextHealthAt: string | null;
  nextStatusAt: string | null;
  checking: boolean;
  ticking: boolean;
}

const IN_PROGRESS: ReadonlySet<string> = new Set(["PENDING_BUILD", "BUILDING", "PENDING_DEPLOY", "DEPLOYING"]);

export const isInProgress = (d: Deployment | null | undefined) => !!d && IN_PROGRESS.has(d.phase);

/** The failed checks at the end of the list (newest last). */
export function trailingFailures(checks: HealthCheck[]): HealthCheck[] {
  let i = checks.length;
  while (i > 0 && !checks[i - 1]!.ok) i--;
  return checks.slice(i);
}

/** Checks are oldest first. Down needs DOWN_AFTER_FAILURES failures in a row; one slow answer isn't an outage. */
export function healthState(checks: HealthCheck[]): HealthState {
  if (!checks.length) return "unknown";
  if (trailingFailures(checks).length >= DOWN_AFTER_FAILURES) return "down";
  // A single failure after a long run of passes still reads as up until the next check confirms it.
  return checks.some((c) => c.ok) ? "up" : "unknown";
}

export function downSince(checks: HealthCheck[]): string | null {
  const fails = trailingFailures(checks);
  return fails.length >= DOWN_AFTER_FAILURES ? fails[0]!.at : null;
}

/** The latest deployment failed and nothing newer has gone live since. */
export function deployFailed(s: StatusPoll | null): boolean {
  return !!s?.latest && s.latest.phase === "ERROR" && s.latest.id !== s.active?.id;
}

export function overall(health: HealthState, s: StatusPoll | null): Overall {
  if (health === "down" || deployFailed(s)) return "bad";
  if (isInProgress(s?.latest)) return "deploying";
  if (health === "up") return "ok";
  return "unknown";
}

export function nextStatusDelay(s: StatusPoll | null): number {
  return isInProgress(s?.latest) ? STATUS_DEPLOYING_EVERY_MS : STATUS_EVERY_MS;
}

/**
 * The last 24 hours of health checks in 10-minute cells, oldest first.
 * A cell with any failure is down; a cell with no checks (Foreman wasn't running) is none.
 */
export function uptimeStrip(checks: HealthCheck[], nowMs: number): { cells: StripCell[]; pct: number | null } {
  const n = Math.round(STRIP_MS / STRIP_BUCKET_MS);
  const start = nowMs - n * STRIP_BUCKET_MS;
  const cells: StripCell[] = Array.from({ length: n }, () => "none");
  let ok = 0;
  let total = 0;
  for (const c of checks) {
    const t = Date.parse(c.at);
    if (!(t > start && t <= nowMs)) continue;
    const i = Math.min(n - 1, Math.floor((t - start) / STRIP_BUCKET_MS));
    total++;
    if (c.ok) ok++;
    if (!c.ok) cells[i] = "down";
    else if (cells[i] === "none") cells[i] = "up";
  }
  return { cells, pct: total ? (ok / total) * 100 : null };
}

export interface NightShiftAlert {
  id: string;
  title: string;
  message: string;
}

/**
 * Alerts for a change of state, given the check history before and after the
 * newest check. Ids are stable, so the `seen` table stops repeats across restarts.
 */
export function healthAlerts(before: HealthCheck[], after: HealthCheck[]): NightShiftAlert[] {
  const was = healthState(before);
  const now = healthState(after);
  const last = after[after.length - 1];
  if (!last || was === now) return [];
  if (now === "down") {
    const since = downSince(after)!;
    const why = last.status ? `HTTP ${last.status}` : (last.error ?? "no response");
    return [{ id: `night-shift:down:${since}`, title: "Night Shift is down", message: `/health failed ${DOWN_AFTER_FAILURES} checks in a row (${why})` }];
  }
  if (now === "up" && was === "down") {
    return [{ id: `night-shift:up:${last.at}`, title: "Night Shift is back up", message: `/health answered in ${last.ms ?? "?"} ms` }];
  }
  return [];
}

export function deployAlerts(s: StatusPoll | null): NightShiftAlert[] {
  if (!deployFailed(s)) return [];
  const d = s!.latest!;
  return [
    {
      id: `night-shift:deploy-error:${d.id}`,
      title: "Night Shift deploy failed",
      message: `Deployment ${d.id.slice(0, 8)}${d.commit ? ` (${d.commit.slice(0, 7)})` : ""} ended in ERROR`,
    },
  ];
}

// ── DigitalOcean API parsing ─────────────────────────────────────────────

interface DoDeployment {
  id?: string;
  phase?: string;
  cause?: string;
  created_at?: string;
  updated_at?: string;
  services?: { name?: string; source_commit_hash?: string }[];
}

export function parseDeployment(d: DoDeployment | null | undefined): Deployment | null {
  if (!d?.id) return null;
  return {
    id: d.id,
    phase: d.phase ?? "UNKNOWN",
    cause: d.cause ?? null,
    commit: d.services?.find((s) => s.source_commit_hash)?.source_commit_hash ?? null,
    createdAt: d.created_at ?? null,
    updatedAt: d.updated_at ?? null,
  };
}

/** From GET /v2/apps/{id} and GET /v2/apps/{id}/deployments?per_page=1. */
export function parseStatus(
  app: { active_deployment?: DoDeployment; last_deployment_active_at?: string } | undefined,
  deployments: DoDeployment[] | undefined,
  at: string,
): StatusPoll {
  return {
    at,
    ok: true,
    error: null,
    active: parseDeployment(app?.active_deployment),
    latest: parseDeployment(deployments?.[0]),
    lastActiveAt: app?.last_deployment_active_at ?? null,
  };
}

export function tickResult(status: number): TickResult {
  if (status === 202 || (status >= 200 && status < 300)) return "started";
  if (status === 409) return "already-running";
  if (status === 401 || status === 403) return "unauthorized";
  return "error";
}
