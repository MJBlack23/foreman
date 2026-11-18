import { buildEvents, EVENT_WINDOW_MS } from "../core/events.ts";
import { typicalDurationMs } from "../core/eta.ts";
import { isRunActive, matchRunToPr } from "../core/match.ts";
import { diffUnseen, planNotifications, type PlannedNotification } from "../core/seen.ts";
import { AUTHOR_KEYS, type AuthorKey, type GhJob, type GhPr, type GhRun, type JobsPayload, SNAPSHOT_SCHEMA, type Snapshot } from "../core/types.ts";
import { buildMyRuns, buildPrViews, isDeployRun, myBranchRuns, pickFeatured } from "../core/view.ts";
import { LIVE_JOBS_MIN_AGE_MS, PRS_EVERY_MS, REPO_NAME, REPO_OWNER, RUNS_EVERY_MS, STATS_DAYS, STATS_EVERY_MS } from "./config.ts";
import type { GitHub } from "./github.ts";
import type { PrefsStore } from "./prefs.ts";
import type { SeenStore } from "./store.ts";

type Listener = (s: Snapshot) => void;

export class Poller {
  private login: string | null = null;
  private prs = new Map<number, GhPr>();
  private runs: GhRun[] = [];
  private jobs = new Map<number, { jobs: GhJob[]; final: boolean }>();
  /** Jobs fetched for the side panel's expanded cards, shared by all open tabs. */
  private live = new Map<number, JobsPayload>();
  private liveInflight = new Map<number, Promise<JobsPayload>>();
  /** Final jobs of my finished runs, fetched once each for the side panel's K8S check. */
  private panelJobs = new Map<number, GhJob[]>();
  private lastPrPollMs = 0;
  private merges: { byAuthor: Record<AuthorKey, string[]>; fetchedAt: string } | null = null;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  /** Until the first fully successful poll, unseen events collapse into one summary. */
  private startupPending = true;
  private listeners = new Set<Listener>();
  private current: Snapshot;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private gh: GitHub,
    private store: SeenStore,
    private prefs: PrefsStore,
    private notify: (n: PlannedNotification) => void,
    private dashboardUrl: string,
  ) {
    this.current = this.compute(Date.now()).snapshot;
  }

  start() {
    const loop = async () => {
      await this.tick();
      this.timer = setTimeout(loop, RUNS_EVERY_MS);
    };
    void loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  snapshot(): Snapshot {
    return this.current;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Recompute (e.g. after the user marked events viewed) and push to clients. */
  republish() {
    this.current = this.compute(Date.now()).snapshot;
    this.emit();
  }

  async tick() {
    let ok = true;
    try {
      this.login ??= await this.gh.login();
      if (Date.now() - this.lastPrPollMs >= PRS_EVERY_MS - 1000) {
        await this.refreshPrs();
        this.lastPrPollMs = Date.now();
      }
      this.runs = await this.gh.workflowRuns();
      await this.refreshJobs();
      await this.refreshPanelJobs();
      await this.refreshMergeStats();
      this.lastError = null;
      this.lastPollAt = new Date().toISOString();
    } catch (e) {
      ok = false;
      this.lastError = (e as Error).message;
      console.error(`[poll] ${this.lastError}`);
    }

    const { snapshot, events } = this.compute(Date.now());
    this.current = snapshot;
    // Only notify from complete data, so a half-failed poll can't misfire.
    if (ok) {
      const unseen = diffUnseen(events, this.store.notifiedIds());
      const plan = planNotifications(unseen, { startup: this.startupPending, dashboardUrl: this.dashboardUrl });
      for (const n of plan) this.notify(n);
      this.store.markNotified(unseen.map((e) => e.id));
      this.startupPending = false;
    }
    this.emit();
  }

  private async refreshPrs() {
    // Search in whole hours; the exact 24h cut happens in compute().
    const since = new Date(Math.floor((Date.now() - EVENT_WINDOW_MS) / 3_600_000) * 3_600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    // Both authors are always fetched; the saved preference filters in compute().
    const lists = await Promise.all(
      AUTHOR_KEYS.flatMap((a) => [this.gh.searchPrs(a, "is:open"), this.gh.searchPrs(a, `is:closed closed:>=${since}`)]),
    );
    this.prs = new Map(lists.flat().map((p) => [p.number, p]));
  }

  /** Jobs only for runs matched to my PRs: active ones, and finished ones once. */
  private async refreshJobs() {
    const wanted = new Set<number>();
    const toFetch: GhRun[] = [];
    for (const pr of this.prs.values()) {
      const run = matchRunToPr(pr, this.runs);
      if (!run) continue;
      wanted.add(run.id);
      const cached = this.jobs.get(run.id);
      if (isRunActive(run) || !cached || !cached.final) toFetch.push(run);
    }
    await Promise.all(
      toFetch.map(async (run) => {
        this.jobs.set(run.id, { jobs: await this.gh.jobs(run.id), final: !isRunActive(run) });
      }),
    );
    for (const id of this.jobs.keys()) if (!wanted.has(id)) this.jobs.delete(id);
    const listed = new Set(this.runs.map((r) => r.id));
    for (const id of this.live.keys()) if (!listed.has(id)) this.live.delete(id);
  }

  /**
   * Jobs + steps for one of my runs, for a live view. Re-fetched at most every
   * LIVE_JOBS_MIN_AGE_MS (ETag'd, so unchanged replies are free); finished runs
   * are served from cache. Returns null for runs that aren't mine.
   */
  async liveJobs(runId: number): Promise<JobsPayload | null> {
    const run = this.runs.find((r) => r.id === runId);
    if (!run || !this.current.myRuns.some((r) => r.id === runId)) return null;
    const cached = this.live.get(runId);
    const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < LIVE_JOBS_MIN_AGE_MS;
    const settled = cached && !isRunActive(run) && Date.parse(cached.fetchedAt) > Date.parse(run.updatedAt);
    if (cached && (fresh || settled)) return cached;

    let pending = this.liveInflight.get(runId);
    if (!pending) {
      pending = this.gh
        .jobs(runId)
        .then((jobs) => {
          const payload = { runId, fetchedAt: new Date().toISOString(), jobs };
          this.live.set(runId, payload);
          // Share with the tracked-run cache so the hero updates as fast as the panel.
          if (this.jobs.has(runId)) {
            this.jobs.set(runId, { jobs, final: !isRunActive(run) });
            this.republish();
          }
          return payload;
        })
        .finally(() => this.liveInflight.delete(runId));
      this.liveInflight.set(runId, pending);
    }
    return pending;
  }

  /**
   * The side panel hides runs whose "Detect K8S targets" job was skipped. For
   * finished runs of mine that pass the 3-minute check, fetch jobs once (a
   * finished run's jobs never change) so that check has data.
   */
  private async refreshPanelJobs() {
    const mine = myBranchRuns(this.runs, [...this.prs.values()], this.login);
    const need = mine.filter(
      (r) => !isRunActive(r) && !this.panelJobs.has(r.id) && !this.jobs.get(r.id)?.final && isDeployRun(r, undefined),
    );
    await Promise.all(
      need.map(async (r) => {
        this.panelJobs.set(r.id, await this.gh.jobs(r.id));
      }),
    );
    const listed = new Set(this.runs.map((r) => r.id));
    for (const id of this.panelJobs.keys()) if (!listed.has(id)) this.panelJobs.delete(id);
  }

  /** Every STATS_EVERY_MS: when my PRs merged over the last STATS_DAYS (+1 so local days are whole, +7 for the average). */
  private async refreshMergeStats() {
    if (this.merges && Date.now() - Date.parse(this.merges.fetchedAt) < STATS_EVERY_MS) return;
    // +7 days so the 7-day average is a full window from the chart's first day.
    const since = new Date(Date.now() - (STATS_DAYS + 7 + 1) * 86_400_000).toISOString().slice(0, 10);
    const [me, claude] = await Promise.all(AUTHOR_KEYS.map((a) => this.gh.mergedAtSince(a, since)));
    this.merges = { byAuthor: { me: me!, claude: claude! }, fetchedAt: new Date().toISOString() };
  }

  /** Change which authors are shown and notified. Newly added authors' existing events are marked as already notified. */
  setPrefs(raw: unknown) {
    const before = new Set(this.prefs.get().authors);
    const prefs = this.prefs.set(raw);
    const added = new Set(prefs.authors.filter((a) => !before.has(a)));
    const { events } = this.compute(Date.now());
    const authorOf = new Map([...this.prs.values()].map((p) => [p.number, p.author]));
    this.store.markNotified(events.filter((e) => added.has(authorOf.get(e.prNumber) ?? "me")).map((e) => e.id));
    this.republish();
  }

  private compute(nowMs: number) {
    const prefs = this.prefs.get();
    const allowed = new Set(prefs.authors);
    const prs = [...this.prs.values()].filter(
      (p) =>
        allowed.has(p.author) && (p.state === "open" || nowMs - Date.parse(p.closedAt ?? p.updatedAt) <= EVENT_WINDOW_MS),
    );
    const jobsByRun = new Map([...this.jobs].map(([id, c]) => [id, c.jobs] as const));
    const views = buildPrViews({ prs, runs: this.runs, jobsByRun, nowMs });
    const events = buildEvents(
      prs.map((pr) => {
        const run = matchRunToPr(pr, this.runs);
        return { pr, run, jobs: run ? jobsByRun.get(run.id) : undefined };
      }),
      nowMs,
    );
    const viewed = this.store.viewedIds();
    const snapshot: Snapshot = {
      schema: SNAPSHOT_SCHEMA,
      prefs,
      login: this.login,
      repo: `${REPO_OWNER}/${REPO_NAME}`,
      generatedAt: new Date(nowMs).toISOString(),
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      rateLimit: this.gh.rateLimit,
      typicalMs: typicalDurationMs(this.runs),
      featured: pickFeatured(views),
      prs: views,
      ...this.panelRuns(jobsByRun, prs, allowed),
      merges: this.merges
        ? { mergedAts: prefs.authors.flatMap((a) => this.merges!.byAuthor[a]), fetchedAt: this.merges.fetchedAt }
        : null,
      events: events.map((e) => ({ ...e, isNew: !viewed.has(e.id) })),
    };
    return { snapshot, events };
  }

  private panelRuns(
    tracked: ReadonlyMap<number, GhJob[]>,
    prs: GhPr[],
    allowed: ReadonlySet<AuthorKey>,
  ): Pick<Snapshot, "myRuns" | "myRunsHidden"> {
    const known = new Map<number, GhJob[]>(this.panelJobs);
    for (const [id, p] of this.live) known.set(id, p.jobs);
    for (const [id, jobs] of tracked) known.set(id, jobs);
    // Runs I triggered with no linked PR count as mine.
    const { runs, hidden } = buildMyRuns(this.runs, prs, allowed.has("me") ? this.login : null, known);
    return { myRuns: runs, myRunsHidden: hidden };
  }

  private emit() {
    for (const fn of this.listeners) {
      try {
        fn(this.current);
      } catch (e) {
        console.error(`[sse] listener failed: ${(e as Error).message}`);
      }
    }
  }
}
