# Grill: Spec 0.4.0 — provenance and honest commands

Type: grilling
Status: closed (resolved 2026-09-15 — see [07-spec-amendment.md](../07-spec-amendment.md))
Blocked by: —

## Resolution

Confirmed in one line by Andre: *"every session's id gets baked into the
horizon text by `horizon-inject` itself (env vars only as a terminal-user
fallback), the block's add teaching becomes the id-first
`horizon add <id> "<one line>"` the CLI actually accepts, provenance stays
on add and close only, and the old 'unknown' records are left alone."*

The full versioned delta — locked footer string (§10.5, composed like the
about-prefix, outside the byte-lock), the one-token `<id>` fix to all three
locked strings, the env fallback chain, scope and history rulings, the
one-flag adapter delta for all five harnesses, and test 34's relock plus new
test 37 — is [`07-spec-amendment.md`](../07-spec-amendment.md).

New facts the grilling established (recorded for downstream tickets): agent
shells do NOT carry `ZCODE_SESSION_ID` (hook processes only — live check
2026-09-15), so env detection was never a sufficient fix; agents coped with
the invalid teaching by reading the docs, which is why 52 gaps landed with
friendly ids but `"unknown"` provenance.

## Question

F6 is a spec bug with three heads; decide the 0.4.0 contract amendment:

1. **The invalid command.** §10's horizon block teaches
   `horizon add "<one line>"`; the CLI requires `add <id> <text>`
   (`cli.ts:176-179`) — an agent following the locked text verbatim gets
   exit 2. Fix which side: CLI accepts a single-arg add (mints the id
   itself — ids are already friendly and minted on add per HL-04, so the
   caller-supplied id buys nothing), or the text teaches the id? (Note:
   agents in the wild evidently coped — 52 gaps exist — but every one
   carries unknown provenance, so how they coped is itself evidence: check
   shell histories/transcripts for what was actually typed.)
2. **Provenance defaults.** `--harness/--session` default to "unknown"
   (`cli.ts:221-223`) and nothing detects env — not even `ZCODE_SESSION_ID`,
   which the adapter documents as exported to hooks. Decide: env detection
   list per harness (ZCODE_SESSION_ID, hermes hook args…), and whether
   texts.ts teaches the flags or the CLI stops needing them.
3. **The dead join.** `recordSession` joins closes by session_id equality;
   with closes at "unknown" and records at real ids, `gaps_closed` is empty
   forever. Once provenance is real this self-heals for future sessions —
   decide whether 0.4.0 does anything about the existing 33 unknown closes
   (leave as-is with a note, or a one-time repair script whose output Andre
   reviews).

Output of this ticket: the §10 amendment text + CLI contract delta, as a
versioned 0.4.0 section (the acceptance tests that byte-lock §10 get new
locked strings — test 34's role survives, its bytes change).

## Why it matters

Provenance is the difference between a session log and a diary (HL-03 r4's
own words); today every record would be provenance-deaf even if records
landed. And a spec that teaches a command its own CLI rejects undermines the
"deterministic CLI" premise the whole design rests on.
