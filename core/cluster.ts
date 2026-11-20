// Pure logic for the Cluster page: mapping Argo CD JSON to the shapes the page
// shows, the log filter, deploy-run matching, and the write guards.

import type {
  AppHealth,
  AppSync,
  ClusterApp,
  ClusterPod,
  ClusterTree,
  DeployState,
  DiffEntry,
  ImageChange,
  ImageRef,
  LogLine,
  PrRef,
} from "./types.ts";

// ── Argo JSON (only the fields we read) ───────────────────────────────────

export interface ArgoApp {
  metadata: {
    name: string;
    ownerReferences?: { kind: string; name: string }[];
    annotations?: Record<string, string>;
    resourceVersion?: string;
  };
  spec?: { source?: unknown; sources?: unknown[] };
  status?: {
    sync?: { status?: string; revision?: string; revisions?: string[] };
    health?: { status?: string; message?: string };
    operationState?: { phase?: string; startedAt?: string; message?: string };
    summary?: { images?: string[] };
    resources?: { kind: string; name: string; group?: string; namespace?: string; status?: string; health?: { status?: string } }[];
    reconciledAt?: string;
  };
}

export interface ArgoNode {
  kind: string;
  name: string;
  group?: string;
  namespace?: string;
  createdAt?: string;
  info?: { name: string; value: string }[];
  images?: string[];
  health?: { status?: string; message?: string };
  parentRefs?: { kind: string; name: string }[];
}

export interface ArgoTree {
  nodes?: ArgoNode[];
}

export const SHA_RE = /^[0-9a-f]{40}$/;
export const shortSha = (sha: string) => sha.slice(0, 7);

// ── Images ────────────────────────────────────────────────────────────────

/** "registry.digitalocean.com/cloudspot/api-server:<sha>" → { service: "api-server", sha }. */
export function parseImage(ref: string): ImageRef {
  const at = ref.indexOf("@");
  const base = at >= 0 ? ref.slice(0, at) : ref;
  const lastSlash = base.lastIndexOf("/");
  const colon = base.lastIndexOf(":");
  const hasTag = colon > lastSlash;
  const repo = hasTag ? base.slice(0, colon) : base;
  const tag = hasTag ? base.slice(colon + 1) : "latest";
  const service = repo.slice(repo.lastIndexOf("/") + 1);
  return { service, sha: SHA_RE.test(tag) ? tag : null, tag };
}

/** Our own image among a pod's images (sidecars and proxies come from other registries). */
export function pickImage(images: string[] | undefined, app?: string): ImageRef | null {
  if (!images?.length) return null;
  const parsed = images.map(parseImage);
  return (
    parsed.find((p) => p.sha && app && p.service === app) ??
    parsed.find((p) => p.sha) ??
    parsed.find((p) => app && p.service === app) ??
    parsed[0] ??
    null
  );
}

// ── Which apps are shown ──────────────────────────────────────────────────

/** "svc" or "job" when an app comes from that ApplicationSet; null hides it. */
export function appGroup(app: ArgoApp): "svc" | "job" | null {
  for (const o of app.metadata.ownerReferences ?? []) {
    if (o.kind === "ApplicationSet" && (o.name === "svc" || o.name === "job")) return o.name;
  }
  return null;
}

export const isShownApp = (app: ArgoApp) => appGroup(app) != null;

const SYNCS: AppSync[] = ["Synced", "OutOfSync"];
const HEALTHS: AppHealth[] = ["Healthy", "Progressing", "Degraded", "Suspended", "Missing"];

/** The infrastructure commit Argo synced: the 40-hex entry of a multi-source app's revisions. */
export function infraRevision(app: ArgoApp): string | null {
  const s = app.status?.sync;
  const all = [...(s?.revisions ?? []), s?.revision ?? ""];
  return all.find((r) => SHA_RE.test(r)) ?? (s?.revision || null);
}

/** Every revision the sync pins to, in source order. */
export function syncRevisions(app: ArgoApp): string[] {
  const s = app.status?.sync;
  if (s?.revisions?.length) return s.revisions;
  return s?.revision ? [s.revision] : [];
}

const info = (n: ArgoNode, key: string) => n.info?.find((i) => i.name === key)?.value;

/** Pod nodes of a resource tree, newest first. */
export function treePods(tree: ArgoTree | null | undefined, app: string, prOf: (sha: string) => PrRef | null = () => null): ClusterPod[] {
  return (tree?.nodes ?? [])
    .filter((n) => n.kind === "Pod" && !n.group)
    .map((n) => {
      const ready = info(n, "Containers") ?? "0/0";
      const [r, t] = ready.split("/").map(Number);
      const phase = info(n, "Status Reason") ?? n.health?.status ?? "Unknown";
      const img = pickImage(n.images, app);
      return {
        name: n.name,
        phase,
        health: n.health?.status ?? null,
        ready,
        isReady: t! > 0 && r === t && phase === "Running",
        restarts: Number(info(n, "Restart Count") ?? 0) || 0,
        createdAt: n.createdAt ?? null,
        owner: n.parentRefs?.[0]?.kind ?? null,
        image: img ? { ...img, pr: img.sha ? prOf(img.sha) : null } : null,
      };
    })
    .sort((a, b) => Date.parse(b.createdAt ?? "0") - Date.parse(a.createdAt ?? "0"));
}

export function toTree(app: string, tree: ArgoTree | null | undefined, prOf?: (sha: string) => PrRef | null): ClusterTree {
  const pods = treePods(tree, app, prOf);
  const top =
    tree?.nodes?.find((n) => n.kind === "Deployment" && n.name === `cloudspot-${app}`) ??
    tree?.nodes?.find((n) => n.kind === "Deployment") ??
    tree?.nodes?.find((n) => n.kind === "CronJob") ??
    null;
  const shas = [...new Set(pods.map((p) => p.image?.sha).filter((s): s is string => !!s))];
  return { app, pods, deployment: top ? { name: top.name, kind: top.kind } : null, shas };
}

/** Pods that count toward ready/total: finished Job pods don't. */
const isLivePod = (p: ClusterPod) => p.phase !== "Completed" && p.phase !== "Succeeded";

export function toClusterApp(app: ArgoApp, tree: ArgoTree | null, prOf: (sha: string) => PrRef | null = () => null): ClusterApp | null {
  const group = appGroup(app);
  if (!group) return null;
  const name = app.metadata.name;
  const st = app.status ?? {};
  const pods = tree ? treePods(tree, name, prOf) : null;
  const live = pods?.filter(isLivePod) ?? [];

  const podShas = [...new Set((pods ?? []).map((p) => p.image?.sha).filter(Boolean))];
  const newest = pods?.find((p) => p.image)?.image ?? null;
  const fallback = pickImage(st.summary?.images, name);
  const img = newest ?? fallback;
  const imageMixed = podShas.length > 1 || (!pods?.length && (st.summary?.images?.filter((i) => parseImage(i).sha).length ?? 0) > 1);

  const op = st.operationState;
  const running = op && (op.phase === "Running" || op.phase === "Terminating");
  const worst = live
    .filter((p) => !p.isReady || p.restarts > 0)
    .sort((a, b) => Number(a.isReady) - Number(b.isReady) || b.restarts - a.restarts)[0];

  return {
    name,
    group,
    sync: SYNCS.includes(st.sync?.status as AppSync) ? (st.sync!.status as AppSync) : "Unknown",
    health: HEALTHS.includes(st.health?.status as AppHealth) ? (st.health!.status as AppHealth) : "Unknown",
    revision: infraRevision(app),
    operation: op?.phase
      ? { phase: op.phase, startedAt: op.startedAt ?? null, message: running || op.phase !== "Succeeded" ? (op.message ?? null) : null }
      : null,
    image: img ? { ...img, pr: img.sha ? prOf(img.sha) : null, mixed: imageMixed } : null,
    pods: pods
      ? { ready: live.filter((p) => p.isReady).length, total: live.length, restarts: live.reduce((n, p) => n + p.restarts, 0) }
      : null,
    newestPodAt: pods?.find((p) => p.createdAt)?.createdAt ?? null,
    problem: worst ? `${worst.name.replace(`cloudspot-${name}-`, "…")} ${worst.phase}${worst.restarts ? ` · ${worst.restarts} restart${worst.restarts === 1 ? "" : "s"}` : ""}` : null,
  };
}

/** k9s-style age: "45s", "12m", "3h", "5d". */
export function formatAge(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

// ── List order ────────────────────────────────────────────────────────────

/** 0 = needs attention first. */
export function appRank(a: ClusterApp): number {
  if (a.health === "Degraded" || a.health === "Missing" || a.operation?.phase === "Failed" || a.operation?.phase === "Error") return 0;
  if (a.pods && a.pods.ready < a.pods.total) return 1;
  if (a.health === "Progressing" || a.operation?.phase === "Running" || a.image?.mixed) return 1;
  if (a.sync === "OutOfSync" || a.health === "Unknown" || a.sync === "Unknown") return 2;
  return 3;
}

export const needsAttention = (a: ClusterApp) => appRank(a) < 3;

export function sortApps(apps: ClusterApp[]): ClusterApp[] {
  return [...apps].sort((a, b) => appRank(a) - appRank(b) || a.name.localeCompare(b.name));
}

// ── Log filter ────────────────────────────────────────────────────────────

export interface FilterRule {
  mode: "include" | "exclude";
  text: string;
  regex: boolean;
}

export type CompiledRule = FilterRule & { test: ((s: string) => boolean) | null; error: string | null };

export function compileRules(rules: FilterRule[]): CompiledRule[] {
  return rules.map((r) => {
    if (!r.text) return { ...r, test: null, error: null };
    if (r.regex) {
      try {
        const re = new RegExp(r.text, "i");
        return { ...r, test: (s: string) => re.test(s), error: null };
      } catch (e) {
        return { ...r, test: null, error: (e as Error).message };
      }
    }
    const needle = r.text.toLowerCase();
    return { ...r, test: (s: string) => s.toLowerCase().includes(needle), error: null };
  });
}

/** Shown when no include rule exists or one matches, and no exclude rule matches. Invalid or empty rules are ignored. */
export function lineMatches(text: string, rules: CompiledRule[]): boolean {
  const active = rules.filter((r) => r.test);
  const includes = active.filter((r) => r.mode === "include");
  if (includes.length && !includes.some((r) => r.test!(text))) return false;
  return !active.some((r) => r.mode === "exclude" && r.test!(text));
}

export function filterLines<T extends Pick<LogLine, "text">>(lines: T[], rules: FilterRule[]): T[] {
  const compiled = compileRules(rules);
  return lines.filter((l) => lineMatches(l.text, compiled));
}

// ── Deploy runs ───────────────────────────────────────────────────────────

/** `K8S_TARGETS=(svc/a job/b)` from a mono-build.env → Argo app names. */
export function parseK8sTargets(env: string): { kind: "svc" | "job"; app: string }[] {
  const m = env.match(/^\s*(?:export\s+)?K8S_TARGETS\s*=\s*\(([^)]*)\)/m);
  if (!m) return [];
  return m[1]!
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ""))
    .map((t) => t.match(/^(svc|job)\/([\w.-]+)$/))
    .filter((x): x is RegExpMatchArray => !!x)
    .map((x) => ({ kind: x[1] as "svc" | "job", app: x[2]! }));
}

/**
 * Whether an app runs a run's commit yet.
 * `shas` are the image SHAs of the app's pods (or Argo's summary images when it has none).
 * `isLater(sha)` says whether a SHA comes from a later merge; undefined = unknown.
 */
export function deployState(
  headSha: string,
  shas: (string | null)[],
  isLater: (sha: string) => boolean | undefined,
): { state: DeployState; note: string } {
  const known = shas.filter((s): s is string => !!s);
  if (!known.length) return { state: "unknown", note: "no running image to compare" };
  const hits = known.filter((s) => s === headSha).length;
  if (hits === known.length) return { state: "live", note: known.length === 1 ? "running it" : `${hits}/${known.length} pods` };
  if (hits > 0) return { state: "rolling", note: `${hits} of ${known.length} pods` };
  const others = [...new Set(known)];
  if (others.some((s) => isLater(s) === true)) return { state: "replaced", note: `a newer merge runs (${shortSha(others[0]!)})` };
  if (others.every((s) => isLater(s) === false)) return { state: "waiting", note: `still on ${shortSha(others[0]!)}` };
  return { state: "waiting", note: `runs ${shortSha(others[0]!)}` };
}

// ── Write guards ──────────────────────────────────────────────────────────

export const PREVIEW_TTL_MS = 2 * 60_000;

export interface StoredPreview {
  env: string;
  app: string;
  revisions: string[];
  createdAtMs: number;
}

/** null = OK to sync; otherwise why the preview no longer holds. */
export function checkPreview(
  p: StoredPreview | undefined,
  env: string,
  app: string,
  currentRevisions: string[],
  nowMs: number,
): string | null {
  if (!p || p.env !== env || p.app !== app) return "Unknown preview. Review the diff again.";
  if (nowMs - p.createdAtMs > PREVIEW_TTL_MS) return "The preview expired. Review the diff again.";
  if (JSON.stringify(p.revisions) !== JSON.stringify(currentRevisions))
    return "Git moved since the preview. Review the new diff.";
  return null;
}

/** Prod restarts must name the app they restart. */
export function checkRestartConfirm(env: string, app: string, body: unknown): string | null {
  if (env !== "prd") return null;
  const confirm = (body as { confirm?: unknown } | null)?.confirm;
  return confirm === app ? null : `Confirm with the app name "${app}".`;
}

// ── Diff ──────────────────────────────────────────────────────────────────

const NOISY_METADATA = ["managedFields", "resourceVersion", "uid", "generation", "creationTimestamp", "selfLink"];

/** Drop server-set fields so the diff shows what git would change. */
export function normalizeManifest(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const { status: _status, ...rest } = obj;
  const meta = { ...((rest.metadata as Record<string, unknown>) ?? {}) };
  for (const k of NOISY_METADATA) delete meta[k];
  const ann = { ...((meta.annotations as Record<string, string>) ?? {}) };
  delete ann["kubectl.kubernetes.io/last-applied-configuration"];
  delete ann["deployment.kubernetes.io/revision"];
  if (Object.keys(ann).length) meta.annotations = ann;
  else delete meta.annotations;
  return { ...rest, metadata: meta };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

const pretty = (v: unknown) => (v == null ? [] : JSON.stringify(sortKeys(v), null, 2).split("\n"));

/** Line diff (LCS) of two values as pretty JSON, keeping `context` lines around each change. */
export function lineDiff(from: unknown, to: unknown, context = 3): string {
  const a = pretty(from);
  const b = pretty(to);
  // Trim the common prefix and suffix so the LCS table stays small.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length * bm.length > 4_000_000) return [...am.map((l) => `- ${l}`), ...bm.map((l) => `+ ${l}`)].join("\n");

  const n = am.length;
  const m = bm.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = am[i] === bm[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);

  const ops: [" " | "-" | "+", string][] = a.slice(0, pre).map((l) => [" ", l]);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      ops.push([" ", am[i]!]);
      i++;
      j++;
    } else if (i < n && (j === m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) ops.push(["-", am[i++]!]);
    else ops.push(["+", bm[j++]!]);
  }
  for (const l of a.slice(a.length - suf)) ops.push([" ", l]);

  const keep = new Array(ops.length).fill(false);
  ops.forEach(([op], k) => {
    if (op === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true;
  });
  const out: string[] = [];
  let skipped = false;
  ops.forEach(([op, l], k) => {
    if (!keep[k]) {
      if (!skipped) out.push("  …");
      skipped = true;
      return;
    }
    skipped = false;
    out.push(`${op} ${l}`);
  });
  return out.join("\n");
}

/** Container images by "container" name in a Deployment / Job / CronJob / Pod manifest. */
export function manifestImages(obj: Record<string, unknown> | null): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (spec: unknown) => {
    const s = spec as { containers?: { name: string; image: string }[]; initContainers?: { name: string; image: string }[] } | undefined;
    for (const c of [...(s?.initContainers ?? []), ...(s?.containers ?? [])]) out.set(c.name, c.image);
  };
  const spec = obj?.spec as Record<string, any> | undefined;
  walk(spec?.template?.spec);
  walk(spec?.jobTemplate?.spec?.template?.spec);
  walk(spec);
  return out;
}

export interface ManagedResource {
  kind: string;
  name: string;
  group?: string;
  namespace?: string;
  liveState?: string;
  targetState?: string;
  normalizedLiveState?: string;
  predictedLiveState?: string;
}

/** Out-of-sync resources with their patches, and the image changes among them. */
export function buildDiff(
  items: ManagedResource[],
  statusOf: (r: ManagedResource) => string | undefined,
  prOf: (sha: string) => PrRef | null = () => null,
): { resources: DiffEntry[]; images: ImageChange[] } {
  const resources: DiffEntry[] = [];
  const images: ImageChange[] = [];
  for (const r of items) {
    const live = normalizeManifest(r.normalizedLiveState ?? r.liveState);
    const target = normalizeManifest(r.predictedLiveState ?? r.targetState);
    const declared = statusOf(r);
    const status: DiffEntry["status"] | null = !live && target ? "Missing" : live && !target ? "Extra" : declared === "OutOfSync" ? "OutOfSync" : null;
    if (!status) continue;
    const patch = lineDiff(live, target);
    if (status === "OutOfSync" && !/^[+-] /m.test(patch)) continue;
    resources.push({ kind: r.kind, name: r.name, status, patch });

    const before = manifestImages(live);
    const after = manifestImages(target);
    for (const [container, img] of after) {
      const old = before.get(container);
      if (old === img) continue;
      const pf = (s: string | undefined) => {
        if (!s) return null;
        const p = parseImage(s);
        return { ...p, pr: p.sha ? prOf(p.sha) : null };
      };
      images.push({ resource: `${r.kind}/${r.name}`, container, from: pf(old), to: pf(img) });
    }
  }
  return { resources, images };
}

// ── Secrets ───────────────────────────────────────────────────────────────

/** Replace every secret value that appears in `text` (error bodies can echo headers). */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out;
}
