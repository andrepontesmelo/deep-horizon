// One home for the shared test machinery. The suite runs in three honest
// tiers: tier 1 calls main() in-process through runCli/runInject (a capturing
// sink plus the cwd/env juggling the spawned twin got from execFile); tier 2
// keeps spawning — the concurrency tests and the bin smoke, whose meaning is
// that real processes behave; tier 3 (the adapter suites) drives the adapters
// directly and only borrows the dirs-and-fences helpers here.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as cliMain } from "../src/cli.ts";
import { main as injectMain } from "../src/inject.ts";

export { seed } from "./seed.js";

export function freshDir(prefix = "horizon-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

// The try/finally rmSync skeleton that used to be hand-rolled in every store
// fixture: the directory exists only for fn, and the removal happens even
// when fn throws — assertion failures included, sync and async alike.
export async function withDir(fn, prefix) {
  const dir = freshDir(prefix);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// One in-process CLI round, shaped exactly like the spawned twin it replaces:
// { code, stdout, stderr } with the same bytes execFile would have captured.
// The seam is main's sink (src/cli.ts); cwd and env are per-call. Tests are
// serial within a file, so one call at a time owns the process globals.
export async function runCli(args, opts = {}) {
  return inProcess(cliMain, args, opts);
}

export async function runInject(args, opts = {}) {
  return inProcess(injectMain, args, opts);
}

// cwd is chdir-in/chdir-out (main resolves stores from process.cwd, and the
// spawned tests passed cwd per execFile call — same semantics, no --cwd
// injection that the CLI's own parser would then have to accept); env
// REPLACES the environment for the call, execFile-style, so a test that
// passes { ...process.env, HOOK: "x" } gets the identical world it always
// did, and the env-var hooks (HORIZON_CLI_TEST_FAIL_RENAMES et al) work
// unchanged — env is env, in-process or spawned.
//
// The process streams are re-bound to the capture for the duration of the
// call: main writes through the sink, but the store module still writes its
// one "created" line straight to process.stderr, outside any sink, and the
// spawned twin captured those bytes too. main's body is synchronous, so the
// window holds exactly this call's writes.
//
// Everything restores in finally — on a nonzero exit, a failed assertion in
// the caller, or a throw from under test alike. A harness that leaks cwd or
// env poisons every test after it; this one cannot.
async function inProcess(main, args, { cwd, env } = {}) {
  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  const out = [];
  const err = [];
  const capture = (buf) => (chunk) => {
    buf.push(chunk.toString("utf8"));
    return true;
  };
  process.stdout.write = capture(out);
  process.stderr.write = capture(err);
  try {
    if (cwd !== undefined) process.chdir(cwd);
    if (env !== undefined) {
      for (const key of Object.keys(process.env)) {
        if (!(key in env)) delete process.env[key];
      }
      Object.assign(process.env, env);
    }
    const code = await main(args, { stdout: capture(out), stderr: capture(err) });
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
  }
}

// Extract the inside of a fenced block that follows `heading` in the spec.
export function specFence(specLines, heading) {
  const h = specLines.findIndex((l) => l.startsWith(heading));
  assert.notEqual(h, -1, `missing ${heading} in spec`);
  const open = specLines.findIndex((l, i) => i > h && l === "```");
  const close = specLines.findIndex((l, i) => i > open && l === "```");
  assert.ok(open > h && close > open, `unclosed fence after ${heading}`);
  return specLines.slice(open + 1, close).join("\n");
}
