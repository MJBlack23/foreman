import { AUTHOR_KEYS, type AuthorKey, type Prefs } from "../core/types.ts";
import { type Db, getSetting, setSetting } from "./db.ts";

const DEFAULT: Prefs = { authors: ["me", "claude"] };

/** Options set from the page's top bar, in the `settings` table under "prefs". */
export class PrefsStore {
  private prefs: Prefs;

  constructor(private db: Db) {
    this.prefs = normalize(getSetting(db, "prefs") ?? DEFAULT);
  }

  get(): Prefs {
    return this.prefs;
  }

  set(next: unknown): Prefs {
    this.prefs = normalize(next);
    setSetting(this.db, "prefs", this.prefs);
    return this.prefs;
  }
}

/** Known authors only, in a fixed order; at least one stays on. */
export function normalize(raw: unknown): Prefs {
  const list = (raw as Partial<Prefs> | null)?.authors;
  const authors = AUTHOR_KEYS.filter((k) => Array.isArray(list) && list.includes(k));
  return { authors: authors.length ? authors : DEFAULT.authors };
}

export type { AuthorKey };
