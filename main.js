'use strict';

const { Plugin, PluginSettingTab, Notice, TFile, requestUrl, getAllTags } = require('obsidian');

const SEP = String.fromCharCode(1); // avoids a literal control byte in the source

const DEFAULT_SETTINGS = {
	apiBaseUrl: 'http://127.0.0.1:3876',
	apiToken: '',
	reminderTagName: 'reminder',
	autoSync: true,
	debounceMs: 1500,
	titleTemplate: '{next}',
	waitingTitleTemplate: 'Waiting on {waiting_on}: {next}',
	showRefInTitle: true,
	projectTagPrefixes: 'Project/',
	nextFieldName: 'next',
	waitingOnFieldName: 'waiting_on',
	includeDeepLink: true,
};

const MIN_DEBOUNCE_MS = 250;
const TITLE_MAX_LEN = 300;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function toText(value) {
	if (value === undefined || value === null) return '';
	if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(' ');
	return String(value).trim();
}

// "Alex" / "Alex and Sam" / "Alex, Sam and Jo" - deduped, no Oxford comma.
function joinGrammatical(items) {
	const seen = [];
	for (const raw of items) {
		const s = String(raw).trim();
		if (s && !seen.includes(s)) seen.push(s);
	}
	if (seen.length === 0) return '';
	if (seen.length === 1) return seen[0];
	if (seen.length === 2) return `${seen[0]} and ${seen[1]}`;
	return `${seen.slice(0, -1).join(', ')} and ${seen[seen.length - 1]}`;
}

function renderTemplate(template, { next, waitingOn, title, ref }) {
	return template
		.replace(/\{next\}/g, next)
		.replace(/\{waiting_on\}/g, waitingOn)
		.replace(/\{title\}/g, title)
		.replace(/\{ref\}/g, String(ref));
}

// encodeURIComponent leaves ( and ) alone, and an unescaped ) would
// terminate a markdown link early.
function encodeLinkComponent(str) {
	return encodeURIComponent(str).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// "Project/, Area/" -> ["Project/", "Area/"], each guaranteed to end with "/".
function parsePrefixList(raw) {
	return String(raw || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => (s.endsWith('/') ? s : `${s}/`));
}

function notesAreOurs(notes) {
	if (!notes) return true;
	if (notes.startsWith('obsidian://open?')) return true; // 0.1.0/0.2.0 format
	return /^\[[^\]]*\]\(obsidian:\/\/open\?[^)]*\)$/.test(notes);
}

function readSent(raw) {
	const out = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [taskId, val] of Object.entries(raw)) {
		if (val && typeof val === 'object' && typeof val.full === 'string') {
			out[taskId] = { content: val.content || '', full: val.full, path: val.path || '' };
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Super Productivity REST client
// ---------------------------------------------------------------------------

class SPApiError extends Error {}

class SPClient {
	constructor(getBaseUrl, getToken) {
		this.getBaseUrl = getBaseUrl;
		this.getToken = getToken;
		this.projectCache = null;
		this.tagCache = null;
	}

	async request(method, path, { body } = {}) {
		const base = this.getBaseUrl().replace(/\/+$/, '');
		const url = `${base}${path}`;

		let res;
		try {
			res = await requestUrl({
				url,
				method,
				headers: {
					Authorization: `Bearer ${this.getToken()}`,
					'Content-Type': 'application/json',
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
				throw: false,
			});
		} catch (e) {
			throw new SPApiError(`Could not reach Super Productivity at ${base} (${e.message}). Is the app running with the local REST API enabled?`);
		}

		if (res.status === 401) {
			throw new SPApiError('Super Productivity access token rejected.');
		}

		let json;
		try {
			json = res.json;
		} catch (e) {
			json = undefined;
		}

		if (res.status === 404 && (!json || json.ok !== false)) {
			throw new SPApiError(`HTTP 404 (${method} ${path})`);
		}
		if (res.status < 200 || res.status >= 300) {
			const msg = json && json.error ? `${json.error.code}: ${json.error.message}` : `HTTP ${res.status}`;
			throw new SPApiError(`Super Productivity API error (${method} ${path}): ${msg}`);
		}
		if (json && json.ok === false) {
			throw new SPApiError(`Super Productivity API error (${method} ${path}): ${json.error.code}: ${json.error.message}`);
		}
		return json ? json.data : undefined;
	}

	health() {
		return this.request('GET', '/health');
	}

	async getTask(id) {
		try {
			return await this.request('GET', `/tasks/${encodeURIComponent(id)}`);
		} catch (e) {
			if (e instanceof SPApiError && /HTTP 404|TASK_NOT_FOUND/.test(e.message)) return null;
			throw e;
		}
	}

	createTask(payload) {
		return this.request('POST', '/tasks', { body: payload });
	}

	updateTask(id, payload) {
		return this.request('PATCH', `/tasks/${encodeURIComponent(id)}`, { body: payload });
	}

	findProject(name) {
		return this._findCached('projectCache', '/projects', name);
	}

	findTag(name) {
		return this._findCached('tagCache', '/tags', name);
	}

	// Case-sensitive exact match against title (or name), cached in memory
	// with exactly one refetch on a miss.
	async _findCached(cacheKey, path, name) {
		if (!this[cacheKey]) this[cacheKey] = (await this.request('GET', path)) || [];
		let found = this[cacheKey].find((i) => i.title === name || i.name === name);
		if (!found) {
			this[cacheKey] = (await this.request('GET', path)) || [];
			found = this[cacheKey].find((i) => i.title === name || i.name === name);
		}
		return found || null;
	}
}

// ---------------------------------------------------------------------------
// Main plugin
// ---------------------------------------------------------------------------

module.exports = class SPTaskerPlugin extends Plugin {
	async onload() {
		const loaded = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded.settings);
		this.sent = readSent(loaded.sent);
		this.refCounter = typeof loaded.refCounter === 'number' ? loaded.refCounter : 1;

		this.client = new SPClient(
			() => this.settings.apiBaseUrl,
			() => this.settings.apiToken
		);

		this._timers = new Map(); // path -> timeout id

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
				this.sendFile(file, { manual: true });
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

		this.app.workspace.onLayoutReady(() => this.healCounter());
	}

	onunload() {
		for (const timer of this._timers.values()) clearTimeout(timer);
		this._timers.clear();
	}

	async persist() {
		await this.saveData({ settings: this.settings, sent: this.sent, refCounter: this.refCounter });
	}

	notify(msg) {
		new Notice(`SP Tasker: ${msg}`);
		console.error(`[SP Tasker] ${msg}`);
	}

	notifySuccess(msg) {
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

	// -- scheduling ------------------------------------------------------------

	scheduleSend(file) {
		if (!(file instanceof TFile) || file.extension !== 'md') return;
		const existing = this._timers.get(file.path);
		if (existing) clearTimeout(existing);
		const delay = Math.max(this.settings.debounceMs, MIN_DEBOUNCE_MS);
		const timer = setTimeout(() => {
			this._timers.delete(file.path);
			this.sendFile(file, { manual: false });
		}, delay);
		this._timers.set(file.path, timer);
	}

	// -- note inspection ---------------------------------------------------------

	resolveProjectNames(file) {
		const cache = this.app.metadataCache.getFileCache(file);
		const tags = (cache && getAllTags(cache)) || [];
		const prefixes = parsePrefixList(this.settings.projectTagPrefixes);
		const names = new Set();
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

	buildDeepLink(file) {
		const vault = encodeLinkComponent(this.app.vault.getName());
		const path = encodeLinkComponent(file.path.replace(/\.md$/i, ''));
		const label = file.basename.replace(/[[\]]/g, '') || 'Open in Obsidian';
		return `[${label}](obsidian://open?vault=${vault}&file=${path})`;
	}

	async writeFrontmatter(file, fields) {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			Object.assign(fm, fields);
		});
	}

	buildTitle(nextText, waitingOn, file, ref) {
		const template = waitingOn ? this.settings.waitingTitleTemplate : this.settings.titleTemplate;
		let rendered = renderTemplate(template, { next: nextText, waitingOn, title: file.basename, ref });
		if (this.settings.showRefInTitle && !template.includes('{ref}')) {
			rendered = `#${ref} ${rendered}`;
		}
		return rendered.slice(0, TITLE_MAX_LEN);
	}

	// -- core sync ---------------------------------------------------------------

	async sendFile(file, { manual = false } = {}) {
		if (!(file instanceof TFile) || file.extension !== 'md') return;

		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const nextText = toText(fm && fm[this.settings.nextFieldName]);
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

		let project = null;
		if (projectNames.length === 1) {
			try {
				project = await this.client.findProject(projectNames[0]);
			} catch (e) {
				this.notify(e.message);
				return;
			}
			if (!project) {
				this.notify(`Super Productivity project "${projectNames[0]}" not found. Create it in SP first.`);
				return;
			}
		}
		const projectName = project ? project.title || project.name : '';

		const waitingRaw = fm[this.settings.waitingOnFieldName];
		const waitingList = waitingRaw == null ? [] : Array.isArray(waitingRaw) ? waitingRaw : [waitingRaw];
		const waitingOn = joinGrammatical(waitingList);

		let tagIds = [];
		let tagName = '';
		if (waitingOn) {
			let tag = null;
			try {
				tag = await this.client.findTag(this.settings.reminderTagName);
			} catch (e) {
				this.notify(e.message);
			}
			if (!tag) {
				this.notify(`Super Productivity tag "${this.settings.reminderTagName}" not found; "${file.basename}" will send untagged.`);
			} else {
				tagIds = [tag.id];
				tagName = tag.title || tag.name;
			}
		}

		const existingTaskId = fm.sp_task_id;
		const existingRef = fm.sp_task_ref;
		const record = existingTaskId ? this.sent[existingTaskId] : null;

		// The note's own sp_task_ref, once written, is that note's permanent
		// display number - trust it even if the sent-record cache (data.json)
		// was lost, so a missing record can't reassign a new/higher number and
		// then flap between the two on every subsequent edit. Only fall back
		// to the live counter for a note that has never been assigned one.
		const plannedRef = typeof existingRef === 'number' ? existingRef : this.refCounter;
		let title = this.buildTitle(nextText, waitingOn, file, plannedRef);
		let contentSig = [title, projectName, tagName].join(SEP);
		let fullSig = contentSig + SEP + file.path;

		try {
			if (!manual && record && record.full === fullSig) return;

			const link = this.settings.includeDeepLink ? this.buildDeepLink(file) : null;

			if (record && record.content === contentSig && record.full !== fullSig) {
				// Path-only change (rename/move). Refresh the link, nothing else -
				// this must never reopen/resurrect a completed task.
				if (link) {
					let current = null;
					try {
						current = await this.client.getTask(existingTaskId);
					} catch (e) {
						// best effort; fall through and still try the notes update
					}
					if (!current || notesAreOurs(current.notes)) {
						await this.client.updateTask(existingTaskId, { notes: link });
					}
				}
				record.full = fullSig;
				record.path = file.path;
				await this.persist();
				return;
			}

			let current = null;
			if (existingTaskId) {
				current = await this.client.getTask(existingTaskId);
			}

			if (current && !current.isDone) {
				const payload = { title, tagIds };
				if (project) payload.projectId = project.id;
				if (link && notesAreOurs(current.notes)) payload.notes = link;
				await this.client.updateTask(existingTaskId, payload);
				this.sent[existingTaskId] = { content: contentSig, full: fullSig, path: file.path };
				await this.persist();
				if (!manual) this.notifySuccess(`updated "${title}".`);
				return; // keeps its ref
			}

			// done / archived / 404 / brand new -> create a fresh task, reusing
			// the note's existing ref (if it has one) so its display number
			// stays stable across task recreation.
			const newRef = plannedRef;
			const createPayload = { title, tagIds };
			if (link) createPayload.notes = link;
			if (project) createPayload.projectId = project.id;
			const created = await this.client.createTask(createPayload);
			if (typeof existingRef !== 'number') this.refCounter = newRef + 1;
			this.sent[created.id] = { content: contentSig, full: fullSig, path: file.path };
			await this.writeFrontmatter(file, { sp_task_id: created.id, sp_task_ref: newRef });
			await this.persist();
			if (!manual) this.notifySuccess(`created "${title}".`);
		} catch (e) {
			this.notify(e.message);
		}
	}

	async healCounter() {
		let max = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const ref = fm && fm.sp_task_ref;
			if (typeof ref === 'number' && ref > max) max = ref;
		}
		const raised = Math.max(this.refCounter, max + 1);
		if (raised !== this.refCounter) {
			this.refCounter = raised;
			await this.persist();
		}
	}
};

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

const requiredText = (label) => (value) => (value.trim() ? undefined : `${label} is required.`);

class SPTaskerSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Route the declarative controls' persistence through the plugin's own
	// data shape ({ settings, sent, refCounter }) instead of the default,
	// which would save only `settings` and drop the task-id mappings.
	getControlValue(key) {
		return this.plugin.settings[key];
	}

	setControlValue(key, value) {
		this.plugin.settings[key] = typeof value === 'string' ? value.trim() : value;
		return this.plugin.persist();
	}

	getSettingDefinitions() {
		return [
			{
				name: 'SP Tasker',
				desc: "Editing a note's frontmatter (next / waiting_on / #Project tag) creates or updates a matching task in Super Productivity. Nothing syncs back.",
			},
			{
				type: 'group',
				heading: 'Connection',
				items: [
					{
						name: 'Super Productivity API URL',
						desc: 'Local REST API base URL (Settings → Misc in Super Productivity).',
						control: {
							type: 'text',
							key: 'apiBaseUrl',
							placeholder: DEFAULT_SETTINGS.apiBaseUrl,
							defaultValue: DEFAULT_SETTINGS.apiBaseUrl,
							validate: requiredText('API URL'),
						},
					},
					{
						name: 'Access token',
						desc: 'Token from Super Productivity → Settings → Misc → Local REST API.',
						control: { type: 'text', key: 'apiToken', placeholder: 'token' },
					},
					{
						name: 'Test connection',
						desc: 'Checks that Super Productivity is reachable and the token is valid.',
						render: (setting) => {
							setting.addButton((btn) => {
								btn.setButtonText('Test').onClick(async () => {
									try {
										await this.plugin.client.health();
										new Notice('SP Tasker: connected to Super Productivity.');
									} catch (e) {
										new Notice(`SP Tasker: ${e.message}`);
									}
								});
							});
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Trigger',
				items: [
					{
						name: 'Sync automatically',
						desc: "Send updates whenever a note's frontmatter changes or it is renamed. Turn off to only sync via the manual command.",
						control: { type: 'toggle', key: 'autoSync', defaultValue: DEFAULT_SETTINGS.autoSync },
					},
					{
						name: 'Debounce (ms)',
						desc: `Delay after an edit before sending. Floored at ${MIN_DEBOUNCE_MS}ms regardless of this value.`,
						control: {
							type: 'number',
							key: 'debounceMs',
							min: 0,
							step: 50,
							defaultValue: DEFAULT_SETTINGS.debounceMs,
							validate: (v) => (Number.isFinite(v) && v >= 0 ? undefined : 'Must be zero or more.'),
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Note properties',
				items: [
					{
						name: '"Next" field name',
						desc: 'Frontmatter key read as the task title source.',
						control: {
							type: 'text',
							key: 'nextFieldName',
							placeholder: DEFAULT_SETTINGS.nextFieldName,
							defaultValue: DEFAULT_SETTINGS.nextFieldName,
							validate: requiredText('"Next" field name'),
						},
					},
					{
						name: '"Waiting on" field name',
						desc: 'Frontmatter key read for the waiting-on list.',
						control: {
							type: 'text',
							key: 'waitingOnFieldName',
							placeholder: DEFAULT_SETTINGS.waitingOnFieldName,
							defaultValue: DEFAULT_SETTINGS.waitingOnFieldName,
							validate: requiredText('"Waiting on" field name'),
						},
					},
					{
						name: 'Project tag prefixes',
						desc: 'Comma-separated tag prefixes that mark a project, e.g. "Project/, Area/". Only the segment right after the prefix is used.',
						control: {
							type: 'text',
							key: 'projectTagPrefixes',
							placeholder: DEFAULT_SETTINGS.projectTagPrefixes,
							defaultValue: DEFAULT_SETTINGS.projectTagPrefixes,
							validate: requiredText('Project tag prefixes'),
						},
					},
					{
						name: 'Include note link',
						desc: "Add a link back to the note in the task's notes field.",
						control: { type: 'toggle', key: 'includeDeepLink', defaultValue: DEFAULT_SETTINGS.includeDeepLink },
					},
					{
						name: 'Reminder tag name',
						desc: 'Existing SP tag applied to tasks created from a note with a waiting_on field. Missing tag just sends the task untagged.',
						control: {
							type: 'text',
							key: 'reminderTagName',
							placeholder: DEFAULT_SETTINGS.reminderTagName,
							defaultValue: DEFAULT_SETTINGS.reminderTagName,
							validate: requiredText('Reminder tag name'),
						},
					},
					{
						name: 'Title template',
						desc: 'Used when there is no waiting_on. Placeholders: {next} {title} {ref}',
						control: {
							type: 'text',
							key: 'titleTemplate',
							placeholder: DEFAULT_SETTINGS.titleTemplate,
							defaultValue: DEFAULT_SETTINGS.titleTemplate,
							validate: requiredText('Title template'),
						},
					},
					{
						name: 'Waiting-on title template',
						desc: 'Used when waiting_on is set. Placeholders: {next} {waiting_on} {title} {ref}',
						control: {
							type: 'text',
							key: 'waitingTitleTemplate',
							placeholder: DEFAULT_SETTINGS.waitingTitleTemplate,
							defaultValue: DEFAULT_SETTINGS.waitingTitleTemplate,
							validate: requiredText('Waiting-on title template'),
						},
					},
					{
						name: 'Show number in title',
						desc: "If the title template doesn't reference {ref}, prefix the rendered title with #<ref>.",
						control: { type: 'toggle', key: 'showRefInTitle', defaultValue: DEFAULT_SETTINGS.showRefInTitle },
					},
				],
			},
			{
				type: 'group',
				heading: 'Maintenance',
				items: [
					{
						name: 'Clear sync cache',
						desc: 'Forgets which notes were already sent, so the next edit to each one re-verifies it against Super Productivity from scratch. Use this if data.json ever gets out of sync (e.g. notes edited while Obsidian was closed). Does not touch settings, task numbers, or existing SP tasks.',
						render: (setting) => {
							setting.addButton((btn) => {
								btn.setButtonText('Clear').onClick(async () => {
									await this.plugin.clearSent();
									new Notice('SP Tasker: sync cache cleared.');
								});
							});
						},
					},
				],
			},
		];
	}
}
