# CONTEXT.md — horizon-line glossary

Vocabulary only. No implementation details, no spec, no scratch notes.

## Horizon

The set of **gaps** a project is currently steering toward: what the human
wants and does not yet have. At most **5 open gaps** at a time. Injected at the
start of every new agent session, on every harness, from a store shared by all
of them.

The horizon says where the work is *heading*. It is not what the project *is*
(that is `AGENTS.md` / `CLAUDE.md`, and moving-target's distilled paragraph),
and it is not what to do this session.

## Gap

One thing the human wants that does not exist yet, written as a capability, use
case, or piece of functionality — **never as a task**. One line of plain text,
no newlines, at most **512 characters**.

The two caps do different jobs. The character cap forces each gap to stay
high-level: no details, no chosen approach, no decision history. The count cap
forces prioritisation — without it, a gap list is just a backlog with a
character limit.

A gap is *open* until the human closes it. Nothing about a gap implies a plan,
an owner, an estimate, or an order.

## Close

Marking a gap delivered. **Only the human closes a gap.** The agent may notice
that one looks delivered and *ask*, but it never closes one on its own: an
agent that silently drops a gap the human still cares about has destroyed the
artifact's trustworthiness, and being wrong in that direction costs more than
carrying a stale gap.

Closed gaps stay in the log with a closed-at marker — the project's record of
what actually got built.

## Propose

The agent's only route to changing the horizon. When the human voices a want
that will not be resolved in the current session, the agent **proposes** adding
it as a gap and writes only after the human agrees. Same for closing.

The human types no command; the agent does the typing. But nothing enters or
leaves the horizon unsanctioned. This is what keeps the horizon something the
human authored rather than something they audit.

## Gap log

The append-only record of every change the horizon has ever undergone: gaps
added, gaps closed, gaps amended. Nothing is ever deleted, so the moment the
horizon moved is always visible.

## Session record

One entry per agent session that touched this project: when it happened, which
harness ran it, that harness's own session id, a short summary of what the
session did, and the gaps it added and closed.

The gap deltas are the load-bearing part and are filled by the CLI itself,
which already knows what happened. The summary is prose the agent supplies and
is **optional** — a session record with no summary is valid and normal. A
summary is never fabricated to fill the field.

Session records turn the log from a diary into a causal record: which sessions
moved the horizon, and which did not.

## Session id

The identifier a harness uses for its own session, recorded verbatim on the
session record. It is the join key back into that harness's own transcripts —
horizon-line never invents its own.

## Amend

Rewriting a gap's text in place because the wording was wrong — not because the
want changed. A changed want is a close plus an add, not an amend.

## Provenance

Advisory metadata on each log entry: which harness wrote it, whether stdin was
a terminal, and whether the entry was agent-proposed and human-confirmed.
Evidence for the reader, never enforcement — the CLI cannot actually tell a
human from an agent.

## Nudge

What is injected on a project with **no** open gaps: a single line saying the
horizon is empty, and to offer adding a gap if the human voices a lasting want.
It is not a gap and is never stored.

## Resolution

Finding which horizon applies to a directory by walking *up* from the current
working directory to the nearest ancestor containing a horizon store — the way
git finds `.git`. A subproject with its own store gets its own horizon;
everything below inherits the nearest one.

## Injection

Placing the current open gaps into an agent session's context before the
human's first turn. Only genuinely new sessions — never resumed, compacted, or
subagent sessions, which already carry context.
