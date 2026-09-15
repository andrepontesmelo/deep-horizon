# Grill: Hook observability shape

Type: grilling
Status: closed (resolved 2026-09-15, AFK-authorized — see map Notes)
Blocked by: —

## Question

F10: all ten failures were invisible by construction — fail-open hooks log
nothing, zcode logs contain zero hook records, hermes logs only
capability-check denials. The next regression would also stay dark until
forensics. Decide the **one** minimal mechanism (charting scope: shared,
core-riding, no per-adapter inventions):

- Where: a debug line per hook fire appended where —
  `<store>/.horizon/hooks.log` (survives reboot, per-project, gitignored
  like sessions.jsonl)? `~/.cache/deep-horizon/log`? stderr (only visible
  where a harness bothers to capture it)?
- What: one line per fire with timestamp, hook, harness, session id,
  resolved store, outcome (injected/nudged/silent/recorded/error) — no
  payloads, no PII beyond ids.
- Gate: always-on (append-only, tiny) vs env-gated
  (`HORIZON_DEBUG=1`) vs `horizon doctor` reading existing signals. Note
  the tension: always-on logging from fail-open hooks must itself never
  fail a hook.
- Does `horizon doctor` exist as a diagnostic command (reads the log,
  checks hook wiring per harness, reports the F3-class "installed but not
  wired" state)? Worth folding in here or separate?

## Why it matters

Fail-open without signals means every future bug costs an afternoon of
forensics — this session's analysis. The cheapest insurance on the map.

## Resolution

**`hooks.log` in the store, always-on, written by the bins; `horizon doctor`
checks the wiring.**

1. **`<store>/.horizon/hooks.log`** — one append-only line per bin fire:
   `<iso-ts> <harness> <bin|hook> session=<id|-> store=<resolved|->
   outcome=<injected|nudged|silent|recorded|error>`. The **bins** write it
   (`horizon-inject`, `horizon session-end`), not the adapters — every
   adapter that shells out gets logging for free, one implementation, no
   per-adapter inventions (the charting constraint). The nested `.gitignore`
   gains `hooks.log` next to `sessions.jsonl`. Storeless fires (the nudge,
   the silence) have no store to log into — they stay unlogged, which is
   fine: the F2/F5 class was diagnosed from harness logs; the invisible
   class was *store-side* drops (records not landing, injections not
   composing). The logging itself is best-effort and never raises: an
   unwritable hooks.log costs the line, never the hook (fail-open all the
   way down).
2. **`horizon doctor`** — a read-only diagnostic the install story (ticket
   10) leans on: per harness, checks wiring — zcode: `horizon-inject` on
   PATH, SessionStart hook present with the right matcher, PreToolUse
   present (the F3 detector), global config parses as JSON; hermes: plugin
   files present at `~/.hermes/plugins/deep-horizon`, `config.yaml` lists it
   enabled, shims resolve on the gateway PATH. Prints one PASS/FAIL line
   per check with the fix hint, exits 0/1. Reads, never writes.
