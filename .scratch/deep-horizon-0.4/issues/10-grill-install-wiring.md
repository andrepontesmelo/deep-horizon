# Grill: Install wiring and the registry release

Type: grilling
Status: open
Blocked by: [01 ZCode hook surface re-probe](01-research-zcode-hook-surface-reprobe.md)

## Question

F3's root cause is a deployment gap: the README carries the hook config
block, but nothing applies it — the user must hand-edit
`~/.zcode/cli/config.json`, and didn't (and the current machine "install" is
a symlink to the repo because the npm registry still 404s — the open
`registry-release` horizon gap). Decide the 0.4.0 install story:

1. **Wiring.** Does `npm i -g deep-horizon` (or a first `horizon` run) wire
   hooks itself — `horizon install --harness zcode` writing/merging the
   global hook config, hermes install copying the plugin and registering it
   in `~/.hermes/config.yaml`? Or does install **verify and fail loudly**
   (`horizon doctor`: "pre-execute shipped but PreToolUse not wired — run
   X")? Merge-safety of editing harness configs is a real risk — decide
   the line between writing config and checking it. Depends on ticket 01's
   config-surface/trust findings.
2. **Registry.** The publish itself: 0.4.0 is the version that ships
   (this map's output); decide release mechanics — `npm publish` from the
   repo (dist/ packed, no install scripts, per the registry-release gap
   notes), version cutover on this machine (unlink the symlink, install
   from registry, keep the repo as the dev checkout), and what `horizon
   doctor` checks post-cutover.
3. **Upgrade path.** Machines with the old config (SessionStart wired,
   PreToolUse absent — i.e., this machine) — does install migrate hook
   config forward across versions, or is re-running install the answer?

## Why it matters

"Shipped but not wired" is how the param trigger spent its first day dead,
and the symlink means every repo experiment mutates the "installed" plugin.
The install path is the difference between 0.4.0 fixing things and 0.4.0
recreating the same gaps one level up. Closes the `registry-release` and
`zcode-param-trigger` horizon gaps.
