# Hermes session-END hook surface (HL-10, salvaged from card t_0ba9fbe3)

Source: live install /home/andre/.hermes/hermes-agent/ v0.21.1, upstream c076d653.
Salvaged from the card's run summary — the worker completed only Hermes + DSH
before finishing; the repo file was never assembled. Claude Code, opencode and
pi are covered by HL-10b (card t_7b8c4c17).

## 1) Hooks

THREE end hooks in `VALID_HOOKS` (`hermes_cli/plugins.py:125-126`):
`on_session_end`, `on_session_finalize`, `on_session_reset`. Registered via
`ctx.register_hook`; kwargs-dispatched callbacks; **all observers — returns
ignored**.

## 2) Exit coverage

- `on_session_end` fires per-turn (`agent/turn_finalizer.py:623-636`) plus
  interrupted/TUI-close paths (`tui_gateway/session_lifecycle.py:219-231`,
  `interrupted=True`).
- `on_session_finalize` fires from an atexit-registered `_run_cleanup`
  (`cli.py:807-832`, `:3864`) — covers normal quit, Ctrl-C, SIGTERM/SIGHUP.
- **NOT covered**: `kill -9`, native crash, `os._exit` paths
  (`cli.py:997-1003`).

## 3) Can it elicit model text? YES

`ctx.llm` (`plugins.py:376-382`) exposes host-owned
`PluginLlm.complete` / `complete_structured` (`agent/plugin_llm.py:446-473`) on
the user's default model. No raw keys exposed; overrides trust-gated.

Timeouts: `on_session_end` bounded by `plugins.hook_callback_timeout` (30s
default, 600s max — `plugins_dispatch.py:41-45`, `:138-139`);
`on_session_finalize` unbounded, but the exit watchdog
`HERMES_EXIT_WATCHDOG_S` (30s) → `os._exit(0)` (`cli.py:678-716`) caps
exit-time model calls.

## 4) Subprocess: yes

Plugin stdlib, plus purpose-built shell hooks (`config.yaml` `hooks:` block,
JSON payload on stdin — `hooks.md:1625-1641`).

## 5) Session id

Present in every end-hook payload. Format `YYYYMMDD_HHMMSS_hex6`, minted at
`cli.py:2825`.

## 6) Transcripts on disk

Per-profile SQLite `state.db` (`sessions` + `messages` tables) is primary;
`$HERMES_HOME/sessions/<id>.jsonl` is the fallback
(`hermes_state.py:297-316`). 8 profiles verified on this machine.

## 7) Version

`hermes --version` = 0.21.1, upstream c076d653.
