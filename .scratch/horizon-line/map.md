# Horizon Line — wayfinder map

Label: `wayfinder:map`
Started: 2026-09-08

## Destination

A published, installable plugin — one CLI core + thin per-harness adapters —
that injects a project's **gap list** into the start of every new agent
session, across Claude Code, opencode, DeepSeek Harness, Hermes and pi, all
reading and writing the *same* repo-local store so work started in one harness
continues in another.

A **gap** is one thing the human wants and does not yet have, written as a
capability rather than a task: max 5 open gaps, each one newline-free line of
at most 512 characters. The agent **proposes** additions and closures when it
hears a want that spans sessions; the human confirms; the CLI writes
deterministically. No LLM ever authors the file's contents unprompted, and no
gap opens or closes without a human yes.

Alongside the gaps, the same store keeps a **session log**: one append-only
record per session that touched the project — timestamp, harness, that
harness's session id, the gaps it added and closed, and an optional agent-written
summary.

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
- [Claude Code + opencode hook surfaces are known](.scratch/horizon-line/research/01-claude-opencode-hooks.md) —
  Claude Code 2.1.258: SessionStart hook injects before the first prompt with
  **exact** new-vs-resumed (`source` matcher) and **structural** subagent
  exclusion. opencode 1.18.29: no session-start hook — `chat.message` prepend,
  heuristic new-vs-resumed, `session.parentID` subagent exclusion; never
  live-probed (binary absent).
- [Hermes + pi hook surfaces are known](.scratch/horizon-line/research/02-hermes-pi-hooks.md) —
  Hermes 0.21.1: `on_session_start` is observer-only; injection via
  `register_system_prompt_section` (persistent, 4k cap) or `pre_llm_call`
  (per-turn, `is_first_turn`). pi 0.73.1: `session_start` has explicit
  `reason` (startup|new|resume|fork) but no injection return — inject via
  `before_agent_start`. Neither auto-excludes subagents. Both can consume a
  CLI's stdout.
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
  Bootstrap resolved in round 2 (below) — no LLM ever authors a line.
- [HL-03 r2: bootstrap offers, never authors](#) — on a project with no horizon,
  the injected text is a **nudge, not a line**: "No horizon line is set for this
  project. If the user states a direction, offer to run `horizon set`." The
  human invokes nothing and types no command; the agent handles the typing, but
  the line still originates in the human's head. Rejected: distilling a first
  line from session history (that IS moving-target, and it puts an LLM in the
  authorship path ruled out in Out of scope) and seeding from README/`.moving-
  target/summary.md` (deterministic but the wrong shape — descriptive "what this
  is", not directional "where next"). Sharpens the boundary with moving-target
  for HL-07: moving-target answers *what is this*, horizon-line answers *where
  next*, and neither reaches into the other's authorship model.
  **Amends the Q5 "silence on absence" decision**: injection on an unset project
  is a single nudge line, not literal silence. The zero-overhead intent survives
  — one line, no history, no machinery.
- [HL-03 r2: injected block shows the current line only](#) — no "set
  2026-09-08, moved 3 times". Dates and move counts are for the human at the
  terminal (`horizon log`); showing them to the model invites it to reason about
  the human's indecision instead of the aim.
- [HL-09: the real prior art is CLAUDE.md, not `/goal`](#) — verified against
  primary docs. `/goal` (v2.1.139) is a session-scoped wrapper around a
  prompt-based Stop hook, machine-evaluated, carried over on *resume* only,
  invisible to other tools. Outcomes and Dreams are beta-header-gated Managed
  Agents API features (Dreams a request-access research preview); Routines are
  claude.ai cloud runs. **None is prior art.** What *is*: `CLAUDE.md` —
  "markdown files that give Claude persistent instructions for a project…
  Claude reads them at the start of every session", repo-local, human-authored,
  version-controlled, loaded from cwd and every parent directory. It covers
  local injection + human authorship + persistence. The gap it leaves is
  exactly cross-harness: Claude Code "reads `CLAUDE.md`, not `AGENTS.md`", and
  the docs' own bridge is a per-repo `@AGENTS.md` import — glue, not a
  standard. **Position against CLAUDE.md, not `/goal`.**
- [HL-01/02: injection is possible in all five, but not uniformly](#) —
  Claude Code has an exact `SessionStart` hook with a `startup` matcher and
  structural subagent exclusion (subagents fire a separate `SubagentStart`);
  DSH has `agent/session-start` + `agent.inject`; pi has `session_start` with a
  first-class `reason` enum (`startup|reload|new|resume|fork`) but **no
  injection return** — it must stash and inject from `before_agent_start`;
  Hermes' `on_session_start` is an **observer whose return value is ignored**,
  so injection goes through `register_system_prompt_section` (4,000-char cap,
  `after_memory`, frozen into the persisted system prompt) or `pre_llm_call`
  (per-turn, ephemeral, `is_first_turn` available); **opencode has no
  session-start hook at all** — the only pre-first-turn seam is `chat.message`,
  which fires per user message and lets a plugin append a TextPart to the
  user's message.
- [HL-03 r3: the horizon is a GAP LIST, not a single aim](#) — Andre's answer
  to the CLAUDE.md question reshaped the domain object and **superseded two
  round-1/2 decisions**. Positioning first: `AGENTS.md`/`CLAUDE.md` is
  auto-inserted too, so *injection was never the differentiator*. The
  differentiators are (1) a **size cap** forcing top-level content, (2) a
  **level constraint** — no details, no chosen approaches, no decision history,
  and (3) **plugin-maintained** rather than hand-edited. Content is a **gap
  list**: what the human wants and does not yet have, as use cases and
  capabilities, expressly *not* tasks.
  **Cardinality (supersedes r1 "one line, no newlines"):** a list of at most
  **5 open gaps**, each still one newline-free line of ≤512 chars. The char cap
  moved from the whole horizon to each gap; the new **count cap** is what
  actually forces prioritisation — without it a gap list is a backlog with a
  character limit. The name survives: each gap is a line.
  **Authorship (supersedes r2 "no agent ever authors"):** the agent
  **proposes**, the human confirms, the CLI writes. When the agent hears a want
  that will not be resolved this session it offers to add it as a gap; nothing
  enters the horizon unsanctioned. The human still types no command — the agent
  does the typing. Provenance records `agent-proposed, human-confirmed`.
  Rejected: silent writes (the human would be auditing rather than authoring)
  and a silent-write-to-pending variant (kept as the fallback if the
  propose-and-confirm friction proves too high in practice).
  **Closure:** only the human closes a gap; the agent may notice one looks
  delivered and *ask*. Auto-closing is the asymmetric risk — silently dropping
  a gap the human still cares about costs more than carrying a stale one.
  Closed gaps stay in the log with a closed-at marker: the project's record of
  what actually got built.
- [HL-03 r4: JSON store, split in two, plus a session log](#) — the store is
  **JSON, not Markdown**: a deterministic CLI writing Markdown would be parsing
  prose to append a record. Split across two files in one directory:
  `gaps.json` (a small mutable set — read-modify-write) and `sessions.jsonl`
  (append-only, unbounded). JSONL makes appending a session one `>>` with no
  read, no parse and no lock — which matters when two harnesses close at once —
  and a corrupt session log can never take the gaps with it.
  **Session record fields:** timestamp, harness name, that harness's own
  session id (verbatim — the join key back into its transcripts; horizon-line
  never invents one), an optional summary, and `gaps_added` / `gaps_closed`.
  The gap deltas are filled **by the CLI**, which already knows what happened
  in the session; they cost nothing at write time and require nothing of the
  agent. They turn the log from a diary into a causal record and make the
  closed-gap history queryable: *when did this gap close, and in which
  session?*
  **Summary is optional and never fabricated.** If a harness's close hook
  cannot elicit model text, the entry is still written with `summary: null` —
  the deltas are load-bearing, the prose is a bonus. Fallback held in reserve:
  have the agent write the summary *mid-session*, when it already has context
  and no close hook is needed.
  **DEPENDS ON HL-10** (`t_0ba9fbe3`, running): whether a session-end hook
  exists at all in each harness, and whether it can elicit model text or is a
  fire-and-forget observer. No close hook fires on `kill -9` in any harness.
- [HL-01/02: CLI-as-core is now forced, not chosen](#) — the adapters span
  Python (Hermes plugin, in-process) and TypeScript (opencode, pi, DSH). No
  single npm package can serve Hermes natively. Every harness can, however,
  spawn a process and read stdout (Hermes: `subprocess` in a hook; opencode:
  Bun `$`; pi: `node:child_process`; Claude Code: the hook *is* a command).
  So the shared artifact is the **CLI**, and each adapter is a thin shim around
  it. This was HL-08's central question and the research has largely answered
  it.

## Not yet specified

- **opencode cannot exactly detect a new session** (HL-01) — `chat.message`
  has no `source` field; new-vs-resumed is heuristic (empty history +
  `session.time.created`). Either accept the heuristic, inject on every turn
  (~130 tokens at the 512 cap — cheap enough to be a real option), or ship
  opencode as a degraded adapter. Decide in HL-04 or HL-08.
- **Subagent exclusion is free in only two of five harnesses** — structural in
  Claude Code, header-based in DSH. opencode needs a `session.parentID` check,
  Hermes a `parent_session_id` check, and **pi has no discriminator at all**
  (child sessions are separate `pi` processes), so pi needs an env-var or a
  project-local install scope.
- **What "opencode injects heuristically" costs at 5 gaps.** The old estimate
  (~130 tokens) assumed one 512-char line. Five gaps is ~5x that, injected on
  every turn if the heuristic route is taken. Re-cost before HL-08 decides.
- **Gap identity.** Session records reference gaps by *something*. Stable ids
  (opaque? sequential?) or the gap text itself? Text breaks the moment a gap is
  amended. Blocks HL-04's schema.
- **Where the closed gaps live** — still in `gaps.json` with a `closed_at`
  field, or moved to the log on close? Affects whether the 5-gap cap needs to
  filter, and how big `gaps.json` grows over a project's life.
- Whether `amend` may edit any open gap or only the most recently added one.
- Whether the 5-gap cap is a hard reject on the 6th add, or a prompt to close
  one first — and whether closed gaps count against it (they must not).
- Ordering: are gaps ordered (priority) or a set? Injection order matters if
  the model reads the first one as most important.
- Commit-vs-gitignore default for the store, and what a teammate sees.

## Out of scope

- Any server or sync component. The filesystem is the bus.
- **Unsanctioned agent writes.** An agent may *propose* a gap or a closure and
  may *run* the CLI once the human agrees — that is the whole point of
  "plugin-maintained". What stays out of scope is any write the human did not
  say yes to: no distillation from session history, no auto-close on inferred
  delivery, no background curation. The moment the horizon changes without a
  human yes, it becomes something to audit rather than something they authored,
  and its trustworthiness is the product.
- Tasks, plans, owners, estimates, ordering-as-schedule. Gaps are wants, not
  work items. Kanban and dex already hold the work.
- Harnesses beyond the five named, for v1. Adapters are additive later.

## Kanban cards (board: horizon-line)

| Ticket | Card | Type | State |
|---|---|---|---|
| 01 Claude Code + opencode hooks | `t_99204bb9` | research | done |
| 02 Hermes + pi hooks | `t_f2e33c02` | research | done |
| 09 Anthropic primary-source check | `t_1e0bc4e1` | research | done — corrected the prior-art finding |
| 03 What IS a horizon line | `t_41be385d` | grilling | done — 3 rounds; r3 reshaped it to a gap list |
| 04 On-disk format | `t_df01dae9` | grilling | blocked → **now unblocked by r3**, needs Andre |
| 05 CLI contract spec | `t_f10bd84a` | task | todo, gated by 04 |
| 06 Injected prompt variants | `t_48b2a9c5` | prototype | **redo** — 08f6bfd was built pre-reshape (single line, human-authored) |
| 07 vs moving-target | `t_64b50d56` | grilling | blocked (HITL) — r3 largely pre-answers it |
| 08 Packaging + distribution | `t_0b9338c4` | grilling | blocked (HITL) — HL-01/02 largely pre-answer it |

Frontier: **HL-04 (format)** is the live one — the gap-list reshape changed
what it has to describe (N gaps + closed history + provenance, not one line).
HL-06's variants need redoing against the new model. HL-07 and HL-08 are both
substantially pre-answered by r3 and the research; they may collapse into
short confirmations rather than full grillings.
