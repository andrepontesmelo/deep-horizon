import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// --- Atomicity / concurrency (21-25, spec section 9 as amended by 297dc95) ---

test("21. no reader ever sees a partial document: 200 reads concurrent with a writer all parse", async () => {
  // temp+fsync+rename property: gaps.json is only ever replaced by a
  // whole-file rename, so a reader mid-write sees either the old or the new
  // document, never a torn one.
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const added = await run(["add", "Seed", "--cwd", dir]);
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("22. no .tmp remains after a successful write; a SIGKILLed writer's tmp does not block; sweep by mtime", async () => {
  const { spawn } = await import("node:child_process");
  const { readdirSync, utimesSync, existsSync } = await import("node:fs");
  const { setTimeout: delay } = await import("node:timers/promises");
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    assert.equal((await run(["add", "Seed", "--cwd", dir])).code, 0);
    // (a) successful write leaves no .tmp behind
    assert.equal((await run(["add", "Tidy", "--cwd", dir])).code, 0);
    assert.deepEqual(readdirSync(join(dir, ".horizon")).filter((n) => n.includes(".tmp")), []);
    // (b) a stray tmp (as a SIGKILLed writer strands) does not block the next write
    const stray = join(dir, ".horizon", `.gaps.json.tmp.999999`);
    writeFileSync(stray, "{}\n");
    const r = await run(["add", "After stray tmp", "--cwd", dir]);
    assert.equal(r.code, 0, `stray tmp blocked the write: ${r.stderr}`);
    assert.equal(readGaps(dir).gaps.length, 3);
    // (c) a stray tmp backdated past TMP_SWEEP_MS is swept by the next store
    // open; a fresh one is kept.
    const past = new Date(Date.now() - 120_000);
    utimesSync(stray, past, past);
    const fresh = join(dir, ".horizon", `.gaps.json.tmp.${process.pid}`);
    writeFileSync(fresh, "in-flight writer\n");
    const s = await run(["show", "--cwd", dir]); // any command through the store sweeps on open
    assert.equal(s.code, 0, `stderr: ${s.stderr}`);
    assert.ok(!existsSync(stray), "backdated tmp not swept");
    assert.ok(existsSync(fresh), "fresh tmp was swept (must be kept)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("23. two concurrent adds: gaps.json parses, gap count 1 or 2 (last-writer-wins)", async () => {
  // The race window between read and rename is microseconds, so 40 rounds
  // with both children spawned simultaneously makes a genuine overlap
  // plausible; the assertion is corruption-freedom, not winner-prediction.
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
      const [a, b] = await Promise.all([startAdd(dir, `alpha ${round}`), startAdd(dir, `beta ${round}`)]);
      // Either exit code is fine (last-writer-wins); no crash, no corruption.
      assert.ok([0, 6].includes(a.code), `round ${round}: a exit ${a.code}: ${a.stderr}`);
      assert.ok([0, 6].includes(b.code), `round ${round}: b exit ${b.code}: ${b.stderr}`);
      const state = readGaps(dir); // throws if the file is corrupt
      assert.ok(state.gaps.length === 1 || state.gaps.length === 2, `round ${round}: ${state.gaps.length} gaps`);
      const texts = new Set(state.gaps.map((g) => g.text));
      // The survivor(s) must be from this round's writes, not a torn document.
      for (const g of state.gaps) assert.ok([`alpha ${round}`, `beta ${round}`].includes(g.text), `round ${round}: alien text ${g.text}`);
      assert.equal(state.gaps.length, texts.size, "duplicate gap texts in store");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("24. rename EPERM retried; later success exits 0; exhaustion exits 6 with file + errno", async () => {
  // HORIZON_CLI_TEST_FAIL_RENAMES=<n>: a test-only hook inside writeGapsFile
  // that fails the first <n> rename attempts with {code:"EPERM"}, then
  // proceeds. Production never sets it.
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    assert.equal((await run(["add", "Seed", "--cwd", dir])).code, 0);
    // (a) fail the first 2 attempts: 10 ms + 50 ms real backoff, then success.
    const t0 = Date.now();
    const r = await run(["add", "Retried", "--cwd", dir], {
      env: { ...process.env, HORIZON_CLI_TEST_FAIL_RENAMES: "2" },
    });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 55, `backoff not real: only ${elapsed} ms elapsed`);
    assert.equal(readGaps(dir).gaps.length, 2);
    assert.ok(readGaps(dir).gaps.some((g) => g.text === "Retried"));
    // (b) hook=99: every attempt fails -> exit 6 naming the file and the errno.
    const r2 = await run(["add", "Doomed", "--cwd", dir], {
      env: { ...process.env, HORIZON_CLI_TEST_FAIL_RENAMES: "99" },
    });
    assert.equal(r2.code, 6, `stdout: ${r2.stdout} stderr: ${r2.stderr}`);
    assert.match(r2.stderr, /gaps\.json/);
    assert.match(r2.stderr, /EPERM/);
    // The failed write left the store intact.
    assert.equal(readGaps(dir).gaps.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
  const SPEC = new URL("../.scratch/deep-horizon/05-cli-contract.md", import.meta.url).pathname;
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

// --- Adversary regression gates (ADV-1..12, fix card t_76f202ea) ---

// ADV-1: a non-object element in gaps[] used to crash every store-touching
// command with a raw TypeError + exit 1. Spec 7: malformed store -> exit 7
// naming the file. (The gap body was already tightened by HL-11's
// envelope hardening; this pins the id/text field types too.)
test("ADV-1. gaps[] containing null: exit 7 naming gaps.json, no crash", async () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(join(dir, ".horizon", "gaps.json"), '{"version":1,"revision":1,"gaps":[null]}');
    const r = await run(["show", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /gaps\.json/);
    assert.ok(!/TypeError|at /m.test(r.stderr), `raw stack leaked: ${r.stderr}`);
    assert.equal(readFileSync(join(dir, ".horizon", "gaps.json"), "utf8"), '{"version":1,"revision":1,"gaps":[null]}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADV-1b. gap with non-string text: exit 7 (no crash, store untouched)", async () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(
      join(dir, ".horizon", "gaps.json"),
      JSON.stringify({ version: 1, revision: 1, gaps: [{ id: "g_00000001", text: 7 }] }) + "\n",
    );
    const r = await run(["show", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /gaps\.json/);
    assert.ok(!/TypeError|at /m.test(r.stderr), `raw stack leaked: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ADV-2: a bare `null` line in a JSONL log used to crash `log` (human) with
// exit 1 and silently pass through `log --json`. A JSONL line whose parse is
// valid JSON but not an object makes the whole file malformed: exit 7.
test("ADV-2. null line in sessions.jsonl: log exits 7; --json never emits a null record", async () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(join(dir, ".horizon", "gaps.json"), JSON.stringify(emptyStore()) + "\n");
    const good = JSON.stringify({ ts: "2026-09-08T15:00:00Z", harness: "t", session_id: "s0", summary: null, gaps_added: [], gaps_closed: [] });
    writeFileSync(join(dir, ".horizon", "sessions.jsonl"), good + "\nnull\n");
    const r = await run(["log", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /sessions\.jsonl/);
    const rj = await run(["log", "--cwd", dir, "--json"]);
    assert.equal(rj.code, 7);
    assert.ok(!/^\s*null\s*$/m.test(rj.stdout), "--json emitted a null record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADV-2b. null line in closes.jsonl: session-end exits 7 naming closes.jsonl", async () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(join(dir, ".horizon", "gaps.json"), JSON.stringify(emptyStore()) + "\n");
    writeFileSync(join(dir, ".horizon", "closes.jsonl"), "null\n");
    const r = await run(["session-end", "--harness", "t", "--session", "s1", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /closes\.jsonl/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADV-2c. syntactically invalid JSONL line: exit 7 (same contract as a null line)", async () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(join(dir, ".horizon", "gaps.json"), JSON.stringify(emptyStore()) + "\n");
    writeFileSync(join(dir, ".horizon", "sessions.jsonl"), "{not json}\n");
    const r = await run(["log", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /sessions\.jsonl/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ADV-3: the close/session record append used to run AFTER the gaps.json
// rename; an append failure then lost the record while the gap was already
// gone (unauditable close, exit 1). Now record-first: append, then rename.
test("ADV-3. append failure at close: exit 7, gap still open, store unchanged", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    const add = await run(["add", "Doomed close", "--cwd", dir]);
    assert.equal(add.code, 0);
    const id = add.stdout.trim();
    // closes.jsonl is created by the first close, so touch it first; an
    // append to a file the process cannot write must then fail.
    const closes = join(dir, ".horizon", "closes.jsonl");
    writeFileSync(closes, "");
    chmodSync(closes, 0o444);
    const r = await run(["close", id, "--cwd", dir]);
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
    await run(["init", "--cwd", dir]);
    await run(["add", "Recorded gap", "--cwd", dir, "--session", "s9"]);
    const sessions = join(dir, ".horizon", "sessions.jsonl");
    await run(["session-end", "--harness", "t", "--session", "s9", "--cwd", dir]);
    chmodSync(sessions, 0o444);
    const r = await run(["session-end", "--harness", "t", "--session", "s9", "--cwd", dir]);
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
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    await run(["add", "Half closed", "--cwd", dir, "--session", "s1"]);
    const store = join(dir, ".horizon");
    const id = readGaps(dir).gaps[0].id;
    writeFileSync(join(store, "closes.jsonl"), JSON.stringify({ ts: "2026-09-08T15:00:00Z", session_id: "s1", gap_id: id, added_session_id: "s1" }) + "\n");
    // Session s2 closes it for real; now two close records exist for the id,
    // one from the orphaned pre-crash append.
    const r = await run(["close", id, "--cwd", dir, "--session", "s2"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const se = await run(["session-end", "--harness", "t", "--session", "s2", "--cwd", dir]);
    assert.equal(se.code, 0, `stderr: ${se.stderr}`);
    const rec = JSON.parse((await run(["log", "--cwd", dir, "--json"])).stdout.trim().split("\n")[0]);
    assert.deepEqual(rec.gaps_closed, [id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ADV-3d: an orphaned close record (crash between the closes.jsonl append and
// the gaps.json rename) is a NO-OP: the session that wrote it must not count
// the gap in gaps_closed while the gap is still open. Only gaps actually
// absent from gaps.json are counted, and only once, by the real closer.
test("ADV-3d. orphan close record while gap still open: that session's gaps_closed is empty", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    await run(["add", "Orphan close", "--cwd", dir, "--session", "s1"]);
    const store = join(dir, ".horizon");
    const id = readGaps(dir).gaps[0].id;
    // Crash simulation: the close record lands while the gap is still open.
    writeFileSync(join(store, "closes.jsonl"), JSON.stringify({ ts: "2026-09-08T15:00:00Z", session_id: "s1", gap_id: id, added_session_id: "s1" }) + "\n");
    const se = await run(["session-end", "--harness", "t", "--session", "s1", "--cwd", dir]);
    assert.equal(se.code, 0, `stderr: ${se.stderr}`);
    const rec = JSON.parse((await run(["log", "--cwd", dir, "--json"])).stdout.trim().split("\n")[0]);
    assert.deepEqual(rec.gaps_closed, []);
    // A real close from another session IS counted, exactly once.
    const r = await run(["close", id, "--cwd", dir, "--session", "s2"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const se2 = await run(["session-end", "--harness", "t", "--session", "s2", "--cwd", dir]);
    assert.equal(se2.code, 0, `stderr: ${se2.stderr}`);
    const rec2 = JSON.parse((await run(["log", "--cwd", dir, "--json"])).stdout.trim().split("\n")[0]);
    assert.deepEqual(rec2.gaps_closed, [id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ADV-4: `.horizon` existing as a REGULAR FILE used to crash init/add with a
// raw ENOTDIR stack, exit 1. Spec 7: unusable store path -> exit 7 naming it.
test("ADV-4. .horizon as a regular file: init and add exit 7 naming the path", async () => {
  const dir = freshDir();
  try {
    writeFileSync(join(dir, ".horizon"), "not a directory\n");
    for (const argv of [["init"], ["add", "X"]]) {
      const r = await run([...argv, "--cwd", dir]);
      assert.equal(r.code, 7, `${argv[0]}: ${r.stderr}`);
      assert.match(r.stderr, /\.horizon/);
      assert.ok(!/at /m.test(r.stderr), `${argv[0]}: raw stack leaked: ${r.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ADV-4b: mkdir EACCES on a NEW store used to crash `add` with a raw stack.
test("ADV-4b. mkdir EACCES on new-store add: exit 7 naming the path, no raw stack", async () => {
  if (process.platform === "win32") return; // POSIX permission model only
  const dir = freshDir();
  try {
    chmodSync(dir, 0o555);
    const r = await run(["add", "No permission", "--cwd", dir]);
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
    const i = await run(["init", "--cwd", dir]);
    assert.equal(i.code, 7, `init stderr: ${i.stderr}`);
    assert.match(i.stderr, /\.horizon/);
    assert.ok(!/at /m.test(i.stderr), `raw stack leaked: ${i.stderr}`);
    const a = await run(["add", "No permission", "--cwd", dir]);
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
    await run(["init", "--cwd", dir]);
    chmodSync(join(dir, ".horizon"), 0o000);
    const r = await run(["show", "--cwd", dir]);
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
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(join(dir, ".horizon", "gaps.json"), JSON.stringify(emptyStore()) + "\n");
    mkdirSync(join(dir, ".horizon", "sessions.jsonl"));
    const r = await run(["log", "--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /sessions\.jsonl/);
    assert.ok(!/at /m.test(r.stderr), `raw stack leaked: ${r.stderr}`);
  } finally {
    rmdirSync(join(dir, ".horizon", "sessions.jsonl"));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADV-6. rename ENOENT after retries: distinct swept-tmp message, exit 6", async () => {
  const dir = freshDir();
  try {
    await run(["init", "--cwd", dir]);
    assert.equal((await run(["add", "Seed", "--cwd", dir])).code, 0);
    // The old message blamed "EPERM" and hid the real cause; a swept tmp is
    // the one deterministic way a rename fails with ENOENT.
    const r = await run(["add", "Vanished", "--cwd", dir], {
      env: { ...process.env, HORIZON_CLI_TEST_FAIL_RENAMES: "99", HORIZON_CLI_TEST_RENAME_ERRNO: "ENOENT" },
    });
    assert.equal(r.code, 6);
    assert.match(r.stderr, /swept/);
    assert.match(r.stderr, /retry the command/);
    assert.equal(readGaps(dir).gaps.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADV-9. help text alignment: command column and --harness naming line up", async () => {
  const r = await run(["--help"]);
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
    const dir = freshDir();
    try {
      await run(["init", "--cwd", dir]);
      const r = await run(["log", "--limit", value, "--cwd", dir]);
      assert.equal(r.code, 2, `--limit ${value} accepted`);
      assert.match(r.stderr, /--limit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("ADV-10. --limit past Number.MAX_SAFE_INTEGER rejected, exit 2", assertValidLimit("99999999999999999999"));
test("ADV-11. --limit leading zeros rejected, exit 2", assertValidLimit("007"));

function emptyStore() {
  return { version: 1, revision: 0, gaps: [] };
}

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
  const dir = freshDir();
  try {
    const r = await run(["init", "--cwd", dir]);
    assert.equal(r.code, 0);
    const ga = join(dir, ".horizon", ".gitattributes");
    const { existsSync } = await import("node:fs");
    assert.ok(existsSync(ga), ".gitattributes missing after init");
    assert.equal(readFileSync(ga, "utf8"), "* -text\n");
    // First add (store created by add, not init) also ships the .gitattributes.
    const dir2 = freshDir();
    try {
      await run(["add", "Ships gitattributes too", "--cwd", dir2]);
      assert.equal(readFileSync(join(dir2, ".horizon", ".gitattributes"), "utf8"), "* -text\n");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
    // JSONL reader: CRLF line endings and blank lines are tolerated.
    await run(["add", "CRLF gap", "--cwd", dir, "--session", "s1"]);
    await run(["session-end", "--harness", "t", "--session", "s1", "--cwd", dir]);
    const sessions = join(dir, ".horizon", "sessions.jsonl");
    const raw = readFileSync(sessions, "utf8");
    writeFileSync(sessions, "\r\n" + raw.trim().split("\n").join("\r\n") + "\r\n\r\n");
    const rec = JSON.parse((await run(["log", "--cwd", dir, "--json"])).stdout.trim().split("\n")[0]);
    assert.equal(rec.harness, "t");
    assert.deepEqual(rec.gaps_added.length >= 1, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("X5. a store directory named .Horizon is discovered (case-insensitive resolution)", async () => {
  const dir = freshDir();
  try {
    const store = join(dir, ".Horizon");
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, "gaps.json"),
      JSON.stringify({ version: 1, revision: 0, gaps: [] }, null, 2) + "\n",
    );
    const r = await run(["add", "Found .Horizon", "--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    // The write landed in the real (case-variant) directory, not a new .horizon.
    const { existsSync, readdirSync } = await import("node:fs");
    assert.ok(existsSync(join(store, ".gitattributes")), ".gitattributes not written to the real store dir");
    assert.deepEqual(readdirSync(dir).filter((n) => n.toLowerCase() === ".horizon"), [".Horizon"]);
    const state = JSON.parse(readFileSync(join(store, "gaps.json"), "utf8"));
    assert.equal(state.gaps.length, 1);
    assert.equal(state.gaps[0].text, "Found .Horizon");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("X6. init writes .horizon/.gitignore (sessions.jsonl, *.tmp.*); gaps.json not ignored", async () => {
  const dir = freshDir();
  try {
    const r = await run(["init", "--cwd", dir]);
    assert.equal(r.code, 0);
    const gi = join(dir, ".horizon", ".gitignore");
    assert.ok(existsSync(gi), ".gitignore missing after init");
    const body = readFileSync(gi, "utf8");
    assert.match(body, /^sessions\.jsonl$/m, "sessions.jsonl entry missing");
    assert.match(body, /^\*\.tmp\.\*$/m, "*.tmp.* entry missing");
    // First add (store created by add, not init) also ships the .gitignore.
    const dir2 = freshDir();
    try {
      await run(["add", "Ships gitignore too", "--cwd", dir2]);
      assert.equal(readFileSync(join(dir2, ".horizon", ".gitignore"), "utf8"), body);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
