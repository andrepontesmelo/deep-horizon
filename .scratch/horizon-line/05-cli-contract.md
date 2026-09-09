# horizon-line CLI contract (HL-05)

Status: draft for review
Date: 2026-09-08
Sources: HL-03 rounds 1–4, HL-04, HL-01/02/09/10 research.

This is the complete, testable contract for the deterministic CLI. It is the
implementation target: a developer should be able to build against it without
asking a question, and a TDD implementation should be able to turn every
acceptance test in §9 red before writing code.

**The CLI contains no LLM calls, no network access, and no nondeterminism
beyond the clock and the id generator.** Same inputs, same store state, same
output — always.

---

## 1. The store

Resolved by walking **up** from `--cwd` (default: the process cwd) to the
nearest ancestor directory containing `.horizon/`, the way git finds `.git`.
Stop at the filesystem root.

```
.horizon/
  gaps.json        open gaps only, max 5, mutable, revisioned
  sessions.jsonl   append-only, one JSON object per line
```

**One store per repository.** Never shared across repos, never global. The
store is discovered by walking up, so a monorepo's subprojects inherit the
repo-root store unless they carry their own `.horizon/`.

### 1.1 `gaps.json`

```json
{
  "version": 1,
  "revision": 7,
  "gaps": [
    {
      "id": "g_3f9a2c1b",
      "text": "A person can hand a photo to the app and get the plant named.",
      "added_at": "2026-09-08T15:04:11Z",
      "provenance": {
        "harness": "claude-code",
        "session_id": "de2cf9e3-...",
        "tty": true,
        "origin": "agent-proposed"
      }
    }
  ]
}
```

- `version` — schema version. Present from day one so a future migration has
  something to branch on.
- `revision` — monotonic integer, incremented on **every** successful write.
  A counter, not a compare-and-swap token (§4).
- `gaps` — **open gaps only**, ordered by `added_at` ascending (insertion
  order). Never more than 5. A closed gap is *removed* from this array.
- `provenance.origin` — one of `human`, `agent-proposed`. Advisory only; the
  CLI cannot actually tell (§6).

`text` is one line: no `\n`, no `\r`, at most **512 Unicode code points**.

### 1.2 `sessions.jsonl`

One object per line, appended, never rewritten:

```json
{"ts":"2026-09-08T16:20:03Z","harness":"hermes","session_id":"20260908_152139_780660","summary":"Settled the store format and wrote the CLI contract.","gaps_added":["g_3f9a2c1b"],"gaps_closed":["g_77c1e004"]}
```

- `summary` — **nullable**. `null` is valid and normal: at least one harness
  (DSH) structurally cannot elicit model text at close (HL-10). A summary is
  never fabricated to fill the field.
- `gaps_added` / `gaps_closed` — arrays of gap ids, filled **by the CLI** from
  what it recorded during the session (§3.6). Never supplied by the agent.
- `harness` + `session_id` — the harness's own id, recorded verbatim. It is the
  join key back into that harness's transcripts; horizon-line never invents an
  id of its own.

---

## 2. Global options

| Option | Meaning |
|---|---|
| `--cwd <path>` | Resolve the store from here instead of the process cwd. |
| `--json` | Machine-readable output on stdout (§7). Errors also become JSON. |
| `--harness <name>` | Records provenance. Defaults to `$HORIZON_HARNESS`, then `unknown`. |
| `--session <id>` | The harness's session id, for provenance and session records. |
| `--origin <human\|agent-proposed>` | Defaults to `human`. |
| `--version` / `--help` | Standard. Always exit 0. |

---

## 3. Commands

### 3.1 `horizon show`

Prints the current open gaps. **The injection path** — its stdout is what a
hook pipes into a session, so it must need zero parsing.

Human form (no `--json`), gaps in insertion order:

```
g_3f9a2c1b  A person can hand a photo to the app and get the plant named.
g_77c1e004  Rentals can be compared across sites without re-entering filters.
```

- Exactly one line per gap: id, two spaces, text.
- **No header, no footer, no dates, no counts, no colour, no trailing blank
  line.** Dates and move counts are for `horizon log` (HL-03 r2).
- No gaps → prints nothing, exit **0**. Emptiness is not an error; the *nudge*
  is the adapter's job, not the CLI's.
- No store at all → prints nothing, exit **0**. A project without a horizon is
  the normal case and must stay silent and cheap (HL-03 r1/r2).

### 3.2 `horizon add "<text>"`

Appends a gap. Mints an id, increments `revision`, writes atomically.

- Rejects text over 512 code points (§5, exit 3).
- Rejects text containing `\n` or `\r` (exit 3).
- Rejects empty or whitespace-only text (exit 3).
- Rejects when 5 gaps are already open (exit 4) — a **hard reject**, naming the
  open gaps so the caller can choose one to close.
- Creates `.horizon/` in `--cwd` if no store exists anywhere up the tree, and
  says so on stderr.

Prints the new id on stdout: `g_3f9a2c1b`.

### 3.3 `horizon close <id>`

Removes the gap from `gaps.json`, increments `revision`, records the close for
the session record (§3.6).

- Unknown or already-closed id → exit 5.
- Prints nothing on success (exit 0).

### 3.4 `horizon amend <id> "<text>"`

Rewrites a gap's text in place. Same validation as `add`. The id is unchanged,
so history stays valid (HL-04). Any *open* gap may be amended.

- Unknown id → exit 5.
- Text failures → exit 3.

### 3.5 `horizon log [--limit N]`

Prints session records, newest first, default limit 20. Human form:

```
2026-09-08 16:20  hermes    +1 -1  Settled the store format and wrote the CLI contract.
2026-09-08 14:03  claude-code  +1 -0  (no summary)
```

`--json` emits the raw JSONL objects, newest first.

### 3.6 `horizon session-end`

Appends a session record. Called by a close hook, or mid-session as the
fallback where no usable close hook exists (HL-10).

```
horizon session-end --harness hermes --session <id> [--summary "<text>"]
```

- `--summary` omitted → `summary: null`. **Never** a placeholder string.
- `gaps_added` / `gaps_closed` are computed by the CLI, not passed in: it reads
  which gap mutations carried this `--session` id in their provenance and which
  closes it recorded for that session.
- Requires `--harness` and `--session`; missing either → exit 2.
- Appending is a single `O_APPEND` write of one line. **No revision check, no
  temp file, no lock** — concurrent appends from two harnesses are safe by
  construction (§4).

### 3.7 `horizon init`

Creates `.horizon/` in `--cwd` with an empty store. Idempotent: an existing
store is left untouched, exit 0.

---

## 4. Atomicity and concurrency

**One store per repository. `gaps.json` — temp + fsync + rename. No lock.**

1. Read `gaps.json`. An absent file is an empty store, not an error (§7).
2. Apply the mutation in memory; `revision` += 1.
3. Write the whole document to `.horizon/.gaps.json.tmp.<pid>` in the **same
   directory** — a cross-filesystem rename is not atomic.
4. `fsync` the temp file, then `rename()` over `gaps.json`. Node's `fs.rename`
   overwrites an existing destination on all three platforms: `rename(2)` on
   POSIX, `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)` on Windows.
5. Retry the `rename` up to 3 times (10 ms, 50 ms, 200 ms). Windows returns
   `EPERM`/`EBUSY` when another process holds the destination open — antivirus,
   search indexers, and editors all do this transiently. After the third
   failure, exit 6.

**No lock file. No claim. No pid. No staleness timer.** Concurrency is
last-writer-wins: if two writers race, the later `rename` wins and the earlier
writer's mutation is lost **silently**. This is an **accepted risk** (Andre,
2026-09-09): the store is written at session start/end and by deliberate human
commands, so simultaneous writes are rare, and every mechanism that would
prevent it costs more than the loss — either a native addon for a real kernel
lock (`os-lock` runs `node-gyp rebuild` at install time and ships no
prebuilds), or a hand-rolled sentinel that strands on `kill -9` and then needs
liveness detection (the DEF-4/DEF-5 chain).

**`revision` is a counter, not a compare-and-swap token.** It increments on
every write so the log and future adapters can tell one write from the next.
It is never re-read before writing, and a moved revision never aborts a write.

**`sessions.jsonl` — plain append.** One write of one line, terminated by an
explicit `\n`. No read, no parse, no lock.

### 4.1 Cross-platform rules (Linux, macOS, Windows)

The CLI must install and run on all three with **no native dependency**.

- **No native modules.** `npm i -g horizon-line` must not invoke a compiler.
  This rules out `os-lock` (fcntl/LockFileEx binding, `install: node-gyp
  rebuild`) and `fs-ext`.
- **No symlinks.** Creating one on Windows needs Developer Mode or admin.
- **No `flock`, no `chmod`, no POSIX-only syscalls.**
- **All paths via `path.join`.** Never concatenate separators.
- **Line endings:** the store ships `.horizon/.gitattributes` containing
  `* -text` (git honours `.gitattributes` in subdirectories), so a Windows
  checkout with `core.autocrlf=true` cannot rewrite `sessions.jsonl` into
  `\r\n`. The reader must still skip blank lines and tolerate a trailing `\r`.
- **Store discovery tolerates case:** on macOS and Windows a directory named
  `.Horizon` also matches.
- **Runtime:** Node ≥ 20 on all three platforms.

---

## 5. The 512 cap

Counted in **Unicode code points** — `[...s].length` in JS, `len(s)` in
Python. Not bytes (would make `ção` cost more than `cao`), not UTF-16 units
(would make an emoji cost 2). This is the one unit that agrees across both
implementation languages (HL-04).

Rejection is deterministic and **never truncates**. stderr, verbatim shape:

```
horizon: gap text is 547 code points; the limit is 512. Not saved.
```

The actual count is always stated, so the failure is never mysterious.

---

## 6. Provenance is evidence, not enforcement

Each gap records `harness`, `session_id`, `tty` (`isatty(stdin)`), and
`origin`. **The CLI cannot tell a human from an agent** — any caller can pass
`--origin human`. The human-authored property is enforced *socially*, by the
injected prompt's wording (HL-03 r3), and provenance exists so the log can be
read honestly afterward.

---

## 7. Exit codes

| Code | Meaning | stderr |
|---|---|---|
| 0 | Success (including "no gaps" and "no store") | — |
| 2 | Usage error — unknown command, missing required flag | usage line |
| 3 | Text rejected — over cap, contains a newline, or empty | states the actual count or the offending character |
| 4 | Cap reached — 5 gaps already open | lists the open gaps with ids |
| 5 | Unknown gap id | states the id |
| 6 | Write failed after retries — the OS held the store file open | names the file and the errno |
| 7 | Store unreadable or malformed JSON | names the file and the parse error |

**0 for an absent store is deliberate.** `horizon show` runs at the start of
every session on every project, and most projects have no horizon. A non-zero
exit there would make every hook noisy on every unrelated repo.

`--json` errors go to stdout as `{"error":{"code":3,"message":"..."}}` with the
same exit code, so a hook can branch without parsing stderr.

---

## 8. What the CLI does NOT do

- No LLM calls. No network. No background work.
- Never writes a summary it was not given.
- Never closes a gap on its own (HL-03 r3 — only the human closes).
- Never injects anything. Injection is the adapters' job; the CLI only prints.
- Never edits `AGENTS.md`, `CLAUDE.md`, or any file outside `.horizon/`.

---

## 9. Acceptance tests

The list a TDD implementation turns red first.

**Resolution**
1. `show` from a subdirectory finds the parent's store.
2. `show` with a nested `.horizon/` uses the *nearest* one, not the outermost.
3. `show` with no store anywhere: empty stdout, exit 0.

**show**
4. Two open gaps print exactly two lines, `id␣␣text`, insertion order.
5. No trailing blank line, no header, no dates in the output.
6. `--json` emits the gap objects with ids, text, and `added_at`.

**add**
7. A 512-code-point text is accepted; 513 is rejected with exit 3 and the count
   in stderr.
8. A 512-code-point text of astral-plane emoji is accepted — proving code
   points, not UTF-16 units.
9. `ção`-heavy text near the cap is accepted — proving code points, not bytes.
10. Text with an embedded `\n` is rejected, exit 3.
11. Empty and whitespace-only text are rejected, exit 3.
12. The 6th add is rejected with exit 4, and the store still has exactly 5.
13. A rejected add does not increment `revision`.
14. Two adds mint different ids; ids match `^g_[0-9a-f]{8}$`.
15. `add` in a directory with no store creates one and says so.

**close / amend**
16. `close` removes the gap from `gaps.json` and frees a slot: after closing
    one of 5, an add succeeds.
17. `close` on an unknown id: exit 5, store unchanged.
18. `close` twice on the same id: the second is exit 5.
19. `amend` changes text but not the id or `added_at`.
20. `amend` past the cap is rejected, exit 3, text unchanged on disk.

**Atomicity / concurrency**
21. No reader ever sees a partial document: 200 reads concurrent with a writer
    in a tight loop all parse (temp+rename property).
22. No `.tmp` file remains after a successful write; a `kill -9` mid-write may
    leave one behind, and the **next** write still succeeds — there is no lock
    to strand and nothing to wait on.
23. Two concurrent `add`s: `gaps.json` stays valid JSON and the surviving gap
    count is 1 or 2. Last-writer-wins is the accepted behaviour; corruption is
    not.
24. `rename` failing with `EPERM`/`EBUSY` is retried, and a later attempt
    succeeding is enough to exit 0.
25. 20 concurrent `session-end` appends produce 20 valid JSONL lines, none
    interleaved or truncated.

**Cross-platform (X1–X5)**
X1. `package.json` has no native dependency: no `gypfile`, no `os-lock`, no
    `fs-ext`; `npm i -g` completes without invoking a compiler.
X2. No `symlink` call anywhere in the source.
X3. Every path is built with `path.join`; no hand-concatenated separator.
X4. `.horizon/.gitattributes` exists and contains `* -text`; the JSONL reader
    accepts `\r\n` and skips blank lines.
X5. A store directory named `.Horizon` is found on a case-insensitive
    filesystem.

**session-end**
26. Omitting `--summary` writes `"summary": null`, not `""` and not a
    placeholder.
27. `gaps_added` is computed from the session's own mutations, not from a flag.
28. A session that touched nothing still writes a record, with empty arrays.
29. Missing `--harness` or `--session`: exit 2, nothing appended.

**log**
30. `log` prints newest first and honours `--limit`.
31. A record with `summary: null` renders as `(no summary)` and does not crash.

**Store integrity**
32. Malformed `gaps.json`: exit 7, naming the file; the file is not
    overwritten.
33. An unknown future `version` is refused rather than migrated silently.

---

## 10. The injected texts (HL-06, locked)

These strings live in the **core package**, not per-adapter. Five copies would
diverge within a month, and the premise is that every harness sees the same
horizon — which has to mean the same words about it.

`{{GAPS}}` is `horizon show` stdout **substituted verbatim, never
re-formatted**. If bullets or numbering are ever wanted, they belong in §3.1's
output, not in five adapters that would drift apart.

### 10.1 The horizon block

Injected when `horizon show` prints at least one gap.

```
This project has a horizon — a short list of what the user wants and doesn't
have yet. It was written across earlier sessions, by earlier agents, with the
user's approval:

{{GAPS}}

You have inherited it, not been assigned it. Nothing here is due today. Sessions
that touch none of these are perfectly normal; the horizon exists so the aim
survives between sessions, not so any one session delivers it.

What it is not: a backlog, a task list, or work assigned to this session. A gap
may sit open for weeks across many sessions and that is the normal case. Do not
plan around closing them, and do not report progress against them.

Two things are yours to do. When the user wants something that outlives this
session, offer `horizon add "<one line>"`. When something here looks done, offer
`horizon close <id>`. Both need the user's yes — the horizon is theirs, you only
hold the pen.
```

Chosen over a terse variant and an explicit-contract variant. The reasoning:
framing changes behaviour more reliably than instruction. *"Inherited, not
assigned"* attacks the eagerness this project exists to prevent at its root,
and *"you only hold the pen"* states the authorship rule (HL-03 r3) as identity
rather than as a prohibition to comply with.

The third paragraph is grafted from the explicit-contract variant, which was
strongest exactly where the framing variant was vague — naming what a gap *is
not*. Its final clause, "and do not mention them again unless relevant", was
**dropped deliberately**: a gap becoming relevant mid-session is a good
outcome, and suppressing it would defeat the injection.

### 10.2 The nudge

Injected when `horizon show` prints nothing (§3.1: empty store *and* absent
store both print nothing and exit 0).

```
Horizon: none set. `horizon add "<one line>"` if the user names a want that
outlives this session.
```

Two lines, because this appears in nearly every session of every project — the
overwhelming majority have no horizon. A longer variant carrying "don't prompt
them unasked" was rejected: it spends a line in every session on every project
to prevent a behaviour the shorter text doesn't especially invite.

### 10.3 Acceptance tests for the texts

34. The horizon block substitutes `{{GAPS}}` with `show` stdout byte-for-byte,
    with no added bullets, indentation, or trailing newline changes.
35. The nudge is emitted when `show` is empty, and the block when it is not —
    never both, never neither.
36. Both strings are exported from the core package and imported by every
    adapter; no adapter contains a literal copy. (Enforced by a test that greps
    the adapter sources for a distinctive phrase from each string.)

---

## 11. Open, deliberately

Not blockers for implementation; each is a fog patch on the map.

- Injection order when a model may read the first gap as most important
  (insertion order is the current default).
- Whether the store is committed or gitignored by default.
- Whether the 5-cap becomes a prompt-to-close rather than a hard reject, once
  the propose-and-confirm flow is real.
