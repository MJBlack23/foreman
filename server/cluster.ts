import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  type ArgoApp,
  type ArgoTree,
  buildDiff,
  checkPreview,
  checkRestartConfirm,
  deployState,
  parseK8sTargets,
  redact,
  type StoredPreview,
  SHA_RE,
  shortSha,
  syncRevisions,
  toClusterApp,
  toTree,
} from "../core/cluster.ts";
import {
  CLUSTER_ENV_LABEL,
  CLUSTER_ENVS,
  type ClusterApp,
  type ClusterAppsPayload,
  type ClusterEnv,
  type ClusterEnvInfo,
  type ClusterTreePayload,
  type DeployTarget,
  type DeployTargetsPayload,
  type PrRef,
  type RestartPlan,
  type StreamState,
  type SyncPreview,
} from "../core/types.ts";
import { ArgoClient, ArgoError } from "./argo.ts";
import { type ArgoConfig, INFRA_REPO, REPO_NAME, REPO_OWNER } from "./config.ts";
import type { GitHub } from "./github.ts";
import { HiddenAppsStore } from "./hiddenApps.ts";

const CLOSE_AFTER_MS = 30_000;
const TREES_EVERY_MS = 30_000;
const TREE_CONCURRENCY = 4;
const PR_CONCURRENCY = 4;

const isEnv = (s: string): s is ClusterEnv => (CLUSTER_ENVS as string[]).includes(s);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Run `fn` over `items`, `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
    }),
  );
}

// ── SHA → PR ──────────────────────────────────────────────────────────────

/** Resolves image SHAs to their merged PR in CloudSpot/cloudspot. A commit's PR never changes, so results are kept. */
class PrResolver {
  private known = new Map<string, PrRef | null>();
  private queue: string[] = [];
  private queued = new Set<string>();
  private active = 0;
  private listeners = new Set<() => void>();
  private laterCache = new Map<string, boolean | undefined>();

  constructor(private gh: GitHub) {}

  /** Synchronous lookup; unknown SHAs are queued and listeners fire when they resolve. */
  get = (sha: string): PrRef | null => {
    if (this.known.has(sha)) return this.known.get(sha)!;
    if (SHA_RE.test(sha) && !this.queued.has(sha)) {
      this.queued.add(sha);
      this.queue.push(sha);
      this.pump();
    }
    return null;
  };

  /** Whether a lookup has finished (with or without a PR). */
  settled(sha: string) {
    return this.known.has(sha);
  }

  onResolved(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private pump() {
    while (this.active < PR_CONCURRENCY && this.queue.length) {
      const sha = this.queue.shift()!;
      this.active++;
      void this.resolve(sha).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async resolve(sha: string) {
    try {
      const pulls = await this.gh.get<{ number: number; title: string; html_url: string; merged_at: string | null }[]>(
        "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
        { owner: REPO_OWNER, repo: REPO_NAME, commit_sha: sha },
      );
      const pr = pulls.find((p) => p.merged_at) ?? pulls[0];
      this.known.set(sha, pr ? { number: pr.number, title: pr.title, htmlUrl: pr.html_url } : null);
      for (const fn of this.listeners) fn();
    } catch (e) {
      const status = (e as { status?: number }).status;
      // 404/422: not a commit in this repo. Anything else: try again on a later lookup.
      if (status === 404 || status === 422) this.known.set(sha, null);
      this.queued.delete(sha);
    }
  }

  /** Is `sha` a later commit on main than `base`? undefined when GitHub can't say. */
  async isLater(base: string, sha: string): Promise<boolean | undefined> {
    const key = `${base}...${sha}`;
    if (this.laterCache.has(key)) return this.laterCache.get(key);
    let out: boolean | undefined;
    try {
      const r = await this.gh.get<{ status: string }>("GET /repos/{owner}/{repo}/compare/{basehead}", {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        basehead: key,
        per_page: 1,
      });
      out = r.status === "ahead" ? true : r.status === "behind" || r.status === "identical" ? false : undefined;
    } catch {
      out = undefined;
    }
    this.laterCache.set(key, out);
    return out;
  }
}

// ── App list watcher ──────────────────────────────────────────────────────

type AppsListener = (p: ClusterAppsPayload) => void;

/**
 * Keeps an environment's shown apps and their pod trees current while at least
 * one page is subscribed. Opens Argo's app stream, refetches trees on change
 * and every 30s, and closes everything 30s after the last page leaves.
 */
class AppsWatcher {
  private apps = new Map<string, ArgoApp>();
  private trees = new Map<string, ArgoTree>();
  private listeners = new Set<AppsListener>();
  private abort: AbortController | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private lastEmitMs = 0;
  private state: StreamState = "loading";
  private message: string | null = null;
  private current: ClusterAppsPayload;
  private treeQueue = new Set<string>();
  private treeRunning = false;
  private unsubPr: () => void;

  constructor(
    private env: ClusterEnv,
    private argo: ArgoClient,
    private prs: PrResolver,
    private hidden: () => string[],
  ) {
    this.current = this.compute();
    this.unsubPr = prs.onResolved(() => this.scheduleEmit());
  }

  get isOpen() {
    return this.abort != null;
  }

  snapshot() {
    return this.current;
  }

  rawApp(name: string) {
    return this.apps.get(name);
  }

  tree(name: string) {
    return this.trees.get(name);
  }

  subscribe(fn: AppsListener): () => void {
    this.listeners.add(fn);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (!this.abort) this.open();
    fn(this.current);
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) {
        this.closeTimer = setTimeout(() => this.close(), CLOSE_AFTER_MS);
      }
    };
  }

  private open() {
    const abort = new AbortController();
    this.abort = abort;
    console.log(`[argo:${this.env}] watching apps`);
    void this.run(abort.signal);
    void this.treeLoop(abort.signal);
  }

  private close() {
    console.log(`[argo:${this.env}] closing app watch`);
    this.abort?.abort();
    this.abort = null;
    this.state = "loading";
  }

  private setState(state: StreamState, message: string | null) {
    this.state = state;
    this.message = message;
    this.scheduleEmit();
  }

  private async run(signal: AbortSignal) {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const list = await this.argo.apps();
        this.apps = new Map(list.filter((a) => toClusterApp(a, null)).map((a) => [a.metadata.name, a]));
        for (const name of this.trees.keys()) if (!this.apps.has(name)) this.trees.delete(name);
        this.setState("live", null);
        for (const name of this.apps.keys()) this.queueTree(name);
        backoff = 1000;
        await this.argo.watchApps((e) => {
          const a = e.application;
          if (!a?.metadata?.name || !toClusterApp(a, null)) return;
          const name = a.metadata.name;
          if (e.type === "DELETED") {
            this.apps.delete(name);
            this.trees.delete(name);
          } else {
            const before = this.apps.get(name);
            this.apps.set(name, a);
            if (!before || fingerprint(before) !== fingerprint(a)) this.queueTree(name);
          }
          this.scheduleEmit();
        }, signal);
        if (signal.aborted) return;
        // Argo closes the stream now and then; reopen at once.
        this.setState("reconnecting", null);
      } catch (e) {
        if (signal.aborted) return;
        const err = e as ArgoError;
        const fatal = err.status === 401 || err.status === 403;
        this.setState(fatal ? "error" : "reconnecting", err.message);
        console.warn(`[argo:${this.env}] ${err.message}`);
        await sleep(fatal ? 30_000 : backoff, signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private queueTree(name: string) {
    this.treeQueue.add(name);
    void this.drainTrees();
  }

  private async drainTrees() {
    if (this.treeRunning || !this.abort) return;
    this.treeRunning = true;
    try {
      while (this.treeQueue.size && this.abort) {
        const batch = [...this.treeQueue];
        this.treeQueue.clear();
        await pool(batch, TREE_CONCURRENCY, async (name) => {
          if (!this.apps.has(name)) return;
          try {
            this.trees.set(name, await this.argo.tree(name));
            this.scheduleEmit();
          } catch (e) {
            console.warn(`[argo:${this.env}] tree ${name}: ${(e as Error).message}`);
          }
        });
      }
    } finally {
      this.treeRunning = false;
    }
  }

  /** Restart counts and readiness change without the app changing, so re-read every tree now and then. */
  private async treeLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      await sleep(TREES_EVERY_MS, signal);
      if (signal.aborted) return;
      for (const name of this.apps.keys()) this.treeQueue.add(name);
      await this.drainTrees();
    }
  }

  /** Push now-ish, e.g. after the hidden list changed. */
  republish() {
    this.scheduleEmit();
  }

  /** At most one push per second. */
  private scheduleEmit() {
    if (this.emitTimer) return;
    const wait = Math.max(0, 1000 - (Date.now() - this.lastEmitMs));
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.lastEmitMs = Date.now();
      this.current = this.compute();
      for (const fn of this.listeners) fn(this.current);
    }, wait);
  }

  private compute(): ClusterAppsPayload {
    const apps = [...this.apps.values()]
      .map((a) => toClusterApp(a, this.trees.get(a.metadata.name) ?? null, this.prs.get))
      .filter((a): a is ClusterApp => !!a);
    return { env: this.env, apps, hidden: this.hidden(), state: this.state, message: this.message, updatedAt: new Date().toISOString() };
  }

  dispose() {
    this.close();
    this.unsubPr();
  }
}

/** The parts of an app that change its pods. */
function fingerprint(a: ArgoApp) {
  const s = a.status;
  return JSON.stringify([s?.sync?.status, s?.sync?.revisions ?? s?.sync?.revision, s?.health?.status, s?.operationState?.phase, s?.summary?.images]);
}

// ── Service ───────────────────────────────────────────────────────────────

export interface RunInfo {
  headSha: string | null;
  deployProd: boolean;
  services: string[];
}

export interface ClusterDeps {
  config: ArgoConfig;
  gh: GitHub;
  dataDir: string;
  port: number;
  /** Origins allowed to POST (the dashboard and, in dev, Vite). */
  origins: string[];
  /** Run details for deploy-run links, or null when the run isn't one of mine. */
  runInfo: (runId: number) => RunInfo | null;
  /** Ask outside the browser before a prod write. Resolves true to go ahead. */
  nativeConfirm?: (title: string, message: string, button: string) => Promise<boolean>;
}

export class ClusterService {
  readonly clients = new Map<ClusterEnv, ArgoClient>();
  private watchers = new Map<ClusterEnv, AppsWatcher>();
  readonly prs: PrResolver;
  private previews = new Map<string, StoredPreview>();
  private targetCache = new Map<string, { kind: "svc" | "job"; app: string }[]>();
  readonly hidden: HiddenAppsStore;

  constructor(readonly deps: ClusterDeps) {
    this.prs = new PrResolver(deps.gh);
    this.hidden = new HiddenAppsStore(deps.dataDir);
    for (const env of CLUSTER_ENVS) {
      const c = deps.config.envs[env].config;
      if (!c) continue;
      const client = new ArgoClient(env, c, deps.config.secrets);
      this.clients.set(env, client);
      this.watchers.set(env, new AppsWatcher(env, client, this.prs, () => this.hidden.list()));
    }
  }

  info(): ClusterEnvInfo[] {
    return CLUSTER_ENVS.map((id) => {
      const e = this.deps.config.envs[id];
      return { id, label: CLUSTER_ENV_LABEL[id], host: e.host, configured: !!e.config, missing: e.missing };
    });
  }

  setHidden(app: string, hidden: boolean): string[] | null {
    if (!this.hidden.set(app, hidden)) return null;
    for (const w of this.watchers.values()) w.republish();
    return this.hidden.list();
  }

  watcher(env: ClusterEnv) {
    return this.watchers.get(env);
  }

  redact(s: string) {
    return redact(s, this.deps.config.secrets);
  }

  /** The Argo app, from the open watcher or one request. Only svc/job apps. */
  async shownApp(env: ClusterEnv, name: string): Promise<ArgoApp> {
    const w = this.watchers.get(env);
    const cached = w?.isOpen ? w.rawApp(name) : undefined;
    const a = cached ?? (await this.client(env).app(name));
    if (!toClusterApp(a, null)) throw new ArgoError(`${name} is not a svc or job app`, 404);
    return a;
  }

  client(env: ClusterEnv): ArgoClient {
    const c = this.clients.get(env);
    if (!c) throw new ArgoError(`${CLUSTER_ENV_LABEL[env]} is not configured`, 503);
    return c;
  }

  audit(env: ClusterEnv, app: string, action: string, result: string) {
    const line = JSON.stringify({ at: new Date().toISOString(), env, app, action, result: this.redact(result) });
    try {
      appendFileSync(join(this.deps.dataDir, "cluster-actions.log"), line + "\n", { mode: 0o600 });
    } catch (e) {
      console.warn(`[argo] audit log: ${(e as Error).message}`);
    }
    console.log(`[argo:${env}] ${action} ${app}: ${this.redact(result)}`);
  }

  async preview(env: ClusterEnv, name: string): Promise<SyncPreview> {
    await this.shownApp(env, name);
    const argo = this.client(env);
    let app = await argo.app(name, true);
    // The refresh runs in the background; wait for Argo to finish it.
    for (let i = 0; i < 20 && app.metadata.annotations?.["argocd.argoproj.io/refresh"]; i++) {
      await sleep(750);
      app = await argo.app(name);
    }
    const items = await argo.managedResources(name);
    const status = new Map((app.status?.resources ?? []).map((r) => [`${r.kind}/${r.namespace ?? ""}/${r.name}`, r.status]));
    const { resources, images } = buildDiff(items, (r) => status.get(`${r.kind}/${r.namespace ?? ""}/${r.name}`), this.prs.get);
    // Resolve the image SHAs before answering, so the dialog shows PR titles.
    const shas = images.flatMap((i) => [i.from?.sha, i.to?.sha]).filter((s): s is string => !!s);
    shas.forEach((s) => this.prs.get(s));
    await this.waitForPrs(shas, 4000);
    const withPrs = images.map((i) => ({
      ...i,
      from: i.from ? { ...i.from, pr: i.from.sha ? this.prs.get(i.from.sha) : null } : null,
      to: i.to ? { ...i.to, pr: i.to.sha ? this.prs.get(i.to.sha) : null } : null,
    }));

    const revisions = syncRevisions(app);
    const previewId = randomUUID();
    const now = Date.now();
    this.previews.set(previewId, { env, app: name, revisions, createdAtMs: now });
    for (const [id, p] of this.previews) if (now - p.createdAtMs > 10 * 60_000) this.previews.delete(id);
    const revision = revisions.find((r) => SHA_RE.test(r)) ?? revisions[0] ?? null;
    return {
      previewId,
      env,
      app: name,
      revision,
      revisionUrl: revision && SHA_RE.test(revision) ? `https://github.com/${INFRA_REPO}/commit/${revision}` : null,
      resources,
      images: withPrs,
      expiresAt: new Date(now + 2 * 60_000).toISOString(),
    };
  }

  private async waitForPrs(shas: string[], ms: number) {
    const start = Date.now();
    while (Date.now() - start < ms && shas.some((s) => !this.prs.settled(s))) await sleep(150);
  }

  async sync(env: ClusterEnv, name: string, previewId: unknown): Promise<{ status: number; body: object }> {
    await this.shownApp(env, name);
    const p = typeof previewId === "string" ? this.previews.get(previewId) : undefined;
    const fresh = await this.client(env).app(name);
    const problem = checkPreview(p, env, name, syncRevisions(fresh), Date.now());
    if (problem) return { status: 409, body: { error: problem } };
    const rev = p!.revisions.find((r) => SHA_RE.test(r)) ?? p!.revisions[0] ?? "";
    if (env === "prd" && !(await this.confirmOutside(`Sync ${name} in PRODUCTION?`, `Argo will sync ${name} to infrastructure ${shortSha(rev)}.`, "Sync production"))) {
      this.audit(env, name, "sync", "cancelled in the macOS dialog");
      return { status: 409, body: { error: "Cancelled in the macOS confirmation." } };
    }
    this.previews.delete(previewId as string);
    try {
      await this.client(env).sync(name, p!.revisions);
      this.audit(env, name, "sync", `ok ${p!.revisions.join(",")}`);
      return { status: 200, body: { ok: true, revision: rev } };
    } catch (e) {
      this.audit(env, name, "sync", `failed: ${(e as Error).message}`);
      throw e;
    }
  }

  async restartPlan(env: ClusterEnv, name: string): Promise<RestartPlan> {
    await this.shownApp(env, name);
    const tree = toTree(name, await this.client(env).tree(name), this.prs.get);
    if (tree.deployment?.kind !== "Deployment") throw new ArgoError(`${name} has no Deployment to restart`, 400);
    return { env, app: name, deployment: tree.deployment.name, pods: tree.pods, sha: tree.shas[0] ?? null };
  }

  async restart(env: ClusterEnv, name: string, body: unknown): Promise<{ status: number; body: object }> {
    const problem = checkRestartConfirm(env, name, body);
    if (problem) return { status: 400, body: { error: problem } };
    const plan = await this.restartPlan(env, name);
    if (
      env === "prd" &&
      !(await this.confirmOutside(`Restart ${name} in PRODUCTION?`, `Kubernetes will replace the ${plan.pods.length} pod(s) of ${plan.deployment}.`, "Restart production"))
    ) {
      this.audit(env, name, "restart", "cancelled in the macOS dialog");
      return { status: 409, body: { error: "Cancelled in the macOS confirmation." } };
    }
    try {
      await this.client(env).restart(name, plan.deployment);
      this.audit(env, name, "restart", `ok ${plan.deployment}`);
      return { status: 200, body: { ok: true } };
    } catch (e) {
      this.audit(env, name, "restart", `failed: ${(e as Error).message}`);
      throw e;
    }
  }

  private async confirmOutside(title: string, message: string, button: string) {
    if (!this.deps.nativeConfirm) return true;
    return this.deps.nativeConfirm(title, message, button);
  }

  /** Which apps a run shipped, and whether each runs its commit yet. */
  async deployTargets(runId: number): Promise<DeployTargetsPayload | null> {
    const run = this.deps.runInfo(runId);
    if (!run) return null;
    const notes: string[] = [];
    if (!run.headSha) return { runId, headSha: null, targets: [], notes: ["The run has no commit SHA."] };
    const head = run.headSha;

    const apps: { kind: "svc" | "job"; app: string }[] = [];
    for (const service of run.services) {
      for (const t of await this.k8sTargets(service, head)) if (!apps.some((a) => a.app === t.app)) apps.push(t);
    }
    if (!apps.length) return { runId, headSha: head, targets: [], notes: run.services.length ? ["No K8S_TARGETS found."] : [] };

    const envs: ClusterEnv[] = run.deployProd ? ["stg", "prd"] : ["stg"];
    const targets: DeployTarget[] = [];
    for (const env of envs) {
      if (!this.clients.has(env)) {
        notes.push(`${CLUSTER_ENV_LABEL[env]} not configured`);
        continue;
      }
      await pool(apps, TREE_CONCURRENCY, async ({ app }) => {
        try {
          const shas = await this.appShas(env, app);
          const later = new Map<string, boolean | undefined>();
          for (const s of new Set(shas)) if (s && s !== head) later.set(s, await this.prs.isLater(head, s));
          const st = deployState(head, shas, (s) => later.get(s));
          targets.push({ env, app, ...st });
        } catch (e) {
          targets.push({ env, app, state: "unknown", note: (e as Error).message });
        }
      });
    }
    const order = (t: DeployTarget) => `${t.env === "stg" ? 0 : 1}${apps.findIndex((a) => a.app === t.app).toString().padStart(3, "0")}`;
    targets.sort((a, b) => order(a).localeCompare(order(b)));
    return { runId, headSha: head, targets, notes };
  }

  private async appShas(env: ClusterEnv, app: string): Promise<(string | null)[]> {
    const w = this.watchers.get(env);
    let tree = w?.isOpen ? w.tree(app) : undefined;
    let raw = w?.isOpen ? w.rawApp(app) : undefined;
    if (!tree) tree = await this.client(env).tree(app);
    const pods = toTree(app, tree).pods.filter((p) => p.phase !== "Completed" && p.phase !== "Succeeded");
    if (pods.length) return pods.map((p) => p.image?.sha ?? null);
    raw ??= await this.client(env).app(app);
    const a = toClusterApp(raw, null);
    return a?.image ? [a.image.sha] : [];
  }

  private async k8sTargets(service: string, sha: string) {
    const key = `${service}@${sha}`;
    const hit = this.targetCache.get(key);
    if (hit) return hit;
    let targets: { kind: "svc" | "job"; app: string }[] = [];
    try {
      const file = await this.deps.gh.get<{ content?: string; encoding?: string }>("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: `services/${service}/mono-build.env`,
        ref: sha,
      });
      const text = file.content ? Buffer.from(file.content, (file.encoding as BufferEncoding) ?? "base64").toString("utf8") : "";
      targets = parseK8sTargets(text);
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
    this.targetCache.set(key, targets);
    return targets;
  }
}

// ── macOS confirmation ────────────────────────────────────────────────────

/** A native dialog the browser and local scripts can't click through. */
export function macConfirm(title: string, message: string, button: string): Promise<boolean> {
  const q = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
  const script = `display dialog ${q(message)} with title ${q(title)} buttons {"Cancel", ${q(button)}} default button "Cancel" cancel button "Cancel" with icon caution giving up after 60`;
  return new Promise((resolve) => {
    execFile("osascript", ["-e", `activate`, "-e", script], { timeout: 70_000 }, (err, stdout) => {
      resolve(!err && stdout.includes(`button returned:${button}`) && !stdout.includes("gave up:true"));
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────

/** POSTs must come from the dashboard page itself, as JSON. */
export function originAllowed(origin: string | undefined, contentType: string | undefined, allowed: string[]): boolean {
  return !!origin && allowed.includes(origin) && /^application\/json\b/i.test(contentType ?? "");
}

export function dashboardOrigins(port: number, extraPorts: number[] = []): string[] {
  return [port, ...extraPorts].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);
}

function errorResponse(c: Context, svc: ClusterService, e: unknown) {
  const status = e instanceof ArgoError ? e.status : 500;
  const message = svc.redact((e as Error).message ?? String(e));
  const code = status >= 400 && status < 600 ? status : 502;
  return c.json({ error: message }, code as 400);
}

export function clusterRoutes(app: Hono, svc: ClusterService) {
  app.use("/api/cluster/*", async (c, next) => {
    if (c.req.method !== "GET" && !originAllowed(c.req.header("origin"), c.req.header("content-type"), svc.deps.origins)) {
      return c.json({ error: "Forbidden: cluster writes must come from the dashboard page." }, 403);
    }
    await next();
  });

  app.get("/api/cluster/config", (c) => c.json({ envs: svc.info() }));

  app.get("/api/cluster/hidden", (c) => c.json({ hidden: svc.hidden.list() }));

  app.post("/api/cluster/hidden", async (c) => {
    const body = await c.req.json<{ app?: unknown; hidden?: unknown }>().catch(() => ({}) as { app?: unknown; hidden?: unknown });
    if (typeof body.app !== "string" || typeof body.hidden !== "boolean") return c.json({ error: "Send { app, hidden }." }, 400);
    const list = svc.setHidden(body.app, body.hidden);
    return list ? c.json({ hidden: list }) : c.json({ error: "bad app name" }, 400);
  });

  const env = (c: Context): ClusterEnv | null => {
    const e = c.req.param("env") ?? "";
    return isEnv(e) ? e : null;
  };

  app.get("/api/cluster/:env/events", (c) => {
    const e = env(c);
    const w = e && svc.watcher(e);
    if (!w) return c.json({ error: "not configured" }, 404);
    return streamSSE(c, async (stream) => {
      const unsubscribe = w.subscribe((p) => {
        stream.writeSSE({ event: "apps", data: JSON.stringify(p) }).catch(() => {});
      });
      const heartbeat = setInterval(() => stream.writeSSE({ event: "ping", data: "" }).catch(() => {}), 25_000);
      await new Promise<void>((resolve) =>
        stream.onAbort(() => {
          unsubscribe();
          clearInterval(heartbeat);
          resolve();
        }),
      );
    });
  });

  app.get("/api/cluster/:env/apps/:app/tree", (c) => {
    const e = env(c);
    if (!e || !svc.clients.has(e)) return c.json({ error: "not configured" }, 404);
    const name = c.req.param("app");
    const argo = svc.client(e);
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      let last: ArgoTree | null = null;
      const send = (p: ClusterTreePayload) => stream.writeSSE({ event: "tree", data: JSON.stringify(p) }).catch(() => {});
      const push = (state: StreamState, message: string | null) =>
        send({ tree: last ? toTree(name, last, svc.prs.get) : null, state, message });
      const unsub = svc.prs.onResolved(() => last && push("live", null));
      const heartbeat = setInterval(() => stream.writeSSE({ event: "ping", data: "" }).catch(() => {}), 25_000);
      let backoff = 1000;
      try {
        await svc.shownApp(e, name);
        while (!abort.signal.aborted) {
          try {
            last = await argo.tree(name);
            await push("live", null);
            backoff = 1000;
            await argo.watchTree(name, (t) => {
              last = t;
              void push("live", null);
            }, abort.signal);
            if (abort.signal.aborted) break;
          } catch (err) {
            if (abort.signal.aborted) break;
            const ae = err as ArgoError;
            const fatal = ae.status === 401 || ae.status === 403 || ae.status === 404;
            await push(fatal ? "error" : "reconnecting", svc.redact(ae.message));
            await sleep(fatal ? 30_000 : backoff, abort.signal);
            backoff = Math.min(backoff * 2, 30_000);
          }
        }
      } catch (err) {
        await push("error", svc.redact((err as Error).message));
      } finally {
        unsub();
        clearInterval(heartbeat);
      }
    });
  });

  app.get("/api/cluster/:env/apps/:app/pods/:pod", async (c) => {
    const e = env(c);
    if (!e) return c.json({ error: "bad env" }, 400);
    try {
      await svc.shownApp(e, c.req.param("app"));
      return c.json({ containers: await svc.client(e).podContainers(c.req.param("app"), c.req.param("pod")) });
    } catch (err) {
      return errorResponse(c, svc, err);
    }
  });

  app.get("/api/cluster/:env/apps/:app/logs", (c) => {
    const e = env(c);
    if (!e || !svc.clients.has(e)) return c.json({ error: "not configured" }, 404);
    const name = c.req.param("app");
    const pod = c.req.query("pod") || undefined;
    const container = c.req.query("container") || undefined;
    const previous = c.req.query("previous") === "1";
    const tail = Math.min(5000, Math.max(1, Number(c.req.query("tail") ?? 500) || 500));
    if (pod && !/^[a-z0-9.-]+$/.test(pod)) return c.json({ error: "bad pod name" }, 400);
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      const heartbeat = setInterval(() => stream.writeSSE({ event: "ping", data: "" }).catch(() => {}), 25_000);
      // Batch lines so a 500-line backlog is a few messages, not 500.
      let batch: { pod: string; ts: string | null; text: string }[] = [];
      let flushTimer: NodeJS.Timeout | null = null;
      const flush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        if (!batch.length) return;
        const data = JSON.stringify(batch);
        batch = [];
        stream.writeSSE({ event: "lines", data }).catch(() => {});
      };
      try {
        const a = await svc.shownApp(e, name);
        const group = toClusterApp(a, null)!.group;
        if (!pod && group !== "svc") throw new ArgoError("Pick a pod: job apps have no Deployment to stream from.", 400);
        await svc.client(e).logs(
          name,
          { pod, deployment: pod ? undefined : `cloudspot-${name}`, container, previous, tail },
          (l) => {
            if (l.last) return;
            batch.push({ pod: l.podName ?? pod ?? "", ts: l.timeStamp ?? null, text: l.content ?? "" });
            if (batch.length >= 200) flush();
            else flushTimer ??= setTimeout(flush, 100);
          },
          abort.signal,
        );
        flush();
        if (!abort.signal.aborted) await stream.writeSSE({ event: "end", data: JSON.stringify({ previous }) });
      } catch (err) {
        flush();
        const ae = err as ArgoError;
        const gone = ae.status === 404 || /not found/i.test(ae.message);
        await stream
          .writeSSE({
            event: gone ? "end" : "fail",
            data: JSON.stringify(gone ? { gone: true, message: "Pod no longer exists." } : { status: ae.status ?? 500, message: svc.redact(ae.message) }),
          })
          .catch(() => {});
      } finally {
        if (flushTimer) clearTimeout(flushTimer);
        clearInterval(heartbeat);
      }
    });
  });

  app.post("/api/cluster/:env/apps/:app/preview", async (c) => {
    const e = env(c);
    if (!e) return c.json({ error: "bad env" }, 400);
    try {
      return c.json(await svc.preview(e, c.req.param("app")));
    } catch (err) {
      return errorResponse(c, svc, err);
    }
  });

  app.post("/api/cluster/:env/apps/:app/sync", async (c) => {
    const e = env(c);
    if (!e) return c.json({ error: "bad env" }, 400);
    const body = await c.req.json<{ previewId?: unknown }>().catch(() => ({ previewId: undefined }));
    try {
      const r = await svc.sync(e, c.req.param("app"), body.previewId);
      return c.json(r.body, r.status as 200);
    } catch (err) {
      return errorResponse(c, svc, err);
    }
  });

  app.get("/api/cluster/:env/apps/:app/restart-plan", async (c) => {
    const e = env(c);
    if (!e) return c.json({ error: "bad env" }, 400);
    try {
      return c.json(await svc.restartPlan(e, c.req.param("app")));
    } catch (err) {
      return errorResponse(c, svc, err);
    }
  });

  app.post("/api/cluster/:env/apps/:app/restart", async (c) => {
    const e = env(c);
    if (!e) return c.json({ error: "bad env" }, 400);
    const body = await c.req.json().catch(() => ({}));
    try {
      const r = await svc.restart(e, c.req.param("app"), body);
      return c.json(r.body, r.status as 200);
    } catch (err) {
      return errorResponse(c, svc, err);
    }
  });

  app.get("/api/cluster/runs/:id/targets", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: "bad run id" }, 400);
    try {
      const r = await svc.deployTargets(id);
      return r ? c.json(r) : c.json({ error: "not one of your runs" }, 404);
    } catch (err) {
      return errorResponse(c, svc, err);
    }
  });
}
