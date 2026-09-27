# Releasing

The runbook, executed top to bottom; every step ends on a completion
criterion — do not advance past a failed one. Ground rules: [CONTRIBUTING.md](CONTRIBUTING.md);
locked §10 texts and CLI contract: [`.scratch/deep-horizon/05-cli-contract.md`](.scratch/deep-horizon/05-cli-contract.md).

## 1. Preflight — npm auth before anything
`npm whoami` must succeed BEFORE any version bump or commit — the check that
would have caught 0.4.0's and 0.5.0's dead token before the push. Fail: stop
and `npm login` until it passes, or proceed consciously on the fallback
(step 4), saying so in the release commit message. Also: working tree clean,
`npm test` green, `gh run list --branch main` green. Done when: `npm whoami`
printed a username (or the fallback decision is recorded) and all checks hold.

## 2. Version
Minor bump (0.x → 0.(x+1).0) when the locked §10 texts or the CLI contract
change (precedents: 0.4.0, 0.5.0); patch for checks, fixes, adapter behavior.
The version lives only in package.json + package-lock.json:
`npm version <minor|patch> --no-git-tag-version`. Done when: both files
carry the new version.

## 3. Commit, push, publish
One release commit (texts, spec, package files, docs together); push `main`;
then `npm publish` — `prepublishOnly` runs the full suite itself. Done when:
`npm view deep-horizon version` prints the new version.

## 4. Fallback — registry unreachable or token dead
```bash
npm pack                                # deep-horizon-<version>.tgz
npm i -g ./deep-horizon-<version>.tgz
rm ./deep-horizon-<version>.tgz
```
Registry catch-up: when npm auth works again, `npm publish` the CURRENT
version from the repo — skipped intermediates are fine, the git tags carry
the history. Done when: `horizon --version` prints the new version.

## 5. Redeploy the machine
```bash
horizon install --harness zcode --harness hermes   # idempotent
horizon doctor
```
Hermes's plugin files refresh here — `npm run sync:hermes` is dev-time, never
a release step. Done when: every doctor line is PASS; any FAIL blocks "done".

## 6. Verify the live path
One `horizon-inject --cwd <repo>` invocation whose output contains a marker
from the new release — for a text release, a distinctive phrase from the new
wording. Injection picks by store state: use a store that injects the changed
block (a §10.1 text release: open gaps — the repo's own store qualifies).
Done when: the phrase appears.

## 7. Tag
`git tag v<version> <release-commit> && git push origin v<version>`. Done
when: `git ls-remote --tags origin v<version>` lists the tag.

## 8. Session record
```bash
horizon session-end --harness <harness> --session <session-id> \
  --summary "<one factual line>"
```
Run from the repo whose store should carry the record; real harness and
session id — per §10.5's provenance convention, never invented, a summary
never fabricated; a repeat is a safe no-op (first record wins). Done when:
`horizon log` shows the record.
