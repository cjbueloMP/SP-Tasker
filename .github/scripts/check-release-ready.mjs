// Fails a pull request into main unless manifest.json / versions.json describe a new, unreleased
// version. Every merge to main is a release (the release workflow drafts one from main), so a PR
// that forgets to bump the version would otherwise merge and silently release nothing.
//
// Existing versions come from git tags (checkout must fetch them) plus, when provided, the
// newline-separated release tag names in the RELEASE_TAGS env var (this includes draft releases,
// whose tags do not exist yet).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
const version = manifest.version;
const errors = [];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parse = (s) => SEMVER.exec(s)?.slice(1).map(Number) ?? null;
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const current = parse(version);
if (!current) {
	errors.push(`manifest.json version "${version}" must be plain x.y.z (no "v" prefix, no suffix).`);
}

if (versions[version] !== manifest.minAppVersion) {
	errors.push(
		`versions.json must map "${version}" to manifest.json's minAppVersion "${manifest.minAppVersion}" (found ${JSON.stringify(versions[version])}).`
	);
}

const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).split('\n');
const releaseTags = (process.env.RELEASE_TAGS ?? '').split('\n');
const existing = [...new Set([...tags, ...releaseTags].map((t) => t.trim().replace(/^v/, '')).filter(Boolean))];

if (existing.includes(version)) {
	errors.push(`Version ${version} already has a tag or release. Bump manifest.json and versions.json.`);
}

if (current) {
	const newer = existing.map(parse).filter(Boolean).filter((p) => compare(p, current) > 0);
	if (newer.length > 0) {
		errors.push(`Version ${version} is lower than an existing release (${newer.map((p) => p.join('.')).join(', ')}).`);
	}
}

if (errors.length > 0) {
	for (const e of errors) console.error(`::error::${e}`);
	process.exit(1);
}
console.log(`Release-ready: ${version} is new and versions.json is consistent.`);
