# TODO

## Soon

- [ ] **Rename the Argo account `pr-dashboard` to `foreman`.** It still has the old app name.
  1. In `CloudSpot/infrastructure`, `apps/argo/values_prd.yaml` and `values_stg.yaml`: rename `accounts.pr-dashboard` and the `role:pr-dashboard` policy lines to `foreman`.
  2. Merge, then sync the `argocd` app by hand in each cluster. It doesn't auto-sync.
  3. Generate a new token for `foreman` in each Argo UI (Settings → Accounts) and put it in Doppler (`foreman` project, `prd` config).
  4. Update the account name in `server/argo.ts` (the permission error message) and `docs/specs/cluster-page.md`.

## Later

- [ ] Rename the `MERGE_WATCH_*` env vars to `FOREMAN_*`, keeping the old names working for a while.
- [ ] Retire the `merge-watch` data folder: its JSON files are imported into `foreman.db` and no longer read. Only the optional `argo.env` fallback still lives there; move it or drop it in favour of Doppler.
- [ ] A settings page for `sound`, so it needn't be set with `sqlite3`.
- [ ] Rename the repo folder `agent-dashboard` to `foreman`.
