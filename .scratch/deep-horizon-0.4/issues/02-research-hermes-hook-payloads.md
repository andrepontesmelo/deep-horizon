# Research: Hermes hook payload audit

Type: research
Status: closed (resolved 2026-09-14, see research/02-hermes-hook-payloads.md)
Blocked by: —

## Question

The hermes adapter's payload claims were verified live **pre-update**
(2026-09-10/11; `plugins_dispatch.py:396`, `:159` cited in
`adapters/hermes/deep_horizon.py`). Hermes updated 2026-09-12 20:38 — and the
section went dark the same night (F2). Read the **current** hermes source
(locate the installed package: `plugins_dispatch.py`,
`plugins_plugin.py`, session-info construction, kanban launcher) and answer,
with file:line evidence:

1. The exact keys of the `session_info` mapping handed to
   `register_system_prompt_section` callables — is `cwd` present, and what is
   it for gateway (telegram/cron) sessions now? What changed in the Sep-12/13
   update (`~/.hermes/update.log`, release notes, changelog)?
2. The exact kwargs `on_session_finalize` receives — is a `cwd` key present
   now? Does finalize still fire for `cron_complete`, `session_reset`,
   `cli_close`, `compression` end reasons (cross-check state.db
   `end_reason` values against dispatch sites)?
3. The `pre_llm_call` payload keys — `terminal_cwd`, `is_first_turn`,
   `parent_session_id`: present? Does any **subagent discriminator** exist
   now (F8), or still nothing?
4. Kanban launcher: why do kanban sessions now run in
   `~/.hermes/kanban/boards/<board>/workspaces/t_*` scratch dirs instead of
   git worktrees (F5)? Is the scratch dir configurable?
5. Cron launcher: what cwd do cron sessions get? Could the HKRC cron job run
   in its repo?
6. Whether `horizon`/`horizon-inject` shims resolve on the gateway's PATH
   (`~/.local/bin` in unit PATH — still true after the update?).

## Why it matters

Tickets 05 (finalize store selection) and 06 (section semantics, nudge
policy, subagent exclusion) decide against these payloads. F2's root cause —
first-candidate-empty wins — is a code bug, but the *right* semantics depend
on what cwd gateway sessions actually carry now. F5's kanban-cwd and F8's
subagent story are hermes-core facts this ticket pins down.

## Resolution

Audited the live checkout `/home/andre/.hermes/hermes-agent` at `205645ee`
(v0.21.2, the Sep-12 20:38 update; pre-update `16cceb8b`). Full evidence:
research/02-hermes-hook-payloads.md. Gist:

1. `session_info` keys unchanged (session_id/model/provider/platform/
   profile_name/cwd — `agent/system_prompt.py:85-93`). What changed: the update
   added `_resolve_scope_cwd_placeholder` (`tools/terminal_scope.py:149-168`)
   and registered `gateway.multiplex_profiles` — so telegram sessions now carry
   `cwd=/home/andre` (placeholder `terminal.cwd: .` → $HOME), storeless, instead
   of the old `""`→process-cwd (`~/.hermes`) fallback. That is F2's trigger.
2. `on_session_finalize` still gets flat kwargs with **no cwd** at all four
   dispatch sites (CLI /new, gateway /new·/reset, gateway shutdown, TUI close).
   cron_complete/cli_close/agent_close/compression book DB rows but fire **no**
   hook; cron sessions never finalize (scheduler-owned, disarmed at
   `cron/scheduler.py:1907`).
3. `pre_llm_call` payload: no `terminal_cwd`; `is_first_turn` present;
   **`parent_session_id` present since 2026-07-27** (`turn_context.py:679` ←
   `delegate_tool.py:243` → `agent_init.py:1144`) — a real pre_llm_call
   subagent discriminator. The *section* mapping still has none (F8 holds
   there only).
4. Kanban scratch `workspaces/t_*` is the by-the-book default for unlinked
   tasks (kind 'scratch' since April; unchanged by the update); worktree
   workspaces are configurable per task/board (`set-default-workdir`,
   `<repo>/.worktrees/<task-id>`).
5. Cron jobs accept `workdir` (absolute dir) → `_SESSION_CWD` → section cwd.
   Setting the HKRC job's `workdir` to its repo would give it its horizon.
6. Gateway unit PATH still includes `~/.local/bin`; both shims resolve. (Note:
   the installed plugin's `../../bin` shortcut is `~/.hermes/bin`, which has no
   horizon bins — PATH is genuinely load-bearing in production.)
