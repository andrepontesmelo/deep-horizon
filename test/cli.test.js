import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshDir, runCli, seed, specFence, withDir } from "./harness.js";
import { main } from "../src/cli.ts";

const BIN = new URL("../bin/horizon.js", import.meta.url).pathname;

// Tier 2, and staying there: tests 21-25 spawn real processes because their
// meaning is that processes race safely — torn reads, stranded tmps,
// last-writer-wins across processes, the retry backoff, concurrent
// appenders. None of that exists within one process, so these keep the
// execFile shape the rest of the suite retired.
function spawnRun(args, opts = {}) {
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

function readGaps(dir) {
  return JSON.parse(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8"));
}

// --- Resolution (1-3) ---

test("1. show from a subdirectory finds the parent store", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, "sub", "deep"), { recursive: true });
    seed(dir, ["Parent gap"]);
    const r = await runCli(["show", "--cwd", join(dir, "sub", "deep")]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Parent gap/);
  });
});

test("2. show with a nested store uses the nearest one", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    seed(dir, ["Outer gap"]);
    seed(join(dir, "sub"), ["Inner gap"]);
    const r = await runCli(["show", "--cwd", join(dir, "sub")]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Inner gap/);
    assert.doesNotMatch(r.stdout, /Outer gap/);
  });
});

test("3. show with no store: empty stdout, exit 0", async () => {
  await withDir(async (dir) => {
    const r = await runCli(["show", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

// --- show (4-6) ---

test("4. two gaps print exactly two lines, id + two spaces + text, insertion order", async () => {
  await withDir(async (dir) => {
    const gaps = seed(dir, ["First gap", "Second gap"]);
    const r = await runCli(["show", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `${gaps[0].id}  First gap\n${gaps[1].id}  Second gap\n`);
  });
});

test("5. no trailing blank line, no header, no dates", async () => {
  await withDir(async (dir) => {
    seed(dir, ["A dated gap"]);
    const r = await runCli(["show", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.endsWith("\n\n"), "trailing blank line");
    assert.doesNotMatch(r.stdout, /horizon|open gaps|total/i);
  });
});

test("6. --json emits gap objects with ids, text, added_at", async () => {
  await withDir(async (dir) => {
    const gaps = seed(dir, ["Json gap"]);
    const r = await runCli(["show", "--cwd", dir, "--json"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, gaps[0].id);
    assert.equal(parsed[0].text, "Json gap");
    assert.equal(parsed[0].added_at, gaps[0].added_at);
  });
});

// --- add (7-15) ---

test("7. 512 code points accepted; 513 rejected with exit 3 and count in stderr", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const ok = await runCli(["add", "long-text", "x".repeat(512), "--cwd", dir]);
    assert.equal(ok.code, 0);
    const bad = await runCli(["add", "longer-text", "x".repeat(513), "--cwd", dir]);
    assert.equal(bad.code, 3);
    assert.match(bad.stderr, /513/);
  });
});

test("8. 512 astral-plane emoji accepted (code points, not UTF-16 units)", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const r = await runCli(["add", "emoji-flood", "🐟".repeat(512), "--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  });
});

test("9. ção-heavy text near the cap accepted (code points, not bytes)", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    // "ção" = 3 code points, 5 bytes in UTF-8, 170 repetitions = 510 points.
    const r = await runCli(["add", "cao-text", "ção".repeat(170), "--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const state = readGaps(dir);
    assert.equal([...state.gaps[0].text].length, 510);
  });
});

test("10. embedded newline rejected, exit 3", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const r = await runCli(["add", "two-lines", "line one\nline two", "--cwd", dir]);
    assert.equal(r.code, 3);
  });
});

test("11. empty and whitespace-only text rejected, exit 3", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    assert.equal((await runCli(["add", "empty-text", "", "--cwd", dir])).code, 3);
    assert.equal((await runCli(["add", "blank-text", "   ", "--cwd", dir])).code, 3);
    assert.equal((await runCli(["add", "tab-text", "\t ", "--cwd", dir])).code, 3);
  });
});

test("12. 6th add rejected with exit 4, store still has 5", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    for (let i = 0; i < 5; i++) {
      const r = await runCli(["add", `gap-${i}`, `Gap ${i}`, "--cwd", dir]);
      assert.equal(r.code, 0);
    }
    const r = await runCli(["add", "gap-5", "One too many", "--cwd", dir]);
    assert.equal(r.code, 4);
    assert.equal(readGaps(dir).gaps.length, 5);
  });
});

test("13. rejected add does not increment revision", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    for (let i = 0; i < 5; i++) await runCli(["add", `gap-${i}`, `Gap ${i}`, "--cwd", dir]);
    const before = readGaps(dir).revision;
    const r = await runCli(["add", "gap-5", "One too many", "--cwd", dir]);
    assert.equal(r.code, 4);
    assert.equal(readGaps(dir).revision, before);
  });
});

test("14. add prints the caller-supplied id; ids match the slug grammar", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const a = await runCli(["add", "first-gap", "First", "--cwd", dir]);
    const b = await runCli(["add", "second-gap", "Second", "--cwd", dir]);
    assert.equal(a.code, 0, `stderr: ${a.stderr}`);
    assert.equal(b.code, 0, `stderr: ${b.stderr}`);
    assert.equal(a.stdout.trim(), "first-gap");
    assert.equal(b.stdout.trim(), "second-gap");
    assert.match(a.stdout.trim(), /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });
});

test("14a. add without an id, or without text, is a usage error: exit 2", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const bare = await runCli(["add", "--cwd", dir]);
    assert.equal(bare.code, 2);
    assert.match(bare.stderr, /add requires <id> <text>/);
    const noText = await runCli(["add", "lonely-id", "--cwd", dir]);
    assert.equal(noText.code, 2);
    assert.match(noText.stderr, /add requires <text>/);
    assert.equal(readGaps(dir).gaps.length, 0);
  });
});

test("14b. an id off the slug grammar is rejected, exit 2, stating the id", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const bad = ["Big-Camel", "ab", "-lead", "trail-", "g_deadbeef", "double--hyphen", "under_score", "has space", "a".repeat(41)];
    for (const id of bad) {
      const r = await runCli(["add", id, "text", "--cwd", dir]);
      assert.equal(r.code, 2, `${JSON.stringify(id)}: exit ${r.code}: ${r.stderr}`);
      assert.ok(r.stderr.includes(id), `${JSON.stringify(id)}: id not named in stderr: ${r.stderr}`);
    }
    // Grammar edges that must pass: shortest, longest, digits after the head.
    assert.equal((await runCli(["add", "abc", "min length", "--cwd", dir])).code, 0);
    assert.equal((await runCli(["add", `${"a".repeat(39)}9`, "max length", "--cwd", dir])).code, 0);
    assert.equal((await runCli(["add", "gap2", "digits after the head", "--cwd", dir])).code, 0);
  });
});

test("14c. adding an id that is already an open gap: exit 8, store unchanged", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    assert.equal((await runCli(["add", "dupe-me", "First", "--cwd", dir])).code, 0);
    const before = readGaps(dir);
    const r = await runCli(["add", "dupe-me", "Second", "--cwd", dir]);
    assert.equal(r.code, 8);
    assert.match(r.stderr, /dupe-me/);
    const after = readGaps(dir);
    assert.equal(after.revision, before.revision);
    assert.equal(after.gaps.length, 1);
    assert.equal(after.gaps[0].text, "First");
  });
});

test("14d. adding an id that was closed: exit 8 — ids are never reused", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const a = await runCli(["add", "reusable", "Doomed", "--cwd", dir]);
    assert.equal(a.code, 0, `stderr: ${a.stderr}`);
    const c = await runCli(["close", "reusable", "--cwd", dir]);
    assert.equal(c.code, 0, `stderr: ${c.stderr}`);
    const r = await runCli(["add", "reusable", "Reborn", "--cwd", dir]);
    assert.equal(r.code, 8);
    assert.match(r.stderr, /reusable/);
    assert.equal(readGaps(dir).gaps.length, 0);
  });
});

test("14e. close appends to closed_ids; a legacy store without the field reads empty and gains it on the next save", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    assert.deepEqual(readGaps(dir).closed_ids, []);
    assert.equal((await runCli(["add", "gone-soon", "Doomed", "--cwd", dir])).code, 0);
    const c = await runCli(["close", "gone-soon", "--cwd", dir]);
    assert.equal(c.code, 0, `stderr: ${c.stderr}`);
    assert.deepEqual(readGaps(dir).closed_ids, ["gone-soon"]);
    // A store written before closed_ids existed: missing reads as empty, and
    // the next whole-file save writes the field.
    await withDir(async (legacy) => {
      mkdirSync(join(legacy, ".horizon"), { recursive: true });
      writeFileSync(
        join(legacy, ".horizon", "gaps.json"),
        JSON.stringify({
          version: 1,
          revision: 3,
          gaps: [{ id: "old-gap", text: "Legacy", added_at: "2026-09-08T15:00:00Z", provenance: { harness: "t", session_id: "s", tty: false, origin: "human" } }],
        }) + "\n",
      );
      assert.equal(readGaps(legacy).closed_ids, undefined);
      const m = await runCli(["amend", "old-gap", "Legacy amended", "--cwd", legacy]);
      assert.equal(m.code, 0, `stderr: ${m.stderr}`);
      assert.deepEqual(readGaps(legacy).closed_ids, []);
    });
  });
});

test("14f. old g_<hex> gap ids and bad closed_ids make the store malformed: exit 7", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    const legacy = {
      version: 1,
      revision: 1,
      gaps: [{ id: "g_00000001", text: "Old shape", added_at: "2026-09-08T15:00:00Z" }],
    };
    writeFileSync(join(dir, ".horizon", "gaps.json"), JSON.stringify(legacy) + "\n");
    const r = await runCli(["show", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /gaps\.json/);
    assert.match(r.stderr, /invalid gap id/);
    assert.equal(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8"), JSON.stringify(legacy) + "\n");
    // A closed_ids entry off the grammar is the same exit-7 family...
    writeFileSync(
      join(dir, ".horizon", "gaps.json"),
      JSON.stringify({ version: 1, revision: 1, gaps: [], closed_ids: ["not a slug!"] }) + "\n",
    );
    const r2 = await runCli(["show", "--cwd", dir]);
    assert.equal(r2.code, 7);
    assert.match(r2.stderr, /closed_ids/);
    // ...and so is a closed_ids that is not an array.
    writeFileSync(join(dir, ".horizon", "gaps.json"), JSON.stringify({ version: 1, revision: 1, gaps: [], closed_ids: "nope" }) + "\n");
    assert.equal((await runCli(["show", "--cwd", dir])).code, 7);
  });
});

test("15. add with no store creates one and says so", async () => {
  await withDir(async (dir) => {
    const r = await runCli(["add", "first-gap", "First gap", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /created/i);
    assert.equal(readGaps(dir).gaps.length, 1);
  });
});

// --- close / amend (16-20) ---

test("16. close removes the gap and frees a slot", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const r = await runCli(["add", `gap-${i}`, `Gap ${i}`, "--cwd", dir]);
      ids.push(r.stdout.trim());
    }
    const c = await runCli(["close", ids[0], "--cwd", dir]);
    assert.equal(c.code, 0);
    assert.equal(readGaps(dir).gaps.length, 4);
    const again = await runCli(["add", "replacement-gap", "Replacement", "--cwd", dir]);
    assert.equal(again.code, 0);
    assert.equal(readGaps(dir).gaps.length, 5);
  });
});

test("17. close on unknown id: exit 5, store unchanged", async () => {
  await withDir(async (dir) => {
    seed(dir, ["Keep me"]);
    const before = readFileSync(join(dir, ".horizon", "gaps.json"), "utf8");
    const r = await runCli(["close", "no-such-gap", "--cwd", dir]);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /no-such-gap/);
    assert.equal(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8"), before);
  });
});

test("17b. close or amend with an id off the grammar: exit 5, stating the id", async () => {
  await withDir(async (dir) => {
    seed(dir, ["Keep me"]);
    for (const argv of [["close", "g_deadbeef"], ["amend", "Big-Camel", "new text"]]) {
      const r = await runCli([...argv, "--cwd", dir]);
      assert.equal(r.code, 5, `${argv[0]}: exit ${r.code}: ${r.stderr}`);
      assert.match(r.stderr, /invalid gap id/);
      assert.ok(r.stderr.includes(argv[1]), `${argv[0]}: id not named in stderr: ${r.stderr}`);
    }
    assert.equal(readGaps(dir).gaps.length, 1);
  });
});

test("18. close twice: second is exit 5", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const a = await runCli(["add", "doomed-gap", "Doomed", "--cwd", dir]);
    const id = a.stdout.trim();
    assert.equal((await runCli(["close", id, "--cwd", dir])).code, 0);
    assert.equal((await runCli(["close", id, "--cwd", dir])).code, 5);
  });
});

test("19. amend changes text but not id or added_at", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const a = await runCli(["add", "original-wording", "Original wording", "--cwd", dir]);
    const id = a.stdout.trim();
    const before = readGaps(dir).gaps[0].added_at;
    const m = await runCli(["amend", id, "Better wording", "--cwd", dir]);
    assert.equal(m.code, 0);
    const after = readGaps(dir).gaps[0];
    assert.equal(after.id, id);
    assert.equal(after.text, "Better wording");
    assert.equal(after.added_at, before);
  });
});

test("20. amend past the cap rejected, exit 3, text unchanged", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const a = await runCli(["add", "original-gap", "Original", "--cwd", dir]);
    const id = a.stdout.trim();
    const m = await runCli(["amend", id, "y".repeat(513), "--cwd", dir]);
    assert.equal(m.code, 3);
    assert.equal(readGaps(dir).gaps[0].text, "Original");
  });
});

// --- Atomicity / concurrency (21-25, spec section 9 as amended by 297dc95) ---

test("21. no reader ever sees a partial document: 200 reads concurrent with a writer all parse", async () => {
  // temp+fsync+rename property: gaps.json is only ever replaced by a
  // whole-file rename, so a reader mid-write sees either the old or the new
  // document, never a torn one.
  await withDir(async (dir) => {
    await spawnRun(["init", "--cwd", dir]);
    const added = await spawnRun(["add", "seed-gap", "Seed", "--cwd", dir]);
    assert.equal(added.code, 0);
    const gapId = added.stdout.trim();
    const { spawn } = await import("node:child_process");
    // One persistent writer process: imports cli.ts directly and amends in a
    // loop, so writes overlap the reader instead of a new process per write.
    const script = `
      const { main } = await import(${JSON.stringify(new URL("../src/cli.ts", import.meta.url).pathname)});
      for (let i = 0; i < 25; i++) {
        const code = await main(["amend", ${JSON.stringify(gapId)}, "wording " + i, "--cwd", ${JSON.stringify(dir)}]);
        if (code !== 0) process.exit(90 + Math.min(code, 5));
      }
      process.exit(0);
    `;
    const writer = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
    const exited = new Promise((r) => writer.on("exit", r)); // attached before any await
    let parses = 0;
    try {
      for (; parses < 200; parses += 1) {
        assert.doesNotThrow(() => readGaps(dir), `unparseable at read ${parses}`);
        await new Promise((r) => setTimeout(r, 2));
      }
    } finally {
      const wcode = await exited;
      assert.equal(wcode, 0, `writer failed: exit ${wcode}`);
    }
    const state = readGaps(dir);
    assert.ok(state.revision > 1, "writer made no progress");
    assert.ok(state.gaps[0].text.startsWith("wording "), "surviving text not from the writer");
  });
});

test("22. no .tmp remains after a successful write; a SIGKILLed writer's tmp does not block; sweep by mtime", async () => {
  const { spawn } = await import("node:child_process");
  const { readdirSync, utimesSync, existsSync } = await import("node:fs");
  const { setTimeout: delay } = await import("node:timers/promises");
  await withDir(async (dir) => {
    await spawnRun(["init", "--cwd", dir]);
    assert.equal((await spawnRun(["add", "seed-gap", "Seed", "--cwd", dir])).code, 0);
    // (a) successful write leaves no .tmp behind
    assert.equal((await spawnRun(["add", "tidy-gap", "Tidy", "--cwd", dir])).code, 0);
    assert.deepEqual(readdirSync(join(dir, ".horizon")).filter((n) => n.includes(".tmp")), []);
    // (b) a stray tmp (as a SIGKILLed writer strands) does not block the next write
    const stray = join(dir, ".horizon", `.gaps.json.tmp.999999`);
    writeFileSync(stray, "{}\n");
    const r = await spawnRun(["add", "after-stray-tmp", "After stray tmp", "--cwd", dir]);
    assert.equal(r.code, 0, `stray tmp blocked the write: ${r.stderr}`);
    assert.equal(readGaps(dir).gaps.length, 3);
    // (c) a stray tmp backdated past TMP_SWEEP_MS is swept by the next store
    // open; a fresh one is kept.
    const past = new Date(Date.now() - 120_000);
    utimesSync(stray, past, past);
    const fresh = join(dir, ".horizon", `.gaps.json.tmp.${process.pid}`);
    writeFileSync(fresh, "in-flight writer\n");
    const s = await spawnRun(["show", "--cwd", dir]); // any command through the store sweeps on open
    assert.equal(s.code, 0, `stderr: ${s.stderr}`);
    assert.ok(!existsSync(stray), "backdated tmp not swept");
    assert.ok(existsSync(fresh), "fresh tmp was swept (must be kept)");
  });
});

test("23. two concurrent adds: gaps.json parses, gap count 1 or 2 (last-writer-wins)", async () => {
  // The race window between read and rename is microseconds, so 40 rounds
  // with both children spawned simultaneously makes a genuine overlap
  // plausible; the assertion is corruption-freedom, not winner-prediction.
  const { execFile } = await import("node:child_process");
  function startAdd(cwd, id, text) {
    return new Promise((resolve) => {
      execFile(BIN, ["add", id, text, "--cwd", cwd], { encoding: "utf8" }, (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === "number" ? error.code : 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });
    });
  }
  for (let round = 0; round < 40; round++) {
    await withDir(async (dir) => {
      await spawnRun(["init", "--cwd", dir]);
      const [a, b] = await Promise.all([
        startAdd(dir, `alpha-${round}`, `alpha ${round}`),
        startAdd(dir, `beta-${round}`, `beta ${round}`),
      ]);
      // Either exit code is fine (last-writer-wins); no crash, no corruption.
      assert.ok([0, 6].includes(a.code), `round ${round}: a exit ${a.code}: ${a.stderr}`);
      assert.ok([0, 6].includes(b.code), `round ${round}: b exit ${b.code}: ${b.stderr}`);
      const state = readGaps(dir); // throws if the file is corrupt
      assert.ok(state.gaps.length === 1 || state.gaps.length === 2, `round ${round}: ${state.gaps.length} gaps`);
      const texts = new Set(state.gaps.map((g) => g.text));
      // The survivor(s) must be from this round's writes, not a torn document.
      for (const g of state.gaps) assert.ok([`alpha ${round}`, `beta ${round}`].includes(g.text), `round ${round}: alien text ${g.text}`);
      assert.equal(state.gaps.length, texts.size, "duplicate gap texts in store");
    });
  }
});

test("24. rename EPERM retried; later success exits 0; exhaustion exits 6 with file + errno", async () => {
  // HORIZON_CLI_TEST_FAIL_RENAMES=<n>: a test-only hook inside writeGapsFile
  // that fails the first <n> rename attempts with {code:"EPERM"}, then
  // proceeds. Production never sets it.
  await withDir(async (dir) => {
    await spawnRun(["init", "--cwd", dir]);
    assert.equal((await spawnRun(["add", "seed-gap", "Seed", "--cwd", dir])).code, 0);
    // (a) fail the first 2 attempts: 10 ms + 50 ms real backoff, then success.
    const t0 = Date.now();
    const r = await spawnRun(["add", "retried-gap", "Retried", "--cwd", dir], {
      env: { ...process.env, HORIZON_CLI_TEST_FAIL_RENAMES: "2" },
    });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 55, `backoff not real: only ${elapsed} ms elapsed`);
    assert.equal(readGaps(dir).gaps.length, 2);
    assert.ok(readGaps(dir).gaps.some((g) => g.text === "Retried"));
    // (b) hook=99: every attempt fails -> exit 6 naming the file and the errno.
    const r2 = await spawnRun(["add", "doomed-gap", "Doomed", "--cwd", dir], {
      env: { ...process.env, HORIZON_CLI_TEST_FAIL_RENAMES: "99" },
    });
    assert.equal(r2.code, 6, `stdout: ${r2.stdout} stderr: ${r2.stderr}`);
    assert.match(r2.stderr, /gaps\.json/);
    assert.match(r2.stderr, /EPERM/);
    // The failed write left the store intact.
    assert.equal(readGaps(dir).gaps.length, 2);
  });
});

test("25. 20 concurrent session-ends yield 20 valid lines", async () => {
  await withDir(async (dir) => {
    await spawnRun(["init", "--cwd", dir]);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        spawnRun(["session-end", "--harness", "test", "--session", `s-${i}`, "--cwd", dir]),
      ),
    );
    for (const r of results) assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const lines = readFileSync(join(dir, ".horizon", "sessions.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    assert.equal(lines.length, 20);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  });
});

// --- session-end (26-29) ---

test("26. omitted --summary writes null, not empty or placeholder", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const r = await runCli(["session-end", "--harness", "hermes", "--session", "s1", "--cwd", dir]);
    assert.equal(r.code, 0);
    const rec = JSON.parse(readFileSync(join(dir, ".horizon", "sessions.jsonl"), "utf8").trim());
    assert.equal(rec.summary, null);
  });
});

test("27. gaps_added computed from the session's own mutations", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const a = await runCli(["add", "mine-gap", "Mine", "--cwd", dir, "--session", "s1"]);
    // Flag-injected arrays are not a thing: passing one is a usage error.
    const bad = await runCli(["session-end", "--harness", "t", "--session", "s1", "--gaps-added", a.stdout.trim(), "--cwd", dir]);
    assert.notEqual(bad.code, 0);
    const r = await runCli(["session-end", "--harness", "t", "--session", "s1", "--cwd", dir]);
    assert.equal(r.code, 0);
    const rec = JSON.parse(readFileSync(join(dir, ".horizon", "sessions.jsonl"), "utf8").trim());
    assert.deepEqual(rec.gaps_added, [a.stdout.trim()]);
  });
});

test("28. untouched session still writes a record with empty arrays", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const r = await runCli(["session-end", "--harness", "t", "--session", "idle", "--cwd", dir]);
    assert.equal(r.code, 0);
    const rec = JSON.parse(readFileSync(join(dir, ".horizon", "sessions.jsonl"), "utf8").trim());
    assert.deepEqual(rec.gaps_added, []);
    assert.deepEqual(rec.gaps_closed, []);
  });
});

test("28b. closing another session's gap closes only — the closer never inherits authorship", async () => {
  // The union that fills the same-session add+close hole (an added gap no
  // longer open, witnessed by the close record's added_session_id) must not
  // over-attribute: a gap ADDED by s1 and CLOSED by s2 lands in s2's
  // gaps_closed alone, never in s2's gaps_added.
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    await runCli(["add", "old-gap", "Added long ago", "--cwd", dir, "--session", "s1"]);
    await runCli(["close", "old-gap", "--cwd", dir, "--session", "s2"]);
    const r = await runCli(["session-end", "--harness", "t", "--session", "s2", "--cwd", dir]);
    assert.equal(r.code, 0);
    const rec = JSON.parse(readFileSync(join(dir, ".horizon", "sessions.jsonl"), "utf8").trim());
    assert.deepEqual(rec.gaps_closed, ["old-gap"]);
    assert.deepEqual(rec.gaps_added, []);
    // And the same-session shape still carries both: added AND closed by s3.
    await runCli(["add", "flash-gap", "Added and closed in one session", "--cwd", dir, "--session", "s3"]);
    await runCli(["close", "flash-gap", "--cwd", dir, "--session", "s3"]);
    const r3 = await runCli(["session-end", "--harness", "t", "--session", "s3", "--cwd", dir]);
    assert.equal(r3.code, 0);
    const lines = readFileSync(join(dir, ".horizon", "sessions.jsonl"), "utf8").trim().split("\n");
    const rec3 = JSON.parse(lines[lines.length - 1]);
    assert.deepEqual(rec3.gaps_added, ["flash-gap"]);
    assert.deepEqual(rec3.gaps_closed, ["flash-gap"]);
  });
});

test("29. missing --harness or --session: exit 2, nothing appended", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const sessionsPath = join(dir, ".horizon", "sessions.jsonl");
    assert.equal((await runCli(["session-end", "--session", "s1", "--cwd", dir])).code, 2);
    assert.equal((await runCli(["session-end", "--harness", "t", "--cwd", dir])).code, 2);
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(sessionsPath));
  });
});

// --store is the close hooks' round-trip: the dir horizon-inject --json
// resolved, handed back so teardown never re-discovers (the harness process
// may have chdir'd since the injection).
test("session-end-store. --store targets that store directly; an absent or non-dir path is the storeless no-op; a malformed store still exits 7", async () => {
  await withDir(async (dir) => {
    seed(dir, ["Store target gap"]);
    const store = join(dir, ".horizon");
    // The record lands in the named store, discovered nowhere: the command
    // runs from a cwd with no store at all.
    await withDir(async (elsewhere) => {
      const r = await runCli(["session-end", "--harness", "t", "--session", "s-store", "--store", store, "--cwd", elsewhere]);
      assert.equal(r.code, 0, r.stderr);
    });
    const rec = JSON.parse(readFileSync(join(store, "sessions.jsonl"), "utf8").trim());
    assert.equal(rec.session_id, "s-store");
    assert.deepEqual(rec.gaps_added, []);
    // An absent path is the storeless twin: silent no-op, exit 0.
    const gone = await runCli(["session-end", "--harness", "t", "--session", "s-gone", "--store", join(dir, "nope")]);
    assert.equal(gone.code, 0);
    // A file, not a directory: the same no-op.
    const filePath = join(dir, "plain-file");
    writeFileSync(filePath, "x");
    const notDir = await runCli(["session-end", "--harness", "t", "--session", "s-file", "--store", filePath]);
    assert.equal(notDir.code, 0);
    const lines = readFileSync(join(store, "sessions.jsonl"), "utf8");
    assert.ok(!lines.includes("s-gone"), "an absent --store must record nothing");
    assert.ok(!lines.includes("s-file"), "a non-directory --store must record nothing");
    // A store that exists but is malformed: the normal error path applies.
    await withDir(async (broken) => {
      mkdirSync(join(broken, ".horizon"), { recursive: true });
      writeFileSync(join(broken, ".horizon", "gaps.json"), "{not json");
      const bad = await runCli(["session-end", "--harness", "t", "--session", "s-bad", "--store", join(broken, ".horizon")]);
      assert.equal(bad.code, 7);
      assert.match(bad.stderr, /gaps\.json/);
    });
  });
});

// --- session-end idempotency: one record per (harness, session_id) ---

// The close hooks can run session-end twice for one session (a mid-session
// steer plus session_shutdown, a retried teardown): the pair's first record
// wins and every later call is a silent no-op, the second summary dropped
// with it. session-end's only write is the sessions.jsonl append — the
// repeat must not start writing closes.jsonl either.
test("session-end-once. first call records; a repeat is a byte-level no-op even with a different summary", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const sessionsPath = join(dir, ".horizon", "sessions.jsonl");
    const first = await runCli(["session-end", "--harness", "t", "--session", "s1", "--summary", "the real one", "--cwd", dir]);
    assert.equal(first.code, 0);
    assert.equal(first.stdout, "");
    const bytes = readFileSync(sessionsPath, "utf8");
    for (const summary of ["the real one", "a second, different story"]) {
      const r = await runCli(["session-end", "--harness", "t", "--session", "s1", "--summary", summary, "--cwd", dir]);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr, "");
      assert.equal(readFileSync(sessionsPath, "utf8"), bytes, `a repeat appended (summary: ${summary})`);
    }
    assert.ok(!existsSync(join(dir, ".horizon", "closes.jsonl")), "a repeat must not touch closes.jsonl");
  });
});

test("session-end-once-distinct. a different session id, or a different harness with the same id, records anew", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    for (const [harness, session] of [["t", "s1"], ["t", "s2"], ["other", "s1"]]) {
      const r = await runCli(["session-end", "--harness", harness, "--session", session, "--cwd", dir]);
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    }
    const lines = readFileSync(join(dir, ".horizon", "sessions.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.deepEqual(
      lines.map((l) => {
        const rec = JSON.parse(l);
        return `${rec.harness}/${rec.session_id}`;
      }),
      ["t/s1", "t/s2", "other/s1"],
    );
  });
});

test("session-end-once-store. the dedupe holds through the --store form too", async () => {
  await withDir(async (dir) => {
    seed(dir, ["Stored gap"]);
    const store = join(dir, ".horizon");
    await withDir(async (elsewhere) => {
      const first = await runCli(["session-end", "--harness", "t", "--session", "s-store", "--store", store, "--cwd", elsewhere]);
      assert.equal(first.code, 0);
      const again = await runCli(["session-end", "--harness", "t", "--session", "s-store", "--store", store, "--cwd", elsewhere]);
      assert.equal(again.code, 0);
      assert.equal(again.stdout, "");
    });
    const lines = readFileSync(join(store, "sessions.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
  });
});

// --- log (30-31) ---

test("30. log prints newest first and honours --limit", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    for (const s of ["s1", "s2", "s3"]) {
      await runCli(["session-end", "--harness", "t", "--session", s, "--summary", `summary ${s}`, "--cwd", dir]);
    }
    const r = await runCli(["log", "--cwd", dir]);
    assert.equal(r.code, 0);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /summary s3/);
    assert.match(lines[2], /summary s1/);
    const limited = await runCli(["log", "--limit", "2", "--cwd", dir]);
    assert.equal(limited.stdout.trim().split("\n").length, 2);
    assert.match(limited.stdout, /summary s3/);
    assert.doesNotMatch(limited.stdout, /summary s1/);
  });
});

test("31. null summary renders as (no summary)", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    await runCli(["session-end", "--harness", "t", "--session", "s1", "--cwd", dir]);
    const r = await runCli(["log", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\(no summary\)/);
  });
});

// --- Store integrity (32-33) ---

test("32. malformed gaps.json: exit 7 naming the file, not overwritten", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(join(dir, ".horizon", "gaps.json"), "{not json");
    const r = await runCli(["show", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /gaps\.json/);
    assert.equal(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8"), "{not json");
  });
});

test("33. unknown future version refused, not migrated", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(join(dir, ".horizon", "gaps.json"), JSON.stringify({ version: 99, revision: 0, gaps: [] }));
    const r = await runCli(["show", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.equal(JSON.parse(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8")).version, 99);
  });
});

// --- Injection texts (34: DEF-3 byte-contract) ---

test("34. exported texts equal the spec section 10 fence blocks byte-for-byte", async () => {
  // DEF-3 ruling: each export equals the INSIDE of its fenced block exactly
  // (no trailing newline added or stripped; fence backticks are markdown,
  // not content). Extract the fences from the spec and compare characters.
  const SRC = new URL("../src/texts.ts", import.meta.url).pathname;
  const SPEC = new URL("../.scratch/deep-horizon/05-cli-contract.md", import.meta.url).pathname;
  const spec = readFileSync(SPEC, "utf8").split("\n");
  const { HORIZON_BLOCK_TEMPLATE, BOOTSTRAP_NUDGE_TEXT, NUDGE_TEXT } = await import(SRC);
  assert.equal(HORIZON_BLOCK_TEMPLATE, specFence(spec, "### 10.1"));
  assert.equal(BOOTSTRAP_NUDGE_TEXT, specFence(spec, "### 10.2"));
  assert.equal(NUDGE_TEXT, specFence(spec, "### 10.3"));
});

// --- Adversary regression gates (ADV-1..12, fix card t_76f202ea) ---

// ADV-1: a non-object element in gaps[] used to crash every store-touching
// command with a raw TypeError + exit 1. Spec 7: malformed store -> exit 7
// naming the file. (The gap body was already tightened by HL-11's
// envelope hardening; this pins the id/text field types too.)
test("ADV-1. gaps[] containing null: exit 7 naming gaps.json, no crash", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(join(dir, ".horizon", "gaps.json"), '{"version":1,"revision":1,"gaps":[null]}');
    const r = await runCli(["show", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /gaps\.json/);
    assert.ok(!/TypeError|at /m.test(r.stderr), `raw stack leaked: ${r.stderr}`);
    assert.equal(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8"), '{"version":1,"revision":1,"gaps":[null]}');
  });
});

test("ADV-1b. gap with non-string text: exit 7 (no crash, store untouched)", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(
      join(dir, ".horizon", "gaps.json"),
      JSON.stringify({ version: 1, revision: 1, gaps: [{ id: "numeric-text", text: 7 }] }) + "\n",
    );
    const r = await runCli(["show", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /gaps\.json/);
    assert.ok(!/TypeError|at /m.test(r.stderr), `raw stack leaked: ${r.stderr}`);
  });
});

// ADV-2: a bare `null` line in a JSONL log used to crash `log` (human) with
// exit 1 and silently pass through `log --json`. A JSONL line whose parse is
// valid JSON but not an object makes the whole file malformed: exit 7.
test("ADV-2. null line in sessions.jsonl: log exits 7; --json never emits a null record", async () => {
  await withDir(async (dir) => {
    // A valid (empty) store seeded through the interface; the hand-written
    // part is the hostile JSONL sibling below.
    seed(dir, []);
    const good = JSON.stringify({ ts: "2026-09-08T15:00:00Z", harness: "t", session_id: "s0", summary: null, gaps_added: [], gaps_closed: [] });
    writeFileSync(join(dir, ".horizon", "sessions.jsonl"), good + "\nnull\n");
    const r = await runCli(["log", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /sessions\.jsonl/);
    const rj = await runCli(["log", "--cwd", dir, "--json"]);
    assert.equal(rj.code, 7);
    assert.ok(!/^\s*null\s*$/m.test(rj.stdout), "--json emitted a null record");
  });
});

test("ADV-2b. null line in closes.jsonl: session-end exits 7 naming closes.jsonl", async () => {
  await withDir(async (dir) => {
    // A valid (empty) store seeded through the interface; the hand-written
    // part is the hostile JSONL sibling below.
    seed(dir, []);
    writeFileSync(join(dir, ".horizon", "closes.jsonl"), "null\n");
    const r = await runCli(["session-end", "--harness", "t", "--session", "s1", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /closes\.jsonl/);
  });
});

test("ADV-2c. syntactically invalid JSONL line: exit 7 (same contract as a null line)", async () => {
  await withDir(async (dir) => {
    // A valid (empty) store seeded through the interface; the hand-written
    // part is the hostile JSONL sibling below.
    seed(dir, []);
    writeFileSync(join(dir, ".horizon", "sessions.jsonl"), "{not json}\n");
    const r = await runCli(["log", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /sessions\.jsonl/);
  });
});

// session-end reads sessions.jsonl for the once-per-pair dedupe, so a
// malformed log fails closed the way every other store read does — exit 7
// naming the file, never an unchecked append — in both resolution forms.
test("ADV-2d. malformed sessions.jsonl at session-end: exit 7, cwd and --store forms alike", async () => {
  await withDir(async (dir) => {
    // A valid (empty) store seeded through the interface; the hand-written
    // part is the hostile JSONL sibling below.
    seed(dir, []);
    const store = join(dir, ".horizon");
    writeFileSync(join(store, "sessions.jsonl"), "{not json}\n");
    const r = await runCli(["session-end", "--harness", "t", "--session", "s1", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /sessions\.jsonl/);
    await withDir(async (elsewhere) => {
      const rs = await runCli(["session-end", "--harness", "t", "--session", "s2", "--store", store, "--cwd", elsewhere]);
      assert.equal(rs.code, 7);
      assert.match(rs.stderr, /sessions\.jsonl/);
    });
    assert.ok(!readFileSync(join(store, "sessions.jsonl"), "utf8").includes("s2"), "appended past the malformed log");
  });
});

// ADV-3: the close/session record append used to run AFTER the gaps.json
// rename; an append failure then lost the record while the gap was already
// gone (unauditable close, exit 1). Now record-first: append, then rename.
test("ADV-3. append failure at close: exit 7, gap still open, store unchanged", async () => {
  const dir = freshDir();
  try {
    await runCli(["init", "--cwd", dir]);
    const add = await runCli(["add", "doomed-close", "Doomed close", "--cwd", dir]);
    assert.equal(add.code, 0);
    const id = add.stdout.trim();
    // closes.jsonl is created by the first close, so touch it first; an
    // append to a file the process cannot write must then fail.
    const closes = join(dir, ".horizon", "closes.jsonl");
    writeFileSync(closes, "");
    chmodSync(closes, 0o444);
    const r = await runCli(["close", id, "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /closes\.jsonl/);
    // No partial state: the gap is STILL open, revision did not move.
    const g = readGaps(dir);
    assert.equal(g.revision, 1);
    assert.deepEqual(g.gaps.map((x) => x.id), [id]);
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(join(dir, ".horizon", "sessions.jsonl")));
  } finally {
    const { existsSync: ex } = await import("node:fs");
    if (ex(join(dir, ".horizon", "closes.jsonl"))) chmodSync(join(dir, ".horizon", "closes.jsonl"), 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADV-3b. append failure at session-end: exit 7, no session record written", async () => {
  const dir = freshDir();
  try {
    await runCli(["init", "--cwd", dir]);
    await runCli(["add", "recorded-gap", "Recorded gap", "--cwd", dir, "--session", "s9"]);
    const sessions = join(dir, ".horizon", "sessions.jsonl");
    await runCli(["session-end", "--harness", "t", "--session", "s9", "--cwd", dir]);
    chmodSync(sessions, 0o444);
    // The failing append needs a pair with no record yet: s9's repeat is the
    // idempotent no-op (session-end-once) and never reaches the append.
    const r = await runCli(["session-end", "--harness", "t", "--session", "s9-again", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /sessions\.jsonl/);
    assert.equal(readFileSync(sessions, "utf8").trim().split("\n").length, 1, "record appended despite failure");
  } finally {
    chmodSync(join(dir, ".horizon", "sessions.jsonl"), 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A close record whose gap is still open (crash between the append and the
// rename) is a no-op for session-end/log accounting, never a phantom close.
test("ADV-3c. close record with the gap still open: counted once, by real closes only", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    await runCli(["add", "half-closed", "Half closed", "--cwd", dir, "--session", "s1"]);
    const store = join(dir, ".horizon");
    const id = readGaps(dir).gaps[0].id;
    writeFileSync(join(store, "closes.jsonl"), JSON.stringify({ ts: "2026-09-08T15:00:00Z", session_id: "s1", gap_id: id, added_session_id: "s1" }) + "\n");
    // Session s2 closes it for real; now two close records exist for the id,
    // one from the orphaned pre-crash append.
    const r = await runCli(["close", id, "--cwd", dir, "--session", "s2"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const se = await runCli(["session-end", "--harness", "t", "--session", "s2", "--cwd", dir]);
    assert.equal(se.code, 0, `stderr: ${se.stderr}`);
    const rec = JSON.parse((await runCli(["log", "--cwd", dir, "--json"])).stdout.trim().split("\n")[0]);
    assert.deepEqual(rec.gaps_closed, [id]);
  });
});

// ADV-3d: an orphaned close record (crash between the closes.jsonl append and
// the gaps.json rename) is a NO-OP: the session that wrote it must not count
// the gap in gaps_closed while the gap is still open. Only gaps actually
// absent from gaps.json are counted, and only once, by the real closer.
test("ADV-3d. orphan close record while gap still open: that session's gaps_closed is empty", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    await runCli(["add", "orphan-close", "Orphan close", "--cwd", dir, "--session", "s1"]);
    const store = join(dir, ".horizon");
    const id = readGaps(dir).gaps[0].id;
    // Crash simulation: the close record lands while the gap is still open.
    writeFileSync(join(store, "closes.jsonl"), JSON.stringify({ ts: "2026-09-08T15:00:00Z", session_id: "s1", gap_id: id, added_session_id: "s1" }) + "\n");
    const se = await runCli(["session-end", "--harness", "t", "--session", "s1", "--cwd", dir]);
    assert.equal(se.code, 0, `stderr: ${se.stderr}`);
    const rec = JSON.parse((await runCli(["log", "--cwd", dir, "--json"])).stdout.trim().split("\n")[0]);
    assert.deepEqual(rec.gaps_closed, []);
    // A real close from another session IS counted, exactly once.
    const r = await runCli(["close", id, "--cwd", dir, "--session", "s2"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const se2 = await runCli(["session-end", "--harness", "t", "--session", "s2", "--cwd", dir]);
    assert.equal(se2.code, 0, `stderr: ${se2.stderr}`);
    const rec2 = JSON.parse((await runCli(["log", "--cwd", dir, "--json"])).stdout.trim().split("\n")[0]);
    assert.deepEqual(rec2.gaps_closed, [id]);
  });
});

// The third join shape, after ADV-3c/3d: the closing session is also the
// adding session. The gap is gone from gaps.json, so the provenance scan
// cannot see the add — only the union with the session's own close records
// carries the id into gaps_added, and both arrays hold it.
test("ADV-3e. added and closed by the same session: both arrays carry the id", async () => {
  await withDir(async (dir) => {
    // A bystander open gap (added by the seeder's own session) proves the
    // inference is provenance-scoped, not "everything open".
    seed(dir, ["Bystander gap"]);
    const a = await runCli(["add", "one-breath", "Added and closed in one breath", "--cwd", dir, "--session", "sX"]);
    assert.equal(a.code, 0, `stderr: ${a.stderr}`);
    const c = await runCli(["close", "one-breath", "--cwd", dir, "--session", "sX"]);
    assert.equal(c.code, 0, `stderr: ${c.stderr}`);
    const se = await runCli(["session-end", "--harness", "t", "--session", "sX", "--cwd", dir]);
    assert.equal(se.code, 0, `stderr: ${se.stderr}`);
    assert.equal(se.stdout, "");
    // The record shape, bytes included: field order is
    // ts, harness, session_id, summary, gaps_added, gaps_closed.
    const raw = readFileSync(join(dir, ".horizon", "sessions.jsonl"), "utf8").trim();
    const rec = JSON.parse(raw);
    assert.deepEqual(rec.gaps_added, ["one-breath"]);
    assert.deepEqual(rec.gaps_closed, ["one-breath"]);
    assert.equal(rec.harness, "t");
    assert.equal(rec.session_id, "sX");
    assert.equal(rec.summary, null);
    assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.match(
      raw,
      /^\{"ts":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z","harness":"t","session_id":"sX","summary":null,"gaps_added":\["one-breath"\],"gaps_closed":\["one-breath"\]\}$/,
    );
  });
});

// ADV-4: `.horizon` existing as a REGULAR FILE used to crash init/add with a
// raw ENOTDIR stack, exit 1. Spec 7: unusable store path -> exit 7 naming it.
test("ADV-4. .horizon as a regular file: init and add exit 7 naming the path", async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, ".horizon"), "not a directory\n");
    for (const argv of [["init"], ["add", "x-gap", "X"]]) {
      const r = await runCli([...argv, "--cwd", dir]);
      assert.equal(r.code, 7, `${argv[0]}: ${r.stderr}`);
      assert.match(r.stderr, /\.horizon/);
      assert.ok(!/at /m.test(r.stderr), `${argv[0]}: raw stack leaked: ${r.stderr}`);
    }
  });
});

// ADV-4b: mkdir EACCES on a NEW store used to crash `add` with a raw stack.
test("ADV-4b. mkdir EACCES on new-store add: exit 7 naming the path, no raw stack", async () => {
  if (process.platform === "win32") return; // POSIX permission model only
  const dir = freshDir();
  try {
    chmodSync(dir, 0o555);
    const r = await runCli(["add", "no-permission", "No permission", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /\.horizon/);
    assert.ok(!/at /m.test(r.stderr), `raw stack leaked: ${r.stderr}`);
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ADV-4c: mkdir EACCES on a NEW store must fail both init and add with exit 7
// naming the path (mutant class: materializeStoreDir swallowing the creation
// error makes init exit 0 silently with no store created).
test("ADV-4c. mkdir EACCES on new store: init exits 7 naming the path, store absent", async () => {
  if (process.platform === "win32") return; // POSIX permission model only
  const dir = freshDir();
  try {
    chmodSync(dir, 0o555);
    const i = await runCli(["init", "--cwd", dir]);
    assert.equal(i.code, 7, `init stderr: ${i.stderr}`);
    assert.match(i.stderr, /\.horizon/);
    assert.ok(!/at /m.test(i.stderr), `raw stack leaked: ${i.stderr}`);
    const a = await runCli(["add", "no-permission", "No permission", "--cwd", dir]);
    assert.equal(a.code, 7, `add stderr: ${a.stderr}`);
    assert.match(a.stderr, /\.horizon/);
    assert.ok(!/at /m.test(a.stderr), `raw stack leaked: ${a.stderr}`);
    assert.equal(existsSync(join(dir, ".horizon")), false, "store must not be created");
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ADV-5: an unreadable store directory used to crash the tmp sweep with a
// raw EACCES scandir stack, exit 1.
test("ADV-5. store dir chmod 000: exit 7, no crash", async () => {
  if (process.platform === "win32") return; // POSIX permission model only
  const dir = freshDir();
  try {
    await runCli(["init", "--cwd", dir]);
    chmodSync(join(dir, ".horizon"), 0o000);
    const r = await runCli(["show", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /\.horizon/);
    assert.ok(!/at /m.test(r.stderr), `raw stack leaked: ${r.stderr}`);
  } finally {
    chmodSync(join(dir, ".horizon"), 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ADV-5b: a store FILE where a JSONL log belongs is malformed, not a crash.
test("ADV-5b. sessions.jsonl as a directory: log exits 7 naming it", async () => {
  const dir = freshDir();
  try {
    // A valid (empty) store seeded through the interface; the hand-written
    // part is the hostile JSONL sibling below.
    seed(dir, []);
    mkdirSync(join(dir, ".horizon", "sessions.jsonl"));
    const r = await runCli(["log", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /sessions\.jsonl/);
    assert.ok(!/at /m.test(r.stderr), `raw stack leaked: ${r.stderr}`);
  } finally {
    rmdirSync(join(dir, ".horizon", "sessions.jsonl"));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADV-6. rename ENOENT after retries: distinct swept-tmp message, exit 6", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    assert.equal((await runCli(["add", "seed-gap", "Seed", "--cwd", dir])).code, 0);
    // The old message blamed "EPERM" and hid the real cause; a swept tmp is
    // the one deterministic way a rename fails with ENOENT.
    const r = await runCli(["add", "vanished-gap", "Vanished", "--cwd", dir], {
      env: { ...process.env, HORIZON_CLI_TEST_FAIL_RENAMES: "99", HORIZON_CLI_TEST_RENAME_ERRNO: "ENOENT" },
    });
    assert.equal(r.code, 6);
    assert.match(r.stderr, /swept/);
    assert.match(r.stderr, /retry the command/);
    assert.equal(readGaps(dir).gaps.length, 1);
  });
});

test("ADV-9. help text alignment: command column and --harness naming line up", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0);
  const lines = r.stdout.split("\n").filter((l) => l.startsWith("  "));
  for (const l of lines.filter((l) => !l.includes("--harness"))) {
    assert.ok(/ {2}\S.*?(\s{2,}|\n)/.test(l), `misaligned help line: ${JSON.stringify(l)}`);
  }
  const drift = lines.filter((l) => l.includes("--harness"));
  for (const l of drift) assert.ok(l.includes("--harness <name>"), `drifted flag naming: ${JSON.stringify(l)}`);
});

function assertValidLimit(value) {
  return async () => {
    await withDir(async (dir) => {
      await runCli(["init", "--cwd", dir]);
      const r = await runCli(["log", "--limit", value, "--cwd", dir]);
      assert.equal(r.code, 2, `--limit ${value} accepted`);
      assert.match(r.stderr, /--limit/);
    });
  };
}

test("ADV-10. --limit past Number.MAX_SAFE_INTEGER rejected, exit 2", assertValidLimit("99999999999999999999"));
test("ADV-11. --limit leading zeros rejected, exit 2", assertValidLimit("007"));

// --- Cross-platform gates (X1-X5, spec section 9 as amended by 297dc95) ---

test("X1. no native dependency: no gypfile, no os-lock/fs-ext, no compiler install script", async () => {
  const { existsSync } = await import("node:fs");
  const pkgRoot = new URL("..", import.meta.url).pathname;
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  assert.equal(pkg.gypfile, undefined, "gypfile must not be set");
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  for (const banned of ["os-lock", "fs-ext"]) {
    assert.equal(deps[banned], undefined, `native dependency ${banned} must not be present`);
  }
  const scripts = pkg.scripts ?? {};
  for (const [name, script] of Object.entries(scripts)) {
    assert.ok(!/\b(node-gyp|node_gyp|prebuild-install|cmake|make|gcc|clang)\b/.test(String(script)), `script ${name} may not invoke a compiler: ${script}`);
  }
  assert.ok(!existsSync(join(pkgRoot, "binding.gyp")), "binding.gyp must not exist");
});

test("X2. no symlink/readlink anywhere in src/", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const srcDir = new URL("../src", import.meta.url).pathname;
  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  })(srcDir);
  assert.ok(files.length > 0, "src/ is empty");
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/symlink|readlink/i.test(text), `${f} mentions symlink/readlink`);
  }
});

test("X3. no hand-built separators in src/ (all paths via path.join)", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const srcDir = new URL("../src", import.meta.url).pathname;
  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  })(srcDir);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    // `+ "/"` and `+ '/'` are hand-built separators; path.join is the only
    // sanctioned path builder (spec 4.1).
    assert.ok(!/[+]\s*['"]\/['"]/.test(text), `${f} hand-builds a path separator`);
  }
});

test("X4. init writes .horizon/.gitattributes (* -text); JSONL reader tolerates CRLF and blank lines", async () => {
  await withDir(async (dir) => {
    const r = await runCli(["init", "--cwd", dir]);
    assert.equal(r.code, 0);
    const ga = join(dir, ".horizon", ".gitattributes");
    const { existsSync } = await import("node:fs");
    assert.ok(existsSync(ga), ".gitattributes missing after init");
    assert.equal(readFileSync(ga, "utf8"), "* -text\n");
    // First add (store created by add, not init) also ships the .gitattributes.
    await withDir(async (dir2) => {
      await runCli(["add", "ships-attrs", "Ships gitattributes too", "--cwd", dir2]);
      assert.equal(readFileSync(join(dir2, ".horizon", ".gitattributes"), "utf8"), "* -text\n");
    });
    // JSONL reader: CRLF line endings and blank lines are tolerated.
    await runCli(["add", "crlf-gap", "CRLF gap", "--cwd", dir, "--session", "s1"]);
    await runCli(["session-end", "--harness", "t", "--session", "s1", "--cwd", dir]);
    const sessions = join(dir, ".horizon", "sessions.jsonl");
    const raw = readFileSync(sessions, "utf8");
    writeFileSync(sessions, "\r\n" + raw.trim().split("\n").join("\r\n") + "\r\n\r\n");
    const rec = JSON.parse((await runCli(["log", "--cwd", dir, "--json"])).stdout.trim().split("\n")[0]);
    assert.equal(rec.harness, "t");
    assert.deepEqual(rec.gaps_added.length >= 1, true);
  });
});

test("X5. a store directory named .Horizon is discovered (case-insensitive resolution)", async () => {
  await withDir(async (dir) => {
    const store = join(dir, ".Horizon");
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, "gaps.json"),
      JSON.stringify({ version: 1, revision: 0, gaps: [] }, null, 2) + "\n",
    );
    const r = await runCli(["add", "found-horizon", "Found .Horizon", "--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    // The write landed in the real (case-variant) directory, not a new .horizon.
    const { existsSync, readdirSync } = await import("node:fs");
    assert.ok(existsSync(join(store, ".gitattributes")), ".gitattributes not written to the real store dir");
    assert.deepEqual(readdirSync(dir).filter((n) => n.toLowerCase() === ".horizon"), [".Horizon"]);
    const state = JSON.parse(readFileSync(join(store, "gaps.json"), "utf8"));
    assert.equal(state.gaps.length, 1);
    assert.equal(state.gaps[0].text, "Found .Horizon");
  });
});

test("X6. init writes .horizon/.gitignore (sessions.jsonl, *.tmp.*); gaps.json not ignored", async () => {
  await withDir(async (dir) => {
    const r = await runCli(["init", "--cwd", dir]);
    assert.equal(r.code, 0);
    const gi = join(dir, ".horizon", ".gitignore");
    assert.ok(existsSync(gi), ".gitignore missing after init");
    const body = readFileSync(gi, "utf8");
    assert.match(body, /^sessions\.jsonl$/m, "sessions.jsonl entry missing");
    assert.match(body, /^\*\.tmp\.\*$/m, "*.tmp.* entry missing");
    // First add (store created by add, not init) also ships the .gitignore.
    await withDir(async (dir2) => {
      await runCli(["add", "ships-ignore", "Ships gitignore too", "--cwd", dir2]);
      assert.equal(readFileSync(join(dir2, ".horizon", ".gitignore"), "utf8"), body);
    });
    // git itself honours the nested file: the JSONL files and the atomic-write
    // tmp names are ignored; gaps.json (the traveling horizon) is not.
    // core.excludesFile is blanked so the assertion cannot depend on the
    // machine's global gitignore.
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const checkIgnore = (paths) =>
      execFileSync(
        "git",
        ["-c", "core.excludesFile=/dev/null", "check-ignore", "--", ...paths],
        { cwd: dir, encoding: "utf8" },
      ).trim().split("\n");
    assert.deepEqual(
      checkIgnore([".horizon/sessions.jsonl", ".horizon/.gaps.json.tmp.12345.1.0a1b2c3d4e5f"]),
      [".horizon/sessions.jsonl", ".horizon/.gaps.json.tmp.12345.1.0a1b2c3d4e5f"],
    );
    let gapsIgnored = true;
    try {
      checkIgnore([".horizon/gaps.json"]);
    } catch {
      gapsIgnored = false; // exit 1: nothing ignored
    }
    assert.ok(!gapsIgnored, ".horizon/gaps.json must not be git-ignored");
  });
});

// --- about (spec 1.1, 10.3: the human-authored about line) ---

test("about-1. about \"<text>\" sets and replaces the line, bumps revision, preserves gaps; bare about prints it", async () => {
  await withDir(async (dir) => {
    const gaps = seed(dir, ["Existing gap"]);
    const r = await runCli(["about", "AI plugin to help agents with long term goals", "--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const state = readGaps(dir);
    assert.equal(state.about, "AI plugin to help agents with long term goals");
    assert.equal(state.revision, gaps.length + 1);
    assert.deepEqual(state.gaps, gaps);
    const print = await runCli(["about", "--cwd", dir]);
    assert.equal(print.code, 0);
    assert.equal(print.stdout, "AI plugin to help agents with long term goals\n");
    // A second set REPLACES rather than appends.
    const r2 = await runCli(["about", "A different line", "--cwd", dir]);
    assert.equal(r2.code, 0, `stderr: ${r2.stderr}`);
    assert.equal(readGaps(dir).about, "A different line");
    assert.equal(readGaps(dir).gaps.length, 1);
  });
});

test("about-2. bare about on an unset store and on no store: prints nothing, exit 0", async () => {
  await withDir(async (dir) => {
    seed(dir, ["A gap without an about"]);
    const r = await runCli(["about", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    await withDir(async (none) => {
      const r2 = await runCli(["about", "--cwd", none]);
      assert.equal(r2.code, 0);
      assert.equal(r2.stdout, "");
    });
  });
});

test("about-3. show prints the about header before gaps, alone when gapless; --json shape unchanged", async () => {
  await withDir(async (dir) => {
    const gaps = seed(dir, ["First gap", "Second gap"]);
    await runCli(["about", "AI plugin to help agents with long term goals", "--cwd", dir]);
    const r = await runCli(["show", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.equal(
      r.stdout,
      `about  AI plugin to help agents with long term goals\n${gaps[0].id}  First gap\n${gaps[1].id}  Second gap\n`,
    );
    const j = await runCli(["show", "--cwd", dir, "--json"]);
    assert.equal(j.code, 0);
    assert.deepEqual(JSON.parse(j.stdout), gaps); // bare gaps array, no about
    // About set, no gaps: the header line alone.
    await withDir(async (bare) => {
      seed(bare, []);
      await runCli(["about", "Only an about", "--cwd", bare]);
      const b = await runCli(["show", "--cwd", bare]);
      assert.equal(b.code, 0);
      assert.equal(b.stdout, "about  Only an about\n");
    });
  });
});

test("about-4. validation: empty/blank/newline/513 code points -> exit 3 (same style as gap text); unknown flag or extra positional -> exit 2", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const empty = await runCli(["about", "", "--cwd", dir]);
    assert.equal(empty.code, 3);
    assert.match(empty.stderr, /about text is empty; not saved\./);
    assert.equal((await runCli(["about", "   ", "--cwd", dir])).code, 3);
    assert.equal((await runCli(["about", "\t ", "--cwd", dir])).code, 3);
    const nl = await runCli(["about", "line one\nline two", "--cwd", dir]);
    assert.equal(nl.code, 3);
    assert.match(nl.stderr, /about text contains a newline/);
    const over = await runCli(["about", "x".repeat(513), "--cwd", dir]);
    assert.equal(over.code, 3);
    assert.match(over.stderr, /about text is 513 code points; the limit is 512\. Not saved\./);
    assert.equal((await runCli(["about", "x".repeat(512), "--cwd", dir])).code, 0);
    // Usage errors: unknown flag, extra positional, --clear with text.
    assert.equal((await runCli(["about", "text", "--bogus", "--cwd", dir])).code, 2);
    assert.equal((await runCli(["about", "one", "two", "--cwd", dir])).code, 2);
    assert.equal((await runCli(["about", "text", "--clear", "--cwd", dir])).code, 2);
    // The rejected sets did not overwrite the accepted 512-point one.
    const state = readGaps(dir);
    assert.equal(state.about, "x".repeat(512));
  });
});

test("about-5. --clear removes the field, bumps revision, preserves gaps", async () => {
  await withDir(async (dir) => {
    const gaps = seed(dir, ["Survives the clear"]);
    await runCli(["about", "Doomed about line", "--cwd", dir]);
    const before = readGaps(dir);
    const r = await runCli(["about", "--clear", "--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const state = readGaps(dir);
    assert.equal(state.about, undefined);
    assert.ok(!("about" in state), "the about field must be absent, not null");
    assert.equal(state.revision, before.revision + 1);
    assert.deepEqual(state.gaps, gaps);
    const print = await runCli(["about", "--cwd", dir]);
    assert.equal(print.stdout, "");
  });
});

test("about-6. about survives add, close, and amend rewrites; an unset store never gains the field", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const a = await runCli(["add", "first-gap", "First", "--cwd", dir]);
    assert.equal(a.code, 0);
    // Unset store: add must not write an about key.
    assert.ok(!("about" in readGaps(dir)), "unset store gained an about field");
    await runCli(["about", "AI plugin to help agents with long term goals", "--cwd", dir]);
    const id1 = a.stdout.trim();
    const b = await runCli(["add", "second-gap", "Second", "--cwd", dir]);
    assert.equal(b.code, 0);
    assert.equal(readGaps(dir).about, "AI plugin to help agents with long term goals");
    const m = await runCli(["amend", id1, "Reworded", "--cwd", dir]);
    assert.equal(m.code, 0, `stderr: ${m.stderr}`);
    assert.equal(readGaps(dir).about, "AI plugin to help agents with long term goals");
    const c = await runCli(["close", id1, "--cwd", dir]);
    assert.equal(c.code, 0, `stderr: ${c.stderr}`);
    const state = readGaps(dir);
    assert.equal(state.about, "AI plugin to help agents with long term goals");
    assert.deepEqual(state.gaps.map((g) => g.text), ["Second"]);
  });
});

test("about-7. non-string about in gaps.json: exit 7 naming the file, store untouched", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    const raw = '{"version":1,"revision":1,"about":42,"gaps":[]}';
    writeFileSync(join(dir, ".horizon", "gaps.json"), raw + "\n");
    const r = await runCli(["about", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /gaps\.json/);
    assert.match(r.stderr, /about is not a string/);
    const s = await runCli(["show", "--cwd", dir]);
    assert.equal(s.code, 7);
    assert.equal(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8"), raw + "\n");
  });
});

// --- per-gap details (optional extended context, HL gap-details) ---

test("detail-1. add --detail stores details; human show is unchanged; show --json carries the field", async () => {
  await withDir(async (dir) => {
    const a = await runCli(["add", "one-line-want", "One-line want", "--detail", "Origin: the user's complaint about X.\nWhy: it costs an hour a week.", "--cwd", dir]);
    assert.equal(a.code, 0, `stderr: ${a.stderr}`);
    const id = a.stdout.trim();
    // Human show output unchanged: exactly one `id␣␣text` line per gap, no details.
    const s = await runCli(["show", "--cwd", dir]);
    assert.equal(s.code, 0);
    assert.equal(s.stdout, `${id}  One-line want\n`);
    // --json gains the details field (present when set).
    const j = await runCli(["show", "--cwd", dir, "--json"]);
    assert.equal(j.code, 0);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed[0].details, "Origin: the user's complaint about X.\nWhy: it costs an hour a week.");
  });
});

test("detail-2. a plain add writes no details field; show --json omits it", async () => {
  await withDir(async (dir) => {
    await runCli(["add", "no-details", "No details here", "--cwd", dir]);
    const gap = JSON.parse((await runCli(["show", "--cwd", dir, "--json"])).stdout)[0];
    assert.ok(!("details" in gap), "unset details must be absent, not null");
  });
});

test("detail-3. detail <id> prints the stored details verbatim, multi-line included", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const id = (await runCli(["add", "want", "Want", "--detail", "line one\nline two", "--cwd", dir])).stdout.trim();
    const r = await runCli(["detail", id, "--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout, "line one\nline two\n");
  });
});

test("detail-4. detail <id> with no stored details prints the explicit no-details message, exit 0 — never silence", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const id = (await runCli(["add", "bare-gap", "Bare gap", "--cwd", dir])).stdout.trim();
    const r = await runCli(["detail", id, "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^no details for bare-gap\n$/);
  });
});

test("detail-5. detail <id> \"<text>\" sets and rewrites; each write bumps revision; title and id untouched", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const id = (await runCli(["add", "want", "Want", "--cwd", dir])).stdout.trim();
    const r1 = await runCli(["detail", id, "First context", "--cwd", dir]);
    assert.equal(r1.code, 0, `stderr: ${r1.stderr}`);
    assert.equal(readGaps(dir).gaps[0].details, "First context");
    const rev1 = readGaps(dir).revision;
    const r2 = await runCli(["detail", id, "Second context", "--cwd", dir]);
    assert.equal(r2.code, 0, `stderr: ${r2.stderr}`);
    const state = readGaps(dir);
    assert.equal(state.gaps[0].details, "Second context");
    assert.equal(state.revision, rev1 + 1);
    assert.equal(state.gaps[0].text, "Want");
    assert.equal(state.gaps[0].id, id);
  });
});

test("detail-6. detail <id> --clear removes the field entirely, bumps revision, preserves the title", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const id = (await runCli(["add", "want", "Want", "--detail", "Context", "--cwd", dir])).stdout.trim();
    const before = readGaps(dir).revision;
    const r = await runCli(["detail", id, "--clear", "--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const state = readGaps(dir);
    assert.ok(!("details" in state.gaps[0]), "details must be absent, not null");
    assert.equal(state.gaps[0].text, "Want");
    assert.equal(state.revision, before + 1);
    // Print mode now reports no details.
    const p = await runCli(["detail", id, "--cwd", dir]);
    assert.equal(p.code, 0);
    assert.match(p.stdout, /no details/);
  });
});

test("detail-7. caps and code points: 2048 accepted (astral emoji counted as code points); 2049 rejected with the count; empty and blank rejected; multi-line allowed", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const id = (await runCli(["add", "want", "Want", "--cwd", dir])).stdout.trim();
    const over = await runCli(["detail", id, "x".repeat(2049), "--cwd", dir]);
    assert.equal(over.code, 3);
    assert.match(over.stderr, /gap details are 2049 code points; the limit is 2048\. Not saved\./);
    assert.ok(!("details" in readGaps(dir).gaps[0]), "a rejected write must not create the field");
    assert.equal((await runCli(["detail", id, "x".repeat(2048), "--cwd", dir])).code, 0);
    assert.equal((await runCli(["detail", id, "🐟".repeat(2048), "--cwd", dir])).code, 0, `astral code points miscounted: stderr`);
    const emojiOver = await runCli(["detail", id, "🐟".repeat(2049), "--cwd", dir]);
    assert.equal(emojiOver.code, 3);
    assert.match(emojiOver.stderr, /2049/);
    const nl = await runCli(["detail", id, "a\nb", "--cwd", dir]);
    assert.equal(nl.code, 0, "multi-line details must be allowed");
    assert.equal((await runCli(["detail", id, "", "--cwd", dir])).code, 3);
    assert.equal((await runCli(["detail", id, "   ", "--cwd", dir])).code, 3);
  });
});

test("detail-8. unknown id: exit 5 (no store, store without the id, set and print modes); invalid id: exit 5, named as invalid; usage errors: exit 2", async () => {
  await withDir(async (dir) => {
    // No store anywhere: the id cannot exist, same exit as close/amend.
    assert.equal((await runCli(["detail", "no-such-gap", "--cwd", dir])).code, 5);
    await runCli(["init", "--cwd", dir]);
    const bad = await runCli(["detail", "no-such-gap", "--cwd", dir]);
    assert.equal(bad.code, 5);
    assert.match(bad.stderr, /no-such-gap/);
    // An id off the slug grammar is named as invalid — the same split
    // close/amend apply (acceptance 17b, D7).
    const invalid = await runCli(["detail", "g_deadbeef", "--cwd", dir]);
    assert.equal(invalid.code, 5);
    assert.match(invalid.stderr, /invalid gap id/);
    assert.match(invalid.stderr, /g_deadbeef/);
    assert.equal((await runCli(["detail", "--cwd", dir])).code, 2);
    await runCli(["add", "want", "Want", "--detail", "C", "--cwd", dir]);
    assert.equal((await runCli(["detail", "no-such-gap", "text", "--cwd", dir])).code, 5);
    const invalidSet = await runCli(["detail", "g_deadbeef", "text", "--cwd", dir]);
    assert.equal(invalidSet.code, 5);
    assert.match(invalidSet.stderr, /invalid gap id/);
    const id = readGaps(dir).gaps[0].id;
    assert.equal((await runCli(["detail", id, "text", "--clear", "--cwd", dir])).code, 2);
    assert.equal((await runCli(["detail", id, "one", "two", "--cwd", dir])).code, 2);
  });
});

test("detail-9. add --detail validation: over-cap details reject the whole add (exit 3, no gap created); empty details reject; a bad title still wins", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const over = await runCli(["add", "want", "Want", "--detail", "x".repeat(2049), "--cwd", dir]);
    assert.equal(over.code, 3);
    assert.match(over.stderr, /2049/);
    assert.equal(readGaps(dir).gaps.length, 0, "no gap may be created");
    assert.equal((await runCli(["add", "want", "Want", "--detail", "", "--cwd", dir])).code, 3);
    assert.equal(readGaps(dir).gaps.length, 0);
    assert.equal((await runCli(["add", "want", "", "--detail", "fine", "--cwd", dir])).code, 3);
    const ok = await runCli(["add", "want", "Want", "--detail", "fine", "--cwd", dir]);
    assert.equal(ok.code, 0, `stderr: ${ok.stderr}`);
  });
});

test("detail-10. amend stays title-only: details survive amend; amend takes no details argument", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const id = (await runCli(["add", "original", "Original", "--detail", "Keep me", "--cwd", dir])).stdout.trim();
    const m = await runCli(["amend", id, "Reworded", "--cwd", dir]);
    assert.equal(m.code, 0);
    const gap = readGaps(dir).gaps[0];
    assert.equal(gap.text, "Reworded");
    assert.equal(gap.details, "Keep me");
    // Three positionals is still a usage error: amend has no details form.
    assert.equal((await runCli(["amend", id, "Reworded", "extra", "--cwd", dir])).code, 2);
  });
});

test("detail-11. details survive whole-file rewrites (close of another gap, about set)", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const a = (await runCli(["add", "first", "First", "--detail", "First context", "--cwd", dir])).stdout.trim();
    const b = (await runCli(["add", "second", "Second", "--cwd", dir])).stdout.trim();
    await runCli(["close", b, "--cwd", dir]);
    await runCli(["about", "About line", "--cwd", dir]);
    const state = readGaps(dir);
    assert.equal(state.gaps.length, 1);
    assert.equal(state.gaps[0].id, a);
    assert.equal(state.gaps[0].details, "First context");
    assert.equal(state.about, "About line");
  });
});

test("detail-12. non-string details in gaps.json: exit 7 naming the file, store untouched", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    const raw = '{"version":1,"revision":1,"gaps":[{"id":"gap-1","text":"T","details":42,"added_at":"2026-09-08T15:00:11Z","provenance":{}}]}';
    writeFileSync(join(dir, ".horizon", "gaps.json"), raw + "\n");
    const r = await runCli(["show", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /gaps\.json/);
    assert.match(r.stderr, /details is not a string/);
    assert.equal(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8"), raw + "\n");
  });
});

test("detail-13. a rejected detail write does not bump revision", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const id = (await runCli(["add", "want", "Want", "--detail", "C", "--cwd", dir])).stdout.trim();
    const before = readGaps(dir).revision;
    assert.equal((await runCli(["detail", id, "x".repeat(2049), "--cwd", dir])).code, 3);
    assert.equal(readGaps(dir).revision, before);
  });
});

test("detail-14. detail changes log nothing (amend's treatment): no sessions.jsonl or closes.jsonl entries", async () => {
  await withDir(async (dir) => {
    await runCli(["init", "--cwd", dir]);
    const id = (await runCli(["add", "want", "Want", "--cwd", dir])).stdout.trim();
    await runCli(["detail", id, "C", "--cwd", dir]);
    await runCli(["detail", id, "--clear", "--cwd", dir]);
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(join(dir, ".horizon", "sessions.jsonl")), "detail writes must not append session records");
    assert.ok(!existsSync(join(dir, ".horizon", "closes.jsonl")), "detail writes must not append close records");
  });
});

test("detail-15. help lists the detail verb", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /detail <id>/);
});

// The sink seam, pinned where it landed: main() reports through the handed-in
// writers and the return value IS the exit code — the whole contract the
// harness and the bins share, and the reason the bins stayed byte-identical
// while the suite moved in-process.
test("sink-1. main writes through the handed-in sink and returns the code; the fail paths report through it too", async () => {
  await withDir(async (dir) => {
    const out = [];
    const err = [];
    const sink = {
      stdout: (s) => { out.push(s); return true; },
      stderr: (s) => { err.push(s); return true; },
    };
    assert.equal(await main(["add", "sink-gap", "Sink gap", "--cwd", dir], sink), 0);
    assert.equal(out.join(""), "sink-gap\n");
    assert.equal(err.join(""), "");
    assert.equal(await main(["close", "no-such-gap", "--cwd", dir], sink), 5);
    assert.ok(err.join("").includes("no-such-gap"), "the failure must reach the sink's stderr");
    assert.equal(out.join(""), "sink-gap\n", "a failed round must not add stdout");
    assert.equal(await main(["no-such-command"], sink), 2);
    assert.ok(err.join("").includes("unknown command"));
  });
});
