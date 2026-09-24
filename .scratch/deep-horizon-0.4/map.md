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
  session start, session-end recording. Glossary: repo `GLOSSARY.md`.
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
- **Execution override (2026-09-15)**: Andre authorized AFK resolution of the
  grilling tickets ("drive the map to conclusion"), waiving wayfinder's
  one-HITL-ticket-per-session rule. Resolutions cite evidence and prior
  rulings (the build map's Decisions and this map's research); every ruling
  stays vetoable — re-open a ticket and the map follows.

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
- [ZCode session-end mechanism](issues/03-grill-zcode-session-end.md) —
  startup reconciliation: at every session-start the adapter scans durable
  markers for prior sessions whose store is this one and runs
  `horizon session-end` for each orphan (store once-guard = idempotent;
  60 s mtime guard spares live sessions). No close hook exists and
  instruction-only close is disproven by data (agents defer correctly, real
  sessions end without wrap-up); the instruction survives demoted to the
  **summary path**. Signal deaths covered by construction — the next session
  reconciles the corpse. Stop-steer stays retired.
- [ZCode re-injection and dedup](issues/04-grill-zcode-reinjection-dedup.md) —
  matcher widens to `"startup|resume"` (F4's cause was the matcher excluding
  resume, not persistence); the F7 double-injection guard is a
  **simultaneity window** (suppress only if an identical seed landed <10 s
  ago), not an identity key — a restart hours later re-injects, which is the
  point. Markers move to `~/.cache/deep-horizon/markers/` (reboot durability
  now matters: reconciliation reads them).
- [Hermes finalize store selection](issues/05-grill-hermes-finalize-store.md) —
  `_session_store` becomes session→**set**: the param path stashes what it
  injects, finalize records once per stashed store (a multi-project telegram
  session leaves one record per project — honest in each). Partial-close
  world accepted and documented: telegram records on /new, /reset, shutdown;
  kanban on TUI close; **cron and compression fire no hook at all** (cron
  injection rides ticket 11's workdir; cron recording is the upstream ask).
- [Hermes section semantics](issues/06-grill-hermes-section-semantics.md) —
  F2 reframed: the post-update silence is **correct** ($HOME-silent rule
  holding); the bug was the pre-update candidate defer freezing the
  `.hermes` nudge into store-covered sessions. Rule: a non-empty session
  cwd is the only candidate (the `""`-cwd shape that needed the defer died
  in 0.21.2); empty cwd still falls back to process cwd. The frozen-nudge +
  param-block contradiction is accepted, bounded to a session. Subagents:
  param path already excludes them; section path accepts the noise
  (fail-open, the pi trade) pending the upstream ask.
- [Store topology](issues/08-grill-store-topology.md) — committed
  `gaps.json` **branches**, not forks: git merge reconciles worktrees,
  because a committed file rides the branch. The jsonl logs stay
  machine-local per checkout (append-only, concurrent, no-lock — never
  merged). The trade, documented once: *what* travels with git; *when and
  in which session* stays on the machine. horizon-line's existing root
  whitelist is the canonical pattern; `horizon init` gains one teaching
  line; no tooling.
- [Hook observability](issues/09-grill-observability.md) —
  `<store>/.horizon/hooks.log`, always-on, one line per **bin** fire
  (injected/nudged/silent/recorded/error) written by the bins themselves —
  adapters inherit logging by shelling out; best-effort, never raises.
  Plus read-only `horizon doctor`: per-harness wiring checks (the F3
  "shipped but not wired" detector), PASS/FAIL + fix hints, exit 0/1.
- [Install wiring and the registry release](issues/10-grill-install-wiring.md) —
  `horizon install --harness <h>` **writes** global config via
  parse→merge→validate→backup→write (never regex; loud failure on unknown
  shapes — ticket 01's whole-config-dies finding bans blind writes);
  zcode gets SessionStart (`startup|resume`) + PreToolUse, hermes gets the
  plugin copy + config.yaml registration. Global-only (project hooks are
  trust-gated, stale-prone, double-firing). 0.4.0 publishes to npm (dist in
  `files`, no lifecycle scripts); cutover here: drop the symlink, install
  from registry, doctor green. Upgrade = re-run install (idempotent merge
  is the migration).
- [Hermes workspace posture](issues/11-task-hermes-workspace-posture.md) —
  executed via hermes CLI: HKRC cron `workdir` → its repo (next 05:00 fire
  sees its horizon), casa board `default_workdir` → the repo via
  `project bind-board` (worktree/dir-kind tasks launch where stores live).
  Residual, honestly recorded: plain-created tasks still default to scratch
  (hermes-core creation default) — habit/README mitigation:
  `--workspace worktree`. Behavioral proof pending next fire/task.

## Not yet specified

(none — the fog is cleared. Items that were here either resolved into
Decisions so far, moved to Out of scope, or became build-time checklist
entries in the Implementation section below.)

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
- **Retroactive session records** for the ~40 analysed sessions — decided
  out at resolution (2026-09-15): one-time value is low, pre-0.4 provenance
  is `"unknown"` anyway, and sessions.jsonl is going-forward truth. The
  forensic record already exists in
  [research/00](research/00-session-analysis-findings.md).
- **Upstream hermes issues** (session_info parent/discriminator key;
  finalize payload cwd; cron finalize) — the plugin's workarounds are the
  permanent 0.4.0 shape; filing upstream is a worthwhile *follow-up effort*
  outside this map, not a ticket on it.

## Ticket index

All tickets closed. 01/02 at charting (research subagents); 07 on
2026-09-15 with Andre live; 03–06, 08–10 on 2026-09-15 under the AFK
authorization (map Notes); 11 executed 2026-09-15 (see its resolution for
the pending behavioral proof).

| # | Name | Type | Resolution |
|---|---|---|---|
| 01 | [ZCode hook surface re-probe](issues/01-research-zcode-hook-surface-reprobe.md) | research | closed — [research/01](research/01-zcode-hook-surface-reprobe.md) |
| 02 | [Hermes hook payload audit](issues/02-research-hermes-hook-payloads.md) | research | closed — [research/02](research/02-hermes-hook-payloads.md) |
| 03 | [ZCode session-end mechanism](issues/03-grill-zcode-session-end.md) | grilling | closed — startup reconciliation |
| 04 | [ZCode re-injection and dedup](issues/04-grill-zcode-reinjection-dedup.md) | grilling | closed — `startup\|resume` + simultaneity window |
| 05 | [Hermes finalize store selection](issues/05-grill-hermes-finalize-store.md) | grilling | closed — every injected store records |
| 06 | [Hermes section semantics](issues/06-grill-hermes-section-semantics.md) | grilling | closed — silence was right; the defer was the bug |
| 07 | [Spec 0.4.0 — provenance and honest commands](issues/07-grill-spec-provenance-commands.md) | grilling | closed — [07-spec-amendment.md](07-spec-amendment.md) |
| 08 | [Store topology](issues/08-grill-store-topology.md) | grilling | closed — gaps.json rides git |
| 09 | [Hook observability](issues/09-grill-observability.md) | grilling | closed — hooks.log + doctor |
| 10 | [Install wiring and the registry release](issues/10-grill-install-wiring.md) | grilling | closed — install writes, doctor verifies |
| 11 | [Hermes workspace posture](issues/11-task-hermes-workspace-posture.md) | task | closed — executed, proof pending next fire |

**The map is complete.** The frontier is empty; nothing is left to decide
before the 0.4.0 build.

## Implementation (post-map)

Build order — six vertical slices, each a build+review pair (per the
orchestrator convention), main stays clean until review passes:

1. **Core amendment** — texts.ts `<id>` token + the §10.5 provenance footer
   (function substitution, DEF-1); inject.ts uses `--session`; cli.ts env
   chain (`ZCODE_SESSION_ID`/`HORIZON_SESSION`); test 34 relock, new test
   37. Slice = core + tests + spec file updated together.
2. **ZCode slice** — matcher `startup|resume`; simultaneity window on
   seeding; markers to `~/.cache/deep-horizon/markers/`; adapters pass
   `--session`; startup reconciliation of orphan markers → `horizon
   session-end`. Slice = adapter scripts + a store-side reconcile helper if
   needed + e2e in /tmp/zcode-e2e style.
3. **Hermes slice** — non-empty cwd is the only candidate; param path
   stashes (session→set); finalize records per store; spawns pass
   `--session`. Slice = adapter + live verification against the gateway.
4. **Observability** — hooks.log (bins) + nested .gitignore line +
   `horizon doctor` (zcode + hermes checks). Slice = core + both check sets.
5. **Topology docs** — README worktree paragraph + commit-gaps.json
   teaching; `horizon init` closing line. Prose slice.
6. **Release** — `npm publish` 0.4.0; `horizon install` (both harnesses);
   local cutover from the symlink; doctor green. Ship slice.

Build-time checklist (fog graduates that need eyes during the build, not
decisions): verify dsh/opencode/pi spawn sites pass `--session`; verify the
zcode subagent start-phase behavior (0 ms no-marker passes suggest hooks
skip subagents — confirm, then document); confirm kanban/cron behavioral
proof when the next task/fire lands after ticket 11's config.

## Outcome (2026-09-15)

Built and deployed the same day, orchestrator-driven: five slices, each
implement→review→merge (all reviews APPROVE; every nit fixed), 228/228
tests on main. Machine cutover from the symlink to a real packed-tarball
install (the registry publish is the one pending step — the npm token in
~/.npmrc is dead, `npm login` needed; `npm publish` from the repo when it
is), `horizon install` wired both harnesses, `horizon doctor` green
(7/7). One live-caught bug fixed post-merge (the session-record union
inherited authorship on close; now witnesses `added_session_id` — test
28b). Horizon gaps closed with real provenance: `close-hook`,
`zcode-param-trigger`; `registry-release` stays open pending the publish.
