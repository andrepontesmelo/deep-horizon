# Grill: Hook observability shape

Type: grilling
Status: open
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
