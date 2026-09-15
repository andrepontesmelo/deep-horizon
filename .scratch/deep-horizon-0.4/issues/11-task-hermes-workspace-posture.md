# Task: Hermes workspace posture — worktree workspaces and cron workdir

Type: task
Status: closed (executed 2026-09-15 by the orchestrator after the delegated
agent died on a rate limit; behavioral proof pending next fire/task)

## Question

F5's kanban half and the cron silence both dissolve into hermes **job/board
config** per the Hermes hook payload audit: kanban tasks can run in real git
worktrees (`--workspace worktree:<repo>` per task, or a board default
workdir → `<repo>/.worktrees/<task-id>`), and cron jobs accept a `workdir`
field that lands in the section cwd. The work:

1. Set the casa-gungalilin board's default workdir (or per-task policy) to
   the worktree form, so kanban sessions launch inside
   `/home/andre/git/casa-gungalilin/.worktrees/<task-id>` — a real store
   (already committed in that repo) instead of a scratch dir.
2. Set the HKRC supervisor cron job's `workdir` to
   `/home/andre/git/hermes-kanban-recovery-controller` so the daily 05:00
   run finally sees its own horizon.
3. Verify live: one kanban task and one cron run afterwards — section
   injects the real horizon (not the nudge), and — once ticket 05's rule
   lands — finalize records land in the right stores.

## Resolution

Executed 2026-09-15 via the hermes CLI (both changes one field each,
reversible):

1. **HKRC cron workdir** — `hermes cron edit 1369f0027b78 --workdir
   /home/andre/git/hermes-kanban-recovery-controller`. Verified in the
   job listing. The repo's store is healthy (0 open gaps, about line set →
   the about+warm-nudge composition). Next 05:00 fire launches with that
   cwd → the section composes the real horizon. Reverse: `hermes cron edit
   1369f0027b78 --workdir ""`.
2. **Casa board workdir** — the `casa-gungalilin` project (primary
   /home/andre/git/casa-gungalilin) was already board-bound; re-ran
   `hermes project bind-board casa-gungalilin casa-gungalilin`, which wrote
   the board's `default_workdir` to the repo path (verified in
   `~/.hermes/kanban/boards/casa-gungalilin/board.json`). Effect at task
   creation: tasks with workspace kind `worktree` get the deterministic
   `<repo>/.worktrees/<task-id>` (committed `.horizon` present in every
   worktree); tasks with kind `dir`/`worktree` and no explicit path inherit
   the repo root as workdir (store resolves there directly). Reverse:
   `hermes kanban boards set-default-workdir casa-gungalilin` (omit path).

**Honest limit:** tasks created plain still default to `workspace_kind:
scratch` — the scratch default is hermes-core task-creation behavior, not
board config. Mitigation is habit/README: create casa tasks with
`--workspace worktree`. Recorded as a residual, not a plugin gap.

**Pending behavioral proof** (cannot be observed from here): the next
HKRC fire (05:00) and the next casa task with worktree/dir kind should show
the real horizon (about line + block/nudge) in their system prompts —
checkable via hermes state.db system_prompts or agent.log
`id=deep-horizon … chars=` lines. Cron *recording* remains uncovered
(finalize fires no hook for cron — ticket 05's documented degradation).
