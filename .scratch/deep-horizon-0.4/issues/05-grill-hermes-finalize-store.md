# Grill: Hermes finalize store selection

Type: grilling
Status: closed (resolved 2026-09-15, AFK-authorized — see map Notes)
Blocked by: [02 Hermes hook payload audit](02-research-hermes-hook-payloads.md) ✅

## Question

The one hermes session that ever recorded is the one whose section cwd had a
store. Every other session — including the 5 telegram sessions that received
real horizons via the param path (F1) — records nothing, because
`_session_store` is stashed only by `_section_text` and finalize falls back
to a storeless process cwd. Decide the finalize store-selection rule:

- The param path stashes what it injected (`_pre_llm_call` already holds the
  store in hand at `deep_horizon.py:590` and drops it) — but a session can
  touch **several** stores. Record in every touched store? Last touched?
  First? Multiple records with one session id and harness is allowed by the
  store format — is it wanted?
- Does finalize get a better signal now (ticket 02: payload cwd? platform?)?
- One record per session end (`end_reason` coverage: `cron_complete`,
  `session_reset`, `compression`, `cli_close` — a telegram session that
  resets 5 times spawns 5 sessions in state.db; do all 5 record?), or one
  per "logical" session?
- Subagent sessions (source=subagent, `agent_close`): recorded or excluded?
  (Currently they'd inherit whatever rule lands — F8 says they inject today.)

## Why it matters

This is the hermes half of the write path (F1) and the hermes row of the
open `close-hook` horizon gap. The rule must hold for telegram (home cwd,
multi-repo touches), cron (home cwd, single repo), and kanban (scratch cwd,
worktree repos) — three shapes, one rule.

## Why it matters (amended by research)

Ticket 02 found the real constraint: finalize fires **only** on /new,
/reset, gateway shutdown, and TUI close. `cron_complete`, `cli_close`,
`agent_close`, and `compression` book state.db rows but fire no hook at all
(cron's finalizer is disarmed by design). The rule must therefore hold for a
partial-close world.

## Resolution

**Every store that injected, records; the partial-close world is accepted
and documented.**

1. `_session_store` becomes a session→**set** map: `_section_text` keeps
   stashing; `_pre_llm_call` starts stashing (it already holds the store at
   `deep_horizon.py:590`). At finalize, `horizon session-end` runs **once
   per stashed store** — a session that touched three projects leaves three
   records, one per store, each honest in its own project's log. The store
   format already allows it; the "one session, many stores" telegram shape
   is exactly why.
2. Fallback unchanged (payload cwd — still absent per ticket 02 — then
   process cwd; storeless stays a safe no-op).
3. End-reason coverage is hermes's, not the plugin's: telegram sessions
   record on /new, /reset, and gateway shutdown; kanban sessions record on
   TUI close (which is what `cli_close` actually rides). **Cron and
   compression sessions book rows but fire no hook** — cron's *injection*
   is fixed by ticket 11's `workdir` config; cron *recording* is upstream
   territory (carried as the map's upstream ask). Documented degradation,
   not silence: the 0.21.2 dispatch sites are cited in research/02.
4. Subagents: excluded when known (`parent_session_id` guard already skips
   the param path; subagent finalizes fire no hook anyway per ticket 02 —
   `agent_close` books rows only). No special casing needed beyond the
   existing guard.
