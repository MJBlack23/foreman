---
name: idea-board
description: Read and write Matt's idea board in Foreman (the Ideas tab at localhost:7896/ideas). Use when Matt says "add this to my ideas", "capture this idea", "idea board", mentions an idea by number ("idea #3"), wants to think an idea through, or asks what ideas are waiting on something. Ideas are not tasks and not Linear issues; they're things he wants to do someday.
---

# Idea board

Foreman keeps Matt's ideas: things he wants to do but hasn't planned or put on the assembly line (Linear) yet. The board is the shared memory between Matt and Claude, so Claude doesn't need to keep an idea in context: **read the idea before discussing it, and write what was decided back to it before the conversation ends.**

Foreman runs locally on `http://localhost:7896`. If `curl` can't connect, tell Matt to start it (`pnpm start` in the agent-dashboard repo) instead of keeping the idea somewhere else.

## What an idea holds

| Field | Use it for |
|---|---|
| `title` | Short name. |
| `pitch` | One or two sentences: what and why. Shown on the card. |
| `body` | Markdown: the thinking so far. Keep it a current, tidy picture (approach, open questions, dependencies, risks), not a log. Use `##` headings and `-` lists. |
| `stage` | `spark` (just captured) · `shaping` (being thought through) · `waiting` (blocked on other work) · `ready` (clear enough for Linear) · `active` (a big project Matt is working on in parallel with other work; listed under the board, and `waitingOn` says what it's waiting for) · `line` (now in Linear) · `shelved` (not doing it). |
| `waitingOn` | What has to happen first, e.g. "the email rewrite". Set it with stage `waiting`, or on an `active` project that's stuck. |
| `tags` | Lowercase words, e.g. `["email", "claude"]`. |
| `link` | The Linear URL once it's on the line. |
| `notes` | A thread. Add a note (author `claude`) for each conversation: what was discussed, what changed, what's still open. |

## Calls

Every write needs `-H 'content-type: application/json'`.

```bash
# All ideas (with notes), most recently updated first
curl -s localhost:7896/api/ideas | jq '.[] | {id, title, stage, waitingOn, tags}'

# One idea
curl -s localhost:7896/api/ideas/3

# Capture a new one (only title is required; stage defaults to spark)
curl -s -X POST localhost:7896/api/ideas -H 'content-type: application/json' \
  -d '{"title":"…","pitch":"…","tags":["…"]}'

# Change fields (send only what changes)
curl -s -X PATCH localhost:7896/api/ideas/3 -H 'content-type: application/json' \
  -d '{"stage":"waiting","waitingOn":"the email rewrite"}'

# Add a note from Claude
curl -s -X POST localhost:7896/api/ideas/3/notes -H 'content-type: application/json' \
  -d '{"author":"claude","body":"…"}'
```

For a long `body` or note, build the JSON with `jq -n --arg body "$text" '{body: $body}'` rather than escaping by hand. Deleting (`DELETE /api/ideas/:id`) is for Matt to do from the page; suggest `shelved` instead.

## How to work an idea

1. **Capture fast.** When Matt mentions something he wants to do someday, capture it with a title, a pitch in his words, and tags. Don't plan it. If it obviously depends on other work, set `waiting` and `waitingOn`. Tell him the id.
2. **Thinking it through** (Matt pasted the "Talk to Claude" prompt, which runs `/grill-me`, or asked): read the idea and its notes first. Then ask questions one at a time, the way the grilling skill does, and check the codebase where that answers a question better than asking. Update `body` as the picture sharpens and move `stage` to `shaping`.
3. **Before you finish**, PATCH the `body` so it reflects where things stand, and add one note summarising this conversation (decisions, open questions, next step). The page updates live.
4. **Ready for the line**: when the approach is clear, set `ready`. Only create Linear issues if Matt asks; then set `stage: "line"` and `link`.

Don't turn the board into a todo list: no checklists of tasks, no dates, no assignees.
