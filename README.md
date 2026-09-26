# SP Tasker

Obsidian plugin: editing a note's frontmatter creates or updates a matching task in [Super Productivity](https://super-productivity.com), via its local REST API. One direction only — nothing syncs back from SP into Obsidian.

## What it does

- `next` (frontmatter key name configurable) becomes the task title. Accepts a string, list, number, or boolean.
- `waiting_on` (frontmatter key name configurable; string or list) prefixes the title ("Waiting on Alex: ...", or "Alex and Sam" / "Alex, Sam and Jo" for a deduped list) and adds the configured reminder tag — untagged if that tag doesn't exist yet in SP.
- The note's `Project/<name>` tag (frontmatter or inline body), if present, picks the SP project. The prefix (`Project/` by default) is configurable and can be a comma-separated list of prefixes. Only the segment directly under the matched prefix is used, so `Project/Website` and `Project/Website/v2` collapse to the same project. Two *different* names abort the send rather than guessing. A note with no matching tag at all just creates a projectless task.
- Project and reminder tag both have to already exist in Super Productivity — the API is  read-only for both. If a note *has* a project tag but SP has no matching project, the send aborts (notice) rather than silently dropping it; a missing reminder tag just sends untagged.
- If a manual send is triggered on a note with no `next` value, a notice explains there's nothing to send (auto-triggered sends stay silent, since every keystroke touches frontmatter).
- Optionally (on by default, toggleable), the task's notes field gets a clickable markdown link back to the note (`[label](obsidian://open?vault=...&file=...)`), since SP only auto-linkifies http/https, not the `obsidian:` scheme.
- The plugin never overwrites notes you typed yourself in SP — only an empty field, a bare `obsidian://open?...` (old format), or its own current link format gets replaced.
- `sp_task_id` and `sp_task_ref` are written back into the note's frontmatter by the plugin. `sp_task_ref` is the note's permanent display number: once assigned it's read from the note itself rather than internal state, so it can't drift or get reassigned if `data.json` is ever lost. It only changes if the task it spawned in SP gets checked and then next gets changed. Then, a new task is created with a new ref string, but same ID# (because it comes from the same note).
- A successful send shows a brief confirmation notice.

Runs automatically (debounced, 250ms floor) whenever a note's frontmatter changes or the note is renamed, or immediately via the **Send current note to Super Productivity** command — which also force-resyncs even when nothing changed, and re-checks the task's live status in SP.

## Requirements

- Super Productivity desktop v14+, with the local REST API enabled (Settings → Misc, off by default) and its access token, listening on `http://127.0.0.1:3876`.
- Obsidian desktop — the API is bound to `127.0.0.1`, so this only works with both apps
  running on the same machine.

## Install

No build step, the plugin is pure javascript. Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/sp-tasker/`, then enable the plugin in Obsidian and set the API URL/token in its settings tab.

If updating the plugin, just drop the new main.js and manifest.json into the plugin directory, data.json stays the same and you won't have to re-enter your SP API token.

I may consider adding to obsidian office community plugins, but this plugin is still pretty new (but has over a month of testing by myself), so for now it's in beta and will be available direct or through BRAT.

## Idempotency

Every send computes two signatures for the note: `content` (title, resolved project name,resolved tag name) and `full` (content + the note's vault path), joined with a `\x01` separator and stored per SP task id.

- Auto-triggered sends return early when the `full` signature is unchanged. The manual command never short-circuits this way — it always re-checks the task with SP.
- If only the path changed (content signature still matches), the plugin refreshes the notes link and does nothing else — this is what stops a rename from reopening a completed task.
- Otherwise it fetches the task from SP: if it's still open, that task is PATCHed in place and keeps its existing `sp_task_ref`. If it's done, archived, or gone (404), a brand-new task is created instead, with a new sequential `sp_task_ref`.

If the plugin's `data.json` is lost, its ref counter can't restart at 1 and collide with numbers already written into the vault: on every startup (`layout-ready`) it automatically rescans all notes and raises the counter above the highest `sp_task_ref` found. It can't recover the old SP task ids though, so notes touched after data.json is lost will get a new task rather than update their old one.

Errors and warnings surface only as an Obsidian `Notice` plus `console.error`. Log view may be added in future.
