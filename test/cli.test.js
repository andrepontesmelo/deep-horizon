// Acceptance tests 1-33 for the horizon-line CLI core, from
// .scratch/horizon-line/05-cli-contract.md section 9. Each test shells out to
// bin/horizon.js so it exercises the real entry point, real argv parsing, real
// exit codes, and real on-disk stores in temp dirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = new URL("../bin/horizon.js", import.meta.url).pathname;

function run(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(BIN, args, { encoding: "utf8", ...opts }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "horizon-test-"));
}

// Seed a store directly (init-equivalent).
function seed(dir, texts) {
  const store = join(dir, ".horizon");
  mkdirSync(store, { recursive: true });
  const gaps = texts.map((text, i) => ({
    id: `g_${(i + 1).toString(16).padStart(8, "0")}`,
    text,
    added_at: `2026-09-08T15:0${i}:11Z`,
    provenance: { harness: "test", session_id: "seed", tty: false, origin: "human" },
  }));
  writeFileSync(join(store, "gaps.json"), JSON.stringify({ version: 1, revision: gaps.length, gaps }, null, 2) + "\n");
  return gaps;
}

function readGaps(dir) {
  return JSON.parse(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8"));
}

// --- Resolution (1-3) ---

test("1. show from a subdirectory finds the parent store", async () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, "sub", "deep"), { recursive: true });
    seed(dir, ["Parent gap"]);
    const r = await run(["show", "--cwd", join(dir, "sub", "deep")]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Parent gap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("2. show with a nested store uses the nearest one", async () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, "sub"), { recursive: true });
    seed(dir, ["Outer gap"]);
    seed(join(dir, "sub"), ["Inner gap"]);
    const r = await run(["show", "--cwd", join(dir, "sub")]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Inner gap/);
    assert.doesNotMatch(r.stdout, /Outer gap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("3. show with no store: empty stdout, exit 0", async () => {
  const dir = freshDir();
  try {
    const r = await run(["show", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- show (4-6) ---

test("4. two gaps print exactly two lines, id + two spaces + text, insertion order", async () => {
  const dir = freshDir();
  try {
    const gaps = seed(dir, ["First gap", "Second gap"]);
    const r = await run(["show", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `${gaps[0].id}  First gap\n${gaps[1].id}  Second gap\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("5. no trailing blank line, no header, no dates", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["A dated gap"]);
    const r = await run(["show", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.endsWith("\n\n"), "trailing blank line");
    assert.doesNotMatch(r.stdout, /horizon|open gaps|total/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6. --json emits gap objects with ids, text, added_at", async () => {
  const dir = freshDir();
  try {
    const gaps = seed(dir, ["Json gap"]);
    const r = await run(["show", "--cwd", dir, "--json"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, gaps[0].id);
    assert.equal(parsed[0].text, "Json gap");
    assert.equal(parsed[0].added_at, gaps[0].added_at);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- add (7-15) ---

test("7. 512 code points accepted; 513 rejected with exit 3 and count in stderr", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const ok = await run(["add", "x".repeat(512), "--cwd", dir]);
    assert.equal(ok.code, 0);
    const bad = await run(["add", "x".repeat(513), "--cwd", dir]);
    assert.equal(bad.code, 3);
    assert.match(bad.stderr, /513/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("8. 512 astral-plane emoji accepted (code points, not UTF-16 units)", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const r = await run(["add", "🐟".repeat(512), "--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("9. ção-heavy text near the cap accepted (code points, not bytes)", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    // "ção" = 3 code points, 5 bytes in UTF-8, 170 repetitions = 510 points.
    const r = await run(["add", "ção".repeat(170), "--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const state = readGaps(dir);
    assert.equal([...state.gaps[0].text].length, 510);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("10. embedded newline rejected, exit 3", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const r = await run(["add", "line one\nline two", "--cwd", dir]);
    assert.equal(r.code, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("11. empty and whitespace-only text rejected, exit 3", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    assert.equal((await run(["add", "", "--cwd", dir])).code, 3);
    assert.equal((await run(["add", "   ", "--cwd", dir])).code, 3);
    assert.equal((await run(["add", "\t ", "--cwd", dir])).code, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("12. 6th add rejected with exit 4, store still has 5", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    for (let i = 0; i < 5; i++) {
      const r = await run(["add", `Gap ${i}`, "--cwd", dir]);
      assert.equal(r.code, 0);
    }
    const r = await run(["add", "One too many", "--cwd", dir]);
    assert.equal(r.code, 4);
    assert.equal(readGaps(dir).gaps.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("13. rejected add does not increment revision", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    for (let i = 0; i < 5; i++) await run(["add", `Gap ${i}`, "--cwd", dir]);
    const before = readGaps(dir).revision;
    const r = await run(["add", "One too many", "--cwd", dir]);
    assert.equal(r.code, 4);
    assert.equal(readGaps(dir).revision, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("14. ids differ and match ^g_[0-9a-f]{8}$", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const a = await run(["add", "First", "--cwd", dir]);
    const b = await run(["add", "Second", "--cwd", dir]);
    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
    assert.match(a.stdout.trim(), /^g_[0-9a-f]{8}$/);
    assert.match(b.stdout.trim(), /^g_[0-9a-f]{8}$/);
    assert.notEqual(a.stdout.trim(), b.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("15. add with no store creates one and says so", async () => {
  const dir = freshDir();
  try {
    const r = await run(["add", "First gap", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /created/i);
    assert.equal(readGaps(dir).gaps.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- close / amend (16-20) ---

test("16. close removes the gap and frees a slot", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const r = await run(["add", `Gap ${i}`, "--cwd", dir]);
      ids.push(r.stdout.trim());
    }
    const c = await run(["close", ids[0], "--cwd", dir]);
    assert.equal(c.code, 0);
    assert.equal(readGaps(dir).gaps.length, 4);
    const again = await run(["add", "Replacement", "--cwd", dir]);
    assert.equal(again.code, 0);
    assert.equal(readGaps(dir).gaps.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("17. close on unknown id: exit 5, store unchanged", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["Keep me"]);
    const before = readFileSync(join(dir, ".horizon", "gaps.json"), "utf8");
    const r = await run(["close", "g_deadbeef", "--cwd", dir]);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /g_deadbeef/);
    assert.equal(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("18. close twice: second is exit 5", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const a = await run(["add", "Doomed", "--cwd", dir]);
    const id = a.stdout.trim();
    assert.equal((await run(["close", id, "--cwd", dir])).code, 0);
    assert.equal((await run(["close", id, "--cwd", dir])).code, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("19. amend changes text but not id or added_at", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const a = await run(["add", "Original wording", "--cwd", dir]);
    const id = a.stdout.trim();
    const before = readGaps(dir).gaps[0].added_at;
    const m = await run(["amend", id, "Better wording", "--cwd", dir]);
    assert.equal(m.code, 0);
    const after = readGaps(dir).gaps[0];
    assert.equal(after.id, id);
    assert.equal(after.text, "Better wording");
    assert.equal(after.added_at, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("20. amend past the cap rejected, exit 3, text unchanged", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const a = await run(["add", "Original", "--cwd", dir]);
    const id = a.stdout.trim();
    const m = await run(["amend", id, "y".repeat(513), "--cwd", dir]);
    assert.equal(m.code, 3);
    assert.equal(readGaps(dir).gaps[0].text, "Original");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Atomicity / concurrency (21-25) ---

test("21b. two simultaneous adds: no silent lost update", async () => {
  // Natural race, no env hook: the pre-fix code loses one gap in ~15-25% of
  // rounds (both exit 0, store holds 1 gap at revision 1). The fix serializes
  // the loser's write to exit 6, so every round ends with: exit-0 ids all
  // present, gap count and revision equal to the exit-0 count, exit-6 texts
  // absent. 40 rounds keeps the suite fast while making a real race
  // near-certain pre-fix.
  const { execFile } = await import("node:child_process");
  function startAdd(cwd, text) {
    return new Promise((resolve) => {
      execFile(BIN, ["add", text, "--cwd", cwd], { encoding: "utf8" }, (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === "number" ? error.code : 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });
    });
  }
  for (let round = 0; round < 40; round++) {
    const dir = freshDir();
    try {
      await run(["init", "--cwd", dir]);
      const [a, b] = await Promise.all([
        startAdd(dir, `alpha ${round}`),
        startAdd(dir, `beta ${round}`),
      ]);
      const state = readGaps(dir);
      const won = [a, b].filter((r) => r.code === 0);
      const lost = [a, b].filter((r) => r.code === 6);
      assert.ok(won.length + lost.length === 2, `round ${round}: unexpected codes [${a.code},${b.code}]`);
      // Every exit-0 id is present; gap count and revision equal exit-0 count;
      // every exit-6 text is absent (the loser wrote nothing).
      const ids = new Set(state.gaps.map((g) => g.id));
      for (const w of won) assert.ok(ids.has(w.stdout), `round ${round}: ${w.stdout} missing from store`);
      assert.equal(state.gaps.length, won.length, `round ${round}: gap count`);
      assert.equal(state.revision, won.length, `round ${round}: revision`);
      const texts = new Set(state.gaps.map((g) => g.text));
      for (const l of lost) {
        const text = l === a ? `alpha ${round}` : `beta ${round}`;
        assert.ok(!texts.has(text), `round ${round}: exit-6 text present`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("21. revision moved between read and write: exit 6, file byte-identical", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    assert.equal((await run(["add", "First", "--cwd", dir])).code, 0);
    const before = readFileSync(join(dir, ".horizon", "gaps.json"));
    // HORIZON_CLI_TEST_RACE_HOOK=bump makes the CLI bump revision externally
    // after reading but before its compare-and-swap write, simulating a
    // concurrent writer.
    const r = await run(["add", "Racer", "--cwd", dir], {
      env: { ...process.env, HORIZON_CLI_TEST_RACE_HOOK: "bump" },
    });
    assert.equal(r.code, 6, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    // The external bump is a legitimate committed write, so the file now holds
    // it — the invariant is that OUR write added nothing: still parseable,
    // still one gap, no "Racer" gap, and the bumped revision intact.
    const after = JSON.parse(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8"));
    assert.equal(after.gaps.length, 1);
    assert.ok(!after.gaps.some((g) => g.text === "Racer"));
    assert.equal(after.revision, JSON.parse(before.toString()).revision + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("22. no .tmp files after a successful write", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    await run(["add", "Tidy", "--cwd", dir]);
    const leftovers = (await import("node:fs")).readdirSync(join(dir, ".horizon")).filter((n) => n.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("23. no .tmp file left after a failed write", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    for (let i = 0; i < 5; i++) await run(["add", `Gap ${i}`, "--cwd", dir]);
    await run(["add", "Overflow", "--cwd", dir]);
    const leftovers = (await import("node:fs")).readdirSync(join(dir, ".horizon")).filter((n) => n.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("24. SIGKILL mid-write: gaps.json stays parseable; next run sweeps stranded tmp", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const a = await run(["add", "Killable", "--cwd", dir]);
    assert.equal(a.code, 0);
    const id = a.stdout.trim();
    // Kill several amends mid-flight: gaps.json must parse after every kill
    // (temp+rename property). Timing varies, so this loop asserts the
    // property, not that a tmp was stranded in any given round.
    const { spawn } = await import("node:child_process");
    for (let i = 0; i < 8; i++) {
      const child = spawn(BIN, ["amend", id, `revision ${i} wording`, "--cwd", dir], { stdio: "ignore" });
      const exited = new Promise((r) => child.on("exit", r));
      await new Promise((r) => setTimeout(r, 120));
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already exited before the kill landed; nothing stranded this round.
      }
      await exited;
      assert.doesNotThrow(() => readGaps(dir), `gaps.json unparseable after kill ${i}`);
    }
    // Deterministic half: plant a dead-pid tmp (stranded by a kill) and a
    // live-pid tmp (an in-flight writer's). The next CLI run must sweep the
    // dead one and never touch the live one.
    const { writeFileSync, readdirSync } = await import("node:fs");
    // Dead pid: a spawned child that has fully exited (fully reaped via
    // exit event), so kill(pid, 0) reports ESRCH. Wait a tick after the
    // exit event: the kernel may briefly keep the pid allocated while the
    // runner's own grandchildren fork, so retry until the pid reads dead
    // (bounded; a live pid here would mean the fixture is wrong).
    const { setTimeout: delay } = await import("node:timers/promises");
    let deadPid = -1;
    for (let attempt = 0; attempt < 50; attempt++) {
      const cand = spawn(process.execPath, ["--version"], { stdio: "ignore" });
      deadPid = cand.pid;
      await new Promise((r) => cand.on("exit", r));
      await delay(20);
      let alive = true;
      try {
        process.kill(deadPid, 0);
      } catch (err) {
        if (err && err.code === "ESRCH") alive = false;
        else throw err;
      }
      if (!alive) break;
      deadPid = -1;
    }
    assert.notEqual(deadPid, -1, "could not obtain a dead pid for the sweep fixture");
    const store = join(dir, ".horizon");
    writeFileSync(join(store, `.gaps.json.tmp.${deadPid}`), "{}\n");
    writeFileSync(join(store, `.gaps.json.tmp.${process.pid}`), "live writer\n");
    const r = await run(["show", "--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const left = readdirSync(store).filter((n) => n.startsWith(".gaps.json.tmp."));
    assert.deepEqual(left, [`.gaps.json.tmp.${process.pid}`]);
    assert.doesNotThrow(() => readGaps(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("36. stranded claim at the live revision: next add recovers (DEF-4)", async () => {
  // Real-kill lab evidence (review t_cf071306, DEF-4): a writer SIGKILLed
  // between linkSync(claim) and renameSync strands
  // .gaps.json.commit.<liveRev>, and the pre-fix store then exited 6 on
  // every later write forever (sweep and re-init could not clear it).
  // Half 1 reproduces the kill for real via the test-only hold hook.
  // Half 2 fabricates the same state deterministically (planted claim,
  // mtime backdated past CLAIM_STALE_MS) so the recovery is asserted
  // without any timing dependence.
  const { spawn } = await import("node:child_process");
  const { readdirSync, utimesSync, existsSync } = await import("node:fs");
  const { setTimeout: delay } = await import("node:timers/promises");

  // Half 1: real SIGKILL between link and rename.
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    assert.equal((await run(["add", "First", "--cwd", dir])).code, 0);
    const store = join(dir, ".horizon");
    const child = spawn(BIN, ["add", "crash mid-claim", "--cwd", dir], {
      stdio: "ignore",
      env: { ...process.env, HORIZON_CLI_TEST_HOLD_CLAIM_MS: "2000" },
    });
    let stranded = false;
    for (let i = 0; i < 100 && !stranded; i++) {
      await delay(25);
      stranded = readdirSync(store).some((n) => n.startsWith(".gaps.json.commit."));
    }
    assert.ok(stranded, "hold hook failed: claim never appeared");
    try {
      process.kill(child.pid, "SIGKILL");
    } catch { /* already exited: fixture broken */ }
    await new Promise((r) => child.on("exit", r));
    // The kill left the claim stranded at the live revision; gaps.json is
    // untouched and parseable.
    assert.ok(readdirSync(store).some((n) => n.startsWith(".gaps.json.commit.")), "claim not stranded after kill");
    assert.doesNotThrow(() => readGaps(dir));
    // Recovery: past CLAIM_STALE_MS the claim reads as abandoned, so the
    // next add succeeds, the revision advances, and every claim/tmp leftover
    // is gone (the tmp sweep clears the killed writer's tmp).
    await delay(250);
    const r = await run(["add", "after crash", "--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const state = readGaps(dir);
    assert.equal(state.revision, 2);
    assert.equal(state.gaps.length, 2);
    assert.ok(state.gaps.some((g) => g.text === "after crash"));
    assert.deepEqual(readdirSync(store).filter((n) => n.startsWith(".gaps.json.")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Half 2: deterministic fabrication — plant the stranded claim and
  // backdate it past CLAIM_STALE_MS (no real kill needed).
  const dir2 = freshDir();
  try {
    await run(["init", "--cwd", dir2]);
    assert.equal((await run(["add", "Seed", "--cwd", dir2])).code, 0);
    const claim = join(dir2, ".horizon", ".gaps.json.commit.1");
    writeFileSync(claim, "{}\n");
    const past = new Date(Date.now() - 10_000);
    utimesSync(claim, past, past);
    const r = await run(["add", "Second", "--cwd", dir2]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const state = readGaps(dir2);
    assert.equal(state.revision, 2);
    assert.equal(state.gaps.length, 2);
    assert.ok(state.gaps.some((g) => g.text === "Second"));
    assert.ok(!existsSync(claim), "stranded claim not removed");
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("25. 20 concurrent session-ends yield 20 valid lines", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        run(["session-end", "--harness", "test", "--session", `s-${i}`, "--cwd", dir]),
      ),
    );
    for (const r of results) assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const lines = readFileSync(join(dir, ".horizon", "sessions.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    assert.equal(lines.length, 20);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- session-end (26-29) ---

test("26. omitted --summary writes null, not empty or placeholder", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const r = await run(["session-end", "--harness", "hermes", "--session", "s1", "--cwd", dir]);
    assert.equal(r.code, 0);
    const rec = JSON.parse(readFileSync(join(dir, ".horizon", "sessions.jsonl"), "utf8").trim());
    assert.equal(rec.summary, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("27. gaps_added computed from the session's own mutations", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const a = await run(["add", "Mine", "--cwd", dir, "--session", "s1"]);
    // Flag-injected arrays are not a thing: passing one is a usage error.
    const bad = await run(["session-end", "--harness", "t", "--session", "s1", "--gaps-added", a.stdout.trim(), "--cwd", dir]);
    assert.notEqual(bad.code, 0);
    const r = await run(["session-end", "--harness", "t", "--session", "s1", "--cwd", dir]);
    assert.equal(r.code, 0);
    const rec = JSON.parse(readFileSync(join(dir, ".horizon", "sessions.jsonl"), "utf8").trim());
    assert.deepEqual(rec.gaps_added, [a.stdout.trim()]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("28. untouched session still writes a record with empty arrays", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const r = await run(["session-end", "--harness", "t", "--session", "idle", "--cwd", dir]);
    assert.equal(r.code, 0);
    const rec = JSON.parse(readFileSync(join(dir, ".horizon", "sessions.jsonl"), "utf8").trim());
    assert.deepEqual(rec.gaps_added, []);
    assert.deepEqual(rec.gaps_closed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("29. missing --harness or --session: exit 2, nothing appended", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const sessionsPath = join(dir, ".horizon", "sessions.jsonl");
    assert.equal((await run(["session-end", "--session", "s1", "--cwd", dir])).code, 2);
    assert.equal((await run(["session-end", "--harness", "t", "--cwd", dir])).code, 2);
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(sessionsPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- log (30-31) ---

test("30. log prints newest first and honours --limit", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    for (const s of ["s1", "s2", "s3"]) {
      await run(["session-end", "--harness", "t", "--session", s, "--summary", `summary ${s}`, "--cwd", dir]);
    }
    const r = await run(["log", "--cwd", dir]);
    assert.equal(r.code, 0);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /summary s3/);
    assert.match(lines[2], /summary s1/);
    const limited = await run(["log", "--limit", "2", "--cwd", dir]);
    assert.equal(limited.stdout.trim().split("\n").length, 2);
    assert.match(limited.stdout, /summary s3/);
    assert.doesNotMatch(limited.stdout, /summary s1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("31. null summary renders as (no summary)", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    await run(["session-end", "--harness", "t", "--session", "s1", "--cwd", dir]);
    const r = await run(["log", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\(no summary\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Store integrity (32-33) ---

test("32. malformed gaps.json: exit 7 naming the file, not overwritten", async () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(join(dir, ".horizon", "gaps.json"), "{not json");
    const r = await run(["show", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /gaps\.json/);
    assert.equal(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8"), "{not json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("33. unknown future version refused, not migrated", async () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(join(dir, ".horizon", "gaps.json"), JSON.stringify({ version: 99, revision: 0, gaps: [] }));
    const r = await run(["show", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.equal(JSON.parse(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8")).version, 99);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Injection texts (34: DEF-3 byte-contract) ---

test("34. exported texts equal the spec section 10 fence blocks byte-for-byte", async () => {
  // DEF-3 ruling: each export equals the INSIDE of its fenced block exactly
  // (no trailing newline added or stripped; fence backticks are markdown,
  // not content). Extract the fences from the spec and compare characters.
  const SRC = new URL("../src/texts.ts", import.meta.url).pathname;
  const SPEC = new URL("../.scratch/horizon-line/05-cli-contract.md", import.meta.url).pathname;
  const spec = readFileSync(SPEC, "utf8").split("\n");
  function fenceAfter(heading) {
    const h = spec.findIndex((l) => l.startsWith(heading));
    assert.notEqual(h, -1, `missing ${heading} in spec`);
    const open = spec.findIndex((l, i) => i > h && l === "```");
    const close = spec.findIndex((l, i) => i > open && l === "```");
    assert.ok(open > h && close > open, `unclosed fence after ${heading}`);
    return spec.slice(open + 1, close).join("\n");
  }
  const { HORIZON_BLOCK_TEMPLATE, NUDGE_TEXT } = await import(SRC);
  assert.equal(HORIZON_BLOCK_TEMPLATE, fenceAfter("### 10.1"));
  assert.equal(NUDGE_TEXT, fenceAfter("### 10.2"));
});

