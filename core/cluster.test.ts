import { describe, expect, it } from "vitest";
import {
  appGroup,
  type ArgoApp,
  type ArgoTree,
  buildDiff,
  checkPreview,
  checkRestartConfirm,
  deployState,
  filterLines,
  formatAge,
  infraRevision,
  lineDiff,
  parseImage,
  parseK8sTargets,
  PREVIEW_TTL_MS,
  redact,
  sortApps,
  syncRevisions,
  toClusterApp,
  toTree,
} from "./cluster.ts";

const SHA_A = "f8f6d60aa1b2c3d4e5f60718293a4b5c6d7e8f90";
const SHA_B = "0d2c77e5b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6";
const INFRA = "7d3e1a0aa1b2c3d4e5f60718293a4b5c6d7e8f91";
const img = (svc: string, tag: string) => `registry.digitalocean.com/cloudspot/${svc}:${tag}`;

function app(name: string, set: string | null, status: ArgoApp["status"] = {}): ArgoApp {
  return {
    metadata: { name, ownerReferences: set ? [{ kind: "ApplicationSet", name: set }] : undefined },
    status: { sync: { status: "Synced", revisions: ["69.2.0", INFRA] }, health: { status: "Healthy" }, ...status },
  };
}

function pod(name: string, image: string, opts: { status?: string; containers?: string; restarts?: number; createdAt?: string } = {}) {
  return {
    kind: "Pod",
    name,
    namespace: "default",
    createdAt: opts.createdAt ?? "2026-11-19T10:00:00Z",
    images: [image, "docker.io/datadog/agent:7"],
    health: { status: opts.status === "Running" || !opts.status ? "Healthy" : "Degraded" },
    parentRefs: [{ kind: "ReplicaSet", name: "rs" }],
    info: [
      { name: "Status Reason", value: opts.status ?? "Running" },
      { name: "Containers", value: opts.containers ?? "1/1" },
      ...(opts.restarts != null ? [{ name: "Restart Count", value: String(opts.restarts) }] : []),
    ],
  };
}

describe("parseImage", () => {
  it("splits service and full SHA", () => {
    expect(parseImage(img("api-server", SHA_A))).toEqual({ service: "api-server", sha: SHA_A, tag: SHA_A });
  });
  it("returns sha null for non-SHA tags", () => {
    expect(parseImage(img("api-server", "v1.2.3")).sha).toBeNull();
    expect(parseImage(img("api-server", SHA_A.slice(0, 7))).sha).toBeNull();
    expect(parseImage(img("api-server", SHA_A.toUpperCase())).sha).toBeNull();
  });
  it("handles registry ports and digests", () => {
    expect(parseImage(`localhost:5000/x/mailer:${SHA_B}`)).toMatchObject({ service: "mailer", sha: SHA_B });
    expect(parseImage(`r.io/x/mailer@sha256:abc`)).toMatchObject({ service: "mailer", tag: "latest" });
  });
});

describe("which apps are shown", () => {
  it("keeps svc and job ApplicationSet apps only", () => {
    expect(appGroup(app("api-server", "svc"))).toBe("svc");
    expect(appGroup(app("purge", "job"))).toBe("job");
    expect(appGroup(app("argocd", null))).toBeNull();
    expect(appGroup(app("loki", "monitoring"))).toBeNull();
  });
  it("finds the infrastructure commit in a multi-source app", () => {
    expect(infraRevision(app("a", "svc"))).toBe(INFRA);
    expect(syncRevisions(app("a", "svc"))).toEqual(["69.2.0", INFRA]);
    expect(infraRevision(app("a", "svc", { sync: { revision: INFRA } }))).toBe(INFRA);
  });
});

describe("toClusterApp", () => {
  const prs: Record<string, { number: number; title: string; htmlUrl: string }> = {
    [SHA_A]: { number: 7548, title: "greet", htmlUrl: "https://github.com/x/pull/7548" },
  };
  const prOf = (s: string) => prs[s] ?? null;

  it("maps a healthy app with its pods and PR", () => {
    const tree: ArgoTree = {
      nodes: [
        { kind: "Deployment", group: "apps", name: "cloudspot-api-server" },
        pod("cloudspot-api-server-1", img("api-server", SHA_A)),
        pod("cloudspot-api-server-2", img("api-server", SHA_A), { restarts: 2 }),
      ],
    };
    const a = toClusterApp(app("api-server", "svc"), tree, prOf)!;
    expect(a).toMatchObject({ name: "api-server", group: "svc", sync: "Synced", health: "Healthy", revision: INFRA });
    expect(a.pods).toEqual({ ready: 2, total: 2, restarts: 2 });
    expect(a.image).toMatchObject({ service: "api-server", sha: SHA_A, mixed: false, pr: { number: 7548 } });
    expect(a.problem).toContain("2 restarts");
  });

  it("marks a rollout as mixed and uses the newest pod's image", () => {
    const tree: ArgoTree = {
      nodes: [
        pod("old", img("api-server", SHA_B), { createdAt: "2026-11-19T09:00:00Z" }),
        pod("new", img("api-server", SHA_A), { createdAt: "2026-11-19T10:00:00Z", containers: "0/1", status: "ContainerCreating" }),
      ],
    };
    const a = toClusterApp(app("api-server", "svc"), tree)!;
    expect(a.image).toMatchObject({ sha: SHA_A, mixed: true });
    expect(a.pods).toMatchObject({ ready: 1, total: 2 });
    expect(a.problem).toContain("ContainerCreating");
  });

  it("doesn't count finished Job pods and falls back to summary images", () => {
    const tree: ArgoTree = { nodes: [pod("done", img("purge", SHA_A), { status: "Completed", containers: "0/1" })] };
    expect(toClusterApp(app("purge", "job"), tree)!.pods).toEqual({ ready: 0, total: 0, restarts: 0 });
    const noTree = toClusterApp(app("purge", "job", { summary: { images: [img("purge", SHA_B)] } }), null)!;
    expect(noTree.pods).toBeNull();
    expect(noTree.image?.sha).toBe(SHA_B);
  });

  it("hides other apps and normalises unknown statuses", () => {
    expect(toClusterApp(app("argocd", null), null)).toBeNull();
    const a = toClusterApp(app("x", "svc", { sync: { status: "Weird" }, health: { status: "???" } }), null)!;
    expect([a.sync, a.health]).toEqual(["Unknown", "Unknown"]);
  });

  it("toTree finds the deployment and distinct SHAs", () => {
    const t = toTree("api-server", {
      nodes: [
        { kind: "Deployment", group: "apps", name: "cloudspot-api-server" },
        pod("a", img("api-server", SHA_A)),
        pod("b", img("api-server", SHA_A)),
      ],
    });
    expect(t.deployment).toEqual({ name: "cloudspot-api-server", kind: "Deployment" });
    expect(t.shas).toEqual([SHA_A]);
    expect(t.pods[0]!.image?.service).toBe("api-server");
  });
});

describe("age", () => {
  it("uses the newest pod and formats like k9s", () => {
    const tree: ArgoTree = {
      nodes: [
        pod("old", img("x", SHA_A), { createdAt: "2026-11-19T08:00:00Z" }),
        pod("new", img("x", SHA_A), { createdAt: "2026-11-19T10:00:00Z" }),
      ],
    };
    expect(toClusterApp(app("x", "svc"), tree)!.newestPodAt).toBe("2026-11-19T10:00:00Z");
    expect(toClusterApp(app("x", "svc"), null)!.newestPodAt).toBeNull();
    const now = Date.parse("2026-11-19T10:00:00Z");
    expect([0, 59, 60, 3599, 3600, 86_399, 86_400 * 3].map((s) => formatAge(new Date(now - s * 1000).toISOString(), now))).toEqual([
      "0s", "59s", "1m", "59m", "1h", "23h", "3d",
    ]);
    expect(formatAge(null, now)).toBe("—");
  });
});

describe("sortApps", () => {
  it("puts problems first, then by name", () => {
    const tree = (s: string) => ({ nodes: [pod("p", img("x", SHA_A), { status: s, containers: s === "Running" ? "1/1" : "0/1" })] });
    const apps = [
      toClusterApp(app("b-ok", "svc"), tree("Running"))!,
      toClusterApp(app("a-ok", "svc"), tree("Running"))!,
      toClusterApp(app("c-drift", "svc", { sync: { status: "OutOfSync" } }), tree("Running"))!,
      toClusterApp(app("d-bad", "svc", { health: { status: "Degraded" } }), tree("CrashLoopBackOff"))!,
    ];
    expect(sortApps(apps).map((a) => a.name)).toEqual(["d-bad", "c-drift", "a-ok", "b-ok"]);
  });
});

describe("filterLines", () => {
  const lines = ["GET /health 200", "POST /email 500 error", "worker: ERROR timeout", "GET /users 200"].map((text) => ({ text }));
  const t = (rules: Parameters<typeof filterLines>[1]) => filterLines(lines, rules).map((l) => l.text);

  it("shows everything with no rules", () => expect(t([])).toHaveLength(4));
  it("include matches any include rule, ignoring case", () => {
    expect(t([{ mode: "include", text: "error", regex: false }])).toEqual(["POST /email 500 error", "worker: ERROR timeout"]);
  });
  it("exclude wins over include", () => {
    expect(
      t([
        { mode: "include", text: "error", regex: false },
        { mode: "exclude", text: "worker", regex: false },
      ]),
    ).toEqual(["POST /email 500 error"]);
  });
  it("exclude only", () => expect(t([{ mode: "exclude", text: "/health", regex: false }])).toHaveLength(3));
  it("regex rules, and invalid regex is ignored", () => {
    expect(t([{ mode: "include", text: "\\s5\\d\\d\\b", regex: true }])).toEqual(["POST /email 500 error"]);
    expect(t([{ mode: "include", text: "([", regex: true }])).toHaveLength(4);
  });
});

describe("parseK8sTargets", () => {
  it("reads svc and job targets", () => {
    const env = `SERVICE=api\nK8S_TARGETS=(svc/api-server job/user-purge "svc/admin-bff")\nOTHER=1`;
    expect(parseK8sTargets(env)).toEqual([
      { kind: "svc", app: "api-server" },
      { kind: "job", app: "user-purge" },
      { kind: "svc", app: "admin-bff" },
    ]);
  });
  it("returns nothing without the variable", () => expect(parseK8sTargets("K8S=1")).toEqual([]));
});

describe("deployState", () => {
  const later = (s: string) => (s === SHA_B ? true : undefined);
  it("live, rolling, replaced, waiting", () => {
    expect(deployState(SHA_A, [SHA_A, SHA_A], later).state).toBe("live");
    expect(deployState(SHA_A, [SHA_A, SHA_B], later)).toEqual({ state: "rolling", note: "1 of 2 pods" });
    expect(deployState(SHA_A, [SHA_B], later).state).toBe("replaced");
    expect(deployState(SHA_A, [INFRA], () => false).state).toBe("waiting");
    expect(deployState(SHA_A, [INFRA], () => undefined).state).toBe("waiting");
    expect(deployState(SHA_A, [null], later).state).toBe("unknown");
  });
});

describe("write guards", () => {
  const p = { env: "prd", app: "mailer", revisions: ["69.2.0", INFRA], createdAtMs: 1_000 };
  it("accepts a fresh, unchanged preview", () => expect(checkPreview(p, "prd", "mailer", ["69.2.0", INFRA], 2_000)).toBeNull());
  it("rejects moved git, expiry, and mismatched app", () => {
    expect(checkPreview(p, "prd", "mailer", ["69.2.0", SHA_A], 2_000)).toMatch(/Git moved/);
    expect(checkPreview(p, "prd", "mailer", ["69.2.0", INFRA], 1_000 + PREVIEW_TTL_MS + 1)).toMatch(/expired/);
    expect(checkPreview(p, "prd", "api-server", ["69.2.0", INFRA], 2_000)).toMatch(/Unknown/);
    expect(checkPreview(undefined, "prd", "mailer", [], 2_000)).toMatch(/Unknown/);
  });
  it("prod restart needs the app name", () => {
    expect(checkRestartConfirm("prd", "users", { confirm: "users" })).toBeNull();
    expect(checkRestartConfirm("prd", "users", { confirm: "mailer" })).not.toBeNull();
    expect(checkRestartConfirm("prd", "users", {})).not.toBeNull();
    expect(checkRestartConfirm("stg", "users", {})).toBeNull();
  });
});

describe("diff", () => {
  const deploy = (tag: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      kind: "Deployment",
      metadata: { name: "cloudspot-mailer", resourceVersion: "9", managedFields: [{}] },
      spec: { replicas: 2, template: { spec: { containers: [{ name: "mailer", image: img("mailer", tag) }] } } },
      status: { readyReplicas: 2 },
      ...extra,
    });

  it("lineDiff shows only changed lines with context", () => {
    const d = lineDiff({ a: 1, b: 2, c: 3 }, { a: 1, b: 9, c: 3 }, 0);
    expect(d).toContain('-   "b": 2,');
    expect(d).toContain('+   "b": 9,');
    expect(d).not.toContain('"a"');
  });

  it("buildDiff reports image changes and ignores server-set fields", () => {
    const { resources, images } = buildDiff(
      [
        { kind: "Deployment", name: "cloudspot-mailer", liveState: deploy(SHA_B), targetState: deploy(SHA_A) },
        { kind: "Service", name: "same", liveState: deploy(SHA_A), targetState: deploy(SHA_A, { status: {} }) },
      ],
      (r) => (r.kind === "Deployment" ? "OutOfSync" : "Synced"),
      (s) => (s === SHA_A ? { number: 1, title: "t", htmlUrl: "u" } : null),
    );
    expect(resources).toHaveLength(1);
    expect(resources[0]!.patch).not.toContain("resourceVersion");
    expect(images).toEqual([
      expect.objectContaining({ container: "mailer", from: expect.objectContaining({ sha: SHA_B, pr: null }), to: expect.objectContaining({ sha: SHA_A, pr: { number: 1, title: "t", htmlUrl: "u" } }) }),
    ]);
  });

  it("buildDiff reports missing resources", () => {
    const { resources } = buildDiff([{ kind: "ConfigMap", name: "new", targetState: JSON.stringify({ kind: "ConfigMap", data: { a: "1" } }) }], () => "OutOfSync");
    expect(resources[0]!.status).toBe("Missing");
  });
});

describe("redact", () => {
  it("removes every secret occurrence", () => {
    expect(redact("token abcd1234 and abcd1234 cf xyz9", ["abcd1234", "xyz9", undefined, ""])).toBe(
      "token [redacted] and [redacted] cf [redacted]",
    );
  });
});
