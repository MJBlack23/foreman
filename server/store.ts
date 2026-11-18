import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pruneSeen } from "../core/seen.ts";

interface StoreFile {
  /** Event ids already sent as notifications, so a restart doesn't re-notify. */
  notified: Record<string, number>;
  /** Event ids the user has looked at in the page; others show "New". */
  viewed: Record<string, number>;
}

export class SeenStore {
  private path: string;
  private data: StoreFile = { notified: {}, viewed: {} };
  /** True when there was no file yet (first ever run). */
  readonly fresh: boolean;

  constructor(dataDir: string) {
    this.path = join(dataDir, "seen.json");
    this.fresh = !existsSync(this.path);
    if (!this.fresh) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoreFile>;
        this.data = { notified: raw.notified ?? {}, viewed: raw.viewed ?? {} };
      } catch (e) {
        console.warn(`[store] starting fresh, could not read ${this.path}: ${(e as Error).message}`);
      }
    }
  }

  notifiedIds(): Set<string> {
    return new Set(Object.keys(this.data.notified));
  }

  viewedIds(): Set<string> {
    return new Set(Object.keys(this.data.viewed));
  }

  markNotified(ids: string[]) {
    this.mark("notified", ids);
  }

  markViewed(ids: string[]) {
    this.mark("viewed", ids);
  }

  private mark(key: keyof StoreFile, ids: string[]) {
    const now = Date.now();
    let changed = false;
    for (const id of ids) {
      if (!(id in this.data[key])) {
        this.data[key][id] = now;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private save() {
    const now = Date.now();
    this.data = { notified: pruneSeen(this.data.notified, now), viewed: pruneSeen(this.data.viewed, now) };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
