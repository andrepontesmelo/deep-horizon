# Research: session-END hook surfaces across all five harnesses (HL-10)

Type: research
Status: done
Date: 2026-09-08
Method: live evidence only — installed binaries, installed source, vendored docs, on-disk
transcripts. Every claim carries a URL or file path. Claude Code / opencode / pi sections were
researched fresh for this file (HL-10b); the Hermes and DSH rows are salvaged from the prior
HL-10 run (see "Salvage provenance" at the bottom).

## Executive answer

- **Claude Code**: real `SessionEnd` hook with a `reason` enum. Command/http/mcp_tool only —
  **it cannot elicit model text at close time** (prompt/agent hook types are explicitly
  unsupported, and its JSON output fields are discarded). Default time budget is 1.5 seconds.
  It does receive `session_id` + `transcript_path`, so the transcript-derive-later path is
  first-class.
- **opencode**: **no session-end hook at all.** Closest is the plugin-lifecycle `dispose` hook
  (instance teardown, receives nothing, graceful-exit only). `session.idle` is per-turn, not
  session end. `dispose` CAN elicit model text via the injected SDK client
  (`client.session.prompt`), but must recover the session id on its own. Abnormal exits fire
  nothing.
- **pi**: `session_shutdown` extension event — the cleanest close-time API of the three
  (awaited, `reason` enum symmetric with `session_start`). But it is a plain observer: **no
  documented model-elicitation API**, and interactive SIGHUP bypasses it entirely
  (`emergencyTerminalExit()`), despite the docs claiming SIGHUP coverage.
- **Hermes** (salvaged): three end hooks (`on_session_end`, `on_session_finalize`,
  `on_session_reset`); **the only harness of the five with first-class close-time model access**
  (`ctx.llm.complete` on the host-owned plugin LLM). Not covered: kill -9, native crash,
  `os._exit` paths.
- **DSH** (salvaged): **no session-end event** — closest is `agent/disposed`, fire-and-forget,
  unawaited, loop already stopped. Design for crash = no callback.

**Design consequence (loud flag):** exactly one of five harnesses (Hermes) can ask a model to
write the summary through the harness itself at close time. Claude Code, opencode, pi, and DSH
all push the design toward: capture `session_id` at close (or per-turn), then derive the
summary from the on-disk transcript afterwards — every one of the five keeps a complete
per-session transcript on disk.

## Merged 5-harness comparison

| | Claude Code 2.1.258 | opencode 1.18.29 | pi 0.73.1 | Hermes 0.21.1 | DSH 0.1.1-rc.2 |
|---|---|---|---|---|---|
| End hook (exact name) | `SessionEnd` (settings `hooks.SessionEnd`) | none; nearest: plugin `dispose` | `session_shutdown` (extension event) | `on_session_end`, `on_session_finalize`, `on_session_reset` | none; nearest: `agent/disposed` |
| Config surface | `hooks` in `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed settings, plugin `hooks/hooks.json` | plugin `dispose` in `.opencode/plugin/*` / opencode.json plugins | `~/.pi/agent/extensions/*.ts` (global), `.pi/extensions/*.ts` (project), `packages` in settings.json | `ctx.register_hook` in plugin `register(ctx)`; plugin dirs per plugins/AGENTS.md | `ctx.on("agent/disposed", ...)` in cordis plugin |
| Normal quit | yes (`prompt_input_exit`/`other`) | yes (`dispose`) | yes (`reason: "quit"`) | yes (atexit `_run_cleanup`) | yes (explicit disposal path only) |
| Ctrl-C | yes (`prompt_input_exit`) | TUI quit yes; hard Ctrl-C on `opencode run` fires nothing | yes (TUI-processed -> shutdown) | yes | unconfirmed (outer binary not shipped in the audited packages) |
| SIGTERM | not documented | **no** (no signal wiring in src) | yes (handler -> awaited shutdown), SIGTERM specifically | yes (SIGHUP too) | unconfirmed (same) |
| Crash / kill -9 | **no** | **no** | **no** | **no** (kill -9, native crash, `os._exit` paths) | **no** |
| Other holes | 1.5s default budget for ALL SessionEnd hooks (raiseable to 60s / `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`) | `dispose` receives no session id | interactive SIGHUP -> `emergencyTerminalExit()` skips the event (docs claim coverage); no timeout guard around handlers | `on_session_finalize` unbounded but exit watchdog `HERMES_EXIT_WATCHDOG_S` 30s caps it | not awaited, errors swallowed; nothing guarantees the outer binary disposes on signals |
| Elicit model text at close | **NO** — command/http/mcp_tool only; JSON outputs discarded | yes, in-process: `client.session.prompt(...)` from `dispose` (ordering caveats) | **NO first-class API** — plain observer; only hand-rolled provider calls via `ctx.modelRegistry` keys (unconfirmed) | **YES** — `ctx.llm.complete/complete_structured` (host-owned PluginLlm) | only via direct `ctx.llm.stream` aux call; loop already stopped, unawaited, racy |
| Shell out to binary w/ text | **native** — it IS a command hook (stdin JSON, args) | in-process Bun `$` (stdin/args); `undefined` outside Bun runtime | yes — full Node `child_process` in extension | yes — plugin stdlib + shell hooks (config `hooks:` block) | yes — plugin spawns processes (moving-target spawns `zstd`) |
| Session id available at close | yes — `session_id` in hook stdin | not in `dispose` (remember from `session.idle` or `client.session.list()`); format `ses_<descending>` minted in `packages/schema/src/session-id.ts` | yes — `ctx.sessionManager.getSessionFile()`; id = uuidv7 minted in `dist/core/session-manager.js:10` | yes — in every end-hook payload; `YYYYMMDD_HHMMSS_hex6` minted at `cli.py:2825` | yes — `payload.agent.id`; minted by caller (ACP bridge), UUIDv4 observed |
| Transcript on disk | `~/.claude/projects/<-cwd->/<session_id>.jsonl` (JSONL) | `~/.local/share/opencode/opencode.db` SQLite (`session`/`message`/`part`, JSON `data` cols) | `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl` (JSONL tree v3) | per-profile `state.db` SQLite (sessions+messages); fallback `$HERMES_HOME/sessions/<id>.jsonl` | `~/.dsh/sessions/<projectKey>/<sessionId>/session.jsonl.zstd` |

---

## Claude Code (live install, 2.1.258)

Verified against: `claude --version` = 2.1.258; official docs fetched 2026-09-08 from
https://code.claude.com/docs/en/hooks (raw mirror `/tmp/cc-hooks.md`, byte-identical re-fetch
same day); live transcript files under `/home/andre/.claude/projects/`.

### 1) Hook name, config path, schema

Event: `SessionEnd` — "Runs when a Claude Code session ends. Useful for cleanup tasks, logging
session statistics, or saving session state." (docs `### SessionEnd`). Same config surfaces as
SessionStart (user/project/local/managed settings, plugin `hooks/hooks.json`):

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "matcher": "clear|resume",
        "hooks": [
          { "type": "command", "command": "/abs/path/hook.sh", "timeout": 10 }
        ]
      }
    ]
  }
}
```

Matcher filters on the exit reason: `clear | resume | logout | prompt_input_exit | other`
(`bypass_permissions_disabled` removed in v2.1.234 — docs tell you to drop it from matchers).
Input = common fields plus `reason`:

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-....jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```

No decision control: "SessionEnd hooks have no decision control. They can't block session
termination but can perform cleanup tasks. Claude Code discards their JSON output fields, such
as `systemMessage`." (docs `### SessionEnd`).

### 2) Exit coverage

- Fires on session exit, `/clear`, and switching sessions via interactive `/resume` (the 1.5s
  budget paragraph enumerates exactly these three).
- `reason: prompt_input_exit` covers the normal "user exited while prompt input was visible"
  quit (i.e. graceful Ctrl-D/exit). Docs do not enumerate signal behaviour; nothing documents
  SessionEnd firing on SIGKILL/native crash — assume no (hooks are child processes of Claude
  Code; a dead parent spawns nothing). **Not doc-explicit: named as a gap.**
- TIMEOUT HOLE (docs `### SessionEnd`, verbatim): "SessionEnd hooks have a default timeout of
  1.5 seconds." All SessionEnd hooks share that budget; it is raised automatically to the
  highest per-hook `timeout` configured in settings files, up to 60 seconds; plugin-provided
  hooks do NOT raise the budget; explicit override is
  `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` (ms). A close-time summarizer must set a per-hook
  `timeout` (or the env var) or get 1.5 s.

### 3) Can it elicit MODEL TEXT at close time? — NO

- Docs section "Events that support `command`, `http`, and `mcp_tool` hooks but not `prompt` or
  `agent`" lists `SessionEnd` explicitly. `type: "prompt"` (LLM evaluates a prompt) and
  `type: "agent"` (spawns an agentic verifier with tool access) are rejected on this event.
- Even if a hook returned model-ish JSON, "Claude Code discards their JSON output fields"
  (docs `### SessionEnd`) — there is no `additionalContext` channel at session end.
- `Stop` DOES support prompt/agent hooks (that is the `/goal` mechanism), but Stop is per-turn
  ("Runs when the main Claude Code agent has finished responding"), does not run on user
  interrupt, and API errors fire `StopFailure` instead — it is not a session-end event.
- Remaining close-time-model option is out-of-band: the command hook itself invoking an LLM
  binary — inside a 1.5 s default budget (see #2).

### 4) Shell out to a binary and pass it text — YES (native)

SessionEnd only supports `command`/`http`/`mcp_tool` handlers; `type: "command"` is executed as
a shell command with the hook's JSON on **stdin** (`session_id`, `transcript_path`, `cwd`,
`reason`). Text transfer = read stdin, or feed the transcript file to the binary; arbitrary
args via the `command` string. Exit-code/stderr semantics: "SessionEnd: No — Shows stderr to
user only" (docs exit-code table row).

### 5) Session id — YES

`session_id` is a common input field on every hook event (docs "common input fields"). The
transcript path in the same payload is `~/.claude/projects/<sanitized-cwd>/<session_id>.jsonl`
— id = transcript file stem (observed live:
`/home/andre/.claude/projects/-tmp/0f1e0e9c-bc87-423f-9591-300e225a6164.jsonl` with matching
`sessionId` inside). Minting happens inside the closed-source binary; not further traceable —
observed format is a hyphenated UUID.

### 6) Transcripts on disk — YES

`~/.claude/projects/<cwd-with-dashes>/<session_id>.jsonl`. Format: JSONL, one record per line —
queue-operation records (`{"type":"queue-operation","operation":"enqueue",...,"sessionId":"..."}`),
message records with `parentUuid`/`isSidechain` fields (sampled live file). Complete enough to
derive a summary after the fact; this is the designed substitute for close-time elicitation.

### 7) Version

2.1.258 (`claude --version`, 2026-09-08). The 1.5s-budget text and the
`bypass_permissions_disabled` removal note are current at this version.

---

## opencode (source-read only, 1.18.29 @ dff8fbc)

Verified against: source checkout
`/home/andre/.hermes/kanban/boards/horizon-line/workspaces/t_99204bb9/opencode-src`
(`packages/opencode/package.json` and `packages/plugin/package.json` both 1.18.29, HEAD
`dff8fbc149fb7492e4f07b713ac31ea70d9a541c`), plus live read-only samples of
`~/.local/share/opencode`. Binary not installed; no behavioural probe. The session-END section
below was produced by the prior HL-10b run against the same checkout and re-spot-verified
today: `packages/plugin/src/index.ts:222-223` (`dispose?`/`event?` verbatim),
`packages/opencode/src/plugin/index.ts:265-278` (`Effect.addFinalizer` dispose invocation
verbatim), `packages/schema/src/session-status-event.ts:45-47` (`session.idle` schema verbatim).

### 1) Session-end hook — NONE

No `session.end`/`session.close`/`session.stop`/process-exit entry exists in the `Hooks`
interface (`packages/plugin/src/index.ts:222-335`). Nearest surfaces, in order of usefulness:

1. `dispose?: () => Promise<void>` — plugin-lifecycle teardown, fires via
   `Effect.addFinalizer` when the instance's plugin layer is torn down (normal command exit,
   TUI quit, `/exit`). Receives nothing — no sessionID.
2. `event` hook seeing `session.idle` `{ sessionID }`
   (`packages/schema/src/session-status-event.ts:44-49`, explicitly `// deprecated` in favour
   of `session.status` `idle`) — fires after **every turn** (`SessionStatus.set` in
   `packages/opencode/src/session/status.ts:41-48`, plus abort/error paths in
   `packages/opencode/src/session/processor.ts:626,638`), published fire-and-forget
   (`void hook["event"]?.(...)`).
3. `session.deleted` — only on explicit `DELETE /session/{id}` (`packages/opencode/src/session/session.ts:622`), not exit.

### 2) Exit coverage — graceful only

`dispose` runs only via the effect finalizer chain; there is no `process.on("SIGTERM")` and no
crash-path disposal anywhere in `packages/opencode/src`. `bin/opencode` forwards
SIGINT/SIGTERM/SIGHUP to the app child and re-raises — signal plumbing, not hook invocation.
Hard Ctrl-C on non-interactive `opencode run`, SIGTERM, SIGKILL, crash: **nothing fires**.
Unconfirmed-at-runtime: whether `dispose` always completes before the outer
`finally { process.exit() }` (`index.ts:141`) on every graceful path.

### 3) Can it elicit MODEL TEXT at close time? — YES, with caveats

Every plugin receives `client` (full `createOpencodeClient` SDK client):
`client.session.prompt(...)` (`POST /session/{id}/message`) runs a complete agent turn and
resolves with the response; `promptAsync`, `command`, `shell`, `summarize` also exist. So a
`dispose` hook can run a one-off LLM call at close time. Caveats: `dispose` gets no sessionID
(recover it by remembering the last `session.idle` payload or `client.session.list()`); the
event hook itself is never awaited; and a slow LLM call races the unconditional outer
`process.exit()`.

### 4) Shell out — in-process only

Hooks are in-process JS/TS. The plugin context exposes Bun's shell `$` (stdin + escaped arg
interpolation; `await $`/path/binary`.text()`); `$` is `undefined` outside the Bun runtime.

### 5) Session id — recoverable, minted centrally

`dispose` receives none. Turn-time hooks/events carry it. Minted as
`"ses_" + descending()` — `packages/schema/src/session-id.ts:5-11`
(`SessionID = Schema.String.check(Schema.isStartsWith("ses"))` + `create()`); observed live
value `ses_22e9bb424ffewpd8FrGU6inP4O`.

### 6) Transcripts on disk — YES (SQLite)

`~/.local/share/opencode/opencode.db`: `session` (id PK, directory, title, tokens, cost, ...),
`message` (FK -> session CASCADE, `data` = full V1 message JSON), `part` (one row per
text/tool/reasoning part), `session_message` (event-sourced journal). Read path for a post-hoc
summarizer: `SELECT data FROM part WHERE session_id = ? ORDER BY rowid`; same data via
`GET /session/{id}/message`. Live sample: 5320 sessions / 114809 messages / 513552 parts on
this machine.

### 7) Version

1.18.29, source commit `dff8fbc149fb7492e4f07b713ac31ea70d9a541c` ("chore: generate"). No live
behavioural probe was run (binary not installed).

---

## pi (live install, 0.73.1)

Verified against: `/home/andre/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/`
(docs `docs/extensions.md`, `docs/sessions.md`, `docs/session-format.md`; installed JS in
`dist/`), plus live session files under `/home/andre/.pi/agent/sessions/`.

### 1) Event name, config path, schema

`session_shutdown` — "Fired before an extension runtime is torn down"
(`docs/extensions.md:452-466`):

```typescript
pi.on("session_shutdown", async (event, ctx) => {
  // event.reason - "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionFile - destination session for session replacement flows
});
```

The `reason` enum is the symmetric mirror of `session_start`'s
`"startup" | "reload" | "new" | "resume" | "fork"`. Lifecycle diagram
(`docs/extensions.md:333-334`): `exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM) ──► session_shutdown`;
`/new`, `/resume`, `/fork`, `/clone` and `ctx.reload()` all emit `session_shutdown` for the old
instance first (`docs/extensions.md:305-317, 388-389, 405-406, 1170`).

Config surface = extension locations (`docs/extensions.md:108-128`): `~/.pi/agent/extensions/*.ts`
(global), `.pi/extensions/*.ts` (project-local), plus npm/git `packages` in `settings.json`.
Extensions "run with your full system permissions".

### 2) Exit coverage — SIGTERM yes, interactive SIGHUP NO (docs mismatch), crash no

Installed-source truth (`dist/modes/interactive/interactive-mode.js`):

- SIGTERM: `registerSignalHandlers()` (line ~2658) installs a `prependListener` for SIGTERM
  whose handler calls `void this.shutdown()`; `shutdown()` (lines 2629-2640) awaits
  `runtimeHost.dispose()` — which awaits `emitSessionShutdownEvent`
  (`dist/core/agent-session-runtime.js:100-106` `teardownCurrent`,
  `dist/core/extensions/runner.js:52-58`) — then `process.exit(0)`. So SIGTERM runs handlers,
  awaited, errors caught per-handler and reported via `emitError` (`runner.js:483-505`); no
  timeout guard (a hung handler hangs exit — opposite failure mode of Claude Code's 1.5 s).
- Ctrl-C / Ctrl-D: processed by the TUI into the normal shutdown path (per docs lifecycle
  diagram), reaching the same `shutdown()`.
- **SIGHUP: docs say covered (`exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM)`), installed source says
  otherwise** — the signal handler branches `if (signal === "SIGHUP") this.emergencyTerminalExit()`
  (line ~2666), and `emergencyTerminalExit()` (lines 2641-2648) deliberately skips extension
  cleanup and calls `process.exit(129)`. Loud docs-vs-source mismatch; design for SIGHUP = no
  callback in interactive mode.
- Crash / kill -9 / uncaught exception: no `uncaughtException`/`unhandledRejection` handler
  found in `dist/modes/*` or `dist/cli.js` — nothing fires.
- Print/RPC modes wire the same SIGTERM(-and-SIGHUP->exit-code) handlers through
  `disposeRuntime()`/`shutdown()` (`dist/modes/print-mode.js:27-41`,
  `dist/modes/rpc/rpc-mode.js:262-277`); RPC's `shutdown` runs the same
  `emitSessionShutdownEvent` chain.

### 3) Can it elicit MODEL TEXT at close time? — NO first-class API

`session_shutdown` is a plain observer: `runner.emit` collects a result only for
`isSessionBeforeEvent` types (`dist/core/extensions/runner.js:476-506`), so return values are
ignored here, and the agent runtime is being torn down (no steering). `docs/extensions.md`
documents **no** ctx-level LLM/complete helper (contrast Hermes `ctx.llm.complete`).
`ctx.modelRegistry` exposes "Access to models and API keys" (`docs/extensions.md:880`) and
`ctx.signal` is documented as typically `undefined` in session events — an extension could
hand-roll a direct provider HTTP call using registry keys, but that is undocumented territory;
named as unconfirmed, not asserted.

### 4) Shell out — YES

Extensions are Node >= 20.6 TypeScript with full system permissions; `node:child_process` /
`node:fs` are used by bundled examples. Any binary, stdin and args, inside the awaited
`session_shutdown` handler.

### 5) Session id — YES

`ctx.sessionManager.getSessionFile()` (`docs/extensions.md:368, 996`) returns the session file
path; the session id is the header entry's `id`. Minted by
`createSessionId() = uuidv7()` (`dist/core/session-manager.js:5-10`, assigned at `:471`/`:485`),
and the on-disk filename embeds it:
`<ISO-timestamp>_<uuid>.jsonl` — live sample
`/home/andre/.pi/agent/sessions/--tmp-pi-test--/2026-09-08T16-30-09-027Z_01a081db-0283-76dc-86e6-f880e69b8202.jsonl`
whose first line is
`{"type":"session","version":3,"id":"01a081db-0283-76dc-86e6-f880e69b8202",...}`.

### 6) Transcripts on disk — YES

`~/.pi/agent/sessions/--<cwd-with-dashes>--/<timestamp>_<uuid>.jsonl`
(`docs/session-format.md:5-11`; live samples confirmed). JSONL, tree-structured entries
(`id`/`parentId`), version 3 header `{type:"session",version:3,id,timestamp,cwd}` followed by
`model_change`, user/assistant/tool entries. Caveat: `pi --no-session` runs are ephemeral —
no transcript exists to summarize (`docs/sessions.md:12`).

### 7) Version

0.73.1 (`package.json` `"version": "0.73.1"`, matching `lastChangelogVersion` in
`/home/andre/.pi/agent/settings.json`).

---

## Salvaged comparator sections (prior HL-10 run)

Full sections for Hermes and DSH were produced by the earlier run and are incorporated here in
summary form with their original citations.

### Hermes (0.21.1, upstream c076d653) — from the HL-10 Hermes run record

All citations from live install `/home/andre/.hermes/hermes-agent/`:

- **Hooks**: THREE end hooks in `VALID_HOOKS` (`hermes_cli/plugins.py:125-126`):
  `on_session_end`, `on_session_finalize`, `on_session_reset`; registered via
  `ctx.register_hook`; kwargs-dispatched; all observers (return values ignored).
- **Coverage**: `on_session_end` fires per-turn (`agent/turn_finalizer.py:623-636`) plus
  interrupted/TUI-close paths (`tui_gateway/session_lifecycle.py:219-231`, `interrupted=True`);
  `on_session_finalize` fires from the atexit-registered `_run_cleanup` (`cli.py:807-832`,
  `:3864`) covering normal quit, Ctrl-C, SIGTERM/SIGHUP. NOT covered: kill -9, native crash,
  `os._exit` paths (`cli.py:997-1003`).
- **Model text: YES** — `ctx.llm` (`plugins.py:376-382`) exposes host-owned
  `PluginLlm.complete/complete_structured` (`agent/plugin_llm.py:446-473`) on the user's
  default model. Timeouts: `on_session_end` bounded by `plugins.hook_callback_timeout`
  (30 s default, 600 s max, `plugins_dispatch.py:41-45,138-139`); `on_session_finalize`
  unbounded but the exit watchdog `HERMES_EXIT_WATCHDOG_S` (30 s -> `os._exit(0)`,
  `cli.py:678-716`) caps exit-time model calls.
- **Subprocess**: yes — plugin stdlib plus purpose-built shell hooks (config `hooks:` block,
  JSON payload on stdin, `hooks.md:1625-1641`).
- **Session id**: in every end-hook payload; format `YYYYMMDD_HHMMSS_hex6`, minted at
  `cli.py:2825` etc.
- **Transcripts**: per-profile SQLite `state.db` (sessions + messages tables) primary;
  `$HERMES_HOME/sessions/<id>.jsonl` fallback (`hermes_state.py:297-316`).

### DSH (0.1.1-rc.2) — from `.scratch/horizon-line/research/10-partial/dsh.md`

- **No session-end event exists.** Declared `agent/*` vocabulary
  (`dsh-agent/lib/types/runtime-types.d.ts:134-323`) has no `agent/session-end`; closest is
  `agent/disposed` (`runtime-types.d.ts:149-159`), emitted from the registry remove path
  (`dsh-agent/lib/index.js:641`, `lib/types/index.js:300`), payload `{ agent }`,
  `agent.id` = session id.
- **Coverage**: graceful disposal only. Zero signal handlers in any shipped `@deepseek-ai/*`
  package (grep over all `.js`/`.ts`). Design assumption: crash/SIGKILL = no callback;
  SIGINT/SIGTERM depends on the outer binary (not installed in the audited tree) — unconfirmed.
- **Model text**: not through the agent (loop stopped). Only via direct
  `ctx.llm.stream(GenerateOptions)` auxiliary call (`purpose: 'compaction' | 'session-title'`
  exists for this shape) — but emit mode is unawaited and errors swallowed
  (`dsh-agent/lib/index.js:335-359`), so a close-time LLM call is racy; the salvage recommends
  the awaited `agent/turn-stopping` hook or post-hoc transcript reading.
- **Subprocess**: yes (moving-target itself spawns `zstd`).
- **Transcripts**: `~/.dsh/sessions/<projectKey>/<sessionId>/session.jsonl.zstd` — JSONL,
  zstd-compressed, mode 0600; header record carries `id`, `cwd`, `origin`, `delegationDepth`.

---

## Design notes for horizon-line (session-close summarizer)

1. Only Hermes can produce the summary through the harness at close time. For the other four,
   the viable pattern is: persist `{date-time, harness, session_id, transcript_path}` at
   close time (cheap, fast, inside every budget), then derive the summary from the transcript
   afterwards. All five keep complete transcripts on disk.
2. Claude Code: set an explicit per-hook `timeout` (or `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`)
   — the default 1.5 s shared budget will kill a summarizer.
3. pi: `session_shutdown` is the right close-time capture point, but filter
   `event.reason` — `"reload" | "new" | "resume" | "fork"` are session *replacements*, not
   quits; summarize on `quit` (or handle replacement flows deliberately via
   `targetSessionFile`).
4. opencode: there is no end hook; either use `dispose` (no sessionID, graceful-only, races
   `process.exit`) or a per-turn `event` hook that last-writes the active session id and a
   post-hoc transcript sweep. Transcript-derived post-hoc is the honest option.
5. Abnormal exit is uncovered on ALL FIVE harnesses (kill -9 / native crash). A
   crash-tolerant design needs a reconciliation pass (e.g. on next session start, sweep for
   sessions whose transcripts have no summary yet) rather than relying on close-time hooks.

## What could not be confirmed (anti-fabrication)

- Claude Code: whether SessionEnd fires on SIGTERM specifically is not documented anywhere in
  the hooks reference; only the three enumerated triggers (session exit, `/clear`, `/resume`)
  carry the budget text. Signal behaviour would need a live probe with a signal-sending
  harness — not run here.
- Claude Code: session-id minting is inside the closed-source binary; observed only as
  transcript-file stem.
- opencode: no behavioural probe (binary absent) — source reading at `dff8fbc` + read-only DB
  inspection; whether `dispose` completes before the outer `process.exit()` on every graceful
  path was not probed.
- pi: a direct provider call from `session_shutdown` using `ctx.modelRegistry` keys is
  theoretically possible but undocumented — treated as unconfirmed, not a capability claim.
- pi: SIGHUP handling in print/RPC modes differs from interactive (`disposeRuntime().finally`
  chain vs `emergencyTerminalExit`); both read from installed source, neither probed live.
- DSH: outer-binary signal wiring (not shipped in the audited packages) — inherited from the
  salvaged section as unconfirmed.

## Salvage provenance

- HL-10 (parent card) prior run covered Hermes (section lost with its workspace
  `sections/hermes.md`; findings recovered verbatim from the run record in
  `~/.hermes/kanban/boards/horizon-line/kanban.db`, `task_runs.summary` for run 18) and DSH
  (salvaged at `.scratch/horizon-line/research/10-partial/dsh.md`).
- The same prior run's workspace also contained a complete opencode session-END section
  (`sections/opencode.md`); its load-bearing quotes were re-verified against the source
  checkout today and it is incorporated (with attribution in the section header) rather than
  redone.
- HL-10b (this card) researched Claude Code and pi fresh, per the anti-fabrication standard of
  `01-claude-opencode-hooks.md` and `02-hermes-pi-hooks.md`.
