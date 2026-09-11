// Tier 2's smoke layer on the real bins. The bins are five-line shims — load
// dist, hand argv to main, exit with the return — and exactly that seam is
// what no in-process round can see: that the built dist really loads, that
// the returned code really becomes the process's exit code, that the shim
// answers under its own bin name. A handful of spawned rounds pins it, so
// every other suite round can stay a function call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { seed, withDir } from "./harness.js";

const HORIZON = new URL("../bin/horizon.js", import.meta.url).pathname;
const HORIZON_INJECT = new URL("../bin/horizon-inject.js", import.meta.url).pathname;

function runBin(bin, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

test("bin smoke: horizon --version answers through the shim", async () => {
  const r = await runBin(HORIZON, ["--version"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^horizon \d+\.\d+\.\d+\n$/);
});

test("bin smoke: horizon-inject --version answers under its own name", async () => {
  const r = await runBin(HORIZON_INJECT, ["--version"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^horizon-inject \d+\.\d+\.\d+\n$/);
});

test("bin smoke: one happy path per bin through the real shim", async () => {
  await withDir(async (dir) => {
    seed(dir, ["Smoke gap"]);
    const r = await runBin(HORIZON, ["show", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "gap-1  Smoke gap\n");
    const inj = await runBin(HORIZON_INJECT, ["--cwd", dir, "--json"]);
    assert.equal(inj.code, 0);
    const parsed = JSON.parse(inj.stdout);
    assert.equal(parsed.store, join(dir, ".horizon"));
    assert.ok(parsed.text.includes("gap-1  Smoke gap"));
  });
});

test("bin smoke: a failure's exit code crosses the shim", async () => {
  const r = await runBin(HORIZON, ["no-such-command"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command/);
  const bad = await runBin(HORIZON_INJECT, ["--bogus"]);
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, "");
});
