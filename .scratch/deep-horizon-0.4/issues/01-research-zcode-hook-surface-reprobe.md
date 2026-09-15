# Research: ZCode hook surface re-probe

Type: research
Status: closed (resolved 2026-09-14, see research/01-zcode-hook-surface-reprobe.md)
Blocked by: —

## Question

The zcode adapter's every "PROVEN" claim was probed against ZCode
**3.11.2-22** (`adapters/zcode/session-start`, `adapters/zcode/pre-execute`
headers; bundle at
`/home/andre/.npm-global/lib/node_modules/zcode-app-cli/vendor/zcode.cjs`).
What is true of the **currently installed** version? Enumerate, with bundle
line evidence:

1. Version now installed (`zcode --version` / package.json).
2. The full hook **event list** and per-event payload schemas — SessionStart
   (and its `source` values), PreToolUse, Stop, and **any close/end event**
   (SessionEnd, SessionClose, Teardown…). Does a session-close hook exist
   now? Does Stop still fire every turn, and can a Stop hook steer
   (`decision: block`)?
3. SessionStart firing semantics across **app instances**: the analysis saw
   two `bootstrap.app.startup` events 0.8 s apart both fire the hook for one
   session id (F7). Does every app instance fire `startup` for the same
   sessionId? Does `resume` reliably fire, and does a resumed session replay
   `additionalContext` from history or drop it (F4)?
4. Whether `additionalContext` output ever reaches the persisted session
   history (message table / rollout), or is genuinely ephemeral (F4).
5. Config surfaces for hooks: global `~/.zcode/cli/config.json`, project
   `.zcode/config.json`, the trust mechanism that blocked project hooks
   (11 `config.project_hooks.pending_trust` warnings), and whether an
   external installer can write the global config safely (precedent in the
   bundle or docs?).
6. Env vars exported to hook processes: `ZCODE_SESSION_ID`,
   `ZCODE_PROJECT_DIR` — still exported, still populated at SessionStart and
   PreToolUse?

## Why it matters

Three grilling tickets (03, 04, 10) hang off this: the zcode close mechanism
depends on whether a close hook exists; the re-injection/dedup semantics
depend on instance/startup behavior; the install wiring depends on the config
surface and trust model. F3 (param trigger merged but never wired) is also a
deployment fact this ticket contextualizes.

## Resolution

Full evidence in [research/01-zcode-hook-surface-reprobe.md](../research/01-zcode-hook-surface-reprobe.md). Gist:

1. **Installed version is unchanged**: zcode-app-cli 3.11.2-22, runtime
   0.16.5, bundle mtime Sep 10 — the very bundle the Sep-13 probes used. The
   re-probe therefore yields additions, not drift corrections.
2. **Still no session-close hook** (7-event enum is exhaustive), **but Stop
   steering works**: `{"decision":"block","reason":...}` on Stop re-prompts
   with the reason as context (`stopHookActive`, cap 3/turn) — ticket 03 has
   an enforcement point the retired stop-steer probe predates.
3. **Per-instance semantics pinned**: `sessionStartHookRan` latch = once per
   app instance; the `session_start_hooks` span fires every turn but the hook
   doesn't; F7 re-confirmed live (142-byte double-seed marker, two boots
   0.78 s apart, 54 app boots today). Resume fires `source:"resume"` and the
   config matcher `"startup|resume"` spelling is available for
   restart-re-injection.
4. **F4 confirmed on current db**: 0 `hook_context` rows in message (15208)
   and session_entry tables; injections are instance-ephemeral by mechanism
   (in-memory `messageHistory` only).
5. **Installer**: global `~/.zcode/cli/config.json` needs no trust and is
   writable (shipped `config.example.json` documents the hooks block;
   `config.file.invalid` = malformed file fails to load, so write
   schema-valid JSON + backup). Project `.zcode/config.json` hooks need
   workspace trust (`~/.zcode/security/workspace-hook-trust-v1.json`, grants
   keyed by declaration digest + bundle digest) and grants go stale on any
   later edit — horizon-line's own project hook has been `pending_trust`
   since the Sep-11 stop-steer retirement edit. Declaring the hook in both
   surfaces double-fires once trusted (`insertWorkspaceHooks` doesn't dedup).
6. **Env vars confirmed** for every hook event: `ZCODE_SESSION_ID`,
   `ZCODE_PROJECT_DIR` (+ `CLAUDE_*` aliases) set from the payload in
   `hft()`; hook cwd = payload cwd || working directory; defaults timeout
   60 s / 32 KB output still hold. One header correction: the output schema
   is not visibly `.strict()` (unknown keys appear stripped, not fatal);
   emitting exactly one key remains the safe envelope.
