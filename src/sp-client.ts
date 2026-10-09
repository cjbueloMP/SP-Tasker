import { requestUrl } from 'obsidian';
import { errMsg } from './helpers';

// Super Productivity local REST API client (read/write tasks; read-only project and tag lookups).

// The parts of SP's task / project / tag objects this plugin reads.
export interface SPTask {
	id: string;
	isDone?: boolean;
	notes?: string;
	dueDay?: string | null;
	dueWithTime?: number | null;
}
export interface SPNamed {
	id: string;
	title?: string;
	name?: string;
}
export interface TaskPayload {
	title: string;
	tagIds: string[];
	notes?: string;
	projectId?: string;
	dueDay?: string | null;
}
interface SPEnvelope {
	ok?: boolean;
	data?: unknown;
	error?: { code: string; message: string };
}

export class SPApiError extends Error {
	retryable?: boolean;
}

export function isRetryable(e: unknown): boolean {
	return e instanceof SPApiError && e.retryable === true;
}

export class SPClient {
	private projectCache: SPNamed[] | null = null;
	private tagCache: SPNamed[] | null = null;

	constructor(
		private readonly getBaseUrl: () => string,
		private readonly getToken: () => string
	) {}

	async request<T>(method: string, path: string, { body }: { body?: unknown } = {}): Promise<T | undefined> {
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
			const err = new SPApiError(`Could not reach Super Productivity at ${base} (${errMsg(e)}). Is the app running with the local REST API enabled?`);
			err.retryable = true; // connectivity failure, not a rejection by SP itself - worth retrying once SP is back
			throw err;
		}

		if (res.status === 401) {
			throw new SPApiError('Super Productivity access token rejected.');
		}

		let json: SPEnvelope | undefined;
		try {
			json = res.json as SPEnvelope | undefined;
		} catch {
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
			const detail = json.error ? `${json.error.code}: ${json.error.message}` : 'unknown error';
			throw new SPApiError(`Super Productivity API error (${method} ${path}): ${detail}`);
		}
		return json ? (json.data as T) : undefined;
	}

	health(): Promise<unknown> {
		return this.request('GET', '/health');
	}

	async getTask(id: string): Promise<SPTask | null> {
		try {
			return (await this.request<SPTask>('GET', `/tasks/${encodeURIComponent(id)}`)) ?? null;
		} catch (e) {
			if (e instanceof SPApiError && /HTTP 404|TASK_NOT_FOUND/.test(e.message)) return null;
			throw e;
		}
	}

	async createTask(payload: TaskPayload): Promise<SPTask> {
		const task = await this.request<SPTask>('POST', '/tasks', { body: payload });
		if (!task) throw new SPApiError('Super Productivity API returned no task for the create request.');
		return task;
	}

	updateTask(id: string, payload: Partial<TaskPayload>): Promise<unknown> {
		return this.request('PATCH', `/tasks/${encodeURIComponent(id)}`, { body: payload });
	}

	findProject(name: string): Promise<SPNamed | null> {
		return this._findCached('projectCache', '/projects', name);
	}

	findTag(name: string): Promise<SPNamed | null> {
		return this._findCached('tagCache', '/tags', name);
	}

	// Case-sensitive exact match against title (or name), cached in memory
	// with exactly one refetch on a miss.
	private async _findCached(cacheKey: 'projectCache' | 'tagCache', path: string, name: string): Promise<SPNamed | null> {
		const matches = (i: SPNamed) => i.title === name || i.name === name;
		const cached = this[cacheKey] ?? (await this.request<SPNamed[]>('GET', path)) ?? [];
		this[cacheKey] = cached;
		let found = cached.find(matches);
		if (!found) {
			const fresh = (await this.request<SPNamed[]>('GET', path)) ?? [];
			this[cacheKey] = fresh;
			found = fresh.find(matches);
		}
		return found ?? null;
	}
}
