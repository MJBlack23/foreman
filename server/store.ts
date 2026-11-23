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

  /**
   * Make the notified ids starting with `prefix` exactly `ids`, for alerts about
   * an ongoing condition: ids still true are kept fresh so pruning never re-fires
   * them, and ids no longer true are dropped so the condition alerts again next time.
   */
  syncNotified(prefix: string, ids: string[]) {
    const now = Date.now();
    const keep = new Set(ids);
    const rows = this.db.prepare("SELECT id FROM seen WHERE kind = 'notified' AND id LIKE ? || '%'").all(prefix) as { id: string }[];
    const upsert = this.db.prepare("INSERT INTO seen (kind, id, at) VALUES ('notified', ?, ?) ON CONFLICT DO UPDATE SET at = excluded.at");
    const del = this.db.prepare("DELETE FROM seen WHERE kind = 'notified' AND id = ?");
    transaction(this.db, () => {
      for (const r of rows) if (!keep.has(r.id)) del.run(r.id);
      for (const id of ids) upsert.run(id, now);
    });
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
