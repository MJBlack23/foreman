# Foreman

Local tool that watches the work in flight and the floor it ships to. It follows my PRs in `CloudSpot/cloudspot` and the "Build and deploy Node.js services" run each one triggers after it merges, and it shows the health of the Prod and Staging clusters through Argo CD. It sends native macOS notifications when a PR merges, when a job in its run fails, and when the run completes. It serves its page at http://localhost:7896.

(It was called PR Dashboard, and before that merge-watch.)

## Run

Needs Node 20+, pnpm, and `gh` signed in (the token comes from `gh auth token` at startup and stays in memory).

```bash
pnpm install
pnpm start        # builds the page and serves it on :7896; restarts the server and rebuilds the page when files change
pnpm start:once   # the same, without watching
pnpm dev          # server with reload + Vite dev server (proxies /api to :7896)
pnpm test         # Vitest: run matching, events, ETA math, seen diff, labels and reviews, Cluster page
pnpm typecheck
pnpm fake-argo    # a stand-in Argo CD API on :7899, for trying the Cluster page
```

## Cluster page (Argo CD)

`/cluster` shows the Argo apps from the `svc` and `job` ApplicationSets, their pods, the commit and PR each pod runs, and live logs. It can also refresh and sync an app and restart a Deployment. It talks only to the Argo CD API, never to kubeconfig.

It needs these variables in the server's environment. Start it through Doppler so no secret sits in a file:

```bash
doppler run --project foreman --config prd -- pnpm start
```

`ARGO_PRD_URL`, `ARGO_PRD_TOKEN`, `ARGO_STG_URL`, `ARGO_STG_TOKEN`, `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. A missing or empty URL or token turns that tab into a "not set up" note, and the rest of the dashboard works as before. Without Doppler, the server also reads them from `argo.env` in the old data folder (see Data).

Services and Jobs are separate tabs. Hide an app with the eye button on its row; hidden names are saved in the database and apply to both environments.

Prod sync and restart ask twice: once in the page, then in a macOS dialog the server shows itself, so a local script can't make a prod change through the API alone. `ARGO_NATIVE_CONFIRM=0` turns the macOS dialog off. Every write is logged to the `cluster_actions` table.

To try it without a cluster:

```bash
pnpm fake-argo
```

```bash
ARGO_PRD_URL=http://127.0.0.1:7899 ARGO_PRD_TOKEN=fake-token ARGO_NATIVE_CONFIRM=0 pnpm start
```

## Night Shift page

`/night-shift` watches the night-shift app on DigitalOcean App Platform (`https://night-shift-5lcby.ondigitalocean.app`; the URL and app ID are in `core/nightShift.ts`). While the server runs it:

- checks `GET /health` every 10 minutes (down means a non-2xx answer or none within 10 seconds, two checks in a row);
- polls the App Platform status every 30 minutes, or every minute while a deployment is in progress;
- sends a macOS notification when health goes down or comes back, and when a deployment ends in `ERROR`;
- sends `POST /tick` when you click "Tick now", after a macOS confirm dialog.

Checks and manual ticks are kept in the database for 7 days. When the server isn't running nothing is checked, and the uptime strip shows that time as no data. The top-bar link carries a dot: green healthy, amber deploying, red down or the last deploy failed.

It reads two variables from Doppler project `foreman` (add them as references to `night-shift`/`prd` so rotation carries over):

- `DO_API_TOKEN`: a read-only DigitalOcean token. Without it the App Platform card says "not configured".
- `NIGHT_SHIFT_TICK_SECRET`: night-shift's `TICK_SECRET`. Without it "Tick now" is disabled.

The health check needs neither.

## Ideas page

`/ideas` is a board for things I want to do someday but haven't planned or put in Linear: not a todo list. Each idea has a title, a pitch, a markdown "thinking so far", a stage (Spark, Shaping, Waiting on something, Ready for the line, On the line, Shelved), what it's waiting on, tags, a link once it's in Linear, and a thread of notes from me or Claude.

Claude reads and writes the same ideas through `/api/ideas` with curl; the [idea-board skill](.claude/skills/idea-board/SKILL.md) says how. "Talk to Claude" on an idea copies a prompt to paste into any Claude Code session. Changes show up on the page live.

Writes from a browser are only accepted from the dashboard's own origin; local clients that send no `Origin` (curl) are allowed. Every write must be `content-type: application/json`.

## Queue page

`/queue` lists the Linear work I've queued that has no open PR yet. Linear is the source of truth, and the page only reads from it. Every 3 minutes, and on "Refresh", it fetches the issues that are started or to do (not backlog or triage), either assigned to me or in a project I lead. Delegated issues show up as mine.

An issue drops off the page once a PR for it is open, either one Linear has linked or one the PRs tab already knows about. Merged or closed PRs don't count, so multi-PR work stays on the page with an "earlier PRs merged" note.

Issues are sorted into lanes:

- **Branch pushed, no PR:** a branch on `CloudSpot/cloudspot` names the issue (found with one GitHub GraphQL call).
- **In progress:** marked Stale after 3 days with nothing pushed.
- **Blocked**
- **Up next**

Within each lane, issues are grouped by project, then by parent issue, and sorted by priority. Parents can be folded; what you've folded is remembered in this browser.

On each row, the copy icon copies Linear's branch name, so the PR links back to the ticket. "Send to Night-Shift" adds the team's `night-shift-ready` label in Linear, moving a Blocked ticket to the team's To Do first, after a macOS confirm (`ARGO_NATIVE_CONFIRM=0` turns it off), and night-shift picks the ticket up on its next tick. Issues that already have the label show "With Night-Shift" instead.

It needs `LINEAR_API_KEY`, a personal Linear key, in Doppler project `foreman`. Read access is enough for the page; "Send to Night-Shift" also needs Write. Without it the page shows a "not set up" note.

## Data

Everything the app remembers is in `foreman.db`, a SQLite database in the project root (git-ignored). `FOREMAN_DB` points it somewhere else. It uses Node's built-in `node:sqlite`, so there's nothing native to install.

| Table | Holds |
|---|---|
| `settings` | `prefs` (whose PRs to watch), `sound`, `port`, and a record of the one-time import |
| `seen` | Event ids already notified (so a restart doesn't re-notify) and ids viewed in the page (others show "New"). Ids older than 7 days are pruned. |
| `hidden_apps` | Apps hidden from the Cluster list |
| `cluster_actions` | Every sync and restart, with Argo's answer |
| `night_shift_*` | Night Shift health checks, status polls and ticks (7 days) |
| `ideas`, `idea_notes` | The Ideas board and each idea's notes |

`sound` is `false` (default, silent), `true` (macOS default sound) or a sound name such as `"Glass"`. There's no settings page yet, so set it with `sqlite3 foreman.db "INSERT OR REPLACE INTO settings VALUES ('sound', '\"Glass\"')"`, or override it with env vars: `MERGE_WATCH_SOUND` (`0`, `1` or a sound name) and `PORT`.

The schema is versioned with `PRAGMA user_version`; the steps are in `server/db.ts`.

On its first start the database imports the old JSON files from `~/Library/Application Support/merge-watch` (`config.json`, `prefs.json`, `seen.json`, `cluster-hidden.json`, `cluster-actions.log`) and leaves them in place. That folder is still where the optional `argo.env` lives, so secrets stay out of the project. `MERGE_WATCH_DATA_DIR` moves it. The Argo account is still `pr-dashboard`; see [TODO.md](TODO.md).

## How it works

- `core/`: pure logic shared by server and page. It matches runs to PRs, maps PR state to a row status, builds the 24-hour event log, does the ETA math, and plans notifications. Tests are in `core/core.test.ts`.
- `server/`: Hono on 127.0.0.1. Every 60s it fetches your PRs with one GraphQL search. That search returns review decision, reviewers, check status, labels and size. Every 30s it polls runs and active jobs over REST with ETags. It notifies through node-notifier (clicking a notification opens the GitHub URL) and falls back to `osascript`. State is pushed over SSE at `GET /api/events`.
- `web/`: React + Vite page. It reads only from the server and never calls GitHub.
  - `/` shows a 90-day merge chart with a 7-day average and 24h / 7d / 30d totals, the PR cards (click one to expand it to full width with its summary and CI run), and the deploy-runs panel (a live hero for one run plus the list).
  - `/notifications` (the bell) shows each event in detail. Events count as read after the page has been in view for a few seconds.
  - The Options menu in the top bar picks whose PRs to watch: mine (`author:@me`), claude[bot] (`author:app/claude`), or both. It's saved in the database and also filters notifications.

Notes:

- A run matches a PR when `event` is `pull_request` and `head_branch` equals the PR's head ref. If more than one run matches, the newest wins. Runs created more than 2 minutes before the merge are ignored, so a reused branch name can't match an old run.
- On startup, more than one unseen event is collapsed into one notification: "N updates since you last ran this".
- If no run matches 5 minutes after the merge, the PR shows "No services build".
