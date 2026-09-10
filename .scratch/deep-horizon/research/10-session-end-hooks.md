# Research: session-END hook surfaces across all five harnesses (HL-10)

Type: research
Status: done
Date: 2026-09-08
Researched against live installs, live probes, and source; every claim carries a URL or
file path. Mirror of research/01 (Claude Code + opencode start) and research/02 (Hermes +
pi start). Nothing is inferred from a sibling harness; per-harness evidence blocks follow
this summary verbatim.

## Executive answer

| Harness | Session-end hook | Fires on non-graceful exit? | Model text at close? | Session id in hook | Transcripts on disk |
|---|---|---|---|---|---|
| Claude Code 2.1.258 | `Stop` (+`StopFailure`), `SessionEnd` | `SessionEnd` fires on SIGINT/SIGTERM (probed, `reason:"other"`); not on SIGKILL (undocumented, unprobed) | **YES via Stop** (`decision:"block"` → model continues; probed) — SessionEnd is fire-and-forget | YES: `session_id` on stdin = transcript basename | `~/.claude/projects/<munged-cwd>/<sid>.jsonl`, `~/.claude/history.jsonl` |
| opencode 1.18.29 | **no session-end hook**; nearest: `dispose` (no args) + `event` `session.idle` (per turn) | **nothing fires** on SIGTERM/Ctrl-C/crash (no signal handlers → no dispose) | **YES** — `dispose` gets full `client`; `client.session.prompt(...)` runs a real agent turn | `dispose`: NO. `session.idle`: yes (`ses_…`, sortable, minted in `packages/schema/src/identifier.ts`) | `~/.local/share/opencode/opencode.db` (SQLite: `session`,`message`,`part`,`session_message`) |
| DSH 0.1.1-rc.2 | **no `agent/session-end`**; nearest: `agent/disposed` (emit-mode, unawaited) | graceful disposal only; **zero signal handlers in any shipped package** → crash/kill fires nothing | only via direct `ctx.llm.stream(...)` + `BlockAssembler` — unawaited, liveness at dispose-time **unconfirmed**; robust path is `agent.steer` while alive (`agent/turn-stopping` is awaited) | YES: `payload.agent.id` = session id (enforced `agent.id === agent.session.id`) | `~/.dsh/sessions/<projectKey>/<sid>/session.jsonl.zstd` |
| Hermes 0.21.1 | `on_session_finalize` (real close), `on_session_reset` (/new), `on_session_end` (per turn) | finalize covers normal quit, Ctrl-C, SIGTERM/SIGHUP (atexit+signal→`_run_cleanup`); **not** SIGKILL / `os._exit` | **YES** — `ctx.llm.complete[_structured]` (`agent/plugin_llm.py:446/:460`); finalize hooks intentionally **unbounded** (no hook timeout) | YES: `<YYYYMMDD_HHMMSS>_<6hex>` (`cli_session_mixin.py:530`) | `$HERMES_HOME/sessions/<sid>.jsonl` + `state.db` `messages` table (per profile) |
| pi 0.73.1 | `session_shutdown` (mirror of `session_start`, `reason` enum) | graceful quit/SIGTERM/Ctrl-C-at-idle yes; **SIGHUP exits 129 skipping shutdown**; SIGKILL/crash no | **YES** — in-process `complete()` from `@mariozechner/pi-ai` with `ctx.modelRegistry`; handler awaited during teardown | event payload has only `reason`/`targetSessionFile`; id via `ctx.sessionManager` / filename | `~/.pi/agent/sessions/<munged-cwd>/<ts>_<uuid>.jsonl` (header line has `id`) |

**Design-critical findings (flagged loudly as requested):**

1. **Every harness CAN produce model text at or before close — but only Claude Code
   (Stop block), Hermes (finalize + ctx.llm), and pi (session_shutdown + complete()) can
   do it *at close time* with the hook itself eliciting the text.** opencode can do it
   inside `dispose` via its own client-driven turn, but `dispose` receives no sessionID
   and does not fire on abnormal exit. DSH's close-time event is unawaited and its LLM
   service liveness at that moment is unconfirmable from shipped code — treat DSH
   close-time elicitation as unreliable.
2. **Abnormal exits are universally uncovered or uncovered-except-Claude-Code.** Only
   Claude Code's `SessionEnd` is proven (live probe) to fire on SIGINT/SIGTERM. DSH ships
   no signal handling at all. Any design that must not lose summaries on crash needs the
   derive-later path (column 6) as the fallback, not the exception.
3. **Session ids are join-key-ready everywhere except opencode's `dispose`** (no args at
   all) and pi's `session_shutdown` payload (id reachable via ctx, not in the event).
   All five harnesses write self-identifying transcripts (header lines carry the id), so
   a later pass can always recover the id from disk.

Cross-harness id formats: Claude Code UUIDv4; opencode `ses_` + 26-char descending
sortable token; DSH UUIDv4 (caller-supplied, ACP-minted); Hermes `<YYYYMMDD_HHMMSS>_<6hex>`;
pi UUIDv7-shaped. The JSON store must therefore store the id as an opaque string plus the
harness name; no format assumptions.


---

# Part 1 — Claude Code

Verified against: **Claude Code 2.1.258** (local, `claude --version`), official docs
fetched 2026-09-08 from https://code.claude.com/docs/en/hooks (raw markdown mirror at
`/tmp/cc-hooks-fresh.md`, 3773 lines), plus four live headless probes in `/tmp/cc-endprobe*`
(hook stdin JSON quoted verbatim below). Section line numbers below refer to the docs mirror.

## 1) Hook names, config path, schema

Three session-end-relevant events, configured under `hooks` in the same surfaces as
SessionStart (HL-01): `~/.claude/settings.json`, `.claude/settings.json`,
`.claude/settings.local.json`, managed settings, or a plugin's `hooks/hooks.json`.

- **`Stop`** (docs L2462): "Runs when the main Claude Code agent has finished responding.
  Does not run if the stoppage occurred due to a user interrupt. API errors fire
  `StopFailure` instead."
- **`StopFailure`** (docs L2564): fires instead of Stop when the turn ends on an API error.
  Claude Code ignores the hook's output and exit code (log/alert only). Input adds `error`,
  optional `error_details`, optional `last_assistant_message`.
- **`SessionEnd`** (docs L3243): "Runs when a Claude Code session ends." Input adds
  `reason`: `clear | resume | logout | prompt_input_exit | other`
  (`bypass_permissions_disabled` was removed in v2.1.234). A `matcher` filters on `reason`.

Schema (same shape as all command hooks):

```json
{
  "hooks": {
    "SessionEnd": [ { "matcher": "other", "hooks": [ { "type": "command", "command": "/abs/hook.sh", "timeout": 30 } ] } ],
    "Stop": [ { "hooks": [ { "type": "command", "command": "/abs/hook.sh", "timeout": 30 } ] } ]
  }
}
```

Timeout, SessionEnd-specific (docs L3275): **default 1.5 seconds**; the budget is
auto-raised to the highest per-hook `timeout` configured in settings files, capped at
60 s (plugin-provided hooks do NOT raise the budget); explicit override via
`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` (milliseconds).

Stop-specific input fields (docs L2474-2478): `stop_hook_active` (true when this Stop is
already the result of a Stop-hook continuation; CC ends the turn after **8 consecutive
blocks**), `last_assistant_message` ("the text content of Claude's final response, so
hooks can access it without parsing the transcript"), `background_tasks[]`,
`session_crons[]` (to distinguish "done" from "paused waiting on background work").

## 2) Exit coverage — probed live

| Exit | Stop | SessionEnd | Evidence |
|---|---|---|---|
| Normal headless completion | fires | fires, `reason:"other"` | `/tmp/cc-endprobe/hooklog.txt`: both lines, 1 s apart |
| SIGINT mid-turn (Ctrl-C) | **does not fire** (docs: "Does not run if the stoppage occurred due to a user interrupt") | **fires**, `reason:"other"` | `/tmp/cc-endprobe4/`: `kill -INT` while generating → hooklog has SessionEnd only |
| SIGTERM mid-turn | does not fire | **fires** (hook attempted; our probe script lacked +x and CC printed `SessionEnd hook [/tmp/cc-endprobe3/log-hook.sh] failed: Permission denied` — proof of invocation) | `/tmp/cc-endprobe3/out.txt` |
| API-error turn end | StopFailure fires instead | (session continues) | docs L2564-2566 |
| SIGKILL / hard crash / power loss | **not probed, not documented** | **not probed, not documented** | docs silent; mechanically a SIGKILLed process has no cleanup window — stated as unverified, not confirmed |

Probe stdin, verbatim (`/tmp/cc-endprobe/hooklog.txt`, TS normalised):

```
Stop       stdin={"session_id":"f38b41ff-3884-4556-b07c-224a68c1ccfa","transcript_path":"/home/andre/.claude/projects/-tmp-cc-endprobe/f38b41ff-3884-4556-b07c-224a68c1ccfa.jsonl","cwd":"/tmp/cc-endprobe","prompt_id":"67055686-...","permission_mode":"auto","effort":{"level":"high"},"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"hello probe","background_tasks":[],"session_crons":[]}
SessionEnd stdin={"session_id":"f38b41ff-3884-4556-b07c-224a68c1ccfa","transcript_path":"...f38b41ff....jsonl","cwd":"/tmp/cc-endprobe","prompt_id":"67055686-...","hook_event_name":"SessionEnd","reason":"other"}
```

## 3) Can a close hook elicit MODEL text? — YES via Stop; NO via SessionEnd

**Stop is a real close-time model surface.** Decision control (docs L2534-2562): a Stop
hook can return `{"decision": "block", "reason": "..."}` (or exit 2 with stderr as
reason, or `hookSpecificOutput.additionalContext`) and Claude **continues the
conversation** with that instruction. Live proof (`/tmp/cc-endprobe2/`): Stop hook
blocked once with reason "Before you finish, reply with exactly: GOODBYE FROM MODEL";
the model's next reply was `GOODBYE FROM MODEL`; the second Stop fired with
`stop_hook_active:true` and `last_assistant_message:"GOODBYE FROM MODEL"`. So a
session-summary can be written **by the harness model itself** at the last turn: block
the first Stop once, ask for a 3-sentence summary, capture `last_assistant_message` on
the second Stop. Guard rails: check `stop_hook_active` and the 8-consecutive-block cap.

**SessionEnd is fire-and-forget**: "SessionEnd hooks have no decision control. They
can't block session termination but can perform cleanup tasks. Claude Code discards
their JSON output fields, such as `systemMessage`." (docs L3273). No model access.

## 4) Shell out, pass text

Yes — both are command hooks: binary spawned by Claude Code, full hook-input JSON on
**stdin** (probe above), decisions via exit code / stdout JSON. No stdin writing back to
CC beyond the JSON grammar.

## 5) Session id

Both events carry `session_id` on stdin; it is the same UUID as the transcript file
basename (`<session_id>.jsonl` under `~/.claude/projects/<munged-cwd>/`) — confirmed in
the probe stdin above. The id is generated by Claude Code per session (UUIDv4-format in
probes).

## 6) Transcripts on disk (derive-later path)

- `~/.claude/projects/<munged-cwd>/<session_id>.jsonl` — full per-session message log
  (path confirmed live by `transcript_path` in every probe stdin). JSONL.
- `~/.claude/history.jsonl` — cross-session user-prompt history.
- Cross-evidence that the path shape is stable API: Hermes ships an importer keyed to it —
  `hermes_cli/foreign_sessions.py:168`: `"claude": ((".claude", "projects"), "*/*.jsonl", ...)`.

## 7) Version

Claude Code **2.1.258** (`claude --version`, 2026-09-08). Docs sections quoted are the
same-day fetch; e.g. the `reason` enum note "Removed in v2.1.234" shows the docs are
newer than 2.1.234 and were applied to a 2.1.258 probe run.

---

# Part 2 — opencode

Type: research
Status: done
Date: 2026-09-08
Researched against source only (binary not exercised): checkout at
`/home/andre/.hermes/kanban/boards/horizon-line/workspaces/t_99204bb9/opencode-src`,
HEAD `dff8fbc149fb7492e4f07b713ac31ea70d9a541c` ("chore: generate"),
`packages/opencode/package.json` + `packages/plugin/package.json` both
`"version": "1.18.29"`. READ-ONLY — nothing modified/committed there. Live
storage samples come from this machine's `~/.local/share/opencode` (real
opencode install), read with `sqlite3 -readonly`.

## Executive answer

- There is **no dedicated session-end hook** (`session.end` / `session.close`
  / `session.stop` / process-exit hook do not exist in the `Hooks` interface).
  The nearest surfaces are, in order of usefulness:
  1. `dispose?: () => Promise<void>` — a plugin-lifecycle hook that fires when
     the instance's plugin layer is torn down (normal command exit, TUI quit,
     `/exit`, instance dispose API). It receives **nothing** (no sessionID).
  2. `event` hook seeing `session.idle` `{ sessionID }` — fires after **every
     turn** (not process end), fire-and-forget.
  3. `event` hook seeing `session.deleted` — only on explicit session delete,
     not exit.
- **Abnormal exit fires nothing.** There is no `process.on("SIGTERM")` (and no
  crash-path disposal) in `packages/opencode/src`; a hard Ctrl-C on
  non-interactive `opencode run`, SIGTERM, SIGKILL, or a crash kills the
  process without running `dispose` or any event hook. `bin/opencode` forwards
  SIGINT/SIGTERM/SIGHUP to the app child and then re-raises — that's signal
  plumbing, not hook invocation.
- **`dispose` CAN elicit model text** — it is not limited to fire-and-forget.
  Every plugin receives `client` (a full `createOpencodeClient` SDK client),
  which exposes `client.session.prompt(...)` (`POST /session/{id}/message`,
  runs a complete agent turn and resolves with the response) plus
  `promptAsync`, `command`, `shell`, `summarize`. A `dispose` hook can
  therefore run a one-off LLM call at close time — with caveats on ordering
  (below). The `event` hook is the fire-and-forget one (`void hook["event"]?.(...)`,
  never awaited).
- Hooks are in-process JS/TS. Shelling out is done by the plugin itself via
  the injected `$` (Bun shell); it supports stdin and escaped arg
  interpolation, but is `undefined` unless running under the Bun runtime.

---

## 1) Session-end hook: exact names + signatures

`packages/plugin/src/index.ts` `export interface Hooks` (lines 222–335).
Complete hook-name inventory at `dff8fbc`:

| Hook | Fires at session end? | Receives sessionID? |
|---|---|---|
| `dispose` | **closest thing** — instance/plugin teardown | no |
| `event` | sees `session.idle`, `session.deleted`, `session.error` via event bus | inside `event.properties` |
| `chat.message`, `chat.params`, `chat.headers` | no — per user message | yes |
| `permission.ask` | no | no (Permission object may carry one) |
| `command.execute.before` | no | yes |
| `tool.execute.before` / `tool.execute.after` | no — per tool call | yes |
| `shell.env` | no | optional |
| `tool.definition` | no | no |
| `experimental.chat.messages.transform`, `experimental.chat.system.transform` | no | optional (`sessionID?`) |
| `experimental.provider.small_model` | no | no |
| `experimental.session.compacting`, `experimental.compaction.autocontinue` | no — compaction, not end | yes |
| `experimental.text.complete` | no — per assistant text part | yes |
| `config`, `tool`, `auth`, `provider` | lifecycle/config, not end | n/a |

Exact signatures (verbatim from `packages/plugin/src/index.ts`):

```ts
export interface Hooks {
  dispose?: () => Promise<void>                                    // L223
  event?: (input: { event: Event }) => Promise<void>               // L224
  "chat.message"?: (
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      messageID?: string
      variant?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>                                               // L234-243
  "experimental.text.complete"?: (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => Promise<void>                                               // L327-330
  // ... full list in the interface, L222-335
}
```

Notes:
- There is **no** `chat.stop`, `chat.idle`, `session.end`, `session.close`,
  `session.exit`, or `process.exit` entry anywhere in the interface (grep over
  the file confirms only the names listed above).
- `session.idle` is an **event**, not a dedicated hook. Schema:
  `packages/schema/src/session-status-event.ts` L44-49 — `Event.define({
  type: "session.idle", schema: { sessionID: SessionID } })`, explicitly
  commented `// deprecated` (superseded by `session.status` with
  `status.type === "idle"`). Published by `SessionStatus.set` in
  `packages/opencode/src/session/status.ts` L41-48 whenever a session's
  status flips to idle — i.e. after **every** assistant turn (and on abort /
  error paths in `packages/opencode/src/session/processor.ts` L626, L638), not
  once per session and not at process exit.
- `session.deleted` (`packages/schema/src/v1/session.ts` L588-595, payload
  `{ sessionID, info: SessionInfo }`) is published only from the explicit
  delete path `packages/opencode/src/session/session.ts` L622 — i.e. `DELETE
  /session/{id}` or `/sessions` UI delete. It does NOT fire at shutdown.
  In-tree usage example of an `event` hook filtering on it:
  `packages/opencode/src/plugin/openai/codex.ts` L285-287.

Where `dispose` is invoked — `packages/opencode/src/plugin/index.ts` L265-278:

```ts
yield* Effect.addFinalizer(() =>
  Effect.forEach(
    hooks,
    (hook) =>
      Effect.tryPromise({
        try: () => Promise.resolve(hook.dispose?.()),
        catch: errorMessage,
      }).pipe(
        Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error })),
        Effect.ignore,
      ),
    { discard: true },
  ),
)
```

So `dispose` runs sequentially per plugin, errors are logged and swallowed,
and it is registered as a finalizer on the plugin-service state scope.
Trigger chain (normal exit):

- CLI commands: `packages/opencode/src/cli/effect-cmd.ts` L89-97 — handler
  wrapped in `try { ... } finally { await AppRuntime.runPromise(store.dispose(ctx)) }`
  ("Auto-disposes via `Effect.ensuring(store.dispose(ctx))` on every Exit").
- `InstanceStore.dispose` (`packages/opencode/src/project/instance-store.ts`
  L147-156) → `disposeContext` (L94-99) → `runDisposers(ctx.directory)`
  (registry in `packages/opencode/src/effect/instance-registry.ts` L9-15) +
  emits `server.instance.disposed`.
- InstanceState-backed services register a per-directory disposer that
  invalidates their `ScopedCache` (`packages/opencode/src/effect/instance-state.ts`
  L38). *Caveat:* the exact step "cache invalidation closes the state scope →
  the `Effect.addFinalizer` above runs" relies on `ScopedCache` internals in
  the `effect` dep (not vendored in this checkout — `node_modules` absent), so
  that one link is read from the surrounding code's intent, not from
  ScopedCache source. Everything else in this chain is quoted verbatim.
- TUI: quitting the UI → `packages/opencode/src/cli/cmd/tui.ts` L296-301
  `finally { await stop() }` → worker RPC `shutdown()`
  (`packages/opencode/src/cli/tui/worker.ts` L72-77) → `disposeAllInstances()`
  then `server.stop(true)` — note dispose happens **before** the server
  stops, which matters for §3.
- HTTP API: `POST /instance/dispose` and `POST /global/dispose`
  (`packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts`
  L62, `groups/global.ts` L117) → `disposeAllInstancesAndEmitGlobalDisposed`
  (`packages/opencode/src/server/global-lifecycle.ts` L13-22).

## 2) Exit coverage: Ctrl-C / SIGTERM / crash

**Nothing fires on abnormal exit. Say this plainly in any design doc.**

Evidence:

- Signal-handler inventory across `packages/opencode/src` (grep
  `SIGINT|SIGTERM|SIGHUP`): the only `process.on(...)` registrations are
  - `packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts` L265/L290 —
    SIGINT in interactive `--mini` mode only: first Ctrl-C clears the prompt
    draft, second goes through `footer.requestExit()` (a *graceful* UI exit,
    which lands in the §1 normal-exit chain);
  - `packages/opencode/src/cli/cmd/tui.ts` L219 — `SIGUSR2` for hot reload;
  - `packages/tui/src/app.tsx` L233 — `SIGHUP` → destroy renderer (graceful-ish);
  - `packages/opencode/src/cli/cmd/run/footer.ts` L298 — `SIGUSR2` theme.
- **No `process.on("SIGTERM")` exists anywhere in `packages/opencode/src` or
  `packages/core/src`** — every SIGTERM hit is `proc.kill(...)` sent *to*
  subprocesses (MCP servers, shell), never a handler.
- Non-interactive `opencode run "..."`: the process parks in
  `loop(client, events)` awaiting SSE (`packages/opencode/src/cli/cmd/run.ts`
  L824-834; exits its loop on `session.status` idle). A bare Ctrl-C here hits
  no handler → default terminate → the `effectCmd` `finally` never runs → no
  `dispose`, no hook.
- `serve` mode: handler is `yield* Effect.never`
  (`packages/opencode/src/cli/cmd/serve.ts` L21) — SIGINT/SIGTERM kill it with
  no disposal.
- Crash / uncaught exception: `worker.ts` installs
  `unhandledRejection`/`uncaughtException` loggers and removes them in
  `shutdown()` (L74-76), but nothing disposes instances on those paths.
- `packages/opencode/bin/opencode` (node launcher) L8-42: forwards
  `SIGINT/SIGTERM/SIGHUP` to the app child, then re-raises the signal at self.
  Plumbing only.
- `packages/opencode/src/index.ts` L136-142: after any command, `finally {
  process.exit() }` — "Explicitly exit to avoid any hanging subprocesses."
  This hard-exit is also why async work started inside an `event` hook (see
  §3) gets cut off at CLI exit.

Consequence for "session ended" semantics: `dispose` = "instance/app shutting
down cleanly" (≈ CLI process about to exit after a normal command, or TUI
quit), NOT "crash-safe end-of-session". For crash coverage the only artifacts
are whatever was already persisted in SQLite (§6).

## 3) Can the hook elicit MODEL TEXT at close time? — YES (critical)

The hook is not constrained to fire-and-forget. What the plugin gets
(`packages/plugin/src/index.ts` L56-66):

```ts
export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>
  project: Project
  directory: string
  worktree: string
  ...
  serverUrl: URL
  $: BunShell
}
```

`client` construction (`packages/opencode/src/plugin/index.ts` L145-151): a
real SDK client pointed at the in-process server (`Server.url`, with auth
headers, falling back to calling the Hono app's `fetch` directly when no URL).
Plugins therefore share the server's own HTTP API.

The session API can run a full prompt. `packages/sdk/js/src/gen/sdk.gen.ts`,
`class Session` (L431+), verbatim method list relevant here:

- `prompt` — "Create and send a new message to a session" →
  `POST /session/{id}/message` (L625-636). Body (`SessionPromptData`,
  `packages/sdk/js/src/gen/types.gen.ts` L2588-2613):
  `{ messageID?, model?: {providerID, modelID}, agent?, noReply?, system?,
    tools?, parts: Array<TextPartInput|FilePartInput|AgentPartInput|SubtaskPartInput> }`.
  This is the same endpoint `opencode run` uses for its whole turn
  (`run.ts` L868-874) — it runs the agent loop and resolves with the result.
  So `client.session.prompt({ sessionID, parts: [{type:"text", text: "summarize this session"}] })`
  inside a hook returns **model text**.
- `promptAsync` — `POST /session/{id}/prompt_async`, "start if needed and
  return immediately".
- `command` — `POST /session/{id}/command` (slash commands).
- `shell` — `POST /session/{id}/shell`.
- `summarize` — `POST /session/{id}/summarize` (LLM compaction summary).
- plus `create/list/get/messages/fork/abort/...` (full list in sdk.gen.ts).

There is **no** `client.session.chat` method at this commit — the prompt
method is `prompt` (name it correctly in design docs).

Feasibility at close time, per surface:

- `dispose`: synchronous-ish await of your own `Promise` — the finalizer
  awaits `hook.dispose?.()` (`plugin/index.ts` L270 `try: () =>
  Promise.resolve(hook.dispose?.())`, inside `Effect.tryPromise`). A dispose
  that `await`s `client.session.prompt(...)` genuinely blocks teardown until
  the LLM answers. Ordering is favorable in the two main paths: TUI quit runs
  `disposeAllInstances()` **before** `server.stop(true)` (`worker.ts` L72-77),
  and CLI `run` disposes in `effectCmd`'s `finally` before the outer
  `process.exit()` in `index.ts`. Risk to design around: you're calling the
  session API *during* instance disposal; if the plugin layer for that
  instance is what's closing, a prompt that re-enters the same instance's
  session pipeline may race the teardown (it triggers the full hook cascade
  again — `chat.message` etc. will re-fire on your synthetic turn). Safer
  pattern: do the LLM work from `dispose` on a **new** session
  (`client.session.create()` then `prompt`), not the closing one.
- `event` hook (`session.idle`): the dispatcher does **not** await it —
  `packages/opencode/src/plugin/index.ts` L255-262:
  ```ts
  const unsubscribe = yield* events.listen((event) => {
    if (event.location?.directory !== ctx.directory) return Effect.void
    return Effect.sync(() => {
      for (const hook of hooks) {
        void hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any })
      }
    })
  })
  ```
  Fire-and-forget: `void`, errors unhandled, nobody waits. The hook can still
  start async work (an LLM call will proceed), but at CLI process end
  `index.ts`'s `process.exit()` can cut it short; and every turn triggers
  `session.idle`, so "close time" must be inferred by the plugin.
- `experimental.text.complete`: awaited via `plugin.trigger` inside the
  stream loop (`packages/opencode/src/session/processor.ts` L529-539) — but it
  fires per text part, mid-turn; its `output.text` is *substituted into the
  part*, so it can rewrite model text but is not an end-of-session point.

Bottom line: **`dispose` + `client.session.prompt` = model text at close
time, supported by the code as written.** `event`-hook-based approaches are
fire-and-forget by construction.

## 4) Shell out (Bun `$`), pass text via stdin/args — YES, with a runtime caveat

`PluginInput.$: BunShell` (`packages/plugin/src/index.ts` L65) is Bun's shell
tag function; type in `packages/plugin/src/shell.ts`:

```ts
export interface BunShell {
  (strings: TemplateStringsArray, ...expressions: ShellExpression[]): BunShellPromise
  escape(input: string): string
  ...
}
export interface BunShellPromise extends Promise<BunShellOutput> {
  readonly stdin: WritableStream          // ← stdin
  text(encoding?: BufferEncoding): Promise<string>   // ← capture stdout as text
  json(): Promise<any>
  lines(): AsyncIterable<string>
  quiet(): this
  env(newEnv: Record<string, string> | undefined): this
  cwd(newCwd: string): this
  ...
}
```

So a hook can do both:

- args: `` await $`/path/binary ${text}`.text() `` (interpolation is escaped;
  `$.escape` available for pre-escaped pieces);
- stdin: write to the returned promise's `.stdin` `WritableStream`, read back
  via `.text()`.

**Caveat (verbatim, `packages/opencode/src/plugin/index.ts` L167):**

```ts
$: typeof Bun === "undefined" ? undefined : Bun.$,
```

Under the Bun runtime (normal packaged binary) `$` is live; if the plugin ever
runs where the global `Bun` is absent, `$` is `undefined` and shell-out via
`$` is unavailable — fall back to node `child_process` in the plugin itself.

## 5) sessionID: who receives it, where it's born

Hooks with `sessionID` in their input (all verbatim in
`packages/plugin/src/index.ts`): `chat.message` (L236), `chat.params` (L248),
`chat.headers` (L258), `command.execute.before` (L263), `tool.execute.before`
(L267), `shell.env` (`sessionID?`, L271), `tool.execute.after` (L275),
`experimental.chat.system.transform` (`sessionID?`, L292),
`experimental.session.compacting` (L306),
`experimental.compaction.autocontinue` (L318),
`experimental.text.complete` (L328). The `event` hook gets it inside
properties of session-scoped events (`session.idle` → `{ sessionID }`,
`session.deleted` → `{ sessionID, info }`, `session.status` →
`{ sessionID, status }`). `dispose` gets **no** sessionID.

ID creation:

- Branding/format: `packages/schema/src/session-id.ts` (whole file):
  ```ts
  export const SessionID = Schema.String.check(Schema.isStartsWith("ses")).pipe(
    Schema.brand("SessionID"),
    statics((schema) => {
      const create = () => schema.make("ses_" + descending())
      return { create, descending: (id?) => ... },
    }),
  )
  ```
- Generator: `packages/schema/src/identifier.ts` — `descending()` builds a
  26-char sortable id: `timestamp_ms * 0x1000 + counter` inverted for
  descending order, rendered as 12 hex time chars + 14 random chars from
  `crypto.getRandomValues` over `[0-9A-Za-z]`.
- Assigned: `Session.createNext`, `packages/opencode/src/session/session.ts`
  L498-530 — `id: SessionID.descending(input.id)` on the new `SessionInfo`,
  then `events.publish(SessionV1.Event.Created, { sessionID: result.id, info:
  result })`. (Subagent sessions get theirs in `tool/task.ts` via
  `sessions.create({ parentID: ... })` — same generator; `parentID` set there
  is the subagent discriminator from HL-01.)
- Message/part ids use the same identifier module (`msg_`/`prt_`/`prt_dd…`
  prefixes visible in real rows, §6 — the `msg_`/`prt_` short prefixes come
  from their respective schema statics).

## 6) Transcripts on disk (verified against the live install)

Two layers under `~/.local/share/opencode/` (i.e. `$XDG_DATA_HOME/opencode`,
`packages/core/src/global.ts` L2-13: `data = path.join(xdgData!, "opencode")`):

**(a) JSON storage — legacy, mostly migrated away.**
`packages/opencode/src/storage/storage.ts`: files are `path.join(dir, ...key) +
".json"` (L63-64) under `Global.Path.data + "/storage"` (L224). Migration
code (L82-180) references the historic layout
`storage/session/info/*.json`, `storage/session/message/<ses>/*.json`,
`storage/session/part/<ses>/<msg>/*.json` — moved into SQLite by migrations.
**Real dir on this machine** (`ls ~/.local/share/opencode/storage`):
only `migration` (marker file, contents `2`), `plugin/`, and
`session_diff/ses_<id>.json` (legacy diff cache; sample content `[]`).
No `session/` or `message/` JSON dirs remain here.

**(b) SQLite — the live transcript store.**
`packages/core/src/database/database.ts` L43-55: DB path is
`~/.local/share/opencode/opencode.db` (prod/latest/beta channel; other
channels get `opencode-<channel>.db`; `OPENCODE_DB` env overrides), opened
with WAL (`PRAGMA journal_mode = WAL`, L27). Real files:
`opencode.db` 11,208,895,720 bytes + `-wal` 34.5 MB + `-shm` (as of
2026-09-08 10:04).

Schema (`CREATE TABLE` in `packages/core/src/database/migration/20260127222353_familiar_lady_ursula.ts`,
extended by later migrations incl. `20260427172553_slow_nightmare.ts`
`session_message`; drizzle defs in `packages/core/src/session/sql.ts`):

- `session(id PK, project_id, workspace_id, parent_id, slug, directory, path,
  title, version, share_url, summary_*, metadata json, cost real,
  tokens_input/output/reasoning/cache_read/cache_write, revert json,
  permission json, agent, model json, time_created, time_updated,
  time_compacting, time_archived)` (sql.ts L22-66)
- `message(id PK, session_id FK→session ON DELETE CASCADE, time_created,
  time_updated, data json NOT NULL)` — `data` = full V1 message JSON
  (sql.ts L68-80)
- `part(id PK, message_id FK→message CASCADE, session_id, time_created,
  time_updated, data json NOT NULL)` — one row per text/tool/reasoning part
  (sql.ts L82-97)
- `session_message(id PK, session_id, type, seq, time_created, time_updated,
  data json)` — event-sourced session journal (sql.ts L119-137)
- plus `session_input`, `session_context_epoch`, `todo`, `session_share`,
  `project`, `project_directory`, `workspace`, `account`, `account_state`,
  `control_account`, `credential`, `permission`, `event`, `event_sequence`,
  `data_migration`, `migration`, `__drizzle_migrations` (verified by running
  `sqlite3` against the live DB; 22 tables listed).

Live row samples (read-only, `sqlite3 -readonly`):

```
session counts: 5320 sessions / 114809 messages / 513552 parts

SELECT id, title, directory, version FROM session LIMIT 1;
ses_22e9bb424ffewpd8FrGU6inP4O | OpenCode inquiry | /home/andre | 1.14.28

SELECT id, session_id, substr(data,1,300) FROM message LIMIT 1;
msg_dd1644be3001dTpL949tmlcxFO | ses_22e9bb424ffewpd8FrGU6inP4O |
{"role":"user","time":{"created":1777334504435},"agent":"build",
 "model":{"providerID":"deepseek","modelID":"deepseek-v4-flash"},
 "summary":{"diffs":[]}}

SELECT id, message_id, substr(data,1,200) FROM part LIMIT 1;
prt_dd1644be4001VmCmgy3sYN6qyF | msg_dd1644be3001dTpL949tmlcxFO |
{"type":"text","text":"opencode"}
```

Read path for a post-hoc session-end consumer (no hook needed):
`SELECT data FROM part WHERE session_id = ? ORDER BY rowid` (or join
`message` on `id`) reconstructs the transcript; the server exposes the same
via `GET /session/{id}/message` (`client.session.messages`, sdk.gen.ts
"List messages for a session").

## 7) Version — verified

- `packages/opencode/package.json` L3: `"version": "1.18.29"`
- `packages/plugin/package.json` L4: `"version": "1.18.29"`
- `git log -1` at the checkout: `dff8fbc149fb7492e4f07b713ac31ea70d9a541c
  chore: generate` (HEAD, clean tree — `git status` empty)
- Note: `InstallationVersion` in `packages/core/src/installation/version.ts`
  is a **build-time** global (`OPENCODE_VERSION`, fallback `"local"`), so the
  package.json is the authoritative source version at this commit.

## Mapping to session-end injection designs

| Need | opencode 1.18.29 reality |
|---|---|
| Hook at session end | `dispose` (app/instance close, no sessionID) or `event`+`session.idle` (per-turn, `{sessionID}`) |
| Fires on Ctrl-C/SIGTERM/crash | **nothing** — graceful exit only |
| Elicit model text at close | `dispose` awaiting `client.session.prompt(...)` (blocks teardown; prefer a fresh session for the summary turn) |
| Shell out with stdin/args | plugin-side Bun `$` (`.stdin`, `.text()`); `undefined` outside Bun runtime |
| Get the sessionID | `event`/turn hooks carry it; `dispose` must read it from elsewhere (e.g. remembered from earlier `session.idle`, or `client.session.list()`) |
| Transcript without hooks | SQLite `~/.local/share/opencode/opencode.db` (`message`/`part` tables, JSON `data` cols) |

## What could not be confirmed

- No live behavioral probe of hooks (binary not run against a test plugin);
  everything above is source reading at `dff8fbc` + read-only inspection of
  the existing on-disk DB.
- The one inferential link in the dispose chain: `ScopedCache.invalidate` →
  state-scope close → `Effect.addFinalizer(dispose)` — the `effect` package
  source is not vendored in this checkout (`node_modules` absent), so this
  link is read from surrounding code intent (`instance-state.ts` L38,
  `plugin/index.ts` L265) rather than ScopedCache internals.
- Whether `dispose` completion is *guaranteed* before process death in every
  graceful path (e.g. very slow LLM call in `dispose` racing outer
  `process.exit()` in `index.ts` L141) was not probed at runtime — the code
  shows `await`-ordering in `effectCmd`/`tui.ts` but the outer `finally {
  process.exit() }` is an unconditional hard exit once the command returns.
- Ordering of `dispose` across multiple plugins is defined (sequential,
  registration order, `Effect.forEach` default) but relative to *other*
  services' finalizers was not pinned down.

---

# Part 3 — DSH (DeepSeek Harness)

Researched 2026-09-08 from `/home/andre/git/moving-target` (plugin, v0.1.5) and its installed
`node_modules/@deepseek-ai/` packages. All quotes below carry file paths; nothing is inferred
beyond what is explicitly marked "could not confirm".

**Versions (from package.json, `grep '"version"'):**

| Package | Version |
|---|---|
| @deepseek-ai/dsh-agent | 0.1.1-rc.2 |
| @deepseek-ai/dsh-session | 0.1.1-rc.2 |
| @deepseek-ai/dsh-llm | 0.1.1-rc.2 |
| @deepseek-ai/dsh-tools | 0.1.1-rc.2 |
| @deepseek-ai/dsh-scope, dsh-commands, dsh-system-prompt, dsh-timeout | 0.1.1-rc.2 |
| @deepseek-ai/cordis | 4.0.1 |
| moving-target | 0.1.5 |

---

## 1) Session-end equivalent of `agent/session-start`

**There is no `agent/session-end` event.** The declared `agent/*` event vocabulary lives in
`dsh-agent/lib/types/runtime-types.d.ts` (module augmentation of `@deepseek-ai/cordis` `Events`,
lines 134–323). Full list: `agent/created`, `agent/disposed`, `agent/status`, `agent/inbox/inserted`,
`agent/inbox/claimed`, `agent/inbox/discarded`, `agent/session-start`, `agent/pre-step`,
`agent/request`, `agent/request-error`, `agent/turn-stopping`, `agent/error`.
Grep for `session-end|session/destroy|agent/idle|session/close` across all dsh-* + cordis
`.d.ts`/`.js`/`.md`: zero event-name hits.

**The close-time hook is `agent/disposed`** — `dsh-agent/lib/types/runtime-types.d.ts:149-159`:

```ts
/**
 * An agent left the registry; AgentLoop emits this after driver quiescence
 * and scoped-registration unwind, but before session detachment. ...
 * @param payload.agent - the exact agent removed from the registry.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'agent/disposed'(this: Scoped<Agent>, payload: { agent: Agent; }): void;
```

Corroborated by `dsh-agent/README.md:51`: *"agent/disposed always means the exact agent has left
the registry. AgentLoop emits it after its driver is quiescent, while ordered teardown may still
be detaching the session and unwinding [its scope]"*. Emission site:
`dsh-agent/lib/types/index.js:300` — `agentEvents(ctx, agent).emit('agent/disposed', { agent })`
inside the registry remove path (`dsh-agent/lib/index.js:641`).

Related but distinct:
- **`session/disposed`** (dsh-session, not dsh-agent): `dsh-session/lib/types/index.d.ts:54` —
  `'session/disposed'(this: Scoped<Session>, session: Session): void;` emitted by the
  SessionStore (`dsh-session/lib/types/index.js:860-861`, `emitDisposed`). Payload is the bare
  `Session`, not `{agent}`.
- **`session/end-seed`** is NOT a hook — it is a durable event marker written INTO the log
  (`dsh-session/lib/types/index.js:1391`: `if (seed !== undefined && this.log.at(-1)?.type !==
  'session/end-seed') this.append('session/end-seed', {})`). It marks where replayed seed ends
  and live events begin.
- **`agent/status`** flips to `'idle'` when no driver remains scheduled (`runtime-types.d.ts:160-172`)
  — that fires on every turn end, not session end.
- **`agent/turn-stopping`** (`runtime-types.d.ts:284-305`, `@mode serial`, awaited) fires before
  each turn closes — the only *awaited* late-stage hook, but per-turn, not per-session.

**Subscription** — identical shape to session-start; moving-target does it for start in
`src/index.ts:37` (`ctx.on("agent/session-start", ({ agent, source }) => {...})`). The end
equivalent inside `apply(ctx)`:

```ts
ctx.on("agent/disposed", ({ agent }: { agent: any }) => { /* ... */ });
```

**Callback signature**: one payload object `{ agent: Agent }` (emit mode → return value ignored).
Emit is fire-and-forget by construction — `dsh-agent/lib/index.js:335-359` (`agentEvents`):
each listener's return goes through `Promise.resolve(returned).catch(err => ctx.logger.warn(...))`
— **neither sync throws nor promise rejections propagate or are awaited**; both become warnings.
So an async session-end handler runs unjoined. `dsh-scope/lib/invariant.js:11` pins scope
filtering: `"agent/disposed": (args) => args[0]["agent"]` — a listener registered via
`agent.ctx` sees only that agent's disposal; plain-plugin `ctx.on` sees all.

## 2) Exit coverage (Ctrl-C / SIGTERM / crash)

**Graceful-path only, and only via explicit disposal. Nothing wires OS signals in any shipped
package.** Grep for `SIGINT|SIGTERM|process.on|beforeExit|uncaughtException` across every
`.js`/`.ts` under `node_modules/@deepseek-ai/`: the only hit is a doc string in
`dsh-tools/lib/types/presentation.d.ts:162` (a *tool result* field "Signal name that killed the
process (e.g. `SIGTERM`)"). Zero signal handlers.

`agent/disposed` is emitted only from the registry remove/dispose path (`dsh-agent/lib/index.js:641`,
`lib/types/index.js:300`), reached via `handle.dispose()` / `registry remove` / cordis fiber
teardown (`cordis/src/registry.ts:264`: `fiber.dispose()`). dsh-agent README (:47, :53) describes
teardown as ordered: stop loop → await exit → unregister → emit `agent/disposed` → detach session →
unwind scope. Crash (uncaught exception / SIGKILL) skips all of it.

**Could not confirm**: whether the outer DSH binary (the concrete loop package `dsh-agent-loop`
is not in this node_modules, and no harness entry-point JS ships here) installs signal handlers
that trigger graceful fiber disposal on Ctrl-C/SIGTERM. From the evidence available: if the
process dies without running cordis teardown, **no session-end hook fires**. Design the feature
assuming crash = no callback (that is exactly why moving-target reads transcripts from disk
instead of keeping in-memory state).

## 3) Can the handler elicit MODEL TEXT at close time?

**Short answer: not through the agent (its loop is stopped), but the `ctx.llm` service exists and
plugins can call it directly — with one unconfirmed caveat about service liveness at `agent/disposed`
time.**

- **What moving-target actually does — it never calls the LLM itself.** Its "distillation" is
  in-band steering: `/moving-target-bootstrap` (`src/index.ts:69-88`) extracts past first-prompts
  deterministically (`src/extract.ts` — "No LLM involved", header comment), then
  `agent.steer(createUserMessage({...}))` with a prompt asking the *agent* to summarize; the model
  saves the result by calling the registered tool `moving_target_save_summary` (`src/index.ts:117-137`),
  which writes `.moving-target/summary.md` via `src/summary.ts`. Cold-start injection at
  session-start uses `agent.inject(...)` (`src/index.ts:48`). So: **plugin elicits model text =
  steer/inject + tool round-trip, not a plugin-side LLM call.** At `agent/disposed` this path is
  dead — `Agent.dispose()` "stops the loop, awaits its exit" before unregistering
  (`dsh-agent/lib/types/index.d.ts:147-148,157`), and steering after disposal is discarded
  ("cancellation or disposal may discard pending steering", `runtime-types.d.ts` Agent.steer doc).

- **Direct LLM access from a plugin ctx exists**: `dsh-llm/README.md:17-29` documents a `llm`
  cordis service: `ctx.llm.registerAdapter(...)`, and crucially
  **`ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>`** (README:29) —
  "Stream one model call as raw chunks... Consumers assemble the chunks into blocks/messages with
  `BlockAssembler`." `GenerateOptions` (`dsh-llm/lib/types/types.d.ts:332+`): `{ provider, model,
  messages, system?, temperature?, maxTokens?, signal?, sessionId?, purpose? }` where
  `purpose?: 'compaction' | 'session-title'` is explicitly *"Provider-neutral classification for an
  auxiliary model call"* — i.e. DSH itself does non-conversation model calls (compaction,
  session-title) through this same API, so a one-shot summary call at close time is an intended
  shape (`system: "...summarize..."`, `messages: [final user-visible history digest]`,
  `purpose: 'compaction'`). A handler gets it via the service (context accessor; the invariant
  code does `ctx.get('llm')`, `dsh-llm/lib/invariant.js:79`) — and `Agent` even exposes
  `readonly ctx: Context` (`runtime-types.d.ts:69`).

- **Caveats, stated honestly**: (a) `agent/disposed` fires *"after scoped-registration unwind"*
  (`runtime-types.d.ts:150-151`) — the listener table for that agent is unwound, but `llm` is a
  global-service registration in a different fiber; I found no source proving it is still
  resolvable at that instant, and none proving it is not. **Could not confirm from shipped code.**
  (b) emit-mode listeners are not awaited (see §1), so an async `ctx.llm.stream` summary races
  process teardown — nothing joins it. (c) The stream is chunk-level; you must assemble text with
  `BlockAssembler` (exported from dsh-llm, `lib/types/index.d.ts:23`).

**Practical verdict**: model text at close is *possible* via direct `ctx.llm.stream(...)` with
`BlockAssembler`, but it is unawaited, unguaranteed under teardown, and unverifiable-liveness from
these sources. The robust pattern — the one moving-target itself uses — is steering a live agent
(mid-session or at `agent/turn-stopping`, which IS awaited) and reading results back from disk.

## 4) Shelling out with text via stdin/args

**Yes — handlers are ordinary in-process JS with full Node stdlib.** Proof by the plugin itself:
`src/extract.ts:59` `spawnFn("zstd", ["-dc", path])` (`node:child_process` spawn, line 8) streams
decompressed transcript bytes through stdout — text via args + pipe is exactly moving-target's
mechanism for reading DSH logs. A disposed-handler can do the same (`spawn("mybin", [textArg])`,
write stdin, `proc.stdout.on('data', ...)`). Timing caveat from §1/§3 applies: emit listeners are
not awaited, so prefer sync work (`spawnSync`) or a detached child (`unref()`) so the binary
survives teardown.

## 5) Session id in the event / where it's generated

**Yes, the callback carries it.** `Agent.id` is the shared identity:
`runtime-types.d.ts:61-62` — `readonly id: SessionId` ("The single identity shared with session");
the registry enforces `agent.id === agent.session.id` on enter (`dsh-agent/README.md:20`:
"`enter(agent, owner)` enforces `agent.id === agent.session.id`"). So in a handler:
`payload.agent.id` (a branded `SessionId`, `dsh-session/lib/types/types.d.ts:6`:
`export type SessionId = Branded<'SessionId'>`) — same string as the on-disk directory name
(verified in §6).

**Generation**: `dsh-session` accepts the id from the caller — `SessionStore.create(id?:
SessionId, options?)` (`dsh-session/lib/types/index.d.ts:315`), and dsh-agent's
`CreateAgentOptions` carries a caller-supplied `sessionId` ("The persisted session id to load and
use as the live agent/session identity", `dsh-agent/lib/types/index.d.ts:124`; "an ACP-generated
id", :61-62). **Grep found no `randomUUID` anywhere in dsh-session or dsh-agent** (the only
`randomUUID` hits in @deepseek-ai are message ids, approval ids, and a command instance token).
**Could not confirm** which component mints the default UUID — the ACP bridge / concrete loop
packages are not installed here. Observed fact: every on-disk session id is a lowercase UUIDv4
(e.g. `01191c01-e001-4759-ae03-a262aa40d861`).

## 6) Transcripts on disk

**Path**: `~/.dsh/sessions/<projectKey>/<sessionId>/session.jsonl.zstd` (plain
`session.jsonl` also supported). The `<projectKey>` grouping is reproduced in
`moving-target/src/extract.ts:30-48` (`projectKey()`, "Verified byte-identical against the
on-disk layout"): separators (`/ \ :`) collapse to `-`, unsafe chars escape `~XXXX`, wrapped
`--…--`, e.g. `--home-andre-git-dsh-model-router--`. **Format**: JSONL, zstd-compressed,
mode 0600, one session dir (UUID-named) per session. Confirmed real install at `/home/andre/.dsh/`
(sessions, profiles, settings.yaml, enhance-pkgs).

**Sampled real transcript**
(`/home/andre/.dsh/sessions/--home-andre-git-dsh-model-router--/01191c01-e001-4759-ae03-a262aa40d861/session.jsonl.zstd`,
692,928 bytes, decompressed via `zstd -dc`): first line is the header record —

```json
{"type":"session","version":0,"id":"01191c01-e001-4759-ae03-a262aa40d861","createdAt":1787520303588,"cwd":"/home/andre/git/dsh-model-router","parentSession":"session-e7b52682-9cef-4a3e-8ac7-20a090438628","origin":"subagent","delegationDepth":1,"agentPreset":"standard"}
```

then per-event records `{"type":"<event>","seq":N,"time":<ms>,"data":{...}}` — observed types in
this sample: `subagent/descriptor`, `session/end-seed`, `sandbox/mode`, `approval/policy`,
`permission/preset`, `agent/inbox/spliced` (full message content), … `step/end`,
`turn/end` (`{"turn":1,"reason":{"kind":"completed"}}` at seq 41455). Event types are validated by
`dsh-session/lib/invariant.js` (e.g. `case 'session/end-seed': break;`), and the known-type list
matches the `SessionEventMap` declaration string embedded in
`dsh-commands/lib/typert.host.js:426` (`turn/start`, `turn/end`, `user/message`,
`assistant/message`, `tool/call`, `tool/result`, `request/header`, `compaction/*`, `goal/change`,
`session/title`, …). Note `session/end-seed` (seq 1) appears near the top of *every* stored log —
it is the replay-boundary marker (§1), so "session ended cleanly" cannot be inferred from it; the
last record here is an ordinary `turn/end`.

**moving-target's own storage**: one markdown file per workspace cwd —
`<cwd>/.moving-target/summary.md` (`src/summary.ts:14-15`, `SUMMARY_DIR = ".moving-target"`),
format `<!-- moving-target -->` + `bootstrappedAt:`/`sessionCount:` meta lines + blank line +
single ≤2000-char paragraph. Plus a real sample at `/home/andre/git/moving-target/.moving-target/summary.md`.
The sessions root is plugin-configurable (`config.sessionsRoot`, default `~/.dsh/sessions`,
`src/extract.ts:134`). Profiles under `/home/andre/.dsh/profiles/` additionally hold
`session_projcache.json` / `session_projcache/` (per-profile projection cache; not sampled further).

## 7) Bottom line for a session-end summarizer

- Hook: `ctx.on("agent/disposed", ({ agent }) => …)` — payload `{ agent }`, `agent.id` = session id,
  `agent.session.header.cwd` available (moving-target relies on `agent.session.header` at
  session-start, `src/index.ts:38`). Emit mode: **not awaited, errors swallowed to warnings.**
- Coverage: graceful disposal only; no signal wiring found in any @deepseek-ai package — assume
  no fire on crash/SIGKILL; SIGINT/SIGTERM behavior depends on the (not-installed-here) outer
  binary. **Unconfirmed.**
- Model text at close: only via direct `ctx.llm.stream(GenerateOptions)` + `BlockAssembler`
  (auxiliary-call `purpose: 'compaction' | 'session-title'` exists for exactly this shape);
  steering the agent is impossible post-dispose. Unawaited → racy; prefer doing summarization on
  the awaited `agent/turn-stopping` hook or reading the transcript from `~/.dsh/sessions/...`
  afterwards (moving-target's own crash-proof pattern).
- Shelling out: yes (plugin itself spawns `zstd`); use `spawnSync`/detached child at dispose time.

---

# Part 4 — Hermes

Verified against the live install `/home/andre/.hermes/hermes-agent/` — **hermes-agent 0.21.1,
upstream c076d653** (`hermes --version`, checked 2026-09-08). All line numbers below were read
from that install on this machine today. Prior session-START coverage: research/02 Part 1.

## 1) Session-end hooks: names, registration, signatures

Three end-side plugin hooks in `VALID_HOOKS` (`hermes_cli/plugins.py:125-126`):
`on_session_end`, `on_session_finalize`, `on_session_reset`. Registered from a plugin's
`register(ctx)` via `ctx.register_hook("<name>", cb)` — same API as `on_session_start`.

| Hook | Fires | Kwargs (from `hermes_cli/hooks.py:120-134` sample payloads + firing sites) |
|---|---|---|
| `on_session_end` | **per turn end** (despite the name) | `session_id, task_id, turn_id, completed: bool, failed: bool, interrupted: bool, turn_exit_reason, model, platform` — fired in `agent/turn_finalizer.py:625-634`; interrupted turns get a best-effort emission from `cli.py:865-872` (`_invoke_interrupted_session_end`, `completed=False, interrupted=True, reason="keyboard_interrupt"`) |
| `on_session_finalize` | **real session close**: process exit, `/new`, `/reset` | `session_id, platform, reason` where reason is `"shutdown"` (`cli.py:828` via `_run_cleanup`, and `cli.py:904`) or `"new_session"`/`"session_boundary"` (`hermes_cli/cli_session_mixin.py:436-450, :510, :589`) |
| `on_session_reset` | `/new` + `/reset` boundary | same shape as finalize with `reason:"new_session"` |

`lifecycle.finalize_session(**kwargs)` (`hermes_cli/lifecycle.py:48-66`) = observe
`on_session_finalize` **and** hard-close the Relay conversation, then run plugin hooks.
Return values are ignored (observers).

## 2) Exit coverage

`_run_cleanup` is "atexit-registered + invoked on the normal / EOF / interrupt exit paths"
and the docstring is explicit (`cli.py:1001-1003`): "this covers normal quit, Ctrl+C and
SIGTERM/SIGHUP. ``kill -9`` is uncatchable, and the kanban worker's ``os._exit(0)`` path
bypasses ``atexit``; neither runs this". SIGTERM/SIGHUP install handlers that route to
`agent.interrupt()` → `app.exit()`/`KeyboardInterrupt` → `finally` → `_run_cleanup`
(`cli.py:733-735`, handlers at `cli.py:3577-3608`).

- Covered: normal quit, EOF, Ctrl-C, SIGTERM, SIGHUP.
- NOT covered: SIGKILL, hard crashes (uncaught native errors / power loss), and any path
  calling `os._exit` (kanban worker hard-exit is named in the source comment).
- `on_session_finalize`/`on_session_reset` are **intentionally unbounded** —
  "last-chance flush — abandon can lose state" (`hermes_cli/plugins_dispatch.py:27-28`):
  they run synchronously to completion at close. `on_session_end` (per-turn) IS in the
  timeout-bounded fail-open set (`plugins_dispatch.py:43-49`).

## 3) Can the close hook elicit model text? — YES (critical answer)

Plugins get a host-owned LLM facade: **`ctx.llm.complete(...)` /
`ctx.llm.complete_structured(...)`** (`agent/plugin_llm.py:446` and `:460`; signature takes
`messages, temperature, max_tokens, timeout, agent_id, profile, provider, model, task`).
"the host owns routing, auth, timeouts and fallback, so the plugin never sees raw tokens"
(module docstring). Nothing restricts which hooks may call it — an `on_session_finalize`
callback can run a summarisation LLM call, and since finalize hooks are unbounded, a slow
model call will not be abandoned by the hook-timeout mechanism. Both finalize and the LLM
facade are sync; `complete` also has async siblings. A summary written this way is real
model text at close time.

## 4) Shell out with text

Yes — plugins are in-process Python with full stdlib: `subprocess.run([...], input=text)`
in any hook callback (same conclusion as research/02 Q5; nothing end-specific changes it).

## 5) Session id

Payload kwargs include `session_id` on all three hooks. Id format and origin:
`hermes_cli/cli_session_mixin.py:530` (and `cli.py:2825` for resume):
`self.session_id = f"{self.session_start.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"`
— i.e. `<YYYYMMDD_HHMMSS>_<6-hex>`, generated per session by the CLI at session start.

## 6) Transcripts on disk (derive-later path)

- Primary store: SQLite `state.db`, table `messages`
  (`hermes_state_messages.py:21`, `INSERT INTO messages (session_id, role, content, ...)`;
  live DB has `messages`, `messages_fts*` tables).
- JSONL mirror: `$HERMES_HOME/sessions/<session_id>.jsonl` — append-path
  `hermes_state.py:297-305` ("Append pending messages to HERMES_HOME/sessions/<id>.jsonl");
  live sample read at `~/.hermes/sessions/20260908_083336_fc6cb56b.jsonl`: one JSON object
  per line, `{"role", "content", "timestamp", "display_metadata", "message_id"}`.
- Multi-profile: each profile's hermes home has its own `sessions/` dir
  (`~/.hermes/profiles/<profile>/sessions/`); the default profile's is `~/.hermes/sessions/`.

## 7) Version

hermes-agent **0.21.1** (2026.9.7), upstream c076d653 — `hermes --version` on 2026-09-08.

---

# Part 5 — pi

Verified against the live install `/home/andre/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/`
— **v0.73.1** (`package.json` `"version"`, checked 2026-09-08). Prior session-START coverage:
research/02 Part 2 (session_start `reason` enum). The symmetric end event exists.

## 1) End event: `session_shutdown`

`docs/extensions.md:452-461`:

```typescript
pi.on("session_shutdown", async (event, ctx) => {
  // event.reason - "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionFile - destination session for session replacement flows
});
```

"Fired before an extension runtime is torn down." It is the mirror of `session_start`:
emitted on quit (`reason:"quit"`), and after /new, /resume, /fork the OLD instance gets
`session_shutdown` then the new one gets `session_start` with the matching reason
(`docs/extensions.md:308-334` lifecycle diagram, :388, :405). Also emitted by
`ctx.shutdown()` — "Emits `session_shutdown` event to all extensions before exiting"
(`docs/extensions.md:921`).

## 2) Exit coverage (from dist source, quoted paths)

- **Graceful quit / SIGTERM**: interactive mode registers handlers for `["SIGTERM", "SIGHUP"]`
  (`dist/modes/interactive/interactive-mode.js:2659-2666`); the SIGTERM path calls
  `shutdown()` (:2669) which runs `await this.runtimeHost.dispose()` (where extension
  teardown and `session_shutdown` happen) then `process.exit(0)` (:2629-2640). Print mode
  and RPC mode have their own SIGTERM handlers (`dist/modes/print-mode.js:29`,
  `dist/modes/rpc/rpc-mode.js:266`). Ctrl-C at idle routes through `shutdown()` too
  (`:2612`, `:2621`).
- **Ctrl-C mid-turn**: aborts the agent turn (abort signal), the process stays alive —
  no `session_shutdown`, and correctly so (session not over). SIGINT is even explicitly
  ignored while suspended (`:2700-2707`).
- **NOT covered — SIGHUP**: the handler calls `emergencyTerminalExit()` which exits 129
  and deliberately skips normal shutdown: "The terminal is gone. Do not run normal
  shutdown..." (`:2641-2651`). No `session_shutdown` fires.
- **NOT covered — SIGKILL, hard crash, power loss**: no handler can run; nothing fires.
  (Not probed live; code-path conclusion from the quoted source.)

## 3) Can the extension elicit model text at close time? — YES

Two routes, both real:

- **In-process LLM call**: extensions import `complete` from `@mariozechner/pi-ai`
  (`examples/extensions/custom-compaction.ts:16`) and resolve a model via
  `ctx.modelRegistry.find("<provider>", "<model>")` (`docs/extensions.md:1514` example).
  `session_shutdown` handlers are async and awaited during teardown ("before an extension
  runtime is torn down"), so a summarisation call can complete before exit.
- **Subprocess**: spawn `pi -p "<summarise this transcript>"` (print mode exists as
  `docs/rpc.md`/README non-interactive mode; `ctx.hasUI` false there, `docs:862`) —
  heavier, but needs no in-process API keys.

## 4) Shell out with text

Yes — extensions are Node >= 20.6 TS running "with your full system permissions"
(`docs/extensions.md`, Extension Locations security note; research/02 Q5); `node:child_process`
with stdin/args as needed.

## 5) Session id

The session id is the UUID (v7-shaped in live samples) in the session file header AND the
session filename. The `session_shutdown` payload itself documents only `reason` +
`targetSessionFile` — I did not find a documented `sessionID` field on the event; an
extension gets the id from `ctx.sessionManager` / the current session file path instead.
(Checked docs/extensions.md session_shutdown section and the lifecycle diagram; not found
elsewhere.)

## 6) Transcripts on disk (derive-later path)

`~/.pi/agent/sessions/<munged-cwd-path>/<ISO-timestamp>_<uuid>.jsonl` — JSONL, one entry
per line; first line is the header. Live sample read 2026-09-08
(`~/.pi/agent/sessions/--home-andre--/2026-09-08T18-21-24-028Z_01a08240-....jsonl`):

```
{"type":"session","version":3,"id":"01a08240-dcbb-70ca-bd05-c69db2f6a523","timestamp":"2026-09-08T18:21:24.028Z","cwd":"/home/andre"}
{"type":"model_change","id":"675d7e97","parentId":null,"timestamp":"...","provider":"spark-local","modelId":"Spark-X2.5-4B"}
```

Sessions are removed by deleting their `.jsonl` files (docs/sessions.md path quoted in
dist docs: `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`).

## 7) Version

**0.73.1** — `package.json` `"version"`, matches `lastChangelogVersion` in the live
`~/.pi/agent/settings.json`.
