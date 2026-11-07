import type { EngineInterface, Register } from 'claude-code';

// The skill's own contract (ADR 0002): the reply opens with this heading, and the filename's slug comes from it.
const HEADING = /^# Handoff: ([a-z0-9-]+)\n/;

const pad = (n: number) => String(n).padStart(2, '0');

// Windows paths arrive with backslashes, and Windows also accepts the forward slashes this joins with.
const lastSep = (p: string) => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));

// Mirrors the handoff skill's HANDOFF_DIR, so `handoff <id>` resumes what this plugin saved.
const handoffDir = async ($: EngineInterface) => {
	const tmp = (await $.env.get('TMPDIR')) ?? (await $.env.get('TEMP')) ?? '/tmp';
	const cwd = await $.session.cwd();
	let root = cwd;
	while (!(await $.fs.exists(`${root}/.git`))) {
		const up = root.slice(0, lastSep(root));
		if (up === '' || up === root) {
			root = cwd;
			break;
		}
		root = up;
	}
	const project = root
		.slice(lastSep(root) + 1)
		.toLowerCase()
		.replaceAll(/[^a-z0-9-]+/g, '-');

	return `${tmp.replace(/[/\\]+$/, '')}/agent-handoff/${project}`;
};

type Attempt =
	| { outcome: 'no-skill'; skillPath: string }
	| { outcome: 'fork-failed'; reason: string }
	| { outcome: 'rejected'; reason: string; text: string; path: string }
	| { outcome: 'accepted'; text: string; path: string };

// One fork and one verdict, shared by the hook and /handoff-preview so the preview can't drift from what compaction does.
// It writes nothing: `path` is where the caller would save the reply.
const attempt = async (
	$: EngineInterface,
	skillOption: string,
	focusText?: string,
): Promise<Attempt> => {
	const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
	// $.fs doesn't expand ~, and a settings field is where people will type one.
	const skillPath =
		skillOption === ''
			? `${home}/.claude/skills/handoff/SKILL.md`
			: skillOption.replace(/^~(?=[/\\])/, `${home}`);
	if (!(await $.fs.exists(skillPath))) return { outcome: 'no-skill', skillPath };
	const skill = await $.fs.read(skillPath);

	// A fork can't read the clock and writes 00:00, so the time comes from here, in local time as the skill uses.
	const now = new Date(await $.clock.now());
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const hhmm = `${pad(now.getHours())}${pad(now.getMinutes())}`;
	// The focus stays out of ARGS: there it would turn a whole-session handoff into a prompt handoff.
	const focus = focusText ? `\nFocus: ${focusText}` : '';
	const reply = await $.model.fork({
		prompt: `${skill}\n\nARGS: inline${focus}\nCurrent local time: ${date} ${hhmm.slice(0, 2)}:${hhmm.slice(2)}`,
	});
	if (!reply.isAnswered) return { outcome: 'fork-failed', reason: reply.reason };

	const [, slug] = HEADING.exec(reply.text) ?? [];
	// Without `inline` the skill ends on its file pointer and a /clear line; swapped in, they'd tell the model to stop.
	const rejection =
		slug === undefined
			? 'no `# Handoff:` heading'
			: /^(Handoff written:|Clear this session:)/m.test(reply.text)
				? "reply carries the skill's pointer block"
				: undefined;
	const dir = await handoffDir($);
	// The skill's collision rule is -<SS>; the counter past it keeps any file from being overwritten.
	const freePath = async (base: string) => {
		let path = `${base}.md`;
		for (let n = 1; await $.fs.exists(path); n++) {
			path = `${base}-${pad(now.getSeconds())}${n === 1 ? '' : `-${n}`}.md`;
		}
		return path;
	};
	if (rejection !== undefined) {
		// The fork was paid for, and its reply is the only evidence of why the contract broke. It goes in a
		// subfolder: a bare `handoff` resumes the newest file in dir and would pick this one up.
		return {
			outcome: 'rejected',
			reason: rejection,
			text: reply.text,
			path: await freePath(`${dir}/rejected/${date}-${hhmm}`),
		};
	}
	return {
		outcome: 'accepted',
		text: reply.text,
		path: await freePath(`${dir}/${date}-${hhmm}-${slug}`),
	};
};

export const register: Register = (on, options) => {
	const skillOption = typeof options.skill_path === 'string' ? options.skill_path : '';

	on('session.start', async ($, e, next) => {
		await $.command.register({
			name: 'handoff-preview',
			description:
				'Show the handoff document the next compaction would swap in, without compacting',
			argumentHint: '[focus]',
		});
		return next(e);
	});

	// The engine refuses $.session.compact inside a command, so the preview can show a document but never swap it in.
	on('command.run', { command: 'handoff-preview' }, async ($, e) => {
		const result = await attempt($, skillOption, e.args.trim() || undefined);
		switch (result.outcome) {
			case 'no-skill':
				return { text: `No handoff skill at ${result.skillPath}` };
			case 'fork-failed':
				return { text: `Fork failed (${result.reason})` };
			case 'rejected':
				return {
					text: `Would reject this reply: ${result.reason}\n\n${result.text}`,
				};
		}
		return {
			text: `Would save this to ${result.path} and swap it in:\n\n${result.text}`,
		};
	});

	// A precompute result is kept for a compaction that may never come, so a fork there is spend
	// with no payoff, and its document would be stale by the time it's used.
	on('session.compact', { trigger: 'precompute' }, () => ({
		skip: 'handoff-on-compact writes at compaction time',
	}));

	on('session.compact', async ($, e, next) => {
		if (e.agentId !== undefined) return next(e);

		// The escape hatch. A command can't compact while its own turn is open, so it rides /compact's text instead.
		const native = /^native(?:\s+(.*))?$/s.exec(e.instructions ?? '');
		if (native) {
			const { instructions: _, ...rest } = e;
			return next(native[1] ? { ...rest, instructions: native[1] } : rest);
		}

		const result = await attempt($, skillOption, e.instructions);
		switch (result.outcome) {
			case 'no-skill':
				$.ui.toast(
					`handoff-on-compact: no handoff skill at ${result.skillPath}, so core compacted`,
				);
				return next(e);
			case 'fork-failed':
				$.ui.toast(`handoff-on-compact: fork failed (${result.reason}), so core compacted`);
				return next(e);
			case 'rejected':
				await $.fs.write(result.path, result.text);
				$.ui.toast(
					`handoff-on-compact: ${result.reason}, so core compacted · reply kept at ${result.path}`,
				);
				return next(e);
		}
		await $.fs.write(result.path, result.text);
		const id = result.path.slice(lastSep(result.path) + 1, -'.md'.length);
		// The swap sends no prompt to the model, so the session sits idle until the user speaks, and the toast has to say that.
		$.ui.toast(
			`handoff-on-compact: swapped in the handoff · send any message to continue from it · saved ${result.path} for \`handoff ${id}\``,
		);
		return { messages: [{ role: 'user', text: result.text, toolUses: [] }] };
	}).catch(($, e, next) => {
		$.ui.toast(`handoff-on-compact: ${next.error.message ?? next.error.kind}, so core compacted`);
		return next(e);
	});
};
