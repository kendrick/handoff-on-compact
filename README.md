# handoff-on-compact

When Claude Code compacts your conversation, get a handoff document instead of a summary.

A handoff document is a short Markdown file that the [`handoff` skill](https://github.com/kendrick/skills/tree/main/handoff) writes for the next session to pick up from. It lists the unfinished tasks, the goal, what's done, the exact next step, the files that matter, decisions and gotchas, and how to verify the work. At every compaction, this plugin has a fork of your session write one, saves it, and replaces the conversation with it. You get the same result as running `handoff`, then `/clear`, then resuming, without leaving the session.

Here's what a compaction looks like, from a real session. First the toast, which Claude Code shows under the plugin's name:

```text
Swapped in the handoff · send any message to continue from it · saved $TMPDIR/agent-handoff/skills/2026-11-06-1743-issue-303-awaiting-go.md for `handoff 2026-11-06-1743-issue-303-awaiting-go`
```

Then the start of the document, which is now the whole conversation:

```markdown
# Handoff: issue-303-awaiting-go

2026-11-06 17:43 CST · skills / main at 943f24d · Agent: Claude Code (Opus 5.5)

## Unfinished Tasks

1. [in_progress] Run work-issue on #303 — …

## Goal

Ship the handoff-skill issues (#302 done, #303 next), then return to the resume-model epic (#145) with #189 and #149.
```

## Why

Claude Code's own compaction writes a free-form summary, and the next turn has to work out what's still open. A handoff document's sections answer that, and the skill that writes it is the same one you'd run by hand. The plugin carries no copy of the skill's template, so when the template changes, the plugin's output changes with it.

## Install

Install the `handoff` skill first. The plugin needs a version with the `inline` destination from [kendrick/skills#302](https://github.com/kendrick/skills/issues/302):

```sh
npx skills add kendrick/skills --skill handoff
```

Then install the plugin from the prompt of a Claude Code session:

```text
/plugin install handoff-on-compact --marketplace kendrick/handoff-on-compact
```

Or from a shell:

```sh
claude plugin install handoff-on-compact --marketplace kendrick/handoff-on-compact
```

## Usage

Compact the way you already do: both `/compact` and Claude Code's automatic compaction go through the plugin. After the swap, the session waits for you. Send any message, and the model continues from the document. To pick the same document up in a later session, run `handoff <id>` with the id from the toast.

| You type | What happens |
| --- | --- |
| `/compact` | A handoff document for the whole session replaces the conversation. |
| `/compact keep the API notes` | The same, with your text passed to the fork as a focus line. |
| `/handoff-preview` | Shows the document the next compaction would swap in, and the path it would be saved to. It never compacts or writes a file. Text after it works like text after `/compact`. |
| `/compact native` | Skips the plugin for this one compaction. Any text after `native` goes to Claude Code's compaction as usual. |

The plugin saves each document to `$TMPDIR/agent-handoff/<project>/<YYYY-MM-DD-HHMM>-<slug>.md`, the folder and name the skill uses. `<project>` is the name of your repo's root folder. Compactions inside subagents go to Claude Code's own compaction untouched.

Claude Code can also prepare a compaction ahead of time. When it does, the plugin writes the handoff document then, so the swap itself is instant. Claude Code doesn't document when it prepares one, and none of the compactions we've logged was prepared ahead of time. It may prepare one only for idle compaction in VS Code and the Desktop app's Code tab, which nobody has tested yet ([#4](https://github.com/kendrick/handoff-on-compact/issues/4)). Otherwise, expect each compaction to wait while the plugin forks a fresh document. When the plugin did write a document ahead of time, anything said after that point follows it word for word, under a note saying it's newer. The plugin forks fresh instead when the conversation has changed underneath (a `/clear` or a rewind), when what was said since is too long to carry over, or when `/compact` has focus text.

### When It Falls Back

If the plugin can't produce a document, Claude Code's own compaction runs instead, and a toast says why: the skill wasn't found, the fork failed, the reply broke the skill's contract, or the plugin hit an error. A reply that broke the contract is kept in `rejected/` inside the handoff folder, so you can see what the fork wrote.

The plugin also writes a JSON file to `log/` inside the handoff folder for each compaction it handles, and for each one Claude Code prepares ahead of time. A compaction's file names the path it took (`cached` for the document written ahead of time, `fresh` for a new fork, `core` for Claude Code's own compaction), the reason, and how long it ran.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `skill_path` | empty, which reads `~/.claude/skills/handoff/SKILL.md` | Where the plugin reads the `handoff` skill's `SKILL.md`. A leading `~` is your home folder. |

## Develop

To load the plugin from a clone, start a session with it:

```sh
claude --plugin-dir .
```

Before the first typecheck, load the plugin once. Claude Code writes the plugin API's types into `.claude-plugin/types/` when it loads the plugin, and `tsconfig.json` extends them.

To check it, run:

```sh
pnpm install
pnpm typecheck
pnpm lint
claude plugin validate .
claude plugin test .
```

To fix formatting, run `pnpm format`. To regenerate the [changelog](CHANGELOG.md) from conventional commits, run `git cliff -o CHANGELOG.md`. The design decisions are in [docs/adr/](docs/adr/), and the project's terms are in [GLOSSARY.md](GLOSSARY.md).

## License

[MIT](LICENSE)
