import { type AnchorHTMLAttributes, useEffect, useState } from "react";

export type Route = "dashboard" | "notifications" | "cluster";

const toRoute = (path: string): Route =>
  path.startsWith("/notifications") ? "notifications" : path.startsWith("/cluster") ? "cluster" : "dashboard";
const toPath = (r: Route) => (r === "notifications" ? "/notifications" : r === "cluster" ? "/cluster" : "/");

/** Small router on the History API; the server serves index.html for any path. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => toRoute(location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(toRoute(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}

/** The current query string, re-read on every navigation. */
export function useSearch(): URLSearchParams {
  const [search, setSearch] = useState(() => location.search);
  useEffect(() => {
    const onPop = () => setSearch(location.search);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return new URLSearchParams(search);
}

const href = (r: Route, search?: Record<string, string | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(search ?? {})) if (v) q.set(k, v);
  const qs = q.toString();
  return toPath(r) + (qs ? `?${qs}` : "");
};

export function navigate(r: Route, search?: Record<string, string | null | undefined>, opts: { replace?: boolean } = {}) {
  const next = href(r, search);
  if (location.pathname + location.search === next) return;
  const routeChanged = toRoute(location.pathname) !== r;
  if (opts.replace) history.replaceState(null, "", next);
  else history.pushState(null, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
  if (routeChanged) window.scrollTo(0, 0);
}

export function RouteLink({
  to,
  search,
  ...rest
}: { to: Route; search?: Record<string, string | null | undefined> } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...rest}
      href={href(to, search)}
      onClick={(e) => {
        rest.onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to, search);
      }}
    />
  );
}
