import { redact } from "../core/cluster.ts";
import type { ArgoApp, ArgoTree, ManagedResource } from "../core/cluster.ts";
import type { ArgoEnvConfig } from "./config.ts";

/** An Argo or Cloudflare failure, already turned into a message the page can show. Never holds a secret. */
export class ArgoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const enc = encodeURIComponent;

/** `service_token_status` from the `meta` JWT in a Cloudflare Access login redirect; undefined when absent. */
export function serviceTokenStatus(location: string | null): boolean | undefined {
  if (!location) return undefined;
  try {
    const meta = new URL(location).searchParams.get("meta");
    const payload = meta?.split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { service_token_status?: unknown };
    return typeof claims.service_token_status === "boolean" ? claims.service_token_status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One Argo CD API server behind Cloudflare Access. Sends the bearer token and
 * the Access service-token headers on every request. Secrets stay in this object.
 */
export class ArgoClient {
  constructor(
    readonly env: "prd" | "stg",
    private cfg: ArgoEnvConfig,
    private secrets: string[],
  ) {}

  get host() {
    return this.cfg.host;
  }

  get baseUrl() {
    return this.cfg.url;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.cfg.token}`, accept: "application/json", ...extra };
    if (this.cfg.cfClientId && this.cfg.cfClientSecret) {
      h["cf-access-client-id"] = this.cfg.cfClientId;
      h["cf-access-client-secret"] = this.cfg.cfClientSecret;
    }
    return h;
  }

  /** Map a non-OK response to a message for the page. */
  private async fail(res: Response, what: string): Promise<never> {
    const body = await res.text().catch(() => "");
    const cf =
      res.headers.get("cf-mitigated") ||
      (res.status >= 300 && res.status < 400 && /cloudflareaccess\.com/.test(res.headers.get("location") ?? "")) ||
      (res.status === 403 && /cloudflare/i.test(body) && !/permission denied/i.test(body));
    let message: string;
    if (cf) message = this.cloudflareMessage(res);
    else if (res.status === 401) message = `Argo token for ${this.env} is invalid or expired`;
    else if (res.status === 403 || /permission denied/i.test(body))
      message = `Argo account lacks permission: ${what}. Check the role:pr-dashboard lines in policy.csv.`;
    else {
      let detail = body.slice(0, 300);
      try {
        const j = JSON.parse(body) as { message?: string; error?: string };
        detail = j.message ?? j.error ?? detail;
      } catch {}
      message = `Argo ${what} failed (${res.status})${detail ? `: ${detail}` : ""}`;
    }
    throw new ArgoError(redact(message, this.secrets), cf ? 403 : res.status);
  }

  /**
   * Why Cloudflare Access turned us away. Its login redirect carries a `meta`
   * JWT whose payload says whether it recognised a service token
   * (`service_token_status`); only that flag is read.
   */
  cloudflareMessage(res: Response): string {
    const base = `Cloudflare Access rejected the request to ${this.host}`;
    if (!this.cfg.cfClientId || !this.cfg.cfClientSecret)
      return `${base}: no service token is set. Add CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.`;
    const status = serviceTokenStatus(res.headers.get("location"));
    if (status === true)
      return `${base}: it accepted the service token, but no Service Auth policy on that Access application allows it. Add a policy with action "Service Auth" that includes this token.`;
    if (status === false)
      return `${base}: it didn't accept the service token for this application. Either no policy with action "Service Auth" on the application includes the token, or the client ID or secret is wrong, revoked or expired.`;
    return `${base} (HTTP ${res.status}). Check the service token and the application's Service Auth policy.`;
  }

  private async request<T>(method: string, path: string, what: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.cfg.url + path, {
        method,
        headers: this.headers(body !== undefined ? { "content-type": "application/json" } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "manual",
        signal: signal ?? AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new ArgoError(redact(`Can't reach ${this.host}: ${(e as Error).message}`, this.secrets), 502);
    }
    if (!res.ok) await this.fail(res, what);
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Cloudflare redirects (handled above); a 200 HTML page is Argo's web UI, which it serves for unknown paths.
      throw new ArgoError(`${this.host} answered ${path.split("?")[0]} with a web page, not JSON. Check ARGO_${this.env.toUpperCase()}_URL points at the Argo server root.`, 502);
    }
  }

  version() {
    return this.request<{ Version?: string }>("GET", "/api/version", "version");
  }

  async apps(): Promise<ArgoApp[]> {
    const r = await this.request<{ items?: ArgoApp[] | null }>("GET", "/api/v1/applications?projects=default", "applications, get");
    return r.items ?? [];
  }

  app(name: string, refresh = false) {
    return this.request<ArgoApp>("GET", `/api/v1/applications/${enc(name)}${refresh ? "?refresh=normal" : ""}`, "applications, get");
  }

  tree(name: string) {
    return this.request<ArgoTree>("GET", `/api/v1/applications/${enc(name)}/resource-tree`, "applications, get");
  }

  async managedResources(name: string): Promise<ManagedResource[]> {
    const r = await this.request<{ items?: ManagedResource[] | null }>(
      "GET",
      `/api/v1/applications/${enc(name)}/managed-resources`,
      "applications, get",
    );
    return r.items ?? [];
  }

  /** A pod's manifest, for its container names. */
  async podContainers(app: string, pod: string): Promise<string[]> {
    const q = new URLSearchParams({ resourceName: pod, namespace: "default", version: "v1", kind: "Pod", group: "" });
    const r = await this.request<{ manifest?: string }>("GET", `/api/v1/applications/${enc(app)}/resource?${q}`, "applications, get");
    try {
      const m = JSON.parse(r.manifest ?? "{}") as { spec?: { containers?: { name: string }[] } };
      return (m.spec?.containers ?? []).map((c) => c.name);
    } catch {
      return [];
    }
  }

  /** Sync exactly these revisions (one per source, in order). */
  sync(name: string, revisions: string[]) {
    const body =
      revisions.length > 1
        ? { revisions, sourcePositions: revisions.map((_, i) => i + 1), prune: true }
        : { revision: revisions[0], prune: true };
    return this.request<ArgoApp>("POST", `/api/v1/applications/${enc(name)}/sync`, "applications, sync", body);
  }

  /** Run the built-in Deployment `restart` action. Tries the v1 route, then the v2 one newer servers use. */
  async restart(app: string, deployment: string): Promise<void> {
    const q = new URLSearchParams({ namespace: "default", resourceName: deployment, kind: "Deployment", group: "apps", version: "v1" });
    const what = "applications, action/apps/Deployment/restart";
    try {
      await this.request("POST", `/api/v1/applications/${enc(app)}/resource/actions?${q}`, what, "restart");
    } catch (e) {
      if (!(e instanceof ArgoError) || ![404, 405, 501].includes(e.status)) throw e;
      await this.request("POST", `/api/v1/applications/${enc(app)}/resource/actions/v2`, what, {
        name: app,
        namespace: "default",
        resourceName: deployment,
        kind: "Deployment",
        group: "apps",
        version: "v1",
        action: "restart",
      });
    }
  }

  /**
   * Read one of Argo's streaming endpoints. Each message is `{"result": …}`,
   * either as SSE `data:` lines or as newline-delimited JSON. Resolves when the
   * stream ends; rejects with ArgoError on a bad status or `{"error": …}`.
   */
  async stream(path: string, what: string, onResult: (r: unknown) => void, signal: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.cfg.url + path, {
        headers: this.headers({ accept: "text/event-stream" }),
        redirect: "manual",
        signal,
      });
    } catch (e) {
      if (signal.aborted) return;
      throw new ArgoError(redact(`Can't reach ${this.host}: ${(e as Error).message}`, this.secrets), 502);
    }
    if (!res.ok || !res.body) await this.fail(res, what);
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/html"))
      throw new ArgoError(`${this.host} answered ${path.split("?")[0]} with a web page, not a stream. Check ARGO_${this.env.toUpperCase()}_URL.`, 502);

    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    const handle = (line: string) => {
      const raw = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
      if (!raw || raw.startsWith(":") || line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) return;
      let msg: { result?: unknown; error?: { message?: string; http_code?: number; code?: number } };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.error) {
        const status = msg.error.http_code ?? (msg.error.code === 7 ? 403 : msg.error.code === 16 ? 401 : msg.error.code === 5 ? 404 : 500);
        throw new ArgoError(redact(`Argo ${what}: ${msg.error.message ?? "stream error"}`, this.secrets), status);
      }
      if (msg.result !== undefined) onResult(msg.result);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          handle(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      if (buf) handle(buf);
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ArgoError) throw e;
      throw new ArgoError(redact(`Stream from ${this.host} dropped: ${(e as Error).message}`, this.secrets), 502);
    } finally {
      reader.releaseLock?.();
    }
  }

  watchApps(onEvent: (e: { type: string; application: ArgoApp }) => void, signal: AbortSignal) {
    return this.stream("/api/v1/stream/applications?projects=default", "applications, get", (r) => onEvent(r as never), signal);
  }

  watchTree(app: string, onTree: (t: ArgoTree) => void, signal: AbortSignal) {
    return this.stream(`/api/v1/stream/applications/${enc(app)}/resource-tree`, "applications, get", (r) => onTree(r as ArgoTree), signal);
  }

  logs(
    app: string,
    opts: { pod?: string; deployment?: string; container?: string; previous: boolean; tail: number },
    onLine: (l: { content?: string; timeStamp?: string; podName?: string; last?: boolean }) => void,
    signal: AbortSignal,
  ) {
    const q = new URLSearchParams({ namespace: "default", tailLines: String(opts.tail), follow: String(!opts.previous) });
    if (opts.previous) q.set("previous", "true");
    if (opts.container) q.set("container", opts.container);
    if (opts.pod) q.set("podName", opts.pod);
    else if (opts.deployment) {
      q.set("kind", "Deployment");
      q.set("group", "apps");
      q.set("resourceName", opts.deployment);
    }
    return this.stream(`/api/v1/applications/${enc(app)}/logs?${q}`, "logs, get", (r) => onLine(r as never), signal);
  }
}
