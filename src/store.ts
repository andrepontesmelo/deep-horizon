import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { gapLine } from "./texts.ts";

export const STORE_VERSION = 1;
export const MAX_GAPS = 5;
export const MAX_TEXT_POINTS = 512;
// Per-gap details (optional extended context): multi-line allowed, so the only
// shape rule is the cap. Rejected at write time, never truncated.
export const MAX_DETAIL_POINTS = 2048;
const HORIZON_DIR = ".horizon";
const GAPS_FILE = "gaps.json";
// Exported for the test invariant: a freshly materialized store's .gitignore
// must cover every append-only file the store writes (test/cli.test.js X6).
export const SESSIONS_FILE = "sessions.jsonl";
export const CLOSES_FILE = "closes.jsonl";
export const HOOKS_LOG_FILE = "hooks.log";
const GITIGNORE_BODY = "sessions.jsonl\ncloses.jsonl\nhooks.log\n*.tmp.*\n";

export function usage() {
  return "usage: horizon [--cwd <path>] [--json] [--harness <name>] [--session <id>] [--origin <human|agent-proposed>] <show|about|add|close|amend|detail|log|session-end|init|doctor|install> [...]";
}

function codePoints(s) {
  return [...s].length;
}

// Wall-clock stamp for every record the store writes (added_at, close ts,
// session-record ts): ISO 8601 with the milliseconds trimmed.
function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Gap ids are caller-supplied slugs, not minted tokens: 3–40 chars, lowercase
// letters and digits, hyphen-separated, starting with a letter. The id is a
// name the caller chooses on add, and it is never reused — closed_ids retires
// it for the life of the project. There is no compatibility with the old
// minted `g_<8 hex>` shape: a store carrying one is malformed (exit 7), and a
// caller supplying one gets a usage error.
function validId(id) {
  return typeof id === "string" && id.length >= 3 && id.length <= 40 && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id);
}

// Sweep stranded temp files left by a SIGKILLed writer: unlink
// .gaps.json.tmp.* whose mtime is older than TMP_SWEEP_MS. Mtime is the only
// signal (spec 4.1 bans pid checks — they are POSIX-only): a temp is alive
// for well under a second in the write path, so one older than a minute can
// no longer be renamed by anyone; a fresh temp belongs to an in-flight
// writer and is never touched. Runs on store open, before any read or write,
// so one later CLI run clears whatever the kill left behind. No lockfiles.
const TMP_PREFIX = ".gaps.json.tmp.";
const TMP_SWEEP_MS = 60_000;

// Every value that crosses a store-file boundary must be a plain record
// (spec 7: anything else is malformed -> exit 7, never a TypeError).
// Internal: the adapters guard their own wire payloads locally — nothing
// outside this module imports the guard.
function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Failure shape shared by every store error: { code, message } with code
// from the spec 7 table (7 for unreadable/malformed/unusable, 6 for rename
// retries exhausted). Success is null, matching writeGapsFile.
function sweepStaleTmps(storeDir) {
  if (!existsSync(storeDir)) return null;
  let names;
  try {
    names = readdirSync(storeDir);
  } catch (err) {
    return { code: 7, message: `horizon: ${storeDir}: ${err.message}` };
  }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const p = join(storeDir, name);
    try {
      if (Date.now() - statSync(p).mtimeMs <= TMP_SWEEP_MS) continue;
    } catch {
      continue; // vanished (its owner just renamed it): nothing to sweep
    }
    try {
      unlinkSync(p);
    } catch { /* already gone */ }
  }
  return null;
}

// openStore returns { dir } on success or { code, message } on failure.
// Runs before every gaps.json read/write path: materializes the store
// directory (idempotent — a resolved store may predate .gitattributes, and a
// case-variant one was found by name, not created) and sweeps stale tmps, so
// any CLI command through a real store leaves it complete.
// `materialize: false` is the read-only mode used by horizon-inject (D6:
// pure composition, no store writes) — it skips both the materializing
// writes and the tmp sweep (an unlink is a write too).
function openStore(storeDir, { materialize = true } = {}) {
  if (materialize) {
    try {
      materializeStoreDir(storeDir);
    } catch (err) {
      return { code: 7, message: `horizon: ${storeDir}: ${err.message}` };
    }
    const sweep = sweepStaleTmps(storeDir);
    if (sweep) return sweep;
  }
  return { dir: storeDir };
}

// Store resolution: walk up from start to the nearest ancestor containing
// .horizon/, the way git finds .git, and stop at the filesystem root. The
// directory name matches case-insensitively (spec 4.1): a store named
// .Horizon is discovered on case-insensitive filesystems, and the real name
// is returned so writes land in the existing directory instead of creating
// a second one. Returns { dir, open: openStore(...) } for the nearest store,
// or null when none exists; `open` carries { code, message } when the store
// cannot be opened (unreadable dir, failed sweep) so callers can exit 7.
// `readonly: true` skips openStore's materializing writes and tmp sweep
// (horizon-inject's no-writes contract, D6).
export function resolveStore(startDir, { readonly = false } = {}) {
  let dir = resolve(startDir);
  for (;;) {
    let entries = null;
    try {
      entries = readdirSync(dir);
    } catch { /* unreadable ancestor: keep walking up */ }
    if (entries) {
      for (const name of entries) {
        if (name.toLowerCase() !== HORIZON_DIR) continue;
        const candidate = join(dir, name);
        try {
          if (!statSync(candidate).isDirectory()) continue;
        } catch {
          continue; // vanished or unstattable: not a store
        }
        return { dir: candidate, open: openStore(candidate, { materialize: !readonly }) };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// An explicit store dir (--store, the close hooks' round-trip) is trusted,
// not discovered, and what counts as a store is the same test the walk above
// applies to a candidate: an existing directory. Absent or not a directory
// returns null — the storeless twin — and an existing path resolves
// lexically so reads and appends land in the handed-back dir.
function explicitStoreDir(path) {
  let st = null;
  try {
    st = statSync(path);
  } catch { /* absent: the storeless twin */ }
  if (!st || !st.isDirectory()) return null;
  return resolve(path);
}

// True when the bootstrap nudge must be silenced: a session whose cwd IS the
// user's home with no store found anywhere above it is not a project, and
// offering to horizon-ize $HOME is a misfire. A store found at all — even at
// $HOME itself, a deliberate user choice — never suppresses. Lexical resolve,
// not realpath, so the comparison holds for paths that do not exist yet.
export function suppressBootstrap({ cwd, storeFound, home }) {
  if (storeFound) return false;
  return resolve(cwd) === resolve(home);
}

// An absent gaps.json is an empty store, not an error (spec 4 step 1, 7):
// every store starts empty before its first write. Malformed JSON, a wrong
// version, or a bad shape is still exit 7.
export function readGapsFile(storeDir) {
  const path = join(storeDir, GAPS_FILE);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, data: emptyStore() };
    }
    return { ok: false, code: 7, message: `horizon: ${path}: ${err.message}` };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, code: 7, message: `horizon: ${path}: invalid JSON: ${err.message}` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, code: 7, message: `horizon: ${path}: invalid store: expected an object` };
  }
  if (data.version !== STORE_VERSION) {
    return { ok: false, code: 7, message: `horizon: ${path}: unsupported version ${JSON.stringify(data.version)}; expected ${STORE_VERSION}` };
  }
  if (!Number.isInteger(data.revision) || data.revision < 0) {
    return { ok: false, code: 7, message: `horizon: ${path}: invalid store: bad revision` };
  }
  // `about` (the human-authored one line saying what this project IS) is
  // optional: absent = unset, and version stays 1 either way. Present, it
  // must be a string — anything else is the same malformed-store exit as the
  // checks above, never a silent drop (spec 1.1, 10.4).
  if (data.about !== undefined && typeof data.about !== "string") {
    return { ok: false, code: 7, message: `horizon: ${path}: invalid store: about is not a string` };
  }
  if (!Array.isArray(data.gaps)) {
    return { ok: false, code: 7, message: `horizon: ${path}: invalid store: gaps is not an array` };
  }
  // `closed_ids` — every id ever closed, so `add` can reject a reuse forever
  // (spec 3.2). Missing reads as empty (stores written before the field
  // existed stay valid) and is written on the next save; present, it must be
  // an array of valid ids — anything else is the same malformed-store exit as
  // the checks above.
  if (data.closed_ids === undefined) data.closed_ids = [];
  if (!Array.isArray(data.closed_ids)) {
    return { ok: false, code: 7, message: `horizon: ${path}: invalid store: closed_ids is not an array` };
  }
  for (let i = 0; i < data.closed_ids.length; i += 1) {
    if (!validId(data.closed_ids[i])) {
      return { ok: false, code: 7, message: `horizon: ${path}: invalid store: closed_ids[${i}] is not a valid gap id` };
    }
  }
  for (let i = 0; i < data.gaps.length; i += 1) {
    const g = data.gaps[i];
    if (!isRecord(g) || typeof g.id !== "string" || typeof g.text !== "string") {
      return { ok: false, code: 7, message: `horizon: ${path}: invalid store: gaps[${i}] is not a gap object with id and text` };
    }
    if (!validId(g.id)) {
      return { ok: false, code: 7, message: `horizon: ${path}: invalid store: gaps[${i}] has an invalid gap id: ${JSON.stringify(g.id)}` };
    }
    // `details` (optional extended context behind the one line) is optional:
    // absent = unset. Present, it must be a string — the same malformed-store
    // exit as the checks above, never a silent drop. The 2048 cap is a write-
    // time rejection (exit 3), not a read-time one, like every text cap here.
    if (g.details !== undefined && typeof g.details !== "string") {
      return { ok: false, code: 7, message: `horizon: ${path}: invalid store: gaps[${i}].details is not a string` };
    }
  }
  return { ok: true, data };
}

function emptyStore() {
  return { version: STORE_VERSION, revision: 0, gaps: [], closed_ids: [] };
}

let tmpSeq = 0;

// Blocking sleep for the rename backoff: Atomics.wait parks the thread
// without spinning; the busy-wait is the fallback where SharedArrayBuffer is
// unavailable. writeGapsFile is synchronous, so timers are not an option.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* burn until real time has passed */ }
  }
}

// gaps.json write: temp file in the same directory, fsync, rename over the
// live file (spec 4). No lock, no claim, no re-read: concurrency is
// last-writer-wins, an accepted risk (Andre, 2026-09-09). gaps.json is only
// ever replaced by a whole-file rename, so a reader or a kill can never see
// a torn document; a kill strands at most a temp, which the sweep clears.
// rename fails transiently with EPERM/EBUSY/EACCES on Windows (antivirus,
// search indexers, editors holding the destination open), so it is retried
// at 10 ms, 50 ms, 200 ms — 4 attempts total — and exhaustion is exit 6
// naming the file and the errno (spec 4 step 5, 7).
// revision is a plain monotonic counter the caller increments; it is never
// re-read and a moved revision never aborts a write (spec 4).
// Test-only hooks: HORIZON_CLI_TEST_FAIL_RENAMES=<n> fails the first <n>
// rename attempts, then proceeds; HORIZON_CLI_TEST_RENAME_ERRNO=<code>
// chooses the errno those failures report (default EPERM). Production never
// sets either.
const RENAME_RETRY_DELAYS_MS = [10, 50, 200];

function writeGapsFile(storeDir, next) {
  const path = join(storeDir, GAPS_FILE);
  const tmp = join(storeDir, `${TMP_PREFIX}${process.pid}.${(tmpSeq += 1)}.${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch { /* never created */ }
    return { code: 7, message: `horizon: ${path}: cannot write: ${err.message}` };
  }
  try {
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch { /* already gone */ }
    return { code: 7, message: `horizon: ${path}: cannot write: ${err.message}` };
  }
  let failLeft = Number(process.env.HORIZON_CLI_TEST_FAIL_RENAMES) || 0;
  const fakeErrno = process.env.HORIZON_CLI_TEST_RENAME_ERRNO || "EPERM";
  let attempt = 0;
  for (;;) {
    let err = null;
    try {
      if (failLeft > 0) {
        failLeft -= 1;
        const fake = new Error(`${fakeErrno}: rename failed (test hook)`);
        fake.code = fakeErrno;
        throw fake;
      }
      renameSync(tmp, path);
    } catch (caught) {
      err = caught;
    }
    if (!err) break;
    if (attempt < RENAME_RETRY_DELAYS_MS.length) {
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
      attempt += 1;
      continue;
    }
    try {
      unlinkSync(tmp);
    } catch { /* already gone */ }
    const errno = err && err.code ? err.code : (err && err.message) || "UNKNOWN";
    if (errno === "ENOENT") {
      // The 60 s sweep can remove a live writer's tmp (VM pause / SIGSTOP
      // past TMP_SWEEP_MS): the store is intact at its old revision, only
      // this write failed. Name the real cause instead of blaming the OS.
      return { code: 6, message: `horizon: ${path}: rename failed after 3 retries: ENOENT — temp file vanished (swept); retry the command` };
    }
    return { code: 6, message: `horizon: ${path}: rename failed after 3 retries: ${errno}` };
  }
  return null;
}

// JSONL readers skip blank lines and strip one trailing \r per line before
// parsing, so a Windows checkout whose .gitattributes did not apply still
// parses (spec 4.1, X4). A line that is not a JSON object — syntactically
// invalid, or valid JSON that is not an object (a bare null) — makes the
// whole file malformed (spec 7): the reader returns
// { ok: false, code: 7, message } naming the file, so no caller ever sees a
// null record and `log --json` never emits one.
function parseJsonlFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, code: 7, message: `horizon: ${path}: ${err.message}` };
  }
  const records = [];
  for (const line of raw.split("\n")) {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (clean.length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(clean);
    } catch (err) {
      return { ok: false, code: 7, message: `horizon: ${path}: invalid JSONL: ${err.message}` };
    }
    if (!isRecord(rec)) {
      return { ok: false, code: 7, message: `horizon: ${path}: invalid JSONL: line is not an object` };
    }
    records.push(rec);
  }
  return { ok: true, records };
}

export function readSessions(storeDir) {
  const path = join(storeDir, SESSIONS_FILE);
  if (!existsSync(path)) return { ok: true, records: [] };
  return parseJsonlFile(path);
}

// sessions.jsonl / closes.jsonl: single appendFileSync write of one line
// terminated by an explicit \n. No read, no parse, no lock (spec 4).
// Returns null on success, or { code: 7, message } naming the file.
// Internal: closeGap and recordSession are the only appenders.
function appendLine(storeDir, file, obj) {
  const path = join(storeDir, file);
  try {
    appendFileSync(path, JSON.stringify(obj) + "\n", { encoding: "utf8" });
  } catch (err) {
    return { code: 7, message: `horizon: ${path}: cannot append: ${err.message}` };
  }
  return null;
}

// --- hooks.log (ticket 09: the one observability channel) ---
//
// One append-only line per BIN fire — the bins write it (horizon-inject,
// horizon session-end), never the adapters, so every harness that shells out
// gets logging for free — into the resolved store's .horizon/hooks.log:
//
//   <iso-ts> <harness> <bin> session=<id|-> store=<resolved|-> outcome=<...>
//
// outcome is injected|nudged|silent for horizon-inject (the section-10
// variants plus the empty composition) and recorded|error for session-end
// (an idempotent repeat still logs recorded: the pair's record IS in that
// store — the line says how the fire ended, not that bytes moved).
// Storeless fires (the nudge, the silence, a vanished --store) stay
// unlogged: there is no store to log into, and that class was always
// diagnosed from harness logs — the invisible class was store-side drops.
//
// The whole contract is best-effort: the logging hangs off fail-open hooks,
// so this helper NEVER raises, NEVER changes an exit code, and NEVER blocks
// the write it accompanies — an unwritable hooks.log costs the line, never
// the hook. Note an accepted gap: an EXISTING store's .gitignore predates
// this file and will not list it (the ignore body ships only with newly
// materialized stores); the log is diagnostics, not data, so no store is
// ever rewritten just to add the line.
export function appendHooksLog(storeDir, { harness, bin, session, outcome }) {
  try {
    appendFileSync(
      join(storeDir, HOOKS_LOG_FILE),
      `${utcNow()} ${harness} ${bin} session=${session || "-"} store=${storeDir} outcome=${outcome}\n`,
      { encoding: "utf8" },
    );
  } catch { /* the line is lost, never the hook */ }
}

// Close records for one session: the whole file parsed, then filtered by
// session_id — the only reader is recordSession's join. An absent file is
// an empty history, like sessions.jsonl.
function readCloses(storeDir, sessionId) {
  const path = join(storeDir, CLOSES_FILE);
  if (!existsSync(path)) return { ok: true, records: [] };
  const parsed = parseJsonlFile(path);
  if (!parsed.ok) return parsed;
  return { ok: true, records: parsed.records.filter((rec) => rec.session_id === sessionId) };
}

// --- The per-concept write interface ---
//
// Every gaps.json rewrite funnels through nextDocument, so the write
// invariant is enforced once, here, and cannot be forgotten by a second
// writer: the revision bumps by exactly one, closed_ids always carry forward,
// and the about line is preserved unless the mutation itself replaces or
// removes it. Rebuilding the store as a bare {version, revision, gaps} would
// silently drop the about line (spec 10.4) and the closed ids (spec 3.2) —
// about carries only when the current store carries it (an unset store stays
// without the field), closed_ids always (readGapsFile defaults it to []).
function nextDocument(cur, gaps) {
  const next = { version: STORE_VERSION, revision: cur.revision + 1, gaps, closed_ids: cur.closed_ids ?? [] };
  if (cur.about !== undefined) next.about = cur.about;
  return next;
}

// One-line text validation shared by gap text and the about line (spec 10.4:
// the about line is validated identically in shape to gap text). `label`
// names the field in the message so the failure is never mysterious.
function validateOneLineText(text, label) {
  if (text.length === 0) return `horizon: ${label} is empty; not saved.`;
  if (text.trim().length === 0) return `horizon: ${label} is blank; not saved.`;
  if (text.includes("\n") || text.includes("\r")) {
    return `horizon: ${label} contains a newline; not saved.`;
  }
  const n = codePoints(text);
  if (n > MAX_TEXT_POINTS) {
    return `horizon: ${label} is ${n} code points; the limit is ${MAX_TEXT_POINTS}. Not saved.`;
  }
  return null;
}

function validateGapText(text) {
  return validateOneLineText(text, "gap text");
}

// Details (optional extended context behind a gap's one line) relax the shape:
// multi-line is allowed, so only emptiness and the cap are enforced. Same
// rejection discipline as the title: state the actual count, never truncate.
function validateDetailText(text) {
  if (text.length === 0) return "horizon: gap details are empty; not saved.";
  if (text.trim().length === 0) return "horizon: gap details are blank; not saved.";
  const n = codePoints(text);
  if (n > MAX_DETAIL_POINTS) {
    return `horizon: gap details are ${n} code points; the limit is ${MAX_DETAIL_POINTS}. Not saved.`;
  }
  return null;
}

function capMessage(gaps) {
  const lines = gaps.map(gapLine);
  return `horizon: at capacity: ${gaps.length} gaps already open; close one first.\n${lines.join("\n")}`;
}

// The write-side opening ritual every mutating gap operation shares: resolve
// the nearest store; when none exists, either create one at cwd (add and
// about-set are the only writers that may bootstrap a store) or hand null
// back so the caller applies its own no-store semantics (close/amend/detail
// report an unknown id; `about --clear` is a silent no-op). Prints the
// "created" line on stderr, as the verbs always did. Returns { dir } on
// success, { error } when the store cannot be opened or created, or null
// when no store exists and none was to be created.
function openForWrite(cwd, create) {
  const found = resolveStore(cwd);
  if (found) {
    if (found.open.code !== undefined) return { error: found.open };
    return { dir: found.dir };
  }
  if (!create) return null;
  const m = ensureStoreDir(cwd);
  if (m.code !== undefined) return { error: m };
  process.stderr.write(`horizon: created ${m.dir}\n`);
  return { dir: m.dir };
}

// addGap appends one gap under a caller-chosen slug id. Validates in the
// order the usage errors teach (id grammar, then title, then details — a bad
// detail rejects the whole add so no half-written gap lands), bootstraps a
// storeless cwd, enforces the count cap (exit 4) and the never-reuse rule
// against open gaps and closed_ids alike (exit 8), and stamps added_at and
// the provenance record itself. Returns null on success, or { code, message }
// carrying the verb's exit code.
export function addGap(cwd, { id, text, details, harness, sessionId, tty, origin }) {
  if (!validId(id)) {
    return { code: 2, message: `horizon: invalid gap id: ${id}; ids are 3-40 chars of a-z, 0-9, and hyphens, starting with a letter` };
  }
  const bad = validateGapText(text);
  if (bad) return { code: 3, message: bad };
  if (details !== undefined) {
    const badDetail = validateDetailText(details);
    if (badDetail) return { code: 3, message: badDetail };
  }
  const opened = openForWrite(cwd, true);
  if (opened.error) return opened.error;
  const cur = readGapsFile(opened.dir);
  if (!cur.ok) return { code: cur.code, message: cur.message };
  if (cur.data.gaps.length >= MAX_GAPS) return { code: 4, message: capMessage(cur.data.gaps) };
  // Ids are never reused for the life of the project: a collision with an
  // open gap or with closed_ids is a hard reject (exit 8), not a remint.
  if (cur.data.gaps.some((g) => g.id === id)) {
    return { code: 8, message: `horizon: duplicate gap id: ${id} is already open. Choose another id.` };
  }
  if (cur.data.closed_ids.includes(id)) {
    return { code: 8, message: `horizon: duplicate gap id: ${id} was closed and ids are never reused. Choose another id.` };
  }
  const gap = {
    id,
    text,
    added_at: utcNow(),
    provenance: { harness, session_id: sessionId, tty, origin },
  };
  if (details !== undefined) gap.details = details;
  return writeGapsFile(opened.dir, nextDocument(cur.data, [...cur.data.gaps, gap]));
}

// The preamble closeGap, amendGap, setDetail, and readGap share: the id must
// be legal, the store resolved (never created), the document readable, and
// the gap found — each failure its own exit, in the order the tests pin. An
// id off the slug grammar can never exist in a store (read validation
// rejects such stores), so it is rejected as invalid, exit 5, the same
// family as an unknown id but named for what it is. Returns
// { dir, cur, gap } on success, or { error } carrying { code, message }.
function loadOpenGap(cwd, id) {
  if (!validId(id)) return { error: { code: 5, message: `horizon: invalid gap id: ${id}` } };
  const opened = openForWrite(cwd, false);
  if (opened === null) return { error: { code: 5, message: `horizon: unknown gap id: ${id}` } };
  if (opened.error) return { error: opened.error };
  const cur = readGapsFile(opened.dir);
  if (!cur.ok) return { error: { code: cur.code, message: cur.message } };
  const gap = cur.data.gaps.find((g) => g.id === id);
  if (!gap) return { error: { code: 5, message: `horizon: unknown gap id: ${id}` } };
  return { dir: opened.dir, cur, gap };
}

// closeGap removes an open gap and retires its id in the same write
// (closed_ids grows), never creating a store: a storeless cwd means the id
// cannot exist (exit 5). Record first (ADV-3) — the invariant every record
// append in this module follows: the jsonl record lands before the durable
// state moves (here, closes.jsonl before gaps.json shrinks; at session-end,
// recordSession's append is the verb's only write), so a failed append is
// exit 7 and the store is unchanged. `sessionId` names the closing session
// on the record.
export function closeGap(cwd, id, sessionId) {
  const loaded = loadOpenGap(cwd, id);
  if (loaded.error) return loaded.error;
  const next = nextDocument(loaded.cur.data, loaded.cur.data.gaps.filter((g) => g.id !== id));
  next.closed_ids = [...loaded.cur.data.closed_ids, id];
  const a = appendLine(loaded.dir, CLOSES_FILE, {
    ts: utcNow(),
    session_id: sessionId,
    gap_id: id,
    added_session_id:
      loaded.gap.provenance && typeof loaded.gap.provenance.session_id === "string"
        ? loaded.gap.provenance.session_id
        : "unknown",
  });
  if (a) return a;
  return writeGapsFile(loaded.dir, next);
}

// The store a session-end fire lands in — recordSession's own two-form
// resolution pulled out so the bin's hooks.log line (ticket 09, via
// sessionEndStoreDir's caller in cli.ts) names the same store the record
// went to without re-deriving the rule and drifting from it. An explicit
// --store is trusted but checked (absent or a non-directory is the storeless
// twin); a cwd walks up. Null is the storeless twin: no record, no log line.
export function sessionEndStoreDir(cwd, store) {
  if (store !== null) return explicitStoreDir(store);
  const r = resolveStore(cwd);
  return r ? r.dir : null;
}

// recordSession appends the one session record (CONTEXT: Session record),
// once per (harness, session_id): a record already in sessions.jsonl for the
// pair makes the call a silent no-op — the first record wins and a later
// call's summary is dropped — while distinct pairs keep appending.
// The join lives here, beside the schemas it reads: gaps.json and
// closes.jsonl are this module's writes (the close records are closeGap's),
// so the verb never re-learns their shapes. `store` is the close hooks'
// round-trip — the dir horizon-inject --json already resolved, handed back
// so teardown does not re-discover it (the harness process may have chdir'd
// since the injection). A store path absent or not a directory, like a cwd
// with no store anywhere above it, is the storeless twin: a silent no-op,
// the store-vanished-mid-session case at teardown — nothing created,
// nothing recorded. A store that exists is read by the normal paths, so a
// malformed one still exits 7.
// Added gaps are inferred from the store, never carried in: an open gap
// whose provenance names this session was added by it. The orphan filter
// counts a close record only when its gap is actually gone — a record
// stranded by a crash between the append and the rename is a no-op, not a
// phantom close. The union closes the one hole the inference cannot see: a
// gap added and closed by the same session is no longer open, so its close
// record is what carries the id into gaps_added as well.
export function recordSession(cwd, { harness, sessionId, summary = null, store = null }) {
  let storeDir = null;
  if (store !== null) {
    storeDir = explicitStoreDir(store);
    if (storeDir === null) return null;
  } else {
    const r = resolveStore(cwd);
    if (!r) return null;
    if (r.open.code !== undefined) return r.open;
    storeDir = r.dir;
  }
  const g = readGapsFile(storeDir);
  if (!g.ok) return { code: g.code, message: g.message };
  const c = readCloses(storeDir, sessionId);
  if (!c.ok) return { code: c.code, message: c.message };
  // The dedupe read keeps the malformed-store discipline (an unreadable
  // sessions.jsonl is exit 7, never an unchecked append) and scans the whole
  // file: append-only jsonl has no index, and this is the read `log` and the
  // closes join already make.
  const seen = readSessions(storeDir);
  if (!seen.ok) return { code: seen.code, message: seen.message };
  if (seen.records.some((rec) => rec.harness === harness && rec.session_id === sessionId)) return null;
  const added = [];
  for (const gap of g.data.gaps) {
    if (gap.provenance && gap.provenance.session_id === sessionId && !added.includes(gap.id)) added.push(gap.id);
  }
  const openIds = new Set(g.data.gaps.map((gap) => gap.id));
  const closedIds = [];
  for (const rec of c.records) {
    if (!openIds.has(rec.gap_id) && !closedIds.includes(rec.gap_id)) closedIds.push(rec.gap_id);
    // The same-session add+close hole the provenance scan cannot see: the
    // gap is no longer open, so the close record's added_session_id is the
    // only witness that THIS session added it. Any other added_session_id
    // (another session, or the pre-0.4 "unknown") closes only — a session
    // that closes an old gap must not inherit its authorship.
    if (rec.added_session_id === sessionId && !added.includes(rec.gap_id)) added.push(rec.gap_id);
  }
  return appendLine(storeDir, SESSIONS_FILE, {
    ts: utcNow(),
    harness,
    session_id: sessionId,
    summary,
    gaps_added: added,
    gaps_closed: closedIds,
  });
}

// amendGap rewrites one gap's text in place — the wording was wrong, not the
// want (CONTEXT: Amend). Same never-creates discipline as closeGap, and the
// text cap is checked only after the id is known to be open, matching the
// exits the CLI taught (an unknown id beats a bad text).
export function amendGap(cwd, id, text) {
  const loaded = loadOpenGap(cwd, id);
  if (loaded.error) return loaded.error;
  const bad = validateGapText(text);
  if (bad) return { code: 3, message: bad };
  const gaps = loaded.cur.data.gaps.map((g) => (g.id === id ? { ...g, text } : g));
  return writeGapsFile(loaded.dir, nextDocument(loaded.cur.data, gaps));
}

// setDetail writes or clears one gap's extended context (the title line and
// the rest of the gap are untouched). Clear drops the field entirely so an
// unset gap stays without it. Like amend (which appends nothing), detail
// changes log nothing: they are visible through the revision counter only.
export function setDetail(cwd, id, { text = null, clear = false }) {
  const loaded = loadOpenGap(cwd, id);
  if (loaded.error) return loaded.error;
  if (!clear) {
    const bad = validateDetailText(text);
    if (bad) return { code: 3, message: bad };
  }
  const gaps = loaded.cur.data.gaps.map((g) => {
    if (g.id !== id) return g;
    if (clear) {
      const { details: _dropped, ...rest } = g;
      return rest;
    }
    return { ...g, details: text };
  });
  return writeGapsFile(loaded.dir, nextDocument(loaded.cur.data, gaps));
}

// setAbout writes or clears the human-authored one line saying what the
// project IS (spec 10.4). Setting may bootstrap a storeless project, exactly
// like add; clearing a storeless cwd is a silent no-op — nothing to unset,
// no store to create. Clear writes the store WITHOUT the about field, so an
// unset store stays without it.
export function setAbout(cwd, { text = null, clear = false }) {
  if (!clear) {
    const bad = validateOneLineText(text, "about text");
    if (bad) return { code: 3, message: bad };
  }
  const opened = openForWrite(cwd, !clear);
  if (opened === null) return null;
  if (opened.error) return opened.error;
  const cur = readGapsFile(opened.dir);
  if (!cur.ok) return { code: cur.code, message: cur.message };
  const next = nextDocument(cur.data, cur.data.gaps);
  if (clear) delete next.about;
  else next.about = text;
  return writeGapsFile(opened.dir, next);
}

// readGap resolves one open gap by id through the same discipline as the
// mutations (invalid id exit 5, unknown id exit 5, each named for what it
// is), so a reader verb — `horizon detail <id>` print mode — rejects exactly
// like a writer. { ok, data: gap } or { ok: false, code, message }.
export function readGap(cwd, id) {
  const loaded = loadOpenGap(cwd, id);
  if (loaded.error) return { ok: false, ...loaded.error };
  return { ok: true, data: loaded.gap };
}

// .gitattributes pins the store files to byte-exact form (spec 4.1): git
// honours .gitattributes in subdirectories, so a Windows checkout with
// core.autocrlf=true cannot rewrite sessions.jsonl into CRLF. An existing
// file is never clobbered (the user may have customised it).
// .gitignore keeps sessions.jsonl and hooks.log (append-only machine noise:
// unbounded, and two clones appending to one tracked file conflict on every
// pull) and the atomic-write tmp files out of git, without touching the
// repo's root .gitignore (spec: 09-open-items-resolved B). gaps.json stays
// committed —
// the horizon is a repo-level artifact that travels. An existing file is
// never clobbered.
// materializeStoreDir makes a store directory complete: it creates the
// directory, an absent gaps.json, an absent .gitattributes, and an absent
// .gitignore. Idempotent on every field. Returns true when it created
// anything, or { code: 7, message } naming the path when the store cannot
// be created (the path exists as a file, or the parent refuses
// mkdir/writes).
function materializeStoreDir(dir) {
  let st = null;
  try {
    st = statSync(dir);
  } catch { /* absent is the normal case */ }
  if (st && !st.isDirectory()) {
    return { code: 7, message: `horizon: ${dir}: exists and is not a directory; remove or rename it to use this path` };
  }
  try {
    let created = false;
    if (!st) {
      mkdirSync(dir, { recursive: true });
      created = true;
    }
    const gapsPath = join(dir, GAPS_FILE);
    if (!existsSync(gapsPath)) {
      writeFileSync(gapsPath, JSON.stringify(emptyStore(), null, 2) + "\n", "utf8");
      created = true;
    }
    const attrPath = join(dir, ".gitattributes");
    if (!existsSync(attrPath)) {
      writeFileSync(attrPath, "* -text\n", "utf8");
    }
    const ignorePath = join(dir, ".gitignore");
    if (!existsSync(ignorePath)) {
      writeFileSync(ignorePath, GITIGNORE_BODY, "utf8");
    }
    return created;
  } catch (err) {
    return { code: 7, message: `horizon: ${dir}: cannot create: ${err.message}` };
  }
}

export function ensureStoreDir(cwd) {
  const dir = join(resolve(cwd), HORIZON_DIR);
  const created = materializeStoreDir(dir);
  if (created && created.code !== undefined) return created;
  return { dir, created };
}
