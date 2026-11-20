# PR Dashboard

Local tool that watches my PRs in `CloudSpot/cloudspot` and the "Build and deploy Node.js services" run each one triggers after it merges. It sends native macOS notifications when a PR merges, when a job in its run fails, and when the run completes. It also serves a dashboard at http://localhost:7896.

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

`/cluster` shows the Argo apps from the `svc` and `job` ApplicationSets, their pods, the commit and PR each pod runs, and live logs. It can also refresh and sync an app and restart a Deployment. It talks only to the Argo CD API, never to kubeconfig. The design is in [docs/specs/cluster-page.md](docs/specs/cluster-page.md).

It needs these variables in the server's environment. Start it through Doppler so no secret sits in a file:

```bash
doppler run --project matt-pr-dashboard --config prd -- pnpm start
```

`ARGO_PRD_URL`, `ARGO_PRD_TOKEN`, `ARGO_STG_URL`, `ARGO_STG_TOKEN`, `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. A missing or empty URL or token turns that tab into a "not set up" note, and the rest of the dashboard works as before. Without Doppler, the server also reads them from `argo.env` in the data folder (see Settings).

Services and Jobs are separate tabs. Hide an app with the eye button on its row; hidden names are saved in `cluster-hidden.json` in the data folder and apply to both environments.

Prod sync and restart ask twice: once in the page, then in a macOS dialog the server shows itself, so a local script can't make a prod change through the API alone. `ARGO_NATIVE_CONFIRM=0` turns the macOS dialog off. Every write is logged to `cluster-actions.log` in the data folder.

To try it without a cluster:

```bash
pnpm fake-argo
```

```bash
ARGO_PRD_URL=http://127.0.0.1:7899 ARGO_PRD_TOKEN=fake-token ARGO_NATIVE_CONFIRM=0 pnpm start
```

## Settings

Optional `~/Library/Application Support/merge-watch/config.json`:

```json
{ "sound": false, "port": 7896 }
```

`sound` is `false` (default, silent), `true` (macOS default sound) or a sound name such as `"Glass"`. Env vars override the file: `MERGE_WATCH_SOUND` (`0`, `1` or a sound name), `PORT`, `MERGE_WATCH_DATA_DIR`.

(The folder and env var names still say `merge-watch` from the app's earlier name, so existing settings and seen state carry over.)

The same folder holds `seen.json`: event ids already notified (so a restart doesn't re-notify) and ids viewed in the page (others show "New"). Ids older than 7 days are pruned.

## How it works

- `core/`: pure logic shared by server and page. It matches runs to PRs, maps PR state to a row status, builds the 24-hour event log, does the ETA math, and plans notifications. Tests are in `core/core.test.ts`.
- `server/`: Hono on 127.0.0.1. Every 60s it fetches your PRs with one GraphQL search. That search returns review decision, reviewers, check status, labels and size. Every 30s it polls runs and active jobs over REST with ETags. It notifies through node-notifier (clicking a notification opens the GitHub URL) and falls back to `osascript`. State is pushed over SSE at `GET /api/events`.
- `web/`: React + Vite page. It reads only from the server and never calls GitHub.
  - `/` shows a 90-day merge chart with a 7-day average and 24h / 7d / 30d totals, the PR cards (click one to expand it to full width with its summary and CI run), and the deploy-runs panel (a live hero for one run plus the list).
  - `/notifications` (the bell) shows each event in detail. Events count as read after the page has been in view for a few seconds.
  - The Options menu in the top bar picks whose PRs to watch: mine (`author:@me`), claude[bot] (`author:app/claude`), or both. It's saved in `prefs.json` and also filters notifications.

Notes:

- A run matches a PR when `event` is `pull_request` and `head_branch` equals the PR's head ref. If more than one run matches, the newest wins. Runs created more than 2 minutes before the merge are ignored, so a reused branch name can't match an old run.
- On startup, more than one unseen event is collapsed into one notification: "N updates since you last ran this".
- If no run matches 5 minutes after the merge, the PR shows "No services build".
