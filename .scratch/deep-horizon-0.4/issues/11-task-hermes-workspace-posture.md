# Task: Hermes workspace posture — worktree workspaces and cron workdir

Type: task
Status: open
Blocked by: —
Graduated from map fog 2026-09-14 (research/02-hermes-hook-payloads.md found
the mechanism is pure config, not code)

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

Two reversible config edits; confirm the exact board/job names with Andre
before writing (board: casa-gungalilin; job: the HKRC harness supervisor
cron). Record what was done and the post-change evidence here — tickets 05
and 06 cite this as the deployment posture their rules ride on.

## Why it matters

No plugin code can fix a session that launches in a storeless scratch dir;
the fix is where hermes launches sessions. This also settles whether ticket
06's nudge policy needs to tolerate scratch-cwd kanban sessions at all.
