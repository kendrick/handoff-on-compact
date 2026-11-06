# handoff-on-compact

A Claude Code plugin that turns compaction into a handoff. When the conversation compacts, a fork of the session writes a handoff document from the [`handoff` skill](https://github.com/kendrick/skills/tree/main/handoff)'s own template. The plugin saves that document where the skill keeps its handoffs and replaces the conversation with it. You get the same result as running `handoff`, then `/clear`, then resuming, without leaving the session.

## Why

Claude Code's built-in compaction writes a free-form summary, and the next turn has to work out what's still open. The `handoff` skill already writes a document that answers that question: unfinished tasks, decisions, gotchas, and how to verify. This plugin runs the skill whenever the conversation compacts, so you don't have to remember to run it yourself.

The skill stays the manual path and works across agents and operating systems. This plugin is the automatic path and runs only in Claude Code. The plugin carries no copy of the template, so when the skill's template changes, so does the plugin's output.

## Install

At the prompt of a terminal session:

```text
/plugin install handoff-on-compact --marketplace kendrick/handoff-on-compact
```

From a shell:

```sh
claude plugin install handoff-on-compact --marketplace kendrick/handoff-on-compact
```

The plugin needs the `handoff` skill installed, in a version with the `inline` destination from [kendrick/skills#302](https://github.com/kendrick/skills/issues/302). Without the skill, compaction falls back to Claude Code's own summarizer.

## How It Works

On a compaction of the main conversation, the plugin:

1. Reads the installed `handoff` skill's `SKILL.md` and asks a fork of the session to write a handoff document from it.
2. Saves the document to `$TMPDIR/agent-handoff/<project>/<YYYY-MM-DD-HHMM>-<slug>.md`, the same name and folder the skill uses. A toast names the file, and `handoff <id>` can resume it from any later session.
3. Replaces the conversation with that one document, and the model carries on from it.

Text after `/compact` goes to the fork as a focus line, so `/compact keep the API notes` still gets a full handoff document that leans toward the API notes.

If the plugin can't produce a document, Claude Code's own compaction runs instead, and a toast says why: the skill wasn't found, the fork failed, the reply broke the skill's contract, or the plugin hit an error. A reply that broke the contract is kept in `rejected/` inside the handoff folder, so you can see what the fork wrote.

To see what the next compaction would swap in, run `/handoff-preview`. It forks the same way the compaction does and shows the document with the path it would be saved to, or the rejected reply with the reason. It never compacts or writes a file. Text after `/handoff-preview` works like text after `/compact`.

To skip the plugin for one compaction on purpose, run `/compact native`. Any text after `native` goes to Claude Code's compaction as usual. The plugin leaves compactions inside subagents alone.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `skill_path` | empty, which reads `~/.claude/skills/handoff/SKILL.md` | Where the plugin reads the `handoff` skill's `SKILL.md`. A leading `~` is your home folder. |

## Develop

To load the plugin from this folder, start a session with it:

```sh
claude --plugin-dir .
```

Before the first typecheck, load the plugin once. Claude Code writes the plugin API's types into `.claude-plugin/types/` when it loads the plugin, and `tsconfig.json` extends them.

To check it, run:

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm format
claude plugin validate .
claude plugin test .
```

To regenerate the changelog from conventional commits, run `git cliff -o CHANGELOG.md`.

## License

MIT
