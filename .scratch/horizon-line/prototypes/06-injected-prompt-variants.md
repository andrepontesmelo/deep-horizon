# 06 — Injected prompt: 3 full variants (+ the fixed unset nudge)

Ticket: `issues/06-prototype-injection-text.md`
Status: **awaiting Andre's pick** — pick one, or name the hybrid.
`<LINE>` = the current horizon, verbatim from the store (one line, ≤512 chars,
shown in double quotes per the kickoff draft).

## Fixed by HL-03 r2 — not varied

- The block shows the **current line only**: no dates, no move counts (map
  decision "injected block shows the current line only"). Exception: Variant B
  deliberately includes a provenance line so the ruled-out option can be
  reacted to in context — see its rationale.
- On an unset project the injection is one nudge line, identical for every
  variant. It extends r2's wording ("…offer to run `horizon set`.") with the
  cap reminder; trim it if you want r2 verbatim:

```
No horizon line is set for this project. If the user states a direction, offer to run `horizon set` with it — one line of text, 512 characters max.
```

## The ticket's axes, mapped

| Axis | A — Quiet | B — Explicit | C — Delegating |
|---|---|---|---|
| Discouraging "finish it this session" | one clause | hardest: rule list + "never a completion condition" | one dense sentence, reframed as success |
| Update command named inline? | no (appears only in the unset nudge) | yes: `horizon set` / `horizon amend` + when-to-use | CLI named, subcommands not — human directs |
| Author + date | no (per r2) | **yes, on purpose** — the ruled-out option, shown for reaction | no (per r2) |
| 2nd/3rd-block survival | label in header, nothing positional | heavy self-labelling + explicit self-containment line | label + "belongs to the human alone" framing |

## Variant A — "Quiet"

```
Horizon line: "<LINE>"

This is the project's horizon: the direction the human is steering, pursued over many sessions — not a task to complete in this one. Keep it in mind when paths diverge. Do not start working toward it here, and do not count it against the session that it still stands.
```

Rationale: closest to the kickoff draft. Trusts the model with one clause of
discouragement and no machinery. Risk: a weak model skims the clause and
starts chasing the horizon anyway.

## Variant B — "Explicit"

```
[Horizon line — human-owned, persisted; injected by horizon-line]
"<LINE>"
Set by <human> on <date>.

This block is not a task. The horizon is this project's multi-session aim; your session works on whatever the human asked for this session. Rules:
- Do not start, advance, or try to complete the horizon this session. An unmet horizon is not session failure — it is expected to outlive every session that reads it, and it is never a completion condition.
- Do not expand, restate, or decompose it into plans or task lists. It is high-level on purpose.
- Only the human changes it. If the human says the direction moved: run `horizon set "<new line>"` when the aim itself moved, `horizon amend "<wording>"` when only the wording did. Never run either unprompted — if their request is vague, confirm the exact wording first.
- This block is self-contained: read it as standalone no matter what other injected context surrounds it.
```

Rationale: the maximum-enforcement end. Names the exact verbs and their
boundary (set = horizon moved, amend = wording moved — per HL-03), bans
unprompted runs, hard-codes the "never a completion condition" rule.
**Flag:** the `Set by <human> on <date>.` line contradicts the HL-03 r2
decision (no dates to the model). It is included only so you can see the
ruled-out option in place — drop that one line and B is decision-clean.

## Variant C — "Delegating"

```
Horizon line: "<LINE>"

A horizon is a direction, not a deliverable: it is expected to still be standing when this session ends — that is success, not backlog. Do not start or finish it here, and do not convert it into tasks. When paths diverge, prefer the one that leads toward it. The line belongs to the human alone: when they say it has moved, take down their exact wording and record it with the horizon CLI. Never move it on your own initiative.
```

Rationale: matches the discouragement strength of B in one sentence, but
refuses to name subcommands inline — naming them in every session invites the
model to think about running them. The human says "the direction moved, it's
now X"; the agent records it via the CLI it can discover with `horizon --help`.
Keeps the injected block about behavior, not syntax.

## Survival check — the same block as #2 of 3

What a model actually reads when moving-target injects first and something
else injects third (worked example line; Variant B shown in the middle):

```
[moving-target summary block]

[Horizon line — human-owned, persisted; injected by horizon-line]
"Get horizon-line v1 published: one core, five harness adapters, injection live-proven in all five."
Set by Andre on 2026-09-08.

This block is not a task. The horizon is this project's multi-session aim; …

[other plugin block]
```

All three variants open with their own label (`Horizon line:` or the bracketed
B header), name their own subject, and contain no positional references
("above", "the previous block"). Each parses cold. B additionally tells the
reader it is self-contained.

## If you want a hybrid

Sharpest single line across the three is C's reframe — "it is expected to
still be standing when this session ends — that is success, not backlog." A
plausible hybrid: C's first sentence + A's brevity, B kept in your back
pocket only if agents turn out to need the verbs spelled out to execute
human-requested updates correctly.
