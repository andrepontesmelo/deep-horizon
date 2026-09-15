# Grill: Store topology — worktrees and commit defaults

Type: grilling
Status: open
Blocked by: —

## Question

F9, decided-not-built (charting scope). Two linked policies:

1. **Worktrees.** A committed `.horizon` means every `git worktree` checkout
   forks the store: casa-gungalilin has 17 copies one write away from silent
   divergence; horizon-line's 3 worktree stores already diverged; the only
   successful session record landed in a worktree, invisible to the main
   store. Candidate policies: (a) don't commit gaps.json (each checkout its
   own store, main repo is canonical by convention); (b) commit and accept
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
