# TODO

## Soon

- [ ] **Rename the Argo account `pr-dashboard` to `foreman`.** It still has the old app name.
  1. In `CloudSpot/infrastructure`, `apps/argo/values_prd.yaml` and `values_stg.yaml`: rename `accounts.pr-dashboard` and the `role:pr-dashboard` policy lines to `foreman`.
  2. Merge, then sync the `argocd` app by hand in each cluster. It doesn't auto-sync.
  3. Generate a new token for `foreman` in each Argo UI (Settings → Accounts) and put it in Doppler (`foreman` project, `prd` config).
  4. Update the account name in `server/argo.ts` (the permission error message).

## Cluster page: still to check against the real clusters

- [ ] Restart: which route our Argo accepts (`…/resource/actions` with body `"restart"`, or `…/resource/actions/v2`). The client tries v1, then v2.
- [ ] Logs: whether `role:pr-dashboard` needs `logs, get`, and whether a whole-Deployment log stream works with only that.
- [ ] Deploy-run links with a real run that built a service (no recent merge did).
- [ ] Staging: whether one Cloudflare service token covers both hosts, or staging needs its own Service Auth policy.
- [ ] Squash merges, including claude[bot]'s: confirm `commits/{sha}/pulls` returns the PR.
- [ ] Sync with auto-sync on: disable "Refresh & sync" with a "nothing to sync" note when the preview diff is empty?

## UI bugs

- [ ] "Loading jobs…" stuck on a finished run in the Latest deploy card (seen once, not reproduced). Make `/api/runs/:id/jobs` slow or failing and check the card shows an error and a retry, never a long "Loading jobs…".
- [ ] The chart's "avg N" label can overlap the last spike. Place it above the higher of the average line and the daily value, or move it into the legend.
- [ ] The latest run shows twice in Deploy runs: as the Latest deploy card and as the first, selected row below it. Start the list at the second run, or drop the selected style.

## Later

- [ ] Rename the `MERGE_WATCH_*` env vars to `FOREMAN_*`, keeping the old names working for a while.
- [ ] Retire the `merge-watch` data folder: its JSON files are imported into `foreman.db` and no longer read. Only the optional `argo.env` fallback still lives there; move it or drop it in favour of Doppler.
- [ ] A settings page for `sound`, so it needn't be set with `sqlite3`.
- [ ] Stop sharing the Argo admin credential: give each person an account and rotate the shared one (in `infrastructure`).
- [ ] Put the `svc` and `job` apps in their own Argo project, so the dashboard's role can be limited to them.
- [ ] Kubernetes events on the app page, through `GET /api/v1/applications/{app}/events`.
- [ ] A speed test panel (parked): Cloudflare's speed test on a timer, with small downloads every few minutes and a full test hourly.
- [ ] Rename the repo folder `agent-dashboard` to `foreman`.
