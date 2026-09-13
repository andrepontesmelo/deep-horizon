# deep-horizon

A deterministic, human-authored **horizon** — a short list of open gaps plus a
session log — shared across AI agent harnesses, injected at the start of every
new session.

The horizon is what the human wants and does not yet have: at most **5 open
gaps**, each one line, written by the agent only after the human agrees.
Nothing here is a task list; gaps sit open for weeks and that is the normal
case. Every harness reads and writes the same store, so the aim survives
between sessions and between tools.

## Install

**CLI first, adapter second.** The binary must be on PATH before any adapter
is configured; hooks fail open (they inject nothing) when the bin is missing.

There is **no npm release yet** — `npm install -g deep-horizon` 404s on
registry.npmjs.org (this repo's open gap `registry-release`). Install from a
checkout, and build before installing: on npm >= 12 the install-scripts
protection blocks this package's `prepare` (the build) on path installs, and
the `--allow-scripts` remedies npm's own warning suggests still block for
path installs — the installed bins then crash with `ERR_MODULE_NOT_FOUND`
for `dist/cli.js`. (`npm pack` is unaffected; `prepare` still runs there.)

```bash
git clone https://github.com/andrepontesmelo/deep-horizon
cd deep-horizon
npm install && npm run build
npm install -g .
```

A folder install is symlinked, so the global bins run this checkout's
`dist/` — build in the clone and the install is whole.

Publishing is the intended route, not a user step today: once `npm publish`
runs, the block above becomes `npm install -g deep-horizon` again.

Status: this package ships the CLI core (`horizon`), the `horizon-inject`
composer, and adapters for every harness below (Claude Code has no npm
artifact — its settings block is the adapter).

## CLI

Run `horizon` inside a project; the store lives in `.horizon/` (found upward,
like git finds `.git`). `horizon init` creates it.

```
usage: horizon [--cwd <path>] [--json] [--harness <name>] [--session <id>] [--origin <human|agent-proposed>] <show|about|add|close|amend|detail|log|session-end|init> [...]

commands:
  show                      print open gaps (id + two spaces + text)
  about                     print the about line
  about "<text>"            set or replace the about line (what this project is)
  about --clear             unset the about line
  add <id> "<text>"         append a gap under a caller-chosen slug id; prints the id (--detail "<text>" attaches details)
  close <id>                remove a gap; frees a slot
  amend <id> "<text>"       rewrite a gap's text in place
  detail <id>               print a gap's details
  detail <id> "<text>"      set or rewrite a gap's details (2048 code points max)
  detail <id> --clear       remove a gap's details
  log [--limit N]           print session records, newest first
  session-end --harness <name> --session <id> [--summary "<text>"] [--store <dir>]
  init                      create .horizon/ in --cwd
```

A gap's title is one line; it may also carry optional **details** — the
extended context (what, why, where it came from) that must not crowd the
line. Details may be multi-line, at most 2048 Unicode code points, set at
creation with `add --detail "<text>"` or later with `horizon detail`. They
are never injected: the injected horizon carries the one line only, plus a
pointer that `horizon detail <id>` retrieves the rest on demand.

Only the human closes a gap. The agent proposes — `horizon add` / `horizon
close` run only after the human says yes. Gap ids are chosen, not minted:
`horizon add plant-photo-lookup "A person can hand a photo to the app and get
the plant named."` — a slug of 3–40 lowercase letters, digits, and hyphens,
starting with a letter. An id is never reused, even after its gap closes, so a
name always means the same gap for the life of the project. The about line is
one human-authored line saying what this project **is** (gaps say where the
work is heading); when set, it is injected ahead of the horizon block. Store
files: `.horizon/gaps.json` (the open gaps, the retired ids of closed gaps,
and the about line), `.horizon/sessions.jsonl` and `.horizon/closes.jsonl`
(append-only history).

## The adapter wire interface

Every harness's glue is the same two calls, and neither discovers a store on
its own. `horizon-inject --harness <name> --cwd <dir>` prints the text to
inject — empty output means silent. With `--json` the answer is total: one
JSON line, `{"text": <string>, "store": <string|null>}` — the composed text
plus the store directory the composer already resolved (null when no store
was found). The close hooks hand that store back, so teardown never
re-discovers it: `horizon session-end --harness <name> --session <id>
--store <dir>` (without a store the command still works, discovering from
`--cwd`; a path that does not exist is a silent no-op).

## Per-harness setup

### 1. DeepSeek Harness (DSH) — reference implementation

Install from a built checkout, CLI first:

```bash
git clone https://github.com/andrepontesmelo/deep-horizon
cd deep-horizon
npm install && npm run build    # build in the clone first — see Install
npm install -g .                # the CLI, from this clone
npm pack                        # the plugin tgz, from the built checkout
dsh --profile <profile> --from-default-profile sdk-minimal --dump-config
dsh plugin --profile <profile> add file:/abs/path/deep-horizon-<version>.tgz
```

Upgrading: bump the version, `npm pack`, and re-run the `dsh plugin add` —
or remove the plugin, then re-add. Re-adding an unchanged version prints
"Already up to date" and silently keeps the old bits, and `--dump-config`
cannot catch stale content.

`npm pack deep-horizon` (by name) packs the registry copy, not this code. The
`plugin add` warns that deep-horizon "declares no dsh.bundle — installed as a
plain dependency, not a profile layer". That is expected; the manual step it
implies is the mount row below. Whether `dsh plugin add npm:deep-horizon`
works was not probed — the tgz path is the documented one.

Mount in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: deep-horizon
      name: deep-horizon/dsh
```

then verify the wiring with `dsh --profile <profile> --dump-config`.

At session start (`agent/session-start`) the adapter arms one
`horizon-inject` resolve — the moment the event fires, before the spawn has
finished — and delivers the block at the session's first model step: the
awaited `agent/pre-step` waterfall holds step 1 until the answer lands, so
the first request already carries the block ahead of the launch prompt
(session-start itself is fire-and-forget; an injection fired there, rather
than armed for the first step, lands in the second step's request). A resolve
that fails or times out (the 15s bin bound) leaves step 1 clean and the miss
retryable. Seeded once per agent — fresh, top-level startups only
(`source === "startup"`; resumed or compacted sessions replay their original
injection, subagents never get one).
The block is one of the composer's three variants: the bootstrap nudge on a
project with no store or an empty one, the warm nudge when an about line is
set but no gaps are, the horizon block when gaps are open (the about line
prefixes it when set). A storeless launch from the home directory stays
silent — $HOME is not a project.

A session launched in repo A that touches repo B mid-session is covered by a
second injection path, the **param trigger** (`tools/pre-execute`): every tool
call's arguments are inspected for target directories — a `workdir` field, the
directories of `file_path`/`path` arguments, and absolute paths in `command`
strings (which covers `git -C <dir>` targets). When a touched directory
resolves to a repo with a horizon store, that repo's horizon is queued for the
next step — once per repo per session, the launch repo's own horizon never
re-fired, subagents excluded, and never for a storeless target (no store is
created or offered for one; an existing but empty store still composes the
bootstrap nudge, as on the startup path). Like everything
else in the adapter it fails open: malformed arguments, a failed spawn, or an
error queue nothing and never block the tool call.

Session end is best-effort by necessity: DSH has no usable close hook —
`agent/disposed` fires unawaited after the loop stops, when model text is
already gone. So on the first turn stop of a top-level session the adapter
steers the agent once to run, mid-session and with the user's approval:

```
horizon session-end --harness dsh --session <id> [--summary "<text>"]
```

Omitting `--summary` records `summary: null` — a summary is never fabricated.

### 2. Claude Code

```bash
npm install -g ./deep-horizon    # from a clone of this repo — see Install
```

`.claude/settings.json` (project-local, checked into the repo):

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
            "command": "horizon session-end --harness claude-code --session \"$(jq -r .session_id)\""
          }
        ]
      }
    ]
  }
}
```

`startup` only: resumed/compacted/forked sessions replay the original
injection from their transcript, so re-injecting would duplicate it. Known
deliberate gap: `/clear` wipes the context but does not re-inject (its source
is not matched by the startup-only hook) — the horizon returns next startup.
Subagents are excluded structurally: the `SessionStart` hook does not fire
for them (they get `SubagentStart`).
`SessionEnd` is the only close hook proven to fire on SIGINT/SIGTERM; its
stdin JSON carries the session id (`jq -r .session_id` reads it), and the
record carries `summary: null` — the close hook cannot elicit model text.

### 3. pi

```bash
npm install -g ./deep-horizon    # from a clone of this repo — see Install
```

`~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:deep-horizon"] }
```

The extension entry point is the package's `exports["./pi"]` module:
`session_start` shells out to `horizon-inject` and stashes the output; the
first `before_agent_start` prompt returns it as a persistent message. Only
the `startup` reason stashes — `new`, `resume`, `fork`, and `reload` arrive
inside a running process or replay an existing horizon. The `git:` package
specifier is proven live; `npm:deep-horizon` does not resolve today (no
registry release), so point the specifier at the repo.

**Subagent opt-out:** pi has no discriminator for subagent sessions, so the
adapter skips injection when `HORIZON_SUBAGENT` is set to a truthy value
(`1`, `true`, `yes`). Subagent extensions should export `HORIZON_SUBAGENT=1`
in the child process environment. Fail-open: absent the variable, injection
happens — a subagent that receives the horizon is noise, not harm.

Close: `session_shutdown` runs `horizon session-end --harness pi --session
<id>`, passing `--store` with the dir the startup injection resolved —
surviving both the delivery (the text stash is spent on the first prompt)
and any process chdir since. With no stashed store the command keeps its
cwd-discovery form. No `--summary` either way, so the record carries
`summary: null`.

### 4. opencode — DEGRADED

```bash
npm install -g ./deep-horizon    # from a clone of this repo — see Install
```

`opencode.json` (project):

```json
{ "plugin": ["deep-horizon"] }
```

opencode ships degraded, and the README says so plainly: the horizon block is
added as an extra text part of the first user message, once per session, on a
freshness heuristic (recent `session.time.created` plus empty persisted
history — new-vs-resumed is inferred, not known); subagent sessions are
excluded via `session.parentID`; and **opencode sessions write no session
records** — no close hook exists, so opencode sessions are invisible to the
log. Its gaps still read and write like every other harness's.

`"plugin": ["deep-horizon"]` resolves a registry package, and there is none
yet — the route today is the local plugin at
`.opencode/plugin/deep-horizon.ts` (live-verified shape):

```ts
import { apply } from "deep-horizon/opencode";
export default async function deepHorizon(ctx) {
  return await apply(ctx);
}
```

### 5. Hermes

Upgrading from horizon-line: disable and remove the old plugin first, or both
inject — `hermes plugins disable horizon-line`, then delete
`~/.hermes/plugins/horizon-line`, before installing deep-horizon.

```bash
git clone https://github.com/andrepontesmelo/deep-horizon
npm install -g ./deep-horizon    # the CLI — see Install
rsync -a --exclude __pycache__ deep-horizon/adapters/hermes/ ~/.hermes/plugins/deep-horizon/
rm -rf ~/.hermes/plugins/deep-horizon/__pycache__   # upgrades: --exclude keeps the OLD bytecode
# no rsync? coreutils only:
#   cp -r deep-horizon/adapters/hermes ~/.hermes/plugins/deep-horizon && \
#     rm -rf ~/.hermes/plugins/deep-horizon/__pycache__
hermes plugins enable deep-horizon
systemctl --user restart hermes-gateway   # the gateway loads plugins at start
```

(The `rm -rf` matters on upgrades: `--exclude` stops rsync copying the
clone's `__pycache__` in, but it also stops it deleting the destination's
stale bytecode — a bare `cp -r` ships it too.)

From a checkout, `npm run sync:hermes` (or `bash
scripts/sync-hermes-adapter.sh`) does the copy above plus a parity diff —
one repeatable step instead of silent drift between repo and plugin dir.
`HERMES_PLUGIN_DIR` overrides the destination.

cwd contract: gateway sessions get their working directory from `terminal.cwd`
in hermes config. A placeholder value (`.`) resolves to the home directory —
set it to the real project root, or export `TERMINAL_CWD`. The plugin never
looks for stores itself: it asks `horizon-inject --json`, and a storeless
session cwd defers to the launch directory when the bin finds a store there.

Known hermes-side limitation: one-shot (`-z`) sessions skip
`on_session_finalize`, so `horizon session-end` never runs for them (filed
upstream as kanban task `t_87aa52a7` on the hermes-agent board).

The Python plugin wires the horizon into Hermes at three points. All spawning
goes through the `horizon` / `horizon-inject` bins (the plugin never composes
the texts itself) and every hook fails open — a missing bin, a timeout, or an
error injects nothing and never blocks a session.

- **Session start (frozen section):** a persistent system-prompt section spawns
  `horizon-inject --harness hermes` for the session's working directory. The
  core renders it once, freezes it into the prompt, and persists it verbatim,
  so resumes never duplicate it. Subagent sessions render nothing.
- **Every turn (param trigger):** after each user turn the plugin scans ONLY
  the new assistant tool-call parameters — `terminal` (command + workdir),
  `read_file` / `write_file` / `patch` / `search_files` (path),
  `execute_code` (code) — for touches under the git root (`/home/andre/git/`
  or `~/git/`). When a touched repo has a `.horizon/` store, its horizon is
  injected into that turn once per (session, repo). Tool results and user
  messages are never scanned (asking "list all files in my workspace" injects
  nothing), store-less repos stay silent (the nudge never fires here), and
  subagents are skipped. The horizon arrives on the turn **after** the first
  touch: the first action in a repo is uninformed by design.
- **Session end:** `on_session_finalize` →
  `horizon session-end --harness hermes --session <id> --store <the store
  the injection answer carried>` (summary omitted, so the record carries
  `summary: null`; sessions that never injected fall back to cwd
  discovery).

### 6. ZCode

```bash
npm install -g ./deep-horizon    # from a clone of this repo — see Install
```

The adapter is one POSIX sh script shipped inside the package
(`adapters/zcode/session-start`); the hook config runs it straight from
the global install, so there is no copy step. It needs `jq` and `node`
on PATH.

`.zcode/config.json` (project-local, checked into the repo — this repo
carries one; the same `hooks` block may instead live in the user config
`~/.zcode/cli/config.json`):

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart": [
        {
          "matcher": "startup",
          "hooks": [
            {
              "type": "command",
              "command": "\"$(npm root -g)/deep-horizon/adapters/zcode/session-start\""
            }
          ]
        }
      ]
    }
  }
}
```

`"enabled": true` is load-bearing — ZCode disables config-file hooks by
default. The `$(npm root -g)` expansion happens in the shell ZCode runs
`command` hooks with; if the package was installed under a different
global prefix (pnpm, bun), point the command at the real location.

Startup: the `SessionStart` hook matches `startup` only — the first turn
of a fresh session — and injects one composed block through the
`additionalContext` envelope ZCode appends to the message history. A
resumed session replays the original injection from its persisted
history, so re-injecting would duplicate it (the same assumption as the
Claude Code adapter). The hook payload carries no subagent marker, so
there is no subagent guard: if a subagent session fires the hook, it
receives the horizon like any other session — noise, not harm. Every
hook fails open: a missing bin, a missing `jq`, or any error injects
nothing and never blocks the session.

Session end: ZCode has no close hook — `Stop` fires at the end of every
assistant turn — so the duty rides the startup injection itself. When a
store exists and the payload carries a session id, the hook appends a
zcode-only tail to the composed block telling the agent that, when the
user is wrapping up the session, it should offer

```
horizon session-end --harness zcode --session <id>
```

with a one-line `--summary` of what the session did if the user gives
one, none if they don't — the record then carries `summary: null`; a
summary is never invented. If the user declines, the agent lets it go.
The tail rides only when a store exists somewhere above the working
directory (a storeless composition is empty and injects nothing) and
only when the payload carries a session id: without the id the agent
cannot name the record, and a placeholder id would write a wrong one.

Known limitations, stated bluntly: no param trigger — ZCode's
`PreToolUse` hook sees tool arguments and could carry a mid-session
injection, but its stdout-to-context path is unproven, so the adapter
ships without one (like Claude Code). And no true close hook: a session
interrupted with SIGINT/SIGTERM — or a terminal closed — writes no
record, because the duty lives in a once-per-session startup injection
and nothing fires at process exit.

## Manual use, no global install

```
node ./deep-horizon/bin/horizon.js show
node ./deep-horizon/bin/horizon-inject.js --harness <name>
```

(The bins import `dist/`, so run `npm install` in the clone first — its
`prepare` builds it. `npx -p deep-horizon` resolves the registry, which has
no such package yet.)

## License

[MIT](LICENSE)
