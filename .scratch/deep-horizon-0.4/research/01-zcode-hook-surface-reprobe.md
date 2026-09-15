# Research: ZCode hook surface re-probe (ticket 01)

Date: 2026-09-14. Method: live evidence only — the installed vendor bundle
(`grep -o` over minified identifiers, annotated function names quoted
verbatim), `~/.zcode/cli/log/zcode-*.jsonl` telemetry, `~/.zcode/cli/db/db.sqlite`,
the live configs, and the `/tmp` adapter markers. Every claim cites its source.
"Bundle" below = `/home/andre/.npm-global/lib/node_modules/zcode-app-cli/vendor/zcode.cjs`.

## 1. Installed version — UNCHANGED, it is the probed version

- `zcode --version` → `zcode-app-cli 3.11.2-22` / `zcode-runtime 0.16.5`;
  `package.json` `"version": "3.11.2-22"`
  (`/home/andre/.npm-global/lib/node_modules/zcode-app-cli/package.json`).
- `vendor/extraction.json`: `"cliVersion": "0.16.5"`, `"appVersion": "3.11.2"`,
  `extractedAt: "2026-09-07T15:55:02Z"`, sha512 matches
  `zcode-runtime.lock.json` (ZCode-3.11.2-linux-x64.deb).
- `vendor/zcode.cjs` mtime **Sep 10 09:14** — the file predates the Sep-13
  live probes and has not changed since. **Every "PROVEN" adapter claim was
  proven against the byte-identical bundle that is installed right now.**
  Nothing regressed; the re-probe question becomes "what did the probes miss",
  and the answers below are additions, not corrections of drift.

## 2. Hook event list, payload schemas, Stop steering

**Event list (exhaustive, 7 events — no close/end event):**
`["SessionStart","UserPromptSubmit","PreToolUse","PermissionRequest","PostToolUse","PostToolUseFailure","Stop"]`
— appears as a zod enum in at least four independent schema definitions in the
bundle (e.g. `vRn=E.enum([...])`, `wRn=f.enum([...])`, `D_r=["SessionStart",...]`,
and the `on={SessionStart:"SessionStart",...}` name map). The config schema's
`events` object has exactly these seven keys.

- **No session-close hook.** `SessionEnd` occurs in the bundle only as the
  internal event-enum entry `SessionEnded:"session_ended"` mapped to the
  telemetry record kind `"session-closed"` (`case V.SessionEnded:return{...kind:"session-closed"}`)
  — not a hook. `Teardown` occurs once, as an internal `wireTeardown` function
  label. `SessionClose`/`PostSession`: 0 hits.
- **Stop fires per assistant turn in the main turn loop.** The turn state
  machine calls `this.runStopHooks(e.modelResponse,e.toolCallCount,...)` at the
  no-tool-calls completion step and returns `"continue"` or `"break"` from the
  same block that ends the turn (`finishModelStepWithoutToolCalls` module,
  `X7r` bundle module). A second call site covers the detached path
  (`async function O7r(e){...await this.runStopHooks(e.modelResponse,...)}`).
- **Stop CAN steer.** Output schema (`k3t`, parsed by `jni` = the annotated
  `parseHookStdout`) accepts: `additionalContext`, `additional_context`
  (snake_case alias), `continue`, `decision` (`enum(["approve","block"])`),
  `hookSpecificOutput` (per-event union `SRn`), `reason`, `stopReason`,
  `suppressOutput`, `systemMessage`. Processing (`processHookOutput`, `zNr`):
  - `e===on.Stop && t.continue===!0` → `stopShouldContinue=!0`;
  - `t.decision==="block"` with `e===on.Stop` → `stopShouldContinue=!0` AND
    `t.systemMessage`/`t.reason` are pushed into `additionalContexts`.
  Continuation gate (`shouldContinueAfterStopHooks`, `R7r`):
  `stopShouldContinue===!0 && additionalContexts.length>0 && count<3`
  (`Idi=3`). On steer, the contexts are injected via
  `injectHookAdditionalContextIntoMessageHistory` (`A7r`:
  `Js("hook_context",Edi(...))` → `messageHistory.addEntries`) into the next
  request, the counter increments, and subsequent Stop fires carry
  `stopHookActive=true` (payload field, mirrors Claude Code's
  `stop_hook_active`). **So the retired stop-steer probe understates the
  current surface: `{"decision":"block","reason":"..."}` is a working steer,
  capped at 3 per turn.**
- **Stop payload** (`E7r`): `agentName, cwd, hookEventName, mode,
  responsePreview` (response truncated at 4000 chars, `Cdi=4e3`,
  `truncateForHook`), `responseText, sessionId, stopHookActive, timestamp,
  toolCallCount, traceId, turnId`.
- **SessionStart payload** (`T7r` call): `agentName, cwd, hookEventName, mode,
  model, sessionId, source, timestamp, traceId, turnId` — unchanged from the
  adapter header; still no subagent/parent discriminator.
- **PreToolUse payload**: adds `riskLevel, sideEffectScope, toolCallId,
  toolInput, toolName` (camelCase; the adapter's `.toolInput // .tool_input`
  read is fine — the alias path exists in schema-land but the payload is
  camelCase).
- **parseHookStdout behavior** unchanged: `function jni(e,t){let r=e.trim();
  if(!r||!r.startsWith("{"))return; ... k3t.safeParse(n); if(!o.success) throw
  Ie(ge.ToolExecutionFailed,"Hook stdout failed HookJSONOutput schema
  validation",...)}` — non-`{` output ignored, malformed JSON ignored, schema
  failure = recoverable ToolExecutionFailed. Exit codes (`WNr`): exit 0 →
  parse stdout; **exit 2 → deny block** (`Fni` builds
  `permissionDecision:"deny"` / `behavior:"deny"`); any other non-zero →
  output discarded. Defaults: timeout `KRo=6e4`, `maxOutputBytes JRo=32768`.
- **Schema-strictness caveat on the adapter headers:** the top-level output
  schema `k3t=E.object({...})` has **no `.strict()`** (the closing paren is
  immediately followed by the next definition; zod default strips unknown
  keys — the explicit `.strict()` calls elsewhere in the bundle show
  strictness is opt-in). The header's "any extra key marks the run failed" is
  therefore questionable as stated; emitting exactly one key remains correct
  and safe under both readings. `hookSpecificOutput` carries a per-event
  `hookEventName` literal and mismatches throw "Hook returned wrong event
  name".

## 3. SessionStart firing semantics across app instances (F7)

- **Once per app instance, not once per session.** `runSessionStartHooks`
  (`T7r`): `return this.sessionStartHookRan || (await
  this.workspaceHookAdmission?.activate(e,r), this.sessionStartHookRan=!0,
  !this.hookRunner) ? BAe : this.hookRunner.run({...source:e...})`. The latch
  is initialized `sessionStartHookRan=!1` in the session-manager constructor
  and never reset (3 bundle occurrences: init, set-true, read). Each app
  instance constructs its own session-manager for the (same) session id, so
  **every app instance fires `startup` once for that session.**
- **The `session_start_hooks` phase span is emitted EVERY turn** (338 spans in
  today's log, same count as `user_prompt_hooks`; seen at `turnNumber` 24-41
  for one session) — the latch is what makes the hook run only on the first.
  So the span proves nothing about hook execution; durations do (~300 ms =
  spawn, 0 ms = latched or no runner).
- **F7 re-confirmed with live artifacts:** the two app boots
  (`bootstrap.app.startup.started` 04:53:12.248Z and 04:53:13.028Z) each left
  one seed pair in `/tmp/horizon-zcode-sess_15c584a4-95e7-4d42-97e1-a4166e3dc632`
  (142 bytes = `d <dir>` + `s <store>` twice; every single-instance session's
  marker today is 77 bytes = one pair). Both boots also each logged a
  `config.project_hooks.pending_trust` warning for horizon-line at
  04:53:12.240Z / 04:53:13.028Z. 54 `bootstrap.app.startup.started` events
  today — multi-instance is the norm on this machine, so per-instance
  re-injection is the steady-state behavior the dedup must be designed for.
- **Resume:** `runSessionStartHooks` has exactly two call sites:
  `"startup"` (context initialization) and `"resume"` (right after the
  `SessionResumed` event is appended). No "clear"/"compact" sources exist in
  this build (confirmed: only two call sites bundle-wide). The config
  `matcher` is matched against that source (`$Nr`:
  `t.split("|").includes(e)` for plain tokens, else regex) — so the adapters'
  `"startup"` matcher correctly skips resume, and **`"startup|resume"` is the
  supported spelling for "every fresh app-instance opening"** — which, given
  the non-persistence below, is the semantically correct trigger for
  re-injection after a restart.
- **Subagents:** `sess_subagent_agent_*` sessions (40+ today, `agentType`,
  `parentSessionId` in the span context) do pass through the
  `session_start_hooks` phase at turnNumber 0 — but with `durationMs: 0`, and
  no `/tmp/horizon-zcode-sess_subagent_*` marker exists, while the parent's
  own runs seeded ~300 ms spans. So subagent sessions do **not** effectively
  execute the hook today (most likely their session config carries no
  `hooks`/`workspaceHookSnapshot`, so `R0i` builds no hookRunner; which of the
  two gates fails is UNVERIFIED). Upgrades the session-start header's
  "UNPROVEN whether subagent children run SessionStart at all" to: the phase
  runs, no execution observed in ~40 subagent sessions.

## 4. additionalContext persistence (F4) — confirmed ephemeral

- `message` table (`~/.zcode/cli/db/db.sqlite`): `id, session_id,
  time_created, time_updated, data(json), sequence`; 15208 rows.
  `data LIKE '%hook_context%'` → **0 rows**. `session_entry` table →
  **0 rows** for `hook_context`.
- The only `data LIKE '%This project is about:%'` hit (1 row) is a
  **user-role message in sess_8ca1f7aa** quoting the plugin changelog
  ("horizon-inject prepends \"This project is about: …\" to the injected
  text") — a conversation about the plugin, not an injection.
- Mechanism matches: `injectHookAdditionalContextIntoMessageHistory` adds the
  entry to the **in-memory** `messageHistory` only; nothing writes
  `hook_context` to the DB. A new app instance (or resume) starts from the
  persisted history without the injection. **F4 stands on the current
  version: injections live exactly as long as the app instance does.**

## 5. Config surfaces, trust mechanism, installer safety

**Surfaces (both live on this machine):**
- Global: `~/.zcode/cli/config.json` (bundle constants `T_r="~/.zcode/cli"`,
  `I_r="config.json"`; `userConfigPath ?? join(t,".zcode","cli","config.json")`).
  Currently carries deep-horizon: `hooks.enabled:true`, SessionStart matcher
  `"startup"` → `session-start` (enabled), Stop → retired `stop-steer`
  (**enabled:false** — F1's "Stop hook disabled"), no PreToolUse (F3
  unchanged).
- Project: per-directory discovery of **both `zcode.json` and
  `.zcode/config.json`** (`[(0,bl.join)(t,"zcode.json"),(0,bl.join)(t,".zcode","config.json")]`),
  `configFileKind` enum `["zcode.json",".zcode/config.json","explicit"]`.
  `/home/andre/git/horizon-line/.zcode/config.json` declares the same
  SessionStart hook; moneytracker's has an empty `events:{}`.
- Schema (`IRn`/`TRn`/`CRn`/`q1` + `hooksRoot`): each entry is
  `{matcher?, hooks:[{type:"command"|"process", command, enabled?, args?|
  async?/shell?, timeoutMs?, statusMessage?}]}`; the shipped
  `config.example.json` (lines 118-135) documents the whole `hooks` block —
  **that file is the official precedent for an external writer.**
- **Merge:** `createConfiguredHookRunner` (`NCe`) registers user-config hooks
  (gated on user `hooks.enabled`) **plus** workspace-snapshot hooks
  (`$ni`/`insertWorkspaceHooks` `Vni`) — `Vni` only *orders* (project hooks
  inserted before non-user entries of the same event), **no dedup by
  command**. Today the two sources don't collide only because the project one
  is trust-blocked (below). Hazard for ticket 10: if a project that also
  declares the hook is ever trusted, **every fire runs the hook twice**
  (double injection in one context).

**Trust mechanism (workspace/project hooks only; global needs none):**
- Project hooks start `pending_trust` and **"remain blocked"** until granted:
  warning `config.project_hooks.pending_trust` (module `adapters.config`,
  `configScope:"project"`, `diagnosticMessage: "Project hooks are pending
  workspace trust and remain blocked"`). 203 warnings across Sep 10-14 logs;
  32 today (15 horizon-line, 17 moneytracker).
- Grants persist in **`/home/andre/.zcode/security/workspace-hook-trust-v1.json`**
  (`schemaVersion:1`, `records[]`): per grant `{workspaceIdentity:
  "/home/andre/git/horizon-line", hookDeclarationDigest: sha256,
  bundleDigestAtGrant, decision:"trusted", grantedAt, eventAtGrant,
  displayCommandAtGrant, sourcePathAtGrant:".zcode/config.json",
  matcherAtGrant, matcherIndexAtGrant, hookIndexAtGrant,
  appVersionAtGrant:"0.16.5"}`. horizon-line has two grants (SessionStart +
  the since-retired Stop/stop-steer), granted 2026-09-11T22:00:15/17Z.
- **Grants go stale when the file changes after granting.** Both configs were
  rewritten *after* the grants (mtimes: global 2026-09-11 15:09:27 -0700 =
  22:09Z, project 15:17:05 -0700 = 22:17Z) — the stop-steer retirement edit —
  and horizon-line's project hook has been back to `pending_trust` ever since
  (warnings fire at every app boot in that workspace, including both F7
  boots). The declaration digest covers `sourceRelativePath,
  sourceDiscoveryOrder, event, matcher, matcherIndex, hookIndex, hook,
  resolvedTimeoutMs, resolvedMaxOutputBytes` (`s5o`/`Fot`), and admission is
  re-checked per dispatch against the snapshot (`evaluateDispatch`,
  `workspace_hooks_snapshot_mismatch` / trust states including
  `stale_digest`, reason `workspace_hooks_bundle_changed`).
- **Why exactly one hook run per instance today:** the user-config hook
  dispatches (no trust needed for `configScope:"user"` — no pending warning
  ever cites the global file), the project duplicate is blocked. F7's two
  seeds = two instances x the single active (global) hook.
- **Installer safety (global write):** YES with care —
  - precedent: the shipped `config.example.json` documents the exact hooks
    block; this machine's own history is three hand edits with `.bak` copies
    (`config.json.bak-pre-horizon-20260911`, `.bak-manual`,
    `.bak-20260910-firecrawl-mcp`);
  - the app itself read-modify-writes these files through its settings writer
    (`hbt`: scope `workspace` → `.zcode/config.json`, any other scope →
    `sources.user.path`, under a write lock `D3i`), so concurrent-write is a
    solved problem only for the app, not for us — an installer should do its
    own locked read-merge-atomic-write + backup;
  - **validation is real:** an unparseable/invalid config source fails with
    `config.file.invalid` ("Config file failed to load", `h5o`/`g5o`) — a
    malformed hooks block risks the whole file being rejected, so the
    installer must emit schema-valid JSON (the example file is the template).
  - No CLI merge command for hooks exists in this build (`zcode --help`
    global options in `extraction.json` have none; settings UI writes target
    the same files). UNVERIFIED whether the TUI settings screen can edit
    global hooks; its workspace-hook toggle code paths target the project
    file.

## 6. Env vars exported to hook processes — confirmed, expanded

The hook runner builds hook env via `hft(e,t,r)`:
```
{ CLAUDE_CODE_SESSION_ID: t.sessionId, CLAUDE_PROJECT_DIR: t.cwd||r,
  CLAUDE_SESSION_ID: t.sessionId, ZCODE_PROJECT_DIR: t.cwd||r,
  ZCODE_SESSION_ID: t.sessionId }
```
— applied to **every** hook event's spawn (`ZNr`: `env:hft(...)`,
`cwd:s.cwd||e.getWorkingDirectory()`, stdin payload, `timeoutMs`,
`outputLimit.maxBufferBytes=maxOutputBytes`). So:
- `ZCODE_SESSION_ID` = payload sessionId, `ZCODE_PROJECT_DIR` = payload cwd ||
  working directory — both populated at SessionStart and PreToolUse alike
  (single generic runner). Adapter claims hold; `ZCODE_PROJECT_DIR` mirrors
  the stdin `cwd` exactly as the session-start header assumes.
- Bonus: `CLAUDE_SESSION_ID`/`CLAUDE_PROJECT_DIR`/`CLAUDE_CODE_SESSION_ID`
  aliases are exported too (relevant to F6's "no env detection" — the CLI
  could detect either spelling), and plugin spawns additionally get
  `ZCODE_PLUGIN_*`.

## Consequences for tickets 03 / 04 / 10

- **Ticket 03 (close mechanism):** there is still no close hook in runtime
  0.16.5 — but Stop is now a *working* steer point (`{"decision":"block",
  "reason":...}` re-prompts with the reason as context, `stopHookActive`,
  cap 3/turn), so a close-nag that must actually re-prompt (not just ride
  startup text) has a supported mechanism the retired stop-steer probe
  predates; it stays per-turn, so the trigger problem (detecting
  "wrapping up") is unchanged.
- **Ticket 04 (dedup / re-injection):** hooks run once per app *instance*
  (latch), never persisted (`hook_context` absent from db), resume fires
  `source:"resume"` — so the right dedup key is (session id + app instance or
  a boot-monotonic token), the right trigger set is matcher
  `"startup|resume"` (re-inject after restart is *desired*), and the F7
  double-seed (142-byte marker, two boot warnings 0.78 s apart) is the live
  repro any design must survive.
- **Ticket 10 (install wiring):** global `~/.zcode/cli/config.json` is
  installer-writable without any trust step (shipped `config.example.json`
  documents the shape; local `.bak` convention; `config.file.invalid` is the
  risk if JSON is malformed), project `.zcode/config.json` hooks buy a trust
  prompt whose grants die on any later file edit (horizon-line's own hook has
  been pending_trust since the Sep-11 stop-steer retirement edit) — and
  declaring the hook in *both* surfaces double-fires once the project one is
  trusted (`Vni` does not dedup), so pick exactly one surface per machine.
