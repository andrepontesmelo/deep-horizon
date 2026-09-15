# Grill: Install wiring and the registry release

Type: grilling
Status: closed (resolved 2026-09-15, AFK-authorized — see map Notes)
Blocked by: [01 ZCode hook surface re-probe](01-research-zcode-hook-surface-reprobe.md) ✅

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

## Resolution

**`horizon install` writes global config (parse→merge→validate→backup);
`horizon doctor` verifies; 0.4.0 ships from the registry; re-install is the
upgrade.**

1. **Wiring — write, but never blind:** `horizon install --harness zcode`
   edits `~/.zcode/cli/config.json` via JSON **parse → merge → validate →
   backup → write** — never a regex edit — writing the SessionStart hook
   (matcher `"startup|resume"` per ticket 04) and the PreToolUse hook
   (pre-execute), leaving Stop disabled, preserving every foreign key.
   Backup first (`config.json.bak-pre-horizon-<date>`, Andre's existing
   convention); idempotent; **fails loudly** (non-zero, named reason) when
   the config's `hooks` shape is unrecognized — ticket 01's finding that
   malformed JSON disables the *whole* config is why blind writes are
   banned. Global config only: project hooks are trust-gated with
   stale-prone grants and double-fire when both scopes declare (ticket 01).
   `horizon install --harness hermes` copies the adapter files to
   `~/.hermes/plugins/deep-horizon/` and ensures `config.yaml`'s enabled
   plugin list names it (append + backup; never reorders).
2. **Registry:** publish 0.4.0 from the repo — `npm publish` with `dist/`
   in `files`, no lifecycle scripts on the user's machine (the
   registry-release gap's own notes). Cutover on this machine: remove the
   `npm root -g` symlink, `npm i -g deep-horizon`, then `horizon doctor`
   green (bins on PATH, wiring present, store readable) — the repo stays
   the dev checkout, no longer the runtime.
3. **Upgrade:** `horizon install` is idempotent and re-runnable — upgrading
   means `npm i -g deep-horizon@latest && horizon install --harness zcode
   --harness hermes && horizon doctor`. No config migration machinery; the
   merge is the migration.
