# handoff-on-compact

A Claude Code plugin that answers a compaction with a handoff document instead of a summary.

## Language

**Handoff document**:
The Markdown document the `handoff` skill defines, opening with a `# Handoff:` heading. Its outline belongs to the skill alone.
_Avoid_: summary, handoff, baton

**Swap**:
Replacing the whole conversation with one handoff document at compaction.
_Avoid_: clear, reset

**Fallback**:
Claude Code's own compaction, run when the plugin can't produce a handoff document.
_Avoid_: classic compaction, native mode

**Escape hatch**:
A compaction the user sends to the fallback on purpose.
_Avoid_: classic, bypass

**Rejected reply**:
A fork's reply that breaks the skill's contract, so the plugin keeps it for inspection and falls back instead of swapping it in.
_Avoid_: failed handoff, bad document
