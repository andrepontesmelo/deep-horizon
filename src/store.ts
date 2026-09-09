import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

// Store resolution: walk up from start to the nearest ancestor containing
// .horizon/, the way git finds .git. Stop at the filesystem root.
export function resolveStore(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, HORIZON_DIR))) return join(dir, HORIZON_DIR);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readGapsFile(storeDir) {
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

// gaps.json write: temp file in the same directory, fsync, re-check revision
// before writing, rename(). No lockfiles.
export function writeGapsFile(storeDir, expectedRevision, next) {
  const path = join(storeDir, GAPS_FILE);
  const current = readGapsFile(storeDir);
  if (!current.ok) return { code: current.code, message: current.message };
  if (current.data.revision !== expectedRevision) {
    return { code: 6, message: "horizon: the horizon changed underneath you, re-read and retry." };
  }
  const tmp = join(storeDir, `.gaps.json.tmp.${process.pid}`);
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch { /* already gone */ }
    return { code: 7, message: `horizon: ${path}: cannot write: ${err.message}` };
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
  return readdirSync(storeDir).filter((name) => name.startsWith(".gaps.json.tmp."));
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
