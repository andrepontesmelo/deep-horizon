# CONTEXT.md — horizon-line glossary

Vocabulary only. No implementation details, no spec, no scratch notes.

## Horizon line

A single, human-owned, high-level aim for a project, persisted in the repo and
injected at the start of every new agent session across every harness. One line
of plain text — no newlines — capped at 512 characters.

It describes where the work is *heading*, not what the project *is*, and not
what to do this session. It is never "reached": you travel toward a horizon and
it stays ahead. Arriving means setting a new one.

Distinct from a **task** (has an end state, lives on a Kanban board or in dex)
and from a **project goal** (moving-target's LLM-distilled paragraph describing
what the project *is*).

## Log

The append-only record of every horizon line a project has ever had. The
**current horizon** is the last entry. Nothing is ever deleted, so the moment
a horizon moved is always visible.

## Supersede

Appending a *new* entry to the log because the horizon genuinely moved. The
previous entry remains, timestamped, as history. This is the normal way a
horizon changes.

## Amend

Rewriting the *last* entry in place because the wording was wrong, not because
the horizon moved. Corrects a typo or sharpens phrasing without falsifying the
history. Only the last entry is ever amendable.

## Nudge

What is injected on a project with **no** horizon line: a single line telling
the agent that none is set, and to offer `horizon set` if the human states a
direction. It is not a horizon line and is never stored.

No agent ever authors a horizon line. The human's words are always the source;
the agent only handles the typing. There is no bootstrap command and no
distillation step.

## Provenance

Advisory metadata recorded on each log entry indicating how it was written —
which harness, and whether stdin was a terminal. Evidence for the reader, never
enforcement: the CLI cannot actually tell a human from an agent.

## Resolution

Finding which horizon applies to a directory by walking *up* from the current
working directory to the nearest ancestor containing a horizon store — the same
way git finds `.git`. A subproject with its own store gets its own horizon;
everything below inherits the nearest one.

## Injection

Placing the current horizon into an agent session's context before the user's
first turn, at session start. Only for genuinely new sessions — never resumed,
compacted, or subagent sessions, which already carry context.
