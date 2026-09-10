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

Status: this package ships the CLI core (`horizon`). Harness adapters and the
`horizon-inject` composer land in subsequent releases — the per-harness setup
below documents the target wiring.

## CLI

Run `horizon` inside a project; the store lives in `.horizon/` (found upward,
like git finds `.git`). `horizon init` creates it.

```
usage: horizon [--cwd <path>] [--json] [--harness <name>] [--session <id>] [--origin <human|agent-proposed>] <show|add|close|amend|log|session-end|init> [...]

commands:
  show                      print open gaps (id + two spaces + text)
  add "<text>"              append a gap; prints the new id
  close <id>                remove a gap; frees a slot
  amend <id> "<text>"       rewrite a gap's text in place
  log [--limit N]           print session records, newest first
  session-end --harness <name> --session <id> [--summary "<text>"]
  init                      create .horizon/ in --cwd
```

Only the human closes a gap. The agent proposes — `horizon add` / `horizon
close` run only after the human says yes. Store files: `.horizon/gaps.json`
(the open gaps), `.horizon/sessions.jsonl` and `.horizon/closes.jsonl`
(append-only history).

## Per-harness setup

### 1. DeepSeek Harness (DSH) — reference implementation

```bash
npm install -g deep-horizon
npm pack deep-horizon          # or: git clone ... && cd deep-horizon && npm pack
dsh plugin --profile <profile> add file:./deep-horizon-<version>.tgz
```

Mount in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: deep-horizon
      name: deep-horizon
```

Session-end uses the mid-session fallback: the adapter prompts the agent to
run `horizon session-end --harness dsh --session <id>` mid-session, where
model text is still available.

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
    ]
  }
}
```

`startup` only: resumed/compacted/forked sessions replay the original
injection from their transcript, so re-injecting would duplicate it. Close
hook: `SessionEnd` → `horizon session-end` (the only close hook proven to
fire on SIGINT/SIGTERM).

### 3. pi

```bash
npm install -g deep-horizon
```

`~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:deep-horizon"] }
```

**Subagent opt-out:** pi has no discriminator for subagent sessions, so the
adapter skips injection when `HORIZON_SUBAGENT` is set to a truthy value
(`1`, `true`, `yes`). Subagent extensions should export `HORIZON_SUBAGENT=1`
in the child process environment. Fail-open: absent the variable, injection
happens — a subagent that receives the horizon is noise, not harm.

### 4. opencode — DEGRADED

```bash
npm install -g deep-horizon
```

`opencode.json` (project):

```json
{ "plugin": ["deep-horizon"] }
```

opencode ships degraded, and the README says so plainly: injection is
best-effort (new-vs-resumed is inferred heuristically), and **opencode
sessions write no session records** — no close hook exists, so opencode
sessions are invisible to the log. Its gaps still read and write like every
other harness's.

### 5. Hermes

```bash
npm install -g deep-horizon
git clone https://github.com/andrepontesmelo/deep-horizon
cp -r deep-horizon/adapters/hermes ~/.hermes/plugins/deep-horizon
hermes plugins enable deep-horizon
systemctl --user restart hermes-gateway   # the gateway loads plugins at start
```

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

## Manual use, no global install

```
npx -p deep-horizon horizon show
npx -p deep-horizon horizon-inject --harness <name>
```

(`-p` is required: the package name is not a bin name.)

## License

[MIT](LICENSE)
