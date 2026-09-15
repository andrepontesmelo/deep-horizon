# Evidence base: the Sep-14 session analysis

The fact-source for every ticket on this map. Three parallel forensic passes
(hermes state.db + logs, zcode db/logs/markers, filesystem store sweep) over
the last ~20 sessions per harness. Nothing here is speculation; every claim
carries its evidence path. Tickets zoom in as needed — this file is the
low-resolution whole.

Machine context: plugin v0.3.0, installed as a **symlink**
(`/home/andre/.npm-global/lib/node_modules/deep-horizon -> ~/git/horizon-line`),
so repo and install share fate. Hermes plugin copy at
`~/.hermes/plugins/deep-horizon/` is byte-identical to the repo adapter.
ZCode global hook config: `~/.zcode/cli/config.json`.

## The ten findings, ranked

### F1 — Session records effectively never land (write path dead)

Machine-wide total: **2 records ever** — `test-manual-001` (manual test,
horizon-test-alpha) and `20260912_131304_36f45d` (the one kanban session that
ran inside a real git worktree with its own store,
`.worktrees/t_6c4be653/.horizon/sessions.jsonl`). **0 of the last ~40
sessions** (20 hermes + 20 zcode) left a record.

- Hermes cause: `_session_store` is stashed **only** in `_section_text`
  (`adapters/hermes/deep_horizon.py:267`). The `pre_llm_call` param path
  injects a store's horizon but discards the store (`:590`) — 5 telegram
  sessions demonstrably received the casa-gungalilin block this way and can
  never be recorded. Finalize fallback resolves the process cwd
  (`/home/andre/.hermes`, storeless) → `horizon session-end` no-ops.
- ZCode cause: the close duty is an instruction ("offer session-end at
  wrap-up"). Agents read it, reason "not wrapping up yet", and never revisit —
  observed verbatim in sess_c31ca372, sess_5b0e5f57, sess_2a8fb399 reasoning
  traces. No re-prompt exists; the Stop hook is `enabled: false`.
- Bonus: `recordSession`'s `gaps_added`/`gaps_closed` join compares the
  record's real session id against closes that all carry `"unknown"` (F6), so
  even a landed record would show empty deltas.

### F2 — Hermes section dark since the Sep-13 hermes update

`agent.log.1:3525` shows the last successful section render at
`2026-09-13 00:55:55` (411 chars). After the hermes update
(`~/.hermes/update.log`, started 2026-09-12T20:38:02) the gateway prompt cwd
moved from `/home/andre/.hermes` to `/home/andre`. `horizon-inject --cwd
/home/andre` answers `{"text":"","store":null}`, and `_section_text` keeps
the **first** candidate's answer even when empty — returns "" though
candidate 2 (launch dir) still answers the nudge. No errors logged: by-design
fail-open silence. Since Sep 13 the param trigger is the plugin's **only
live hermes injection**.

### F3 — ZCode param trigger merged but never wired

`adapters/zcode/pre-execute` exists in the 0.3.0 install, but
`~/.zcode/cli/config.json` `hooks.events` has only `SessionStart` and a
disabled `Stop` — no `PreToolUse` anywhere (project configs empty or
trust-blocked; 11 `config.project_hooks.pending_trust` warnings in zcode
logs). README's install block includes the PreToolUse hook; the user never
added it. Live consequence: the Sep-14 career-ops session created its own
store mid-session (12:53) and kept the storeless nudge it got at 12:52.

### F4 — ZCode injections don't survive app restarts

`additionalContext` is not persisted to the session history DB (zero hits for
horizon text in the zcode `message` table). sess_4a710891: marker proves
session-start fired 21:49; its 22:05–22:14 full-context requests contain zero
horizon text. The adapter's "resume replays the original injection" premise
holds only within one app instance.

### F5 — False and contradictory injections on hermes

Pre-update, 13 of 17 prompt-carrying sessions froze a "no horizon yet" nudge
while doing store-covered work; two sessions (`20260912_144649_90c98801`,
`20260912_110024_5194a066`) held the nudge **and** the param-injected real
casa block simultaneously. Kanban sessions since the Sep-12 hermes update run
in `~/.hermes/kanban/boards/casa-gungalilin/workspaces/t_*` scratch dirs
(no `.horizon`, verified `ls`) instead of git worktrees → nudge instead of
horizon. Cron "HKRC harness supervisor" sessions touch the HKRC repo daily
via tool params yet never got its horizon and never record.

### F6 — Provenance is "unknown" by construction; the spec teaches an invalid command

All 52 gaps across 24 repos carry `{harness:"unknown", session_id:"unknown"}`;
all 33 closes carry `"unknown"` ids. Cause chain: `src/cli.ts:221-223`
defaults, **no env detection** (not even `ZCODE_SESSION_ID`, which the zcode
adapter itself documents as exported), and `src/texts.ts` never mentions
`--harness/--session`. Worse: the injected block teaches
`horizon add "<one line>"` — **a usage error** (`add` requires `<id> <text>`,
`cli.ts:176-179`); an agent following the locked §10 text literally gets
exit 2. §10 strings are byte-locked by acceptance test 34 — amending them is
a spec change (0.4.0), which is why this is a decision, not a bugfix.

### F7 — Duplicate ZCode startup injection

sess_15c584a4 (the Sep-14 analysis session itself): two zcode app instances
started 0.8 s apart (`bootstrap.app.startup.started` 04:53:12.248Z and
04:53:13.028Z), both ran session-start, and the script seeds its marker
unconditionally (no `known()` check, unlike pre-execute) → identical
`d`/`s` pairs twice in the marker, identical horizon block twice in context.
Interacts with F4: a genuine restart *should* re-inject (context lost it) —
the dedup key can't be the bare session id.

### F8 — Subagent exclusion never fires on hermes

40 subagent sessions since Sep 10 carry the deep-horizon section: the live
session-info mapping exposes no parent/depth discriminator and
`HORIZON_SUBAGENT` is unset (nobody sets it for `delegate_task` children).
Fail-open guard injects noise into every delegated child.

### F9 — Store topology undermines "one shared store"

casa-gungalilin: 17 byte-identical store copies (main + 16 git worktrees —
committed `.horizon` means each worktree checkout forks the store; silent
divergence on first write). horizon-line's 3 worktree stores already diverged
(rev 8, stale about-line vs main rev 17). The one successful record (F1)
landed in a worktree store, invisible to the main store. Commit discipline:
only 2 of 24 repos track `.horizon`; `closes.jsonl` is committed **nowhere**
(in horizon-line the root `.gitignore` whitelist actively excludes it).

### F10 — Zero observability

ZCode logs contain no hook execution records at all; hermes logs only
`capability_check ... deny` lines. Fail-open means every failure above was
invisible by construction — all ten were found by forensics, not by signals.

## Session counts

- Hermes last 20: 6 telegram, 8 kanban, 2 cron, plus resets/subagents.
  Param-trigger injections persisted in 5 telegram sessions' `api_content`
  (msgs 102440, 103061, 104103, 104247, 104398). 1 record (the worktree one).
- ZCode last 20: all 20 in horizon-backed projects; ~15 provable
  session-start injections (14 full + 1 storeless nudge). 0 records. No
  `horizon session-end` in `~/.bash_history`.

## Machine-state facts later tickets depend on

- `sessions.cwd`/`git_repo_root` are NULL for every gateway session in
  hermes state.db (91/1178 rows have cwd, all `source=cli`, last Sep 11).
- ZCode `model-io-*` rollout files rotate aggressively (3 survive) — API-layer
  evidence is ephemeral.
- The zcode hook-probe doc (`adapters/zcode/*` headers) was proven against
  ZCode **3.11.2-22**; the current installed version is unverified.
- Hermes updated 2026-09-12 20:38 — payload shapes cited in the adapter
  (`plugins_dispatch.py:396`, `:159`) were verified 2026-09-10/11, i.e.
  **pre-update**; the update is the prime suspect for F2 and the kanban
  workspaces-cwd change.
