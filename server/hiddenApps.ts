import type { Db } from "./db.ts";

const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/;

/**
 * Argo apps hidden from the Cluster page's list, in the `hidden_apps` table.
 * One list for both environments: the apps have the same names in each.
 */
export class HiddenAppsStore {
  constructor(private db: Db) {}

  list(): string[] {
    return (this.db.prepare("SELECT app FROM hidden_apps ORDER BY app").all() as { app: string }[]).map((r) => r.app);
  }

  /** Returns false for a name that can't be an Argo app. */
  set(app: string, hidden: boolean): boolean {
    if (!NAME_RE.test(app)) return false;
    if (hidden) this.db.prepare("INSERT OR IGNORE INTO hidden_apps (app, hidden_at) VALUES (?, ?)").run(app, new Date().toISOString());
    else this.db.prepare("DELETE FROM hidden_apps WHERE app = ?").run(app);
    return true;
  }
}
