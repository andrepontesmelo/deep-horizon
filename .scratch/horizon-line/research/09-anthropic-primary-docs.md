# HL-09 findings: prior art against primary Anthropic sources

Date: 2026-09-08. Method: primary sources only — code.claude.com docs (fetched as
raw markdown via `/llms.txt`-indexed `.md` URLs), platform.claude.com Managed
Agents docs (same method), the official changelog
(github.com/anthropics/claude-code/blob/main/CHANGELOG.md, fetched 2026-09-08),
and the locally installed Claude Code binary. All quotes are verbatim. The
kickoff finding was directionally right but wrong on every name and mechanism —
corrections below, per question.

## 1. `/goal` — CONFIRMED, with corrections

Exists. Primary doc: "Keep Claude working toward a goal"
https://code.claude.com/docs/en/goal (raw: .../goal.md)

- Version: added in Claude Code **v2.1.139**. Changelog entry (verbatim):
  "Added `/goal` command: set a completion condition and Claude keeps working
  across turns until it's met. Works in interactive, `-p`, and Remote Control.
  Shows live elapsed/turns/tokens as an overlay panel"
  (CHANGELOG.md under `## 2.1.139`). Local install is 2.1.258; running
  `claude -p "/goal"` on it prints `No goal set. Usage: `/goal <condition>`` —
  the command ships in the binary I tested.
- Scope: **session-scoped, not persisted**. Doc, verbatim: "`/goal` is a
  session-scoped shortcut: you type a condition and it's active for the current
  session only."
- Restart: partially survives **resume** (not restart). Doc: "When you resume a
  session, Claude Code restores a goal that was still active when the session
  ended." Routes: `--continue`, `--resume`, session picker; requires
  v2.1.239+ for the picker route. "Claude Code carries the condition over but
  resets the turn count, timer, and token-spend baseline. It doesn't restore a
  goal that was already achieved or cleared." A process restart without resume
  (`/clear`, new session) loses it: "Running `/clear` to start a new
  conversation also removes any active goal."
- Mechanism: not a new primitive — "a wrapper around a session-scoped
  prompt-based Stop hook", evaluated after each turn by the configured small
  fast model (Haiku default). Condition max 4,000 chars; one goal per session.
- Contrast with horizon-line: `/goal` is a machine-authored, session-scoped
  completion condition with a model-judged exit. It does NOT persist a
  human-authored aim across independent sessions, is not a repo-local artifact,
  and is unreadable by other tools (it lives in session state). Different
  problem; not prior art. Closest relative, still not overlapping: a Stop hook
  in settings is durable and deterministic but per-harness config, not
  cross-harness shared content.

## 2. Outcomes / Dreams / Routines — ALL REAL, none applicable to a local CLI

### Outcomes — CONFIRMED as Managed-Agents API feature

Primary doc: "Define outcomes"
https://platform.claude.com/docs/en/managed-agents/define-outcomes (raw: same
URL + `.md`). Verbatim: "An outcome tells the session what the end result
should look like and how to measure its quality. The agent works toward that
target, self-evaluating and iterating until the outcome is met." Concretely a
`user.define_outcome` event with a markdown rubric; "the harness automatically
provisions a *grader*"; `max_iterations` default 3, max 20. Requires the
`managed-agents-2026-04-01` beta header and, per the Managed Agents overview
(https://docs.anthropic.com/en/docs/managed-agents/overview), "Certain features
(outcomes and multiagent) are in research preview. Request access to try them."
It is an event on hosted sessions — nothing a local CLI harness can consume.
Note: the earlier 404 was a slug problem; the real page is `define-outcomes`.

### Dreams — CONFIRMED as Managed-Agents feature, research preview

Primary doc: "Dreams"
https://platform.claude.com/docs/en/managed-agents/dreams (raw: .../dreams.md).
Verbatim: "**Dreams** let Claude clean that up. A dream reads an existing memory
store alongside past session transcripts, then produces a new, reorganized
memory store: duplicates merged, stale or contradicted entries replaced with
the latest value, and new insights surfaced." Gated by the
`dreaming-2026-04-21` beta header; "Dreaming is a research preview feature.
Request access to try it." It is a memory-store consolidation pipeline, not an
aim-injection mechanism. (Locally adjacent: Claude Code has an
`autoDreamEnabled` setting behind a per-account rollout flag — see
github.com/anthropics/claude-code/issues/86209, a repo issue, i.e. primary-adjacent;
closed-flag accounts get a silent no-op.)

### Routines — CONFIRMED, but they are Claude-Code-on-the-web cloud runs

Primary doc: "Automate work with routines"
https://code.claude.com/docs/en/routines (raw: .../routines.md). Verbatim: "A
routine is a saved Claude Code configuration: a prompt, one or more
repositories, and a set of connectors, packaged once and run automatically."
They execute "on Anthropic-managed cloud infrastructure, or on your
organization's self-hosted environment"; "Routines are in research preview".
CLI surface is `/schedule`; the Tools reference
(https://docs.anthropic.com/en/docs/claude-code/tools) says the RemoteTrigger
tool "Creates, updates, runs, and lists Routines on claude.ai. Backs the
`/schedule` command. Routines live on claude.ai and require a Pro, Max, Team,
or Enterprise plan". So: cloud/orchestrated recurring runs — not a persisted
aim readable inside arbitrary local sessions.

## 3. Is there ANY Anthropic primitive that persists a human-authored aim across sessions, readable by other tools?

Two exist — but neither is a new Anthropic "aim" product, and both have a gap
horizon-line fills.

### CLAUDE.md — the real nearest prior art

Primary doc: "How Claude remembers your project"
https://code.claude.com/docs/en/memory (raw: .../memory.md). Verbatim: "CLAUDE.md
files are markdown files that give Claude persistent instructions for a project,
your personal workflow, or your entire organization. You write these files in
plain text; Claude reads them at the start of every session." Project file at
`./CLAUDE.md` or `./.claude/CLAUDE.md`, "shared with your team through version
control", loaded from cwd and every parent directory, all concatenated into
context. Also: an auto-memory feature whose files "are plain markdown you can
edit or delete at any time" — but it is Claude-authored ("Claude saves four
kinds of notes for itself"), not human-authored.

So "persist a human-authored, repo-local, plain-text aim injected every
session" IS already shipping inside Claude Code. The gap horizon-line fills is
exactly the cross-harness half: Claude Code "reads `CLAUDE.md`, not
`AGENTS.md`"; the doc's own bridge is "If your repository already uses
`AGENTS.md` for other coding agents, create a `CLAUDE.md` that imports it"
(`@AGENTS.md`) — a per-repo symlink/import trick, not a standard, enforced,
512-char-capped, CLI-managed line that opencode/Hermes/pi/DeepSeek all also
read. That per-harness-glue gap is the project's reason to exist.

### Managed Agents memory stores — server-side persistence, not repo-local

Primary doc: "Memory stores"
https://platform.claude.com/docs/en/managed-agents/memory (raw: .../memory.md).
Verbatim: "Memory stores let the agent carry information across sessions: user
preferences, project conventions, prior mistakes, and domain context." Attached
at session creation ("memory stores can only be attached at session creation
time"), mounted at `/mnt/memory/<slug>/`; `agent-memory-2026-07-22` beta header.
Anthropic-accessible via API/Console, but it is a hosted workspace-scoped store,
not a file in the repo that arbitrary local harnesses read.

## Verdict for the map

- No Anthropic primitive is horizon-line: nothing persists a human-authored,
  512-char, repo-local aim that ALL harnesses read. Q3's two primitives
  (CLAUDE.md, memory stores) each cover one half (local injection vs.
  cross-session persistence) and neither covers cross-harness interop.
- The kickoff press-derived names were real but mis-scoped: Outcomes/Dreams are
  Managed-Agents research-preview features (not local CLI), Routines are
  claude.ai cloud runs, `/goal` is session-scoped with resume-only carryover.
- Cite CLAUDE.md (+ the `@AGENTS.md` import pattern) as the prior art to
  position against, not `/goal`.
