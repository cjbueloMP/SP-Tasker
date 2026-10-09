# SP Tasker

Obsidian desktop plugin: one-way sync from a note's YAML frontmatter to a task in
[Super Productivity](https://super-productivity.com) (SP), via SP's local REST API. Nothing ever
syncs back from SP into Obsidian. Personal project, single user (the repo owner). Currently
distributed via GitHub Releases (manual install or BRAT); preparing for submission to the Obsidian
Community directory — see "Community directory submission".

Read [README.md](README.md) for user-facing behavior and [DEV.md](DEV.md) (if present — it's kept
off some branches) for the offline `data.json` repair script. This file is for a fresh coding
session: the design decisions and invariants that aren't obvious from reading the code once.

## Architecture

- Source is a single ES-module file, **`src/main.js`** (plain JS, no TypeScript, no runtime npm
  dependencies). It uses `import ... from 'obsidian'` / `export default class`, which the
  Community directory's lint (`no-require-imports`) requires. **esbuild** bundles it to the root
  `main.js` (CommonJS, `obsidian` external, deliberately **unminified** and no sourcemap in release
  builds — the developer policies prohibit obfuscation and reviewers read it). Root `main.js` is a
  build artifact and is **gitignored**; never edit it by hand.
- Commands: `npm run build` (one-off), `npm run dev` (watch), `npm run lint` (lints `src/` with
  `eslint-plugin-obsidianmd`, the ruleset the directory scanner runs). `esbuild.config.mjs`,
  `eslint.config.mjs`, `tsconfig.json` (only `allowJs`, so the type-checked rules can analyze the
  JS) are dev tooling and are never shipped. The scanner tracks the lint plugin's latest version,
  so `npm update` before releasing — rules change between versions. `node_modules/` is gitignored.
  Release assets stay `main.js` + `manifest.json` only.
- Adding a bundler was an explicit decision by the owner (who knows esbuild) to satisfy
  `no-require-imports`. Don't go further (no TypeScript, no extra deps) without discussing.
- Licensed MIT (`LICENSE`, © 2026 Collin Buelo). The directory requires a LICENSE file.
- `manifest.json` / `versions.json` at repo root are Obsidian's plugin metadata. Bump both together
  when releasing (see "Releasing" below).
- No `node` binary is reliably available in this project's usual dev sandbox (the owner runs
  lint/build via Docker or a local Node install) — there is no test suite, and often no way to run
  the build or lint here. Verify changes by careful manual reading, and always tell the user that
  real verification means running `npm run build` + `npm run lint` and loading the plugin in
  Obsidian.

## Data model (`data.json`, at `<vault>/.obsidian/plugins/sp-tasker/data.json`)

Persisted as one object: `{ settings, sent, refCounter }`. All three are written together via
`persist()` — never write just one piece, or you'll silently drop the others (this bit us once
during the settings-API migration; `PluginSettingTab.getControlValue`/`setControlValue` are
overridden specifically to route through `persist()` instead of Obsidian's default, which would
call `saveData(settings)` alone).

- `settings` — see `DEFAULT_SETTINGS` in `src/main.js`. `Object.assign({}, DEFAULT_SETTINGS, loaded)`
  on load backfills any newly-added key automatically; no migration script is needed for new
  settings.
- `sent` — keyed by SP task id: `{ content, full, path }`. Two designed-in signatures joined with
  `SEP = String.fromCharCode(1)`:
  - `content` = title + resolved project name + resolved tag name, plus `SEP + dueDay` **only when
    a due date is being sent**. It's appended conditionally on purpose: records written before the
    `start` feature never had one, so an unconditional component would invalidate every existing
    `sent` record and re-PATCH each note on its next edit.
  - `full` = `content + SEP + file.path`.
  - Auto-triggered sends short-circuit if `full` is unchanged. If only `content` still matches but
    `full` doesn't, that's a pure rename/move — only the notes-field link gets refreshed, since
    that path must never resurrect/reopen a completed task.
  - **This cache is disposable.** `sendFile` always re-verifies a note's task against SP by its own
    `sp_task_id` before deciding create-vs-update, so a missing/cleared `sent` record can't cause a
    duplicate — it just costs one extra SP round-trip. This is why the "Clear sync cache" button in
    Maintenance settings is safe, and why deleting `data.json` entirely doesn't corrupt anything
    (though it does reset `settings` to defaults — token, custom field names, etc. all need
    re-entering).
- `refCounter` — the next `sp_task_ref` number to hand out. **Once written into a note's
  frontmatter, that number belongs to the note permanently** — read from the note's own
  frontmatter, not from `this.sent`, specifically so a lost/cleared `sent` cache can never cause a
  note's visible `#<ref>` number to change or regress. See `plannedRef` in `sendFile`. Also
  self-heals on every Obsidian startup via `healCounter()` (scans all notes' `sp_task_ref`, raises
  the counter above the max found) — there is deliberately no manual "heal" command; automatic
  startup healing was judged sufficient and a manual trigger was removed as redundant.

## Non-destructive design philosophy

This governs most non-obvious decisions in the code — when in doubt, prefer the option that cannot
lose data or silently diverge Obsidian/SP state, even at the cost of an extra API call or a less
convenient recovery step:

- Never overwrite a task's `notes` field in SP unless it's empty or already looks like the
  plugin's own link format (`notesAreOurs()`). A user's own typed notes are never clobbered.
- Never auto-delete an orphaned SP task (e.g. one created but never linked back due to a
  frontmatter write failure) — recovery is left to the user, deliberately, even though the plugin
  could technically clean it up.
- Ambiguous input (two different `Project/` tags on one note) aborts with a notice rather than
  guessing which one to use.
- Project/tag lookups are read-only against SP by design — SP's REST API has no create endpoint
  for either, and the plugin doesn't try to work around that.

## Due dates (`start` property)

- `startToDueDay()` maps the note's `start` (`startFieldName`, default `start`) to SP's `dueDay`.
  Only `YYYY-MM-DD` is used (a trailing time is ignored), compared against local "today". **Today or
  later → sent; past, missing, or unparseable → `null` → nothing sent.** `start` is optional; a note
  with only `next` still sends normally.
- On create, a qualifying `start` sets `dueDay`. A **valid but past** `start` (`parseStartDay()`
  succeeds, `startToDueDay()` returned null) sets `dueDay` to **today** — "overdue means due now".
  This covers brand-new tasks and tasks recreated because the old one was done/archived/404 (all
  reach the create branch of `sendFile`); the update branch is untouched, so a task rescheduled in
  SP can't be snapped back. `contentSig` still uses `startToDueDay()` (null for past), so it never
  changes day to day. Otherwise (no/unparseable `start`), if `noDueDateOnCreate` (default on) is
  set, the payload carries `dueDay: null`. Reason: SP's `TaskService.add()` stamps `dueDay = today`
  when its Today view is the active work context, **unless the payload has a `dueDay` key at all**
  (`'dueDay' in additional`). The REST handler accepts `dueDay: string | null`, so `null` opts out.
  PATCH doesn't go through `add()`, so `noDueDateOnCreate` is create-only.
- On update, a **strictly future** `start` (`dueDay > localTodayStr()`) is included in the PATCH,
  and a `start` of **today** is included only when the SP task has no date yet (`current.dueDay`
  and `current.dueWithTime` both empty — e.g. `start` was added to a note after its task was
  created). Past/missing is left out. This asymmetry with create is deliberate: the owner
  reschedules unfinished same-day tasks in SP, and a note whose `start` is today must not snap
  them back on the next edit or manual send. A past/removed `start` therefore **never changes or
  clears** an existing SP due date (sending `null` could wipe a date set by hand in SP).
- Obsidian-first by decision: a strictly future `start` still overwrites a manually set SP due date
  whenever the note syncs (including a manual send). The owner confirmed this is intended.
- `dueDay` stays in `contentSig` for today-or-later starts regardless of whether the PATCH sends it;
  that only decides *when* an update fires, not what it carries.
- Owner's mental model: `start` means "when I started/will work on it", not a deadline. Once a
  task is underway (`start` today or past), SP owns its date — the owner pushes the next work
  session out in SP. Hence the update rule above. An SP date that has gone **overdue** is
  deliberately *not* treated as "no date": SP's own "finish day" feature rolls unfinished tasks to
  today, so the plugin doesn't need to.

## Obsidian-first fields (decided, not oversights)

- `tagIds` is sent on every update (`[]` when the note has no `waiting_on`), so tags added by hand
  in SP are cleared on the next sync. Intended: Obsidian is the source of truth for tags.
- `projectId` is sent on update only when the note has a `Project/` tag (Obsidian wins). With no
  tag, an update leaves SP's project alone, so a manual move in SP sticks while the task is alive.
  A task *recreated* (old one done/deleted) gets the note's project, else `defaultProjectName` —
  never the old task's project, because the owner wants projects edited in Obsidian.

## Default project (`defaultProjectName`, default `Inbox`)

`TaskService.add()` seeds `projectId` from the active work context, so a task created while a project
view is open in SP lands in that project even if the note names none. `additional` spreads last, so
an explicit `projectId` wins — but `WritableTaskFields.projectId` is `string`, **not** nullable, so
`projectId: null` (the `dueDay: null` trick) would fail validation. Instead, on create only, a note
with no `Project/` tag gets the project named by `defaultProjectName`, resolved with the same
read-only `findProject` lookup. Lookup failure/miss is non-fatal (falls back to SP's behaviour);
empty setting disables it. Update never touches `projectId` unless the note names a project, and
the project isn't part of `contentSig` for this fallback, so existing `sent` records stay valid.

## Frontmatter writes and the `processFrontMatter` race

`processFrontMatter` re-reads and re-parses the file **fresh from disk** each call — it does not
reuse the cached parse `sendFile` read at the top (`metadataCache.getFileCache`). This creates a
real (if narrow) race: if the user is still typing when a debounced auto-sync fires, the frontmatter
can be momentarily invalid YAML at the exact moment `processFrontMatter` runs, even though the
values `sendFile` already used (read earlier, from cache) were fine. Confirmed via Obsidian's own
docs that `processFrontMatter` can throw `YAMLParseError` for exactly this reason.

Mitigations in place (see `sendFile`'s create path):

1. `sp_task_ref` (fully plugin-generated, never comes from SP) is written to frontmatter **before**
   any SP network call. A failure here has touched nothing external — just release the reserved
   counter value and bail out like any other failed send.
2. `sp_task_id` (SP's own id, only known after `createTask` succeeds) must be written after
   creation — that's the one genuinely unavoidable ordering constraint. Checked against SP's actual
   source (`local-rest-api-handler.service.ts` in `super-productivity/super-productivity`): task
   `id` is not in `ALLOWED_TASK_FIELDS`/`WritableTaskFields`, so there is no way to have SP accept a
   client-supplied id or pre-reserve one. This ordering constraint is a hard API limitation, not a
   plugin design gap.
3. Both writes go through `writeFrontmatterWithRetry()` (exponential backoff, a few short retries)
   before giving up, since the race is transient (clears once the user stops typing) rather than
   real corruption — genuine corruption would have already caused `getFileCache().frontmatter` to
   come back empty/undefined, which `sendFile` checks for at the very top (empty `next` field means
   it never reaches SP at all).
4. If the `sp_task_id` write still fails after retries (SP task now exists, note doesn't point to
   it), the recovery notice deliberately doesn't ask the user to copy a raw UUID out of a
   `Notice` (which auto-dismisses) — the note already carries the correct `sp_task_ref`, and that
   same number is baked into the task's own title in SP (`#<ref> ...`), so a duplicate is
   recoverable by eye: look for two SP tasks sharing that title number.

## Settings tab (declarative API, Obsidian 1.13+)

`display()` is deprecated since 1.13.0; this plugin uses `getSettingDefinitions()` exclusively, no
fallback. Two API details that aren't obvious from a first read of `obsidian.d.ts`:

- **`action` vs `render`.** `action: (el, index) => void` is only invoked **when the row is
  clicked** — it does not render anything up front. Using it to build a persistent button (as an
  earlier version of this plugin did) produces exactly the bug we hit: no button visible until the
  row is clicked once, and a new button appended (never cleared) on every subsequent click. The
  correct construct for "always show a persistent, imperatively-built control" is
  `render: (setting, group) => void`, which mirrors the classic `new Setting(el).addButton(...)`
  pattern and is called once per row build. Both the "Test connection" and "Clear sync cache"
  buttons use `render`.
- `getControlValue`/`setControlValue` are overridden on `SPTaskerSettingTab` to route through
  `this.plugin.persist()` instead of Obsidian's default (which only saves `settings`, dropping
  `sent`/`refCounter`). Any new setting control added to `getSettingDefinitions()` gets this for
  free — no extra wiring needed per-field.

## Releasing

1. Bump `version` in `manifest.json` and add the matching entry to `versions.json` (both keyed
   identically, e.g. `"0.2.0": "1.13.7"`). In pre-1.0 semver, a breaking change bumps the **minor**
   version (`0.1.x` → `0.2.0`), not just the patch.
2. Tag the release commit with the version number **exactly**, no `v` prefix (e.g. `0.2.0`, not
   `v0.2.0`) — this is what both BRAT and Obsidian's own installer match against. (The directory
   preview scan flagged an earlier `v`-prefixed tag.)
3. Run `npm run lint` and `npm run build`. Create the GitHub Release from that tag, and **attach the
   freshly built `main.js` and `manifest.json` as
   individual binary assets** — not just relying on the auto-generated source zip. This is what
   BRAT and Obsidian's community-plugin installer actually download; they ignore the source archive
   entirely.
4. BRAT compatibility checklist: valid `manifest.json` at repo root (✓), a release tagged to match
   `version` with `main.js`+`manifest.json` attached (✓ once step 3 is done), repo must be public
   (or BRAT needs a PAT for a private repo). `versions.json` is *not* required by BRAT — that file
   matters for Obsidian's own Community Plugins updater, which this plugin isn't listed on.
5. Manual install on a second machine (non-BRAT): download `main.js`/`manifest.json` from the
   release assets, place both in `<vault>/.obsidian/plugins/sp-tasker/`, enable in Obsidian.

## Community directory submission

Since May 2026 there is no obsidian-releases PR queue. Submission is via the developer dashboard at
community.obsidian.md (Obsidian account + linked GitHub, pick the repo; it reads `manifest.json` at
the default branch HEAD). Review is automated and runs on **every release**, not just the first;
a failing version is dropped from in-app search within 24h. The dashboard has a preview scan for any
branch/tag/commit — use it before cutting a release. Details live in Obsidian's docs
(`docs.obsidian.md/community-directory/` and `/Plugins/Releasing/Plugin+guidelines`); don't rely on
older blog posts or forum threads describing the PR flow.

Requirements that bit or could bite this repo:

- Root needs `README.md`, `LICENSE`, `manifest.json`. README must **disclose network use** (name the
  remote service and why — here: Super Productivity's local REST API, authenticated with the user's
  token). No telemetry, no obfuscation, no self-updating allowed.
- `manifest.json` `description`: ≤250 chars, ends with a period, no emoji, starts with an action
  statement (not "This is a plugin"). `id` must not contain "obsidian". No `fundingUrl` unless
  accepting donations. `isDesktopOnly` stays `true`.
- Settings tab: no top-level heading named after the plugin/"settings" (the `SP Tasker` group in
  `getSettingDefinitions()` is a known violation to fix); UI strings in sentence case.
- No default hotkeys; command IDs must not contain the plugin ID.
- Lint locally with `npm run lint` (see Architecture). The scanner follows the latest
  `eslint-plugin-obsidianmd`, so a pinned old version passing is not proof the scan will pass.
- Version bump per release is mandatory for fixes — the scanner re-scans new releases only.

## Branch/workflow notes (fluid — verify before relying on this section)

The owner works across a few branches (`main`, `dev`, and sometimes short-lived local-only
branches for work they're not ready to merge/release, e.g. an in-progress opportunistic-retry
queue for when SP is unreachable). **Don't assume any specific branch's content from this file —
always check `git log --oneline --all --graph` and `git status` at the start of a session.** A
local branch may be intentionally kept unpushed indefinitely; don't push or merge branches unless
asked.

## Super Productivity API notes (learned by reading its actual source, not just its docs)

Source: `super-productivity/super-productivity` on GitHub (moved from `johannesjo/...`), local
server implementation in `electron/local-rest-api.ts` (transport) and
`src/app/core/electron/local-rest-api-handler.service.ts` (the actual route logic, in the Angular
app, forwarded over IPC).

- `POST /tasks` creates via `TaskService.add()`; the task `id` is always server/app-generated.
  There is no way to specify or pre-reserve an id — `id` is not in the whitelist of writable
  fields (`ALLOWED_TASK_FIELDS`).
- Writable task fields (create and PATCH) are whitelisted to: `title`, `notes`, `isDone`,
  `timeEstimate`, `timeSpent`, `projectId`, `tagIds`, plus the due/deadline fields. Anything else
  in the request body is silently dropped, not rejected.
- No create endpoint for projects or tags — this plugin's project/tag "resolution" is read-only
  lookup against `GET /projects` / `GET /tags` by exact `title`/`name` match, cached with exactly
  one refetch on a cache miss.
- 401 means a bad/rejected token; a genuine connectivity failure (SP not running) is a distinct
  error path — see `SPApiError`'s `retryable` flag (only set on the connectivity-failure branch of
  `SPClient.request()`), used to decide what's worth queueing for opportunistic retry on the
  in-progress retry-queue branch.
