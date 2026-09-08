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

## Not yet specified

- Multiple lines per repo (monorepo with several independent aims), and
  whether a line can be scoped to a subdirectory.
- History/audit: whether superseded lines are kept, and where.
- "Reached the horizon" — is there a terminal state, or does the line only
  ever get replaced?
- Whether an agent may *propose* a new line (and how a human ratifies it), vs
  strictly human-authored. Interacts with the moving-target relationship
  ticket.
- Commit-vs-gitignore default for `.horizon/`, and what a teammate sees.
- Conflict behaviour when two harnesses write the line in the same second.
  (Sharp enough to ticket once the format is decided — see ticket 04.)

## Out of scope

- Any server or sync component. The filesystem is the bus.
- LLM-authored line updates. That is moving-target's job; conflating them
  destroys the "deterministic" property that makes this trustworthy.
- Harnesses beyond the five named, for v1. Adapters are additive later.
