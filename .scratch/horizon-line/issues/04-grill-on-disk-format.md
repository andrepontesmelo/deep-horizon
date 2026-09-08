# Grilling: on-disk format, atomicity, concurrency

Type: grilling
Status: open
Blocked by: 03

## Question

Given the content model from ticket 03:

- Exact path under `.horizon/` and exact file format (plain text? markdown
  with YAML frontmatter, like moving-target's `summary.md`? JSON?).
- The format must be readable by a 3-line shell snippet *and* by TS — which
  constrains it. Which wins where they conflict?
- Atomic write strategy (write-temp + rename?) so a reader never sees a torn
  file.
- What happens when two harnesses write within the same second — last-write
  wins, lock, or refuse?
- Encoding/newline rules, and how the 512-char cap is counted (bytes? UTF-16
  code units? Unicode code points? moving-target's CLI already had a
  surrogate-pair bug class here).
- Is `.horizon/` committed or gitignored by default, and does the tool write a
  `.gitignore` for it?
