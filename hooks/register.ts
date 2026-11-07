import type { EngineInterface, Register, SessionMessage } from 'claude-code';

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

// Past this many characters, the swap would leave the context nearly as full as before (about 15k tokens).
const TAIL_CAP = 60_000;

// shortcut: JSON length overcounts a little against the text a request carries; fine for a cap.
const size = (messages: readonly SessionMessage[]) => JSON.stringify(messages).length;

const AFTER =
	'The conversation continued after this handoff was written. The messages that follow are newer than it.';

// The swap sends no prompt to the model, so the session sits idle until the user speaks, and the toast has to say that.
// It carries the path and id to resume from, more than the default 4 s lets anyone read.
const toastSwap = ($: EngineInterface, path: string) => {
	const id = path.slice(lastSep(path) + 1, -'.md'.length);
	$.ui.toast(
		`Swapped in the handoff · send any message to continue from it · saved ${path} for \`handoff ${id}\``,
		{ timeoutMs: 15_000 },
	);
};

// Toasts and command text carry no plugin name: Claude Code draws both under it already.
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

	// The fork written ahead of time, and the last message it read. A module variable: a reload drops it,
	// and the compaction then forks fresh, which is the fallback anyway.
	let ahead: { pending: Promise<Attempt>; coveredHandle: string | undefined } | undefined;

	// Fork on the engine's precompute so the real compaction swaps instantly, then answer skip so the
	// engine keeps nothing of its own and the real compaction still comes back through this hook.
	on('session.compact', { trigger: 'precompute' }, async ($, e) => {
		if (e.agentId === undefined) {
			// Nobody asked for a precompute, so its failures stay quiet and the compaction forks fresh.
			const pending = attempt($, skillOption).catch((): Attempt => ({
				outcome: 'fork-failed',
				reason: 'precompute threw',
			}));
			ahead = { pending, coveredHandle: e.messages.at(-1)?.handle };
			await pending;
		}
		return { skip: 'handoff-on-compact writes its own handoff ahead of time' };
	});

	on('session.compact', async ($, e, next) => {
		if (e.agentId !== undefined) return next(e);

		// The escape hatch. A command can't compact while its own turn is open, so it rides /compact's text instead.
		const native = /^native(?:\s+(.*))?$/s.exec(e.instructions ?? '');
		if (native) {
			const { instructions: _, ...rest } = e;
			return next(native[1] ? { ...rest, instructions: native[1] } : rest);
		}

		const cached = ahead;
		ahead = undefined;
		// The stored document was written without focus text, so a focused /compact needs its own fork.
		if (cached !== undefined && e.instructions === undefined) {
			const early = await cached.pending;
			const { coveredHandle } = cached;
			const at =
				coveredHandle === undefined ? -1 : e.messages.findIndex((m) => m.handle === coveredHandle);
			// Messages after the precompute ride along verbatim, so nothing said since is summarized away.
			const tail = at === -1 ? undefined : e.messages.slice(at + 1);
			if (early.outcome === 'accepted' && tail !== undefined && size(tail) <= TAIL_CAP) {
				await $.fs.write(early.path, early.text);
				toastSwap($, early.path);
				return {
					messages: [{ role: 'user', text: `${early.text}\n\n${AFTER}`, toolUses: [] }, ...tail],
				};
			}
		}

		const result = await attempt($, skillOption, e.instructions);
		switch (result.outcome) {
			case 'no-skill':
				$.ui.toast(`No handoff skill at ${result.skillPath}, so core compacted`);
				return next(e);
			case 'fork-failed':
				$.ui.toast(`Fork failed (${result.reason}), so core compacted`);
				return next(e);
			case 'rejected':
				await $.fs.write(result.path, result.text);
				$.ui.toast(
					`${result.reason.charAt(0).toUpperCase()}${result.reason.slice(1)}, so core compacted · reply kept at ${result.path}`,
				);
				return next(e);
		}
		await $.fs.write(result.path, result.text);
		toastSwap($, result.path);
		return { messages: [{ role: 'user', text: result.text, toolUses: [] }] };
	}).catch(($, e, next) => {
		$.ui.toast(`${next.error.message ?? next.error.kind}, so core compacted`);
		return next(e);
	});
};
