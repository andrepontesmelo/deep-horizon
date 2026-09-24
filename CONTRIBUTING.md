# Contributing

Thanks for looking at deep-horizon. PRs welcome.

## Workflow

1. Fork / branch from `main`.
2. Make the change with a test that pins it (`test/`, `node --test`).
3. Run the local gate:

   ```bash
   npm test   # builds dist/, then the full suite (228 tests at time of writing)
   ```

4. Open a PR describing what changed and why.

CI runs the same gate on Node 22; a PR is mergeable when it is green.

## Ground rules

- ESM only, Node >= 22.18, no transpile step, no new runtime dependencies
  without discussion — the package ships zero.
- Every adapter hook fails open: a missing bin, a timeout, or an error injects
  nothing and never blocks a session. A change that makes an adapter fail
  closed needs a discussion first.
- Glossary terms from [GLOSSARY.md](GLOSSARY.md) are used verbatim in comments,
  tests and errors (gap, about, horizon, store).
- The injected surface is one line per gap, at most 5 open gaps, nothing
  machine-generated in the human's words — keep the composer's output
  deterministic.
- Update [README.md](README.md) when the CLI surface or a harness wiring
  changes — the README is the single manual, and the per-harness sections are
  load-bearing documentation, not marketing.

## Reporting bugs

Open a GitHub issue with: the deep-horizon version or commit, the harness
(DSH, Claude Code, pi, opencode, Hermes, ZCode) and its version, and either
the command output or the hook's `.horizon/hooks.log` line. Redact anything
private — the store holds gap text only, but logs can name directories.

## Security

See [SECURITY.md](SECURITY.md) — please do not open public issues for security reports.
