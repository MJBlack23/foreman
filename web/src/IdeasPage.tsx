import { type FormEvent, useEffect, useMemo, useState } from "react";
import { BOARD_STAGES, type Idea, type IdeaPatch, type Stage, STAGE_HINT, STAGE_LABEL, STAGES } from "../../core/ideas.ts";
import { formatAgo } from "../../core/pr.ts";
import { Toasts, useToasts } from "./ClusterActions.tsx";
import { Markdown } from "./Markdown.tsx";
import { navigate, useSearch } from "./router.tsx";
import { Ext, shortDate } from "./ui.tsx";

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return out as T;
}

/** The prompt "Talk to Claude" copies: enough for any Claude Code session to find the idea. */
const claudePrompt = (idea: Idea) =>
  `Let's think through idea #${idea.id} on my Foreman idea board ("${idea.title}"). ` +
  `Use the idea-board skill to read it, then grill me on it. Write what we decide back to the idea as you go.`;

/** /ideas: things Matt wants to do someday that aren't on the assembly line (Linear) yet. */
export function IdeasPage({ ideas, connected, now }: { ideas: Idea[] | null; connected: boolean; now: number }) {
  const toasts = useToasts();
  const search = useSearch();
  const openId = Number(search.get("id")) || null;
  const [filter, setFilter] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Ideas · Foreman";
  }, []);

  const tags = useMemo(() => [...new Set((ideas ?? []).flatMap((i) => i.tags))].sort(), [ideas]);
  if (!ideas) return <p className="muted">{connected ? "Loading…" : "Connecting to the Foreman server…"}</p>;

  const shown = filter ? ideas.filter((i) => i.tags.includes(filter)) : ideas;
  const open = openId ? ideas.find((i) => i.id === openId) : undefined;
  const select = (id: number | null) => navigate("ideas", { id: id ? String(id) : null });
  const fail = (what: string) => (e: unknown) => toasts.push(`${what}: ${(e as Error).message}`, "bad");

  const offBoard = (["line", "shelved"] as Stage[]).map((s) => ({ stage: s, items: shown.filter((i) => i.stage === s) }));

  return (
    <div className="ideas">
      <div className="page-head">
        <div>
          <h1>Ideas</h1>
          <p className="muted">
            Things you want to do but haven’t put on the line yet. Claude can read and write these too: hit “Talk to Claude” on an idea.
          </p>
        </div>
        <QuickCapture onCreate={(title) => api<Idea>("POST", "/api/ideas", { title }).then((i) => select(i.id), fail("Couldn’t add it"))} />
      </div>

      {tags.length > 0 && (
        <div className="idea-tags-filter">
          <button className={`tag ${filter ? "" : "active"}`} onClick={() => setFilter(null)}>
            all
          </button>
          {tags.map((t) => (
            <button key={t} className={`tag ${filter === t ? "active" : ""}`} onClick={() => setFilter(filter === t ? null : t)}>
              {t}
            </button>
          ))}
        </div>
      )}

      <div className="idea-board">
        {BOARD_STAGES.map((stage) => {
          const items = shown.filter((i) => i.stage === stage);
          return (
            <section key={stage} className={`idea-col ${stage}`} aria-label={STAGE_LABEL[stage]}>
              <header title={STAGE_HINT[stage]}>
                <span className="section-label">{STAGE_LABEL[stage]}</span>
                <span className="muted small">{items.length}</span>
              </header>
              {items.length === 0 && <p className="muted small idea-empty">{STAGE_HINT[stage]}</p>}
              {items.map((i) => (
                <IdeaCard key={i.id} idea={i} now={now} active={i.id === openId} onOpen={() => select(i.id)} />
              ))}
            </section>
          );
        })}
      </div>

      {offBoard.map(
        ({ stage, items }) =>
          items.length > 0 && (
            <details key={stage} className="idea-off">
              <summary>
                <span className="section-label">{STAGE_LABEL[stage]}</span> <span className="muted small">{items.length}</span>
              </summary>
              <ul>
                {items.map((i) => (
                  <li key={i.id}>
                    <button className="linkish" onClick={() => select(i.id)}>
                      {i.title}
                    </button>
                    {i.link && (
                      <Ext href={i.link} className="small">
                        {linkLabel(i.link)}
                      </Ext>
                    )}
                    <span className="muted small">{formatAgo(i.updatedAt, now)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ),
      )}

      {openId && !open && (
        <div className="banner">
          Idea #{openId} doesn’t exist (it may have been deleted).{" "}
          <button className="linkish" onClick={() => select(null)}>
            Close
          </button>
        </div>
      )}
      {open && (
        <IdeaDrawer
          key={open.id}
          idea={open}
          now={now}
          onClose={() => select(null)}
          onSave={(p) => api<Idea>("PATCH", `/api/ideas/${open.id}`, p).then(() => true, (e) => (fail("Couldn’t save")(e), false))}
          onNote={(body) => api<Idea>("POST", `/api/ideas/${open.id}/notes`, { author: "matt", body }).then(() => true, (e) => (fail("Couldn’t add the note")(e), false))}
          onDeleteNote={(noteId) => void api("DELETE", `/api/ideas/${open.id}/notes/${noteId}`).catch(fail("Couldn’t delete the note"))}
          onDelete={() =>
            api("DELETE", `/api/ideas/${open.id}`).then(() => {
              select(null);
              toasts.push(`Deleted “${open.title}”.`);
            }, fail("Couldn’t delete"))
          }
          onCopied={() => toasts.push("Copied. Paste it into any Claude Code session.")}
        />
      )}
      <Toasts items={toasts.items} onDismiss={toasts.dismiss} />
    </div>
  );
}

const linkLabel = (url: string) => (/linear\.app/.test(url) ? "Linear" : url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]);

function QuickCapture({ onCreate }: { onCreate: (title: string) => Promise<unknown> }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    await onCreate(title.trim());
    setBusy(false);
    setTitle("");
  };
  return (
    <form className="idea-capture" onSubmit={submit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Capture an idea…" aria-label="New idea" maxLength={200} />
      <button className="button primary" disabled={busy || !title.trim()}>
        Add
      </button>
    </form>
  );
}

function IdeaCard({ idea, now, active, onOpen }: { idea: Idea; now: number; active: boolean; onOpen: () => void }) {
  const last = idea.notes.at(-1);
  return (
    <button className={`idea-card ${active ? "active" : ""}`} onClick={onOpen}>
      <span className="idea-title">{idea.title}</span>
      {idea.pitch && <span className="idea-pitch">{idea.pitch}</span>}
      {idea.waitingOn && <span className="idea-waiting">After: {idea.waitingOn}</span>}
      <span className="idea-meta">
        {idea.tags.map((t) => (
          <span key={t} className="tag">
            {t}
          </span>
        ))}
        <span className="muted small idea-when">
          {idea.notes.length > 0 && (
            <span className={last?.author === "claude" ? "claude-mark" : undefined} title={`Last note from ${last?.author === "claude" ? "Claude" : "you"}`}>
              {idea.notes.length} note{idea.notes.length === 1 ? "" : "s"} ·{" "}
            </span>
          )}
          {formatAgo(idea.updatedAt, now)}
        </span>
      </span>
    </button>
  );
}

interface Draft {
  title: string;
  pitch: string;
  body: string;
  stage: Stage;
  waitingOn: string;
  tags: string;
  link: string;
}

const toDraft = (i: Idea): Draft => ({
  title: i.title,
  pitch: i.pitch,
  body: i.body,
  stage: i.stage,
  waitingOn: i.waitingOn,
  tags: i.tags.join(", "),
  link: i.link,
});

function IdeaDrawer({
  idea,
  now,
  onClose,
  onSave,
  onNote,
  onDeleteNote,
  onDelete,
  onCopied,
}: {
  idea: Idea;
  now: number;
  onClose: () => void;
  onSave: (p: IdeaPatch) => Promise<boolean>;
  onNote: (body: string) => Promise<boolean>;
  onDeleteNote: (id: number) => void;
  onDelete: () => void;
  onCopied: () => void;
}) {
  const [draft, setDraft] = useState(() => toDraft(idea));
  const [base, setBase] = useState(() => toDraft(idea));
  const [editingBody, setEditingBody] = useState(!idea.body);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);

  // Take changes made elsewhere (Claude, another tab) unless you have unsaved edits.
  const server = toDraft(idea);
  const dirty = (Object.keys(draft) as (keyof Draft)[]).some((k) => draft[k] !== base[k]);
  const serverChanged = (Object.keys(server) as (keyof Draft)[]).some((k) => server[k] !== base[k]);
  useEffect(() => {
    if (!serverChanged) return;
    setBase(server);
    if (dirty) setStale(true);
    else setDraft(server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idea.updatedAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !dirty && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, onClose]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    const patch: IdeaPatch = {};
    for (const k of Object.keys(draft) as (keyof Draft)[]) {
      if (draft[k] === base[k]) continue;
      if (k === "tags") patch.tags = draft.tags.split(",").map((t) => t.trim()).filter(Boolean);
      else if (k === "stage") patch.stage = draft.stage;
      else patch[k] = draft[k];
    }
    setSaving(true);
    if (await onSave(patch)) {
      setBase(draft);
      setStale(false);
      setEditingBody(false);
    }
    setSaving(false);
  };

  // Stage changes save at once: it's the thing you most often change on its own.
  const setStage = async (stage: Stage) => {
    set("stage", stage);
    if (await onSave({ stage })) setBase((b) => ({ ...b, stage }));
  };

  const addNote = async (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    if (await onNote(note)) setNote("");
  };

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(claudePrompt(idea));
    onCopied();
  };

  return (
    <aside className="idea-drawer" aria-label={`Idea: ${idea.title}`}>
      <div className="idea-drawer-head">
        <span className="muted small">
          #{idea.id} · captured {shortDate(idea.createdAt)}
        </span>
        <button className="button claude-btn" onClick={copyPrompt} title={claudePrompt(idea)}>
          Talk to Claude
        </button>
        <button className="rule-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <input className="idea-title-input" value={draft.title} onChange={(e) => set("title", e.target.value)} aria-label="Title" maxLength={200} />
      <textarea
        className="idea-pitch-input"
        value={draft.pitch}
        onChange={(e) => set("pitch", e.target.value)}
        placeholder="The pitch: what, and why it’s worth doing."
        aria-label="Pitch"
        rows={3}
      />

      <div className="idea-fields">
        <label>
          <span className="section-label">Stage</span>
          <select value={draft.stage} onChange={(e) => void setStage(e.target.value as Stage)}>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="section-label">Waiting on</span>
          <input value={draft.waitingOn} onChange={(e) => set("waitingOn", e.target.value)} placeholder="e.g. the email rewrite" />
        </label>
        <label>
          <span className="section-label">Tags</span>
          <input value={draft.tags} onChange={(e) => set("tags", e.target.value)} placeholder="email, claude" />
        </label>
        <label>
          <span className="section-label">Link</span>
          <input value={draft.link} onChange={(e) => set("link", e.target.value)} placeholder="Linear URL, once it’s on the line" />
        </label>
      </div>

      <div className="idea-body">
        <div className="idea-body-head">
          <span className="section-label">The thinking so far</span>
          <button className="linkish small" onClick={() => setEditingBody((v) => !v)}>
            {editingBody ? "Preview" : "Edit"}
          </button>
        </div>
        {editingBody ? (
          <textarea
            value={draft.body}
            onChange={(e) => set("body", e.target.value)}
            rows={12}
            placeholder={"How it could work, open questions, what it depends on. Markdown.\n\n## Approach\n- …\n\n## Open questions\n- …"}
          />
        ) : draft.body ? (
          <Markdown text={draft.body} />
        ) : (
          <p className="muted small">Nothing yet.</p>
        )}
      </div>

      <div className="idea-save">
        <button className="button primary" onClick={save} disabled={!dirty || saving || !draft.title.trim()}>
          {saving ? "Saving…" : "Save"}
        </button>
        {dirty && (
          <button className="button" onClick={() => (setDraft(base), setStale(false))}>
            Discard
          </button>
        )}
        {dirty && stale && <span className="small idea-stale">This idea changed elsewhere while you were editing. Save keeps your edits to the fields you changed.</span>}
        <button
          className="linkish small danger-link"
          onClick={() => confirm(`Delete “${idea.title}” and its notes? Shelving keeps it.`) && onDelete()}
        >
          Delete
        </button>
      </div>

      <div className="idea-notes">
        <span className="section-label">Notes</span>
        {idea.notes.length === 0 && <p className="muted small">No notes yet. Claude adds notes here when you talk an idea through.</p>}
        {idea.notes.map((n) => (
          <div key={n.id} className={`idea-note ${n.author}`}>
            <div className="idea-note-head">
              <strong>{n.author === "claude" ? "Claude" : "You"}</strong>
              <span className="muted small">{formatAgo(n.at, now)}</span>
              <button className="rule-x" onClick={() => confirm("Delete this note?") && onDeleteNote(n.id)} aria-label="Delete note">
                ×
              </button>
            </div>
            <Markdown text={n.body} />
          </div>
        ))}
        <form onSubmit={addNote} className="idea-note-form">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a thought…"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void addNote(e);
            }}
          />
          <button className="button" disabled={!note.trim()}>
            Add note
          </button>
        </form>
      </div>
    </aside>
  );
}
