// Idea board: things Matt wants to do someday but hasn't put on the assembly line (Linear) yet.

/**
 * Where an idea sits. Not a workflow: an idea can move in any direction, and most never leave "spark".
 * "active" is a big project in progress alongside other work; "line" means it has become real work
 * (a Linear issue or project); "shelved" means not doing it.
 */
export const STAGES = ["spark", "shaping", "waiting", "ready", "active", "line", "shelved"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  spark: "Spark",
  shaping: "Shaping",
  waiting: "Waiting on something",
  ready: "Ready for the line",
  active: "Active project",
  line: "On the line",
  shelved: "Shelved",
};

export const STAGE_HINT: Record<Stage, string> = {
  spark: "Just captured. No thinking done yet.",
  shaping: "Being thought through: how it could work, what it needs.",
  waiting: "Blocked on other work landing first.",
  ready: "Clear enough to become a Linear project or issue.",
  active: "A big thing you're working on in parallel with everything else.",
  line: "Now tracked in Linear.",
  shelved: "Decided not to do it, for now.",
};

/** Columns on the board; "active" is listed under it, and "line" and "shelved" sit in collapsed lists below that. */
export const BOARD_STAGES: Stage[] = ["spark", "shaping", "waiting", "ready"];

export type Author = "matt" | "claude";

export interface IdeaNote {
  id: number;
  ideaId: number;
  author: Author;
  body: string;
  at: string;
}

export interface Idea {
  id: number;
  title: string;
  /** One or two sentences: what and why. */
  pitch: string;
  /** Markdown: the thinking so far (approach, open questions, risks). */
  body: string;
  stage: Stage;
  /** What has to happen first, e.g. "the email rewrite". Shown on the card. */
  waitingOn: string;
  tags: string[];
  /** Linear (or other) link once it's on the line. */
  link: string;
  createdAt: string;
  updatedAt: string;
  notes: IdeaNote[];
}

export interface IdeaPatch {
  title?: string;
  pitch?: string;
  body?: string;
  stage?: Stage;
  waitingOn?: string;
  tags?: string[];
  link?: string;
}

export const isStage = (s: unknown): s is Stage => typeof s === "string" && (STAGES as readonly string[]).includes(s);

const LIMITS = { title: 200, pitch: 2_000, body: 50_000, waitingOn: 300, link: 1_000, tag: 40, tags: 12, note: 20_000 };

/** Checks a create/update body. Returns the clean patch or an error message. */
export function parsePatch(input: unknown, { requireTitle }: { requireTitle: boolean }): IdeaPatch | string {
  if (!input || typeof input !== "object") return "Expected a JSON object.";
  const o = input as Record<string, unknown>;
  const out: IdeaPatch = {};
  for (const k of ["title", "pitch", "body", "waitingOn", "link"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "string") return `${k} must be a string.`;
    const v = (o[k] as string).trim();
    if (v.length > LIMITS[k]) return `${k} is longer than ${LIMITS[k]} characters.`;
    out[k] = v;
  }
  if (out.link && !/^https?:\/\//.test(out.link)) return "link must start with http:// or https://.";
  if (o.stage !== undefined) {
    if (!isStage(o.stage)) return `stage must be one of ${STAGES.join(", ")}.`;
    out.stage = o.stage;
  }
  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags) || o.tags.some((t) => typeof t !== "string")) return "tags must be an array of strings.";
    const tags = [...new Set((o.tags as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean))];
    if (tags.length > LIMITS.tags || tags.some((t) => t.length > LIMITS.tag)) return `At most ${LIMITS.tags} tags of ${LIMITS.tag} characters.`;
    out.tags = tags;
  }
  if (requireTitle && !out.title) return "title is required.";
  if (out.title === "") return "title can't be empty.";
  return out;
}

export function parseNote(input: unknown): { author: Author; body: string } | string {
  if (!input || typeof input !== "object") return "Expected a JSON object.";
  const { author = "matt", body } = input as Record<string, unknown>;
  if (author !== "matt" && author !== "claude") return "author must be matt or claude.";
  if (typeof body !== "string" || !body.trim()) return "body is required.";
  if (body.length > LIMITS.note) return `body is longer than ${LIMITS.note} characters.`;
  return { author, body: body.trim() };
}
