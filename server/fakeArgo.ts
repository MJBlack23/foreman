// A small stand-in for the Argo CD API, for tests and for trying the Cluster
// page without a cluster: `pnpm fake-argo`, then start the dashboard with
// ARGO_STG_URL=http://127.0.0.1:7899 ARGO_STG_TOKEN=fake-token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ArgoApp, ArgoNode } from "../core/cluster.ts";

export const FAKE_TOKEN = "fake-token";
const SHA_OLD = "0d2c77e5b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6";
const SHA_NEW = "4b19c25e07a1b2c3d4e5f60718293a4b5c6d7e8f";
const INFRA_1 = "7d3e1a0aa1b2c3d4e5f60718293a4b5c6d7e8f91";
const INFRA_2 = "9a8b7c6d5e4f30211a2b3c4d5e6f708192a3b4c5";
const img = (svc: string, sha: string) => `registry.digitalocean.com/cloudspot/${svc}:${sha}`;

interface FakeState {
  apps: ArgoApp[];
  trees: Record<string, ArgoNode[]>;
  syncs: { app: string; body: unknown }[];
  restarts: { app: string; query: string; body: unknown }[];
  /** Set to make the next refresh move git. */
  moveGitOnRefresh: boolean;
}

function app(name: string, set: string | null, health = "Healthy", sync = "Synced", images: string[] = []): ArgoApp {
  return {
    metadata: { name, ownerReferences: set ? [{ kind: "ApplicationSet", name: set }] : [] },
    status: {
      sync: { status: sync, revisions: ["69.2.0", INFRA_1] },
      health: { status: health },
      operationState: { phase: "Succeeded", startedAt: new Date(Date.now() - 3_600_000).toISOString() },
      summary: { images },
      resources: [{ kind: "Deployment", group: "apps", name: `cloudspot-${name}`, namespace: "default", status: sync }],
    },
  };
}

function pod(app: string, suffix: string, sha: string, opts: { status?: string; ready?: string; restarts?: number; ageMin?: number } = {}): ArgoNode {
  return {
    kind: "Pod",
    name: `cloudspot-${app}-6b8d4-${suffix}`,
    namespace: "default",
    createdAt: new Date(Date.now() - (opts.ageMin ?? 90) * 60_000).toISOString(),
    images: [img(app, sha)],
    health: { status: (opts.status ?? "Running") === "Running" ? "Healthy" : "Degraded" },
    parentRefs: [{ kind: "ReplicaSet", name: `cloudspot-${app}-6b8d4` }],
    info: [
      { name: "Status Reason", value: opts.status ?? "Running" },
      { name: "Containers", value: opts.ready ?? "1/1" },
      { name: "Restart Count", value: String(opts.restarts ?? 0) },
    ],
  };
}

const deploy = (app: string): ArgoNode => ({ kind: "Deployment", group: "apps", name: `cloudspot-${app}`, namespace: "default" });

export function initialState(): FakeState {
  return {
    apps: [
      app("api-server", "svc", "Healthy", "Synced", [img("api-server", SHA_NEW)]),
      app("mailer", "svc", "Healthy", "OutOfSync", [img("mailer", SHA_OLD)]),
      app("users", "svc", "Degraded", "Synced", [img("users", SHA_OLD)]),
      app("admin-bff", "svc", "Progressing", "Synced", [img("admin-bff", SHA_OLD), img("admin-bff", SHA_NEW)]),
      app("user-purge", "job", "Healthy", "Synced", [img("user-purge", SHA_NEW)]),
      app("argocd", null),
      app("loki", "monitoring"),
    ],
    trees: {
      "api-server": [deploy("api-server"), pod("api-server", "a1b2c", SHA_NEW), pod("api-server", "d3e4f", SHA_NEW, { restarts: 1 })],
      mailer: [deploy("mailer"), pod("mailer", "x9y8z", SHA_OLD)],
      users: [deploy("users"), pod("users", "r7tjm", SHA_OLD, { status: "CrashLoopBackOff", ready: "0/1", restarts: 7 }), pod("users", "k2wqs", SHA_OLD)],
      "admin-bff": [
        deploy("admin-bff"),
        pod("admin-bff", "n3w01", SHA_NEW, { ageMin: 2 }),
        pod("admin-bff", "n3w02", SHA_NEW, { ageMin: 1, status: "ContainerCreating", ready: "0/1" }),
        pod("admin-bff", "o1d01", SHA_OLD),
      ],
      "user-purge": [{ kind: "CronJob", group: "batch", name: "cloudspot-user-purge", namespace: "default" }],
    },
    syncs: [],
    restarts: [],
    moveGitOnRefresh: false,
  };
}

const LOG_SAMPLES = [
  "GET /health 200 1ms",
  "POST /internal/email 202 41ms",
  "worker: processed job 8812 in 120ms",
  "WARN slow query users.find 830ms",
  "ERROR connect ECONNREFUSED 10.0.3.4:6379",
  "GET /v1/users/me 200 12ms",
];

export interface FakeArgo {
  url: string;
  state: FakeState;
  close: () => Promise<void>;
}

export function startFakeArgo(port = 0, opts: { requireCf?: boolean; cfPolicyAllows?: boolean } = {}): Promise<FakeArgo> {
  const state = initialState();
  const sse = (res: ServerResponse) => res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (res: ServerResponse, result: unknown) => res.write(`data: ${JSON.stringify({ result })}\n\n`);
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const body = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(s || "null"));
        } catch {
          resolve(s);
        }
      });
    });

  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const p = u.pathname;
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) return json(res, 401, { error: "invalid session", message: "invalid session: token is invalid" });
    if (opts.requireCf && (req.headers["cf-access-client-id"] !== "cf-id" || !opts.cfPolicyAllows)) {
      const recognised = req.headers["cf-access-client-id"] === "cf-id";
      const claims = Buffer.from(JSON.stringify({ type: "meta", service_token_status: recognised })).toString("base64url");
      res.writeHead(302, { location: `https://cloudspot.cloudflareaccess.com/cdn-cgi/access/login/x?meta=e30.${claims}.sig` });
      return res.end();
    }
    const find = (name: string) => state.apps.find((a) => a.metadata.name === name);
    let m: RegExpMatchArray | null;

    if (p === "/api/version") return json(res, 200, { Version: "v3.0.6+fake" });
    if (p === "/api/v1/applications") return json(res, 200, { items: state.apps });
    if (p === "/api/v1/stream/applications") {
      sse(res);
      const t = setInterval(() => {
        const a = state.apps[0]!;
        a.status!.reconciledAt = new Date().toISOString();
        send(res, { type: "MODIFIED", application: a });
      }, 2000);
      req.on("close", () => clearInterval(t));
      return;
    }
    if ((m = p.match(/^\/api\/v1\/stream\/applications\/([^/]+)\/resource-tree$/))) {
      const name = decodeURIComponent(m[1]!);
      if (!find(name)) return json(res, 404, { error: "not found", message: `applications.argoproj.io "${name}" not found` });
      sse(res);
      send(res, { nodes: state.trees[name] ?? [] });
      const t = setInterval(() => send(res, { nodes: state.trees[name] ?? [] }), 3000);
      req.on("close", () => clearInterval(t));
      return;
    }
    if ((m = p.match(/^\/api\/v1\/applications\/([^/]+)(\/.*)?$/))) {
      const name = decodeURIComponent(m[1]!);
      const rest = m[2] ?? "";
      const a = find(name);
      if (!a) return json(res, 404, { error: "not found", message: `applications.argoproj.io "${name}" not found` });
      if (rest === "" && req.method === "GET") {
        if (u.searchParams.get("refresh") && state.moveGitOnRefresh) {
          a.status!.sync!.revisions = ["69.2.0", INFRA_2];
          state.moveGitOnRefresh = false;
        }
        return json(res, 200, a);
      }
      if (rest === "/resource-tree") return json(res, 200, { nodes: state.trees[name] ?? [] });
      if (rest === "/managed-resources") {
        const live = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: `cloudspot-${name}`, resourceVersion: "123" }, spec: { replicas: 2, template: { spec: { containers: [{ name, image: img(name, SHA_OLD) }] } } } };
        const target = { ...live, metadata: { name: `cloudspot-${name}` }, spec: { ...live.spec, template: { spec: { containers: [{ name, image: img(name, a.status?.sync?.status === "OutOfSync" ? SHA_NEW : SHA_OLD) }] } } } };
        return json(res, 200, { items: [{ kind: "Deployment", group: "apps", namespace: "default", name: `cloudspot-${name}`, liveState: JSON.stringify(live), targetState: JSON.stringify(target) }] });
      }
      if (rest === "/resource") {
        return json(res, 200, { manifest: JSON.stringify({ kind: "Pod", spec: { containers: [{ name }, { name: "datadog-agent" }] } }) });
      }
      if (rest === "/sync" && req.method === "POST") {
        state.syncs.push({ app: name, body: await body(req) });
        return json(res, 200, a);
      }
      if (rest === "/resource/actions" && req.method === "POST") {
        state.restarts.push({ app: name, query: u.search, body: await body(req) });
        return json(res, 200, {});
      }
      if (rest === "/logs") {
        sse(res);
        const podName = u.searchParams.get("podName") ?? `cloudspot-${name}-6b8d4-a1b2c`;
        const tail = Number(u.searchParams.get("tailLines") ?? 10);
        const prev = u.searchParams.get("previous") === "true";
        let i = 0;
        const line = () => {
          const text = prev ? `[previous] panic: redis unavailable (${i})` : LOG_SAMPLES[i % LOG_SAMPLES.length]!;
          i++;
          return { content: text, podName, timeStamp: new Date().toISOString() };
        };
        for (let k = 0; k < Math.min(tail, 30); k++) send(res, line());
        if (u.searchParams.get("follow") !== "true") {
          send(res, { last: true });
          return res.end();
        }
        const t = setInterval(() => send(res, line()), 700);
        req.on("close", () => clearInterval(t));
        return;
      }
    }
    json(res, 404, { error: "no route", message: `no fake route for ${req.method} ${p}` });
  });

  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        state,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    }),
  );
}

if (process.argv[1]?.endsWith("fakeArgo.ts")) {
  const port = Number(process.env.FAKE_ARGO_PORT ?? 7899);
  void startFakeArgo(port).then((f) => console.log(`Fake Argo on ${f.url} (token: ${FAKE_TOKEN})`));
}
