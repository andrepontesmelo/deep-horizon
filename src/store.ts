import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
    // Claim symlinks name their owner's tmp (and thus its pid), but the
    // sweep never steals a claim at the live revision: the owner may be
    // alive and about to commit, and stealing is writeGapsFile's job
    // (claimIsStale: dead pid, or unprovable liveness past CLAIM_STALE_MS).
    // Claims behind the live revision can never be committed by anyone and
    // are garbage-collected here.
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

// gaps.json write: temp file in the same directory, fsync, claim, re-check,
// rename. Unique temp per attempt (.tmp.<pid>.<seq>) so two concurrent
// writers never share a temp. Sequence: write tmp -> fsync -> symlink tmp to
// the per-revision claim name -> hold-test-hook -> re-read revision ->
// re-verify claim ownership -> rename tmp over gaps.json -> read back.
// The claim name is shared and symlink() is atomic, so exactly one writer can
// hold the claim for a given source revision; the claim is created BEFORE
// the re-read, which closes the recheck-then-rename window: a writer that
// loses the claim (EEXIST) returns exit 6 with its text absent instead of
// silently clobbering the rival. On EEXIST the claim is read (DEF-4): a
// claim whose owner pid is dead (kill(pid, 0) -> ESRCH) belongs to a
// SIGKILLed writer, so it is unlinked and the link is retried once — a
// crashed writer cannot hold the live revision hostage. A live owner is
// never robbed, however slow or descheduled: pid liveness is not fooled by
// scheduling, which is what defeats a wall-clock bound (DEF-5, review
// t_1c29d984). The claim symlink targets the owner's tmp NAME and the commit
// renames the owner's tmp (never the claim link), so a steal can never swap
// payloads between writers; a robbed writer detects the theft by re-reading
// the link before the rename, and a post-commit read-back makes exit 0 mean
// the writer's own payload is verifiably in gaps.json. gaps.json is only
// ever replaced by a whole-file rename, so a kill mid-write leaves it
// parseable. No lockfiles.
// Test-only hook: hold the claim so a SIGKILL lands between claim and
// rename. Enabled by HORIZON_CLI_TEST_HOLD_CLAIM_MS=<ms> (busy-wait after the
// claim link); production never sets it.
function maybeHoldClaim() {
  const ms = Number(process.env.HORIZON_CLI_TEST_HOLD_CLAIM_MS);
  if (!Number.isFinite(ms) || ms <= 0) return;
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy-wait: keep the signal window open */ }
}

// Steal decision (DEF-5): liveness first, clock as fallback. The claim
// symlink names its owner's tmp (.gaps.json.tmp.<pid>.<seq>); when
// kill(owner, 0) succeeds the owner is alive and the claim must never be
// stolen, no matter how long it has been held — a descheduled, throttled,
// traced or swapped-out writer is alive, and robbing it is the silent lost
// update of DEF-1. Only ESRCH (no such process) proves the owner dead.
// Pids are recycled and liveness can be unprovable (EPERM, foreign pid), so
// when liveness cannot be decided the wall clock falls back to the old
// DEF-4 bound: a claim older than CLAIM_STALE_MS is treated as abandoned.
// CLAIM_STALE_MS therefore bounds worst-case recovery from a crashed or
// unprovable claim; it never bounds a live writer's critical section.
export const CLAIM_STALE_MS = 100;

// True when the claim may be stolen: its symlinked owner pid is dead
// (ESRCH), or liveness cannot be decided and the link's mtime is older than
// CLAIM_STALE_MS. A plain (non-symlink) claim has no owner pid to query —
// legacy or planted state — so the clock decides from the link's own mtime
// (lstat: a dangling symlink must still yield its mtime).
export function claimIsStale(storeDir, claimName, now) {
  const claimPath = join(storeDir, claimName);
  let target;
  try {
    target = readlinkSync(claimPath);
  } catch (err) {
    if (err && err.code === "EINVAL") {
      try {
        return now - lstatSync(claimPath).mtimeMs > CLAIM_STALE_MS;
      } catch {
        return false; // vanished: nothing to steal
      }
    }
    return false; // ENOENT and friends: the claim is gone
  }
  const m = /^\.gaps\.json\.tmp\.([1-9][0-9]*)\.[0-9]+$/.exec(basename(target));
  if (m) {
    try {
      process.kill(Number(m[1]), 0);
      return false; // owner alive: never steal (DEF-5)
    } catch (err) {
      if (err && err.code === "ESRCH") return true; // owner dead: safe to steal
      // EPERM etc: liveness unprovable; fall through to the clock.
    }
  }
  try {
    return now - lstatSync(claimPath).mtimeMs > CLAIM_STALE_MS;
  } catch {
    return false; // vanished between readlink and lstat
  }
}

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
  // Claim BEFORE re-reading: symlink() either makes us the owner of this
  // revision or tells us (EEXIST) a rival already holds the claim. On EEXIST
  // a live rival keeps its claim no matter how slow it is (DEF-5: liveness,
  // not the clock) and we exit 6.
  // But a SIGKILLed rival strands its claim forever (DEF-4: the sweep cannot
  // touch a claim at the live revision), so when the claim's owner pid is
  // dead (or liveness is unprovable and the link is older than
  // CLAIM_STALE_MS) we treat the owner as gone, take the claim, and retry
  // the link once. The claim symlink targets our tmp NAME and the commit
  // renames the owner's tmp, not the claim link, so even a steal can never
  // swap payloads between writers.
  let myClaim = null; // inode of the claim symlink, captured at claim time
  try {
    symlinkSync(tmp, claim);
    maybeHoldClaim();
    myClaim = statSync(claim).ino; // ownership capture 1
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      try {
        unlinkSync(tmp);
      } catch { /* already gone */ }
      return { code: 7, message: `horizon: ${path}: cannot write: ${err.message}` };
    }
    let stale = false;
    try {
      stale = claimIsStale(storeDir, basename(claim), Date.now());
    } catch { /* claim vanished between EEXIST and check: race to re-link */ }
    if (stale) {
      try {
        unlinkSync(claim);
      } catch { /* a rival reaped it first */ }
    }
    try {
      symlinkSync(tmp, claim);
      maybeHoldClaim();
      myClaim = statSync(claim).ino; // ownership capture 2
    } catch (err2) {
      try {
        unlinkSync(tmp);
      } catch { /* already gone */ }
      if (err2 && err2.code === "EEXIST") {
        return { code: 6, message: "horizon: the horizon changed underneath you, re-read and retry." };
      }
      return { code: 7, message: `horizon: ${path}: cannot write: ${err.message}` };
    }
  }
  // We hold the claim. Re-read: if the revision already moved (a previous
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
  // Pre-rename ownership re-check (DEF-5): a steal by a third writer would
  // have unlinked our claim and replaced it with the thief's own symlink,
  // changing the inode. If we no longer own the name, our rename would
  // publish the thief's payload — exit 6 instead.
  if (statSync(claim).ino !== myClaim) {
    try {
      unlinkSync(tmp);
    } catch { /* already gone */ }
    return { code: 6, message: "horizon: the horizon changed underneath you, re-read and retry." };
  }
  try {
    // Rename OUR tmp, never the claim link: the symlink name must stay
    // resolved-able to the owner pid, and ownership of the name is what the
    // re-check above verified.
    renameSync(tmp, path);
  } catch (err) {
    for (const p of [claim, tmp]) {
      try {
        unlinkSync(p);
      } catch { /* already gone */ }
    }
    return { code: 7, message: `horizon: ${path}: cannot write: ${err.message}` };
  }
  // Our claim link is now redundant: remove it. If a rival's steal unlinked
  // and recreated it in the meantime, our unlink removes the rival's claim
  // link only — the rival's tmp payload is untouched and the rival's own
  // read-back (below) is what certifies its commit, so no corruption is
  // possible.
  try {
    unlinkSync(claim);
  } catch { /* already gone or stolen */ }
  try {
    unlinkSync(tmp);
  } catch { /* already gone */ }
  // Post-commit read-back (DEF-5, invariant): exit 0 only if OUR payload is
  // verifiably the live one. rename is atomic and we just verified
  // ownership, so failure here can only be an I/O fault — reported as such.
  try {
    const verify = readFileSync(path, "utf8");
    if (verify !== JSON.stringify(next, null, 2) + "\n") {
      return { code: 7, message: `horizon: ${path}: post-commit read-back mismatch` };
    }
  } catch (err) {
    return { code: 7, message: `horizon: ${path}: post-commit read-back failed: ${err.message}` };
  }
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
