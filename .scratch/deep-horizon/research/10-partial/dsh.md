# DSH Session-End Hook Surface — live evidence

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
