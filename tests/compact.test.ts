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
};

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
	}: Engine = {},
) => {
	const seen = {
		forks: [] as string[],
		writes: {} as Record<string, string>,
		toasts: [] as string[],
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
		if (writeFails) return { deny: `EACCES: ${e.path}` };
		seen.writes[unresolve(e.path)] = e.text;
		return { value: undefined };
	});
	on('ui.toast', (_, e) => {
		seen.toasts.push(e.text);
		return { value: undefined };
	});
	on('model.fork', (_, e) => {
		seen.forks.push(e.prompt);
		if (failure) return { value: { isAnswered: false as const, reason: failure, usage: USAGE } };
		return { value: { isAnswered: true as const, text: reply, usage: USAGE } };
	});

	return seen;
};

test('a precompute is skipped, so no fork runs ahead of a compaction that may never come', async ($, on) => {
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

	expect(seen.writes).toEqual({
		'/tmp/x/agent-handoff/handoff-on-compact/2026-11-06-1405-probe-fork.md': DOC,
	});
});

test('a reply without the heading falls back to core, and is kept beside the handoffs for a look', async ($, on) => {
	const reply = 'Handoff written: /tmp/x.md\nClear this session: /clear';
	const seen = engine(on, { reply });

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	const kept = '/tmp/x/agent-handoff/handoff-on-compact/rejected/2026-11-06-1405.md';
	expect(result).toEqual(CORE);
	expect(seen.writes).toEqual({ [kept]: reply });
	expect(seen.toasts).toEqual([
		`handoff-on-compact: no \`# Handoff:\` heading, so core compacted · reply kept at ${kept}`,
	]);
});

test('a missing skill falls back to core before any fork, with a toast saying why', async ($, on) => {
	const seen = engine(on, { env: { HOME: '/nobody' } });

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(result).toEqual(CORE);
	expect(seen.forks).toEqual([]);
	expect(seen.toasts).toEqual([
		'handoff-on-compact: no handoff skill at /nobody/.claude/skills/handoff/SKILL.md, so core compacted',
	]);
});

test('a fork that fails falls back to core, with a toast naming the reason', async ($, on) => {
	const seen = engine(on, { failure: 'nothing-to-fork' });

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(result).toEqual(CORE);
	expect(seen.toasts).toEqual([
		'handoff-on-compact: fork failed (nothing-to-fork), so core compacted',
	]);
});

test('a taken filename gets the seconds appended, as the handoff skill does, so no handoff is overwritten', async ($, on) => {
	const taken = '/tmp/x/agent-handoff/handoff-on-compact/2026-11-06-1405-probe-fork.md';
	const seen = engine(on, { files: { [taken]: 'an earlier handoff' } });

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(Object.keys(seen.writes)).toEqual([
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

	expect(Object.keys(seen.writes)).toEqual([
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

	expect(Object.keys(seen.writes)).toEqual([
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

	expect(Object.keys(seen.writes)).toEqual([`${dir}/2026-11-06-1405-probe-fork-37-2.md`]);
});

test('on Windows, the skill comes from USERPROFILE and the folder from the git root found across backslashes', async ($, on) => {
	const seen = engine(on, {
		cwd: 'C:\\work\\My Repo\\hooks',
		git: 'C:\\work\\My Repo',
		env: { HOME: undefined, USERPROFILE: 'C:\\Users\\k', TMPDIR: undefined, TEMP: 'C:\\Temp\\' },
	});

	await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(seen.toasts.filter((t) => t.includes('core compacted'))).toEqual([]);
	expect(Object.keys(seen.writes)).toEqual([
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
		'handoff-on-compact: saved /tmp/x/agent-handoff/handoff-on-compact/2026-11-06-1405-probe-fork.md · resume with `handoff 2026-11-06-1405-probe-fork`',
	]);
});

test("a document that still carries the skill's pointer block is rejected, not swapped in with it", async ($, on) => {
	const reply = `${DOC}\nHandoff written: /tmp/x.md\nClear this session: /clear Probe Fork ☑️\n`;
	const seen = engine(on, { reply });

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	const kept = '/tmp/x/agent-handoff/handoff-on-compact/rejected/2026-11-06-1405.md';
	expect(result).toEqual(CORE);
	expect(seen.writes).toEqual({ [kept]: reply });
	expect(seen.toasts).toEqual([
		`handoff-on-compact: reply carries the skill's pointer block, so core compacted · reply kept at ${kept}`,
	]);
});

test('an error anywhere in the hook falls back to core with a toast, never silently', async ($, on) => {
	const seen = engine(on, { writeFails: true });

	const result = await $.session.compact({ trigger: 'manual', messages: CHAT });

	expect(result).toEqual(CORE);
	expect(seen.toasts).toHaveLength(1);
	expect(seen.toasts[0]).toMatch(/^handoff-on-compact: .*EACCES.*, so core compacted$/);
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

	expect(Object.keys(seen.writes)).toEqual([`${dir}/2026-11-06-1405-37.md`]);
});
