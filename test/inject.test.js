import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INJECT_BIN = new URL("../bin/horizon-inject.js", import.meta.url).pathname;
const ADAPTER = new URL("../src/adapters/dsh.ts", import.meta.url).pathname;

function run(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(INJECT_BIN, args, { encoding: "utf8", ...opts }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "horizon-inject-test-"));
}

// Seed a store directly (init-equivalent), mirroring test/cli.test.js seed().
function seed(dir, texts) {
  const store = join(dir, ".horizon");
  mkdirSync(store, { recursive: true });
  const gaps = texts.map((text, i) => ({
    id: `gap-${i + 1}`,
    text,
    added_at: `2026-09-08T15:0${i}:11Z`,
    provenance: { harness: "test", session_id: "seed", tty: false, origin: "human" },
  }));
  writeFileSync(join(store, "gaps.json"), JSON.stringify({ version: 1, revision: gaps.length, gaps }, null, 2) + "\n");
  return gaps;
}

// Extract the inside of a fenced block that follows `heading` in the spec.
function specFence(specLines, heading) {
  const h = specLines.findIndex((l) => l.startsWith(heading));
  assert.notEqual(h, -1, `missing ${heading} in spec`);
  const open = specLines.findIndex((l, i) => i > h && l === "```");
  const close = specLines.findIndex((l, i) => i > open && l === "```");
  assert.ok(open > h && close > open, `unclosed fence after ${heading}`);
  return specLines.slice(open + 1, close).join("\n");
}

// --- horizon-inject: composition (spec 10, D6) ---

test("35. inject prints the horizon block, gaps substituted verbatim, byte-for-byte against the spec", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["A person can hand a photo to the app and get the plant named.", "Rentals can be compared across sites without re-entering filters."]);
    const r = await run(["--cwd", dir]);
    assert.equal(r.code, 0);
    const spec = readFileSync(new URL("../.scratch/deep-horizon/05-cli-contract.md", import.meta.url), "utf8").split("\n");
    const show = "gap-1  A person can hand a photo to the app and get the plant named.\ngap-2  Rentals can be compared across sites without re-entering filters.\n";
    const expected = specFence(spec, "### 10.1").replace("{{GAPS}}", show);
    assert.equal(r.stdout, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("36. inject prints the bootstrap nudge, exactly, on an absent store; on an empty store; never two variants, never none", async () => {
  const spec = readFileSync(new URL("../.scratch/deep-horizon/05-cli-contract.md", import.meta.url), "utf8").split("\n");
  const bootstrap = specFence(spec, "### 10.2");
  const absent = freshDir();
  try {
    const r1 = await run(["--cwd", absent]);
    assert.equal(r1.code, 0);
    assert.equal(r1.stdout, bootstrap);
    const empty = freshDir();
    try {
      seed(empty, []);
      const r2 = await run(["--cwd", empty]);
      assert.equal(r2.code, 0);
      assert.equal(r2.stdout, bootstrap);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(absent, { recursive: true, force: true });
  }
});

// A storeless $HOME must not be offered horizon-ization; the decision is a
// pure export so tests can pass a fake home and never touch the real one.
test("home-suppress-1. the bootstrap-silence decision: storeless $HOME silences, storeless elsewhere nudges, a found store never suppresses", async () => {
  const { suppressBootstrap } = await import(new URL("../src/store.ts", import.meta.url).pathname);
  const home = "/home/fake-user";
  assert.equal(suppressBootstrap({ cwd: home, storeFound: false, home }), true, "storeless home must be suppressed");
  assert.equal(suppressBootstrap({ cwd: `${home}/.`, storeFound: false, home }), true, "a non-canonical spelling of home must be suppressed");
  assert.equal(suppressBootstrap({ cwd: "/tmp/some-project", storeFound: false, home }), false, "storeless non-home must still nudge");
  assert.equal(suppressBootstrap({ cwd: `${home}/git/repo`, storeFound: false, home }), false, "a storeless subdir of home must still nudge");
  assert.equal(suppressBootstrap({ cwd: home, storeFound: true, home }), false, "a visible store — even at home — must never be suppressed");
});

test("home-suppress-2. end-to-end: the bin silences a storeless $HOME (exit 0, empty stdout) and keeps a deliberate home store", async () => {
  // os.homedir() honours $HOME on POSIX, so a fake home keeps this
  // deterministic regardless of the real ~/.horizon.
  const fakeHome = mkdtempSync(join(tmpdir(), "horizon-fake-home-"));
  try {
    const env = { ...process.env, HOME: fakeHome };
    const r1 = await run(["--cwd", fakeHome], { env });
    assert.equal(r1.code, 0);
    assert.equal(r1.stdout, "", "the storeless-home bootstrap misfire must be silent");
    const proj = join(fakeHome, "git", "proj");
    mkdirSync(proj, { recursive: true });
    const r2 = await run(["--cwd", proj], { env });
    assert.equal(r2.code, 0);
    assert.ok(r2.stdout.startsWith("This project has no horizon yet"), "a storeless project still gets its nudge");
    seed(fakeHome, ["Deliberate home store gap"]);
    const r3 = await run(["--cwd", fakeHome], { env });
    assert.equal(r3.code, 0);
    assert.ok(r3.stdout.includes("Deliberate home store gap"), "a deliberate home-level store keeps injecting");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("37. inject has a --json mode: {\"text\":<string>} on stdout, nothing else", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["Only one gap"]);
    const r = await run(["--cwd", dir, "--json"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(typeof parsed.text, "string");
    assert.ok(parsed.text.startsWith("This project has a horizon"));
    assert.ok(parsed.text.includes("gap-1  Only one gap"));
    assert.equal(JSON.stringify(parsed), JSON.stringify({ text: parsed.text }));
    assert.ok(!r.stderr, "stderr must stay empty on success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("38. inject makes no store writes: read-only dirs and read-only files still inject", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["Read-only world"]);
    const store = join(dir, ".horizon");
    for (const name of readdirSync(store)) {
      writeFileSync(join(store, name), readFileSync(join(store, name), "utf8"), { mode: 0o444 });
    }
    const before = readdirSync(store).sort().join(",");
    const r = await run(["--cwd", dir]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("Read-only world"));
    assert.equal(readdirSync(store).sort().join(","), before, "store directory listing changed");
    const empty = freshDir();
    try {
      const emptyStore = join(empty, ".horizon");
      mkdirSync(emptyStore, { recursive: true });
      writeFileSync(join(emptyStore, "gaps.json"), JSON.stringify({ version: 1, revision: 0, gaps: [] }, null, 2) + "\n");
      for (const name of readdirSync(emptyStore)) {
        writeFileSync(join(emptyStore, name), readFileSync(join(emptyStore, name), "utf8"), { mode: 0o444 });
      }
      const beforeEmpty = readdirSync(emptyStore).sort().join(",");
      const r2 = await run(["--cwd", empty]);
      assert.equal(r2.code, 0);
      assert.ok(r2.stdout.startsWith("This project has no horizon yet"));
      assert.equal(readdirSync(emptyStore).sort().join(","), beforeEmpty, "store directory listing changed");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- horizon-inject: edge behaviour ---

test("39. malformed gaps.json: inject exits 7 naming the file and prints no text", async () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".horizon"), { recursive: true });
    writeFileSync(join(dir, ".horizon", "gaps.json"), '{"version":1,"revision":1,"gaps":[null]}');
    const r = await run(["--cwd", dir]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /gaps\.json/);
    assert.ok(!/TypeError|at /m.test(r.stderr), `raw stack leaked: ${r.stderr}`);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("40. inject supports the CLI's global options (help/version, --harness/--session/--origin accepted and ignored)", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["Global options gap"]);
    const help = await run(["--help"]);
    assert.equal(help.code, 0);
    assert.ok(help.stdout.includes("horizon-inject"));
    const version = await run(["--version"]);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^horizon-inject \d+\.\d+\.\d+/);
    const r = await run(["--cwd", dir, "--harness", "dsh", "--session", "abc", "--origin", "human"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("Global options gap"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- The DSH adapter (glue only) ---

test("41. the DSH adapter registers agent/session-start and spawns the bins (no text composition)", async () => {
  const calls = [];
  const agent = {
    session: { header: { cwd: "/somewhere", delegationDepth: 0, origin: "user" } },
    inject(message) { calls.push({ kind: "inject", message }); },
    steer(message) { calls.push({ kind: "steer", message }); },
  };
  const mod = await import(ADAPTER);
  const registered2 = {};
  const registered = mod.apply({
    on(name, handler) { registered2[name] = handler; },
  }, {
    spawnBin: (bin, args) => {
      calls.push({ kind: "spawn", bin, args });
      if (bin === "horizon-inject") return { status: 0, stdout: "MOCK-INJECTED-TEXT", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(registered["agent/session-start"], "apply() must return an agent/session-start handler");
  assert.ok(registered2["agent/session-start"], "apply() must also register agent/session-start on the ctx");
  assert.ok(registered2["agent/turn-stopping"], "apply() must register agent/turn-stopping on the ctx");
  await registered["agent/session-start"]({ agent, source: "startup" });
  const injectSpawn = calls.find((c) => c.kind === "spawn" && c.bin === "horizon-inject");
  assert.ok(injectSpawn, "horizon-inject must be spawned");
  assert.ok(injectSpawn.args.includes("dsh"), "--harness dsh must be passed");
  const injected = calls.find((c) => c.kind === "inject");
  assert.ok(injected, "the bin output must reach agent.inject");
  assert.equal(injected.message.content[0].text, "MOCK-INJECTED-TEXT");
  assert.equal(injected.message.role, "user");
  assert.ok(injected.message.source, "the injected message must carry a source");
});

test("42. the DSH adapter guards: only source==='startup', never subagents (depth or origin), no cwd is a no-op", async () => {
  const mod = await import(ADAPTER);
  async function scenario(agent, source) {
    const calls = [];
    const registered = mod.apply({}, {
      spawnBin: (bin) => { calls.push({ bin }); return { status: 0, stdout: "X", stderr: "" }; },
      findBin: (b) => b,
    });
    await registered["agent/session-start"]({ agent, source });
    return calls;
  }
  const base = { cwd: "/somewhere" };
  assert.deepEqual(await scenario({ session: { header: { ...base, delegationDepth: 0, origin: "user" } } }, "startup").then((c) => c.map((x) => x.bin)), ["horizon-inject"]);
  for (const [label, agent, source] of [
    ["resume source", { session: { header: { ...base, delegationDepth: 0, origin: "user" } } }, "resume"],
    ["compact source", { session: { header: { ...base, delegationDepth: 0, origin: "user" } } }, "compact"],
    ["depth 1", { session: { header: { ...base, delegationDepth: 1, origin: "user" } } }, "startup"],
    ["depth 3", { session: { header: { ...base, delegationDepth: 3, origin: "user" } } }, "startup"],
    ["subagent origin", { session: { header: { ...base, delegationDepth: 0, origin: "subagent" } } }, "startup"],
    ["missing header", {}, "startup"],
    ["missing agent", undefined, "startup"],
    ["missing cwd", { session: { header: { delegationDepth: 0, origin: "user" } } }, "startup"],
  ]) {
    const calls = await scenario(agent, source);
    assert.deepEqual(calls.map((x) => x.bin), [], `guard must fire for: ${label}`);
  }
});

test("43. horizon-inject unresolved: the DSH adapter injects nothing and the session proceeds", async () => {
  const mod = await import(ADAPTER);
  const calls = [];
  const registered = mod.apply({}, {
    spawnBin: () => { throw new Error("spawnSync horizon-inject ENOENT"); },
    findBin: (b) => b,
  });
  await assert.doesNotReject(registered["agent/session-start"]({
    agent: {
      session: { header: { cwd: "/somewhere", delegationDepth: 0, origin: "user" } },
      inject: () => calls.push("inject"),
      steer: () => calls.push("steer"),
    },
    source: "startup",
  }));
  assert.deepEqual(calls, []);
});

test("44. horizon-inject nonzero exit: nothing injected", async () => {
  const mod = await import(ADAPTER);
  const calls = [];
  const registered = mod.apply({}, {
    spawnBin: () => ({ status: 7, stdout: "", stderr: "horizon: malformed gaps.json: ..." }),
    findBin: (b) => b,
  });
  await assert.doesNotReject(registered["agent/session-start"]({
    agent: {
      session: { header: { cwd: "/somewhere", delegationDepth: 0, origin: "user" } },
      inject: () => calls.push("inject"),
      steer: () => calls.push("steer"),
    },
    source: "startup",
  }));
  assert.deepEqual(calls, []);
});

// A harness may re-fire agent/session-start with source "startup" for the
// same agent; the block must land once. A fail-open miss (nonzero exit,
// spawn throw, empty stdout) seeds nothing, so the re-fire can still deliver.
test("dsh-seed-once. a re-fired agent/session-start for the same agent injects once; a fail-open miss stays retryable", async () => {
  const mod = await import(ADAPTER);
  const calls = [];
  const header = { cwd: "/somewhere", delegationDepth: 0, origin: "user" };
  const agent = {
    session: { header },
    inject() { calls.push("inject"); },
    steer() {},
  };
  let spawns = 0;
  const registered = mod.apply({}, {
    spawnBin: () => { spawns += 1; return { status: 0, stdout: "MOCK-SEED", stderr: "" }; },
  });
  await registered["agent/session-start"]({ agent, source: "startup" });
  await registered["agent/session-start"]({ agent, source: "startup" });
  assert.equal(spawns, 1, "the re-fired startup must not spawn again");
  assert.deepEqual(calls, ["inject"], "the re-fired startup must not inject again");
  // A distinct agent object seeds independently.
  await registered["agent/session-start"]({
    agent: { session: { header }, inject() { calls.push("inject-2"); }, steer() {} },
    source: "startup",
  });
  assert.deepEqual(calls, ["inject", "inject-2"]);
  let fail = true;
  const retry = { session: { header }, inject() { calls.push("inject-3"); }, steer() {} };
  const registered2 = mod.apply({}, {
    spawnBin: () => {
      const r = fail ? { status: 7, stdout: "", stderr: "boom" } : { status: 0, stdout: "Y", stderr: "" };
      fail = false;
      return r;
    },
  });
  await registered2["agent/session-start"]({ agent: retry, source: "startup" });
  await registered2["agent/session-start"]({ agent: retry, source: "startup" });
  assert.deepEqual(calls, ["inject", "inject-2", "inject-3"], "the re-fire after a failed delivery must deliver");
});

// --- The DSH param trigger (tools/pre-execute, HL-23) ---

// Shared fixture: a top-level agent plus an apply() whose spawnBin records
// and returns fixed text, so composition never leaves the test.
function paramFixture(spawnStdout, header = { cwd: "/launched-elsewhere", delegationDepth: 0, origin: "user" }) {
  const calls = [];
  const spawned = [];
  const agent = {
    session: { header },
    inject(message) { calls.push({ kind: "inject", message }); },
    steer() {},
  };
  return {
    agent,
    calls,
    spawned,
    spawnBin: (bin, args) => {
      spawned.push({ bin, args });
      return { status: 0, stdout: typeof spawnStdout === "function" ? spawnStdout(args) : spawnStdout, stderr: "" };
    },
  };
}

// The harness hands the adapter deep-frozen parsed arguments; mirror that.
function frozen(x) {
  const clone = structuredClone(x);
  (function deep(o) {
    if (o && typeof o === "object") {
      for (const v of Object.values(o)) deep(v);
      Object.freeze(o);
    }
  })(clone);
  return clone;
}

test("dsh-param-1. a bash touch of a stored repo queues its horizon once, and the gate is never vetoed", async () => {
  const repo = freshDir();
  try {
    seed(repo, ["Param trigger gap"]);
    const mod = await import(ADAPTER);
    const fx = paramFixture("MOCK-PARAM-HORIZON");
    const registered = mod.apply({}, fx);
    let nextCalls = 0;
    const gate = await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `git -C ${repo} status && cat ${repo}/README.md` }), agent: fx.agent },
      () => { nextCalls += 1; return { kind: "allow" }; },
    );
    assert.deepEqual(gate, { kind: "allow" }, "the handler must return next()'s result, never a veto");
    assert.equal(nextCalls, 1, "next() must be called exactly once");
    assert.deepEqual(fx.spawned, [{ bin: "horizon-inject", args: ["--harness", "dsh", "--cwd", repo] }]);
    assert.equal(fx.calls.length, 1, "exactly one inject");
    assert.equal(fx.calls[0].message.content[0].text, "MOCK-PARAM-HORIZON");
    assert.equal(fx.calls[0].message.role, "user");
    // The same tool call again: once per store per session, never twice.
    await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `git -C ${repo} log --oneline` }), agent: fx.agent },
      () => ({ kind: "allow" }),
    );
    assert.equal(fx.spawned.length, 1, "the same store must not spawn twice");
    assert.equal(fx.calls.length, 1, "the same store must not inject twice");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dsh-param-2. a different stored repo touched mid-session gets its own horizon (file_path walks up)", async () => {
  const repoA = freshDir();
  const repoB = freshDir();
  try {
    seed(repoA, ["Repo A gap"]);
    seed(repoB, ["Repo B gap"]);
    mkdirSync(join(repoB, "sub"), { recursive: true });
    const mod = await import(ADAPTER);
    const fx = paramFixture((args) => `MOCK:${args[args.indexOf("--cwd") + 1]}`);
    const registered = mod.apply({}, fx);
    await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `git -C ${repoA} status` }), agent: fx.agent },
      () => ({ kind: "allow" }),
    );
    // A file_path whose directory has no store still resolves the nearest
    // ancestor store, exactly like the bin resolves --cwd.
    await registered["tools/pre-execute"](
      { name: "str_replace_editor", arguments: frozen({ file_path: join(repoB, "sub", "file.txt") }), agent: fx.agent },
      () => ({ kind: "allow" }),
    );
    assert.deepEqual(fx.spawned.map((s) => s.args[3]), [repoA, join(repoB, "sub")], "each touch spawns once; --cwd is the touched dir and the bin resolves the store itself");
    assert.deepEqual(fx.calls.map((c) => c.message.content[0].text), [`MOCK:${repoA}`, `MOCK:${join(repoB, "sub")}`]);
  } finally {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});

test("dsh-param-3. a storeless target never fires — no spawn, no inject, no bootstrap", async () => {
  const bare = freshDir();
  try {
    const mod = await import(ADAPTER);
    const fx = paramFixture("MOCK-SHOULD-NOT-APPEAR");
    const registered = mod.apply({}, fx);
    const gate = await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `ls ${bare} && cd ${bare}/deeper`, workdir: bare }), agent: fx.agent },
      () => ({ kind: "allow" }),
    );
    assert.deepEqual(gate, { kind: "allow" });
    assert.deepEqual(fx.spawned, [], "a storeless target must not spawn");
    assert.deepEqual(fx.calls, [], "a storeless target must not inject");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("dsh-param-4. subagent sessions never fire the param trigger", async () => {
  const repo = freshDir();
  try {
    seed(repo, ["Subagent gap"]);
    const mod = await import(ADAPTER);
    for (const header of [
      { cwd: "/x", delegationDepth: 0, origin: "subagent" },
      { cwd: "/x", delegationDepth: 1, origin: "user" },
      { cwd: "/x", delegationDepth: 3, origin: "subagent" },
    ]) {
      const fx = paramFixture("MOCK-SUBAGENT");
      const registered = mod.apply({}, fx);
      let nextCalls = 0;
      const gate = await registered["tools/pre-execute"](
        { name: "bash", arguments: frozen({ command: `git -C ${repo} status` }), agent: { session: { header }, inject() {} } },
        () => { nextCalls += 1; return { kind: "allow" }; },
      );
      assert.deepEqual(gate, { kind: "allow" }, `the subagent skip must still return next()'s allow gate for ${JSON.stringify(header)}`);
      assert.equal(nextCalls, 1, `next() must run exactly once on the subagent path for ${JSON.stringify(header)}`);
      assert.deepEqual(fx.spawned, [], `subagent must not spawn for ${JSON.stringify(header)}`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dsh-param-5. malformed or empty arguments: no throw, no inject, gate still passes", async () => {
  const repo = freshDir();
  try {
    seed(repo, ["Malformed gap"]);
    const mod = await import(ADAPTER);
    for (const args of [undefined, "not json at all", {}, [], frozen({ command: 42 }), frozen({ path: null })]) {
      const fx = paramFixture("MOCK-MALFORMED");
      const registered = mod.apply({}, fx);
      await assert.doesNotReject(registered["tools/pre-execute"](
        { name: "bash", arguments: args, agent: fx.agent },
        () => ({ kind: "allow" }),
      ));
      assert.deepEqual(fx.spawned, [], `no spawn for arguments ${JSON.stringify(args)}`);
      assert.deepEqual(fx.calls, [], `no inject for arguments ${JSON.stringify(args)}`);
    }
    // An unparseable-JSON call must still be able to touch a store through
    // another field, but a broken command string alone must not throw.
    const fx = paramFixture("MOCK-OK");
    const registered = mod.apply({}, fx);
    const gate = await registered["tools/pre-execute"](
      { name: "bash", arguments: "git -C TOTAL-GARBAGE", agent: fx.agent },
      () => ({ kind: "allow" }),
    );
    assert.deepEqual(gate, { kind: "allow" }, "a raw-string arguments payload must not block the call");
    assert.deepEqual(fx.calls, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dsh-param-6. the store the startup injection served is not re-injected by the param path", async () => {
  const repo = freshDir();
  try {
    seed(repo, ["Startup gap"]);
    const mod = await import(ADAPTER);
    const fx = paramFixture("MOCK-STARTUP", { cwd: repo, delegationDepth: 0, origin: "user" });
    const registered = mod.apply({}, fx);
    await registered["agent/session-start"]({ agent: fx.agent, source: "startup" });
    assert.equal(fx.calls.length, 1, "startup injects once");
    await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `git -C ${repo} status` }), agent: fx.agent },
      () => ({ kind: "allow" }),
    );
    assert.equal(fx.spawned.length, 1, "the param path must not re-spawn for the launch repo");
    assert.equal(fx.calls.length, 1, "the param path must not re-inject the launch repo");
    // A different repo still fires after the startup one was served.
    const other = freshDir();
    try {
      seed(other, ["Other gap"]);
      await registered["tools/pre-execute"](
        { name: "bash", arguments: frozen({ command: `git -C ${other} status` }), agent: fx.agent },
        () => ({ kind: "allow" }),
      );
      assert.equal(fx.spawned.length, 2);
      assert.equal(fx.calls.length, 2);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dsh-param-7. end-to-end: the param trigger composes through the real bins", async () => {
  const repo = freshDir();
  try {
    seed(repo, ["Param e2e gap"]);
    const mod = await import(ADAPTER);
    const registered = mod.apply({ on() {} });
    const injected = [];
    const gate = await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `git -C ${repo} status --short` }), agent: { session: { header: { cwd: "/launched-elsewhere", delegationDepth: 0, origin: "user" } }, inject(m) { injected.push(m); } } },
      () => ({ kind: "allow" }),
    );
    assert.deepEqual(gate, { kind: "allow" });
    assert.equal(injected.length, 1);
    const text = injected[0].content[0].text;
    assert.ok(text.startsWith("This project has a horizon"), `got: ${text.slice(0, 80)}`);
    assert.ok(text.includes("g_00000001  Param e2e gap"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Degenerate exec shapes sit on the same veto trap as subagents: a listener
// that returns without next() denies the tool call outright, so the missing
// and non-injectable agent cases must pass the gate through too.
test("dsh-param-8. no agent, or inject not a function: the gate still allows, nothing spawns", async () => {
  const repo = freshDir();
  try {
    seed(repo, ["Degenerate agent gap"]);
    const mod = await import(ADAPTER);
    const header = { cwd: "/x", delegationDepth: 0, origin: "user" };
    const cases = [
      { label: "agent missing entirely", exec: { name: "bash", arguments: frozen({ command: `git -C ${repo} status` }) } },
      { label: "inject not a function", exec: { name: "bash", arguments: frozen({ command: `git -C ${repo} status` }), agent: { session: { header }, inject: "not-a-function" } } },
    ];
    for (const { label, exec } of cases) {
      const fx = paramFixture("MOCK-DEGENERATE");
      const registered = mod.apply({}, fx);
      let nextCalls = 0;
      const gate = await registered["tools/pre-execute"](exec, () => { nextCalls += 1; return { kind: "allow" }; });
      assert.deepEqual(gate, { kind: "allow" }, `${label}: the returned gate must be next()'s allow, never a veto`);
      assert.equal(nextCalls, 1, `${label}: next() must run exactly once`);
      assert.deepEqual(fx.spawned, [], `${label}: nothing spawns`);
      assert.deepEqual(fx.calls, [], `${label}: nothing injects`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// A rejecting inject must release the store's once-per-session claim so a
// later identical call can retry — the param-path mirror of dsh-seed-once.
// The handler calls inject() synchronously inside its try/catch (it does not
// await it), so a synchronous throw is the failure mode it treats as failed
// delivery, and the one pinned here.
test("dsh-param-9. a throwing inject releases the store's claim; the next call delivers", async () => {
  const repo = freshDir();
  try {
    seed(repo, ["Retry gap"]);
    const mod = await import(ADAPTER);
    const fx = paramFixture("MOCK-RETRY");
    let throwing = true;
    fx.agent.inject = (message) => {
      if (throwing) throw new Error("inject rejected");
      fx.calls.push({ kind: "inject", message });
    };
    const registered = mod.apply({}, fx);
    const call = () => registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `git -C ${repo} status` }), agent: fx.agent },
      () => ({ kind: "allow" }),
    );
    // First call: the inject throws — fail open, store claim released.
    const gate1 = await call();
    assert.deepEqual(gate1, { kind: "allow" }, "a throwing inject must still let the tool call through");
    assert.equal(fx.spawned.length, 1);
    assert.deepEqual(fx.calls, [], "the throwing inject delivered nothing");
    // Second identical call: the released claim must allow a full retry.
    throwing = false;
    const gate2 = await call();
    assert.deepEqual(gate2, { kind: "allow" });
    assert.equal(fx.spawned.length, 2, "the failed delivery must spawn again");
    assert.equal(fx.calls.length, 1, "the retried delivery lands");
    assert.equal(fx.calls[0].message.content[0].text, "MOCK-RETRY");
    // A third call is the ordinary once-per-store: nothing more.
    await call();
    assert.equal(fx.spawned.length, 2, "after a delivered inject the once-per-session claim holds");
    assert.equal(fx.calls.length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("45. no adapter contains a literal of any section-10 text (spec acceptance 36, made real)", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const { HORIZON_BLOCK_TEMPLATE, BOOTSTRAP_NUDGE_TEXT, NUDGE_TEXT } = await import(new URL("../src/index.ts", import.meta.url).pathname);
  function phrases(text) {
    // Distinctive 6+ word fragments from each text.
    const words = text.split(/\s+/);
    const out = [];
    for (let i = 0; i + 5 < words.length; i += 4) out.push(words.slice(i, i + 6).join(" "));
    return out;
  }
  const needles = [...phrases(HORIZON_BLOCK_TEMPLATE), ...phrases(BOOTSTRAP_NUDGE_TEXT), ...phrases(NUDGE_TEXT)];
  assert.ok(needles.length >= 20);
  const roots = ["src/adapters", "adapters/hermes"];
  for (const root of roots) {
    const dir = new URL(`../${root}`, import.meta.url).pathname;
    const files = [];
    (function walk(d) {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    })(dir);
    assert.ok(files.length > 0, `${root} is empty`);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const needle of needles) {
        assert.ok(!text.includes(needle), `${f} contains a literal copy of a section-10 text: "${needle}"`);
      }
    }
  }
});

test("46. the DSH adapter returns a turn-stopping addendum: the mid-session session-end prompt", async () => {
  const mod = await import(ADAPTER);
  const registered = mod.apply({}, { spawnBin: () => ({ status: 0, stdout: "", stderr: "" }), findBin: (b) => b });
  assert.ok(registered["agent/turn-stopping"], "the adapter must register agent/turn-stopping");
  const agent = {
    session: { header: { cwd: "/somewhere", delegationDepth: 0, origin: "user" } },
    inject() {},
    id: "sess-1234",
  };
  const steerCalls = [];
  agent.steer = (m) => steerCalls.push(m);
  await registered["agent/turn-stopping"]({ agent });
  assert.equal(steerCalls.length, 1, "exactly one mid-session addendum steer");
  const text = steerCalls[0].content[0].text;
  assert.ok(text.includes("horizon session-end"), "the addendum names the session-end command");
  assert.ok(text.includes("--harness dsh"), "the addendum pins the harness");
  assert.ok(text.includes("sess-1234"), "the addendum carries the session id");
  assert.ok(text.includes("user"), "the addendum demands explicit user approval");
});

test("47. package.json shape per D1: two bins, three adapter exports, no native dependency", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(pkg.bin).sort(), ["horizon", "horizon-inject"]);
  assert.deepEqual(Object.keys(pkg.exports).sort(), [".", "./dsh", "./opencode", "./pi", "./texts"]);
  // C3 live-probe finding (2026-09-10): Node refuses to type-strip files under
  // node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so an installed
  // dsh profile could never load a .ts runtime target. The dsh export's runtime
  // (default) target must be the built JS; types stay at the source.
  assert.equal(pkg.exports["./dsh"].default, "./dist/adapters/dsh.js", "the dsh export's runtime target is the built adapter JS");
  assert.equal(pkg.exports["./dsh"].types, "./src/adapters/dsh.ts", "the dsh export keeps types at the source");
  for (const key of ["./opencode", "./pi"]) assert.ok(pkg.exports[key].endsWith(".ts"), "host-loaded exports resolve to source files");
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  for (const banned of ["os-lock", "fs-ext", "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-tools", "@deepseek-ai/cordis"]) {
    assert.equal(deps[banned], undefined, `dependency ${banned} must not be present (glue spawns bins, never imports DSH)`);
  }
  assert.ok(!existsSync(join(new URL("..", import.meta.url).pathname, "binding.gyp")), "binding.gyp must not exist");
});

test("48. end-to-end: apply() with no overrides injects the composed block through the real bins", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["End-to-end gap"]);
    const mod = await import(ADAPTER);
    const injected = [];
    const registered = mod.apply({
      on() {},
    });
    await registered["agent/session-start"]({
      agent: {
        session: { header: { cwd: dir, delegationDepth: 0, origin: "user" } },
        inject(message) { injected.push(message); },
      },
      source: "startup",
    });
    assert.equal(injected.length, 1);
    const text = injected[0].content[0].text;
    assert.ok(text.startsWith("This project has a horizon"), `got: ${text.slice(0, 80)}`);
    assert.ok(text.includes("gap-1  End-to-end gap"));
    // The details pointer reaches the harness through the same bin stdout:
    // adapters are glue, so the core's pointer line needs no per-adapter work.
    assert.ok(text.includes("`horizon detail <id>` prints it"), "the dsh path must carry the core's detail pointer");
    // The empty-store twin: the real bootstrap nudge comes back through the
    // same chain.
    const empty = freshDir();
    try {
      seed(empty, []);
      const injected2 = [];
      await registered["agent/session-start"]({
        agent: {
          session: { header: { cwd: empty, delegationDepth: 0, origin: "user" } },
          inject(message) { injected2.push(message); },
        },
        source: "startup",
      });
      assert.equal(injected2.length, 1);
      assert.ok(injected2[0].content[0].text.startsWith("This project has no horizon yet"));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("49. inject embeds show stdout byte-for-byte even when gap texts carry $-replacement patterns (DEF-1)", async () => {
  const dir = freshDir();
  try {
    const texts = ["pay $& now", "cost $$5", "use $`tick", "tail $'mark", "plain $1 end"];
    const gaps = seed(dir, texts);
    const HORIZON_BIN = new URL("../bin/horizon.js", import.meta.url).pathname;
    const show = await new Promise((resolve) => {
      execFile(process.execPath, [HORIZON_BIN, "show", "--cwd", dir], { encoding: "utf8" }, (error, stdout) => {
        resolve({ code: error && typeof error.code === "number" ? error.code : 0, stdout });
      });
    });
    assert.equal(show.code, 0);
    const r = await run(["--cwd", dir]);
    assert.equal(r.code, 0);
    // spec 10: {{GAPS}} is horizon show stdout substituted verbatim, never
    // re-formatted — so the block must contain that stdout byte-for-byte.
    assert.ok(r.stdout.includes(show.stdout), "inject stdout must embed horizon show stdout byte-for-byte");
    for (const g of gaps) {
      assert.ok(r.stdout.includes(`${g.id}  ${g.text}`), `gap line must survive verbatim: ${g.text}`);
    }
    assert.ok(!r.stdout.includes("{{GAPS}}"), "the {{GAPS}} placeholder must never leak into the output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- about-line composition (spec 10.3) ---

// Write an about line into a seeded store, the way `horizon about` would.
function setAbout(dir, about) {
  const p = join(dir, ".horizon", "gaps.json");
  const state = JSON.parse(readFileSync(p, "utf8"));
  state.about = about;
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
}

test("about-inject-1. about + gaps: the about line, a blank line, then the byte-identical horizon block", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["A person can hand a photo to the app and get the plant named."]);
    setAbout(dir, "AI plugin to help agents with long term goals");
    const r = await run(["--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const spec = readFileSync(new URL("../.scratch/deep-horizon/05-cli-contract.md", import.meta.url), "utf8").split("\n");
    const show = "gap-1  A person can hand a photo to the app and get the plant named.\n";
    const expected =
      "This project is about: AI plugin to help agents with long term goals\n\n" +
      specFence(spec, "### 10.1").replace("{{GAPS}}", show);
    assert.equal(r.stdout, expected);
    // --json carries the same composed text in the text field.
    const j = await run(["--cwd", dir, "--json"]);
    assert.equal(j.code, 0);
    assert.equal(JSON.parse(j.stdout).text, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("about-inject-2. about + no gaps: the about line, a blank line, then the warm nudge", async () => {
  const dir = freshDir();
  try {
    seed(dir, []);
    setAbout(dir, "AI plugin to help agents with long term goals");
    const r = await run(["--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const spec = readFileSync(new URL("../.scratch/deep-horizon/05-cli-contract.md", import.meta.url), "utf8").split("\n");
    const expected =
      "This project is about: AI plugin to help agents with long term goals\n\n" + specFence(spec, "### 10.3");
    assert.equal(r.stdout, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("about-inject-3. without an about line: output is byte-identical to the pre-about composition", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["Only one gap"]);
    const r = await run(["--cwd", dir]);
    assert.equal(r.code, 0);
    const spec = readFileSync(new URL("../.scratch/deep-horizon/05-cli-contract.md", import.meta.url), "utf8").split("\n");
    const expected = specFence(spec, "### 10.1").replace("{{GAPS}}", "gap-1  Only one gap\n");
    assert.equal(r.stdout, expected); // no prefix, no extra blank line
    assert.ok(!r.stdout.startsWith("This project is about"), "about prefix leaked into an unset store");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inject-matrix. the five store states each produce exactly one variant — never two, never none (spec 10, acceptance 35)", async () => {
  const spec = readFileSync(new URL("../.scratch/deep-horizon/05-cli-contract.md", import.meta.url), "utf8").split("\n");
  const block = specFence(spec, "### 10.1");
  const bootstrap = specFence(spec, "### 10.2");
  const warm = specFence(spec, "### 10.3");
  const ABOUT = "AI plugin to help agents with long term goals";
  const prefix = `This project is about: ${ABOUT}\n\n`;
  const GAP = "A person can hand a photo to the app and get the plant named.";
  const show = `gap-1  ${GAP}\n`;
  // Openings chosen so no one is a substring of another variant's text.
  const openings = {
    block: "This project has a horizon — a short list",
    bootstrap: "This project has no horizon yet — no about line",
    warm: "No gaps yet. `horizon add",
  };
  const dirs = [];
  const cases = [];
  const noStore = freshDir(); dirs.push(noStore);
  cases.push(["no store", noStore, bootstrap, "bootstrap"]);
  const emptyStore = freshDir(); dirs.push(emptyStore); seed(emptyStore, []);
  cases.push(["store, nothing set", emptyStore, bootstrap, "bootstrap"]);
  const aboutOnly = freshDir(); dirs.push(aboutOnly); seed(aboutOnly, []); setAbout(aboutOnly, ABOUT);
  cases.push(["about only", aboutOnly, prefix + warm, "warm"]);
  const gapsOnly = freshDir(); dirs.push(gapsOnly); seed(gapsOnly, [GAP]);
  cases.push(["gaps only", gapsOnly, block.replace("{{GAPS}}", show), "block"]);
  const aboutGaps = freshDir(); dirs.push(aboutGaps); seed(aboutGaps, [GAP]); setAbout(aboutGaps, ABOUT);
  cases.push(["about+gaps", aboutGaps, prefix + block.replace("{{GAPS}}", show), "block"]);
  try {
    for (const [label, dir, expected, variant] of cases) {
      const r = await run(["--cwd", dir]);
      assert.equal(r.code, 0, `${label}: ${r.stderr}`);
      assert.equal(r.stdout, expected, `${label}: wrong variant composed`);
      const present = Object.entries(openings).filter(([, opening]) => r.stdout.includes(opening));
      assert.equal(present.length, 1, `${label}: expected exactly one variant, saw ${present.map(([k]) => k).join("+") || "none"}`);
      assert.equal(present[0][0], variant, `${label}: wrong variant present`);
    }
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});

// --- details pointer (per-gap extended context, retrieved on demand) ---

// The injected block carries ONE pointer line so a session knows a gap may
// hold extended context and how to retrieve it (`horizon detail <id>`). The
// nudges cover the no-gaps states, where no details exist, so they carry no
// pointer. Byte-exactness against the spec fence is already pinned by test 35
// and the matrix above; this pins the pointer's presence and its absence in
// the nudges.
test("pointer-1. the horizon block carries the detail pointer; neither nudge does", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["Pointer gap"]);
    const r = await run(["--cwd", dir]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("`horizon detail <id>` prints it"), "the block must tell the session how to retrieve extended context");
    assert.ok(r.stdout.includes("extended context"), "the pointer must name the thing, not just the command");
    const empty = freshDir();
    try {
      seed(empty, []);
      const r2 = await run(["--cwd", empty]);
      assert.equal(r2.code, 0);
      assert.ok(!r2.stdout.includes("horizon detail"), "the bootstrap nudge must not carry the pointer");
      setAbout(empty, "About line");
      const r3 = await run(["--cwd", empty]);
      assert.equal(r3.code, 0);
      assert.ok(!r3.stdout.includes("horizon detail"), "the warm nudge must not carry the pointer");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Injection minimalism (CONTEXT.md): details content NEVER appears in any
// injected text — the one line plus the pointer is everything a session gets.
test("pointer-2. details content never reaches injected text", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["Watchful gap"]);
    const store = join(dir, ".horizon");
    const state = JSON.parse(readFileSync(join(store, "gaps.json"), "utf8"));
    state.gaps[0].details = "SECRET-DETAIL-CONTEXT\nmore secret context";
    writeFileSync(join(store, "gaps.json"), JSON.stringify(state, null, 2) + "\n");
    const r = await run(["--cwd", dir]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("g_00000001  Watchful gap"), "the title line must survive");
    assert.ok(!r.stdout.includes("SECRET-DETAIL-CONTEXT"), "details content must never be injected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
