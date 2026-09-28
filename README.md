# deep-horizon

[![CI](https://github.com/andrepontesmelo/deep-horizon/actions/workflows/ci.yml/badge.svg)](https://github.com/andrepontesmelo/deep-horizon/actions/workflows/ci.yml)

A deterministic, human-authored **horizon** — a short list of open gaps plus a
session log — shared across AI agent harnesses, injected at the start of every
new session.

The horizon is what the human wants and does not yet have: at most **5 open
gaps**, each one line, written by the agent only after the human agrees.
Nothing here is a task list; gaps sit open for weeks and that is the normal
case. Every harness reads and writes the same store, so the aim survives
between sessions and between tools.

## When to reach for it

You work across more than one AI coding harness (ZCode, Hermes, DSH, Claude
Code, pi, opencode), or across sessions, and the intent you state once keeps
getting lost. deep-horizon keeps it in a committed `.horizon/gaps.json` that
every harness reads at session start and writes back through one CLI — so the
plan survives a session end, a tool switch, or a reboot, and closing a gap is
recorded rather than remembered. It is not a task list: if your work fits in
one session in one tool, you do not need it.

## Install

**CLI first, adapter second.** The binary must be on PATH before any adapter
is configured; hooks fail open (they inject nothing) when the bin is missing.

```bash
npm install -g deep-horizon
horizon install --harness zcode --harness hermes
horizon doctor
```

`horizon install` wires ZCode and Hermes global config itself (parse, merge,
validate, timestamped backup; it refuses loudly rather than blind-write an
unrecognized shape), and `horizon doctor` verifies the result — one PASS/FAIL
line per check. The other four harnesses are wired by hand; each block is in
the [manual](docs/manual.md#per-harness-setup).

From a checkout instead (hacking on the adapters): build before installing —
`npm install && npm run build && npm install -g .` Details and the npm >= 12
path-install caveat are in [Install](docs/manual.md#install).

## It's working if

In any git repo, create the store and add a gap:

```bash
horizon init
horizon add check-storage "The shed has usable shelf space."
horizon show
```

`horizon show` prints the gap — `check-storage  The shed has usable shelf
space.` — and `.horizon/gaps.json` appears as a tracked-able file (commit it).
Then `horizon doctor` exits 0 with every wiring check PASS. With an adapter
wired, the next session in that repo opens with the horizon block already in
context — no command issued.

## Known limitations

- Gaps are one line each, at most 5 open (details are capped at 2048 code
  points and never injected — `horizon detail <id>` retrieves them).
- The close side is best-effort per harness: opencode writes no session
  records at all; pi loses the record on terminal close (SIGHUP); DSH loses it
  on a second Ctrl-C inside the 5s force-exit budget. Per-harness detail is in
  the [manual](docs/manual.md#per-harness-setup).
- Subagent sessions are excluded where the harness distinguishes them; where
  it cannot (ZCode hook payloads, pi pre-`HORIZON_SUBAGENT`), a subagent may
  receive the horizon — noise, not harm.
- `horizon install` supports zcode and hermes only; the other four harnesses
  are hand-wired config blocks copied from the manual.

The full manual — CLI reference, the store and git, the adapter wire
interface, per-harness setup — lives in [docs/manual.md](docs/manual.md).

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues:
[SECURITY.md](SECURITY.md) (do not open a public issue). License: [MIT](LICENSE).
