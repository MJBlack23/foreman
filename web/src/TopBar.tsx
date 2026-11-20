import type { Overall } from "../../core/nightShift.ts";
import type { Snapshot } from "../../core/types.ts";
import { type Route, RouteLink } from "./router.tsx";
import { OptionsMenu } from "./OptionsMenu.tsx";
import { PollStatus } from "./PollStatus.tsx";
import { BellIcon, FactoryIcon } from "./ui.tsx";

const NS_DOT: Record<Overall, string> = {
  ok: "Night Shift is healthy",
  deploying: "Night Shift is deploying",
  bad: "Night Shift is down or its last deploy failed",
  unknown: "Night Shift: no checks yet",
};

export function TopBar({
  snapshot,
  nightShift,
  connected,
  route,
}: {
  snapshot: Snapshot | null;
  nightShift: Overall | null;
  connected: boolean;
  route: Route;
}) {
  const unread = snapshot?.events.filter((e) => e.isNew).length ?? 0;
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <RouteLink to="dashboard" className="brand">
          <FactoryIcon />
          Foreman
        </RouteLink>
        <nav className="topnav" aria-label="Pages">
          <RouteLink to="dashboard" className={route === "dashboard" ? "active" : ""} aria-current={route === "dashboard" ? "page" : undefined}>
            PRs
          </RouteLink>
          <RouteLink to="cluster" className={route === "cluster" ? "active" : ""} aria-current={route === "cluster" ? "page" : undefined}>
            Cluster
          </RouteLink>
          <RouteLink
            to="night-shift"
            className={route === "night-shift" ? "active" : ""}
            aria-current={route === "night-shift" ? "page" : undefined}
            title={nightShift ? NS_DOT[nightShift] : undefined}
          >
            Night Shift
            {nightShift && <span className={`ns-dot ${nightShift}`} aria-label={NS_DOT[nightShift]} role="img" />}
          </RouteLink>
        </nav>
        {snapshot && <span className="repo">{snapshot.repo}</span>}

        <div className="topbar-right">
          <PollStatus snapshot={snapshot} connected={connected} />
          {snapshot?.login && <span className="login">@{snapshot.login}</span>}
          {snapshot && <OptionsMenu prefs={snapshot.prefs} login={snapshot.login} />}
          <RouteLink
            to="notifications"
            className={`bell ${route === "notifications" ? "active" : ""}`}
            aria-label={unread ? `Notifications, ${unread} new` : "Notifications"}
            title="Notifications"
          >
            <BellIcon />
            {unread > 0 && <span className="bell-count">{unread > 99 ? "99+" : unread}</span>}
          </RouteLink>
        </div>
      </div>
    </header>
  );
}
