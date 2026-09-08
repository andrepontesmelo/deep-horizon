# Research: session-END hook surfaces across all five harnesses

Type: research
Status: open (card t_0ba9fbe3)
Blocked by: —

## Question

Mirror of tickets 01/02, which covered session *start*. Andre wants a
session-close hook that asks the agent to write a short summary of the
session, appended to the store with date-time, harness name and the harness's
own session id.

For each of Claude Code, opencode, DSH, Hermes, pi:

1. Is there a session-end/close/stop/exit hook? Name, config path, schema.
2. Does it fire on ALL exits — quit, Ctrl-C, SIGTERM, crash, timeout — or only
   graceful ones? Name the uncovered exits.
3. **Can the hook elicit model text at close time**, or is it a fire-and-forget
   observer with no model access? A hook that cannot elicit model output cannot
   produce a summary. This is the question the design hangs on.
4. Can it shell out and pass text (stdin/args)?
5. Does it receive the harness's own session id, and where does that id come
   from? Needed as the cross-harness join key.
6. Do per-harness transcripts exist on disk that a summary could be derived
   from *later* instead of at close time? Path + format.
7. Version the answer is true for.

## Why it matters

If close-time model access is unavailable in most harnesses, the summary must
be produced another way: written mid-session when the agent already has
context, derived post-hoc from transcripts by a separate pass, or dropped.
