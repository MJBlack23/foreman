import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArgoClient, ArgoError } from "./argo.ts";
import { clusterRoutes, ClusterService, dashboardOrigins, originAllowed } from "./cluster.ts";
import { loadArgoConfig, parseEnvFile } from "./config.ts";
import { FAKE_TOKEN, type FakeArgo, startFakeArgo } from "./fakeArgo.ts";
import type { GitHub } from "./github.ts";

const CF_SECRET = "cf-secret-value-123";
const fakeGh = { get: async () => [] } as unknown as GitHub;

describe("Argo config", () => {
  it("parses env files", () => {
    expect(parseEnvFile(`# c\nA=1\nexport B="two words"\nC='x' \nD=v # note\nbad line`)).toEqual({ A: "1", B: "two words", C: "x", D: "v" });
  });

  it("reads the process env first, then argo.env, and treats empty as missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "argo-cfg-"));
    writeFileSync(join(dir, "argo.env"), "ARGO_STG_URL=https://stg.example\nARGO_STG_TOKEN=file-token\n");
    const c = loadArgoConfig(dir, { ARGO_PRD_URL: "https://prd.example/", ARGO_PRD_TOKEN: "env-token", ARGO_STG_TOKEN: "", CF_ACCESS_CLIENT_ID: "id" });
    expect(c.envs.prd.config).toMatchObject({ url: "https://prd.example", host: "prd.example", token: "env-token", cfClientId: "id", cfClientSecret: null });
    // Empty in the env doesn't hide the file's value…
    expect(c.envs.stg.config?.token).toBe("file-token");
    // …but empty everywhere is missing.
    const none = loadArgoConfig(mkdtempSync(join(tmpdir(), "argo-cfg-")), { ARGO_STG_URL: "https://s", ARGO_STG_TOKEN: " " });
    expect(none.envs.stg).toMatchObject({ config: null, missing: ["ARGO_STG_TOKEN"] });
    expect(none.envs.prd.missing).toEqual(["ARGO_PRD_URL", "ARGO_PRD_TOKEN"]);
  });

  it("refuses plain http except on loopback", () => {
    const c = loadArgoConfig(mkdtempSync(join(tmpdir(), "argo-cfg-")), { ARGO_PRD_URL: "http://argo.example", ARGO_PRD_TOKEN: "t" });
    expect(c.envs.prd.config).toBeNull();
    expect(c.envs.prd.missing[0]).toMatch(/https/);
  });
});

describe("origin guard", () => {
  const allowed = dashboardOrigins(7896, [5173]);
  it("accepts the dashboard's own JSON posts", () => {
    expect(originAllowed("http://localhost:7896", "application/json", allowed)).toBe(true);
    expect(originAllowed("http://127.0.0.1:5173", "application/json; charset=utf-8", allowed)).toBe(true);
  });
  it("rejects other origins, no origin, and form posts", () => {
    expect(originAllowed("https://evil.test", "application/json", allowed)).toBe(false);
    expect(originAllowed(undefined, "application/json", allowed)).toBe(false);
    expect(originAllowed("http://localhost:7896", "application/x-www-form-urlencoded", allowed)).toBe(false);
    expect(originAllowed("http://localhost:7897", "application/json", allowed)).toBe(false);
  });
});

describe("against a fake Argo", () => {
  let fake: FakeArgo;
  let dataDir: string;
  let svc: ClusterService;
  let app: Hono;
  let confirms: string[];

  beforeEach(async () => {
    fake = await startFakeArgo();
    dataDir = mkdtempSync(join(tmpdir(), "argo-data-"));
    confirms = [];
    const config = loadArgoConfig(dataDir, {
      ARGO_PRD_URL: fake.url,
      ARGO_PRD_TOKEN: FAKE_TOKEN,
      ARGO_STG_URL: fake.url,
      ARGO_STG_TOKEN: FAKE_TOKEN,
      CF_ACCESS_CLIENT_ID: "cf-id",
      CF_ACCESS_CLIENT_SECRET: CF_SECRET,
    });
    svc = new ClusterService({
      config,
      gh: fakeGh,
      dataDir,
      port: 7896,
      origins: dashboardOrigins(7896),
      runInfo: () => null,
      nativeConfirm: async (title) => (confirms.push(title), true),
    });
    app = new Hono();
    clusterRoutes(app, svc);
  });

  afterEach(async () => {
    await fake.close();
  });

  const post = (path: string, body: unknown, origin = "http://localhost:7896") =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });

  it("reports which envs are configured without leaking secrets", async () => {
    const res = await app.request("/api/cluster/config");
    const text = await res.text();
    expect(JSON.parse(text).envs.map((e: { configured: boolean }) => e.configured)).toEqual([true, true]);
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(CF_SECRET);
  });

  it("lists apps and reads a tree", async () => {
    const argo = svc.client("prd");
    expect((await argo.apps()).length).toBe(7);
    expect((await argo.tree("users")).nodes?.some((n) => n.kind === "Pod")).toBe(true);
  });

  it("explains a bad token and never echoes it", async () => {
    const bad = new ArgoClient("prd", { url: fake.url, host: "h", token: "wrong-token-abc", cfClientId: null, cfClientSecret: null }, ["wrong-token-abc"]);
    const err = (await bad.apps().catch((e) => e)) as ArgoError;
    expect(err).toBeInstanceOf(ArgoError);
    expect(err.message).toBe("Argo token for prd is invalid or expired");
  });

  it("says why Cloudflare Access refused", async () => {
    const cf = await startFakeArgo(0, { requireCf: true });
    const client = (id: string | null) =>
      new ArgoClient("prd", { url: cf.url, host: "argo.prd", token: FAKE_TOKEN, cfClientId: id, cfClientSecret: id && "s" }, []);
    await expect(client(null).apps()).rejects.toThrow(/no service token is set/);
    await expect(client("wrong-id").apps()).rejects.toThrow(/didn't accept the service token/);
    await expect(client("cf-id").apps()).rejects.toThrow(/no Service Auth policy/);
    await cf.close();
    const ok = await startFakeArgo(0, { requireCf: true, cfPolicyAllows: true });
    const good = new ArgoClient("prd", { url: ok.url, host: "argo.prd", token: FAKE_TOKEN, cfClientId: "cf-id", cfClientSecret: "s" }, []);
    expect((await good.apps()).length).toBe(7);
    await ok.close();
  });

  it("refuses POSTs from other origins", async () => {
    const res = await post("/api/cluster/prd/apps/mailer/preview", {}, "https://evil.test");
    expect(res.status).toBe(403);
    expect(fake.state.syncs).toHaveLength(0);
  });

  it("previews, then syncs exactly the previewed revisions", async () => {
    const preview = await (await post("/api/cluster/prd/apps/mailer/preview", {})).json();
    expect(preview.resources).toHaveLength(1);
    expect(preview.images[0].to.sha).toMatch(/^4b19c25e/);
    const res = await post("/api/cluster/prd/apps/mailer/sync", { previewId: preview.previewId });
    expect(res.status).toBe(200);
    expect(fake.state.syncs[0]!.body).toEqual({ revisions: ["69.2.0", preview.revision], sourcePositions: [1, 2], prune: true });
    expect(confirms).toEqual(["Sync mailer in PRODUCTION?"]);
    // A preview is single-use.
    expect((await post("/api/cluster/prd/apps/mailer/sync", { previewId: preview.previewId })).status).toBe(409);
    const log = readFileSync(join(dataDir, "cluster-actions.log"), "utf8");
    expect(log).toContain('"action":"sync"');
    expect(log).not.toContain(FAKE_TOKEN);
  });

  it("refuses a sync when git moved after the preview", async () => {
    const preview = await (await post("/api/cluster/prd/apps/mailer/preview", {})).json();
    // Git moves: the next GET with refresh returns a new revision.
    fake.state.apps.find((a) => a.metadata.name === "mailer")!.status!.sync!.revisions = ["69.2.0", "9a8b7c6d5e4f30211a2b3c4d5e6f708192a3b4c5"];
    const res = await post("/api/cluster/prd/apps/mailer/sync", { previewId: preview.previewId });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Git moved/);
    expect(fake.state.syncs).toHaveLength(0);
  });

  it("does nothing when the macOS confirmation is cancelled", async () => {
    svc.deps.nativeConfirm = async () => false;
    const preview = await (await post("/api/cluster/prd/apps/mailer/preview", {})).json();
    expect((await post("/api/cluster/prd/apps/mailer/sync", { previewId: preview.previewId })).status).toBe(409);
    expect(fake.state.syncs).toHaveLength(0);
  });

  it("prod restart needs the right app name; staging doesn't ask", async () => {
    expect((await post("/api/cluster/prd/apps/users/restart", { confirm: "mailer" })).status).toBe(400);
    expect(fake.state.restarts).toHaveLength(0);
    expect((await post("/api/cluster/prd/apps/users/restart", { confirm: "users" })).status).toBe(200);
    expect(fake.state.restarts[0]).toMatchObject({ app: "users", body: "restart" });
    expect(fake.state.restarts[0]!.query).toContain("resourceName=cloudspot-users");
    expect((await post("/api/cluster/stg/apps/users/restart", {})).status).toBe(200);
    expect(confirms).toEqual(["Restart users in PRODUCTION?"]);
  });

  it("hides apps through the API, from the dashboard's origin only", async () => {
    expect((await post("/api/cluster/hidden", { app: "mailer", hidden: true }, "https://evil.test")).status).toBe(403);
    const res = await post("/api/cluster/hidden", { app: "mailer", hidden: true });
    expect(await res.json()).toEqual({ hidden: ["mailer"] });
    expect(await (await app.request("/api/cluster/hidden")).json()).toEqual({ hidden: ["mailer"] });
    expect((await post("/api/cluster/hidden", { app: "mailer" })).status).toBe(400);
  });

  it("won't act on apps outside the svc and job sets", async () => {
    const res = await post("/api/cluster/prd/apps/argocd/restart", { confirm: "argocd" });
    expect(res.status).toBe(404);
    expect(fake.state.restarts).toHaveLength(0);
  });

  it("streams log lines", async () => {
    const res = await app.request("/api/cluster/prd/apps/users/logs?pod=cloudspot-users-6b8d4-r7tjm&previous=1&tail=5");
    const text = await res.text();
    expect(text).toContain("event: lines");
    expect(text).toContain("[previous] panic");
    expect(text).toContain("event: end");
  });
});

describe("hidden apps", () => {
  it("persists to a flat file and rejects odd names", async () => {
    const { HiddenAppsStore } = await import("./hiddenApps.ts");
    const dir = mkdtempSync(join(tmpdir(), "hidden-"));
    const a = new HiddenAppsStore(dir);
    expect(a.set("mailer", true)).toBe(true);
    expect(a.set("api-server", true)).toBe(true);
    expect(a.set("../etc", true)).toBe(false);
    a.set("mailer", false);
    expect(new HiddenAppsStore(dir).list()).toEqual(["api-server"]);
    expect(JSON.parse(readFileSync(join(dir, "cluster-hidden.json"), "utf8"))).toEqual({ hidden: ["api-server"] });
  });
});
