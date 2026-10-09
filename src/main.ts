import { Plugin, Notice, TFile, getAllTags } from 'obsidian';
import type { TAbstractFile } from 'obsidian';
import {
	errMsg,
	toText,
	joinGrammatical,
	renderTemplate,
	encodeLinkComponent,
	parsePrefixList,
	parseStartDay,
	startToDueDay,
	localTodayStr,
	notesAreOurs,
	readSent,
} from './helpers';
import type { SentRecord, SentMap } from './helpers';
import { SPClient, isRetryable } from './sp-client';
import type { SPTask, SPNamed, TaskPayload } from './sp-client';
import { SPTaskerSettingTab, DEFAULT_SETTINGS, MIN_DEBOUNCE_MS } from './settings';
import type { SPSettings } from './settings';

const SEP = String.fromCharCode(1); // avoids a literal control byte in the source

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

interface PersistedData {
	settings?: Partial<SPSettings>;
	sent?: unknown;
	refCounter?: unknown;
}

const TITLE_MAX_LEN = 300;

// ---------------------------------------------------------------------------
// Main plugin
// ---------------------------------------------------------------------------

export default class SPTaskerPlugin extends Plugin {
	settings!: SPSettings;
	sent!: SentMap;
	refCounter!: number;
	client!: SPClient;
	private _timers!: Map<string, number>; // path -> timeout id
	private pendingRetry!: Set<string>; // paths that failed to reach SP; retried opportunistically, in-memory only

	async onload() {
		const loaded = ((await this.loadData()) as PersistedData | null) ?? {};
		this.settings = { ...DEFAULT_SETTINGS, ...loaded.settings };
		this.sent = readSent(loaded.sent);
		this.refCounter = typeof loaded.refCounter === 'number' ? loaded.refCounter : 1;

		this.client = new SPClient(
			() => this.settings.apiBaseUrl,
			() => this.settings.apiToken
		);

		this._timers = new Map();
		this.pendingRetry = new Set();

		this.addSettingTab(new SPTaskerSettingTab(this.app, this));

		this.addCommand({
			id: 'send-current-note',
			name: 'Send current note to Super Productivity',
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					new Notice('SP Tasker: no active note.');
					return;
				}
				void this.sendFile(file, { manual: true });
			},
		});

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (this.settings.autoSync) this.scheduleSend(file);
			})
		);

		this.registerEvent(
			this.app.vault.on('rename', (file) => {
				if (this.settings.autoSync && file instanceof TFile && file.extension === 'md') {
					this.scheduleSend(file);
				}
			})
		);

		this.app.workspace.onLayoutReady(() => void this.healCounter());
	}

	onunload() {
		for (const timer of this._timers.values()) window.clearTimeout(timer);
		this._timers.clear();
	}

	async persist() {
		await this.saveData({ settings: this.settings, sent: this.sent, refCounter: this.refCounter });
	}

	notify(msg: string) {
		new Notice(`SP Tasker: ${msg}`);
		console.error(`[SP Tasker] ${msg}`);
	}

	notifySuccess(msg: string) {
		new Notice(`SP Tasker: ${msg}`);
	}

	// Forces every note to re-verify against SP on its next send instead of
	// trusting cached signatures - safe because sendFile always re-checks the
	// live task by the note's own sp_task_id before deciding create vs.
	// update, so a cleared cache can't cause a duplicate task.
	async clearSent() {
		this.sent = {};
		await this.persist();
	}

	// Called right after any send actually reaches SP successfully - that's
	// proof SP is back up, so opportunistically retry other notes that
	// previously failed to connect, instead of polling on a timer. In-memory
	// only: a note stuck here is forgotten on Obsidian restart and just falls
	// back to needing a manual edit/send, same as before this existed.
	async flushPendingRetries(excludePath: string) {
		const paths = [...this.pendingRetry].filter((p) => p !== excludePath);
		for (const path of paths) {
			this.pendingRetry.delete(path);
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await this.sendFile(file, { manual: false });
		}
	}

	// -- scheduling ------------------------------------------------------------

	scheduleSend(file: TAbstractFile) {
		if (!(file instanceof TFile) || file.extension !== 'md') return;
		const existing = this._timers.get(file.path);
		if (existing) window.clearTimeout(existing);
		const delay = Math.max(this.settings.debounceMs, MIN_DEBOUNCE_MS);
		const timer = window.setTimeout(() => {
			this._timers.delete(file.path);
			void this.sendFile(file, { manual: false });
		}, delay);
		this._timers.set(file.path, timer);
	}

	// -- note inspection ---------------------------------------------------------

	frontmatterOf(file: TFile): Record<string, unknown> | undefined {
		return this.app.metadataCache.getFileCache(file)?.frontmatter;
	}

	resolveProjectNames(file: TFile): string[] {
		const cache = this.app.metadataCache.getFileCache(file);
		const tags = (cache && getAllTags(cache)) || [];
		const prefixes = parsePrefixList(this.settings.projectTagPrefixes);
		const names = new Set<string>();
		for (const t of tags) {
			const clean = t.replace(/^#/, '');
			for (const prefix of prefixes) {
				if (clean.startsWith(prefix)) {
					const segment = clean.slice(prefix.length).split('/')[0];
					if (segment) names.add(segment);
					break;
				}
			}
		}
		return [...names];
	}

	buildDeepLink(file: TFile): string {
		const vault = encodeLinkComponent(this.app.vault.getName());
		const path = encodeLinkComponent(file.path.replace(/\.md$/i, ''));
		const label = file.basename.replace(/[[\]]/g, '') || 'Open in Obsidian';
		return `[${label}](obsidian://open?vault=${vault}&file=${path})`;
	}

	async writeFrontmatter(file: TFile, fields: Record<string, unknown>) {
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			Object.assign(fm, fields);
		});
	}

	// processFrontMatter re-reads and re-parses the file fresh each call, so
	// it can fail with a YAMLParseError on frontmatter that was valid when we
	// last read the cache - typically because the user is still typing and
	// briefly left it in an invalid state. That clears itself within a
	// second or two, so a few short retries clear almost all of these before
	// resorting to surfacing an error.
	async writeFrontmatterWithRetry(file: TFile, fields: Record<string, unknown>, attempts = 4, baseDelayMs = 300) {
		for (let i = 0; i < attempts; i++) {
			try {
				await this.writeFrontmatter(file, fields);
				return;
			} catch (e) {
				if (i === attempts - 1) throw e;
				await new Promise((resolve) => window.setTimeout(resolve, baseDelayMs * 2 ** i));
			}
		}
	}

	buildTitle(nextText: string, waitingOn: string, file: TFile, ref: number): string {
		const template = waitingOn ? this.settings.waitingTitleTemplate : this.settings.titleTemplate;
		let rendered = renderTemplate(template, { next: nextText, waitingOn, title: file.basename, ref });
		if (this.settings.showRefInTitle && !template.includes('{ref}')) {
			rendered = `#${ref} ${rendered}`;
		}
		return rendered.slice(0, TITLE_MAX_LEN);
	}

	// -- core sync ---------------------------------------------------------------

	async sendFile(file: TFile, { manual = false }: { manual?: boolean } = {}) {
		if (file.extension !== 'md') return;

		const fm = this.frontmatterOf(file) ?? {};
		const nextText = toText(fm[this.settings.nextFieldName]);
		if (!nextText) {
			if (manual) this.notify(`"${file.basename}" has no "${this.settings.nextFieldName}" value; nothing to send.`);
			return;
		}

		if (!this.settings.apiToken) {
			this.notify('no API access token set. Configure it in plugin settings.');
			return;
		}

		const projectNames = this.resolveProjectNames(file);
		if (projectNames.length > 1) {
			this.notify(`"${file.basename}" has ambiguous project tags (${projectNames.join(', ')}); skipped.`);
			return;
		}

		let project: SPNamed | null = null;
		if (projectNames.length === 1) {
			try {
				project = await this.client.findProject(projectNames[0]);
			} catch (e) {
				if (isRetryable(e)) this.pendingRetry.add(file.path);
				this.notify(errMsg(e));
				return;
			}
			if (!project) {
				this.notify(`Super Productivity project "${projectNames[0]}" not found. Create it in SP first.`);
				return;
			}
		}
		const projectName = project ? project.title || project.name || '' : '';

		const waitingRaw = fm[this.settings.waitingOnFieldName];
		const waitingList: unknown[] = waitingRaw == null ? [] : Array.isArray(waitingRaw) ? waitingRaw : [waitingRaw];
		const waitingOn = joinGrammatical(waitingList);

		let tagIds: string[] = [];
		let tagName = '';
		if (waitingOn) {
			let tag: SPNamed | null = null;
			try {
				tag = await this.client.findTag(this.settings.reminderTagName);
			} catch (e) {
				if (isRetryable(e)) this.pendingRetry.add(file.path);
				this.notify(errMsg(e));
			}
			if (!tag) {
				this.notify(`Super Productivity tag "${this.settings.reminderTagName}" not found; "${file.basename}" will send untagged.`);
			} else {
				tagIds = [tag.id];
				tagName = tag.title || tag.name || '';
			}
		}

		const dueDay = startToDueDay(fm[this.settings.startFieldName]);

		const rawTaskId = fm.sp_task_id;
		const existingTaskId = typeof rawTaskId === 'string' || typeof rawTaskId === 'number' ? String(rawTaskId) : '';
		const existingRef = fm.sp_task_ref;
		const record: SentRecord | undefined = existingTaskId ? this.sent[existingTaskId] : undefined;

		// The note's own sp_task_ref, once written, is that note's permanent
		// display number - trust it even if the sent-record cache (data.json)
		// was lost, so a missing record can't reassign a new/higher number and
		// then flap between the two on every subsequent edit. Only fall back
		// to the live counter for a note that has never been assigned one.
		const plannedRef = typeof existingRef === 'number' ? existingRef : this.refCounter;
		const title = this.buildTitle(nextText, waitingOn, file, plannedRef);
		// dueDay joins the signature only when present, so existing records
		// (which never had one) keep matching and aren't needlessly re-sent.
		const contentSig = [title, projectName, tagName].join(SEP) + (dueDay ? SEP + dueDay : '');
		const fullSig = contentSig + SEP + file.path;

		try {
			if (!manual && record && record.full === fullSig) return;

			const link = this.settings.includeDeepLink ? this.buildDeepLink(file) : null;

			if (existingTaskId && record && record.content === contentSig && record.full !== fullSig) {
				// Path-only change (rename/move). Refresh the link, nothing else -
				// this must never reopen/resurrect a completed task.
				if (link) {
					let current: SPTask | null = null;
					try {
						current = await this.client.getTask(existingTaskId);
					} catch {
						// best effort; fall through and still try the notes update
					}
					if (!current || notesAreOurs(current.notes)) {
						await this.client.updateTask(existingTaskId, { notes: link });
					}
					this.pendingRetry.delete(file.path);
					await this.flushPendingRetries(file.path);
				}
				record.full = fullSig;
				record.path = file.path;
				await this.persist();
				return;
			}

			let current: SPTask | null = null;
			if (existingTaskId) {
				current = await this.client.getTask(existingTaskId);
			}

			if (existingTaskId && current && !current.isDone) {
				const payload: Partial<TaskPayload> = { title, tagIds };
				if (project) payload.projectId = project.id;
				// Updates push a strictly future start. Today is sent only if the SP
				// task has no date yet (start added after creation); otherwise it's left
				// alone so a task the user pushed to a later day in SP isn't snapped
				// back to today by an unrelated edit. Past starts are never sent.
				if (dueDay && (dueDay > localTodayStr() || (dueDay === localTodayStr() && !current.dueDay && !current.dueWithTime))) payload.dueDay = dueDay;
				if (link && notesAreOurs(current.notes)) payload.notes = link;
				await this.client.updateTask(existingTaskId, payload);
				this.sent[existingTaskId] = { content: contentSig, full: fullSig, path: file.path };
				await this.persist();
				this.pendingRetry.delete(file.path);
				await this.flushPendingRetries(file.path);
				if (!manual) this.notifySuccess(`updated "${title}".`);
				return; // keeps its ref
			}

			// done / archived / 404 / brand new -> create a fresh task, reusing
			// the note's existing ref (if it has one) so its display number
			// stays stable across task recreation.
			const newRef = plannedRef;
			const isNewRef = typeof existingRef !== 'number';
			if (isNewRef) this.refCounter = newRef + 1; // reserve the number before touching SP

			// sp_task_ref never comes from SP - it's ours alone - so writing it
			// first means a failure here has touched nothing external. Nothing
			// was created, so this is just an ordinary failed send: release the
			// reserved number and bail out, same as any other aborted send.
			try {
				await this.writeFrontmatterWithRetry(file, { sp_task_ref: newRef });
			} catch (e) {
				if (isNewRef) this.refCounter = newRef;
				this.notify(`couldn't write to "${file.basename}"'s frontmatter (${errMsg(e)}); nothing was sent.`);
				return;
			}
			await this.persist();

			const createPayload: TaskPayload = { title, tagIds };
			if (link) createPayload.notes = link;
			if (project) createPayload.projectId = project.id;
			else if (this.settings.defaultProjectName) {
				// SP files a new task under whichever project view is open unless
				// the payload names a project (projectId can't be null). Pin notes
				// with no Project/ tag to a fixed default instead. Best effort: a
				// failed or missing lookup just falls back to SP's own behaviour.
				try {
					const fallback = await this.client.findProject(this.settings.defaultProjectName);
					if (fallback) createPayload.projectId = fallback.id;
				} catch {
					// ignore; createTask below surfaces any real connectivity problem
				}
			}
			// SP's TaskService.add() stamps dueDay = today when its Today view is
			// open, unless the payload carries a dueDay key at all; null opts out.
			// A valid but past start on a brand-new task (incl. one recreated after
			// the old one was completed) means "due now": use today. This is
			// create-only, so it can't snap back a task rescheduled in SP.
			if (dueDay) createPayload.dueDay = dueDay;
			else if (parseStartDay(fm[this.settings.startFieldName])) createPayload.dueDay = localTodayStr();
			else if (this.settings.noDueDateOnCreate) createPayload.dueDay = null;
			const created = await this.client.createTask(createPayload);
			this.sent[created.id] = { content: contentSig, full: fullSig, path: file.path };

			// The SP task now exists - a failure writing its id back must not
			// look like an ordinary retryable failure, since retrying would
			// just call createTask again and leave this one orphaned. The note
			// already carries the correct ref number and title, so recovery
			// doesn't need it copied from here: a duplicate is spottable in SP
			// by two tasks sharing that same "#<ref>" title.
			try {
				await this.writeFrontmatterWithRetry(file, { sp_task_id: created.id });
			} catch (e) {
				await this.persist();
				this.notify(
					`created SP task "${title}" but couldn't record its id in "${file.basename}" (${errMsg(e)}). ` +
						`If the next send creates a duplicate, look in Super Productivity for two tasks titled "#${newRef} ..." and remove the extra one.`
				);
				return;
			}

			await this.persist();
			this.pendingRetry.delete(file.path);
			await this.flushPendingRetries(file.path);
			if (!manual) this.notifySuccess(`created "${title}".`);
		} catch (e) {
			if (isRetryable(e)) this.pendingRetry.add(file.path);
			this.notify(errMsg(e));
		}
	}

	async healCounter() {
		let max = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const ref = this.frontmatterOf(file)?.sp_task_ref;
			if (typeof ref === 'number' && ref > max) max = ref;
		}
		const raised = Math.max(this.refCounter, max + 1);
		if (raised !== this.refCounter) {
			this.refCounter = raised;
			await this.persist();
		}
	}
}
