import { describe, expect, it } from "vitest";
import {
  deployAlerts,
  type Deployment,
  downSince,
  type HealthCheck,
  healthAlerts,
  healthState,
  nextStatusDelay,
  overall,
  parseStatus,
  STATUS_DEPLOYING_EVERY_MS,
  STATUS_EVERY_MS,
  type StatusPoll,
  tickResult,
  uptimeStrip,
} from "./nightShift.ts";

const T0 = Date.parse("2026-11-20T12:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ok = (min: number): HealthCheck => ({ at: at(min), ok: true, status: 200, ms: 80, error: null });
const fail = (min: number, status: number | null = 503): HealthCheck => ({
  at: at(min),
  ok: false,
  status,
  ms: status ? 50 : null,
  error: status ? null : "timed out",
});
const dep = (id: string, phase: string): Deployment => ({ id, phase, cause: "commit abc pushed", commit: "abc1234def", createdAt: at(0), updatedAt: at(1) });
const poll = (active: Deployment | null, latest: Deployment | null): StatusPoll => ({ at: at(0), ok: true, error: null, active, latest, lastActiveAt: at(0) });

describe("healthState", () => {
  it("is unknown with no checks", () => expect(healthState([])).toBe("unknown"));
  it("stays up after a single failure", () => expect(healthState([ok(0), fail(10)])).toBe("up"));
  it("is down after two failures in a row", () => {
    const checks = [ok(0), fail(10), fail(20)];
    expect(healthState(checks)).toBe("down");
    expect(downSince(checks)).toBe(at(10));
  });
  it("recovers on the next pass", () => expect(healthState([fail(0), fail(10), ok(20)])).toBe("up"));
});

describe("healthAlerts", () => {
  it("alerts once when health goes down, with a stable id", () => {
    const a = healthAlerts([ok(0), fail(10)], [ok(0), fail(10), fail(20)]);
    expect(a).toHaveLength(1);
    expect(a[0]!.id).toBe(`night-shift:down:${at(10)}`);
    expect(a[0]!.message).toContain("HTTP 503");
  });
  it("doesn't alert again while it stays down", () => {
    expect(healthAlerts([fail(0), fail(10)], [fail(0), fail(10), fail(20)])).toEqual([]);
  });
  it("alerts when it comes back up", () => {
    const a = healthAlerts([fail(0), fail(10)], [fail(0), fail(10), ok(20)]);
    expect(a.map((x) => x.title)).toEqual(["Night Shift is back up"]);
  });
  it("doesn't alert on a first pass or a single blip", () => {
    expect(healthAlerts([], [ok(0)])).toEqual([]);
    expect(healthAlerts([ok(0)], [ok(0), fail(10)])).toEqual([]);
  });
});

describe("deployments", () => {
  it("flags a failed latest deployment that never went live", () => {
    const s = poll(dep("a", "ACTIVE"), dep("b", "ERROR"));
    expect(overall("up", s)).toBe("bad");
    expect(deployAlerts(s).map((x) => x.id)).toEqual(["night-shift:deploy-error:b"]);
  });
  it("is deploying while the latest is building, and polls every minute", () => {
    const s = poll(dep("a", "ACTIVE"), dep("b", "BUILDING"));
    expect(overall("up", s)).toBe("deploying");
    expect(nextStatusDelay(s)).toBe(STATUS_DEPLOYING_EVERY_MS);
  });
  it("is ok when the latest is the active one", () => {
    const s = poll(dep("a", "ACTIVE"), dep("a", "ACTIVE"));
    expect(overall("up", s)).toBe("ok");
    expect(nextStatusDelay(s)).toBe(STATUS_EVERY_MS);
    expect(deployAlerts(s)).toEqual([]);
  });
  it("down health beats a deploy in progress", () => expect(overall("down", poll(null, dep("b", "DEPLOYING")))).toBe("bad"));
});

describe("uptimeStrip", () => {
  it("buckets the last 24 hours in 10-minute cells, with gaps as none", () => {
    const now = T0 + 30 * 60_000;
    const { cells, pct } = uptimeStrip([ok(0), fail(10), ok(25), ok(-60 * 25)], now);
    expect(cells).toHaveLength(144);
    expect(cells.slice(-3)).toEqual(["up", "down", "up"]);
    expect(cells.slice(0, 141).every((c) => c === "none")).toBe(true);
    expect(pct).toBeCloseTo(66.67, 1);
  });
  it("has no percentage without data", () => expect(uptimeStrip([], T0).pct).toBeNull());
});

describe("parseStatus", () => {
  it("reads the active and latest deployments from the DigitalOcean API", () => {
    const s = parseStatus(
      {
        active_deployment: { id: "a", phase: "ACTIVE", cause: "commit pushed", services: [{ name: "night-shift", source_commit_hash: "deadbeef" }] },
        last_deployment_active_at: at(0),
      },
      [{ id: "b", phase: "ERROR", created_at: at(5) }],
      at(10),
    );
    expect(s.active).toMatchObject({ id: "a", phase: "ACTIVE", commit: "deadbeef" });
    expect(s.latest).toMatchObject({ id: "b", phase: "ERROR", commit: null, createdAt: at(5) });
    expect(s.lastActiveAt).toBe(at(0));
  });
});

describe("tickResult", () => {
  it("maps night-shift's replies", () => {
    expect(tickResult(202)).toBe("started");
    expect(tickResult(409)).toBe("already-running");
    expect(tickResult(401)).toBe("unauthorized");
    expect(tickResult(500)).toBe("error");
  });
});
