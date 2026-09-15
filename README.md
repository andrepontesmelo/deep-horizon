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

The registry tarball ships `dist/` as packed, so no build step and no
lifecycle script runs on install — the npm >= 12 install-scripts protection
is irrelevant on this route.

After installing, wire the harnesses — install writes the hook config
itself (parse, merge, validate, timestamped backup; it refuses loudly
rather than blind-write an unrecognized shape), and doctor verifies the
result:

```bash
horizon install --harness zcode --harness hermes
horizon doctor
```

From a checkout instead (hacking on the adapters): build before installing.
On npm >= 12 the install-scripts protection blocks this package's `prepare`
(the build) on path installs, and the `--allow-scripts` remedies npm's own
warning suggests still block for path installs — an unbuilt clone installs
bins that crash with `ERR_MODULE_NOT_FOUND` for `dist/cli.js`. (`npm pack`
is unaffected; `prepare` still runs there.)

```bash
git clone https://github.com/andrepontesmelo/deep-horizon
cd deep-horizon
npm install && npm run build
npm install -g .
```

A folder install is symlinked, so the global bins run this checkout's
`dist/` — build in the clone and the install is whole.

Status: this package ships the CLI core (`horizon`), the `horizon-inject`
composer, and adapters for every harness below (Claude Code has no npm
artifact — its settings block is the adapter). After the CLI is on PATH,
`horizon install --harness zcode|hermes` wires the adapter configs for you
and `horizon doctor` verifies the wiring — see Wiring below.

## CLI

Run `horizon` inside a project; the store lives in `.horizon/` (found upward,
like git finds `.git`). `horizon init` creates it.

```
usage: horizon [--cwd <path>] [--json] [--harness <name>] [--session <id>] [--origin <human|agent-proposed>] <show|about|add|close|amend|detail|log|session-end|init|doctor|install> [...]

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
  session-end --harness <name> --session <id> [--summary "<text>"] [--store <dir>] — once per (harness, session); a repeat is a silent no-op
  init                      create .horizon/ in --cwd
  doctor [--harness <name>] read-only wiring check per harness (zcode, hermes; both by default) — one PASS/FAIL line per check with the fix hint; exit 0 all-pass, 1 any FAIL
  install --harness <name>  wire a harness's global config (zcode, hermes; repeat the flag or comma-separate); parse → merge → validate → backup → atomic write, idempotent
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

## The store and git

`gaps.json` is the shared truth: **commit it**. The append-only logs
(`sessions.jsonl`, `closes.jsonl`, `hooks.log`) are machine-local by
design — gitignored by the `.gitignore` every store carries, never
merged, because concurrent append-only logs would spend their lives in
merge conflicts for no cross-machine value. The trade, stated once:
*what* is open or closed travels with the repository; *when it happened
and in which session* stays on the machine where it happened.

Git worktrees are the corollary, not a problem: a committed `gaps.json`
does not fork the store, it **branches** it — each worktree checkout
rides its branch like any other file, and merging the branch home
reconciles the gaps with it. A worktree's `sessions.jsonl` is that
checkout's diary and stays there. `horizon init` writes the nested
`.gitignore` that implements all of this; the pattern this repo's own
root `.gitignore` uses (ignore `.horizon/*`, re-include `gaps.json`,
`.gitignore`, `.gitattributes`) is the canonical one to copy.

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

## Wiring: horizon install, horizon doctor

Two adapters ride global config surfaces — ZCode's `~/.zcode/cli/config.json`
and Hermes' `~/.hermes` — and `horizon install` applies them so nobody has to
hand-edit JSON:

```bash
horizon install --harness zcode      # repeat the flag or comma-separate: --harness zcode,hermes
horizon install --harness hermes
```

ZCode: the config is parsed, merged, validated, backed up
(`config.json.bak-pre-horizon-<timestamp>` alongside), and written
atomically — never a blind write. A config that does not parse, or a `hooks`
shape install does not recognize, is a loud refusal (exit 2, fix by hand):
an unparseable config disables the *whole* file in ZCode, so writing over
one is the one unrecoverable move. The merge writes the block documented in
the ZCode section below (SessionStart matcher `startup|resume`, PreToolUse
`pre-execute`), preserves every foreign key, replaces only deep-horizon's
own entries (matched by a command naming `deep-horizon`), and leaves `Stop`
untouched. Global config only: project hooks are trust-gated and double-fire
once trusted when both scopes declare them — exactly one surface per
machine. Hermes: the plugin files are copied to
`~/.hermes/plugins/deep-horizon/` (byte-identical files skipped, stale
`__pycache__` removed) and `~/.hermes/config.yaml` gains `deep-horizon` in
`plugins.enabled` — appended last, backed up, nothing else reordered; a yaml
install cannot confidently read is refused, not guessed at. Re-running an
install changes nothing when already wired (and takes no backup when nothing
will be written); upgrading is `npm i -g deep-horizon@latest && horizon
install --harness zcode --harness hermes && horizon doctor` — the merge is
the migration, there is no config migration machinery.

`horizon doctor` is the read-only twin: per harness, one PASS/FAIL line per
check with the fix hint, exit 0 when everything is wired, 1 when something
is not. It checks the bins on PATH, the config's presence and parse, both
ZCode hooks (a missing PreToolUse is the F3-class "shipped but not wired"
state — the check names it and the fix), and for Hermes the plugin files,
the `plugins.enabled` entry, and the shims. Absent and corrupt configs are
FAIL lines, never a crash.

```bash
horizon doctor                       # both harnesses; --harness zcode narrows
```

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

Session end has two paths. Mid-session, on the first turn stop of a top-level
session, the adapter steers the agent once to run, with the user's approval:

```
horizon session-end --harness dsh --session <id> [--summary "<text>"]
```

Omitting `--summary` records `summary: null` — a summary is never fabricated.
The steer is the only path that can carry a summary, because it is the only
one that can ask.

And when the session never reaches a turn stop: the DSH launcher itself
registers SIGINT/SIGTERM and awaits the whole plugin tree's disposal under a
5-second force-exit budget (`agent/disposed`, the loop-level event, stays
unawaited — but the plugin-level dispose is a different mechanism, and it is
awaited). On the first Ctrl-C or SIGTERM the adapter's disposer runs inside
that budget and writes, synchronously, one summary-null record per store the
session served — the launch repo plus every repo the param trigger claimed
(a touch the session made is a footprint worth recording even when the
injection itself failed to deliver):

```
horizon session-end --harness dsh --session <id> --store <dir>
```

A second Ctrl-C force-exits past the budget and cuts the writes short;
SIGHUP — a closed terminal window — has no handler at all and loses the
record. A live patch-reload also unloads the plugin, but writes nothing: it
is not a session end, and an early summary-null record would consume the
`session-end` idempotency slot (first record wins) that the later
user-approved steer summary needs.

### 2. Claude Code

```bash
npm install -g deep-horizon           # the CLI — see Install
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
npm install -g deep-horizon           # the CLI — see Install
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

The close has one hole, stated plainly: SIGTERM runs `session_shutdown` and
the record lands, but closing the terminal sends SIGHUP, and pi's SIGHUP
path is a deliberate emergency exit — it skips extension cleanup entirely,
because cleanup writing to a dead terminal can re-trigger the very EIO it
is cleaning up. A session ended by terminal close therefore writes no
record. (Ctrl-C inside the interactive TUI is a raw-mode keystroke, not a
signal, and never reaches pi's process handlers either way.)

### 4. opencode — DEGRADED

```bash
npm install -g deep-horizon           # the CLI — see Install
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
records** — no close hook exists among its plugin hooks, and on signals the
binary's own handlers are bare `process.exit()` calls, so nothing graceful
ever runs at exit. opencode sessions are invisible to the log. Its gaps
still read and write like every other harness's.

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
npm install -g deep-horizon           # the CLI — see Install
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

One-shot (`-z`) sessions finalize too: the CLI's one-shot exit path runs the
same `on_session_finalize` the gateway does, so `-z` sessions that injected
also write their record.

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
  discovery). The gateway runs finalize on its SIGINT/SIGTERM shutdown
  inside a 10-second finalize budget — the bin needs milliseconds — so a
  `systemctl --user restart hermes-gateway` (SIGTERM, then SIGKILL only
  after the unit's stop timeout) still lands every live session's record;
  a hard kill or a crash does not.

### 6. ZCode

```bash
npm install -g deep-horizon           # the CLI — see Install
```

The adapter is POSIX sh scripts shipped inside the package
(`adapters/zcode/session-start`, `adapters/zcode/pre-execute`); the hook
config runs them straight from the global install, so there is no copy
step. They need `jq` and `node` on PATH.

`horizon install --harness zcode` writes the block below into the user
config `~/.zcode/cli/config.json` (parse → merge → validate → backup →
atomic write; see Wiring), and `horizon doctor` verifies the wiring
afterwards. Project-local `.zcode/config.json` may carry the
same block instead — this repo checks in the SessionStart half — but project
hooks are trust-gated and double-fire once trusted when both scopes declare
them, so pick exactly one surface; the user config is the reliable one:

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart": [
        {
          "matcher": "startup|resume",
          "hooks": [
            {
              "type": "command",
              "command": "\"$(npm root -g)/deep-horizon/adapters/zcode/session-start\"",
              "enabled": true
            }
          ]
        }
      ],
      "PreToolUse": [
        {
          "matcher": "Bash|Read|Edit|Write|NotebookEdit",
          "hooks": [
            {
              "type": "command",
              "command": "\"$(npm root -g)/deep-horizon/adapters/zcode/pre-execute\"",
              "enabled": true,
              "timeout": 10
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
global prefix (pnpm, bun), point the command at the real location. The
`timeout` is seconds; leave it modest — hooks run inline before the tool
call. The PreToolUse matcher is a case-sensitive regex on the tool name;
`Bash|Read|Edit|Write|NotebookEdit` is pinned because those are the calls
whose arguments carry absolute targets (a command string, a `file_path`,
a `notebook_path`), and the matcher keeps the hook's cost off calls that
can never carry one.
Omitting the matcher entirely would match every tool and work too — the
script scans fields, not tool names — it would just fire more often for
nothing.

Startup: the `SessionStart` hook matches `startup` and `resume` — every
app instance hands its session the horizon once. The widening is forced by
a proven fact: the `additionalContext` envelope never persists to the
session history, so a session resumed in a new app instance has no horizon
in context and the `resume` fire is the only seam that can re-deliver it.
(The harness runs the hook once per app instance — a `sessionStartHookRan`
latch — so the matcher widening cannot loop.) A 10-second simultaneity
guard covers the one race the latch cannot: two app instances starting
within seconds of each other both fire `startup` for the same session id —
the second fire finds its marker pair freshly seeded and stays silent; a
restart minutes later re-injects, which is the point. The hook payload
carries no subagent marker, so
there is no subagent guard: if a subagent session fires the hook, it
receives the horizon like any other session — noise, not harm. Every
hook fails open: a missing bin, a missing `jq`, or any error injects
nothing and never blocks the session. Each fire appends one line to the
store's `.horizon/hooks.log` (the bin-fire log, gitignored like
sessions.jsonl) — injected/nudged/silent for startup, recorded/error for
`horizon session-end` — so a regression is visible without forensics.

Param trigger: the `PreToolUse` hook scans each matching call's
arguments for absolute target directories — a `workdir` argument, the
dirname of `file_path`/`path`, absolute-path tokens inside a `command`
string (`git -C <dir>` targets included). Relative paths are dropped:
the hook cannot know the shell cwd the tool will run in, and guessing
one would resolve against the harness process. For a touched dir with a
store, the dir's horizon is injected mid-session through the same
`additionalContext` envelope, once per store per session — the hook
itself fires on every matching call (proven live: two identical calls
produced two injections), so the dedup is the script's job, kept in a
per-session marker file under `~/.cache/deep-horizon/markers/` that the
startup hook seeds with
the launch store. That seed is the point: a session launched in repo A
that touches repo A again mid-session does not get repo A's horizon
twice; a first touch of repo B does. The cache dir is deliberate — the
markers survive a reboot, which the next paragraph depends on. Storeless targets are probed once,
remembered silent, and never re-asked. The hook never denies a tool
call — it has no deny path at all (exit 2 would deny; the script cannot
produce one) — and fails open the same way: any error, missing tool, or
missing bin means silence and the call proceeds untouched. As with the
other harnesses' param triggers, a subagent's tool calls are not
distinguished from top-level ones: a subagent that touches repo B
delivers repo B's horizon into its own session — noise, not harm.

One-time trust step for project scope: hooks declared in a project's
`.zcode/config.json` are trust-gated — they stay blocked (logged as
`pending_trust`) until the workspace-hook trust is granted once, in the
TUI's review flow; headless runs never grant it. User-scope hooks in
`~/.zcode/cli/config.json` run unconditionally — that is the reliable
route if you do not want to touch the trust prompt.

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

The instruction is the quality path, not the load-bearing one — the
live data says agents understand the duty, defer it mid-session
correctly, and then the session simply ends without a wrap-up exchange,
so the offer never fires. The load-bearing mechanism is **startup
reconciliation**: every session-start also scans the marker dir for
*prior* sessions whose marker names this fire's store, older than 60
seconds, with no record in the store's `sessions.jsonl` — and writes
each orphan's record itself (`horizon session-end --harness zcode
--session <id> --store <store>`, summary honestly null). The store's own
once-guard makes it idempotent; the 60-second guard keeps live
concurrent sessions out of scope. This also covers the signal deaths no
hook can see: a session killed by SIGINT/SIGTERM — or a terminal closed
— leaves a marker, and the next session in that project buries it.

Known limitations, stated bluntly: reconciliation only runs when some
session starts in the project again — a project whose every session dies
before any next startup stays unrecorded until then. And no true close
hook exists: its hook
events number exactly seven (SessionStart, UserPromptSubmit, PreToolUse,
PermissionRequest, PostToolUse, PostToolUseFailure, Stop) and none of
them is an exit hook, while on SIGINT/SIGTERM the binary's own shutdown
runs no user-reachable code at all.

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
