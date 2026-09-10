# Task: write the CLI contract spec

Type: task
Status: open
Blocked by: 03, 04

## Question

Not a decision — a document. Write the complete, testable contract for the
deterministic CLI, so implementation is mechanical:

- Command surface: `horizon show`, `horizon set "<text>"`, `horizon clear`,
  and whatever ticket 03 adds.
- Exit codes for: success, over-cap rejection, no line set, unreadable store,
  not-a-project.
- Exact stderr text on a >512-char rejection, including the actual count.
- stdout shape for `show` — must be pipeable into a hook with zero parsing.
- A `--json` mode, or an explicit decision that there isn't one.
- The full acceptance-test list a TDD implementation would turn red first.

Done when the spec file is committed under `.scratch/deep-horizon/` and a
developer could implement against it without asking a question.
