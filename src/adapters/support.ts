// The one spawn/parse policy for the TS adapters (dsh, pi, opencode).
//
// This module exists because the plumbing drifted. The spawn helper lived as
// three private copies, and the DEF-ADV-14-1 finding — a hung horizon bin
// stalls the whole session — was fixed in two of them (pi and opencode:
// spawnSync with a 15s timeout) while dsh's async rewrite landed with no
// timeout at all, so a hung horizon-inject there would stall every
// tools/pre-execute waterfall: the param trigger awaits its probes inside
// each tool call. One home now — one resolution order, one timeout, one
// fallback, one --json parser — so the next fix to this class has exactly one
// place to land.
//
// The policy, in full. A repo checkout (this file still sitting in
// src/adapters/) runs bin/<name>.js with the current node; an installed
// package relies on the global bin on PATH (D2). A sibling that runs but
// exits nonzero gets exactly one PATH retry: the installed package ships TS
// source, and Node < 23.6 refuses to strip types for files under
// node_modules, so the sibling bin can die with a module-error exit before
// printing anything — a wrapper, a user-side compiled install, or a newer
// Node provides a working PATH bin. Every spawn is bounded by a 15s timeout:
// the child is killed and the result carries status -1 (fail-open at the
// callers). A timed-out sibling is deliberately NOT retried on PATH — a
// retry cannot fix a hang, it would only double the stall. runBin rejects
// only when the binary cannot be spawned at all (ENOENT) — callers treat
// that as fail-open (D2): an unresolvable bin injects nothing and the
// session proceeds.
//
// Async on purpose: runBin returns a promise for {status, stdout, stderr} so
// dsh's param trigger can probe a call's fresh dirs concurrently — a
// synchronous spawn would serialize the batch inside the awaited waterfall.
// Test overrides may keep returning the shape synchronously; callers await
// it either way.
//
// Glue only (D6): pure child_process + path work. No store import (the
// adapters' rule), no composed texts — a test greps this directory for the
// composer's literals.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// The DEF-ADV-14-1 bound: long enough for a cold node startup plus the bin's
// work, short enough that a hung bin costs seconds, never a session.
const SPAWN_TIMEOUT_MS = 15_000;

// Spawn one command, never throw: the resolved shape carries the exit status
// (the code, or -1 when the child was killed — the timeout's shape) and an
// `error` only when the process could not be spawned at all.
function spawnOnce(cmd, args, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    let failure = null;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => { failure = err; });
    // 'close' fires after 'exit', or after 'error' when the spawn itself
    // failed — settling here (not in the error handler) keeps this function
    // total: every spawn resolves exactly once.
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ status: code ?? -1, stdout, stderr, error: failure });
    });
  });
}

// Resolve and run a horizon bin under the one policy. See the module comment.
export function runBin(binName, args, { timeoutMs = SPAWN_TIMEOUT_MS } = {}) {
  const local = new URL(`../../bin/${binName}.js`, import.meta.url);
  const sibling = existsSync(local);
  return (async () => {
    const first = await spawnOnce(
      sibling ? process.execPath : binName,
      sibling ? [local.pathname, ...args] : args,
      timeoutMs,
    );
    if (first.error) throw first.error;
    // A real nonzero sibling exit is the installed package's module-error
    // shape: the PATH bin gets exactly one retry. A timeout (status -1)
    // never takes the retry — see the module comment.
    if (sibling && first.status > 0) {
      const pathRes = await spawnOnce(binName, args, timeoutMs);
      if (!pathRes.error) return { status: pathRes.status, stdout: pathRes.stdout, stderr: pathRes.stderr };
    }
    return { status: first.status, stdout: first.stdout, stderr: first.stderr };
  })();
}

// Plain-record guard for parsed JSON of arbitrary shape (dsh's candidateDirs
// guards harness-handed tool-call arguments with it too).
export function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// The README-documented truthy set for HORIZON_SUBAGENT. hermes' Python twin
// additionally accepts "on" — the plugin keeps its own copy; this set is the
// TS adapters' contract, and the README documents it as such.
export function truthy(v) {
  return ["1", "true", "yes"].includes(String(v ?? "").toLowerCase());
}

// The horizon-inject --json answer: {"text": string, "store": string|null}.
// Anything off-shape is a failed answer (null), never an injection — the
// adapters trust only the total answer the composer documents.
export function parseInjectAnswer(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.text !== "string") return null;
  if (parsed.store !== null && typeof parsed.store !== "string") return null;
  return { text: parsed.text, store: parsed.store };
}
