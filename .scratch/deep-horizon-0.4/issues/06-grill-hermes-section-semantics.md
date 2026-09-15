# Grill: Hermes section semantics — nudge, candidates, subagents

Type: grilling
Status: closed (resolved 2026-09-15, AFK-authorized — see map Notes)
Blocked by: [02 Hermes hook payload audit](02-research-hermes-hook-payloads.md) ✅

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

## Resolution

**F2 reframed: the post-update silence is correct; the pre-update nudge was
the bug.** Ticket 02 pinned the mechanism — 0.21.2 resolves the
`terminal.cwd: "."` placeholder to `$HOME`, so telegram/cron sessions now
carry `cwd=/home/andre`, and `horizon-inject`'s own $HOME-silent rule
answers `""`. That is the build map's "silence on absence" philosophy
holding, not failing: gateway home sessions were never project-dir sessions,
and their horizons arrive via the param path (5 proven deliveries). The
actual bug was the **candidate defer**: pre-update, the empty cwd fell back
to the process cwd (`/home/andre/.hermes`) and froze its storeless *nudge*
into sessions doing store-covered work — F5's false nudge.

1. **Candidate rule:** a non-empty session cwd is the **only** candidate
   (no process-cwd defer for it — that defer existed for the pre-0.21.2 `""`
   cwd shape, which the update killed); an empty cwd still falls back to
   the process cwd. Post-update gateway sessions: `/home/andre` → silence,
   correct. The `.hermes` false nudge becomes unreachable.
2. **Nudge truth:** the false-nudge family dies with the candidate rule.
   Kanban scratch-cwd sessions still see a project-dir nudge (a storeless
   non-$HOME dir) — legitimate, and ticket 11's worktree workspaces removes
   the scratch shape itself. The frozen-nudge-plus-param-block contradiction
   (2 sessions) is **accepted and bounded**: the section freezes once, the
   param block arrives later and real; they cannot be reconciled without
   rewriting frozen prompts. Documented, not engineered.
3. **Subagents:** the param path already excludes them (the
   `parent_session_id` guard, present since July). The section path accepts
   the noise — no discriminator exists in the mapping, `HORIZON_SUBAGENT`
   has no natural setter, and dropping the section for cwd-less session-info
   would silence real sessions too. Fail-open, the pi adapter's trade,
   carried as the map's upstream ask to hermes.
