// The harness's own contract, pinned. Tier 1 runs main() in-process by
// swapping process globals around each call; a swap that leaks poisons every
// test after it, so the restoration is itself load-bearing and gets tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, withDir } from "./harness.js";

test("harness-1. runCli restores cwd, env, and the process streams — env replacement included", async () => {
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  await withDir(async (dir) => {
    writeFileSync(join(dir, "placeholder"), "so the dir is not empty");
    // env REPLACES the environment execFile-style: during the call almost
    // everything is gone, and the storeless show answers silence.
    const r = await runCli(["show"], { cwd: dir, env: { ONLY: "one" } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
  assert.equal(process.cwd(), savedCwd, "cwd leaked");
  assert.deepEqual({ ...process.env }, savedEnv, "env leaked");
  assert.equal(process.env.ONLY, undefined, "the call-only key leaked");
  assert.equal(process.stdout.write, savedOut, "process.stdout.write leaked");
  assert.equal(process.stderr.write, savedErr, "process.stderr.write leaked");
});

test("harness-2. withDir removes the dir even when the body throws", async () => {
  let seen = null;
  await assert.rejects(
    withDir(async (dir) => {
      seen = dir;
      assert.ok(existsSync(dir), "the dir must exist for the body");
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.ok(seen, "the body never ran");
  assert.ok(!existsSync(seen), "a throwing body must still get its dir removed");
});
