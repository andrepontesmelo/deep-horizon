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
  The compare-and-swap token (§4).
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

**`gaps.json` — temp + rename + compare-and-swap.**

1. Read the file, note `revision`.
2. Apply the mutation in memory.
3. Write to `.horizon/.gaps.json.tmp.<pid>` in the **same directory** (so
   `rename` stays atomic — a cross-filesystem rename is not).
4. `fsync` the temp file, `rename()` over `gaps.json`.
5. Before writing, re-read `revision`. If it changed, **abort with exit 6** —
   "the horizon changed underneath you, re-read and retry". Never clobber.

**`sessions.jsonl` — plain append.** One `O_APPEND` write of a single line
under `PIPE_BUF` is atomic on POSIX. No lock, no read, no parse.

**No lockfiles anywhere.** They strand when a process is killed, and HL-10
confirmed DSH's teardown does not run on `kill -9`.

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
| 6 | Revision conflict — the store changed mid-write | "re-read and retry" |
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
21. A write whose `revision` moved between read and write aborts with exit 6
    and leaves the file byte-identical.
22. No `.tmp` files remain after a successful write.
23. No `.tmp` file is left behind after a failed write.
24. A killed process mid-write leaves `gaps.json` parseable (temp+rename
    property).
25. 20 concurrent `session-end` appends produce 20 valid JSONL lines, none
    interleaved or truncated.

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

## 10. Open, deliberately

Not blockers for implementation; each is a fog patch on the map.

- Injection order when a model may read the first gap as most important
  (insertion order is the current default).
- Whether the store is committed or gitignored by default.
- Whether the 5-cap becomes a prompt-to-close rather than a hard reject, once
  the propose-and-confirm flow is real.
