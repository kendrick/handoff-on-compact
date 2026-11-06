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

export const register: Register = (on, options) => {
	const skillOption = typeof options.skill_path === 'string' ? options.skill_path : '';

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

		const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
		// $.fs doesn't expand ~, and a settings field is where people will type one.
		const skillPath =
			skillOption === ''
				? `${home}/.claude/skills/handoff/SKILL.md`
				: skillOption.replace(/^~(?=[/\\])/, `${home}`);
		if (!(await $.fs.exists(skillPath))) {
			$.ui.toast(`handoff-on-compact: no handoff skill at ${skillPath}, so core compacted`);
			return next(e);
		}
		const skill = await $.fs.read(skillPath);
		// A fork can't read the clock and writes 00:00, so the time comes from here, in local time as the skill uses.
		const now = new Date(await $.clock.now());
		const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		const hhmm = `${pad(now.getHours())}${pad(now.getMinutes())}`;
		// The focus stays out of ARGS: there it would turn a whole-session handoff into a prompt handoff.
		const focus = e.instructions ? `\nFocus: ${e.instructions}` : '';
		const reply = await $.model.fork({
			prompt: `${skill}\n\nARGS: inline${focus}\nCurrent local time: ${date} ${hhmm.slice(0, 2)}:${hhmm.slice(2)}`,
		});
		if (!reply.isAnswered) {
			$.ui.toast(`handoff-on-compact: fork failed (${reply.reason}), so core compacted`);
			return next(e);
		}

		const [, slug] = HEADING.exec(reply.text) ?? [];
		// Without `inline` the skill ends on its file pointer and a /clear line; swapped in, they'd tell the model to stop.
		const rejection =
			slug === undefined
				? 'no `# Handoff:` heading'
				: /^(Handoff written:|Clear this session:)/m.test(reply.text)
					? "reply carries the skill's pointer block"
					: undefined;
		const dir = await handoffDir($);
		if (rejection !== undefined) {
			// The fork was paid for, and its reply is the only evidence of why the contract broke. It goes in a
			// subfolder: a bare `handoff` resumes the newest file in dir and would pick this one up.
			const kept = `${dir}/rejected/${date}-${hhmm}.md`;
			await $.fs.write(kept, reply.text);
			$.ui.toast(`handoff-on-compact: ${rejection}, so core compacted · reply kept at ${kept}`);
			return next(e);
		}
		const base = `${dir}/${date}-${hhmm}-${slug}`;
		let path = `${base}.md`;
		for (let n = 1; await $.fs.exists(path); n++) {
			path = `${base}-${pad(now.getSeconds())}${n === 1 ? '' : `-${n}`}.md`;
		}
		await $.fs.write(path, reply.text);
		const id = path.slice(lastSep(path) + 1, -'.md'.length);
		$.ui.toast(`handoff-on-compact: saved ${path} · resume with \`handoff ${id}\``);

		return { messages: [{ role: 'user', text: reply.text, toolUses: [] }] };
	}).catch(($, e, next) => {
		$.ui.toast(`handoff-on-compact: ${next.error.message ?? next.error.kind}, so core compacted`);
		return next(e);
	});
};
