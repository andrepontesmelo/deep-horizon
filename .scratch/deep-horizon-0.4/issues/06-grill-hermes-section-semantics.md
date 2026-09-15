# Grill: Hermes section semantics — nudge, candidates, subagents

Type: grilling
Status: open
Blocked by: [02 Hermes hook payload audit](02-research-hermes-hook-payloads.md)

## Question

Three section-callable decisions, one ticket (they share the code path and
the philosophy):

1. **Candidate semantics (F2).** Today the first candidate's answer stands
   when no store appears anywhere — so a storeless `/home/andre` answer
   (text "") beats the launch dir's nudge. But F5 shows the opposite failure:
   the nudge freezing into sessions doing store-covered work was **worse**
   than silence. Decide: defer on empty-text? Defer only on storeless? Is
   the nudge right at all for gateway home-cwd sessions (the build map's
   "silence on absence" was amended to "nudge once" for *project dirs* —
   were telegram/cron sessions ever meant to see it)?
2. **Nudge truth (F5).** Two sessions held "no horizon yet" and the real
   casa-gungalilin block simultaneously; 13 sessions got the nudge for
   store-covered work; kanban scratch-cwd sessions get it by construction.
   Whatever rule lands, a session that has received a param-trigger block
   must not also carry a frozen "no horizon" nudge — decide the
   interaction (does a param injection supersede/annotate the frozen
   section? is the nudge suppressed once any store was touched?).
3. **Subagent exclusion (F8).** 40 subagent sessions carry the section; no
   discriminator exists in the mapping and `HORIZON_SUBAGENT` is set by
   nobody. Given what ticket 02 finds: accept the noise (fail-open, the pi
   trade), or wire the opt-out somewhere real (hermes core change?
   delegate_task spawn env?), or drop the section for sessions whose
   session-info lacks a cwd?

## Why it matters

This is the hermes read path: since Sep 13 it injects nothing (F2), and
before that it injected the wrong thing half the time (F5). The nudge
decision also touches the locked §10 texts if wording changes — flag any
overlap with ticket 07 rather than deciding text there.
