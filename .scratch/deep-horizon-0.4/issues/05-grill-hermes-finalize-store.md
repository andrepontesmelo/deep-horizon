# Grill: Hermes finalize store selection

Type: grilling
Status: open
Blocked by: [02 Hermes hook payload audit](02-research-hermes-hook-payloads.md)

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
