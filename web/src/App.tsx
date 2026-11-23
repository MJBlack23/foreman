import { useEffect } from "react";
import { ClusterPage } from "./ClusterPage.tsx";
import { isRunActive } from "../../core/match.ts";
import { SNAPSHOT_SCHEMA } from "../../core/types.ts";
import { useBuildReload, useNow, useSnapshot } from "./hooks.ts";
import { IdeasPage } from "./IdeasPage.tsx";
import { NightShiftPage } from "./NightShiftPage.tsx";
import { NotificationsPage } from "./NotificationsPage.tsx";
import { QueuePage } from "./QueuePage.tsx";
import { blockedCount } from "../../core/queue.ts";
import { PrTabs } from "./PrList.tsx";
import { RunsPanel } from "./RunsPanel.tsx";
import { StatsBand } from "./StatsBand.tsx";
import { useRoute } from "./router.tsx";
import { SideNav } from "./SideNav.tsx";
import { TopBar } from "./TopBar.tsx";

export function App() {
  const { snapshot, nightShift, ideas, queue, connected } = useSnapshot();
  const route = useRoute();
  const now = useNow();
  useBuildReload();

  let body;
  if (route === "cluster") {
    body = <ClusterPage now={now} />;
  } else if (route === "night-shift") {
    body = <NightShiftPage state={nightShift} connected={connected} now={now} />;
  } else if (route === "ideas") {
    body = <IdeasPage ideas={ideas} connected={connected} now={now} />;
  } else if (route === "queue") {
    body = <QueuePage state={queue} connected={connected} now={now} />;
  } else if (snapshot && snapshot.schema !== SNAPSHOT_SCHEMA) {
    body = (
      <div className="banner">
        The Foreman server is running older code than this page. Stop it and run <code>pnpm start</code> again.
      </div>
    );
  } else if (!snapshot || (!snapshot.lastPollAt && !snapshot.lastError)) {
    body = <p className="muted">{snapshot ? "Fetching your PRs and runs from GitHub…" : "Connecting to the Foreman server…"}</p>;
  } else if (route === "notifications") {
    body = <NotificationsPage events={snapshot.events} typicalMs={snapshot.typicalMs} now={now} />;
  } else {
    body = (
      <>
      <StatsBand merges={snapshot.merges} now={now} />
      <div className="layout">
        <div className="main-col">
          <PrTabs prs={snapshot.prs} typicalMs={snapshot.typicalMs} now={now} />
        </div>
        <RunsPanel runs={snapshot.myRuns} hidden={snapshot.myRunsHidden} typicalMs={snapshot.typicalMs} now={now} />
      </div>
      </>
    );
  }

  const activeRuns = snapshot?.prs.filter((p) => p.run && isRunActive(p.run)).length ?? 0;
  useEffect(() => {
    if (route === "cluster" || route === "night-shift" || route === "ideas" || route === "queue") return;
    document.title = activeRuns ? `(${activeRuns} building) Foreman` : "Foreman";
  }, [activeRuns, route]);

  return (
    <>
      <TopBar
        snapshot={snapshot?.schema === SNAPSHOT_SCHEMA ? snapshot : null}
        connected={connected}
        route={route}
      />
      <div className="shell">
        <SideNav route={route} nightShift={nightShift?.overall ?? null} blocked={queue?.configured ? blockedCount(queue) : null} />
        <main>
        {snapshot?.lastError && route !== "cluster" && route !== "night-shift" && route !== "ideas" && route !== "queue" && <div className="banner">GitHub poll failed: {snapshot.lastError}</div>}
        {body}
        </main>
      </div>
    </>
  );
}
