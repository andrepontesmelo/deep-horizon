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

export function sweepStaleTmps(storeDir) {
  if (!existsSync(storeDir)) return;
  for (const name of readdirSync(storeDir)) {
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
}

// Runs before every gaps.json read/write path: materializes the store
// directory (idempotent — a resolved store may predate .gitattributes, and a
// case-variant one was found by name, not created) and sweeps stale tmps, so
// any CLI command through a real store leaves it complete. resolveStore
// returns the result of this, which is the store dir.
export function openStore(storeDir) {
  try {
    materializeStoreDir(storeDir);
  } catch { /* read-only or racing creator: the store still reads */ }
  sweepStaleTmps(storeDir);
  return storeDir;
}

// Store resolution: walk up from start to the nearest ancestor containing
// .horizon/, the way git finds .git. Stop at the filesystem root. The
// directory name matches case-insensitively (spec 4.1): a store named
// .Horizon is discovered on case-insensitive filesystems, and the real name
// is returned so writes land in the existing directory instead of creating
// a second one.
export function resolveStore(startDir) {
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
        return openStore(candidate);
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
// Test-only hook: HORIZON_CLI_TEST_FAIL_RENAMES=<n> fails the first <n>
// rename attempts with {code:"EPERM"}, then proceeds. Production never sets
// it.
const RENAME_RETRY_DELAYS_MS = [10, 50, 200];

export function writeGapsFile(storeDir, next) {
  const path = join(storeDir, GAPS_FILE);
  const tmp = join(storeDir, `${TMP_PREFIX}${process.pid}.${(tmpSeq += 1)}`);
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
  let attempt = 0;
  for (;;) {
    let err = null;
    try {
      if (failLeft > 0) {
        failLeft -= 1;
        const fake = new Error("EPERM: operation not permitted, rename (test hook)");
        fake.code = "EPERM";
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
    return { code: 6, message: `horizon: ${path}: rename failed after 3 retries: ${errno}` };
  }
  return null;
}

// JSONL readers skip blank lines and strip one trailing \r per line before
// parsing, so a Windows checkout whose .gitattributes did not apply still
// parses (spec 4.1, X4).
function parseJsonl(raw) {
  const out = [];
  for (const line of raw.split("\n")) {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (clean.length === 0) continue;
    out.push(JSON.parse(clean));
  }
  return out;
}

export function readSessions(storeDir) {
  const path = join(storeDir, SESSIONS_FILE);
  if (!existsSync(path)) return [];
  return parseJsonl(readFileSync(path, "utf8"));
}

// sessions.jsonl / closes.jsonl: single appendFileSync write of one line
// terminated by an explicit \n. No read, no parse, no lock (spec 4).
export function appendLine(storeDir, file, obj) {
  const path = join(storeDir, file);
  appendFileSync(path, JSON.stringify(obj) + "\n", { encoding: "utf8" });
}

export function readCloses(storeDir, sessionId) {
  const path = join(storeDir, CLOSES_FILE);
  if (!existsSync(path)) return [];
  return parseJsonl(readFileSync(path, "utf8")).filter((rec) => rec && rec.session_id === sessionId);
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
// on every field. ensureStoreDir uses it for a brand-new store at cwd.
export function materializeStoreDir(dir) {
  let created = false;
  if (!existsSync(dir)) {
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
}

export function ensureStoreDir(cwd) {
  const dir = join(resolve(cwd), HORIZON_DIR);
  const created = materializeStoreDir(dir);
  return { dir, created };
}
