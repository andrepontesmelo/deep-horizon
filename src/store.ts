import { appendFileSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

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

// Sweep stranded temp files left by a SIGKILLed writer. A temp whose pid is
// dead (kill(pid, 0) throws ESRCH) can never be renamed by its owner; a live
// pid's temp belongs to an in-flight writer and is never touched. Runs on
// store open, before any read or write, so one later CLI run clears whatever
// the kill left behind. No lockfiles.
export const TMP_PREFIX = ".gaps.json.tmp.";

function pidDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // ESRCH: no such process. EPERM: a live process we may not signal.
    return err && err.code === "ESRCH";
  }
}

export function sweepStaleTmps(storeDir) {
  if (!existsSync(storeDir)) return;
  // Read the live revision once without recursing into the sweep.
  const live = readGapsFileNoSweep(storeDir);
  const liveRev = live.ok ? live.data.revision : null;
  for (const name of readdirSync(storeDir)) {
    // Claim files carry no pid; they strand only on a kill between link and
    // rename, in which case the claimed revision never advances past them.
    // A live writer may still rename its current-revision claim, so sweep a
    // claim only when its revision is already behind the live revision.
    if (name.startsWith(COMMIT_PREFIX)) {
      const revText = name.slice(COMMIT_PREFIX.length);
      if (!/^[0-9]+$/.test(revText)) continue;
      if (liveRev === null || Number(revText) < liveRev) {
        try {
          unlinkSync(join(storeDir, name));
        } catch { /* already gone */ }
      }
      continue;
    }
    if (!name.startsWith(TMP_PREFIX)) continue;
    if (name !== basename(name)) continue;
    // tmp: <pid>.<seq>
    const pidText = name.slice(TMP_PREFIX.length).split(".")[0];
    if (!pidText || !/^[1-9][0-9]*$/.test(pidText)) continue;
    if (!pidDead(Number(pidText))) continue;
    try {
      unlinkSync(join(storeDir, name));
    } catch { /* already gone */ }
  }
}

// Runs before every gaps.json read/write path. resolveStore returns the dir;
// this sweeps it, so any CLI command through a real store clears dead tmps.
export function openStore(storeDir) {
  sweepStaleTmps(storeDir);
  return storeDir;
}

// Store resolution: walk up from start to the nearest ancestor containing
// .horizon/, the way git finds .git. Stop at the filesystem root.
export function resolveStore(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, HORIZON_DIR))) return openStore(join(dir, HORIZON_DIR));
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readGapsFile(storeDir) {
  return readGapsFileNoSweep(storeDir);
}

function readGapsFileNoSweep(storeDir) {
  const path = join(storeDir, GAPS_FILE);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: false, code: 7, message: `horizon: ${path}: no such file` };
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
  return { ok: true, data, raw };
}

export function emptyStore() {
  return { version: STORE_VERSION, revision: 0, gaps: [] };
}

// gaps.json write: temp file in the same directory, fsync, re-check, rename.
// Unique temp per attempt (.tmp.<pid>.<seq>) so two concurrent writers never
// share a temp. Sequence: write tmp -> fsync -> link tmp to a per-revision
// claim name -> re-read revision -> rename claim over gaps.json.
// link() is atomic, so exactly one writer can hold the claim for a given
// source revision; the claim is created BEFORE the re-read, which closes the
// recheck-then-rename window: a writer that loses the claim (EEXIST) returns
// exit 6 with its text absent instead of silently clobbering the rival, and
// the claim file itself keeps the temp+rename property (gaps.json is only
// ever replaced by a whole-file rename, so a kill mid-write leaves it
// parseable; stranded claims sweep like stranded tmps). No lockfiles.
let tmpSeq = 0;

export const COMMIT_PREFIX = ".gaps.json.commit.";

export function writeGapsFile(storeDir, expectedRevision, next) {
  const path = join(storeDir, GAPS_FILE);
  const seq = `${process.pid}.${tmpSeq += 1}`;
  const tmp = join(storeDir, `${TMP_PREFIX}${seq}`);
  // One claim per source revision: the atomic link below makes exactly one
  // writer the owner of revision N -> N+1, no matter how the syscalls interleave.
  const claim = join(storeDir, `${COMMIT_PREFIX}${expectedRevision}`);
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch (err) {
    return { code: 7, message: `horizon: ${path}: cannot write: ${err.message}` };
  }
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Claim BEFORE re-reading: link() either makes us the owner of this
  // revision or tells us (EEXIST) a rival already owns it.
  try {
    linkSync(tmp, claim);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch { /* already gone */ }
    if (err && err.code === "EEXIST") {
      return { code: 6, message: "horizon: the horizon changed underneath you, re-read and retry." };
    }
    return { code: 7, message: `horizon: ${path}: cannot write: ${err.message}` };
  }
  // We own the claim. Re-read: if the revision already moved (a previous
  // owner committed, or the file changed any other way), release the claim
  // and report the conflict; our text stays absent.
  const live = readGapsFileNoSweep(storeDir);
  if (!live.ok || live.data.revision !== expectedRevision) {
    for (const p of [claim, tmp]) {
      try {
        unlinkSync(p);
      } catch { /* already gone */ }
    }
    if (!live.ok) return { code: live.code, message: live.message };
    return { code: 6, message: "horizon: the horizon changed underneath you, re-read and retry." };
  }
  try {
    renameSync(claim, path);
  } catch (err) {
    for (const p of [claim, tmp]) {
      try {
        unlinkSync(p);
      } catch { /* already gone */ }
    }
    return { code: 7, message: `horizon: ${path}: cannot write: ${err.message}` };
  }
  try {
    unlinkSync(tmp);
  } catch { /* already gone */ }
  return null;
}

export function readSessions(storeDir) {
  const path = join(storeDir, SESSIONS_FILE);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return raw.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

// sessions.jsonl / closes.jsonl: single O_APPEND write of one line.
export function appendLine(storeDir, file, obj) {
  const path = join(storeDir, file);
  appendFileSync(path, JSON.stringify(obj) + "\n", { encoding: "utf8" });
}

export function readCloses(storeDir, sessionId) {
  const path = join(storeDir, CLOSES_FILE);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
    .filter((rec) => rec && rec.session_id === sessionId);
}

export function listTmpFiles(storeDir) {
  if (!existsSync(storeDir)) return [];
  return readdirSync(storeDir).filter(
    (name) => name.startsWith(TMP_PREFIX) || name.startsWith(COMMIT_PREFIX),
  );
}

export function ensureStoreDir(cwd) {
  const dir = join(resolve(cwd), HORIZON_DIR);
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
  return { dir, created };
}
