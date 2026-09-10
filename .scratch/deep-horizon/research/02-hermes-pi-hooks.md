# Research: Hermes + pi session-start injection surfaces

Type: research (HL-02)
Status: done
Method: read the live installs. Every claim below cites a file path or doc path that was
actually read on this machine on 2026-09-08. Nothing is inferred from a sibling harness.

Sources read:

- Hermes live install: `/home/andre/.hermes/hermes-agent/` (hermes-agent 0.21.1, upstream c076d653)
- Hermes docs (vendored in install, mirror of https://claude-code.nousresearch.com/docs):
  `website/docs/developer-guide/plugins/index.md`, `website/docs/user-guide/features/hooks.md`,
  `plugins/AGENTS.md`
- pi live install: `/home/andre/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/`
  (`package.json`, `README.md`, `docs/extensions.md`, `examples/extensions/`)
- pi user config: `/home/andre/.pi/agent/settings.json`, working extension at
  `/home/andre/.pi/agent/git/github.com/badlogic/pi-telegram/index.ts`

---

## Part 1 — Hermes

### 1. Hook/plugin name + config surface

**Mechanism: Hermes plugin hooks** (Python). Three relevant surfaces, all registered from a
plugin's `register(ctx)` function:

- `ctx.register_hook("on_session_start", cb)` — lifecycle observer
  (`hermes_cli/plugins.py:893`; docs `website/docs/user-guide/features/hooks.md:886`)
- `ctx.register_system_prompt_section(id, content_or_callable, position=..., max_chars=...)` —
  bounded text frozen into the system prompt (`hermes_cli/plugins.py:917`)
- `ctx.register_hook("pre_llm_call", cb)` — per-turn context injection, return value consumed
  (`website/docs/user-guide/features/hooks.md`, pre_llm_call row)

Config surface (from `plugins/AGENTS.md` "Plugin kinds and their discovery systems" table):

| Location | Notes |
|---|---|
| `plugins/<name>/` | in-tree, bundled |
| `~/.hermes/plugins/` | user-global |
| `./.hermes/plugins/` | project-local, opt-in via `HERMES_ENABLE_PROJECT_PLUGINS` |
| pip entry points, group `hermes_agent.plugins` | package distribution |

A directory plugin needs a `plugin.yaml` manifest (`hermes_cli/plugins.py:6`,
`hermes_cli/plugins_manifest.py`). Enable with `hermes plugins enable <name>`; per-plugin
grants live under `plugins.entries.<name>` in `config.yaml`. Discovery runs via
`PluginManager.discover_and_load` (`hermes_cli/plugins.py:1202`).

### 2. Where injected text lands; does the model see it?

- **`on_session_start` return value is IGNORED** — it is an observer. Signature:
  `cb(session_id: str, model: str, platform: str)`. Source: `agent/conversation_loop.py:730-738`
  fires it via `hermes_cli.lifecycle.invoke_hook`; docs table marks it "Observer ... return
  ignored". So on_session_start alone cannot inject text. It is for setup (e.g. prime state,
  register a prompt section dynamically is NOT possible here — sections register at plugin load).
- **`register_system_prompt_section`** — the real "session-start text" mechanism. Content
  (string, or callable receiving a read-only session-info mapping) is rendered once for a new
  session, frozen on the agent, and persisted verbatim into the stored system prompt
  (`agent/system_prompt.py:112-166`). Position: `"after_memory"` is the only valid position
  (`hermes_cli/plugins_dispatch.py:56`). Cap: default and max 4,000 chars
  (`hermes_cli/plugins_dispatch.py:57-58`). The model sees it every turn, on every surface.
- **`pre_llm_call`** — return `{"context": "..."}` or a plain string; Hermes appends it to the
  CURRENT turn's user message. Ephemeral: not persisted, history not mutated, system prompt
  untouched (deliberate, for prompt-cache preservation —
  `website/docs/developer-guide/plugins/index.md` "How injection works"). Oversized returns
  (>10,000 chars default) are spilled to `$HERMES_HOME/hook_outputs/<session_id>/<uuid>.txt`
  with a head/tail preview plus the path. `agent/turn_context.py:608-618` collects it.

So: "where injected text lands" = (a) system prompt via prompt sections (persistent, 4k cap),
or (b) the current user message via `pre_llm_call` (per-turn, ephemeral, 10k spill cap).
Model sees both.

### 3. New vs resumed session discrimination

- `on_session_start` fires **only on the first turn of a brand-new session**, never on
  continuation or resume: comment at `agent/conversation_loop.py:730` —
  "Plugin hook: on_session_start — fired once for a brand-new session, not on continuation."
  On resume the stored system prompt is reused and plugin section bytes are RECOVERED from the
  persisted prompt instead of re-rendered (`agent/system_prompt.py:117-121`,
  `restore_plugin_prompt_sections` at :166).
- `pre_llm_call` fires every turn and its payload includes `is_first_turn: bool`
  (hooks.md payload table) — usable as an explicit new/resume discriminator for per-turn
  injection.

### 4. Subagent exclusion

**No automatic exclusion.** `delegate_task` children run `child.run_conversation(...)` — the
same conversation loop (`tools/delegate_tool_child_run.py:411, :659`), so `on_session_start`
and `pre_llm_call` fire in children too. There is no "don't run hooks in subagents" flag.

Self-exclusion IS possible: the `pre_llm_call` payload includes `parent_session_id`
(hooks.md payload table) — a child sees a non-null parent session id, so the callback can
`return None` when `parent_session_id` is set. Hermes also ships dedicated parent-side
observer hooks `subagent_start` / `subagent_stop` (hooks.md:463-464, :1048, :1119) for
delegation observability; they do not inject into children.

### 5. Can it shell out to the `horizon` CLI and consume stdout?

Yes. Plugins are in-process Python with full stdlib: `subprocess.run(["horizon", ...],
capture_output=True)` in a `pre_llm_call` callback, and the returned stdout string becomes
injected context the model reads. Constraints: `pre_llm_call` is a timeout-bounded hook —
default `plugins.hook_callback_timeout` 30s, max 600s; a callback that blocks past the
timeout is abandoned and the hook FAILS OPEN (skipped) (hooks.md:386). The 10,000-char spill
cap applies to the injected context.

### 6. Version

hermes-agent **0.21.1** (2026.9.7), upstream commit c076d653 — from `hermes --version` and
`pip show hermes-agent`. All paths above verified against this installed copy.

---

## Part 2 — pi

### 1. Hook/plugin name + config surface

**Mechanism: TypeScript Extensions.** The session-start event is `session_start`
(`docs/extensions.md:360`); the injection events are `before_agent_start`, `context`, and
`before_provider_request`.

Config surface (`docs/extensions.md` "Extension Locations"):

| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` (or `*/index.ts`) | global |
| `.pi/extensions/*.ts` (or `*/index.ts`) | project-local |
| `settings.json` `"extensions": [paths]` | explicit extra paths |
| `settings.json` `"packages": ["npm:...", "git:..."]` | pi packages (npm or git) |

Live working example on this machine: `/home/andre/.pi/agent/settings.json` declares
`"packages": ["git:github.com/badlogic/pi-telegram"]`; the extension lands at
`/home/andre/.pi/agent/git/github.com/badlogic/pi-telegram/index.ts` and registers handlers on
a default-exported `function (pi: ExtensionAPI)`. Run-scoped alternative: `pi -e ./ext.ts`.

### 2. Where injected text lands; does the model see it?

IMPORTANT precision: **`session_start` itself has no documented injection return.** It fires
before any prompt and its documented contract is setup + `ctx.ui.notify`
(`docs/extensions.md:360-370`); unlike `before_agent_start` there is no documented
message/systemPrompt return. The documented injection points are:

- **`before_agent_start`** (`docs/extensions.md:466-501`) — fires after the user submits a
  prompt, before the agent loop. Handler may return
  `{ message: { customType, content, display }, systemPrompt: event.systemPrompt + "..." }`.
  Per the doc comment: the message is "**persistent** (stored in session, sent to LLM)";
  the `systemPrompt` replaces the chained system prompt for that turn. `event.systemPrompt`
  and `ctx.getSystemPrompt()` reflect chained changes.
- **`context`** (`docs/extensions.md:589`) — fired before each LLM call with a deep copy of
  `event.messages`; return `{ messages }` to mutate what is sent (non-destructive to stored
  session).
- **`before_provider_request`** (`docs/extensions.md:602+`) — full provider payload rewrite,
  including system instructions at the wire level.

Working precedent for "collect at session_start, inject per prompt": the bundled example
`examples/extensions/claude-rules.ts` scans `.claude/rules/` in `session_start` and appends a
rules listing to the system prompt in `before_agent_start`. `examples/extensions/subagent/`
shows a full extension-registering custom tools + child `pi` processes.

So a deep-horizon pi adapter = extension whose `session_start` shells out and stashes the
output, then returns a `message`/`systemPrompt` from `before_agent_start` (gated on first
prompt) — or returns it on every prompt via `context`.

### 3. New vs resumed session discrimination

**First-class.** `session_start` carries
`event.reason: "startup" | "reload" | "new" | "resume" | "fork"` and
`event.previousSessionFile` (present for new/resume/fork) — `docs/extensions.md:360-370`,
lifecycle diagram at :273-317. A new session is `reason: "startup"` at process launch or
`reason: "new"` after `/new`; resuming is `reason: "resume"`. No guessing required.

### 4. Subagent exclusion

**No built-in subagents to exclude.** pi's README states it "skips features like sub agents"
(`README.md` intro) — subagents are an extension-provided pattern
(`examples/extensions/subagent/` spawns a separate `pi` process per child). Consequence: a
child `pi` process is a fresh pi runtime, so `session_start` fires there too and a globally
installed deep-horizon extension WOULD also inject into child sessions. Exclusion is the
adapter's job (e.g. environment variable / flag check, or install the extension
project-locally). Pi core does not provide a discriminator for "this session was spawned by
the subagent extension."

### 5. Can it shell out to the `horizon` CLI and consume stdout?

Yes. Extensions are Node >= 20.6 TypeScript (`"engines": { "node": ">=20.6.0" }`,
`package.json:97-98`) running with full system permissions ("Extensions run with your full
system permissions", `docs/extensions.md` Extension Locations security note). `node:fs` /
`node:child_process` are available and already used by bundled examples
(`examples/extensions/mac-system-theme.ts`, `sandbox/index.ts` use `child_process`). Parse
stdout in the handler, return it as injected text. No documented size cap on injected
message/systemPrompt content (unlike Hermes' caps) — unverified at runtime.

### 6. Version

**0.73.1** — `"version": "0.73.1"` in
`/home/andre/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/package.json`, which
matches `"lastChangelogVersion": "0.73.1"` in `/home/andre/.pi/agent/settings.json`.

---

## Part 3 — Cross-cutting notes for HL-08 (packaging)

1. **Language split**: Hermes adapter = Python plugin (in-process); pi adapter = TypeScript
   extension. A single npm package cannot serve Hermes unless Hermes shells out to a CLI —
   which Hermes plugins can do (Q5) — or a deep-horizon-core CLI is the shared artifact and
   each harness adapter is a thin (5-20 line) shim around it. Both harnesses can consume a
   CLI's stdout; this strongly favors the CLI-as-core packaging option.
2. **Injection mechanics differ**: Hermes has a purpose-built persistent mechanism
   (`register_system_prompt_section`, frozen + persisted, 4k cap); pi's persistent mechanism
   is a `before_agent_start` returned `message` (stored in session). Per-turn ephemeral
   injection exists in both (`pre_llm_call` context / `context` event).
3. **New/resume**: Hermes infers (first-turn-only hook + `is_first_turn`); pi exposes an
   explicit `reason` enum. Adapters should normalize on the richer pi semantics.
4. **Subagents**: neither harness excludes children automatically; both adapters need an
   explicit opt-out (Hermes: `parent_session_id` check; pi: env/flag or local install scope).

## Explicitly NOT verified (anti-fabrication)

- Runtime behavior was verified by reading installed source and vendored docs, not by executing
  a live injection session in either harness. Line numbers refer to the installed copies.
- pi: no documented size cap on injected content was found in `docs/extensions.md`; absence of
  documentation is not proof of absence of a cap.
- Hermes docs live URL is https://claude-code.nousresearch.com/docs (the task's URL); the
  text quoted is the vendored copy in the install at
  `/home/andre/.hermes/hermes-agent/website/docs/...`, which `plugins/AGENTS.md` identifies as
  the canonical authoring location for those pages.
