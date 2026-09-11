import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshDir, runCli, runInject, seed, specFence, withDir } from "./harness.js";
import { setAbout as storeSetAbout, setDetail } from "../src/store.ts";
import { compose, resolveInjection } from "../src/inject.ts";

const ADAPTER = new URL("../src/adapters/dsh.ts", import.meta.url).pathname;

// --- horizon-inject: composition (spec 10, D6) ---

test("35. inject prints the horizon block, gaps substituted verbatim, byte-for-byte against the spec", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["A person can hand a photo to the app and get the plant named.", "Rentals can be compared across sites without re-entering filters."]);
    const r = await runInject(["--cwd", dir]);
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
    const r1 = await runInject(["--cwd", absent]);
    assert.equal(r1.code, 0);
    assert.equal(r1.stdout, bootstrap);
    const empty = freshDir();
    try {
      seed(empty, []);
      const r2 = await runInject(["--cwd", empty]);
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

test("home-suppress-2. end-to-end: main silences a storeless $HOME (exit 0, empty stdout) and keeps a deliberate home store", async () => {
  // os.homedir() honours $HOME on POSIX, and runInject swaps the environment
  // per call, so a fake home keeps this deterministic regardless of the real
  // ~/.horizon — the same mechanism the spawned bin was subject to.
  await withDir(async (fakeHome) => {
    const env = { ...process.env, HOME: fakeHome };
    const r1 = await runInject(["--cwd", fakeHome], { env });
    assert.equal(r1.code, 0);
    assert.equal(r1.stdout, "", "the storeless-home bootstrap misfire must be silent");
    const proj = join(fakeHome, "git", "proj");
    mkdirSync(proj, { recursive: true });
    const r2 = await runInject(["--cwd", proj], { env });
    assert.equal(r2.code, 0);
    assert.ok(r2.stdout.startsWith("This project has no horizon yet"), "a storeless project still gets its nudge");
    seed(fakeHome, ["Deliberate home store gap"]);
    const r3 = await runInject(["--cwd", fakeHome], { env });
    assert.equal(r3.code, 0);
    assert.ok(r3.stdout.includes("Deliberate home store gap"), "a deliberate home-level store keeps injecting");
  }, "horizon-fake-home-");
});

test("37. inject has a --json mode: {\"text\",\"store\"} on stdout, nothing else", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["Only one gap"]);
    const r = await runInject(["--cwd", dir, "--json"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(typeof parsed.text, "string");
    assert.ok(parsed.text.startsWith("This project has a horizon"));
    assert.ok(parsed.text.includes("gap-1  Only one gap"));
    // The total answer: the resolved store dir rides along with the text.
    assert.equal(parsed.store, join(dir, ".horizon"));
    assert.equal(JSON.stringify(parsed), JSON.stringify({ text: parsed.text, store: join(dir, ".horizon") }));
    assert.ok(!r.stderr, "stderr must stay empty on success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The storeless twin of 37: no store anywhere above the cwd, so store is
// null — the nudge text still composes (the storeless-nudge case), and the
// home-silence case is the total answer {"",""} twin: empty text, null store.
test("inject-json-storeless. --json answers store:null when no store resolves; plain stdout stays byte-identical", async () => {
  const dir = freshDir();
  try {
    const j = await runInject(["--cwd", dir, "--json"]);
    assert.equal(j.code, 0);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.store, null, "a storeless cwd must answer store:null");
    assert.ok(parsed.text.startsWith("This project has no horizon yet"), "the storeless nudge still composes");
    assert.equal(JSON.stringify(parsed), JSON.stringify({ text: parsed.text, store: null }));
    // Plain mode: the same text, no JSON wrapper (the non-json contract).
    const plain = await runInject(["--cwd", dir]);
    assert.equal(plain.code, 0);
    assert.equal(plain.stdout, parsed.text);
    // Home silence: empty text, null store — nothing to hand back. (os.homedir()
    // honours $HOME on POSIX; the mechanism is pinned by home-suppress-2.)
    const env = { ...process.env, HOME: dir };
    const silent = await runInject(["--cwd", dir, "--json"], { env });
    assert.equal(silent.code, 0);
    assert.deepEqual(JSON.parse(silent.stdout), { text: "", store: null });
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
    const r = await runInject(["--cwd", dir]);
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
      const r2 = await runInject(["--cwd", empty]);
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
    const r = await runInject(["--cwd", dir]);
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
    const help = await runInject(["--help"]);
    assert.equal(help.code, 0);
    assert.ok(help.stdout.includes("horizon-inject"));
    const version = await runInject(["--version"]);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^horizon-inject \d+\.\d+\.\d+/);
    const r = await runInject(["--cwd", dir, "--harness", "dsh", "--session", "abc", "--origin", "human"]);
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
      if (bin === "horizon-inject") return { status: 0, stdout: JSON.stringify({ text: "MOCK-INJECTED-TEXT", store: "/mock-store" }), stderr: "" };
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
    spawnBin: () => { throw new Error("horizon-inject ENOENT"); },
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
    spawnBin: () => { spawns += 1; return { status: 0, stdout: JSON.stringify({ text: "MOCK-SEED", store: "/seed-store" }), stderr: "" }; },
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
      const r = fail
        ? { status: 7, stdout: "", stderr: "boom" }
        : { status: 0, stdout: JSON.stringify({ text: "Y", store: "/retry-store" }), stderr: "" };
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
// and returns a fixed horizon-inject --json answer ({text, store}, or a
// function of the spawn args), so composition never leaves the test.
function paramFixture(answer, header = { cwd: "/launched-elsewhere", delegationDepth: 0, origin: "user" }) {
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
      const a = typeof answer === "function" ? answer(args) : answer;
      return { status: 0, stdout: JSON.stringify(a), stderr: "" };
    },
  };
}

// The --cwd value of a recorded spawn (the probes are keyed on the touched dir).
function cwdOf(spawn) {
  return spawn.args[spawn.args.indexOf("--cwd") + 1];
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
    const fx = paramFixture({ text: "MOCK-PARAM-HORIZON", store: repo });
    const registered = mod.apply({}, fx);
    let nextCalls = 0;
    const gate = await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `git -C ${repo} status && cat ${repo}/README.md` }), agent: fx.agent },
      () => { nextCalls += 1; return { kind: "allow" }; },
    );
    assert.deepEqual(gate, { kind: "allow" }, "the handler must return next()'s result, never a veto");
    assert.equal(nextCalls, 1, "next() must be called exactly once");
    // The trigger asks the bin per newly-seen candidate dir (the command's
    // two tokens name the repo and a file inside it — both probe), and the
    // bin's returned store is what the dedup keys on: one inject.
    assert.deepEqual(fx.spawned.map(cwdOf), [repo, join(repo, "README.md")]);
    for (const s of fx.spawned) assert.deepEqual(s.args, ["--harness", "dsh", "--json", "--cwd", cwdOf(s)]);
    assert.equal(fx.calls.length, 1, "exactly one inject — once per store per session");
    assert.equal(fx.calls[0].message.content[0].text, "MOCK-PARAM-HORIZON");
    assert.equal(fx.calls[0].message.role, "user");
    // The same tool call again: both dirs are answered, the store is served.
    await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `git -C ${repo} log --oneline` }), agent: fx.agent },
      () => ({ kind: "allow" }),
    );
    assert.equal(fx.spawned.length, 2, "answered dirs must not spawn again");
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
    const fx = paramFixture((args) => {
      const dir = args[args.indexOf("--cwd") + 1];
      return { text: `MOCK:${dir}`, store: dir };
    });
    const registered = mod.apply({}, fx);
    await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `git -C ${repoA} status` }), agent: fx.agent },
      () => ({ kind: "allow" }),
    );
    // A file_path whose directory has no store still resolves the nearest
    // ancestor store — the bin resolves --cwd, and its answer's store key
    // keeps the two repos apart.
    await registered["tools/pre-execute"](
      { name: "str_replace_editor", arguments: frozen({ file_path: join(repoB, "sub", "file.txt") }), agent: fx.agent },
      () => ({ kind: "allow" }),
    );
    assert.deepEqual(fx.spawned.map(cwdOf), [repoA, join(repoB, "sub")], "each touch probes once; --cwd is the touched dir and the bin resolves the store itself");
    assert.deepEqual(fx.calls.map((c) => c.message.content[0].text), [`MOCK:${repoA}`, `MOCK:${join(repoB, "sub")}`]);
  } finally {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});

test("dsh-param-3. a storeless target never fires — one probe per dir, no inject, no bootstrap, and the storeless answer is remembered", async () => {
  const bare = freshDir();
  try {
    const mod = await import(ADAPTER);
    const fx = paramFixture({ text: "MOCK-SHOULD-NOT-APPEAR", store: null });
    const registered = mod.apply({}, fx);
    const gate = await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `ls ${bare} && cd ${bare}/deeper`, workdir: bare }), agent: fx.agent },
      () => ({ kind: "allow" }),
    );
    assert.deepEqual(gate, { kind: "allow" });
    // The bin is asked (it owns the store-existence rule now): its
    // store:null answer silences every candidate dir — the nudge never
    // fires from a param probe.
    assert.deepEqual(fx.spawned.map(cwdOf), [bare, join(bare, "deeper")], "each unseen dir probes once");
    assert.deepEqual(fx.calls, [], "a storeless target must not inject");
    // And the storeless answers are remembered: no re-probe on the next touch.
    await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `ls ${bare}` }), agent: fx.agent },
      () => ({ kind: "allow" }),
    );
    assert.equal(fx.spawned.length, 2, "a storeless dir must not re-spawn");
    assert.deepEqual(fx.calls, []);
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
      const fx = paramFixture({ text: "MOCK-SUBAGENT", store: "/x-store" });
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
      const fx = paramFixture({ text: "MOCK-MALFORMED", store: "/m-store" });
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
    const fx = paramFixture({ text: "MOCK-OK", store: "/ok-store" });
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
    const fx = paramFixture((args) => ({ text: "MOCK-STARTUP", store: args[args.indexOf("--cwd") + 1] }), { cwd: repo, delegationDepth: 0, origin: "user" });
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
    assert.ok(text.includes("gap-1  Param e2e gap"));
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
      const fx = paramFixture({ text: "MOCK-DEGENERATE", store: "/deg-store" });
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
    const fx = paramFixture({ text: "MOCK-RETRY", store: repo });
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

// A call naming several unseen dirs must not pay serial node startups inside
// the awaited waterfall: the fresh probes issue together, and the
// once-per-store claim still collapses N dirs on one store to one inject.
test("dsh-param-10. fresh dirs in one call probe concurrently — every probe issues before the first delivery, and two dirs on one store inject once", async () => {
  const repo = freshDir();
  try {
    seed(repo, ["Concurrency gap"]);
    const mod = await import(ADAPTER);
    const events = [];
    const agent = {
      session: { header: { cwd: "/launched-elsewhere", delegationDepth: 0, origin: "user" } },
      inject() { events.push("inject"); },
      steer() {},
    };
    const registered = mod.apply({}, {
      spawnBin: (bin, args) => {
        events.push(`spawn:${args[args.indexOf("--cwd") + 1]}`);
        return { status: 0, stdout: JSON.stringify({ text: "MOCK-CONCURRENT", store: repo }), stderr: "" };
      },
    });
    // Two fresh dirs on ONE store, named in one call: both probed, one
    // inject. Normalized keys, so the token spellings dedupe first.
    const gate = await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `cp ${repo}/a.txt ${repo}/b.txt` }), agent },
      () => ({ kind: "allow" }),
    );
    assert.deepEqual(gate, { kind: "allow" });
    assert.equal(events.filter((e) => e.startsWith("spawn")).length, 2, "both fresh dirs probe");
    assert.equal(events.filter((e) => e === "inject").length, 1, "N dirs on one store inject once");
    // Concurrency shape: every probe issues before any delivery. A
    // sequential await-loop would deliver the first store's inject before
    // the second dir's spawn was even issued.
    const spawnsAt = events.map((e) => e.startsWith("spawn"));
    const lastSpawn = spawnsAt.lastIndexOf(true);
    const firstInject = events.indexOf("inject");
    assert.ok(firstInject === -1 || firstInject > lastSpawn, `all probes must issue before the first delivery: ${events}`);
    // Normalization: token variants of one path are one probe key — the
    // double-slash spelling of the same dir must not re-probe.
    events.length = 0;
    await registered["tools/pre-execute"](
      { name: "bash", arguments: frozen({ command: `cat ${repo}//a.txt` }), agent },
      () => ({ kind: "allow" }),
    );
    assert.equal(events.length, 0, `a normalized duplicate must not re-probe: ${events}`);
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
  const registered = mod.apply({}, { spawnBin: () => ({ status: 0, stdout: "", stderr: "" }) });
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
    const show = await runCli(["show", "--cwd", dir]);
    assert.equal(show.code, 0);
    const r = await runInject(["--cwd", dir]);
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

// Write an about line into a seeded store through the store interface, the
// way `horizon about "<text>"` would.
function setAbout(dir, about) {
  const r = storeSetAbout(dir, { text: about });
  if (r) throw new Error(r.message);
}

test("about-inject-1. about + gaps: the about line, a blank line, then the byte-identical horizon block", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["A person can hand a photo to the app and get the plant named."]);
    setAbout(dir, "AI plugin to help agents with long term goals");
    const r = await runInject(["--cwd", dir]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const spec = readFileSync(new URL("../.scratch/deep-horizon/05-cli-contract.md", import.meta.url), "utf8").split("\n");
    const show = "gap-1  A person can hand a photo to the app and get the plant named.\n";
    const expected =
      "This project is about: AI plugin to help agents with long term goals\n\n" +
      specFence(spec, "### 10.1").replace("{{GAPS}}", show);
    assert.equal(r.stdout, expected);
    // --json carries the same composed text in the text field.
    const j = await runInject(["--cwd", dir, "--json"]);
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
    const r = await runInject(["--cwd", dir]);
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
    const r = await runInject(["--cwd", dir]);
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
      const r = await runInject(["--cwd", dir]);
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
    const r = await runInject(["--cwd", dir]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("`horizon detail <id>` prints it"), "the block must tell the session how to retrieve extended context");
    assert.ok(r.stdout.includes("extended context"), "the pointer must name the thing, not just the command");
    const empty = freshDir();
    try {
      seed(empty, []);
      const r2 = await runInject(["--cwd", empty]);
      assert.equal(r2.code, 0);
      assert.ok(!r2.stdout.includes("horizon detail"), "the bootstrap nudge must not carry the pointer");
      setAbout(empty, "About line");
      const r3 = await runInject(["--cwd", empty]);
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
    // Details go in through the store's own writer, never a hand-written file.
    const r0 = setDetail(dir, "gap-1", { text: "SECRET-DETAIL-CONTEXT\nmore secret context" });
    assert.equal(r0, null, `seeding details failed: ${r0 && r0.message}`);
    const r = await runInject(["--cwd", dir]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("gap-1  Watchful gap"), "the title line must survive");
    assert.ok(!r.stdout.includes("SECRET-DETAIL-CONTEXT"), "details content must never be injected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the composer, in-process (src/inject.ts) ---

// The variant state machine used to live inline in the bin's main(), reachable
// only through a subprocess spawn. The composer's src home makes it importable:
// compose() is the pure selection, resolveInjection() the read-only cwd round.

test("inject-unit-1. selection in-process: exactly one variant per state, byte-equal to the spec fences", () => {
  const spec = readFileSync(new URL("../.scratch/deep-horizon/05-cli-contract.md", import.meta.url), "utf8").split("\n");
  const block = specFence(spec, "### 10.1");
  const bootstrap = specFence(spec, "### 10.2");
  const warm = specFence(spec, "### 10.3");
  const ABOUT = "AI plugin to help agents with long term goals";
  const prefix = `This project is about: ${ABOUT}\n\n`;
  const GAP = { id: "gap-1", text: "A person can hand a photo to the app and get the plant named." };
  const show = "gap-1  A person can hand a photo to the app and get the plant named.\n";
  const cases = [
    ["gaps, no about", compose({ gaps: [GAP], about: undefined, silence: false }), block.replace("{{GAPS}}", show)],
    ["gaps + about", compose({ gaps: [GAP], about: ABOUT, silence: false }), prefix + block.replace("{{GAPS}}", show)],
    ["about only", compose({ gaps: [], about: ABOUT, silence: false }), prefix + warm],
    ["neither", compose({ gaps: [], about: undefined, silence: false }), bootstrap],
    ["neither, home silence", compose({ gaps: [], about: undefined, silence: true }), ""],
  ];
  // Openings chosen so no one is a substring of another variant's text.
  const openings = {
    block: "This project has a horizon — a short list",
    bootstrap: "This project has no horizon yet — no about line",
    warm: "No gaps yet. `horizon add",
  };
  for (const [label, text, expected] of cases) {
    assert.equal(text, expected, `${label}: wrong variant composed`);
    // The silence case composes empty — no variant present is its point.
    if (text === "") continue;
    const present = Object.entries(openings).filter(([, opening]) => text.includes(opening));
    assert.equal(present.length, 1, `${label}: expected exactly one variant, saw ${present.map(([k]) => k).join("+") || "none"}`);
  }
});

// DEF-1's guard has its caller at last: the substitution goes through
// texts.ts's horizonBlock() (a function replacement), so $-patterns in
// user-authored gap text ride into the block verbatim — pinned here without
// a subprocess, next to the selection it guards.
test("inject-unit-2. the $-pattern guard: $&, $`, $', $$, $1 substitute byte-for-byte, no expansion, no placeholder leak", () => {
  const spec = readFileSync(new URL("../.scratch/deep-horizon/05-cli-contract.md", import.meta.url), "utf8").split("\n");
  const gaps = [
    { id: "pay", text: "pay $& now" },
    { id: "cost", text: "cost $$5" },
    { id: "tick", text: "use $`tick" },
    { id: "tail", text: "tail $'mark" },
    { id: "plain", text: "plain $1 end" },
  ];
  const show = gaps.map((g) => `${g.id}  ${g.text}`).join("\n") + "\n";
  // Function replacement in the fixture too: a string replacement would
  // expand the $-patterns in `show` while building the expectation — the
  // very DEF-1 bug this test exists to pin.
  const text = compose({ gaps, about: undefined, silence: false });
  assert.equal(text, specFence(spec, "### 10.1").replace("{{GAPS}}", () => show));
  assert.ok(!text.includes("{{GAPS}}"), "the {{GAPS}} placeholder must never leak into the output");
});

// The --json envelope's content, in-process: resolveInjection is the total
// answer for a cwd — the composed text plus the store the resolution already
// paid for, null when none was found. `home` is injectable, so the silence
// case never touches the real $HOME. A malformed store stays an unwrapped
// error: { code, message }, stdout untouched (main() prints nothing under
// --json on the error path).
test("inject-unit-3. resolveInjection: the {text, store} answer — store rides along, storeless is null, home silence is empty", () => {
  const dir = freshDir();
  try {
    seed(dir, ["Envelope gap"]);
    const spec = readFileSync(new URL("../.scratch/deep-horizon/05-cli-contract.md", import.meta.url), "utf8").split("\n");
    const expected = specFence(spec, "### 10.1").replace("{{GAPS}}", "gap-1  Envelope gap\n");
    assert.deepEqual(resolveInjection(dir, { home: "/home/fake-user" }), { text: expected, store: join(dir, ".horizon") });
    const storeless = freshDir();
    try {
      const s = resolveInjection(storeless, { home: "/home/fake-user" });
      assert.equal(s.store, null, "a storeless cwd must answer store:null");
      assert.ok(s.text.startsWith("This project has no horizon yet"), "the storeless nudge still composes");
      // The silence twin: a storeless cwd that IS the (fake) home — empty
      // text, null store, nothing to hand back.
      assert.deepEqual(resolveInjection(storeless, { home: storeless }), { text: "", store: null });
    } finally {
      rmSync(storeless, { recursive: true, force: true });
    }
    const bad = freshDir();
    try {
      mkdirSync(join(bad, ".horizon"), { recursive: true });
      writeFileSync(join(bad, ".horizon", "gaps.json"), '{"version":1,"revision":1,"gaps":[null]}');
      const e = resolveInjection(bad, { home: "/home/fake-user" });
      assert.equal(e.error.code, 7);
      assert.match(e.error.message, /gaps\.json/);
      assert.equal(e.text, undefined);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The deliberate wire change the extraction carried: --flag=value. The CLI's
// parser always took --cwd=<path>; the bin's own loop answered "unknown
// option" (exit 2) — a divergence nothing pinned. The extracted parser
// mirrors the CLI's = handling; this test drives it through main() itself,
// and the shim seam it used to need a subprocess for is the bin smoke's.
test("inject-eq-flag. --cwd=<path> composes like the separate-arg form, plain and --json; unknown flags still exit 2", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["Equals form gap"]);
    const r = await runInject([`--cwd=${dir}`]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("gap-1  Equals form gap"));
    const j = await runInject([`--cwd=${dir}`, "--json"]);
    assert.equal(j.code, 0);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.store, join(dir, ".horizon"));
    assert.ok(parsed.text.includes("gap-1  Equals form gap"));
    // Bool flags reject the = form the way the CLI's parser does — all three
    // of them, short-circuits included: --help=x is a usage error, never a
    // help answer — while the bare forms still answer (and test 40 pins the
    // bare forms' exit 0 through the same bin).
    for (const flag of ["--json", "--help", "--version"]) {
      const boolEq = await runInject([`--cwd=${dir}`, `${flag}=x`]);
      assert.equal(boolEq.code, 2, `${flag}=x must be a usage error`);
      assert.ok(boolEq.stderr.startsWith(`horizon-inject: ${flag} takes no value`), `${flag}=x: ${boolEq.stderr}`);
      assert.equal(boolEq.stdout, "", `${flag}=x must print nothing on stdout`);
      const bare = await runInject([flag]);
      assert.equal(bare.code, 0, `bare ${flag} must still answer`);
      assert.notEqual(bare.stdout, "", `bare ${flag} must print`);
    }
    // A genuinely unknown option still names the token and exits 2 with
    // empty stdout.
    const bad = await runInject([`--bogus=${dir}`]);
    assert.equal(bad.code, 2);
    assert.equal(bad.stdout, "");
    assert.ok(bad.stderr.startsWith(`horizon-inject: unknown option: --bogus=${dir}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
