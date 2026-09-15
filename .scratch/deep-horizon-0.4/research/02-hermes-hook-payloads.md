# Research 02: Hermes hook payload audit (post-Sep-12 update)

Resolves `issues/02-research-hermes-hook-payloads.md`. Method: live source audit of the
installed hermes checkout, all claims file:line-cited against the **current** tree.
Everything below is verified unless marked UNVERIFIED. state.db / kanban.db were only
opened in sqlite read-only URI mode.

## Install facts

- Package: a git checkout at `/home/andre/.hermes/hermes-agent` (launcher
  `/home/andre/.local/bin/hermes` execs `hermes-agent/venv/bin/hermes`). The
  `python3 -c "import hermes_cli"` probe fails because the default interpreter is not
  the venv — resolve by path, not import.
- The Sep-12/13 update is receipt
  `~/.hermes/logs/update_receipts/update_20260912_204046_660154.json`:
  `0.21.1 @ 16cceb8ba5` → `0.21.2 @ 205645ee42`, started 2026-09-13T03:38:02Z
  (2026-09-12 20:38 -0700), outcome success, hermes-gateway restarted.
  (`~/.hermes/update.log` does not exist; the live log is `~/.hermes/logs/update.log`.)
- Reflog confirms the flip: `reset: moving to origin/main` at 2026-09-12 20:38:08 -0700
  (`git -C ~/.hermes/hermes-agent reflog`).
- No formal changelog shipped. The update-relevant diffs (`git diff 16cceb8ba5..205645ee42`):
  - `tools/terminal_scope.py` +23 lines — **new** `_resolve_scope_cwd_placeholder`
    (see Q1). This is the only change that touches plugin-visible cwd.
  - `hermes_cli/plugins_dispatch.py` +11/−5 — `_invoke_hook_callback` now resolves
    coroutine results (`resolve_plugin_command_result`), so an `async def` hook body
    actually runs (#12449). Flat-kwargs signature filtering unchanged.
  - `gateway/run.py` — multiplexer work; top commit 205645ee42 "register
    `gateway.multiplex_profiles`; explicit migrate --multiplex flips it".
  - `plugins_plugin.py`, `agent/system_prompt.py`, `agent/runtime_cwd.py`: **unchanged**
    (empty diffs).

## Q1 — session_info mapping handed to section callables

Exact keys — **unchanged by the update**, six keys, same order of construction,
`agent/system_prompt.py:85-93` (`_plugin_session_info`):

```python
info = {k: str(getattr(agent, k, None) or "") for k in ("session_id", "model", "provider", "platform")}
info.update(profile_name=_active_profile_name(agent, _ambient_plugin_profile_name), cwd=cwd)
```

`cwd = str(resolve_context_cwd() or "")` — i.e. `agent/runtime_cwd.py:90-94`:
session override (`_SESSION_CWD` ContextVar) → scope `TERMINAL_CWD`; **never**
`os.getcwd()`. Still frozen read-only per render via
`hermes_cli/plugins_dispatch.py:402` `types.MappingProxyType(dict(session_info))`
(the cited `:396` is now `:402`; semantics identical). No parent/depth discriminator —
see Q3.

What cwd resolves to per session type now:

- **Telegram/gateway (routed multiplex turns): `/home/andre`.** Chain:
  `config.yaml:92-95` has `terminal.cwd: .` (a `CWD_PLACEHOLDERS` member,
  `gateway/cwd_placeholder.py:14`); backend is `local`; local + placeholder →
  `home_fallback` = `Path.home()` (`gateway/cwd_placeholder.py:30-31`).
  The import-time env resolution (`gateway/run.py:2105-2120`) existed pre-update;
  what the update **added** is the per-turn-scope twin:
  `tools/terminal_scope.py:145` calls the new `_resolve_scope_cwd_placeholder`
  (`:149-168`) inside `build_profile_terminal_scope`, giving every routed profile
  scope `TERMINAL_CWD=$HOME` when the profile config has no explicit cwd. Its own
  docstring names the pre-update failure: without it, a routed turn's
  `resolve_agent_cwd()` fell back to "the multiplexer PROCESS cwd (wherever
  `hermes gateway` was launched)" = `~/.hermes` (unit `WorkingDirectory`), which is
  exactly F2's pre-update prompt cwd.
- The gateway is a **multiplexer**: `config.yaml:644 gateway.multiplex_profiles: true`.
  That flag was already set before the update (present in
  `config.yaml.bak-20260911-131220:644`) but was only *registered* by the update's
  top commit — so the multiplex scope path switched on with the update.
- **Cron: job `workdir` if set, else `/home/andre`** (see Q5).
- **Kanban worker: the task workspace** (`TERMINAL_CWD=workspace`,
  `hermes_cli/kanban_db_dispatch.py:2239-2240`, plus `cwd=workspace` on the
  subprocess at `:2286`) — a scratch `t_*` dir by default (see Q4).

Live corroboration: `horizon-inject --harness hermes --json --cwd /home/andre` →
`{"text":"","store":null}` (run for this audit); `--cwd /home/andre/.hermes` → the
storeless nudge, exactly **411 chars**, matching every logged render
(`logs/agent.log.1`: renders `chars=411` up to 2026-09-13 00:55:55, none since —
an empty section return is dropped at `plugins_dispatch.py:449-450` *before* the
render info-log at `:427-429`, so darkness logs nothing, by design).

UNVERIFIED: which individual post-update sessions were multiplex-routed vs. plain;
the 411-char renders at 21:11/00:55 on Sep 12/13 are consistent with
kanban-worker/CLI sessions whose cwd answered the nudge (scratch dirs), but no
per-session surface attribution was possible from logs alone.

## Q2 — on_session_finalize kwargs and dispatch coverage

The plugin hook fires **only** through `hermes_cli/lifecycle.py:47-63`
(`finalize_session` → `_plugin_hooks("on_session_finalize", **kwargs)`). Exact kwargs
per site, current source — **no cwd key anywhere**:

| Site | File:line | kwargs |
|---|---|---|
| CLI `/new` | `cli_session_mixin.py:519` → `:444-457` | `session_id`, `platform` (default `"cli"`), `reason="session_boundary"` |
| Gateway `/new`·`/reset` | `gateway/slash_commands_session.py:145-147` | `session_id=old_sid`, `platform`, `reason="new_session"`, `old_session_id`, `new_session_id` |
| Gateway shutdown | `gateway/run_shutdown.py:1062-1064` → `:1112-1117` | `session_id`, `platform="gateway"`, `reason="shutdown"` |
| TUI/desktop close | `tui_gateway/session_lifecycle.py:16-21,249` | `session_id`, `platform` — **no reason key** |

Dispatch mechanics unchanged (`plugins_dispatch.py:152-170`): flat kwargs, filtered to
the callback's declared params (var-keyed callbacks get everything). The only update
change here is coroutine resolution (async hooks now run).

Coverage vs `state.db sessions.end_reason` (live read-only GROUP BY: `session_reset`
763 telegram / 147 compression etc., `compression`, `cron_complete` 69, `agent_close`
61 subagent + 37 cli + 9 telegram, `cli_close` 36 cli + 10 kanban, `webhook_complete`,
`cron_incomplete_no_output`, `new_session`, `daily`, `idle`, NULL):

- The DB row reasons and the plugin hook are **separate mechanisms**. Row bookings that
  fire NO plugin hook: `agent_close` (`run_agent.py:996-997`), `cli_close`
  (`cli.py:947`, `:3962`), `cron_complete`/`cron_incomplete_no_output`
  (`cron/scheduler.py:1886,1899`), `compression` (rotation bookkeeping,
  `agent/conversation_compression.py:1421,2221` — no lifecycle call), `new_session`
  row (`cli_session_mixin.py:535`).
- The big `session_reset` population (telegram) comes from route resets
  (`gateway/session.py:925`); the `/new|/reset` *command* path that books it does fire
  the hook, with `reason="new_session"` (slash_commands_session.py:145-150,210-212).
- **Cron sessions never fire `on_session_finalize` at all**: the scheduler owns
  finalization, books only the row, and explicitly disarms the agent's own finalizer
  (`cron/scheduler.py:1898-1907`, comment "The scheduler owns cron-session
  finalization"). `finalize_session` is referenced nowhere under `cron/`.
- Kanban workers exit as plain CLIs (`cli_close`, `cli.py:3962`) — no hook either.
- Gateway shutdown sweeps only *live* agents (`run_shutdown.py:1057-1067`).

So finalize coverage = CLI `/new`, gateway `/new|/reset`, gateway shutdown, TUI close.
Everything else — cron_complete, cli_close, agent_close, compression — ends sessions
with **no plugin callback**.

## Q3 — pre_llm_call payload and subagent discriminator

Constructed at `agent/turn_context.py:658-681` (`_collect_pre_llm_call_context`),
one call site (`:975`). Exact payload:

```
session_id, task_id, turn_id, user_message,
conversation_history (list(messages)),
is_first_turn = (not bool(conversation_history)),
model, platform,
parent_session_id = getattr(agent, "_parent_session_id", None) or "",
sender_id
```

plus `telemetry_schema_version` added by `invoke_hook` itself
(`plugins_dispatch.py:184-185`). Result contract unchanged: `{"context": ...}` /
str, injected into the user message, oversized context spilled to disk
(`turn_context.py:693-709`).

- `terminal_cwd`: **absent** — still. The adapter's `terminal_cwd` param and
  TERMINAL_CWD fallback remain inert (as documented in deep_horizon.py).
- `is_first_turn`: **present** (truthy only when history is empty).
- `parent_session_id`: **present, and it is a real subagent discriminator.** Wiring:
  `tools/delegate_tool.py:243` builds the child with
  `parent_session_id=parent_sid` → `agent/agent_init.py:1144`
  `agent._parent_session_id = parent_session_id`. Added 2026-07-27
  (commit 14bed44c8cf, "Reapply NeMo Relay runtime") — i.e. it predates both the
  update *and* the adapter's 2026-09-10/11 live verification; the adapter's
  `parent_session_id` guard (deep_horizon.py:542-543) has been load-bearing all along.
- The discriminator exists at the **pre_llm_call layer only**. The section layer's
  `session_info` (Q1) still carries no parent/depth key — F8's "no discriminator"
  remains true there and only there.

## Q4 — kanban workspaces scratch dirs

- Task ids are `t_` + 4 hex bytes (`hermes_cli/kanban_db.py:1052-1055`); scratch
  workspace = `<workspaces_root>/<task_id>` = `~/.hermes/kanban/boards/<board>/
  workspaces/t_*` (`hermes_cli/kanban_db_workspace.py:507-508`; root resolver
  `kanban_db.py:496-499`).
- Why scratch: `workspace_kind` defaults to `'scratch'` (schema default
  `kanban_db.py:863`; `create_task` default `:1266-1272`). Worktree only when the task
  is **project-linked** (scratch→worktree upgrade, `kanban_db.py:1122-1135`, worktree
  materialized at `<repo>/.worktrees/<task-id>` by `_anchored_worktree`,
  `kanban_db_workspace.py:414-418`) or explicitly requested
  (`--workspace worktree:<abs-repo>`; or board `default_workdir` + worktree kind,
  `kanban_db_workspace.py:428-450`).
- The Sep-12 update did **not** change this: `kanban_db.py` and
  `kanban_db_workspace.py` have empty diffs across `16cceb8b..205645ee`, and the
  scratch default dates to 2026-04-30 (c8684254675, "durable multi-profile
  collaboration board"). Live read-only query of the casa-gungalilin board DB: every
  recent task is `workspace_kind='scratch'`, `project_id=NULL`,
  `workspace_path=.../workspaces/t_*` — the tasks were created unlinked, so scratch is
  the by-the-book outcome, not a launcher regression.
- Worker launch anchors everything on the workspace: `cwd=workspace`
  (`kanban_db_dispatch.py:2286`), `TERMINAL_CWD=workspace` when absolute
  (`:2232-2240`), `HERMES_KANBAN_WORKSPACE` (`:2224`),
  `HERMES_KANBAN_WORKSPACES_ROOT` (`:2257-2260`).
- Configurable — yes, three ways: per task (`--workspace worktree:<abs-repo>` or
  `dir:<abs-path>`), per board (`hermes kanban set-default-workdir <abs repo>`,
  `kanban_parser.py:109-111`) which makes worktree-kind tasks land in
  `<repo>/.worktrees/<task-id>` (a checkout — carries `.horizon` per F9's committed-
  store caveat), and `HERMES_KANBAN_WORKSPACES_ROOT` to relocate the scratch root
  (`kanban_db.py:499`). Scratch cleanup refuses paths outside managed roots
  (`kanban_db_workspace.py:63-107`).

## Q5 — cron session cwd

- `workdir` is a first-class job field: `cron/jobs.py:1474-1493` (normalized to an
  absolute, existing directory), accepted on create/update (`:1587`, `:1593`), exposed
  in the dashboard API (`web_routers/cron.py:50`).
- Per run, `_CronRunScope` (`cron/scheduler.py:2022-2063`) resolves it and binds
  `set_session_vars(cwd=...)` → `_SESSION_CWD` (`gateway/session_context.py:143` →
  `runtime_cwd.set_session_cwd`) — which is precisely the prompt/context-file
  authority `resolve_context_cwd()` reads. The tool layer additionally gets
  `record_session_cwd(task_id, workdir)` (`:2059-2063`). Never `os.chdir()`
  (comment at `:1256`).
- Therefore: a cron job with `workdir: /home/andre/git/<repo>` runs with
  `session_info.cwd = <repo>` → the section candidate 1 answers with the repo's real
  horizon. **Yes — the HKRC cron job can run in its repo; it is pure job config.**
- Without `workdir`: `_SESSION_CWD` is bound empty → falls through to scope
  `TERMINAL_CWD` → `/home/andre` → storeless `""` → dark section, same as telegram.
- `state.db` cron rows all have `cwd=NULL` (live query) — that column is written by
  CLI paths only and says nothing about the in-memory session_info cwd.

## Q6 — gateway PATH and horizon shims

- `systemctl --user show hermes-gateway -p Environment` (live): PATH includes
  `/home/andre/.local/bin` — same value as the unit file
  `~/.config/systemd/user/hermes-gateway.service:11`; the only drop-in is
  `hermes-gateway.service.d/display.conf` (DISPLAY only). Survived the update.
- Shims exist and are current:
  `~/.local/bin/horizon -> /home/andre/git/horizon-line/bin/horizon.js` and
  `~/.local/bin/horizon-inject -> .../bin/horizon-inject.js` (symlinks dated Sep 10).
  `which horizon horizon-inject` with the unit's exact PATH resolves both.
- Note the resolution order inside the plugin: `_spawn_bin` prefers
  `<plugin_dir>/../../bin/<name>.js` (deep_horizon.py:80-81,104-109). For the
  installed copy at `~/.hermes/plugins/deep-horizon/` that path is
  `~/.hermes/bin/` — which exists but contains **no horizon bins** — so in production
  the plugin always falls through to `shutil.which` and PATH is genuinely load-bearing.
  (Repo checkouts, i.e. tests, hit `bin/*.js` directly.)

## Consequences for tickets 05/06

**Ticket 05 (finalize store selection).** `on_session_finalize` is not a universal
close signal on hermes and its payload has no cwd at any of the four sites. It fires
only for CLI `/new`, gateway `/new|/reset`, gateway shutdown, and TUI close; cron
sessions never finalize (scheduler-owned, `cron/scheduler.py:1898-1907`), and
kanban/CLI exits book `cli_close` with no callback. Coverage decisions for 05 must
therefore be made against a partial-close-world: either accept that cron + kanban +
plain-CLI sessions can never record via finalize (record-at-turn or a core upstream
ask are the only fixes), or keep the stash-then-`--store` design as the only
reliable recorder for sessions that injected, with the cwd fallback mattering only
for gateway-shutdown sweeps (where process cwd = `~/.hermes`, storeless). The
async-hook fix in 0.21.2 also means the adapter's "plain def or the body never
runs" comment is now historical — async would work, sync is still correct.

**Ticket 06 (section semantics, nudge, subagents).** F2's mechanism is now pinned to
source: the update taught multiplexed profile scopes to resolve the `terminal.cwd: .`
placeholder to `$HOME` (`tools/terminal_scope.py:149-168`), so telegram sessions hand
the section a real-but-storeless `/home/andre`; horizon-inject's storeless-$HOME rule
answers `""` (storeless nudge for other dirs is exactly 411 chars, matching the last
logged renders); and the adapter's first-candidate-wins rule freezes that `""` over
the process-cwd nudge. The semantics decision is therefore really about one rule in
the adapter: whether a **text-empty, storeless** first answer should defer to the
next candidate exactly as a storeless answer does (today only `store != null` wins
the defer — deep_horizon.py:246-260), or whether `/home/andre` should be treated as
"no project" silence (which is what the composer already says). Kanban and cron are
coverable by config, not code: project-linked kanban tasks (worktree workspaces under
`<repo>/.worktrees/`) and cron `workdir` put sessions inside stores legitimately.
Subagent exclusion: `pre_llm_call` already discriminates via `parent_session_id`
(since 2026-07-27); the **section** still has nothing — if section-level exclusion is
required, it is an upstream ask against `_plugin_session_info`
(`agent/system_prompt.py:85-93`), because the frozen mapping provably carries only the
six keys above.
