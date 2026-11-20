import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/;

/**
 * Argo apps hidden from the Cluster page's list, kept in `<dataDir>/cluster-hidden.json`.
 * One list for both environments: the apps have the same names in each.
 */
export class HiddenAppsStore {
  private path: string;
  private apps = new Set<string>();

  constructor(dataDir: string) {
    this.path = join(dataDir, "cluster-hidden.json");
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as { hidden?: unknown };
        if (Array.isArray(raw.hidden)) for (const a of raw.hidden) if (typeof a === "string" && NAME_RE.test(a)) this.apps.add(a);
      } catch (e) {
        console.warn(`[hidden] starting empty, could not read ${this.path}: ${(e as Error).message}`);
      }
    }
  }

  list(): string[] {
    return [...this.apps].sort();
  }

  /** Returns false for a name that can't be an Argo app. */
  set(app: string, hidden: boolean): boolean {
    if (!NAME_RE.test(app)) return false;
    if (hidden === this.apps.has(app)) return true;
    if (hidden) this.apps.add(app);
    else this.apps.delete(app);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ hidden: this.list() }, null, 2) + "\n");
    renameSync(tmp, this.path);
    return true;
  }
}
