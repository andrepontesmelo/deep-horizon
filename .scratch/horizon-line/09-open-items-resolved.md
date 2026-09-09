# Resolved: the three open items (2026-09-09)

Operator mandate: **"Drive this to conclusion."** These three were left open by
the map and by CLI contract §11 / the packaging doc. Decided here so the
adapter wave has no ambiguity. Operator may override any of them.

---

## A — Gap injection order: **insertion order (oldest first)**

`gaps.json` already stores gaps ordered by `added_at` ascending, and `show`
prints that order. The injected block uses the same order — no re-sorting.

Why not most-recent-first: a model tends to read the first line as the most
important. Under insertion order the first line is the want that has waited
longest, which is the correct default when the list carries no priority field
(HL-04 deliberately made ids non-sequential and gaps priority-free). Recency
ordering would let a fresh want bury a stale one — the exact failure the
horizon exists to prevent.

Consequence: `horizon show`, `horizon log`, and the injected block all agree on
one order. Nothing in the CLI changes; this is a statement of the existing
behaviour.

---

## B — Store in git: **commit `gaps.json`, ignore `sessions.jsonl`**

- `.horizon/gaps.json` is **committed**. The horizon is a repo-level artifact:
  small, human-readable, and the whole point is that it travels — between
  harnesses on one machine, and to a teammate who clones. A gitignored
  `gaps.json` would make the horizon machine-local and invisible in review.
- `.horizon/sessions.jsonl` is **gitignored**. It is append-only machine noise,
  unbounded, and two clones appending to one tracked file produce a merge
  conflict on every pull.

Mechanism: `horizon init` writes a nested `.horizon/.gitignore` containing
`sessions.jsonl` and `*.tmp.*`. Nested `.gitignore` is honoured by git, so the
plugin never touches the repo's root `.gitignore`.

This also means horizon-line's own repo carries a real `.horizon/gaps.json` —
the plugin's own horizon, dogfooded.

---

## C — pi subagent exclusion: **env var, fail-open**

pi has no discriminator for "this session was spawned by the subagent
extension" (research/02 §Part 2 Q4): subagents are an extension pattern that
spawns a **separate `pi` process**, so `session_start` fires there too.

- The adapter skips injection when `HORIZON_SUBAGENT` is set to a truthy value
  (`1`, `true`, `yes`).
- **Fail-open:** absent the variable, injection happens. A subagent that
  receives the horizon is noise, not harm — the block explicitly says the
  horizon is inherited, not assigned.
- Project-local install scope is **rejected** as the mechanism: a child `pi`
  process runs in the same project, so scope does not discriminate.
- The README documents that subagent extensions should export
  `HORIZON_SUBAGENT=1` in the child process environment.

---

## Still open after this (post-v1, unchanged)

- Whether the 5-cap becomes a prompt-to-close rather than a hard reject, once
  the propose-and-confirm flow is real (CLI contract §11).
