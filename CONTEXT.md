# CONTEXT.md — deep-horizon glossary

Vocabulary only. No implementation details, no spec, no scratch notes.

## Horizon

The set of **gaps** a project is currently steering toward: what the human
wants and does not yet have. At most **5 open gaps** at a time. Injected at the
start of every new agent session, on every harness, from a store shared by all
of them.

The horizon says where the work is *heading*. It is not what the project *is*
(that is `AGENTS.md` / `CLAUDE.md`, the about line, and moving-target's
distilled paragraph), and it is not what to do this session.

## About

One human-authored line saying what this project **is** — as opposed to the
horizon, which says where the work is heading.

When the stored line and the human's words disagree, the human wins: the agent
offers to rewrite the line with their words, after their yes.

## Gap

One thing the human wants that does not exist yet, written as a capability, use
case, or piece of functionality — **never as a task**. One line of plain text,
no newlines, at most **512 Unicode code points**.

Identified by a short slug id (`plant-photo-lookup`), chosen by whoever types
the add — agent or human — and never reused: a closed gap's id is retired for
the life of the project. Ids are deliberately **not sequential**: numbering
gaps invites reading gap 3 as more important than gap 5, and gaps carry no
priority order. A slug is a name, not a position — it cannot be counted,
sorted, or ranked. The id is what session records and the log reference, so a
gap's text stays free to be amended without invalidating history.

The two caps do different jobs. The character cap forces each gap to stay
high-level: no details, no chosen approach, no decision history. The count cap
forces prioritisation — without it, a gap list is just a backlog with a
character limit.

A gap is *open* until the human closes it. Nothing about a gap implies a plan,
an owner, an estimate, or an order.

**Only open gaps are stored in `gaps.json`.** Closing a gap removes it from
that file; the close is recorded in the session log. So the file holds at most
5 entries for the life of the project, the injection path reads it whole with
no filtering, and the count cap can never be accidentally charged against
closed gaps.

## Close

Marking a gap delivered. **Only the human closes a gap.** The agent may notice
that one looks delivered and *ask*, but it never closes one on its own: an
agent that silently drops a gap the human still cares about has destroyed the
artifact's trustworthiness, and being wrong in that direction costs more than
carrying a stale gap.

Closed gaps live on in the session log — the project's record of what actually
got built, and the answer to "when did this close, and in which session?" A
close also retires the gap's id: no gap added later may carry it.

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
deep-horizon never invents its own.

## Amend

Rewriting a gap's text in place because the wording was wrong — not because the
want changed. A changed want is a close plus an add, not an amend.

## Provenance

Advisory metadata on each log entry: which harness wrote it, whether stdin was
a terminal, and whether the entry was agent-proposed and human-confirmed.
Evidence for the reader, never enforcement — the CLI cannot actually tell a
human from an agent.

## Nudge

One of two texts injected when a store has **no** open gaps — chosen by store
state, never stored, never a gap.

The **bootstrap nudge** lands when there is no about line either (store absent
or empty): the agent may offer once, unprompted, to set the about line or add
the first gap — with a draft, and only after the human's yes. A decline ends
the offering for this session; being asked again in a later session is
expected. One exception: a storeless launch from the home directory is
silence — $HOME is not a project.

The **warm nudge** lands when an about line is set but no gaps exist: offer to
add a gap when the human voices a lasting want, and offer to update the about
line when the human's own words no longer match it.

## Resolution

Finding which horizon applies to a directory by walking *up* from the current
working directory to the nearest ancestor containing a horizon store — the way
git finds `.git`. A subproject with its own store gets its own horizon;
everything below inherits the nearest one.

## Injection

Placing the horizon into an agent session's context — the block when gaps are
open, a nudge when they are not. The startup injection lands once, at the
start of a genuinely new session — never resumed, compacted, or subagent
sessions, which already carry context. The **param trigger** extends coverage
to the moving-target case: harnesses that expose tool-call parameters inspect
each call for target directories, and a touched repo with a store gets its
horizon once per session, mid-session — storeless targets never fire here.
Harnesses with no usable close hook add the **session-end steer**: a
mid-session prompt asking the agent to run `horizon session-end` while it can
still write the summary.

## Revision

A monotonic counter on `gaps.json`, incremented on every write. It records
that a write happened — it guards nothing: a writer never re-reads it, and a
revision that moved underneath a write never **rejects** that write.

So concurrent writes are **last-writer-wins**. Two harnesses sharing the
store never corrupt its structure — every write replaces the file whole — but
a racing write's content can be lost, superseded by whichever write landed
last.
