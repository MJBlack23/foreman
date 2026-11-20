import { existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { clusterRoutes, ClusterService, dashboardOrigins, macConfirm } from "./cluster.ts";
import { loadArgoConfig, loadConfig } from "./config.ts";
import { ghToken, GitHub } from "./github.ts";
import { sendNotification } from "./notify.ts";
import { Poller } from "./poller.ts";
import { PrefsStore } from "./prefs.ts";
import { SeenStore } from "./store.ts";

const config = loadConfig();
const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "web");
const dashboardUrl = `http://localhost:${config.port}`;
const gh = new GitHub(ghToken());
const store = new SeenStore(config.dataDir);
const prefs = new PrefsStore(config.dataDir);
const poller = new Poller(gh, store, prefs, (n) => sendNotification(n, config.sound), dashboardUrl);
const argoConfig = loadArgoConfig(config.dataDir);
const cluster = new ClusterService({
  config: argoConfig,
  gh,
  dataDir: config.dataDir,
  port: config.port,
  // The dashboard itself, and Vite's dev server (which proxies /api here).
  origins: dashboardOrigins(config.port, [Number(process.env.VITE_PORT ?? 5173)]),
  runInfo: (id) => poller.runInfo(id),
  // Prod writes also need a click in a native macOS dialog, so a local script can't make one alone.
  nativeConfirm: process.env.ARGO_NATIVE_CONFIRM === "0" ? undefined : macConfirm,
});

const app = new Hono();

// Local-only tool: refuse requests whose Host isn't loopback (DNS rebinding).
app.use("*", async (c, next) => {
  const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return c.text("Forbidden", 403);
  await next();
});

app.get("/api/state", (c) => c.json(poller.snapshot()));

app.get("/api/events", (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "snapshot", data: JSON.stringify(poller.snapshot()) });
    const unsubscribe = poller.subscribe((s) => {
      stream.writeSSE({ event: "snapshot", data: JSON.stringify(s) }).catch(() => {});
    });
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
    }, 25_000);
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        unsubscribe();
        clearInterval(heartbeat);
        resolve();
      });
    });
  }),
);

app.get("/api/runs/:id/jobs", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: "bad run id" }, 400);
  try {
    const payload = await poller.liveJobs(id);
    return payload ? c.json(payload) : c.json({ error: "not one of your runs" }, 404);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

app.post("/api/refresh", async (c) => {
  await poller.refreshNow();
  return c.json({ ok: true, lastError: poller.snapshot().lastError });
});

app.post("/api/prefs", async (c) => {
  const body = await c.req.json().catch(() => null);
  poller.setPrefs(body);
  return c.json(prefs.get());
});

app.post("/api/viewed", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({ ids: undefined }));
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
  store.markViewed(ids);
  poller.republish();
  return c.json({ ok: true });
});

clusterRoutes(app, cluster);

// The page polls this and reloads itself when `vite build --watch` writes a new build.
app.get("/api/build", (c) => {
  try {
    return c.json({ id: String(statSync(join(webDir, "index.html")).mtimeMs) });
  } catch {
    return c.json({ id: null });
  }
});

// Production: serve the Vite build. In dev, Vite serves the page and proxies /api.
if (existsSync(webDir)) {
  const root = relative(process.cwd(), webDir) || ".";
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ path: join(root, "index.html") }));
} else {
  app.get("/", (c) => c.text("No web build found. Run `pnpm build`, or use `pnpm dev` and open the Vite URL."));
}

serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, () => {
  console.log(`Foreman on ${dashboardUrl} (sound: ${config.sound === false ? "off" : config.sound})`);
  for (const e of cluster.info())
    console.log(`[argo:${e.id}] ${e.configured ? `using ${e.host}` : `not configured (missing ${e.missing.join(", ")})`}`);
  poller.start();
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    poller.stop();
    process.exit(0);
  });
}
