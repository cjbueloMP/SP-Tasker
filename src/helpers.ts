// Pure helpers (no Obsidian or network access) so they can be unit tested; see tests/.

export interface SentRecord {
	content: string;
	full: string;
	path: string;
}
export type SentMap = Record<string, SentRecord>;

export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function toText(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (Array.isArray(value)) return (value as unknown[]).map(toText).filter(Boolean).join(' ');
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
	return ''; // a YAML map etc. is not a usable title (previously became "[object Object]")
}

// "Alex" / "Alex and Sam" / "Alex, Sam and Jo" - deduped, no Oxford comma.
export function joinGrammatical(items: unknown[]): string {
	const seen: string[] = [];
	for (const raw of items) {
		const s = String(raw).trim();
		if (s && !seen.includes(s)) seen.push(s);
	}
	if (seen.length === 0) return '';
	if (seen.length === 1) return seen[0];
	if (seen.length === 2) return `${seen[0]} and ${seen[1]}`;
	return `${seen.slice(0, -1).join(', ')} and ${seen[seen.length - 1]}`;
}

export function renderTemplate(
	template: string,
	{ next, waitingOn, title, ref }: { next: string; waitingOn: string; title: string; ref: number }
): string {
	return template
		.replace(/\{next\}/g, next)
		.replace(/\{waiting_on\}/g, waitingOn)
		.replace(/\{title\}/g, title)
		.replace(/\{ref\}/g, String(ref));
}

// encodeURIComponent leaves ( and ) alone, and an unescaped ) would
// terminate a markdown link early.
export function encodeLinkComponent(str: string): string {
	return encodeURIComponent(str).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// "Project/, Area/" -> ["Project/", "Area/"], each guaranteed to end with "/".
export function parsePrefixList(raw: string): string[] {
	return String(raw || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => (s.endsWith('/') ? s : `${s}/`));
}

// A note's start value (YYYY-MM-DD, optionally followed by a time) as a real
// calendar date, or null if it's missing or unparseable. Not time-sensitive.
export function parseStartDay(value: unknown): { day: string; parsed: Date } | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(toText(value));
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const parsed = new Date(y, mo - 1, d);
	if (parsed.getFullYear() !== y || parsed.getMonth() !== mo - 1 || parsed.getDate() !== d) return null;
	return { day: `${m[1]}-${m[2]}-${m[3]}`, parsed };
}

// A note's start becomes SP's dueDay only when it is today or later, judged in
// local time. Past, missing or unparseable values return null, meaning "don't
// send a due date" (create separately turns a valid past start into today).
export function startToDueDay(value: unknown, now: Date = new Date()): string | null {
	const s = parseStartDay(value);
	if (!s) return null;
	if (s.parsed < new Date(now.getFullYear(), now.getMonth(), now.getDate())) return null;
	return s.day;
}

// Local-time YYYY-MM-DD for "today"; sorts correctly against a dueDay string.
export function localTodayStr(n: Date = new Date()): string {
	const pad = (v: number) => String(v).padStart(2, '0');
	return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

export function notesAreOurs(notes: string | null | undefined): boolean {
	if (!notes) return true;
	if (notes.startsWith('obsidian://open?')) return true; // 0.1.0/0.2.0 format
	return /^\[[^\]]*\]\(obsidian:\/\/open\?[^)]*\)$/.test(notes);
}

export function readSent(raw: unknown): SentMap {
	const out: SentMap = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [taskId, val] of Object.entries(raw as Record<string, unknown>)) {
		if (val && typeof val === 'object') {
			const v = val as Partial<SentRecord>;
			if (typeof v.full === 'string') {
				out[taskId] = { content: v.content || '', full: v.full, path: v.path || '' };
			}
		}
	}
	return out;
}
