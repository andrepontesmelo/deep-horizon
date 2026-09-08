# Horizon Line — wayfinder map

Label: `wayfinder:map`
Started: 2026-09-08

## Destination

A published, installable plugin — one core + thin per-harness adapters — that
injects a single **human-owned, persisted, high-level aim** into the start of
every new agent session, across Claude Code, opencode, DeepSeek Harness,
Hermes and pi, all reading and writing the *same* repo-local line so work
started in one harness continues in another. Ships with a deterministic
(no-LLM) CLI that sets/updates the line and hard-rejects text over 512
characters.

The map is done when the way is clear: format, CLI contract, injection text,
per-harness hook mechanics and packaging are all decided — nothing left to
decide before someone builds it.

## Notes

- Domain: agent-harness plugins, cross-tool interop, prompt injection at
  session start.
- Skills every session should consult: `dsh-plugins`, `wayfinder`,
  `grilling`, `domain-modeling`, `kanban-operations`.
- Prior art in this house: `~/git/moving-target` — DSH plugin, same injection
  shape. Reuse its `agent/session-start` hook pattern, its `startup`-only
  guard, its subagent exclusion, and its pure/testable `injectionText()`
  split. Do **not** reuse its LLM-mediated update path: Horizon Line's update
  is deterministic CLI, human-authored.
- Runtime locked: TypeScript/Node core + CLI; TS adapters for opencode and
  DSH; Claude Code, Hermes and pi shell out to the CLI.
- Store locked: repo-local file under `.horizon/`, per-project.
- Cap locked: 512 characters, rejected deterministically (not truncated).
- Standing preference: live evidence only. No harness hook API is assumed to
  exist until it has been read in that harness's own docs or source.

## Decisions so far

- [Name: horizon-line](#) — chosen over `natural-horizon` / `true-horizon` /
  `apparent-horizon`. Free on npm and on GitHub (`andrepontesmelo`) as of
  2026-09-08. Noted trade-off accepted: in aviation "horizon line" names the
  line on the *attitude indicator* (the artificial horizon); the real one out
  the window is the "natural" or "visible" horizon.
- [Prior art check: nothing to collide with](#) — Claude Code `/goal`
  (v2.1.139, 2026-05-12) is a **within-session** completion condition scored
  by an evaluator model each turn and cleared when met; Anthropic **Outcomes**
  (Managed Agents, 2026-05-06) is server-side result-specification;
  **Dreaming** is machine-curated memory between sessions; **Routines** is
  cron for Claude Code. None is a human-authored, persisted, cross-harness
  aim. [Unverified — secondary press only, anthropic.com primary docs not yet
  read; see ticket 09.]
- [Store shape](#) — repo-local file, shared by every harness because they
  share the cwd. Global-store fallback and team-sharing defaults deferred.
- [Runtime](#) — TypeScript/Node core + CLI; native TS adapters for the two TS
  harnesses; subprocess CLI for the rest.
- [DSH hook surface is known](#) — `ctx.on("agent/session-start", …)` +
  `agent.inject(createUserMessage(...))`, guarded on `source === "startup"`
  and on `delegationDepth`/`origin` to skip subagents. Proven live by
  moving-target; no research needed for DSH.
- [HL-03 r1: one horizon per project](#) — cardinality is exactly one, resolved
  by walking **up** from cwd to the nearest ancestor store, the way git finds
  `.git`. Monorepos work for free: a subproject with its own store gets its own
  horizon, everything below inherits the nearest. "Multiple simultaneous aims"
  never enters the model — that is a backlog, and Kanban/dex already are one.
- [HL-03 r1: append-only log, two verbs](#) — the store is an append-only log;
  the current horizon is the **last entry**. `set` **supersedes** (appends a new
  entry — the horizon moved); `amend` **rewrites the last entry in place** (the
  wording moved, the horizon didn't). Directly answers moving-target's stated
  pain: "nothing marks the moment it moved." Forces the format constraint that
  gives the project its name — **entries contain no newlines**; a horizon *line*
  is one line of text.
- [HL-03 r1: no lifecycle states](#) — no `reached`/`paused`/`abandoned`. A
  horizon is never reached; arriving means setting a new one. Abandonment is
  `clear`. Adding states turns this into a task tracker, and its usefulness
  depends on it not being one.
- [HL-03 r1: silence on absence](#) — no line set means nothing is injected,
  zero overhead (moving-target's rule). A nudge in every session of every repo
  becomes noise, and noise trains the reader to skim past the injection block —
  destroying signal on the repos that *do* have a horizon. The nudge lives in
  `horizon show`, run by hand.
- [HL-03 r1: agent may originate, but only at bootstrap](#) — the agent is not a
  free author. It may **execute** updates the human asks for, and it may
  **originate** exactly once, at bootstrap. Enforcement is social, not
  technical: the CLI cannot tell who invoked it, so the rule lives in the
  injected prompt's wording. The CLI records advisory **provenance** per entry
  (harness name + `isatty(stdin)`) as evidence, never as a gate.
  **OPEN:** whether bootstrap is human-invoked or fires automatically — see
  Not yet specified.

## Not yet specified

- **Bootstrap's trigger and its source text.** Settled: the agent may originate
  the first line at bootstrap. Unsettled: does the human invoke bootstrap (as
  in moving-target's `/moving-target-bootstrap`), or does it fire on its own?
  And what does it derive the line *from*? If bootstrap distills from session
  history it needs an LLM — which collides with the locked "no LLM-authored
  lines" boundary in Out of scope. Blocks HL-06's injected text and part of
  HL-05's command surface.
- Whether `amend` may ever touch an entry that is not the last one.
- What `clear` means in an append-only log — a tombstone entry, or a separate
  empty-current state.
- Commit-vs-gitignore default for the store, and what a teammate sees.
- Whether the injected block reveals history (last-set date, times moved) or
  only the current line.

## Out of scope

- Any server or sync component. The filesystem is the bus.
- LLM-authored line updates. That is moving-target's job; conflating them
  destroys the "deterministic" property that makes this trustworthy.
- Harnesses beyond the five named, for v1. Adapters are additive later.

## Kanban cards (board: horizon-line)

| Ticket | Card | Type | State |
|---|---|---|---|
| 01 Claude Code + opencode hooks | `t_99204bb9` | research | dispatched → developer |
| 02 Hermes + pi hooks | `t_f2e33c02` | research | dispatched → developer |
| 09 Anthropic primary-source check | `t_1e0bc4e1` | research | dispatched → developer |
| 03 What IS a horizon line | `t_41be385d` | grilling | blocked: needs_input (HITL) |
| 04 On-disk format | `t_df01dae9` | grilling | todo, gated by 03 |
| 05 CLI contract spec | `t_f10bd84a` | task | todo, gated by 03+04 |
| 06 Injected prompt variants | `t_48b2a9c5` | prototype | todo, gated by 03 |
| 07 vs moving-target | `t_64b50d56` | grilling | blocked: needs_input (HITL) |
| 08 Packaging + distribution | `t_0b9338c4` | grilling | todo, gated by 01+02 |

Frontier right now: the three research cards (AFK, running) plus HL-03 and
HL-07, which are HITL and wait on Andre. HL-03 is the keystone — 04, 05 and 06
all hang off it.
