import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTHOR_KEYS, type AuthorKey, type Prefs } from "../core/types.ts";

const DEFAULT: Prefs = { authors: ["me", "claude"] };

/** Options set from the page's top bar, kept in `<dataDir>/prefs.json`. */
export class PrefsStore {
  private path: string;
  private prefs: Prefs = DEFAULT;

  constructor(dataDir: string) {
    this.path = join(dataDir, "prefs.json");
    if (existsSync(this.path)) {
      try {
        this.prefs = normalize(JSON.parse(readFileSync(this.path, "utf8")));
      } catch (e) {
        console.warn(`[prefs] using defaults, could not read ${this.path}: ${(e as Error).message}`);
      }
    }
  }

  get(): Prefs {
    return this.prefs;
  }

  set(next: unknown): Prefs {
    this.prefs = normalize(next);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.prefs, null, 2));
    renameSync(tmp, this.path);
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
