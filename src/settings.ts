import { Notice, PluginSettingTab } from 'obsidian';
import type { Plugin, SettingDefinitionItem } from 'obsidian';
import { errMsg } from './helpers';

// A type alias (not an interface) so it is assignable to Record<string, unknown>,
// which the settings tab needs to read/write controls by key.
export type SPSettings = {
	apiBaseUrl: string;
	apiToken: string;
	reminderTagName: string;
	autoSync: boolean;
	debounceMs: number;
	titleTemplate: string;
	waitingTitleTemplate: string;
	showRefInTitle: boolean;
	projectTagPrefixes: string;
	nextFieldName: string;
	waitingOnFieldName: string;
	startFieldName: string;
	includeDeepLink: boolean;
	noDueDateOnCreate: boolean;
	defaultProjectName: string;
};

export const DEFAULT_SETTINGS: SPSettings = {
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
	startFieldName: 'start',
	includeDeepLink: true,
	noDueDateOnCreate: true,
	defaultProjectName: 'Inbox',
};

export const MIN_DEBOUNCE_MS = 250;

// The slice of the plugin object the settings tab needs. Declared here (rather than importing the
// plugin class) so settings.ts doesn't depend on main.ts.
export interface SettingsHost {
	settings: SPSettings;
	client: { health(): Promise<unknown> };
	persist(): Promise<void>;
	clearSent(): Promise<void>;
}

const requiredText = (label: string) => (value: string) => (value.trim() ? undefined : `${label} is required.`);

export class SPTaskerSettingTab extends PluginSettingTab {
	declare plugin: Plugin & SettingsHost;

	// Route the declarative controls' persistence through the plugin's own
	// data shape ({ settings, sent, refCounter }) instead of the default,
	// which would save only `settings` and drop the task-id mappings.
	getControlValue(key: string): unknown {
		const settings: Record<string, unknown> = this.plugin.settings;
		return settings[key];
	}

	setControlValue(key: string, value: unknown): Promise<void> {
		const settings: Record<string, unknown> = this.plugin.settings;
		settings[key] = typeof value === 'string' ? value.trim() : value;
		return this.plugin.persist();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'How syncing works',
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
										new Notice(`SP Tasker: ${errMsg(e)}`);
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
						name: '"Start" field name',
						desc: "Frontmatter key read for a start date (YYYY-MM-DD). If it is today or later it becomes the task's due date in SP; past dates are ignored.",
						control: {
							type: 'text',
							key: 'startFieldName',
							placeholder: DEFAULT_SETTINGS.startFieldName,
							defaultValue: DEFAULT_SETTINGS.startFieldName,
							validate: requiredText('"Start" field name'),
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
						name: 'Default project',
						desc: 'SP project used for new tasks from notes with no project tag, so they do not land in whichever project view is open in SP. Must already exist in SP. Leave empty to let SP decide. Only affects task creation.',
						control: {
							type: 'text',
							key: 'defaultProjectName',
							placeholder: DEFAULT_SETTINGS.defaultProjectName,
							defaultValue: DEFAULT_SETTINGS.defaultProjectName,
						},
					},
					{
						name: 'Include note link',
						desc: "Add a link back to the note in the task's notes field.",
						control: { type: 'toggle', key: 'includeDeepLink', defaultValue: DEFAULT_SETTINGS.includeDeepLink },
					},
					{
						name: 'No due date on new tasks',
						desc: "Create tasks without a due date, even while SP's Today view is open (SP otherwise schedules them for today). Only affects task creation.",
						control: { type: 'toggle', key: 'noDueDateOnCreate', defaultValue: DEFAULT_SETTINGS.noDueDateOnCreate },
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
