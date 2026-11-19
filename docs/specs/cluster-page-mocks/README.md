# Cluster page mocks

These are static mocks of the Cluster page described in [../cluster-page.md](../cluster-page.md). They use sample data built from real app and PR names, and they're drawn in light mode only.

The live canvas is at https://claude.ai/artifact/ThVXu5TWot1AMHgDw8zqVk. It's private to its owner, so share it from its Share menu before sending the link to anyone.

The `.dc.html` files are the canvas's source. Each one loads `./support.js` from the canvas runtime, so they don't render when opened straight from this folder. Open the canvas link to view them. `canvas.json` holds the layout.

| File | Screen | Spec section |
|---|---|---|
| `Main.dc.html` | Prod app list: Services and Jobs, problems first, running commit and PR for each app | Which apps are shown; Commit and PR on each pod |
| `AppDetail.dc.html` | One app mid-rollout: rolling-out and replaced commits, pods, resources, actions | Commit and PR on each pod; Write safety |
| `Logs.dc.html` | Live tail with the previous-container toggle, pause, and include and exclude rules | Log filter |
| `Staging.dc.html` | Staging tab with its own color, plus the Cloudflare, Argo-permission and not-configured states | Errors; Prerequisites |
| `SyncDialog.dc.html` | Prod Refresh & sync confirm with the image diff, pinned to the previewed revision | Write safety |
| `RestartDialog.dc.html` | Prod restart confirm listing the pods to be replaced | Write safety |
| `DeployLinks.dc.html` | PR card and deploy-run panel showing live, rolling, waiting and replaced for each target app | Linking deploy runs to apps |
