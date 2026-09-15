# Grill: Store topology — worktrees and commit defaults

Type: grilling
Status: closed (resolved 2026-09-15, AFK-authorized — see map Notes)
Blocked by: —

## Question

F9, decided-not-built (charting scope). Two linked policies:

1. **Worktrees.** A committed `.horizon` means every `git worktree` checkout
   forks the store: casa-gungalilin has 17 copies one write away from silent
   divergence; horizon-line's 3 worktree stores already diverged; the only
   successful session record landed in a worktree, invisible to the main
   store. Candidate policies: (a) don't commit gaps.json (each checkout its
   own store, main repo canonical by convention); (b) commit and accept
   forks (document "the worktree you work in is the store you move");
   (c) resolveStore skips a store whose git dir points at a worktree and
   walks to the main checkout (one store per repo, machine-locally). Each
   breaks something — pick the breakage.
2. **Commit defaults.** 22 of 24 stores are untracked; `closes.jsonl` is
   committed nowhere and is actively excluded in horizon-line's root
   `.gitignore` whitelist. What does `horizon init` write, and what does the
   README teach: commit gaps.json only (current whitelist), commit
   closes.jsonl too (the close audit trail travels), or commit nothing?

## Why it matters

"One shared .horizon store per project" is the product's one-sentence
premise; worktrees and git discipline currently make it "one store per
checkout, mostly invisible". This ticket restores the premise by policy —
machinery stays out of scope.

## Resolution

**gaps.json is the shared truth and git's merge reconciles worktrees;
sessions.jsonl and closes.jsonl are machine-local by design.**

1. **Worktrees — option (b), reframed:** a committed `gaps.json` does not
   fork the store; it **branches** it, and `git merge` reconciles it, because
   a committed file rides the worktree's branch like any other. The 17 casa
   copies are 16 task branches plus main — divergence is branch state, and
   merging the task branch home carries the gaps.json changes with it. What
   does NOT ride merges are the append-only logs (gitignored everywhere,
   written concurrently by design, no-lock per HL-04) — so they stay
   **machine-local per checkout**: a worktree's sessions.jsonl is that
   checkout's diary. The trade, stated once in the README: *what* is
   open/closed travels with git; *when and in which session* stays on the
   machine where it happened. The HL-03-r4 query ("when did this gap close,
   which session") is answered machine-locally — accepted.
   Rejected alternatives: (a) uncommitting gaps.json breaks the committed
   -store practice casa and horizon-line already run and the cross-machine
   story; (c) resolveStore walking to a main checkout is machine-local magic
   that desynchronizes a task branch from its own gaps.
2. **Commit defaults:** commit `gaps.json` (+ the nested `.gitignore` /
   `.gitattributes`), never the jsonl logs — which is exactly what
   horizon-line's root whitelist already implements; that whitelist is the
   canonical pattern. `horizon init`'s closing output gains one line
   teaching "commit gaps.json"; the README gains the worktree paragraph
   above. The 22 untracked stores are a docs problem, not a tooling one —
   no migration, no nagging.
