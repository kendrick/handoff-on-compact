import type { On, SessionMessage } from 'claude-code';
import { expect, test } from 'claude-code/testing';

const CHAT: SessionMessage[] = [{ role: 'user', text: 'hi', toolUses: [] }];
const CORE = {
	messages: [{ role: 'user', text: 'core summary', toolUses: [] }] satisfies SessionMessage[],
};
const USAGE = {
	input_tokens: 1,
	output_tokens: 1,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
};
const SKILL = '/home/k/.claude/skills/handoff/SKILL.md';
const WIN_SKILL = 'C:\\Users\\k/.claude/skills/handoff/SKILL.md';
const DOC =
	'# Handoff: probe-fork\n\n2026-11-06 14:05 PST · handoff-on-compact / main · Agent: Claude Code\n\n## Goal\n\nShip it.\n';

type Engine = {
	files?: Record<string, string>;
	env?: Record<string, string | undefined>;
	cwd?: string;
	git?: string;
	reply?: string;
	failure?: 'nothing-to-fork' | 'empty-reply' | 'aborted';
	writeFails?: boolean;
	// Deny only the log's writes, or only everything else's.
	logWriteFails?: boolean;
	docWriteFails?: boolean;
	// Holds every fork until it resolves, to stand for one still running.
	gate?: Promise<void>;
	// The first fork is refused outright, as an engine error would be.
	firstForkThrows?: boolean;
};

// Any handoff folder's log, wherever TMPDIR and the separator put it.
const isLog = (p: string) => /[\\/]log[\\/][^\\/]+\.json$/.test(p);
// Handoff documents only, so older assertions stay about what they were written for.
const docs = (w: Record<string, string>) =>
	Object.fromEntries(Object.entries(w).filter(([p]) => !isLog(p)));
const logged = (w: Record<string, string>) =>
	Object.entries(w)
		.filter(([p]) => isLog(p))
		.toSorted(([a], [b]) => a.localeCompare(b))
		.map(([, t]) => JSON.parse(t) as Record<string, unknown>);

// The test host is POSIX, so the engine resolves a drive path against the working directory; undo that.
const unresolve = (path: string) => path.replace(/^.*(?=[A-Z]:\\)/, '');

// Stands in for everything beneath the plugin, and records what the plugin did to it.
const engine = (
	on: On,
	{
		files = {},
		env = {},
		cwd = '/work/Handoff_On_Compact',
		git = cwd,
		reply = DOC,
		failure,
		writeFails = false,
		logWriteFails = false,
		docWriteFails = false,
		gate,
		firstForkThrows = false,
	}: Engine = {},
) => {
	const seen = {
		forks: [] as string[],
		writes: {} as Record<string, string>,
		toasts: [] as string[],
		toastTimeouts: [] as (number | undefined)[],
		core: [] as (string | undefined)[],
	};
	const disk: Record<string, string> = {
		[SKILL]: 'SKILL BODY',
		[WIN_SKILL]: 'SKILL BODY',
		...files,
	};

	on('session.compact', (_, e) => {
		seen.core.push(e.instructions);
		return CORE;
	});
	on('session.cwd', () => ({ value: cwd }));
	// Local time, as the skill names its files: 14:05:37 on the day DOC claims.
	on('clock.now', () => ({ value: new Date(2026, 10, 6, 14, 5, 37).getTime() }));
	on('env.get', (_, e) => ({ value: { HOME: '/home/k', TMPDIR: '/tmp/x/', ...env }[e.name] }));
	on('fs.exists', (_, e) => {
		const path = unresolve(e.path);
		return { value: path in disk || path === `${git}/.git` };
	});
	on('fs.read', (_, e) => {
		const text = disk[unresolve(e.path)];
		if (text === undefined) throw new Error(`ENOENT: ${e.path}`);
		return { value: text };
	});
	on('fs.write', (_, e) => {
		if (writeFails || (isLog(unresolve(e.path)) ? logWriteFails : docWriteFails))
			return { deny: `EACCES: ${e.path}` };
		seen.writes[unresolve(e.path)] = e.text;
		return { value: undefined };
	});
	on('ui.toast', (_, e) => {
		seen.toasts.push(e.text);
		seen.toastTimeouts.push(e.timeoutMs);
		return { value: undefined };
	});
	on('model.fork', async (_, e) => {
		seen.forks.push(e.prompt);
		await gate;
		if (firstForkThrows && seen.forks.length === 1) return { deny: 'engine error' };
		if (failure) return { value: { isAnswered: false as const, reason: failure, usage: USAGE } };
		return { value: { isAnswered: true as const, text: reply, usage: USAGE } };
	});

	return seen;
};

test('a precompute answers skip, so the engine keeps nothing and the real compaction still reaches the hook', async ($, on) => {
	engine(on);

	const result = await $.session.compact({ trigger: 'precompute', messages: CHAT });

	expect(result.skip).toBeDefined();
});

test('a manual compaction swaps the conversation for the handoff document', async ($, on) => {
	engine(on);

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(result.messages?.map((m) => m.text)).toEqual([DOC]);
});

test("a subagent's compaction goes to core, since its transcript isn't the session the handoff describes", async ($, on) => {
	const seen = engine(on);

	const result = await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: CHAT });

	expect(result).toEqual(CORE);
	expect(seen.forks).toEqual([]);
});

test('the document is saved where the handoff skill keeps its own, named from its heading and timestamp', async ($, on) => {
	const seen = engine(on);

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(docs(seen.writes)).toEqual({
		'/tmp/x/agent-handoff/handoff-on-compact/2026-11-06-1405-probe-fork.md': DOC,
	});
});

test('a reply without the heading falls back to core, and is kept beside the handoffs for a look', async ($, on) => {
	const reply = 'Handoff written: /tmp/x.md\nClear this session: /clear';
	const seen = engine(on, { reply });

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	const kept = '/tmp/x/agent-handoff/handoff-on-compact/rejected/2026-11-06-1405.md';
	expect(result).toEqual(CORE);
	expect(docs(seen.writes)).toEqual({ [kept]: reply });
	expect(seen.toasts).toEqual([
		`No \`# Handoff:\` heading, so core compacted · reply kept at ${kept}`,
	]);
});

test('a missing skill falls back to core before any fork, with a toast saying why', async ($, on) => {
	const seen = engine(on, { env: { HOME: '/nobody' } });

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(result).toEqual(CORE);
	expect(seen.forks).toEqual([]);
	expect(seen.toasts).toEqual([
		'No handoff skill at /nobody/.claude/skills/handoff/SKILL.md, so core compacted',
	]);
});

test('a fork that fails falls back to core, with a toast naming the reason', async ($, on) => {
	const seen = engine(on, { failure: 'nothing-to-fork' });

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(result).toEqual(CORE);
	expect(seen.toasts).toEqual(['Fork failed (nothing-to-fork), so core compacted']);
});

test('a taken filename gets the seconds appended, as the handoff skill does, so no handoff is overwritten', async ($, on) => {
	const taken = '/tmp/x/agent-handoff/handoff-on-compact/2026-11-06-1405-probe-fork.md';
	const seen = engine(on, { files: { [taken]: 'an earlier handoff' } });

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(Object.keys(docs(seen.writes))).toEqual([
		'/tmp/x/agent-handoff/handoff-on-compact/2026-11-06-1405-probe-fork-37.md',
	]);
});

test("from a subdirectory with no TMPDIR, the folder uses TEMP and the git root's name", async ($, on) => {
	const seen = engine(on, {
		cwd: '/work/Handoff_On_Compact/hooks',
		git: '/work/Handoff_On_Compact',
		env: { TMPDIR: undefined, TEMP: '/win/temp' },
	});

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(Object.keys(docs(seen.writes))).toEqual([
		'/win/temp/agent-handoff/handoff-on-compact/2026-11-06-1405-probe-fork.md',
	]);
});

test('text after /compact reaches the fork as a focus line, so ARGS stays `inline` and the skill writes the whole session', async ($, on) => {
	const seen = engine(on);

	await $.session.compact({
		trigger: 'manual',
		instructions: 'keep the API notes',
		messages: CHAT,
	});
	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(seen.forks.map((p) => p.split('\n').filter((l) => /^(ARGS|Focus):/.test(l)))).toEqual([
		['ARGS: inline', 'Focus: keep the API notes'],
		['ARGS: inline'],
	]);
});

test("the filename's time comes from the clock, since a fork can't read one and writes 00:00", async ($, on) => {
	const seen = engine(on, { reply: DOC.replace('2026-11-06 14:05 PST', '2026-11-06 00:00 local') });

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(Object.keys(docs(seen.writes))).toEqual([
		'/tmp/x/agent-handoff/handoff-on-compact/2026-11-06-1405-probe-fork.md',
	]);
});

test("the fork is told the local time, so the document's own timestamp line is right", async ($, on) => {
	const seen = engine(on);

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(seen.forks[0]?.split('\n')).toContain('Current local time: 2026-11-06 14:05');
});

test('when the seconds-suffixed name is taken too, a counter follows, so no handoff is ever overwritten', async ($, on) => {
	const dir = '/tmp/x/agent-handoff/handoff-on-compact';
	const seen = engine(on, {
		files: {
			[`${dir}/2026-11-06-1405-probe-fork.md`]: 'first',
			[`${dir}/2026-11-06-1405-probe-fork-37.md`]: 'second',
		},
	});

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(Object.keys(docs(seen.writes))).toEqual([`${dir}/2026-11-06-1405-probe-fork-37-2.md`]);
});

test('on Windows, the skill comes from USERPROFILE and the folder from the git root found across backslashes', async ($, on) => {
	const seen = engine(on, {
		cwd: 'C:\\work\\My Repo\\hooks',
		git: 'C:\\work\\My Repo',
		env: { HOME: undefined, USERPROFILE: 'C:\\Users\\k', TMPDIR: undefined, TEMP: 'C:\\Temp\\' },
	});

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(seen.toasts.filter((t) => t.includes('core compacted'))).toEqual([]);
	expect(Object.keys(docs(seen.writes))).toEqual([
		'C:\\Temp/agent-handoff/my-repo/2026-11-06-1405-probe-fork.md',
	]);
});

test('`/compact native` goes to core with the word stripped, and only a leading `native` word counts', async ($, on) => {
	const seen = engine(on);

	const bare = await $.session.compact({
		trigger: 'manual',
		instructions: 'native',
		messages: CHAT,
	});
	await $.session.compact({
		trigger: 'manual',
		instructions: 'native keep the API notes',
		messages: CHAT,
	});
	await $.session.compact({
		trigger: 'manual',
		instructions: 'natively keep the API notes',
		messages: CHAT,
	});

	expect(bare).toEqual(CORE);
	expect(seen.core).toEqual([undefined, 'keep the API notes']);
	expect(seen.forks).toHaveLength(1);
});

test('a swap toasts where the document went and how to resume it, since the swap itself is silent', async ($, on) => {
	const seen = engine(on);

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(seen.toasts).toEqual([
		'Swapped in the handoff · send any message to continue from it · saved /tmp/x/agent-handoff/handoff-on-compact/2026-11-06-1405-probe-fork.md for `handoff 2026-11-06-1405-probe-fork`',
	]);
});

test("a document that still carries the skill's pointer block is rejected, not swapped in with it", async ($, on) => {
	const reply = `${DOC}\nHandoff written: /tmp/x.md\nClear this session: /clear Probe Fork ☑️\n`;
	const seen = engine(on, { reply });

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	const kept = '/tmp/x/agent-handoff/handoff-on-compact/rejected/2026-11-06-1405.md';
	expect(result).toEqual(CORE);
	expect(docs(seen.writes)).toEqual({ [kept]: reply });
	expect(seen.toasts).toEqual([
		`Reply carries the skill's pointer block, so core compacted · reply kept at ${kept}`,
	]);
});

test('an error anywhere in the hook falls back to core with a toast, never silently', async ($, on) => {
	const seen = engine(on, { writeFails: true });

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(result).toEqual(CORE);
	expect(seen.toasts).toHaveLength(1);
	expect(seen.toasts[0]).toMatch(/^[^h].*EACCES.*, so core compacted$/);
});

test(
	'skill_path points the plugin at another SKILL.md, with a leading ~ read as the home folder',
	{ options: { skill_path: '~/forks/handoff/SKILL.md' } },
	async ($, on) => {
		const seen = engine(on, { files: { '/home/k/forks/handoff/SKILL.md': 'FORKED SKILL' } });

		await $.session.compact({ trigger: 'manual', messages: CHAT });

		expect(seen.forks[0]?.startsWith('FORKED SKILL\n')).toBe(true);
	},
);

test('a second rejected reply in the same minute gets its own file, so neither is lost', async ($, on) => {
	const dir = '/tmp/x/agent-handoff/handoff-on-compact/rejected';
	const seen = engine(on, {
		reply: 'no heading here',
		files: { [`${dir}/2026-11-06-1405.md`]: 'the first' },
	});

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(Object.keys(docs(seen.writes))).toEqual([`${dir}/2026-11-06-1405-37.md`]);
});

test('the swap toast stays long enough to read its path and id, since the default 4 s does not', async ($, on) => {
	const seen = engine(on);

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(seen.toastTimeouts[0]).toBeGreaterThanOrEqual(15_000);
});

// Promise.withResolvers runs here, but the engine's TS lib predates its typings.
const deferred = () => {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((done) => (resolve = done));
	return { promise, resolve: () => resolve?.() };
};

const said = (
	text: string,
	handle: string,
	role: 'user' | 'assistant' = 'user',
): SessionMessage => ({
	role,
	text,
	toolUses: [],
	handle,
});

test('a precomputed handoff swaps in with no second fork, and everything said after it follows verbatim', async ($, on) => {
	const seen = engine(on);
	const before = [said('hi', 'h1'), said('on it', 'h2', 'assistant')];
	await $.session.compact({ trigger: 'precompute', messages: before });

	const after = [...before, said('one more thing', 'h3'), said('done', 'h4', 'assistant')];
	const result = await $.session.compact({ trigger: 'manual', messages: after });

	expect(seen.forks).toHaveLength(1);
	expect(result.messages?.[0]?.text.startsWith(DOC)).toBe(true);
	expect(result.messages?.slice(1).map((m) => [m.text, m.handle])).toEqual([
		['one more thing', 'h3'],
		['done', 'h4'],
	]);
});

test('a tail over the cap forks fresh, since swapping it in would leave the context nearly as full', async ($, on) => {
	const seen = engine(on);
	const before = [said('hi', 'h1')];
	await $.session.compact({ trigger: 'precompute', messages: before });

	const huge = said('x'.repeat(60_001), 'h2', 'assistant');
	const result = await $.session.compact({ trigger: 'manual', messages: [...before, huge] });

	expect(seen.forks).toHaveLength(2);
	expect(result.messages?.map((m) => m.text)).toEqual([DOC]);
});

test('/compact with focus text forks fresh, since the precomputed document was written without it', async ($, on) => {
	const seen = engine(on);
	const before = [said('hi', 'h1')];
	await $.session.compact({ trigger: 'precompute', messages: before });

	await $.session.compact({
		trigger: 'manual',
		instructions: 'keep the API notes',
		messages: before,
	});

	expect(seen.forks).toHaveLength(2);
	expect(seen.forks[1]?.split('\n')).toContain('Focus: keep the API notes');
});

test('a precompute whose last message is gone (a /clear or a rewind) forks fresh', async ($, on) => {
	const seen = engine(on);
	await $.session.compact({ trigger: 'precompute', messages: [said('hi', 'h1')] });

	await $.session.compact({ trigger: 'manual', messages: [said('a new start', 'h9')] });

	expect(seen.forks).toHaveLength(2);
});

test('a failed precompute stays quiet, and the compaction forks fresh', async ($, on) => {
	const seen = engine(on, { reply: 'no heading here' });
	await $.session.compact({ trigger: 'precompute', messages: [said('hi', 'h1')] });

	expect(seen.toasts).toEqual([]);
	expect(docs(seen.writes)).toEqual({});

	await $.session.compact({ trigger: 'manual', messages: [said('hi', 'h1')] });

	expect(seen.forks).toHaveLength(2);
});

test('a compaction that arrives while the precompute is still forking waits for it, so only one fork runs', async ($, on) => {
	const gate = deferred();
	const seen = engine(on, { gate: gate.promise });
	const before = [said('hi', 'h1')];

	const early = $.session.compact({ trigger: 'precompute', messages: before });
	const compaction = $.session.compact({ trigger: 'manual', messages: before });
	gate.resolve();
	await early;
	const result = await compaction;

	expect(seen.forks).toHaveLength(1);
	expect(result.messages?.[0]?.text.startsWith(DOC)).toBe(true);
});

test('a precomputed document is used once, so the next compaction forks fresh', async ($, on) => {
	const seen = engine(on);
	const before = [said('hi', 'h1')];
	await $.session.compact({ trigger: 'precompute', messages: before });
	await $.session.compact({ trigger: 'manual', messages: before });

	await $.session.compact({ trigger: 'manual', messages: before });

	expect(seen.forks).toHaveLength(2);
});

test('a precompute that throws stays quiet, and the compaction forks fresh with no error toast', async ($, on) => {
	const seen = engine(on, { firstForkThrows: true });
	const before = [said('hi', 'h1')];
	await $.session.compact({ trigger: 'precompute', messages: before });

	const result = await $.session.compact({ trigger: 'manual', messages: before });

	expect(seen.forks).toHaveLength(2);
	expect(result.messages?.map((m) => m.text)).toEqual([DOC]);
	expect(seen.toasts.filter((t) => t.includes('core compacted'))).toEqual([]);
});

test('a precompute over messages with no handle is never matched, so the compaction forks fresh', async ($, on) => {
	const seen = engine(on);
	await $.session.compact({ trigger: 'precompute', messages: CHAT });

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(seen.forks).toHaveLength(2);
});

const AFTER_NOTE = 'The messages that follow are newer than it.';

test('a compaction with no precompute logs a fresh fork', async ($, on) => {
	const seen = engine(on);

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(logged(seen.writes)).toMatchObject([
		{
			event: 'compact',
			trigger: 'manual',
			precompute: 'none',
			path: 'fresh',
			why: 'no-precompute',
			cap: 60_000,
		},
	]);
});

test('a precomputed swap logs cached, with the precompute logged first', async ($, on) => {
	const seen = engine(on);
	const before = [said('hi', 'h1')];
	await $.session.compact({ trigger: 'precompute', messages: before });

	await $.session.compact({ trigger: 'manual', messages: [...before, said('more', 'h2')] });

	const [early, swap] = logged(seen.writes);
	expect(early).toMatchObject({ event: 'precompute', outcome: 'accepted' });
	expect(swap).toMatchObject({
		event: 'compact',
		precompute: 'accepted',
		coveredFound: true,
		path: 'cached',
		why: 'precomputed',
	});
	expect(swap?.['tail']).toBeGreaterThan(0);
});

// The rule from #2: the log says cached exactly when the swap carries the AFTER note. This test and the next two
// each move one input and check the log against the result it describes.
test('a tail over the cap logs a fresh fork, and the swap carries no AFTER note', async ($, on) => {
	const seen = engine(on);
	await $.session.compact({ trigger: 'precompute', messages: [said('hi', 'h1')] });

	const result = await $.session.compact({
		trigger: 'manual',
		messages: [said('hi', 'h1'), said('x'.repeat(60_001), 'h2', 'assistant')],
	});

	expect(result.messages?.[0]?.text.endsWith(AFTER_NOTE)).toBe(false);
	expect(logged(seen.writes).at(-1)).toMatchObject({ path: 'fresh', why: 'tail-over-cap' });
});

test('a large precomputed document with a small tail still swaps in cached', async ($, on) => {
	const seen = engine(on, { reply: DOC + 'x'.repeat(70_000) });
	await $.session.compact({ trigger: 'precompute', messages: [said('hi', 'h1')] });

	const result = await $.session.compact({ trigger: 'manual', messages: [said('hi', 'h1')] });

	expect(result.messages?.[0]?.text.endsWith(AFTER_NOTE)).toBe(true);
	expect(logged(seen.writes).at(-1)).toMatchObject({ path: 'cached', why: 'precomputed' });
});

test('a precompute whose last message is gone logs handle-missing', async ($, on) => {
	const seen = engine(on);
	await $.session.compact({ trigger: 'precompute', messages: [said('hi', 'h1')] });

	const result = await $.session.compact({
		trigger: 'manual',
		messages: [said('a new start', 'h9')],
	});

	expect(result.messages?.[0]?.text.endsWith(AFTER_NOTE)).toBe(false);
	expect(logged(seen.writes).at(-1)).toMatchObject({
		coveredFound: false,
		why: 'handle-missing',
		path: 'fresh',
	});
});

test('a focused /compact logs why it skipped the precompute', async ($, on) => {
	const seen = engine(on);
	const before = [said('hi', 'h1')];
	await $.session.compact({ trigger: 'precompute', messages: before });

	await $.session.compact({
		trigger: 'manual',
		instructions: 'keep the API notes',
		messages: before,
	});

	expect(logged(seen.writes).at(-1)).toMatchObject({ why: 'focus', path: 'fresh' });
	expect(logged(seen.writes).at(-1)?.['precompute']).toBeUndefined();
});

test('a rejected precompute logs its outcome, and the compaction says why it fell back', async ($, on) => {
	const seen = engine(on, { reply: 'no heading here' });
	await $.session.compact({ trigger: 'precompute', messages: [said('hi', 'h1')] });

	await $.session.compact({ trigger: 'manual', messages: [said('hi', 'h1')] });

	expect(logged(seen.writes)).toMatchObject([
		{ event: 'precompute', outcome: 'rejected' },
		{ event: 'compact', precompute: 'rejected', path: 'core', why: 'rejected' },
	]);
});

test('a precompute that throws logs fork-failed', async ($, on) => {
	const seen = engine(on, { firstForkThrows: true });

	await $.session.compact({ trigger: 'precompute', messages: [said('hi', 'h1')] });

	expect(logged(seen.writes)).toMatchObject([
		{ event: 'precompute', outcome: 'fork-failed', reason: 'precompute threw' },
	]);
});

test('two compactions in one second keep separate log files', async ($, on) => {
	const seen = engine(on);
	const before = [said('hi', 'h1')];
	await $.session.compact({ trigger: 'precompute', messages: before });
	await $.session.compact({ trigger: 'manual', messages: before });

	await $.session.compact({ trigger: 'manual', messages: before });

	expect(logged(seen.writes)).toHaveLength(3);
});

test('a log write that fails changes nothing about the compaction', async ($, on) => {
	const seen = engine(on, { logWriteFails: true });

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(result.messages?.map((m) => m.text)).toEqual([DOC]);
	expect(seen.toasts).toHaveLength(1);
	expect(seen.toasts[0]).toMatch(/^Swapped in the handoff/);
});

test('an error in the hook still logs, as core', async ($, on) => {
	const seen = engine(on, { docWriteFails: true });

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(result).toEqual(CORE);
	const lines = logged(seen.writes);
	expect(lines).toMatchObject([{ event: 'compact', path: 'core' }]);
	expect(String(lines[0]?.['why'])).toMatch(/EACCES/);
	expect(lines[0]?.['precompute']).toBeUndefined();
});

test('subagent and native compactions write no log', async ($, on) => {
	const seen = engine(on);

	await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: CHAT });
	await $.session.compact({ trigger: 'manual', instructions: 'native', messages: CHAT });

	expect(logged(seen.writes)).toEqual([]);
});
