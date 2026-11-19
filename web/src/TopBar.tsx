import type { Snapshot } from "../../core/types.ts";
import { type Route, RouteLink } from "./router.tsx";
import { OptionsMenu } from "./OptionsMenu.tsx";
import { PollStatus } from "./PollStatus.tsx";
import { BellIcon } from "./ui.tsx";

export function TopBar({ snapshot, connected, route }: { snapshot: Snapshot | null; connected: boolean; route: Route }) {
  const unread = snapshot?.events.filter((e) => e.isNew).length ?? 0;
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <RouteLink to="dashboard" className="brand">
          <span className="logo" aria-hidden />
          PR Dashboard
        </RouteLink>
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
