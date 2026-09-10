# Research: Claude Code + opencode session-start injection surfaces (HL-01)

Type: research
Status: done
Date: 2026-09-08
Researched against live installs + source; every claim carries a URL or file path.

## Executive answer

- **Claude Code**: the `SessionStart` hook (configured in `settings.json`, or
  `hooks/hooks.json` for plugins) fires before the first prompt and injects
  via plain stdout or `hookSpecificOutput.additionalContext`. It distinguishes
  new vs resumed/compacted via `source` and a `matcher`. Subagents do NOT fire
  it (they fire the separate `SubagentStart`). It is a shell command; stdout
  and JSON both work.
- **opencode**: there is **no session-start hook**. The nearest pre-first-turn
  injection point is the `chat.message` plugin hook, which fires on creation
  of every user message and can prepend a text part to the user's message.
  New-vs-resumed must be inferred (message count / `session.time.created`);
  subagent sessions DO run `chat.message` and are excluded by checking
  `session.parentID`; the hook is in-process JS/TS, so "shelling out" means
  spawning a process yourself via Bun's `$`.

## Claude Code

Verified against: **Claude Code 2.1.258** (local install, `claude --version`),
official docs fetched 2026-09-08 from https://code.claude.com/docs/en/hooks
(raw markdown mirror at `/tmp/cc-hooks.md` at research time), plus a live
headless probe (transcripts quoted below).

### 1) Hook name, config path, schema

Event: `SessionStart`. Configured as a matcher group under `hooks` in:

- `~/.claude/settings.json` (user)
- `.claude/settings.json` (project, checked into repo)
- `.claude/settings.local.json` (project-local)
- managed/policy settings
- `hooks/hooks.json` inside a plugin (see plugins-reference#hooks)

Schema (docs "Configuration" + "Command hook fields"):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "/abs/path/hook.sh", "args": [], "timeout": 30 }
        ]
      }
    ]
  }
}
```

Constraints specific to SessionStart (docs, "### SessionStart"):

- Only `type: "command"` and `type: "mcp_tool"` handlers are supported
  (no prompt/agent handlers on this event).
- `matcher` filters on how the session started: `startup | resume | clear |
  compact | fork`. `"*"`, empty or omitted = fire on all.
- Handler stdin receives JSON with common fields (`session_id`,
  `transcript_path`, `cwd`, `hook_event_name`) plus event fields: `source`,
  optionally `model`, `agent_type`, `session_title` (the resume-cost fields
  `seconds_since_last_response`, `context_tokens`,
  `prompt_cache_likely_expired`, `estimated_cache_write_usd` require >= 2.1.251).

Plugins can also ship SessionStart hooks via `hooks/hooks.json` with
`${CLAUDE_PLUGIN_ROOT}` substitution — same schema, packaged as a plugin.

### 2) Where injected text lands; does the model see it

Two channels, both land **before the first prompt** (docs "Add context for
Claude": "SessionStart and SubagentStart: at the start of the conversation,
before the first prompt"):

- Plain stdout on exit 0: for SessionStart, "Claude Code adds plain-text
  stdout as context that Claude can see and act on". Parse caveat: stdout
  starting with `{` and ending with `}` is parsed as JSON output instead.
- JSON: `{"hookSpecificOutput": {"hookEventName": "SessionStart",
  "additionalContext": "..."}}`.

Delivery mechanics (docs "Add context for Claude"): the string is wrapped in
a **system reminder** inserted into the conversation at the point the hook
fired; "Claude reads the reminder on the next model request, but it doesn't
appear as a chat message in the interface." So: not a system-prompt edit, not
a visible chat message — a system-reminder block ahead of the first user
turn. The model sees it. Values > 10,000 chars are spilled to a file in the
session directory, replaced by a path + short preview. There is also
`initialUserMessage` (headless `-p` only), which creates the first user turn
itself instead of attaching context.

### 3) New vs resumed/compacted — YES (critical)

The hook input carries `source`, and the matcher filters on exactly this:

| Matcher  | Fires when                                             |
|----------|--------------------------------------------------------|
| `startup`| New session                                            |
| `resume` | `--resume`, `--continue`, or `/resume`                 |
| `clear`  | `/clear`                                               |
| `compact`| Auto or manual compaction                              |
| `fork`   | `--fork-session` with `--resume`/`--continue`, `/fork`, `/branch` |

(docs "### SessionStart" matcher table; note "Before v2.1.214, forked
sessions reported source `resume`".)

So moving-target's "inject only on new session" maps to
`matcher: "startup"` (or `source == "startup"` in the handler). Live proof
(2.1.258, probe project `/tmp/cc-probe`, hook logged its input):

```
2026-09-08T14:43:32 | SessionStart source=startup session_id=de2cf9e3
2026-09-08T14:44:35 | SessionStart source=resume  session_id=de2cf9e3
```

Note the doc's caveat: injected context is saved in the transcript and
replayed on `--continue`/`--resume` for mid-session events — but SessionStart
itself re-runs on resume with `source: "resume"`, so a `startup`-only hook
simply does not fire again on resume.

### 4) Subagents

SessionStart does **not** fire for subagent sessions. Subagents get the
separate `SubagentStart` event ("Runs when a Claude Code subagent is spawned
via the Agent tool"), whose `additionalContext` injects into the *subagent's*
context. Live proof (same probe run): parent fired `SessionStart
source=startup`, and when the run spawned an Explore subagent only
`SubagentStart agent_type=Explore` was logged — no second SessionStart.

Exclusion is therefore structural: a SessionStart hook cannot fire for
subagents in the first place. Belt-and-braces: the input's optional
`agent_type` field is present when launched via `claude --agent <name>`
(distinguish top-level named-agent sessions if needed), and a SubagentStart
hook can filter by agent-type matcher if it must also run there.

### 5) Shell out to a binary and use stdout — YES

That is the native model: `type: "command"` runs a shell command (input via
stdin JSON), and for SessionStart plain stdout on exit 0 becomes context the
model sees. Exec form (`command` + `args`, no shell) and shell form
(`sh -c`) are both supported (docs "Exec form and shell form"). Exit code 2
stderr is shown to the user only for SessionStart (not to Claude).

### 6) Version

Answers above verified on **Claude Code 2.1.258** (docs fetched same day).
Known version boundaries quoted by the docs: `fork` source + fork/branch
matcher since v2.1.214 (before that it reported `resume`); resume-cost input
fields since v2.1.251; JSON-parse-failure behavior on context-adding events
changed in v2.1.248.

### Live probe evidence

Probe setup: `/tmp/cc-probe` with `.claude/settings.json` registering the
same logging script on `SessionStart` and `SubagentStart` (matchers empty),
`.claude/hooks/log.sh` appending the parsed input to `/tmp/cc-probe/hooklog.txt`.

Run 1 (fresh headless session that spawns a subagent):
`claude -p "Use the Task tool with subagent_type=Explore ... " --max-turns 4 --allowedTools Task`

```
14:43:32 SessionStart source=startup agent_type=None session_id=de2cf9e3
14:43:41 SubagentStart  source=None   agent_type=Explore session_id=de2cf9e3
```

Run 2 (`claude -p --resume de2cf9e3-... "Reply with just 'ok'"`):

```
14:44:35 SessionStart source=resume agent_type=None session_id=de2cf9e3
```

Transcripts: `~/.claude/projects/-tmp-cc-probe/de2cf9e3-*.jsonl`.

## opencode

Verified against: **opencode source at commit `dff8fbc` (2026-09-08), npm
package `opencode-ai` v1.18.29** (matches local clone `packages/*/package.json`
and `npm view opencode-ai version`). The binary is not installed on this
machine (`opencode: command not found`), so all opencode evidence is from the
source tree (cloned to `opencode-src/` in this task workspace) plus
https://opencode.ai/docs/plugins — no live run was performed. The source
under the npm dist-tag `latest` equals what was read.

### 1) Hook/plugin name, config path, schema

There is **no hook event named anything like session-start**. Plugin hooks
are JavaScript/TypeScript functions, not shell commands:

- Local: `.opencode/plugins/*.ts|js` (project) or
  `~/.config/opencode/plugins/*` (global) — auto-loaded at startup
  (docs "Use a plugin").
- npm: `"plugin": ["name"]` in `opencode.json` (docs, same section).

A plugin exports async functions returning a hooks object:

```ts
// .opencode/plugins/moving-target.ts
import type { Plugin } from "@opencode-ai/plugin"
export const MovingTarget: Plugin = async ({ project, client, $, directory, worktree }) => {
  return {
    // hook implementations
  }
}
```

The complete hook surface is the `Hooks` interface in
`opencode-src/packages/plugin/src/index.ts` (lines ~184-330): `event`,
`config`, `tool`, `auth`, `provider`, `chat.message`, `chat.params`,
`chat.headers`, `permission.ask`, `command.execute.before`,
`tool.execute.before`, `tool.execute.after`, `shell.env`, and
`experimental.chat.messages.transform`, `experimental.chat.system.transform`,
`experimental.provider.small_model`, `experimental.session.compacting`,
`experimental.compaction.autocontinue`, `experimental.text.complete`.
The docs page's "Events" section lists bus events (`session.created`,
`session.idle`, `session.compacted`, ...) observable via the `event` hook.
Checked explicitly: no `session.start`, no `session.loaded`, no
pre-first-turn lifecycle hook exists. The closest lifecycle signals are the
`event`-hook notifications `session.created` / `session.compacted`
(schema: `packages/schema/src/v1/session.ts` line 573 `type:
"session.created"`), but an `event` hook is a passive notification — it
cannot modify the outgoing prompt.

### 2) Where injected text lands; does the model see it

The pre-first-turn injection point is **`chat.message`**:

```ts
"chat.message"?: (
  input: { sessionID: string; agent?: string; model?: {...}; messageID?: string; variant?: string },
  output: { message: UserMessage; parts: Part[] },
) => Promise<void>
```

(`packages/plugin/src/index.ts`, commented "Called when a new message is
received".) Trigger site: `packages/opencode/src/session/prompt.ts` line
~1000, inside `createUserMessage` — fired after parts are resolved but
**before** `sessions.updateMessage(info)` / `sessions.updatePart(part)`
persist them, and before the LLM loop starts. The `output` object is mutable
and authoritative: appending a `{ type: "text", text: "..." }` TextPart to
`output.parts` (shape: `packages/schema/src/v1/session.ts` line 102) saves it
as part of the user message, so it reaches the model as part of the first
user turn (same message, additional part — not a separate message, not
system context).

Two experimental hooks can also shape what the model sees, but they run at
request-build time, not session start:
- `experimental.chat.messages.transform` (prompt.ts line ~1255, just before
  the request) — can rewrite the whole message list every request.
- `experimental.chat.system.transform` — can append to the system prompt
  every request.

### 3) New vs resumed/compacted — NOT DIRECTLY; must be inferred (critical)

`chat.message` has no `source` field. Nothing tells the hook whether the
session is fresh, resumed, or compacted. Inference options, all verified in
source:

- Fresh vs has-history: `chat.message` fires per user message. On the first
  `chat.message` of a session, if the session already has persisted messages,
  it is a resumed/continued session. (Resuming in opencode continues the
  same session record; there is no `--resume` re-fire of anything.)
- Compacted: compaction runs on the **same session ID**
  (`packages/opencode/src/session/compaction.ts` `processCompaction` writes
  the summary assistant message to `input.sessionID`) and does NOT route
  through `chat.message` for the summary generation — the compaction pipeline
  triggers only `experimental.session.compacting`,
  `experimental.chat.messages.transform`. So `chat.message` staying silent is
  itself weak evidence of compaction, and the follow-up user turn after
  compaction fires `chat.message` on a session whose messages include
  summary/compaction parts.
- `session.time.created` (schema `SessionInfo.time.created`) gives session
  age; `event` hook `session.created` gives an exact birth signal.

Caveat to carry into design: all inference is heuristic. If
new-vs-resumed discrimination must be exact, opencode cannot currently
guarantee it; Claude Code can.

### 4) Subagents fire it — exclude via `session.parentID`

Subagent sessions are created with `parentID` set to the parent session:
`packages/opencode/src/tool/task.ts` line ~159
(`sessions.create({ parentID: ctx.sessionID, title: ... + " (@${next.name}
subagent)", agent: next.name })`; schema field:
`packages/schema/src/v1/session.ts` line 550 `parentID: optional(SessionID)`).

Subagent first prompts go through the same `SessionPrompt.prompt` path
(task.ts calls `ops.prompt({ sessionID: nextSession.id, ... })` →
`createUserMessage`), so **`chat.message` DOES fire for subagent sessions**.
Exclusion: in the hook, load the session (`client.session.get` /
`Session.get`) and skip when `info.parentID` is set — equivalently skip when
`input.agent` is a subagent-only agent. This mirrors moving-target's DSH
guard `(header.delegationDepth ?? 0) > 0 || header.origin === "subagent"`.

### 5) Shell out to a binary and use stdout

Not a hook feature — hooks are in-process functions. But the plugin context
exposes Bun's shell: `export const P = async ({ $ }) => { const out = await
$\`/path/binary --flag\`.text(); ... }` (docs "Basic structure" — `$` is
"Bun's shell API for executing commands"). So yes, a plugin can run a binary
and read stdout, it just does so from inside the plugin process rather than
being spawned by the harness. (Docs example of the same primitive:
`await $\`osascript -e '...'\``.)

### 6) Version

Findings true for `opencode-ai` **v1.18.29** / source commit `dff8fbc`
(2026-09-08). Hook surface is marked with `experimental.*` prefixes in
places, so treat the experimental hooks as unstable; `chat.message` and the
plugin loading scheme are long-standing but were only verified at this
version. No live behavioral probe was run (binary not installed) — source
reading only.

## Mapping to moving-target's requirements

| moving-target need (DSH `agent/session-start` + `agent.inject`) | Claude Code 2.1.258 | opencode 1.18.29 |
|---|---|---|
| Inject before first turn | SessionStart hook, `additionalContext`/stdout | `chat.message` hook, prepend TextPart |
| Injection form | system reminder, model sees it, not a chat message | part of first user message, model sees it |
| Fire only on NEW session | exact: `matcher: "startup"` / `source === "startup"` | heuristic: first message + empty history + `session.time.created` |
| Skip resumed/compacted | exact via source | heuristic (same-session compaction leaves no source marker) |
| Skip subagents | structural (SessionStart never fires there) | check `session.parentID` in the hook |
| Run external binary, use stdout | native (command hook) | manual via Bun `$` inside plugin |
| One config surface | `hooks` in settings.json / plugin hooks.json | `.opencode/plugins/*.ts` or npm plugin in opencode.json |

## What could not be confirmed

- opencode: no behavioral probe (binary absent). Everything is from source
  at `dff8fbc` / v1.18.29 and the docs page; a live `chat.message`
  mutation run was not performed.
- opencode: no documented guarantee about `chat.message` ordering across
  multiple plugins (docs say only "all hooks run in sequence" for load
  order).
- Claude Code: exact DOM/transcript rendering of the injected system
  reminder was not inspected beyond the docs' description.
