# Per-harness setup: DeepSeek Harness (DSH) — reference implementation

This file is the DSH section of the README (packaging doc `08-packaging-distribution.md`, DSH block, literal commands). Merge note: fold into the main `README.md` "Per-harness setup" section and delete this file. Until the README lands (HL-16a), this is the authoritative DSH setup text.

## Install

```bash
npm install -g horizon-line
npm pack horizon-line          # or: git clone ... && cd horizon-line && npm pack
dsh plugin --profile <profile> add file:./horizon-line-<version>.tgz
```

Mount in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: horizon-line
      name: horizon-line
```

Ceremony identical to moving-target's proven path (its README). Whether
`dsh plugin add npm:horizon-line` works was not probed — the tgz path is the
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
