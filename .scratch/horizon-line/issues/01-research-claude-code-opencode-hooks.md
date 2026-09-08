# Research: Claude Code + opencode session-start injection surfaces

Type: research
Status: open
Blocked by: —

## Question

For **Claude Code** and **opencode**, what is the exact, currently-shipping
mechanism by which a plugin/hook can inject text into a session *before the
user's first turn*?

Answer for each harness:
1. Hook/plugin name and where it is configured (file path + schema).
2. Whether the injected text lands as system context, a user message, or is
   prepended to the first prompt — and whether the model actually sees it.
3. Whether the hook can distinguish a NEW session from a resumed/compacted one
   (moving-target relies on this: it injects only on `startup`).
4. Whether subagent/child sessions fire the same hook, and how to exclude them.
5. Whether the hook can shell out to a binary and use its stdout.
6. Version the answer is true for.

## Anti-fabrication

Read the harness's own documentation or source. If a capability cannot be
confirmed, say so explicitly and name what was checked. Do not infer a hook
exists because a similar one does in another tool.
