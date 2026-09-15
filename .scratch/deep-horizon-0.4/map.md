# Deep Horizon 0.4 — wayfinder map

Label: `wayfinder:map`
Started: 2026-09-14
Predecessor: [`.scratch/deep-horizon/map.md`](../deep-horizon/map.md) — the
build map, complete. This map charts the **recovery**: what the first
production deployment taught, and what 0.4.0 must decide before it is built.

## Destination

deep-horizon **0.4.0**, where the write path works and the read path is
honest, proven on this machine: every hermes and zcode session that receives
a horizon **leaves a session record with real provenance**; injections are
never dark, false, duplicated, or silently lost; deployment **wires itself**
(and lands from the npm registry). The §10 texts and CLI contract are amended
as a versioned 0.4.0 change where the fix requires it. dsh/opencode/pi
inherit core changes untested.

The map is done when nothing is left to decide before the 0.4.0 build: the
close mechanism per harness, the section/param semantics, the spec
amendments, the store topology policy, the observability shape, and the
install path are all locked.

## Notes

- Domain: agent-harness plugins, cross-tool interop, prompt injection at
  session start, session-end recording. Glossary: repo `CONTEXT.md`.
- Skills every session should consult: `grilling`, `domain-modeling`,
  `wayfinder`. For zcode evidence work: the `zcode-guide:diagnosing-hooks`
  and `zcode-guide:diagnosing-plugins` skills.
- **Evidence base**: [`research/00-session-analysis-findings.md`](research/00-session-analysis-findings.md)
  — the ten findings (F1–F10), ranked, with paths. Every ticket starts there.
- Standing preference (inherited from the build map): live evidence only. No
  harness API is assumed until read in that harness's own source or docs —
  the zcode adapter's probes were against 3.11.2-22 and hermes's payload
  shapes were verified pre-update; both are now suspects, not facts.
- Scope locked at charting (Andre, 2026-09-14): core + hermes + zcode;
  deployment/registry folded in; spec amendable (0.4.0); store topology
  decided-not-built; minimal observability.
- Fail-open (D2) stays the default posture unless a ticket explicitly
  decides otherwise — the recovery fixes *what* fail-open silently drops,
  not the posture itself.
- Tracker: local markdown, this directory. Kanban cards spawn at
  implementation start (per the build map's "task tracking stays on Kanban"
  rule), not during charting.

## Decisions so far

- [Scope: core + hermes + zcode](#) — dsh/opencode/pi inherit core changes
  (texts, CLI, store) automatically but get no harness-specific work or
  verification; they are unexercised on this machine (2026-09-14 grilling).
- [Deployment is in scope](#) — the destination includes a real npm registry
  release (supersedes the machine-local symlink install) and an install path
  that wires hooks itself or fails loudly, so "merged but not wired" (F3)
  cannot recur.
- [The spec is amendable](#) — §10 texts and the CLI contract may be amended
  as a versioned 0.4.0 change. A locked string that teaches a command the CLI
  rejects (F6) is a spec bug, not a constraint to work around.
- [Store topology: decide, don't build](#) — one grilling ticket settles the
  worktree policy and commit defaults (F9); sync/merge machinery stays out.
- [Observability: minimal](#) — one shared debug-log mechanism riding the
  core (F10); no per-adapter inventions.
- [ZCode hook surface re-probe](research/01-zcode-hook-surface-reprobe.md) —
  installed zcode is still 3.11.2-22 (byte-identical bundle; no probe
  regressed). No session-close hook exists (the 7-event enum is exhaustive),
  **but Stop can steer**: `{"decision":"block","reason":"…"}` injects the
  reason as context, with a `stopHookActive` flag and a 3-per-turn cap — an
  enforcement point ticket 03 can use. SessionStart fires **once per app
  instance** (`sessionStartHookRan` latch), and matcher `"startup|resume"`
  is the supported spelling for restart re-injection. `additionalContext`
  confirmed ephemeral (0 persisted rows in 15,208). Global
  `~/.zcode/cli/config.json` needs no trust and is installer-writable;
  project hooks are trust-gated with stale-prone grants, and declaring a
  hook in both global and project double-fires. `ZCODE_SESSION_ID` /
  `ZCODE_PROJECT_DIR` exported to every hook fire.
- [Spec 0.4.0 — provenance and honest commands](07-spec-amendment.md) —
  provenance rides the injected text: a locked footer (new §10.5, composed
  by `horizon-inject` outside the byte-lock, like the about-prefix) carries
  `--harness <h> --session <id>` verbatim, so the agent copies flags instead
  of remembering them; the three locked strings gain the `<id>` token
  (`horizon add <id> "<one line>"` — the CLI was right, the text was wrong);
  env (`ZCODE_SESSION_ID`/`HORIZON_SESSION`) is a terminal-user fallback
  only — agent shells provably lack it; provenance stays on add + close;
  pre-0.4 "unknown" records left as-is; every adapter spawn gains
  `--session`; test 34 relocks, new test 37 guards the footer.
- [Hermes hook payload audit](research/02-hermes-hook-payloads.md) — hermes
  0.21.1→0.21.2 (Sep 12 20:38). session_info keys unchanged; F2's trigger is
  `terminal.cwd: "."` now resolving to `$HOME`, so telegram sessions carry
  `cwd=/home/andre` (storeless, and $HOME stays silent by rule). Finalize
  fires **only** on /new, /reset, gateway shutdown, TUI close —
  `cron_complete`/`cli_close`/`agent_close`/`compression` book DB rows but
  fire **no hook** (cron's finalizer is disarmed by design). `pre_llm_call`
  has carried `parent_session_id` since July — the param path CAN exclude
  subagents; the section mapping still cannot (F8 narrowed to the section
  only). Kanban worktree workspaces (`--workspace worktree:<repo>`, board
  default workdir) and cron `workdir` are **pure job/board config**. Gateway
  PATH resolves the horizon shims (load-bearing: the plugin's `../../bin`
  repo shortcut resolves to `~/.hermes/bin` in production).

## Not yet specified

- 0.4.0 release mechanics: publish checklist, symlink→registry cutover on
  this machine, migration of existing stores. (Retro-repair of `"unknown"`
  provenance is decided — leave it — per
  *Spec 0.4.0 — provenance and honest commands*.)
- Retroactive session records: hermes state.db + zcode db hold enough ground
  truth to backfill records for the ~40 analysed sessions — worth doing once,
  by hand or script? Decide after the close mechanisms land.
- Upstream hermes asks: the section mapping's missing parent/discriminator
  key and the finalize payload's missing cwd are hermes-core gaps the plugin
  works around — does 0.4.0 file/carry upstream issues for them, or is the
  workaround the permanent shape? Depends on tickets 05/06.
- ZCode subagent start-phase: today's subagent sessions pass the SessionStart
  phase at 0 ms with no marker — the hook appears not to run for them, but
  the mechanism is UNVERIFIED (ticket 01). Verify before ticket 04 trusts
  it as an exclusion story.
- Build-time verification that the dsh/opencode/pi spawn sites actually pass
  `--session` (the amendment's one-flag delta is mechanical but unexercised
  on this machine).

## Out of scope

- dsh/opencode/pi harness-specific work (beyond free core changes) — the
  five-adapter build map already shipped them; this recovery walks only where
  sessions actually ran.
- Any server or sync component for stores (filesystem remains the bus).
- Store-merge machinery — topology gets a policy, not tooling.
- Unsanctioned agent writes; LLM-authored gaps (carried over from the build
  map, unchanged).
- GitHub Issues (Kanban + this tracker only).
- Backfilling or rewriting existing stores' history as a *product feature* —
  a one-time local repair may fall out of the fog above, but store history
  rewriting as a shipped capability does not.

## Ticket index

Created and wired at charting; open tickets live in `issues/`.

| # | Name | Type | Blocked by |
|---|---|---|---|
| 01 | [ZCode hook surface re-probe](issues/01-research-zcode-hook-surface-reprobe.md) | research | — |
| 02 | [Hermes hook payload audit](issues/02-research-hermes-hook-payloads.md) | research | — |
| 03 | [ZCode session-end mechanism](issues/03-grill-zcode-session-end.md) | grilling | 01 |
| 04 | [ZCode re-injection and dedup across app instances](issues/04-grill-zcode-reinjection-dedup.md) | grilling | 01 |
| 05 | [Hermes finalize store selection](issues/05-grill-hermes-finalize-store.md) | grilling | 02 |
| 06 | [Hermes section semantics — nudge, candidates, subagents](issues/06-grill-hermes-section-semantics.md) | grilling | 02 |
| 07 | [Spec 0.4.0 — provenance and honest commands](issues/07-grill-spec-provenance-commands.md) | grilling | — |
| 08 | [Store topology — worktrees and commit defaults](issues/08-grill-store-topology.md) | grilling | — |
| 09 | [Hook observability shape](issues/09-grill-observability.md) | grilling | — |
| 10 | [Install wiring and the registry release](issues/10-grill-install-wiring.md) | grilling | 01 ✅ |
| 11 | [Hermes workspace posture — worktree workspaces and cron workdir](issues/11-task-hermes-workspace-posture.md) | task | — |

01 and 02 closed at charting (their resolutions are in Decisions so far).
Frontier after research: **03, 04, 05, 06, 07, 08, 09, 10, 11** — all HITL
grilling except 11 (AFK task). Andre was AFK at charting; the grilling
tickets wait for him.
