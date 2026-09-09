# HL-06 prototype: the two injected texts

Status: awaiting Andre's pick
Date: 2026-09-08
Redone against the gap-list model (HL-03 r3/r4). The earlier version at commit
`08f6bfd` was written for the superseded single-line, human-only-authored
model and is void.

Two texts are needed, not one:

- **The horizon block** — injected when the project has open gaps.
- **The nudge** — injected when it has none.

`{{GAPS}}` is `horizon show` stdout verbatim: one line per gap, `id␣␣text`,
insertion order, no header or footer (HL-05 §3.1).

Everything below is the literal string. Judge them as text, not as
descriptions.

---

## The horizon block — three variants

### Variant A — Terse

```
Horizon for this project:

{{GAPS}}

These are gaps: things wanted that don't exist yet. They span sessions — you
are not expected to close any of them today, and most sessions won't. Don't
treat them as this session's task list.

If the user describes something they want that won't be finished in this
session, offer to add it: `horizon add "<one line>"`. If a gap looks delivered,
say so and offer `horizon close <id>`. Never run either without the user
agreeing first.
```

**Bet:** the shortest thing that carries every constraint. Survives being the
third injected block because it can be read in one glance. Risk: "you are not
expected to close any of them today" may be too soft a brake for an eager
model.

---

### Variant B — Explicit contract

```
HORIZON — the gaps this project is steering toward

{{GAPS}}

What this is: each line is a gap — a capability the user wants that does not
exist yet. Gaps are deliberately high-level and capped at five. They are the
destination, not the itinerary.

What it is not: a backlog, a task list, or work assigned to this session. A gap
may sit open for weeks across many sessions and that is the normal case. Do not
plan around closing them, do not report progress against them, and do not
mention them again unless they become relevant to what the user is actually
doing.

Your one responsibility: if the user voices a want that clearly won't be
resolved in this session, ask whether to add it as a gap, and run
`horizon add "<one line, max 512 chars>"` only if they say yes. If work in this
session appears to have delivered a gap, point at it and ask whether to run
`horizon close <id>`. You never add or close a gap on your own initiative.
```

**Bet:** the failure mode this project exists to prevent is a model treating
the horizon as today's plan, so name that failure mode explicitly and forbid
it. Risk: long enough that it competes for attention with the user's actual
first message, and "do not mention them again" may over-suppress.

---

### Variant C — Framed as inheritance

```
This project has a horizon — a short list of what the user wants and doesn't
have yet. It was written across earlier sessions, by earlier agents, with the
user's approval:

{{GAPS}}

You have inherited it, not been assigned it. Nothing here is due today. Sessions
that touch none of these are perfectly normal; the horizon exists so the aim
survives between sessions, not so any one session delivers it.

Two things are yours to do. When the user wants something that outlives this
session, offer `horizon add "<one line>"`. When something here looks done, offer
`horizon close <id>`. Both need the user's yes — the horizon is theirs, you only
hold the pen.
```

**Bet:** framing sets behaviour more reliably than instruction. "Inherited, not
assigned" attacks the eagerness at its root, and "you only hold the pen" states
the authorship rule as identity rather than as a prohibition. Risk: the softest
of the three about the mechanics; a model may skim the commands.

---

## The nudge — three variants

Injected when `horizon show` prints nothing. Must be cheap: it appears in every
session of every project that has no horizon, i.e. almost all of them.

### Nudge 1 — Minimal

```
No horizon is set for this project. If the user describes something they want
that will take more than this session, offer to run `horizon add "<one line>"`.
```

### Nudge 2 — With the concept

```
This project has no horizon yet — no list of the gaps it's steering toward. If
the user mentions something they want that won't be finished in this session,
offer to capture it: `horizon add "<one line>"`. Don't prompt them unasked.
```

### Nudge 3 — Silent-adjacent

```
Horizon: none set. `horizon add "<one line>"` if the user names a want that
outlives this session.
```

---

## My picks

**Horizon block: C, with B's second paragraph grafted in.**

C's framing does the heavy lifting — "inherited, not assigned" and "you only
hold the pen" are the two sentences most likely to actually change behaviour,
because they give the model a role rather than a rule to comply with. But C is
vague about what a gap *is not*, and that's exactly where B is strongest.

The hybrid: C's opening and closing, with B's "What it is not" paragraph
inserted after the gap list — minus its "do not mention them again", which
over-suppresses. A gap becoming relevant mid-session is a *good* outcome.

**Nudge: 3.**

It's four lines shorter than the alternatives and appears in nearly every
session you ever start. Nudge 2's "Don't prompt them unasked" is a real
concern, but it costs a line in every session on every project to prevent a
behaviour that the shorter text doesn't especially invite.

---

## Two notes for whoever implements this

1. **`{{GAPS}}` is substituted, never re-formatted.** The adapter pipes
   `horizon show` stdout in as-is. If the text needs bullets or numbering, that
   belongs in the CLI's output (HL-05 §3.1), not in five adapters that would
   drift apart.
2. **These strings live in the core package, not per-adapter.** Five copies
   would diverge within a month, and the whole premise is that every harness
   sees the same horizon — which has to mean the same words about it too.
