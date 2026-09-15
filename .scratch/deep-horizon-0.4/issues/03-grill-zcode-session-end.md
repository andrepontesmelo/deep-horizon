# Grill: ZCode session-end mechanism

Type: grilling
Status: closed (resolved 2026-09-15, AFK-authorized — see map Notes)
Blocked by: [01 ZCode hook surface re-probe](01-research-zcode-hook-surface-reprobe.md) ✅

## Question

0 of 20 zcode sessions left a record (F1). The instruction-riding-injection
approach ("offer `horizon session-end` at wrap-up") is disproven by data:
agents understand the duty, defer it, and never revisit. What mechanism
closes zcode sessions? Candidate space, to be pruned by what ticket 01 finds:

- A true close hook (SessionEnd), if the current zcode has one — record
  directly, fire-and-forget, `summary: null` (the honest shape the build map
  already blessed for DSH).
- A Stop-hook steer that fires **exactly once per session** (once-guard:
  record-exists check or marker), possibly asking the agent for a one-line
  summary first — the retired `stop-steer` design, resurrected with the
  once-guards that killed its spam problem. The build map retired it because
  "Stop fires at end of EVERY assistant turn"; the once-guard inverts that
  cost.
- A late-session re-injection of the duty (the analysis sessions show agents
  reasoning about it correctly — the failure is timing, not comprehension).
- Hybrid: record-when-quiet — a hook records a session after N minutes of
  inactivity, no agent involvement.

Decide: mechanism, once-guard key, summary policy for zcode (can the
mechanism elicit text, or is `summary: null` the zcode contract?), and what
happens on SIGINT/SIGTERM/closed terminal (the build map's close-hook gap
row — is signal coverage in scope for 0.4.0 or still open?).

## Why it matters

This is the write path's largest hole: zcode is the daily-driver harness and
has never once recorded a session. It also closes the horizon store's open
`close-hook` gap for the zcode row.

## Resolution

**Startup reconciliation writes the records; the instruction survives as the
summary path.** No close hook exists (ticket 01: the 7-event enum is
exhaustive), and the data says instruction-only close fails structurally —
agents defer correctly mid-session, and real sessions end without a wrap-up
exchange, so the offer never fires. Stop-steer stays retired: it fires every
turn, and its once-guarded variant only re-delivers an instruction the
evidence already disproves.

The mechanism that needs no agent and no close hook: at every session-start,
the adapter scans the durable marker store (ticket 04 moves markers to
`~/.cache/deep-horizon/markers/`) for **prior** sessions whose `s` line
names this session's store, checks `sessions.jsonl` for a record, and runs
`horizon session-end --harness zcode --session <sid>` for each orphan. The
store's own once-guard (store.ts:599 — same harness+session_id is a no-op)
makes it idempotent; an mtime guard (skip markers touched in the last 60 s)
keeps live concurrent sessions out of scope. Records carry `summary: null`;
`ts` is the reconciliation write time, which is honest — that is when the
record was written.

The startup instruction stays exactly as shipped, but demoted: it is now the
**quality path** (a real wrap-up yields a real summary), not the load-bearing
one. Free win: signal deaths (SIGINT/SIGTERM, closed terminal — the build
map's open close-hook row) are covered by construction, because a killed
session leaves a marker and the next session reconciles it.

0.4.0 scope: reconciliation covers session-start-visible orphans only; a
project whose sessions all die before any next startup stays unrecorded
until then — accepted, documented.
