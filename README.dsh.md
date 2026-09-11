# Per-harness setup: DeepSeek Harness (DSH) — reference implementation

This file is the DSH section of the README (packaging doc `08-packaging-distribution.md`, DSH block, literal commands). Merge note: fold into the main `README.md` "Per-harness setup" section and delete this file. Until the README lands (HL-16a), this is the authoritative DSH setup text.

## Install

```bash
npm install -g deep-horizon
npm pack deep-horizon          # or: git clone ... && cd deep-horizon && npm pack
dsh plugin --profile <profile> add file:./deep-horizon-<version>.tgz
```

Mount in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: deep-horizon
      name: deep-horizon/dsh
```

Ceremony identical to moving-target's proven path (its README). Whether
`dsh plugin add npm:deep-horizon` works was not probed — the tgz path is the
documented one.

## Injection

`agent/session-start`, guarded on `source === "startup"` and on
`delegationDepth`/`origin` (moving-target's proven pattern): only fresh,
top-level sessions get the horizon; resumed or compacted sessions already
carry it, and subagents never do.

## Session end

The mid-session fallback from day one (D3): DSH has no usable close hook —
`agent/disposed` fires unawaited after the loop stops, when model text is
already gone. On every turn stop of a top-level session the adapter prompts
the agent once to run, with the user's approval:

```
horizon session-end --harness dsh --session <id> [--summary "<text>"]
```

mid-session, while the model can still write the summary. Omitting
`--summary` records `summary: null` — a summary is never fabricated.

## Claude Code

### Install

```bash
npm install -g deep-horizon
```

### Inject — `.claude/settings.json` (project-local, checked into the repo)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "horizon-inject --harness claude-code" }
        ]
      }
    ]
  }
}
```

`startup` only: resumed/compacted/forked sessions replay the original
injection from their transcript, so re-injecting would duplicate it. Known
deliberate gap: `/clear` wipes the context but does not re-inject (its source
is not matched) — the horizon returns next startup. There is no npm artifact:
the settings block is the adapter. Subagents are excluded structurally (the
`SessionStart` hook does not fire for them; they get `SubagentStart`).

### Close — `SessionEnd`

Add to the same `.claude/settings.json` `hooks` object:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "horizon-inject --harness claude-code" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "horizon session-end --harness claude-code --session \"$CLAUDE_SESSION_ID\""
          }
        ]
      }
    ]
  }
}
```

`SessionEnd` is the only close hook proven to fire on SIGINT/SIGTERM (HL-10b
research). Its stdin JSON carries the `session_id`; keep the command a one
line `jq` fallback if your shell cannot expand the id:

```json
{ "type": "command", "command": "horizon session-end --harness claude-code --session \"$(jq -r .session_id)\"" }
```

The record carries `summary: null` — the close hook cannot elicit model text
(only `Stop` can, and using it to demand a summary every session is not v1).

## pi

### Install

```bash
npm install -g deep-horizon
```

`~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:deep-horizon"] }
```

The `git:` package specifier is proven live on this machine (pi-telegram);
the `npm:` variant is documented in the same settings table. The extension
entry point is the package's `exports["./pi"]` module: `session_start` shells
out to `horizon-inject --harness pi` and stashes the output; the first
`before_agent_start` prompt returns it as a persistent message. Only the
`startup` reason stashes — `new`, `resume`, `fork`, and `reload` arrive inside
a running process or replay an existing horizon.

### Subagent opt-out (fail-open)

pi has no discriminator for subagent sessions, so the adapter skips injection
when `HORIZON_SUBAGENT` is set to a truthy value (`1`, `true`, `yes`).
Subagent extensions should export `HORIZON_SUBAGENT=1` in the child process
environment. Fail-open: absent the variable, injection happens — a subagent
that receives the horizon is noise, not harm.

### Close

`session_shutdown` runs:

```
horizon session-end --harness pi --session <id>
```

with the session id read from `ctx.sessionManager.getSessionId()`. The record
carries `summary: null` unless a future version elicits one.

## opencode — DEGRADED

### Install

```bash
npm install -g deep-horizon
```

`opencode.json` (project):

```json
{ "plugin": ["deep-horizon"] }
```

**opencode ships degraded, and this README says so plainly:** injection is
best-effort — the horizon block is added as an extra text part of the first
user message, once per session, on a freshness heuristic (recent
`session.time.created` plus empty persisted history), so new-vs-resumed is
inferred, not known. Subagent sessions are excluded via `session.parentID`.
**opencode sessions write no session records** — no close hook exists, so
opencode sessions are invisible to `sessions.jsonl`. Its gaps still read and
write like every other harness's.

If Bun does not resolve the npm package from the global install, the fallback
is a local plugin at `.opencode/plugin/deep-horizon.ts` (live-verified shape):

```ts
import { apply } from "deep-horizon/opencode";
export default async function HorizonLine(ctx) {
  return await apply(ctx);
}
```

## Hermes

```bash
npm install -g deep-horizon
git clone https://github.com/andrepontesmelo/deep-horizon
cp -r deep-horizon/adapters/hermes ~/.hermes/plugins/deep-horizon
hermes plugins enable deep-horizon
```

The Python plugin registers a persistent system-prompt section (id
`deep-horizon`, capped at the core maximum of 4,000 chars — the worst-case
block fits with room to spare) whose callable spawns
`horizon-inject --harness hermes`; the core renders it once per new session,
freezes it, and persists it verbatim, so resumed sessions replay the original
bytes instead of re-rendering. Subagent exclusion: the section renders empty
when `parent_session_id` is set (delegate_task children run the same loop).
Close: `on_session_finalize` → `horizon session-end --harness hermes
--session <id>` with no `--summary` (the record carries `summary: null`).
Fails open when the binary is missing: sessions proceed, nothing is injected.
