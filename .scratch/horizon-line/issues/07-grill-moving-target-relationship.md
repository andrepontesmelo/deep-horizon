# Grilling: horizon-line vs moving-target — supersede, coexist, or merge

Type: grilling
Status: done
Blocked by: —

## Answer

**Coexist.** They are different objects:

- **moving-target** — *what this project IS*: LLM-distilled, descriptive,
  frozen until you update it.
- **horizon-line** — *what we steer toward next*: human-authored, directional,
  moves only with your yes.

That pair goes in both READMEs; CONTEXT.md's Horizon gloss already carries it.

## Decisions (batch 1, single-query mode — recommendations adopted; veto via card comment)

1. **Relationship:** describe it in both READMEs (and CONTEXT.md); neither
   plugin changes behaviour. No absorb, no supersede, no merge.
2. **Coupling:** none. Different stores, no cross-writes; the injected texts
   stay exactly as HL-06 locked them — no cross-reference clause, because the
   no-copies rule (contract §10, test 36) would make it unmirrorable, and
   each block describes itself well enough that adjacency needs no
   explanation.
3. **Injection order:** moving-target first, then horizon-line (identity
   before direction). A fixed convention, decided in practice by harness
   mount order (cordis.patch.yml insert order in DSH). Not configurable,
   nothing enforced in code. Both gates already agree: startup/new sessions
   only.
4. **Code reuse:** pattern only. HL imports nothing from MT; the
   `agent/session-start` hook pattern, startup-only guard, subagent
   exclusion, and pure `injectionText()` split are re-implemented against
   HL's contract (CLI-as-core makes an npm dep useless to the Hermes adapter
   anyway). MT keeps shipping independently; its LLM update path is not
   reused.
5. **`.moving-target/`:** unchanged, stays MT's store, gitignored per MT's
   README. HL-08 decides `.horizon/`'s commit-vs-gitignore independently.
   Sole recorded future coupling: a bootstrap seeding option (rejected in
   HL-03 r2) would read MT's summary if ever revived.

## Gates this opens

- README wording: the one-line pair above.
- Packaging shape: independent packages; nothing shared except on paper.
- `.moving-target/` future: it has one — MT's own, untouched.

Recorded on the map: **[HL-07 resolved: coexist — different objects,
pattern-only reuse]** under Decisions so far.
