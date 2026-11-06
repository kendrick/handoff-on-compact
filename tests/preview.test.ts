import type { On } from 'claude-code';
import { type Engine, expect, test } from 'claude-code/testing';

const SKILL = '/home/k/.claude/skills/handoff/SKILL.md';
const DOC =
	'# Handoff: probe-fork\n\n2026-11-06 14:05 PST · handoff-on-compact / main · Agent: Claude Code\n\n## Goal\n\nShip it.\n';
const USAGE = {
	input_tokens: 1,
	output_tokens: 1,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
};

// The engine beneath the plugin, as in compact.test.ts, plus the command registry the preview needs.
const engine = (
	on: On,
	{ reply = DOC, home = '/home/k' }: { reply?: string; home?: string } = {},
) => {
	const seen = { forks: [] as string[], writes: [] as string[], commands: [] as string[] };

	on('command.register', (_, e) => {
		seen.commands.push(e.name);
		return { value: { command: e.name } };
	});
	on('session.start', (_, e) => ({ cwd: e.cwd }));
	on('session.cwd', () => ({ value: '/work/Handoff_On_Compact' }));
	on('clock.now', () => ({ value: new Date(2026, 10, 6, 14, 5, 37).getTime() }));
	on('env.get', (_, e) => ({
		value: ({ HOME: home, TMPDIR: '/tmp/x/' } as Record<string, string>)[e.name],
	}));
	on('fs.exists', (_, e) => ({
		value: e.path === SKILL || e.path === '/work/Handoff_On_Compact/.git',
	}));
	on('fs.read', () => ({ value: 'SKILL BODY' }));
	on('fs.write', (_, e) => {
		seen.writes.push(e.path);
		return { value: undefined };
	});
	on('model.fork', (_, e) => {
		seen.forks.push(e.prompt);
		return { value: { isAnswered: true as const, text: reply, usage: USAGE } };
	});

	return seen;
};

const preview = ($: Engine, args: string) =>
	$.command.run({
		command: 'handoff-preview',
		args,
		origin: { kind: 'composer' },
		presentation: { isFullscreen: false, columns: 120 },
	});

test('/handoff-preview shows the document the hook would swap in and where it would go, writing nothing', async ($, on) => {
	const seen = engine(on);
	await $.session.start({
		cwd: '/work/Handoff_On_Compact',
		surface: 'terminal',
		isInteractive: true,
	});

	const { text } = await preview($, '');

	expect(seen.commands).toContain('handoff-preview');
	expect(text).toContain(DOC);
	expect(text).toContain('/tmp/x/agent-handoff/handoff-on-compact/2026-11-06-1405-probe-fork.md');
	expect(seen.writes).toEqual([]);
});

test("a reply the hook would reject is shown raw, with the hook's reason", async ($, on) => {
	const reply = `${DOC}\nHandoff written: /tmp/x.md\n`;
	const seen = engine(on, { reply });

	const { text } = await preview($, '');

	expect(text).toContain("reply carries the skill's pointer block");
	expect(text).toContain(reply);
	expect(seen.writes).toEqual([]);
});

test('a missing skill is reported by path, and nothing forks', async ($, on) => {
	const seen = engine(on, { home: '/nobody' });

	const { text } = await preview($, '');

	expect(text).toContain('/nobody/.claude/skills/handoff/SKILL.md');
	expect(seen.forks).toEqual([]);
});

test('text after the command reaches the fork as the focus line, as /compact text does', async ($, on) => {
	const seen = engine(on);

	await preview($, 'keep the API notes');

	expect(seen.forks[0]?.split('\n')).toContain('Focus: keep the API notes');
});

test("the preview's text skips the plugin name, which the engine already puts in front of it", async ($, on) => {
	engine(on);

	const { text } = await preview($, '');

	expect(text?.startsWith('Would save this to /tmp/x/agent-handoff/')).toBe(true);
});
