import { describe, expect, it } from "vitest";
import { nextPrPollMs, pollProgress } from "./poll.ts";
import { computeEta, formatDuration, formatTimeLeft, median, typicalDurationMs } from "./eta.ts";
import { buildEvents } from "./events.ts";
import { T0, iso, job, min, pr, run, step } from "./fixtures.ts";
import { matchRunToPr } from "./match.ts";
import { mergeStats, niceMax, rollingAverage } from "./stats.ts";
import { attachedTickets, matchesQuery, parseLinkback, resolveTickets, ticketHints } from "./tickets.ts";
import { extractSummary, formatAgo, reviewSummary, riskLevel, riskTone, splitLabels } from "./pr.ts";
import { diffUnseen, planNotifications, pruneSeen } from "./seen.ts";
import { findFailedJob, prStatus } from "./status.ts";
import { buildMyRuns, buildPrViews, isDeployRun, pickFeatured } from "./view.ts";

const failedBuild = job({
  id: 7,
  name: "Build admin-bff",
  status: "completed",
  conclusion: "failure",
  completedAt: iso(T0 + min(5)),
  htmlUrl: "https://github.com/CloudSpot/cloudspot/actions/runs/44149567802/job/7",
  steps: [
    step({ name: "Checkout" }),
    step({ number: 2, name: "Build and push Docker image", conclusion: "failure" }),
    step({ number: 3, name: "Post", conclusion: "skipped" }),
  ],
});

describe("matchRunToPr", () => {
  it("matches on pull_request event and head branch", () => {
    expect(matchRunToPr(pr(), [run()])?.id).toBe(44149567802);
  });

  it("ignores other branches and other events", () => {
    expect(matchRunToPr(pr(), [run({ headBranch: "other" })])).toBeUndefined();
    expect(matchRunToPr(pr(), [run({ event: "push" })])).toBeUndefined();
  });

  it("takes the newest run when there are re-runs", () => {
    const older = run({ id: 1, createdAt: iso(T0 + 10_000) });
    const newer = run({ id: 2, createdAt: iso(T0 + min(20)) });
    expect(matchRunToPr(pr(), [older, newer])?.id).toBe(2);
    expect(matchRunToPr(pr(), [newer, older])?.id).toBe(2);
  });

  it("does not match unmerged PRs", () => {
    expect(matchRunToPr(pr({ state: "open", mergedAt: null }), [run()])).toBeUndefined();
  });

  it("ignores a run from long before the merge (reused branch name)", () => {
    expect(matchRunToPr(pr(), [run({ createdAt: iso(T0 - min(60 * 24)) })])).toBeUndefined();
  });
});

describe("ETA math", () => {
  it("median handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("typical duration is the median of successful runs only", () => {
    const runs = [
      run({ id: 1, status: "completed", conclusion: "success", runStartedAt: iso(T0), updatedAt: iso(T0 + min(6)) }),
      run({ id: 2, status: "completed", conclusion: "success", runStartedAt: iso(T0), updatedAt: iso(T0 + min(8)) }),
      run({ id: 3, status: "completed", conclusion: "success", runStartedAt: iso(T0), updatedAt: iso(T0 + min(10)) }),
      run({ id: 4, status: "completed", conclusion: "failure", runStartedAt: iso(T0), updatedAt: iso(T0 + min(1)) }),
      run({ id: 5, status: "in_progress" }),
    ];
    expect(typicalDurationMs(runs)).toBe(min(8));
    expect(typicalDurationMs([run()])).toBeNull();
    // No-op runs (under 3 minutes) don't count, however many there are.
    const quick = [1, 2, 3, 4, 5].map((i) =>
      run({ id: 100 + i, status: "completed", conclusion: "success", runStartedAt: iso(T0), updatedAt: iso(T0 + min(1.5)) }),
    );
    expect(typicalDurationMs([...runs, ...quick])).toBe(min(8));
  });

  it("computes remaining time and progress", () => {
    const eta = computeEta(iso(T0), T0 + min(4), min(8));
    expect(eta.elapsedMs).toBe(min(4));
    expect(eta.remainingMs).toBe(min(4));
    expect(eta.progress).toBeCloseTo(0.5);
    expect(eta.overdue).toBe(false);
    expect(formatTimeLeft(eta)).toBe("~4 min left");
  });

  it("caps progress and flags overdue runs", () => {
    const eta = computeEta(iso(T0), T0 + min(12), min(8));
    expect(eta.remainingMs).toBe(0);
    expect(eta.progress).toBeLessThan(1);
    expect(eta.overdue).toBe(true);
    expect(formatTimeLeft(eta)).toBe("taking longer than usual");
  });

  it("has no estimate without a typical duration", () => {
    const eta = computeEta(iso(T0), T0 + min(2), null);
    expect(eta.remainingMs).toBeNull();
    expect(formatTimeLeft(eta)).toBeNull();
  });

  it("formats durations", () => {
    expect(formatDuration(7 * 60_000 + 42_000)).toBe("7m 42s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(63 * 60_000)).toBe("1h 3m");
    expect(formatTimeLeft(computeEta(iso(T0), T0 + min(7.5), min(8)))).toBe("<1 min left");
  });
});

describe("status", () => {
  it("finds the failed job and step", () => {
    expect(findFailedJob([job(), failedBuild])).toMatchObject({
      jobName: "Build admin-bff",
      stepName: "Build and push Docker image",
    });
    expect(findFailedJob([job()])).toBeNull();
  });

  it("maps PR + run state to a row status", () => {
    const now = T0 + min(3);
    expect(prStatus(pr({ state: "open", mergedAt: null }), undefined, undefined, now)).toBe("open");
    expect(prStatus(pr({ mergedAt: null }), undefined, undefined, now)).toBe("closed");
    expect(prStatus(pr(), undefined, undefined, now)).toBe("waiting");
    expect(prStatus(pr(), undefined, undefined, T0 + min(6))).toBe("no-build");
    expect(prStatus(pr(), run(), [job()], now)).toBe("building");
    expect(prStatus(pr(), run(), [failedBuild], now)).toBe("failing");
    expect(prStatus(pr(), run({ status: "completed", conclusion: "failure" }), [], now)).toBe("failed");
    expect(prStatus(pr(), run({ status: "completed", conclusion: "success" }), [], now)).toBe("complete");
  });
});

describe("buildEvents", () => {
  const now = T0 + min(10);

  it("emits merged for merged PRs only", () => {
    const events = buildEvents([{ pr: pr() }, { pr: pr({ number: 1, state: "open", mergedAt: null }) }], now);
    expect(events.map((e) => e.id)).toEqual(["merged:7475"]);
  });

  it("emits failed as soon as one job fails, while the run is still going", () => {
    const events = buildEvents([{ pr: pr(), run: run(), jobs: [job(), failedBuild] }], now);
    const failed = events.find((e) => e.kind === "failed");
    expect(failed).toMatchObject({
      id: "failed:44149567802",
      detail: "Build admin-bff — Build and push Docker image",
      url: failedBuild.htmlUrl,
      at: failedBuild.completedAt,
    });
  });

  it("emits failed when the run completes with failure even without job detail", () => {
    const events = buildEvents([{ pr: pr(), run: run({ status: "completed", conclusion: "failure" }) }], now);
    expect(events.map((e) => e.id)).toContain("failed:44149567802");
    expect(events.map((e) => e.id)).not.toContain("complete:44149567802");
  });

  it("emits complete for any non-failure conclusion, with the run's duration", () => {
    const done = run({ status: "completed", conclusion: "success", updatedAt: iso(T0 + 5_000 + 462_000) });
    const events = buildEvents([{ pr: pr(), run: done, jobs: [job()] }], now);
    const complete = events.find((e) => e.kind === "complete");
    expect(complete?.id).toBe("complete:44149567802");
    expect(complete?.detail).toContain("success in 7m 42s");

    const cancelled = buildEvents([{ pr: pr(), run: run({ status: "completed", conclusion: "cancelled" }) }], now);
    expect(cancelled.map((e) => e.id)).toContain("complete:44149567802");
  });

  it("does not emit complete when a job failed", () => {
    const events = buildEvents(
      [{ pr: pr(), run: run({ status: "completed", conclusion: "cancelled" }), jobs: [failedBuild] }],
      now,
    );
    expect(events.map((e) => e.kind).sort()).toEqual(["failed", "merged"]);
  });

  it("drops events older than 24h and sorts newest first", () => {
    const old = pr({ number: 1, mergedAt: iso(T0 - min(60 * 25)) });
    const events = buildEvents(
      [{ pr: old }, { pr: pr(), run: run({ status: "completed", conclusion: "success" }) }],
      now,
    );
    expect(events.map((e) => e.id)).toEqual(["complete:44149567802", "merged:7475"]);
  });
});

describe("seen diff and notification plan", () => {
  const events = buildEvents(
    [{ pr: pr(), run: run({ status: "completed", conclusion: "success" }) }],
    T0 + min(10),
  );
  const opts = { dashboardUrl: "http://localhost:7896" };

  it("returns unseen events oldest first", () => {
    expect(diffUnseen(events, new Set()).map((e) => e.id)).toEqual(["merged:7475", "complete:44149567802"]);
    expect(diffUnseen(events, new Set(["merged:7475"])).map((e) => e.id)).toEqual(["complete:44149567802"]);
    expect(diffUnseen(events, new Set(events.map((e) => e.id)))).toEqual([]);
  });

  it("sends one summary at startup instead of a burst", () => {
    const plan = planNotifications(diffUnseen(events, new Set()), { ...opts, startup: true });
    expect(plan).toEqual([
      { kind: "summary", title: "Foreman", message: "2 updates since you last ran this", url: opts.dashboardUrl },
    ]);
  });

  it("sends a single unseen startup event as itself", () => {
    const plan = planNotifications(diffUnseen(events, new Set(["merged:7475"])), { ...opts, startup: true });
    expect(plan.map((n) => n.kind)).toEqual(["complete"]);
  });

  it("sends each event individually after startup", () => {
    const plan = planNotifications(diffUnseen(events, new Set()), { ...opts, startup: false });
    expect(plan.map((n) => n.kind)).toEqual(["merged", "complete"]);
    expect(plan[0]?.url).toBe(pr().htmlUrl);
  });

  it("prunes old seen ids", () => {
    expect(pruneSeen({ a: T0, b: T0 - min(60 * 24 * 8) }, T0)).toEqual({ a: T0 });
  });
});

describe("views", () => {
  const now = T0 + min(3);

  it("links a row to its failed job, else its run", () => {
    const jobsByRun = new Map([[44149567802, [job(), failedBuild]]]);
    const [view] = buildPrViews({ prs: [pr()], runs: [run()], jobsByRun, nowMs: now });
    expect(view?.status).toBe("failing");
    expect(view?.link).toEqual({ label: "Failed: Build admin-bff", url: failedBuild.htmlUrl });

    const [ok] = buildPrViews({ prs: [pr()], runs: [run()], jobsByRun: new Map(), nowMs: now });
    expect(ok?.link?.url).toBe(run().htmlUrl);
  });

  it("features active runs, else the latest finished run", () => {
    const a = pr({ number: 1, headRef: "a" });
    const b = pr({ number: 2, headRef: "b" });
    const active = buildPrViews({
      prs: [a, b],
      runs: [run({ id: 10, headBranch: "a" }), run({ id: 11, headBranch: "b", status: "completed", conclusion: "success" })],
      jobsByRun: new Map(),
      nowMs: now,
    });
    expect(pickFeatured(active)).toEqual({ mode: "active", prNumbers: [1] });

    const finished = buildPrViews({
      prs: [a, b],
      runs: [
        run({ id: 10, headBranch: "a", status: "completed", conclusion: "success", updatedAt: iso(T0 + min(9)) }),
        run({ id: 11, headBranch: "b", status: "completed", conclusion: "failure", updatedAt: iso(T0 + min(12)) }),
      ],
      jobsByRun: new Map(),
      nowMs: now,
    });
    expect(pickFeatured(finished)).toEqual({ mode: "last", prNumbers: [2] });
    expect(pickFeatured([])).toEqual({ mode: "none", prNumbers: [] });
  });
});

describe("PR labels and reviews", () => {
  it("reads the risk level and splits claude-* labels", () => {
    expect(riskLevel(["sso", "risk:5"])).toBe(5);
    expect(riskLevel(["sso"])).toBeNull();
    expect(riskLevel(["risk:0"])).toBe(0);
    expect(riskTone(2)).toBe("low");
    expect(riskTone(3)).toBe("medium");
    expect(riskTone(5)).toBe("high");
    expect(splitLabels(["javascript", "deploy-prod", "claude-review", "claude-approved", "risk:2"])).toEqual({
      deployProd: true,
      risk: 2,
      claudeLabels: ["claude-review", "claude-approved"],
      otherLabels: ["javascript"],
    });
  });

  it("summarises approval vs requested changes", () => {
    const open = { state: "open" as const, isDraft: false, requestedReviewers: ["NodeJS"] };
    expect(
      reviewSummary({ ...open, reviewDecision: "APPROVED", reviews: [{ login: "bd", state: "APPROVED" }] }),
    ).toEqual({ state: "approved", approvedBy: ["bd"], changesBy: [], waitingOn: ["NodeJS"] });
    expect(
      reviewSummary({
        ...open,
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [{ login: "bd", state: "APPROVED" }, { login: "mg", state: "CHANGES_REQUESTED" }],
      }).state,
    ).toBe("changes");
    expect(reviewSummary({ ...open, reviewDecision: "REVIEW_REQUIRED", reviews: [] }).state).toBe("required");
    expect(reviewSummary({ ...open, isDraft: true, reviewDecision: "REVIEW_REQUIRED", reviews: [] }).state).toBe("draft");
    expect(reviewSummary({ ...open, reviewDecision: null, reviews: [] }).state).toBe("none");
    // Pending reviewers don't matter once the PR is closed.
    expect(reviewSummary({ ...open, state: "closed", reviewDecision: "APPROVED", reviews: [] }).waitingOn).toEqual([]);
  });

  it("formats relative times", () => {
    expect(formatAgo(iso(T0), T0 + 10_000)).toBe("just now");
    expect(formatAgo(iso(T0), T0 + min(12))).toBe("12 min ago");
    expect(formatAgo(iso(T0), T0 + min(180))).toBe("3 h ago");
    expect(formatAgo(iso(T0), T0 + min(60 * 48))).toBe("2 d ago");
  });
});

describe("event detail", () => {
  it("carries run, failed job and services on a failure", () => {
    const jobs = [job(), job({ id: 8, name: "Build po" }), failedBuild];
    const [failed] = buildEvents([{ pr: pr({ labels: ["deploy-prod"] }), run: run(), jobs }], T0 + min(10)).filter(
      (e) => e.kind === "failed",
    );
    expect(failed?.run).toMatchObject({ number: 2860, durationMs: min(5) - 5_000 });
    expect(failed?.failedJob).toEqual({ name: "Build admin-bff", step: "Build and push Docker image", url: failedBuild.htmlUrl });
    expect(failed?.services.map((s) => `${s.name}:${s.conclusion}`)).toEqual(["po:success", "admin-bff:failure"]);
    expect(failed?.deployProd).toBe(true);
  });
});

describe("side panel runs", () => {
  const long = { status: "completed", conclusion: "success", runStartedAt: iso(T0), updatedAt: iso(T0 + min(7)) };
  const k8s = (conclusion: string) => [job({ name: "Detect K8S targets", conclusion })];

  it("keeps runs on my branches or triggered by me, newest first", () => {
    const mine = pr({ number: 1, headRef: "a", title: "A" });
    const runs = [
      run({ ...long, id: 1, headBranch: "a", actor: "someone", createdAt: iso(T0) }),
      run({ ...long, id: 2, headBranch: "other", actor: "someone", createdAt: iso(T0 + min(5)) }),
      run({ ...long, id: 3, headBranch: "b", actor: "me", createdAt: iso(T0 + min(10)) }),
      run({ ...long, id: 4, headBranch: "a", actor: "someone", createdAt: iso(T0 + min(20)) }),
    ];
    const out = buildMyRuns(runs, [mine], "me").runs;
    expect(out.map((r) => r.id)).toEqual([4, 3, 1]);
    expect(out[0]?.pr).toEqual({ number: 1, title: "A", htmlUrl: mine.htmlUrl });
    expect(out[1]?.pr).toBeNull();
  });

  it("links a branch to its newest PR", () => {
    const old = pr({ number: 1, headRef: "a", createdAt: iso(T0 - min(600)) });
    const recent = pr({ number: 2, headRef: "a", createdAt: iso(T0 - min(60)) });
    expect(buildMyRuns([run({ headBranch: "a" })], [recent, old], null).runs[0]?.pr?.number).toBe(2);
  });

  it("drops no-op runs: under 3 minutes, or K8S targets skipped", () => {
    expect(isDeployRun(run(long), undefined)).toBe(true);
    expect(isDeployRun(run({ ...long, updatedAt: iso(T0 + min(2.5)) }), undefined)).toBe(false);
    expect(isDeployRun(run(long), k8s("success"))).toBe(true);
    expect(isDeployRun(run(long), k8s("skipped"))).toBe(false);
    expect(isDeployRun(run(long), [job()])).toBe(false);
  });

  it("always keeps running and failed runs", () => {
    expect(isDeployRun(run({ status: "in_progress", runStartedAt: iso(T0), updatedAt: iso(T0 + 1000) }), k8s("skipped"))).toBe(true);
    expect(isDeployRun(run({ ...long, conclusion: "failure", updatedAt: iso(T0 + min(1)) }), k8s("skipped"))).toBe(true);
  });

  it("counts hidden runs", () => {
    const quick = run({ ...long, id: 9, headBranch: "a", updatedAt: iso(T0 + min(1)) });
    const real = run({ ...long, id: 8, headBranch: "a" });
    const out = buildMyRuns([quick, real], [pr({ headRef: "a" })], null);
    expect(out.runs.map((r) => r.id)).toEqual([8]);
    expect(out.hidden).toBe(1);
  });
});

describe("extractSummary", () => {
  it("takes the Summary section up to the next heading", () => {
    const body = "# Summary\n\nSSO stops serving `settings`.\n\n- one\n- two\n\n# Motivation / Context\n\nWhy.";
    expect(extractSummary(body)).toBe("SSO stops serving `settings`.\n\n- one\n- two");
  });

  it("stops at a horizontal rule and handles ## headings", () => {
    expect(extractSummary("## Summary\nShort.\n---\nRef: x")).toBe("Short.");
  });

  it("falls back to the first paragraph", () => {
    expect(extractSummary("<!-- template -->\nFirst para\nstill first.\n\nSecond.")).toBe("First para\nstill first.");
  });

  it("returns null for empty bodies and truncates long ones", () => {
    expect(extractSummary("")).toBeNull();
    expect(extractSummary(null)).toBeNull();
    expect(extractSummary("# Summary\n" + "a".repeat(50), 10)).toBe("aaaaaaaaaa…");
  });
});

describe("merge stats", () => {
  // Local-time dates so the day buckets don't depend on the machine's time zone.
  const now = new Date(2026, 10, 18, 15, 0).getTime();
  const at = (daysAgo: number, hour: number) => {
    const d = new Date(2026, 10, 18 - daysAgo, hour, 0);
    return d.toISOString();
  };

  it("counts rolling 24h / 7d / 30d windows", () => {
    const merges = [at(0, 9), at(0, 14), at(1, 16), at(1, 10), at(6, 12), at(8, 12), at(29, 16), at(40, 12)];
    const s = mergeStats(merges, now);
    expect(s.last24h).toBe(3); // today 9:00, 14:00, yesterday 16:00
    expect(s.last7d).toBe(5);
    expect(s.last30d).toBe(7);
  });

  it("buckets by local day, oldest first, ending today", () => {
    const s = mergeStats([at(0, 9), at(0, 14), at(2, 1), at(31, 12)], now, 3);
    expect(s.daily.map((d) => d.count)).toEqual([1, 0, 2]);
    expect(new Date(s.daily[2]!.day).getDate()).toBe(18);
  });

  it("ignores future and invalid timestamps", () => {
    expect(mergeStats(["nope", new Date(now + 60_000).toISOString()], now).last24h).toBe(0);
  });

  it("computes a trailing 7-day average", () => {
    const counts = [7, 0, 0, 0, 0, 0, 0, 14, 7];
    const avg = rollingAverage(counts);
    expect(avg[6]).toBe(1); // days 0-6: 7 / 7
    expect(avg[7]).toBe(2); // days 1-7: 14 / 7
    expect(avg[8]).toBe(3); // days 2-8: 21 / 7
    expect(avg[0]).toBe(7); // only one day available
    expect(rollingAverage([2, 4], 3)).toEqual([2, 3]);
  });

  it("rounds the axis max", () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(21)).toBe(25);
  });
});

describe("authors", () => {
  const long = { status: "completed", conclusion: "success", runStartedAt: iso(T0), updatedAt: iso(T0 + min(7)) };

  it("tags runs with their PR's author, and actor-only runs as mine", () => {
    const bot = pr({ number: 2, headRef: "bot-branch", author: "claude" });
    const out = buildMyRuns(
      [run({ ...long, id: 1, headBranch: "bot-branch", actor: "me" }), run({ ...long, id: 2, headBranch: "x", actor: "me" })],
      [bot],
      "me",
    ).runs;
    expect(out.map((r) => [r.id, r.author])).toEqual([
      [1, "claude"],
      [2, "me"],
    ]);
  });

  it("skips actor-only runs when login is null (my PRs turned off)", () => {
    const out = buildMyRuns([run({ ...long, headBranch: "x", actor: "me" })], [], null).runs;
    expect(out).toEqual([]);
  });
});

describe("Linear tickets", () => {
  const linkback = (id: string, title: string, extra = "") =>
    `<!-- linear-linkback -->\n<details>\n<summary><a href="https://linear.app/cloudspot/issue/${id}/slug">${id} ${title}</a></summary>\n<p>\n\n${extra}`;

  it("reads the ticket from the linkback summary, not the quoted description", () => {
    const body = linkback("PLAT-1234", "Convert crm-backend", "Pilot ([PLAT-1233](<https://linear.app/cloudspot/issue/PLAT-1233>))");
    expect(parseLinkback(body)).toEqual({
      id: "PLAT-1234",
      title: "Convert crm-backend",
      url: "https://linear.app/cloudspot/issue/PLAT-1234/slug",
    });
    expect(parseLinkback("LGTM")).toBeNull();
  });

  it("decodes HTML entities in the title", () => {
    expect(parseLinkback(linkback("PLAT-1", "Add `&lt;Foo&gt;` &amp; bar"))?.title).toBe("Add `<Foo>` & bar");
  });

  it("uses linkbacks when present, ignoring related tickets linked in the description", () => {
    const out = attachedTickets(
      [linkback("PLAT-2", "Two"), "risk gate comment"],
      "See https://linear.app/cloudspot/issue/PLAT-2 and https://linear.app/cloudspot/issue/SUP-9/x",
    );
    expect(out.map((t) => t.id)).toEqual(["PLAT-2"]);
  });

  it("falls back to description links, deduplicated, when there is no linkback", () => {
    const out = attachedTickets(["LGTM"], "https://linear.app/cloudspot/issue/SUP-9/x and https://linear.app/cloudspot/issue/SUP-9");
    expect(out.map((t) => t.id)).toEqual(["SUP-9"]);
  });

  it("finds ticket-shaped IDs in titles and branches", () => {
    expect(ticketHints("fix: thing (PLAT-2031)", "claude/plat-2055-update-row")).toEqual(["PLAT-2031", "PLAT-2055"]);
  });

  it("falls back to hints only for team keys seen on real Linear links", () => {
    const linked = pr({ number: 1, tickets: [{ id: "PLAT-1", title: "x", url: "https://linear.app/cloudspot/issue/PLAT-1/x" }] });
    const pending = pr({ number: 2, ticketHints: ["PLAT-2055"] });
    const rfc = pr({ number: 3, ticketHints: ["RFC-0001"] });
    const [, a, b] = resolveTickets([linked, pending, rfc]);
    expect(a?.tickets).toEqual([{ id: "PLAT-2055", title: null, url: "https://linear.app/cloudspot/issue/PLAT-2055" }]);
    expect(b?.tickets).toEqual([]);
  });
});

describe("search", () => {
  const p = pr({
    number: 7507,
    title: "refactor(sso): remove the GET /settings route",
    tickets: [{ id: "PLAT-2031", title: null, url: "u" }],
  });

  it("matches title words, any order, case-insensitive", () => {
    expect(matchesQuery(p, "SSO settings")).toBe(true);
    expect(matchesQuery(p, "settings billing")).toBe(false);
  });

  it("matches PR numbers with or without #", () => {
    expect(matchesQuery(p, "7507")).toBe(true);
    expect(matchesQuery(p, "#75")).toBe(true);
    expect(matchesQuery(p, "#7508")).toBe(false);
  });

  it("matches ticket IDs in full, lowercase, or by number", () => {
    expect(matchesQuery(p, "PLAT-2031")).toBe(true);
    expect(matchesQuery(p, "plat-20")).toBe(true);
    expect(matchesQuery(p, "2031")).toBe(true);
    expect(matchesQuery(p, "SUP-2031")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(matchesQuery(p, "  ")).toBe(true);
  });
});

describe("PR poll timing", () => {
  const S = 1000;
  it("next PR fetch is the first tick at least ~60s after the last one", () => {
    // Fetched at 0, next tick at 30s: too early, so the tick after (60s).
    expect(nextPrPollMs(0, 30 * S, 30 * S, 60 * S)).toBe(60 * S);
    // A slow tick pushed the next tick past 59s: that one fetches.
    expect(nextPrPollMs(0, 59.5 * S, 30 * S, 60 * S)).toBe(59.5 * S);
  });
  it("progress runs 0..1 across the window and clamps", () => {
    const last = new Date(0).toISOString();
    const next = new Date(60 * S).toISOString();
    expect(pollProgress(last, next, 0)).toBe(0);
    expect(pollProgress(last, next, 30 * S)).toBe(0.5);
    expect(pollProgress(last, next, 90 * S)).toBe(1);
    expect(pollProgress(null, next, 30 * S)).toBe(0);
  });
});
