# SP Tasker

Obsidian plugin: editing a note's frontmatter creates or updates a matching task in
[Super Productivity](https://super-productivity.com), via its local REST API. One direction
only — nothing syncs back from SP into Obsidian.

## What it does

- `next` becomes the task title. Accepts a string, list, number, or boolean.
- `waiting_on` (string or list) prefixes the title ("Waiting on Alex: ...", or "Alex and Sam" /
  "Alex, Sam and Jo" for a deduped list) and adds the configured reminder tag — untagged if that
  tag doesn't exist yet in SP.
- The note's `Project/<name>` tag (frontmatter or inline body, via `getAllTags`), if present,
  picks the SP project. Only the segment directly under `Project/` is used, so `Project/Website`
  and `Project/Website/v2` collapse to the same project; two *different* names abort the send
  rather than guessing. A note with no `Project/` tag at all just creates a projectless task.
- Project and reminder tag both have to already exist in Super Productivity — the API is
  read-only for both. If a note *has* a `Project/<name>` tag but SP has no matching project, the
  send aborts (notice) rather than silently dropping it; a missing reminder tag just sends
  untagged.
- The task's notes field gets a clickable markdown link back to the note
  (`[label](obsidian://open?vault=...&file=...)`), since SP only auto-linkifies http/https, not
  the `obsidian:` scheme.
- The plugin never overwrites notes you typed yourself in SP — only an empty field, a bare
  `obsidian://open?...` (old format), or its own current link format gets replaced.
- `sp_task_id` and `sp_task_ref` are written back into the note's frontmatter by the plugin.

Runs automatically (debounced, 250ms floor) whenever a note's frontmatter changes or the note is
renamed, or immediately via the **Send current note to Super Productivity** command — which also
force-resyncs even when nothing changed, and re-checks the task's live status in SP.

## Requirements

- Super Productivity desktop v14+, with the local REST API enabled
  (Settings → Misc, off by default) and its access token, listening on `http://127.0.0.1:3876`.
- Obsidian desktop — the API is bound to `127.0.0.1`, so this only works with both apps
  running on the same machine.

## Install

No build step. Copy `main.js` and `manifest.json` into
`<vault>/.obsidian/plugins/sp-tasker/`, then enable the plugin in Obsidian and set the API
URL/token in its settings tab.

## Idempotency, precisely

Every send computes two signatures for the note: `content` (title, resolved project name,
resolved tag name) and `full` (content + the note's vault path), joined with a `\x01` separator
and stored per SP task id.

- Auto-triggered sends return early when the `full` signature is unchanged. The manual command
  never short-circuits this way — it always re-checks the task with SP.
- If only the path changed (content signature still matches), the plugin refreshes the notes
  link and does nothing else — this is what stops a rename from reopening a completed task.
- Otherwise it fetches the task from SP: if it's still open, that task is PATCHed in place and
  keeps its existing `sp_task_ref`. If it's done, archived, or gone (404), a brand-new task is
  created instead, with a new sequential `sp_task_ref`.

If the plugin's `data.json` is lost, its ref counter can't restart at 1 and collide with numbers
already written into the vault: on every startup (`layout-ready`) it automatically rescans all
notes and raises the counter above the highest `sp_task_ref` found — no command or button needed.
It can't recover the old SP task ids though, so notes touched after data.json is lost will get a
new task rather than update their old one.

Errors and warnings surface only as an Obsidian `Notice` plus `console.error` — no status bar, no
log view.
