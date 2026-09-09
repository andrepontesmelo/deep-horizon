import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export const STORE_VERSION = 1;
export const MAX_GAPS = 5;
export const MAX_TEXT_POINTS = 512;
export const HORIZON_DIR = ".horizon";
export const GAPS_FILE = "gaps.json";
export const SESSIONS_FILE = "sessions.jsonl";
export const CLOSES_FILE = "closes.jsonl";

export function usage() {
  return "usage: horizon [--cwd <path>] [--json] [--harness <name>] [--session <id>] [--origin <human|agent-proposed>] <show|add|close|amend|log|session-end|init> [...]";
}

export function codePoints(s) {
  return [...s].length;
}

export function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function mintId() {
  return `g_${randomBytes(4).toString("hex")}`;
}

export function validId(id) {
  return /^g_[0-9a-f]{8}$/.test(id);
}

// Sweep stranded temp files left by a SIGKILLed writer: unlink
// .gaps.json.tmp.* whose mtime is older than TMP_SWEEP_MS. Mtime is the only
// signal (spec 4.1 bans pid checks — they are POSIX-only): a temp is alive
// for well under a second in the write path, so one older than a minute can
// no longer be renamed by anyone; a fresh temp belongs to an in-flight
// writer and is never touched. Runs on store open, before any read or write,
// so one later CLI run clears whatever the kill left behind. No lockfiles.
export const TMP_PREFIX = ".gaps.json.tmp.";
export const TMP_SWEEP_MS = 60_000;

// Every value that crosses a store-file boundary must be a plain record
// (spec 7: anything else is malformed -> exit 7, never a TypeError).
export function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Failure shape shared by every store error: { code, message } with code
// from the spec 7 table (7 for unreadable/malformed/unusable, 6 for rename
// retries exhausted). Success is null, matching writeGapsFile.
export function sweepStaleTmps(storeDir) {
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
export function openStore(storeDir, { materialize = true } = {}) {
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
  if (!Array.isArray(data.gaps)) {
    return { ok: false, code: 7, message: `horizon: ${path}: invalid store: gaps is not an array` };
  }
  for (let i = 0; i < data.gaps.length; i += 1) {
    const g = data.gaps[i];
    if (!isRecord(g) || typeof g.id !== "string" || typeof g.text !== "string") {
      return { ok: false, code: 7, message: `horizon: ${path}: invalid store: gaps[${i}] is not a gap object with id and text` };
    }
  }
  return { ok: true, data };
}

export function emptyStore() {
  return { version: STORE_VERSION, revision: 0, gaps: [] };
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

export function writeGapsFile(storeDir, next) {
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
export function appendLine(storeDir, file, obj) {
  const path = join(storeDir, file);
  try {
    appendFileSync(path, JSON.stringify(obj) + "\n", { encoding: "utf8" });
  } catch (err) {
    return { code: 7, message: `horizon: ${path}: cannot append: ${err.message}` };
  }
  return null;
}

export function readCloses(storeDir, sessionId) {
  const path = join(storeDir, CLOSES_FILE);
  if (!existsSync(path)) return { ok: true, records: [] };
  const parsed = parseJsonlFile(path);
  if (!parsed.ok) return parsed;
  return { ok: true, records: parsed.records.filter((rec) => rec.session_id === sessionId) };
}

export function listTmpFiles(storeDir) {
  if (!existsSync(storeDir)) return [];
  return readdirSync(storeDir).filter((name) => name.startsWith(TMP_PREFIX));
}

// .gitattributes pins the store files to byte-exact form (spec 4.1): git
// honours .gitattributes in subdirectories, so a Windows checkout with
// core.autocrlf=true cannot rewrite sessions.jsonl into CRLF. An existing
// file is never clobbered (the user may have customised it).
// materializeStoreDir makes a store directory complete: it creates the
// directory, an absent gaps.json, and an absent .gitattributes. Idempotent
// on every field. Returns true when it created anything, or
// { code: 7, message } naming the path when the store cannot be created
// (the path exists as a file, or the parent refuses mkdir/writes).
export function materializeStoreDir(dir) {
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
