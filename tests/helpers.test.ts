import { test as nodeTest, describe as nodeDescribe } from 'node:test';
import assert from 'node:assert/strict';
import {
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
	errMsg,
} from '../src/helpers.ts';

// node:test returns promises that nothing needs to await; wrap them once so the
// type-aware lint rule (no-floating-promises) stays satisfied without sprinkling `void`.
const describe = (name: string, fn: () => void): void => void nodeDescribe(name, fn);
const test = (name: string, fn: () => void): void => void nodeTest(name, fn);

describe('toText', () => {
	test('empty-ish values become empty string', () => {
		assert.equal(toText(undefined), '');
		assert.equal(toText(null), '');
		assert.equal(toText(''), '');
		assert.equal(toText('   '), '');
	});
	test('trims strings and stringifies numbers and booleans', () => {
		assert.equal(toText('  hello  '), 'hello');
		assert.equal(toText(42), '42');
		assert.equal(toText(0), '0');
		assert.equal(toText(false), 'false');
	});
	test('arrays join their non-empty parts with spaces', () => {
		assert.equal(toText(['a', ' b ', '', null, 3]), 'a b 3');
		assert.equal(toText(['a', ['b', 'c']]), 'a b c');
	});
	test('objects (YAML maps) are not usable text', () => {
		assert.equal(toText({ a: 1 }), '');
	});
});

describe('joinGrammatical', () => {
	test('no items', () => assert.equal(joinGrammatical([]), ''));
	test('one item', () => assert.equal(joinGrammatical(['Alex']), 'Alex'));
	test('two items use "and"', () => assert.equal(joinGrammatical(['Alex', 'Sam']), 'Alex and Sam'));
	test('three or more use commas and no Oxford comma', () => {
		assert.equal(joinGrammatical(['Alex', 'Sam', 'Jo']), 'Alex, Sam and Jo');
		assert.equal(joinGrammatical(['A', 'B', 'C', 'D']), 'A, B, C and D');
	});
	test('trims, drops blanks and dedupes, keeping first occurrence order', () => {
		assert.equal(joinGrammatical([' Alex ', 'Alex', '', 'Sam', 'Alex']), 'Alex and Sam');
	});
	test('non-string items are stringified', () => {
		assert.equal(joinGrammatical([1, 2]), '1 and 2');
	});
});

describe('renderTemplate', () => {
	const vars = { next: 'Call vendor', waitingOn: 'Alex', title: 'Note title', ref: 7 };
	test('replaces every placeholder, including repeats', () => {
		assert.equal(
			renderTemplate('{ref}: {next} / {waiting_on} / {title} / {next}', vars),
			'7: Call vendor / Alex / Note title / Call vendor'
		);
	});
	test('leaves unknown placeholders and plain text alone', () => {
		assert.equal(renderTemplate('{nope} {next}', vars), '{nope} Call vendor');
	});
	test('default templates', () => {
		assert.equal(renderTemplate('{next}', vars), 'Call vendor');
		assert.equal(renderTemplate('Waiting on {waiting_on}: {next}', vars), 'Waiting on Alex: Call vendor');
	});
});

describe('encodeLinkComponent', () => {
	test('percent-encodes spaces and slashes', () => {
		assert.equal(encodeLinkComponent('a b/c'), 'a%20b%2Fc');
	});
	test('also encodes parentheses so a markdown link cannot end early', () => {
		assert.equal(encodeLinkComponent('Notes (2026)'), 'Notes%20%282026%29');
	});
});

describe('parsePrefixList', () => {
	test('splits, trims and ensures a trailing slash', () => {
		assert.deepEqual(parsePrefixList('Project/, Area'), ['Project/', 'Area/']);
	});
	test('drops empty entries', () => {
		assert.deepEqual(parsePrefixList(' , ,Project/,, '), ['Project/']);
	});
	test('empty input gives an empty list', () => {
		assert.deepEqual(parsePrefixList(''), []);
	});
});

describe('parseStartDay', () => {
	test('parses a plain date', () => {
		const r = parseStartDay('2026-10-09');
		assert.equal(r?.day, '2026-10-09');
		assert.equal(r?.parsed.getFullYear(), 2026);
		assert.equal(r?.parsed.getMonth(), 9);
		assert.equal(r?.parsed.getDate(), 9);
	});
	test('ignores a trailing time', () => {
		assert.equal(parseStartDay('2026-10-09 14:30')?.day, '2026-10-09');
		assert.equal(parseStartDay('2026-10-09T14:30:00')?.day, '2026-10-09');
	});
	test('rejects impossible calendar dates', () => {
		assert.equal(parseStartDay('2026-02-30'), null);
		assert.equal(parseStartDay('2026-13-01'), null);
		assert.equal(parseStartDay('2026-00-10'), null);
		assert.equal(parseStartDay('2026-04-31'), null);
	});
	test('accepts a leap day only in leap years', () => {
		assert.equal(parseStartDay('2028-02-29')?.day, '2028-02-29');
		assert.equal(parseStartDay('2027-02-29'), null);
	});
	test('rejects missing and malformed values', () => {
		assert.equal(parseStartDay(undefined), null);
		assert.equal(parseStartDay(''), null);
		assert.equal(parseStartDay('tomorrow'), null);
		assert.equal(parseStartDay('10/09/2026'), null);
		assert.equal(parseStartDay({}), null);
	});
});

describe('startToDueDay', () => {
	// Fixed "now": 9 Oct 2026, late evening, to prove the time of day does not matter.
	const now = new Date(2026, 9, 9, 23, 59, 30);
	test('today is sent', () => assert.equal(startToDueDay('2026-10-09', now), '2026-10-09'));
	test('a future date is sent', () => {
		assert.equal(startToDueDay('2026-10-10', now), '2026-10-10');
		assert.equal(startToDueDay('2027-01-01', now), '2027-01-01');
	});
	test('a past date is not sent', () => {
		assert.equal(startToDueDay('2026-10-08', now), null);
		assert.equal(startToDueDay('2025-12-31', now), null);
	});
	test('today still counts early in the morning', () => {
		assert.equal(startToDueDay('2026-10-09', new Date(2026, 9, 9, 0, 0, 1)), '2026-10-09');
	});
	test('missing or unparseable values are not sent', () => {
		assert.equal(startToDueDay(undefined, now), null);
		assert.equal(startToDueDay('nonsense', now), null);
		assert.equal(startToDueDay('2026-02-30', now), null);
	});
	test('a trailing time is ignored', () => {
		assert.equal(startToDueDay('2026-10-09 08:00', now), '2026-10-09');
	});
});

describe('localTodayStr', () => {
	test('zero-pads month and day', () => {
		assert.equal(localTodayStr(new Date(2026, 0, 5)), '2026-01-05');
		assert.equal(localTodayStr(new Date(2026, 11, 31)), '2026-12-31');
	});
	test('sorts correctly against dueDay strings', () => {
		const today = localTodayStr(new Date(2026, 9, 9));
		assert.ok('2026-10-10' > today);
		assert.ok('2026-10-08' < today);
		assert.ok(!('2026-10-09' > today));
	});
});

describe('notesAreOurs', () => {
	test('empty notes are ours to fill', () => {
		assert.equal(notesAreOurs(undefined), true);
		assert.equal(notesAreOurs(null), true);
		assert.equal(notesAreOurs(''), true);
	});
	test('the old bare obsidian:// format is ours', () => {
		assert.equal(notesAreOurs('obsidian://open?vault=V&file=F'), true);
	});
	test('the current markdown link format is ours', () => {
		assert.equal(notesAreOurs('[My note](obsidian://open?vault=V&file=Folder%2FMy%20note)'), true);
	});
	test('anything the user typed is not ours', () => {
		assert.equal(notesAreOurs('call them back first'), false);
		assert.equal(notesAreOurs('[My note](obsidian://open?vault=V&file=F) plus my own notes'), false);
		assert.equal(notesAreOurs('see [x](https://example.com)'), false);
	});
});

describe('readSent', () => {
	test('non-objects give an empty map', () => {
		assert.deepEqual(readSent(undefined), {});
		assert.deepEqual(readSent(null), {});
		assert.deepEqual(readSent('x'), {});
		assert.deepEqual(readSent(5), {});
	});
	test('keeps valid records', () => {
		const raw = { t1: { content: 'c', full: 'f', path: 'a.md' } };
		assert.deepEqual(readSent(raw), raw);
	});
	test('fills missing content and path with empty strings', () => {
		assert.deepEqual(readSent({ t1: { full: 'f' } }), { t1: { content: '', full: 'f', path: '' } });
	});
	test('skips entries without a string "full"', () => {
		const out = readSent({
			good: { full: 'f' },
			noFull: { content: 'c' },
			numFull: { full: 1 },
			nullVal: null,
			strVal: 'x',
		});
		assert.deepEqual(Object.keys(out), ['good']);
	});
});

describe('errMsg', () => {
	test('uses an Error message, else stringifies', () => {
		assert.equal(errMsg(new Error('boom')), 'boom');
		assert.equal(errMsg('plain'), 'plain');
		assert.equal(errMsg(404), '404');
	});
});
