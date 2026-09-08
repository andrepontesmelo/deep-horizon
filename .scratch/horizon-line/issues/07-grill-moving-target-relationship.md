# Grilling: horizon-line vs moving-target — supersede, coexist, or merge

Type: grilling
Status: open
Blocked by: —

## Question

moving-target already injects a project-goal paragraph at DSH session start.
horizon-line will inject an aim at session start too. On a DSH project with
both installed, the model gets two goal-shaped blocks before the user speaks.

- Are they genuinely different objects — "what this project IS" (moving-target,
  LLM-distilled, descriptive) vs "what we are steering toward next"
  (horizon-line, human-authored, directional)? If so, say it in one line each,
  and that line goes in both READMEs.
- Does horizon-line supersede moving-target, absorb it, or sit beside it?
- If they coexist: injection order, and does either mention the other?
- Does horizon-line reuse moving-target's npm package/code, fork it, or share
  only the pattern?

This decision gates the README, the packaging shape, and whether the
`.moving-target/` directory has a future.
