import { type AnchorHTMLAttributes, useEffect, useState } from "react";

export type Route = "dashboard" | "notifications";

const toRoute = (path: string): Route => (path.startsWith("/notifications") ? "notifications" : "dashboard");
const toPath = (r: Route) => (r === "notifications" ? "/notifications" : "/");

/** Two-page router on the History API; the server serves index.html for any path. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => toRoute(location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(toRoute(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}

export function navigate(r: Route) {
  if (toRoute(location.pathname) === r) return;
  history.pushState(null, "", toPath(r));
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function RouteLink({ to, ...rest }: { to: Route } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...rest}
      href={toPath(to)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
