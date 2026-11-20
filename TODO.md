# TODO

## Soon

- [ ] **Rename the Argo account `pr-dashboard` to `foreman`.** It still has the old app name.
  1. In `CloudSpot/infrastructure`, `apps/argo/values_prd.yaml` and `values_stg.yaml`: rename `accounts.pr-dashboard` and the `role:pr-dashboard` policy lines to `foreman`.
  2. Merge, then sync the `argocd` app by hand in each cluster. It doesn't auto-sync.
  3. Generate a new token for `foreman` in each Argo UI (Settings → Accounts) and put it in Doppler (`foreman` project, `prd` config).
  4. Update the account name in `server/argo.ts` (the permission error message) and `docs/specs/cluster-page.md`.

## Later

- [ ] Rename the `merge-watch` data folder and `MERGE_WATCH_*` env vars to `foreman`, moving the existing folder on first start.
- [ ] Rename the repo folder `agent-dashboard` to `foreman`.
