# Grilling: packaging + distribution across five harnesses

Type: grilling
Status: done
Blocked by: 01, 02

## Question

Given what tickets 01 and 02 find out about each harness's hook surface:

- One repo, one npm package with optional adapter entrypoints — or a monorepo
  publishing `deep-horizon-core` plus `deep-horizon-{dsh,opencode}`?
- Is the CLI installed globally (`npm i -g`), via `npx`, or vendored per
  harness? Claude Code / Hermes / pi shell out to it, so its PATH story is
  load-bearing.
- Minimum install ceremony per harness, written as the literal commands that
  go in the README.
- Which harness ships first, and which is the reference implementation?
- Does a harness with no session-start hook get a degraded adapter (e.g.
  manual `/horizon` command) or no adapter at all?
- License and publish target (MIT + public GitHub, matching the rest of the
  portfolio?).
