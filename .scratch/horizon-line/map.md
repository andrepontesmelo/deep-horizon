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

- [HL-04 resolved: schema, identity, atomicity](#) — the format question,
  settled in one round.
  **Gap identity:** a short opaque id (`g_3f9a2c1b`), minted on add, never
  reused, deliberately **non-sequential** — sequential ids invite reading `g_3`
  as higher priority than `g_5`, and gaps carry no order. Session records and
  the log reference the id, so gap text can be amended without invalidating
  history.
  **Closed gaps leave `gaps.json`.** The file holds *only* open gaps — at most
  5 for the project's whole life — so the injection path reads it whole with no
  filtering and the count cap can never be charged against closed entries.
  Closes are recorded in `sessions.jsonl`; history grows only in the file
  designed to grow.
  **The 512 cap counts Unicode code points** (`[...s].length` in JS, `len(s)`
  in Python) — the only unit that agrees across both languages and doesn't
  penalise Portuguese. Bytes would make "ção" cost more than "cao"; UTF-16
  units make an emoji cost 2. The rejection message states the actual count.
  **Atomicity:** temp-file + `rename()` in the same directory (atomic on POSIX,
  so a reader never sees a torn file), plus a **compare-and-swap on a
  `revision` integer** for the lost-update case: read rev 7, write expects 7,
  someone already wrote 8 → reject with "the horizon changed underneath you,
  re-read and retry" rather than silently clobbering. **No lockfiles** — they
  strand on `kill -9`, the exact failure mode HL-10 found in DSH.
- [HL-10 partial: DSH cannot elicit model text at close](#) — the worker
  finished only 2 of 5 harnesses and never wrote its file; both sections were
  salvaged from the workspace before pruning (`e3d8160`), and HL-10b
  (`t_7b8c4c17`) covers the rest. What landed already constrains the design:
  **Hermes CAN** produce a close-time summary (three end hooks; `ctx.llm`
  exposes host-owned completion; `on_session_finalize` runs from `atexit` so it
  survives Ctrl-C and SIGTERM, though not `kill -9`). **DSH CANNOT** — there is
  no `agent/session-end` event at all; the nearest is `agent/disposed`, which
  fires *after* the loop stops, is unawaited (emit-mode, returns discarded), and
  steering at that point is thrown away. This validates r4's `summary: null`
  ahead of time: the summary field must be optional because at least one
  harness structurally cannot fill it.
- [HL-05 done: the CLI contract is written](#) — full spec at
  `.scratch/horizon-line/05-cli-contract.md`: seven commands (`show`, `add`,
  `close`, `amend`, `log`, `session-end`, `init`), the `gaps.json` /
  `sessions.jsonl` schemas, an eight-code exit table, and **33 acceptance
  tests** a TDD implementation turns red first. Two contract choices worth
  surfacing: **exit 0 when no store exists** (`show` runs at every session start
  on every project, and most projects have no horizon — a non-zero exit there
  would make every hook noisy on unrelated repos), and **`gaps_added` /
  `gaps_closed` are computed by the CLI**, never passed in, so the session log
  cannot be lied to by a caller. The spec is the implementation target; no code
  is written yet.
- [HL-10b: every harness can elicit model text, but only three reliably](#) —
  the remaining three harnesses researched with live probes. **Claude Code**
  has `Stop` (a `decision:"block"` makes the model continue — probed) plus
  `SessionEnd`, which is the *only* close hook proven to fire on SIGINT/SIGTERM.
  **pi** has `session_shutdown`, a true mirror of `session_start` with the same
  `reason` enum, awaited during teardown, and can call `complete()` in-process.
  **opencode** has no session-end hook at all: `dispose` receives no arguments
  (so no session id) and does not fire on abnormal exit. Combined with DSH's
  unawaited `agent/disposed`, that makes **close-time summaries reliable in
  three of five harnesses**, and abnormal exits uncovered nearly everywhere.
  The derive-later path from on-disk transcripts is therefore the fallback, not
  the exception — every harness writes self-identifying transcripts.
  **Confirms an HL-05 choice:** session id formats differ wildly (Claude Code
  UUIDv4, opencode `ses_`+26-char sortable, DSH UUIDv4, Hermes
  `YYYYMMDD_HHMMSS_6hex`, pi UUIDv7-shaped), so the store must keep the id as
  an **opaque string plus harness name** — which is exactly what the spec says.
- [HL-06 resolved: the injected texts are locked](#) — two texts, not one.
  **The horizon block** uses the inheritance framing — *"You have inherited it,
  not been assigned it"*, *"the horizon is theirs, you only hold the pen"* —
  chosen over a terse and an explicit-contract variant because framing changes
  behaviour more reliably than instruction: it attacks the eagerness this
  project exists to prevent at its root, and states the authorship rule as
  identity rather than as a prohibition. One paragraph is grafted from the
  contract variant, naming what a gap *is not* (backlog, task list, this
  session's work) — but its "do not mention them again" clause was dropped
  deliberately, since a gap becoming relevant mid-session is a good outcome.
  **The nudge** is two lines, because it appears in nearly every session of
  every project; the longer variant spent a line preventing a behaviour the
  short one doesn't invite. Both strings live in the **core package**, imported
  by every adapter — five copies would diverge within a month, and the premise
  is that every harness sees the same horizon, which must mean the same words
  about it. Final strings are §10 of the CLI contract; 3 more acceptance tests
  (34–36) cover substitution fidelity, block-vs-nudge selection, and the
  no-copies rule.
- [HL-01/02: CLI-as-core is now forced, not chosen](#) — the adapters span
  Python (Hermes plugin, in-process) and TypeScript (opencode, pi, DSH). No
  single npm package can serve Hermes natively. Every harness can, however,
  spawn a process and read stdout (Hermes: `subprocess` in a hook; opencode:
  Bun `$`; pi: `node:child_process`; Claude Code: the hook *is* a command).
  So the shared artifact is the **CLI**, and each adapter is a thin shim around
  it. This was HL-08's central question and the research has largely answered
  it.

- [HL-07 resolved: coexist — different objects, pattern-only reuse](#) — five
  confirmations, as predicted ("short confirmations, not full grillings").
  Resolved in a headless run with recommendations auto-adopted; every one
  follows from already-locked decisions. Veto by comment on `t_64b50d56`.
  **The relationship, one line each** (goes in both READMEs; CONTEXT.md's
  Horizon gloss already carries it): moving-target answers *what this project
  IS* — LLM-distilled, descriptive, frozen until you update it; horizon-line
  answers *what we steer toward next* — human-authored, directional, moves
  only with the human's yes.
  **Coexist, uncoupled.** Neither supersedes nor absorbs: different questions,
  different stores (`.moving-target/summary.md` vs `.horizon/`), different
  authorship models, no cross-writes. The injected texts stay exactly as
  HL-06 locked them — no clause added to name the other plugin: the no-copies
  rule (§10, test 36) makes a bespoke cross-reference unmirrorable, and each
  block already describes itself well enough that adjacency needs no
  explanation.
  **Injection order: moving-target first, then horizon-line** — identity
  before direction reads naturally, and in practice the harness decides it by
  mount order (cordis.patch.yml insert order in DSH, hook registration order
  elsewhere). Both gates already agree (genuinely-new sessions only), so the
  pairing is symmetric. A fixed convention noted here, not a mechanism —
  nothing configurable, nothing enforced in code.
  **Code: share the pattern, not the code.** Confirms the prior-art note
  above: HL imports nothing from moving-target; the `agent/session-start`
  hook pattern, startup-only guard, subagent exclusion and pure
  `injectionText()` split are re-implemented against HL's contract — and
  CLI-as-core makes an npm dependency useless to the Hermes adapter anyway.
  moving-target keeps shipping independently; its LLM update path stays its
  own.
  **`.moving-target/` keeps its future.** It remains moving-target's store,
  unchanged, gitignored per its own README; HL-08 decides `.horizon/`'s
  commit-vs-gitignore independently. Sole recorded future coupling: the
  bootstrap seeding option rejected in HL-03 r2 would have *read* MT's
  summary — dead unless deliberately revived.

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
- Whether the 5-gap cap is a hard reject on the 6th add, or a prompt to close
  one first. (HL-04 settles the second half: closed gaps leave `gaps.json`, so
  they can never count against the cap.) For HL-05's exit-code table.
- Ordering: gaps carry no priority (HL-04, non-sequential ids). Still open:
  what order they are *injected* in — insertion order, or most-recent-first —
  since a model may read the first as most important.
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
| 01 Claude Code + opencode start hooks | `t_99204bb9` | research | done |
| 02 Hermes + pi start hooks | `t_f2e33c02` | research | done |
| 09 Anthropic primary-source check | `t_1e0bc4e1` | research | done |
| 03 What IS a horizon | `t_41be385d` | grilling | done — 4 rounds |
| 04 On-disk format | `t_df01dae9` | grilling | done (card stuck `triage`; record in comments + git) |
| 10 Session-end hooks (Hermes, DSH) | `t_0ba9fbe3` | research | done |
| 10b Session-end hooks (CC, opencode, pi) | `t_7b8c4c17` | research | done |
| 05 CLI contract spec | `t_f10bd84a` | task | done — `05-cli-contract.md` |
| 06 Injected texts | `t_48b2a9c5` | prototype | **done** — locked into spec §10 |
| 07 vs moving-target | `t_64b50d56` | grilling | done — coexist, pattern-only reuse |
| 08 Packaging + distribution | `t_0b9338c4` | grilling | blocked (HITL) — largely pre-answered |

**Ten of eleven resolved.** Only HL-08 (packaging) remains, and it is
substantially pre-answered — HL-01/02/10 forced CLI-as-core. Expect a short
confirmation, not a full grilling. After that, the way is clear and the map
hands off to implementation.
