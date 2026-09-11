# Resolved: packaging + distribution across five harnesses (HL-08)

Type: grilling — resolved
Date: 2026-09-08
Card: t_0b9338c4
Sources: research/01-claude-opencode-hooks.md, research/02-hermes-pi-hooks.md,
05-cli-contract.md (§10 texts), research findings HL-10/10b, operator answers
received 2026-09-08.

The five-question batch was posted on the card and answered by the operator.
Confirmed as recommended: one package (D1), global install (D2), MIT +
public GitHub (D5). Overridden: the reference harness is **DSH**, not Claude
Code (D3), and opencode ships **degraded with no session records**, not as a
full heuristic adapter (D4). One new decision surfaced while writing the
literal install commands: the two-bin split (D6). The opencode re-cost the
map had deferred to HL-08 is settled with measured numbers (D4).

## D1 — One npm package, not a monorepo

One package, `deep-horizon` (operator, verbatim rationale): a monorepo buys
independent versioning that five adapters MUST NOT have — they stay in
lockstep with one CLI contract, and lockstep is the point. The adapters are
5–20-line glue; nobody installs an adapter without the CLI it wraps.
moving-target is one package and it works.

Package shape (the contract between core and adapters):

```json
{
  "bin": { "horizon": "dist/horizon.js", "horizon-inject": "dist/horizon-inject.js" },
  "exports": {
    ".": "./dist/index.js",
    "./dsh": "./dist/adapters/dsh.js",
    "./opencode": "./dist/adapters/opencode.js",
    "./pi": "./dist/adapters/pi.js"
  }
}
```

- `bin` `horizon` — the HL-05 contract CLI, unchanged: seven commands, prints
  raw gaps only, never composes the §10 texts (§8: "the CLI only prints").
- `bin` `horizon-inject` — pure composition: runs the `show` logic, then
  prints the §10 horizon block (gaps present) or the nudge (empty stdout).
  No store writes, no new commands in the HL-05 contract (D6).
- `exports["."]` — core library: the two §10 strings, the render function, and
  what the bins share. This is what acceptance test 36 means by "exported
  from the core package".
- `exports["./dsh" | "./opencode" | "./pi"]` — harness glue only (hook
  registration + spawning the bins).
- **Hermes' Python plugin and Claude Code's hook need no npm artifact** —
  both simply shell out to the binary. Claude Code is a settings.json block
  (nothing to distribute); the Hermes plugin is Python shipped in this repo
  at `adapters/hermes/` and installed from a clone (D6).

## D2 — Global install is the blessed PATH story

`npm install -g deep-horizon` is step 1 of every harness's README (operator:
three of five harnesses shell out, so the binary must be on PATH). Adapters
invoke the bare bins `horizon` / `horizon-inject`. Hooks fail open when the
bin cannot be resolved — silently injecting nothing — so install order is
always CLI first, adapter second, and the README says so.

`npx` is rejected as the primary path (operator): ~300 ms added to every
session start and network needed on a cold cache — on the hot path of every
session of every project. The documented per-harness fallback for manual,
no-global use:

```
npx -p deep-horizon horizon show
npx -p deep-horizon horizon-inject --harness <name>
```

(`-p` is required: the package name is not a bin name, so plain
`npx deep-horizon …` would not resolve.) Vendoring a copy into each harness
is rejected: three vendored copies of the store logic and the texts drift,
which is exactly what D1's lockstep rule exists to prevent.

## D3 — DSH is the reference implementation (operator override)

**DSH ships first and is the reference implementation** — Andre's call,
overriding the Claude-Code-first recommendation. Trade-off recorded honestly:
DSH is where the close hook is weakest — no `agent/session-end` event exists,
and `agent/disposed` fires after the loop stops, is unawaited, and steering
at that point is discarded (HL-10). So the reference implementation gets
built where session-end must use the **mid-session fallback** (§3.7's
"called mid-session where no usable close hook exists") from day one.
Upside: the fallback path — which has to work everywhere — is proven first
rather than bolted on after a Claude-Code-shaped implementation. DSH's
session records will carry `summary: null`-capable mechanics from the start,
exactly as HL-03 r4 anticipated.

Ship order after the reference, matching the build order recorded on the
map: Claude Code (live-probed end-to-end, lowest ceremony) → Hermes (most
divergent semantics: persistent system-prompt section, Python in-process) →
pi (first-class `reason` enum, source-read) → opencode (degraded, D4).

## D4 — opencode ships DEGRADED, with no session records

Operator decision, superseding the "full adapter on the heuristic"
recommendation. opencode's adapter:

- injects via `chat.message` prepend, once per session, on the heuristic
  (first message + empty persisted history + fresh `session.time.created`),
- excludes subagents via `session.parentID`,
- writes **no session records at all** — no close hook exists (HL-10b: the
  `dispose` hook receives no arguments, so not even a session id survives),
  and pretending parity would be worse than documenting the gap. The README
  says so.

Consequence for the store: `sessions.jsonl` receives records from four of
five harnesses (DSH mid-session fallback, Claude Code `SessionEnd` — the only
close hook proven to fire on SIGINT/SIGTERM — pi `session_shutdown`, Hermes
`on_session_finalize`). opencode sessions are invisible to the log; its gaps
still read and write like everyone else's.

The re-cost the map deferred to HL-08, measured from the locked §10 strings
(chars ÷ 4 ≈ tokens):

| Text | Chars | ≈ Tokens |
|---|---|---|
| Horizon block, empty `{{GAPS}}` | 885 | 221 |
| The nudge | 98 | 24 |
| Horizon block, 5 gaps × 512 chars | 3,501 | 875 |

The map's ~130-token estimate assumed one 512-char line; at the 5-gap cap one
injection is ~875 tokens, and inject-every-turn would duplicate ≈ 35,000
tokens across a 40-turn session — rejected. Once-per-session on the heuristic
stands. Accepted failure mode: a duplicate block after a compaction follow-up
that looks fresh — a repeated ~875-token injection, never data loss. The
manual `horizon show` fallback exists everywhere regardless.

## D5 — MIT, public GitHub + npm; GitHub is not the tracker

MIT, matching moving-target and the portfolio. Publish targets:
`github.com/andrepontesmelo/deep-horizon` and npm `deep-horizon` (name
confirmed free on both as of 2026-09-08, map "Name" decision). Operator
constraint: **GitHub is for the repo and releases ONLY** — task tracking
stays on Kanban and no GitHub Issues are created for this project. Note: the
local repo currently has **no git remote** — wiring the remote and the first
publish are implementation-phase steps, not done here.

## D6 — Two bins; every adapter spawns, none composes

New decision, forced by writing the literal commands: Hermes is in-process
Python and Claude Code is a shell command — neither can import the TS core
where the §10 strings live. Both can spawn processes and read stdout
(operator: "shell out to the binary").

Therefore: **all five adapters spawn the bins; none implements store logic or
text composition.** TS adapters may import the strings from `exports["."]`
for tests, but composition is single-sourced in `horizon-inject`. Test 36's
no-copies grep now guards a real rule: no adapter ever contains a literal of
either text, because none needs one.

The Hermes Python shim lives in this repo at `adapters/hermes/` (with its
`plugin.yaml`) — no npm artifact, per D1:

```bash
npm install -g deep-horizon
git clone https://github.com/andrepontesmelo/deep-horizon
cp -r deep-horizon/adapters/hermes ~/.hermes/plugins/deep-horizon
hermes plugins enable deep-horizon
```

Its injection mechanism: `register_system_prompt_section` with a callable that
spawns `horizon-inject --harness hermes` — the semantic match to the other
harnesses' persistent injection. The 4,000-char cap **fits the worst case**
(3,501 chars at 5×512 gaps) with 499 chars spare. `pre_llm_call` +
`is_first_turn` (10k spill cap, ephemeral) is the held fallback if
render-time spawning proves problematic. Subagent exclusion via
`parent_session_id`; close-time `on_session_finalize` → `horizon session-end
--harness hermes --session <id>` (summary omitted → null; HL-10).

---

## Literal README install commands, per harness

### 1. DeepSeek Harness (DSH) — reference implementation

```bash
npm install -g deep-horizon
npm pack deep-horizon          # or: git clone … && cd deep-horizon && npm pack
dsh plugin --profile <profile> add file:./deep-horizon-<version>.tgz
```

Mount in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: deep-horizon
      name: deep-horizon
```

Ceremony identical to moving-target's proven path (its README). Injection:
`agent/session-start` guarded on `source === "startup"` and
`delegationDepth`/`origin` (moving-target's proven pattern). Session-end:
the mid-session fallback from day one (D3) — the adapter prompts the agent
to run `horizon session-end --harness dsh --session <id>` mid-session, where
model text is still available; `agent/disposed` is too late. Whether
`dsh plugin add npm:deep-horizon` works was not probed — the tgz path is the
documented one.

### 2. Claude Code

```bash
npm install -g deep-horizon
```

`.claude/settings.json` (project-local, checked into the repo):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "horizon-inject --harness claude-code" }
        ]
      }
    ]
  }
}
```

`startup` only: resumed/compacted/forked sessions replay the original
injection from their transcript (research/01 §3), so re-injecting would
duplicate it. Known deliberate gap: `/clear` wipes the context but does not
re-inject (source `clear` is not matched) — the horizon returns next startup.
Close hook: `SessionEnd` → `horizon session-end` (the only close hook proven
to fire on SIGINT/SIGTERM, HL-10b).

### 3. pi

```bash
npm install -g deep-horizon
```

`~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:deep-horizon"] }
```

Injection: `session_start` shells out and stashes, `before_agent_start`
returns the message gated on first prompt (claude-rules.ts pattern).
Subagent exclusion needs an env-var or project-local install scope — pi has
no discriminator (map, open). Close: `session_shutdown` → `horizon
session-end`. Verify at implementation: the `git:` package specifier is
proven live on this machine (pi-telegram), the `npm:` variant is documented
in the same settings table but not yet run.

### 4. opencode — DEGRADED (D4)

```bash
npm install -g deep-horizon
```

`opencode.json` (project):

```json
{ "plugin": ["deep-horizon"] }
```

The README must state the degradation plainly: injection is best-effort
(new-vs-resumed inferred), and **opencode sessions write no session records**
— no session-end hook exists. Verify at implementation: npm-plugin loading is
documented (research/01 §1) but opencode was never live-probed; if Bun does
not resolve the package from the global install, the fallback is a two-line
local plugin at `.opencode/plugins/deep-horizon.ts` importing
`deep-horizon/opencode` by path.

### 5. Hermes

See D6 — the four commands there are the README block.

---

## What this leaves open (not HL-08)

- Store committed vs gitignored (CLI contract §11) — unchanged.
- Injection order of gaps (§11) — unchanged.
- pi subagent-exclusion mechanism: env-var vs project-local install scope
  (decided at pi-adapter implementation).
- Claude Code plugin packaging (`hooks/hooks.json` + `${CLAUDE_PLUGIN_ROOT}`)
  as an alternative to the settings.json block — additive backlog, not v1.
- Two one-run verifications: pi `npm:` package loading, opencode npm plugin
  resolution. Both flagged in their README sections above.
