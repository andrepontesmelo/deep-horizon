# Grill: ZCode session-end mechanism

Type: grilling
Status: open
Blocked by: [01 ZCode hook surface re-probe](01-research-zcode-hook-surface-reprobe.md)

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
