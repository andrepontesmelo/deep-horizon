# 07 resolution — the 0.4.0 provenance amendment

The versioned §10 / CLI-contract delta resolving *Spec 0.4.0 — provenance and
honest commands*. Confirmed by Andre 2026-09-15: "every session's id gets
baked into the horizon text by `horizon-inject` itself (env vars only as a
terminal-user fallback), the block's add teaching becomes the id-first
`horizon add <id> "<one line>"` the CLI actually accepts, provenance stays on
add and close only, and the old 'unknown' records are left alone."

## D1 — Provenance rides the injected text (the footer)

Adapters already hold the session id at injection time; `horizon-inject`
already receives `--session` and discards it. From 0.4.0 the composer USES
it: a **provenance footer** is appended after the composed variant (after
`aboutPrefix + core`), following the §10.4 about-prefix precedent — composed
outside the locked strings, so the byte-lock (test 34) keeps locking the
fences and a new test guards the footer's own bytes.

**Locked footer string** (substitution like `{{GAPS}}`, function replacement
per DEF-1 so `$` in ids never expands; `{{HARNESS}}`/`{{SESSION}}` are the
two slots):

```
Provenance: when you run `horizon add` or `horizon close`, append
`--harness {{HARNESS}} --session {{SESSION}}` verbatim — it names this
session in the store's record.
```

Composition rule (new spec §10.5): the footer composes when `--session` is
present (harness from `--harness`, then `HORIZON_HARNESS` env, else
`"unknown"`); absent session → no footer (a human running `horizon-inject`
by hand gets none). The footer applies to the block AND both nudges — a
storeless session's first bootstrap add deserves real provenance too.

## D2 — The add teaching becomes honest (one token, three strings)

The CLI is right (ids are chosen, not minted — the friendly-gap-ids ruling);
the text was wrong. Every `horizon add "<one line>"` in the three locked
strings gains the `<id>` argument:

- Block: `offer \`horizon add <id> "<one line>"\`` (was: without `<id>`).
- Bootstrap nudge: `offer \`horizon add <id> "<one line>"\` the same way.`
- Warm nudge: `\`horizon add <id> "<one line>"\` if the user names a want…`

The id's grammar stays where it already lives: the CLI's rejection message
and the docs ("ids are chosen, not minted"). The block does not teach slug
grammar — three sources teaching it was the original disease.

## D3 — Env fallback, terminal users and hook-glue only

`horizon`'s `--session` default chain: flag → `ZCODE_SESSION_ID` →
`HORIZON_SESSION` → `"unknown"` (`HORIZON_HARNESS` already chains for
harness). Verified 2026-09-15: agent shells do NOT carry `ZCODE_SESSION_ID`
(only hook processes do), so env is a fallback for humans at terminals and
forgetful hook-glue — never the primary path. The primary path is D1:
composed into the text the agent reads.

## D4 — Scope and history

- Provenance stays on **add and close** only (the record-join's inputs);
  `amend`/`about`/`detail` remain provenance-free.
- Pre-0.4 records (52 gaps, 33 closes at `"unknown"`) are **left as-is** —
  provenance is advisory evidence, and timestamp-correlated backfill would
  be partly fabrication. The contract gains a one-line note: pre-0.4
  entries carry `"unknown"` honestly.
- Hermes frozen sections: the footer freezes with its session's id; a
  resumed session replays the same id, so staleness is bounded by session
  life. Pre-0.4 frozen sections age out with their sessions.

## Adapter delta (all five, one flag each)

Every `horizon-inject` spawn gains `--session <id>` where the adapter holds
it: zcode `session-start` (payload `sessionId`) and `pre-execute` (payload
`session_id`); hermes `_section_text` (session_info `session_id`) and
`_pre_llm_call` (payload `session_id`); dsh/opencode/pi spawn sites get the
same one-line change at build time (unexercised — verified then, not now).

## Test deltas

- **Test 34 relocks**: all three fences change by the `<id>` token; the
  byte-equality assertion itself is unchanged.
- **New test 37 — footer composition**: footer bytes verbatim with
  `--session`; absent without; `{{…}}` substitution is function-replacement
  (a `$`-bearing session id round-trips); footer appears on block and both
  nudges.
- Test 36 (no-copies) unchanged. Acceptance count 36 → 37.
