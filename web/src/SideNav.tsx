import type { ReactNode } from "react";
import type { Overall } from "../../core/nightShift.ts";
import { type Route, RouteLink } from "./router.tsx";

const NS_DOT: Record<Overall, string> = {
  ok: "Night Shift is healthy",
  deploying: "Night Shift is deploying",
  bad: "Night Shift is down or its last deploy failed",
  unknown: "Night Shift: no checks yet",
};

const Icon = ({ children }: { children: ReactNode }) => (
  <svg className="sidenav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

const ICONS: Record<Exclude<Route, "notifications">, ReactNode> = {
  ideas: (
    <Icon>
      <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
    </Icon>
  ),
  queue: (
    <Icon>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </Icon>
  ),
  dashboard: (
    <Icon>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v12M13 6h3a2 2 0 0 1 2 2v7" />
    </Icon>
  ),
  cluster: (
    <Icon>
      <rect x="3" y="3" width="18" height="7" rx="2" />
      <rect x="3" y="14" width="18" height="7" rx="2" />
      <path d="M7 6.5h.01M7 17.5h.01" />
    </Icon>
  ),
  "night-shift": (
    <Icon>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </Icon>
  ),
};

/** The page list, down the left side (a strip under the top bar on narrow screens). */
export function SideNav({ route, nightShift, blocked }: { route: Route; nightShift: Overall | null; blocked: number | null }) {
  const item = (to: Exclude<Route, "notifications">, label: string, extra?: ReactNode, title?: string) => (
    <RouteLink to={to} className={route === to ? "active" : ""} aria-current={route === to ? "page" : undefined} title={title}>
      {ICONS[to]}
      <span className="sidenav-label">{label}</span>
      {extra}
    </RouteLink>
  );
  return (
    <nav className="sidenav" aria-label="Pages">
      {item("ideas", "Ideas")}
      {item(
        "queue",
        "Queue",
        blocked ? (
          <span className="nav-count warn" aria-label={`${blocked} blocked, waiting on you`}>
            {blocked}
          </span>
        ) : null,
        blocked ? `${blocked} blocked ticket${blocked === 1 ? "" : "s"} waiting on you` : "Linear work with no PR yet",
      )}
      {item("dashboard", "PRs")}
      {item("cluster", "Cluster")}
      {item(
        "night-shift",
        "Night Shift",
        nightShift && <span className={`ns-dot ${nightShift}`} aria-label={NS_DOT[nightShift]} role="img" />,
        nightShift ? NS_DOT[nightShift] : undefined,
      )}
    </nav>
  );
}
