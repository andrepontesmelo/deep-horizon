# Grilling: what IS a horizon line, exactly

Type: grilling
Status: open
Blocked by: —

## Question

Pin down the domain object before any code exists.

- Is the line one sentence, or a short paragraph capped at 512 chars?
- Does it carry metadata (author, set-at timestamp, harness that set it), or
  is it bare text?
- Does setting a new line **replace** the old one, or supersede it with the
  old one retained?
- Is there any state beyond "current line" — e.g. reached, abandoned, paused?
- Who may write it: human only, or may an agent call the CLI mid-session?
- What does the *absence* of a line mean, and what happens at session start
  then — silence, or a nudge to set one?

Resolution must produce a written definition precise enough that ticket 04
(format) and ticket 05 (CLI contract) can be specified without re-asking.
