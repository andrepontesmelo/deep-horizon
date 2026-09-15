# Grill: ZCode re-injection and dedup across app instances

Type: grilling
Status: open
Blocked by: [01 ZCode hook surface re-probe](01-research-zcode-hook-surface-reprobe.md)

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
