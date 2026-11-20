import { type Db, transaction } from "./db.ts";

/** Seen ids older than this are pruned. */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Event ids already notified and ids viewed in the page, in the `seen` table. */
export class SeenStore {
  constructor(private db: Db) {}

  notifiedIds(): Set<string> {
    return this.ids("notified");
  }

  viewedIds(): Set<string> {
    return this.ids("viewed");
  }

  markNotified(ids: string[]) {
    this.mark("notified", ids);
  }

  markViewed(ids: string[]) {
    this.mark("viewed", ids);
  }

  private ids(kind: "notified" | "viewed"): Set<string> {
    const rows = this.db.prepare("SELECT id FROM seen WHERE kind = ?").all(kind) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  private mark(kind: "notified" | "viewed", ids: string[]) {
    if (!ids.length) return;
    const now = Date.now();
    const ins = this.db.prepare("INSERT OR IGNORE INTO seen (kind, id, at) VALUES (?, ?, ?)");
    transaction(this.db, () => {
      for (const id of ids) ins.run(kind, id, now);
      this.db.prepare("DELETE FROM seen WHERE at < ?").run(now - MAX_AGE_MS);
    });
  }
}
