# Grill: ZCode re-injection and dedup across app instances

Type: grilling
Status: closed (resolved 2026-09-15, AFK-authorized — see map Notes)
Blocked by: [01 ZCode hook surface re-probe](01-research-zcode-hook-surface-reprobe.md) ✅

## Question

F4 and F7 pull in opposite directions and must be decided together:

- F4: `additionalContext` is ephemeral — a session resumed in a **new app
  instance** has no horizon in context (proven: sess_4a710891). Re-injecting
  on every `startup` fire would fix this.
- F7: two app instances 0.8 s apart both fired session-start and duplicated
  the block into one context (proven: sess_15c584a4). Re-injecting on every
  `startup` fire would make this the norm, not the accident.

Decide the dedup key and the re-injection rule: per (session id + app
instance)? Per startup timestamp? Does the marker file (currently keyed by
session id alone, seeded unconditionally by session-start) gain a
instance/startup dimension? Should session-start adopt pre-execute's
`known()` check, and what exactly does it check? Also decide the marker's
lifetime: `/tmp` dies on reboot (the Sep-13 reboot erased all markers) — is
that acceptable, or does the marker move to
`~/.cache/deep-horizon/` or the store dir (gitignored)?

## Why it matters

Every zcode session's first-turn context hangs on this: too much dedup loses
the horizon silently (F4), too little duplicates it (F7) — and the current
code does both wrong in different scenarios.

## Resolution

**Matcher widens to `"startup|resume"`; the dedup key is time, not identity.**

Ticket 01 pinned the facts: SessionStart fires once per app instance (the
`sessionStartHookRan` latch), `resume` is a distinct supported source, and
`additionalContext` never persists (0 rows in 15,208). F4's real cause is
the current matcher: a session resumed in a new instance fires `resume`,
which `"startup"` excludes — the context lost the block and nothing
re-delivered it. So: matcher becomes `"startup|resume"` — **every app
instance hands its session the horizon once**, which is precisely the
ephemerality contract the research proves.

F7 (the 0.8 s double-start) is not identity duplication — it is
**simultaneity** duplication: two instances racing for one session id. The
guard is therefore a window, not a key: the marker's seed lines gain an
mtime-anchored form, and session-start suppresses injection only when an
identical seed for this session id was written within the last 10 seconds;
outside that window it injects and seeds unconditionally (a restart hours
later re-injects — that is F4 working). The `known()` exact-line check stays
pre-execute's own (its once-per-store-per-session duty is different and
unchanged).

Marker lifetime: markers move from `/tmp` to
`~/.cache/deep-horizon/markers/horizon-zcode-<sid>` — reboot durability
matters now that ticket 03's reconciliation reads them as the record of
which sessions touched which stores. (The Sep-13 reboot erasing every marker
is the failure being closed.)
