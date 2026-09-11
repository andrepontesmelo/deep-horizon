# deep-horizon CLI contract (HL-05)

Status: draft for review
Date: 2026-09-08
Sources: HL-03 rounds 1–4, HL-04, HL-01/02/09/10 research.

This is the complete, testable contract for the deterministic CLI. It is the
implementation target: a developer should be able to build against it without
asking a question, and a TDD implementation should be able to turn every
acceptance test in §9 red before writing code.

**The CLI contains no LLM calls, no network access, and no nondeterminism
beyond the clock.** Same inputs, same store state, same output — always.

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
      "id": "plant-photo-lookup",
      "text": "A person can hand a photo to the app and get the plant named.",
      "details": "The user misidentifies the same three houseplants every week;\nthe lookup table already exists, only the handoff is missing.",
      "added_at": "2026-09-08T15:04:11Z",
      "provenance": {
        "harness": "claude-code",
        "session_id": "de2cf9e3-...",
        "tty": true,
        "origin": "agent-proposed"
      }
    }
  ],
  "closed_ids": ["rental-compare"]
}
```

- `version` — schema version. Present from day one so a future migration has
  something to branch on.
- `revision` — monotonic integer, incremented on **every** successful write.
  A counter, not a compare-and-swap token (§4).
- `gaps` — **open gaps only**, ordered by `added_at` ascending (insertion
  order). Never more than 5. A closed gap is *removed* from this array. Every
  `id` must match the slug grammar (§3.2); a store carrying an id that does
  not — including the abandoned `g_<8 hex>` shape — is malformed (exit 7).
- `closed_ids` — every id ever closed, in close order; `add` rejects a reuse
  (§3.2). **Missing reads as empty** (stores written before the field existed
  stay valid) and is **written on the next save**. Present but not an array of
  valid ids is malformed (exit 7).
- `about` — **optional** top-level string: the one human-authored line saying
  what this project *is*, distinct from the gaps, which say where the work is
  heading (§10.4). Absent = unset; present but not a string is malformed
  (exit 7). Version stays 1 — old stores remain valid.
- `provenance.origin` — one of `human`, `agent-proposed`. Advisory only; the
  CLI cannot actually tell (§6).
- `details` — **optional** per-gap string: the extended context (what/why/
  origin) that does not fit the one line. Absent = unset (the field is never
  written as `null`); present but not a string is malformed (exit 7). Unlike
  `text` it may contain `\n` — the only shape rule is the cap (§5). Details
  are never injected (§10); they are retrieved on demand with `horizon
  detail <id>` (§3.5).

`text` is one line: no `\n`, no `\r`, at most **512 Unicode code points**.

### 1.2 `sessions.jsonl`

One object per line, appended, never rewritten:

```json
{"ts":"2026-09-08T16:20:03Z","harness":"hermes","session_id":"20260908_152139_780660","summary":"Settled the store format and wrote the CLI contract.","gaps_added":["plant-photo-lookup"],"gaps_closed":["rental-compare"]}
```

- `summary` — **nullable**. `null` is valid and normal: at least one harness
  (DSH) structurally cannot elicit model text at close (HL-10). A summary is
  never fabricated to fill the field.
- `gaps_added` / `gaps_closed` — arrays of gap ids, filled **by the CLI** from
  what it recorded during the session (§3.7). Never supplied by the agent.
- `harness` + `session_id` — the harness's own id, recorded verbatim. It is the
  join key back into that harness's transcripts; deep-horizon never invents an
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

Prints the current open gaps. Feeds the injection: `horizon-inject` (D6)
composes this stdout verbatim into the §10 block's `{{GAPS}}` slot, so it must
need zero parsing.

Human form (no `--json`), gaps in insertion order:

```
plant-photo-lookup  A person can hand a photo to the app and get the plant named.
rental-compare  Rentals can be compared across sites without re-entering filters.
```

- Exactly one line per gap: id, two spaces, text.
- When the store carries an `about` line, `show` prints it first as
  `about  <text>` — the token `about`, two spaces, the text — ahead of the
  gap lines, and alone when there are no gaps. Unset, no such line (§10.4).
  `--json` output is unchanged: the bare gaps array.
- Gaps print in **insertion order, oldest first** — the order they are stored
  in `gaps.json` (`added_at` ascending). Resolved in
  `09-open-items-resolved.md` (item A): a model reads the first line as most
  important, so the first line must be the want that has waited longest.
  Recency ordering would let a fresh want bury a stale one — the failure the
  horizon exists to prevent. `gaps.json` order = `show` order = injected
  order: one order everywhere, no re-sorting at any layer.
- **No header, no footer, no dates, no counts, no colour, no trailing blank
  line.** Dates and move counts are for `horizon log` (HL-03 r2).
- No gaps → prints nothing, exit **0**. Emptiness is not an error; the nudge
  (§10.2/§10.3) is `horizon-inject`'s job, not the CLI's — `show` itself stays
  silent either way.
- No store at all → prints nothing, exit **0**. A project without a horizon is
  the normal case and must stay silent and cheap (HL-03 r1/r2).

### 3.2 `horizon add <id> "<text>" [--detail "<text>"]`

Appends a gap under the caller-supplied id, increments `revision`, writes
atomically. **The id is not minted**: the caller names the gap, positionally
first, so a text starting with dashes is still text.

The id is a slug: `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, 3–40 chars — lowercase
letters and digits, hyphen-separated, starting with a letter. Example:
`plant-photo-lookup`. There is **no compatibility** with the abandoned
`g_<8 hex>` shape: it fails the grammar everywhere.

- Missing id or missing text → exit 2.
- Id off the grammar (uppercase, leading/trailing hyphen, too short, too long,
  or the old `g_<hex>` shape) → exit 2, stating the id.
- Rejects text over 512 code points (§5, exit 3).
- Rejects text containing `\n` or `\r` (exit 3).
- Rejects empty or whitespace-only text (exit 3).
- `--detail "<text>"` optionally sets the gap's details in the same command
  (§3.5): same validation and cap as `horizon detail <id> "<text>"`. A bad
  detail rejects the whole add (exit 3) — no gap lands without its title.
- Rejects when 5 gaps are already open (exit 4) — a **hard reject**, naming the
  open gaps so the caller can choose one to close.
- Rejects a duplicate id (exit 8): an id that is already an open gap, or one
  that appears in `closed_ids`. Ids are **never reused** for the life of the
  project — a name always means the same gap.
- Creates `.horizon/` in `--cwd` if no store exists anywhere up the tree, and
  says so on stderr.

Prints the id on stdout: `plant-photo-lookup`.

### 3.3 `horizon close <id>`

Removes the gap from `gaps.json`, appends the id to `closed_ids` in the same
write — retiring it from any future `add` — increments `revision`, records the
close for the session record (§3.7).

- Id off the grammar → exit 5, named as invalid.
- Unknown or already-closed id → exit 5.
- Prints nothing on success (exit 0).

### 3.4 `horizon amend <id> "<text>"`

Rewrites a gap's text in place. Same text validation as `add`. The id is
unchanged, so history stays valid (HL-04). Any *open* gap may be amended.

- Id off the grammar → exit 5, named as invalid.
- Unknown id → exit 5.
- Text failures → exit 3.

### 3.5 `horizon detail <id> ["<text>" | --clear]`

The extended context behind a gap's one line (§1.1 `details`). Three forms:

- `horizon detail <id>` — **prints** the stored details verbatim (multi-line
  stays multi-line), exit 0. A gap with no details prints the explicit line
  `no details for <id>` and exits 0 — never silence; the wording is part of
  this contract.
- `horizon detail <id> "<text>"` — sets or **rewrites** the details. The write
  is the amend protocol: whole-file rewrite, `revision` + 1, id / title /
  `added_at` / provenance unchanged, atomic tmp+rename (§4). `amend` stays
  title-only; details and title are edited by their own verbs.
- `horizon detail <id> --clear` — removes the field entirely (absent, never
  `null`), `revision` + 1, title preserved. `--clear` together with text is a
  usage error (exit 2).

Validation (both write paths, `add --detail` included):

- Multi-line **allowed** — `\n` and `\r` are ordinary characters here.
- Rejects empty or whitespace-only text (exit 3).
- Rejects text over **2048 Unicode code points** (§5, exit 3), counted the
  same way as the title cap.

- Id off the grammar → exit 5, named as invalid (print, set, and clear forms
  alike — the same split `close` and `amend` apply).
- Unknown id → exit 5 (print, set, and clear forms alike; also when no store
  exists at all — an id cannot be known without a store).
- Missing `<id>` or extra positionals → exit 2.
- Like `amend`, detail changes append **nothing** to `sessions.jsonl` or
  `closes.jsonl`: a wording/context rewrite of an open gap leaves no log
  entry and is visible only through the revision counter. The session log
  records adds and closes (what entered and left the horizon), not rewrites.

### 3.6 `horizon log [--limit N]`

Prints session records, newest first, default limit 20. Human form:

```
2026-09-08 16:20  hermes    +1 -1  Settled the store format and wrote the CLI contract.
2026-09-08 14:03  claude-code  +1 -0  (no summary)
```

`--json` emits the raw JSONL objects, newest first.

### 3.7 `horizon session-end`

Appends a session record. Called by a close hook, or mid-session as the
fallback where no usable close hook exists (HL-10).

```
horizon session-end --harness hermes --session <id> [--summary "<text>"] [--store <dir>]
```

- `--summary` omitted → `summary: null`. **Never** a placeholder string.
- `--store <dir>` targets that store directory directly instead of walking up
  from `--cwd` — the close hooks hand back the dir `horizon-inject --json`
  resolved at injection. A path that is not an existing directory is the
  storeless twin: a silent no-op (exit 0); a store that exists but is
  malformed is the usual exit 7. The no-op covers only paths that do not
  exist: an existing directory that is not a store is writable — a missing
  `gaps.json` reads as a fresh empty store — so a typo'd path (say, the repo
  root instead of the store dir) silently becomes a record home.
- `gaps_added` / `gaps_closed` are computed by the CLI, not passed in: it reads
  which gap mutations carried this `--session` id in their provenance and which
  closes it recorded for that session.
- Requires `--harness` and `--session`; missing either → exit 2.
- Appending is a single `O_APPEND` write of one line. **No revision check, no
  temp file, no lock** — concurrent appends from two harnesses are safe by
  construction (§4).

### 3.8 `horizon init`

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

- **No native modules.** `npm i -g deep-horizon` must not invoke a compiler.
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

The `details` cap works identically at **2048 code points** (§3.5), counted
by the same rule. stderr, verbatim shape:

```
horizon: gap details are 2049 code points; the limit is 2048. Not saved.
```

Multi-line details are valid input, so the newline rejection does not apply
to them — only the empty/blank and cap checks do.

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
| 2 | Usage error — unknown command, missing required flag or argument, id off the slug grammar on `add` | usage line |
| 3 | Text rejected — over cap (title 512, details 2048), a newline in a title, or empty | states the actual count or the offending character |
| 4 | Cap reached — 5 gaps already open | lists the open gaps with ids |
| 5 | Unknown or invalid gap id (`close`/`amend`/`detail`) | states the id |
| 6 | Write failed after retries — the OS held the store file open | names the file and the errno |
| 7 | Store unreadable or malformed JSON — including gap ids or `closed_ids` entries off the slug grammar, or a non-string `details` | names the file and the parse error |
| 8 | Duplicate id on `add` — already an open gap, or closed before (ids are never reused) | states the id |

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
14. `add` prints the caller-supplied id; ids match
    `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, 3–40 chars.
14a. Missing id or missing text → exit 2.
14b. An id off the grammar (uppercase, leading/trailing hyphen, too short, too
     long, or the old `g_<hex>` shape) is rejected, exit 2, stating the id;
     the shortest (3 chars), longest (40 chars), and digit-bearing ids pass.
14c. Adding an id that is already an open gap: exit 8, store and revision
     unchanged.
14d. Adding an id that appears in `closed_ids`: exit 8 — ids are never reused.
14e. `close` appends the id to `closed_ids`; a store without the field reads
     as empty and gains it on the next whole-file save.
14f. A store whose gap ids (or `closed_ids` entries) do not match the grammar
     is malformed: exit 7, same family as other malformed stores.
15. `add` in a directory with no store creates one and says so.

**close / amend**
16. `close` removes the gap from `gaps.json` and frees a slot: after closing
    one of 5, an add succeeds.
17. `close` on an unknown id: exit 5, store unchanged.
17b. `close` or `amend` with an id off the grammar: exit 5, named as invalid.
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

**details**
D1. `add <id> "T" --detail "C"` stores the details; human `show` output is
    unchanged (`id␣␣text`, one line per gap); `show --json` carries the
    `details` field. A plain `add` leaves the field absent, never `null`.
D2. `detail <id>` prints the stored details verbatim, newlines included.
D3. `detail <id>` on a gap without details prints `no details for <id>`,
    exit 0 — never silence.
D4. `detail <id> "C"` sets and re-sets; each write bumps `revision` and
    leaves id, title, `added_at`, and provenance untouched.
D5. `detail <id> --clear` removes the field entirely (absent from the JSON),
    bumps `revision`, preserves the title; `--clear` with text is exit 2.
D6. 2048 code points accepted — astral-plane emoji counted as code points;
    2049 rejected with exit 3 and the count in stderr, in the §5 shape;
    empty and blank rejected, exit 3; embedded `\n` accepted.
D7. Unknown id: exit 5 in all three forms, and when no store exists.
    An id off the grammar: exit 5, named as invalid — the same split
    `close`/`amend` apply. Missing `<id>`: exit 2.
D8. `add` with over-cap or empty `--detail` rejects the whole add (exit 3),
    creating no gap and incrementing no revision.
D9. `amend` stays title-only: it never touches `details`, and details
    survive it.
D10. Details survive every whole-file rewrite (`add`, `close`, `amend`,
     `about`), like the about line.
D11. A non-string `details` in `gaps.json` is malformed (exit 7), naming the
     file; the file is not overwritten.
D12. `detail` set/clear append nothing to `sessions.jsonl` or `closes.jsonl`
     (amend's treatment: rewrites ride on the revision counter alone).

---

## 10. The injected texts (HL-06, locked)

These strings live in the **core package**, not per-adapter. Five copies would
diverge within a month, and the premise is that every harness sees the same
horizon — which has to mean the same words about it.

Selection is **state-sensitive** — exactly one variant per session, never two,
never none:

| Store state | Injected text |
|---|---|
| open gaps | the horizon block (§10.1), prefixed by the about line when set (§10.4) |
| no gaps, `about` set | the warm nudge (§10.3), prefixed by the about line (§10.4) |
| no gaps, no `about` — store absent or empty alike | the bootstrap nudge (§10.2), alone |

The bootstrap exists so a horizon can start without the human typing
commands: an agent that sees an empty world may offer to draft the first line
itself, once, behind the user's yes. The warm nudge keeps that licence once
*something* is set, narrowed to adding gaps and refreshing a stale about line.

`{{GAPS}}` is `horizon show` stdout **substituted verbatim, never
re-formatted**. If bullets or numbering are ever wanted, they belong in §3.1's
output, not in five adapters that would drift apart. Injection order equals
`show` order (§3.1, `09-open-items-resolved.md` item A): `{{GAPS}}` is
substituted byte-for-byte, so the oldest gap is also the first line the model
reads in an injected block. No adapter may re-sort.

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

Some gaps carry extended context beyond their one line —
`horizon detail <id>` prints it.

Three things are yours to do. When the user wants something that outlives this
session, offer `horizon add "<one line>"`. When something here looks done, offer
`horizon close <id>`. If no about line heads this block and the work tells you
what the project is about, offer `horizon about "<one line>"`; if the user says
it themselves, offer to set or update it with their words. All need the user's
yes — the horizon is theirs, you only hold the pen.
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

The third duty was added when selection became state-sensitive: with no about
line heading the block, the agent may offer to draft one (the §10.2 bootstrap
nudge does the same work before any store exists).

The detail pointer was added with the per-gap `details` field (§1.1, §3.5):
one line, so a session knows extended context may exist and how to retrieve
it without that content ever being injected (injection minimalism — the
`{{GAPS}}` slot stays `show` stdout alone). The nudges carry no pointer: they
cover the no-gaps states, where no details exist.

### 10.2 The bootstrap nudge

Injected when the store has neither an about line nor open gaps — an absent
store and an empty store are the same state here. Composed alone: no about
prefix, because none exists.

```
This project has no horizon yet — no about line, no gaps. If the work at hand
tells you what the project is about, offer once to set it:
`horizon about "<one line>"` with your draft, after the user's yes. If the
user says it themselves, offer their words instead. When the user names a want
that outlives this session, offer `horizon add "<one line>"` the same way.
A decline ends the offering for this session.
```

The only text with licence to offer **unprompted**: without it, a horizon
never starts unless the human already knows the commands. The licence is
narrow — offer once, with a draft, after a yes. A decline ends the offering
for this session; being asked again in a later session is the expected,
normal case.

### 10.3 The warm nudge

Injected when an about line is set but no gaps exist. Composed **after** the
about prefix (§10.4), so "the line above" is the about line, literally.

```
No gaps yet. `horizon add "<one line>"` if the user names a want that
outlives this session. If what the user says the project is about no longer
matches the line above, offer to update it — `horizon about`, their words,
after their yes.
```

Short, because it appears in every session of a described-but-gapless
project. Two duties only: add when the user names a lasting want, and offer
to update the about line when the user's own words have outgrown it — when
they disagree, the user's words win.

### 10.4 The about line and the `about` command

When the store carries an `about` line (§1.1), the injected text opens with
one line and a blank line ahead of the block or the warm nudge:

```
This project is about: <about text>

<the horizon block from 10.1, or the warm nudge from 10.3 — byte-identical>
```

The about line is the one human-authored sentence saying what this project
**is**. Gaps say where the work is heading; the about line is the constant
underneath it. It is written by the `about` command, not the add/close flow:

- `horizon about "<text>"` — set or **replace** the line. Validation is
  identical in shape to gap text (§1.1: one line, no `\n`/`\r`, at most 512
  code points, exit 3 on failure). The write increments `revision` and
  preserves the gaps; it creates `.horizon/` in `--cwd` if no store exists.
- `horizon about` — print the current line and exit 0; print nothing, exit 0,
  when unset (emptiness is not an error, same shape as `show`).
- `horizon about --clear` — unset it: rewrite with `revision` + 1 **without**
  the field, gaps preserved.

`show` prints the line as a header ahead of the gap lines — the token
`about`, two spaces, the text, the gap line format (§3.1). `--json` output is
unchanged.

Unset, the injected text is exactly §10.1 (gaps present) or §10.2 (no gaps,
no about) — the about line adds a prefix and nothing else, so the locked
strings never change to carry it. The bootstrap nudge is definitionally the
no-about case, so it never carries a prefix. The prefix is composed by
`horizon-inject` from the core package's `aboutPrefix` helper (D6:
composition stays single-sourced there, never per-adapter).

### 10.5 Acceptance tests for the texts

34. The horizon block substitutes `{{GAPS}}` with `show` stdout byte-for-byte,
    with no added bullets, indentation, or trailing newline changes.
35. Exactly one of the three variants is injected for any store state — the
    block when gaps are open; the bootstrap nudge when neither about nor gaps
    are set (store absent or empty alike); the warm nudge when about is set
    and no gaps are. Never two, never none.
36. All three strings are exported from the core package and imported by every
    adapter; no adapter contains a literal copy. (Enforced by a test that greps
    the adapter sources for a distinctive phrase from each string.)
37. The about line, when set, is injected as `This project is about: <text>`
    followed by a blank line ahead of the block (gaps present) or the warm
    nudge (none); the bootstrap nudge carries no prefix. When unset, the
    injected text is byte-identical to §10.1/§10.2 alone.
38. The about line survives every whole-file rewrite (`add`, `close`,
    `amend`, `about` itself) and is removed only by `about --clear`, which
    preserves the gaps. A non-string `about` in `gaps.json` is malformed
    (exit 7), and an unset store never gains the field from a rewrite.
39. The horizon block carries the detail pointer — the one line naming
    `horizon detail <id>` as the retrieval path — and neither nudge does:
    no gaps exist in the nudge states, so no details can either. Details
    content itself never appears in any injected text. (Pinned in code by
    the `pointer-1`/`pointer-2` tests in test/inject.test.js.)

---

## 11. Open, deliberately

Not blockers for implementation; each is a fog patch on the map.

Three former items are **resolved** in `09-open-items-resolved.md` and bind
from there — do not re-open them here:

- Injection order → insertion order, oldest first (§3.1, §10). No CLI change;
  a statement of existing behaviour.
- Store in git → commit `gaps.json`, ignore `sessions.jsonl` and `*.tmp.*`
  via a nested `.horizon/.gitignore` written by `horizon init`.
- pi subagent exclusion → `HORIZON_SUBAGENT` env var, fail-open. Lands with
  the pi adapter (research/02 §Part 2 Q4); nothing to do in the CLI.

The one item still open:

- Whether the 5-cap becomes a prompt-to-close rather than a hard reject, once
  the propose-and-confirm flow is real.
