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

```bash
npm install -g deep-horizon
```

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
  session-end --harness <name> --session <id> [--summary "<text>"]
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

## Per-harness setup

### 1. DeepSeek Harness (DSH) — reference implementation

Install from a built checkout, CLI first:

```bash
npm install -g deep-horizon
git clone https://github.com/andrepontesmelo/deep-horizon
cd deep-horizon && npm pack     # prepare runs the build, so the tgz is never stale
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

At session start (`agent/session-start`) the adapter composes one block via
`horizon-inject` and seeds it once per agent — fresh, top-level startups only
(`source === "startup"`; resumed or compacted sessions replay their original
injection, subagents never get one, and a fail-open miss stays retryable).
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
npm install -g deep-horizon
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
npm install -g deep-horizon
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
specifier is proven live; the `npm:deep-horizon` variant is documented but
unprobed.

**Subagent opt-out:** pi has no discriminator for subagent sessions, so the
adapter skips injection when `HORIZON_SUBAGENT` is set to a truthy value
(`1`, `true`, `yes`). Subagent extensions should export `HORIZON_SUBAGENT=1`
in the child process environment. Fail-open: absent the variable, injection
happens — a subagent that receives the horizon is noise, not harm.

Close: `session_shutdown` runs `horizon session-end --harness pi --session
<id>` — no `--summary`, so the record carries `summary: null`.

### 4. opencode — DEGRADED

```bash
npm install -g deep-horizon
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

If Bun does not resolve the npm package from the global install, the fallback
is a local plugin at `.opencode/plugin/deep-horizon.ts` (live-verified
shape):

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
npm install -g deep-horizon
git clone https://github.com/andrepontesmelo/deep-horizon
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

cwd contract: gateway sessions get their working directory from `terminal.cwd`
in hermes config. A placeholder value (`.`) resolves to the home directory —
set it to the real project root, or export `TERMINAL_CWD`. The plugin
distrusts a session cwd with no `.horizon/` store visible and falls back to
the launch directory when it has one.

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
  `horizon session-end --harness hermes --session <id>` (summary omitted, so
  the record carries `summary: null`).

### 6. ZCode

```bash
npm install -g deep-horizon
```

The adapter is two POSIX sh scripts shipped inside the package
(`adapters/zcode/session-start`, `adapters/zcode/stop-steer`); the hook
config runs them straight from the global install, so there is no copy
step. It needs `jq` and `node` on PATH.

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
      ],
      "Stop": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "\"$(npm root -g)/deep-horizon/adapters/zcode/stop-steer\""
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
global prefix (pnpm, bun), point the two commands at the real location.

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
assistant turn. On the first stop of a session the adapter steers once:
the agent is told to ask the user, then run

```
horizon session-end --harness zcode --session <id> [--summary "<text>"]
```

The steer fires only where a horizon store exists somewhere above the
working directory — storeless, `horizon session-end` exits 0 without
writing, and a steer there would spend the user's yes on a no-op. It is
held to once per session by two guards: a record for the
session id already in `.horizon/sessions.jsonl` (the store found by
walking up from the working directory, like the CLI), or a marker file
`$TMPDIR/horizon-zcode-steer-<id>`, written before steering. Omitting
`--summary` records `summary: null` — a summary is never fabricated.

Known limitations, stated bluntly: no param trigger — ZCode's
`PreToolUse` hook sees tool arguments and could carry a mid-session
injection, but its stdout-to-context path is unproven, so the adapter
ships without one (like Claude Code). And no true close hook: a session
interrupted with SIGINT/SIGTERM — or a terminal closed — writes no
record, because `Stop` only steers at a turn boundary and nothing fires
at process exit.

## Manual use, no global install

```
npx -p deep-horizon horizon show
npx -p deep-horizon horizon-inject --harness <name>
```

(`-p` is required: the package name is not a bin name.)

## License

[MIT](LICENSE)
