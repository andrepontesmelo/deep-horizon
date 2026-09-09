// Adapter tests for the HL-15 wave: Claude Code (settings.json blocks), Hermes
// (Python plugin glue), pi (extension), opencode (degraded plugin). The Python
// plugin itself is exercised with the real python3 interpreter; the TS
// adapters are driven through their exported handlers like the DSH tests.
//
// Nothing here imports hermes_cli or @mariozechner/pi: the adapters are glue
// that shells out to the bins, and these tests prove the glue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PI_ADAPTER = new URL("../src/adapters/pi.ts", import.meta.url).pathname;
const OPENCODE_ADAPTER = new URL("../src/adapters/opencode.ts", import.meta.url).pathname;
const HERMES_PLUGIN_DIR = join(ROOT, "adapters", "hermes");

function freshDir() {
  return mkdtempSync(join(tmpdir(), "horizon-adapter-test-"));
}

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

function runPython(args, opts = {}) {
  const r = spawnSync("python3", args, { encoding: "utf8", ...opts });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

// --- Claude Code: the settings.json block IS the adapter ---

test("50. the Claude Code adapter ships as a documented settings.json block with startup-only matcher and a SessionEnd close hook", () => {
  // The literal block lives in README.dsh.md's Claude Code section (folded
  // into the main README by the packaging card).
  const text = readFileSync(join(ROOT, "README.dsh.md"), "utf8");
  assert.ok(text.includes('"SessionStart"'), "README must document the SessionStart hook");
  assert.ok(text.includes('"matcher": "startup"'), "README must pin the matcher to startup only");
  assert.ok(text.includes("horizon-inject --harness claude-code"), "README must spawn horizon-inject for claude-code");
  assert.ok(text.includes('"SessionEnd"'), "README must document the SessionEnd close hook");
  assert.ok(/horizon session-end[^`]*--harness claude-code|horizon session-end --harness claude-code/.test(text),
    "SessionEnd must close with the CLI: 'horizon session-end --harness claude-code'");
});

// --- Hermes: adapters/hermes/ Python plugin ---

test("51. the Hermes plugin manifest is valid, names horizon-line, and the package imports without hermes_cli", () => {
  assert.ok(existsSync(join(HERMES_PLUGIN_DIR, "plugin.yaml")), "plugin.yaml must exist");
  assert.ok(existsSync(join(HERMES_PLUGIN_DIR, "horizon_line.py")), "the plugin module must exist");
  const manifest = readFileSync(join(HERMES_PLUGIN_DIR, "plugin.yaml"), "utf8");
  assert.match(manifest, /^name:\s*horizon-line\s*$/m);
  // The glue must not import hermes_cli (CLI-as-core, acceptance 36's spirit):
  // it spawns the bins like every other harness.
  const py = readFileSync(join(HERMES_PLUGIN_DIR, "horizon_line.py"), "utf8");
  assert.ok(!/import\s+hermes_cli|from\s+hermes_cli/.test(py), "the plugin must not import hermes_cli");
});

test("52. the Hermes section callable spawns horizon-inject --harness hermes and returns its stdout; caps fail open", () => {
  const dir = freshDir();
  try {
    seed(dir, ["Hermes section gap"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import horizon_line",
      "info = {'session_id': 's-1', 'cwd': " + JSON.stringify(dir) + ", 'parent_session_id': '', 'model': 'm', 'platform': 'cli', 'profile_name': 'dev'}",
      "text = horizon_line._section_text(info)",
      "sys.stdout.write(text)",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.ok(r.stdout.startsWith("This project has a horizon"), `got: ${r.stdout.slice(0, 80)}`);
    assert.ok(r.stdout.includes("g_00000001  Hermes section gap"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("53. the Hermes section returns empty text for subagent sessions (parent_session_id set) and renders under the 4000-char cap at the 5x512 worst case", () => {
  const dir = freshDir();
  try {
    seed(dir, Array.from({ length: 5 }, (_, i) => "g".repeat(512) + " " + i));
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import horizon_line",
      "base = {'session_id': 's-1', 'cwd': " + JSON.stringify(dir) + ", 'model': 'm', 'platform': 'cli', 'profile_name': 'dev'}",
      "child = dict(base, parent_session_id='parent-9')",
      "assert horizon_line._section_text(child) == '', 'subagent must render empty'",
      "text = horizon_line._section_text(base)",
      "assert len(text) < 4000, 'worst-case block must fit the Hermes cap: %d' % len(text)",
      "sys.stdout.write(str(len(text)))",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    const worstCase = Number(r.stdout.trim());
    assert.ok(worstCase > 3000 && worstCase < 4000, `unexpected worst-case length: ${worstCase}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("54. the Hermes plugin register() wires the section, the finalize hook, and fails open when the bins are missing", () => {
  const dir = freshDir();
  try {
    // PATH without the horizon bins: register() and the section must not raise.
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import horizon_line",
      "calls = []",
      "class Ctx:",
      "    def register_system_prompt_section(self, id, content, **kw):",
      "        calls.append(('section', id, content, kw))",
      "    def register_hook(self, name, cb):",
      "        calls.append(('hook', name, cb))",
      "horizon_line.register(Ctx())",
      "kinds = [c[0] for c in calls]",
      "assert kinds.count('section') == 1, kinds",
      "assert kinds.count('hook') == 1 and calls[[k[0] for k in calls].index('hook')][1] == 'on_session_finalize', kinds",
      "sec = [c for c in calls if c[0] == 'section'][0]",
      "assert sec[1] == 'horizon-line', sec[1]",
      "assert sec[3].get('max_chars') == 4000, sec[3]",
      "assert callable(sec[2]), 'content must be the callable'",
      "# A child session renders empty even with the bins missing (fail open).",
      "assert horizon_line._section_text({'session_id': 'x', 'cwd': '/tmp', 'parent_session_id': 'p'}) == ''",
      "# The finalize handler swallows everything with no store around.",
      "import inspect",
      "fin = [c for c in calls if c[0] == 'hook'][0][2]",
      "assert inspect.iscoroutinefunction(fin) or callable(fin)",
      "fin({'session_id': 'nope', 'platform': 'cli', 'reason': 'shutdown'})",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script], { env: { ...process.env, PATH: "/usr/bin:/bin" } });
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- pi adapter ---

test("55. the pi adapter: session_start shells out and stashes only on fresh reasons, before_agent_start returns the message on the first prompt", async () => {
  const dir = freshDir();
  const mod = await import(PI_ADAPTER);
  try {
    seed(dir, ["pi adapter gap"]);
    const calls = [];
    const registered = mod.apply({}, {
      spawnBin: (bin, args) => {
        calls.push({ bin, args });
        return { status: 0, stdout: "PI-MOCK-BLOCK", stderr: "" };
      },
    });
    assert.ok(registered["session_start"]);
    assert.ok(registered["before_agent_start"]);
    assert.ok(registered["session_shutdown"]);
    // Fresh session: stashed.
    await registered["session_start"]({ reason: "startup" }, { cwd: dir });
    assert.equal(calls.length, 1, "session_start must spawn horizon-inject");
    assert.ok(calls[0].args.includes("pi"));
    // First prompt: the stashed text is returned as the message, exactly once.
    const first = await registered["before_agent_start"]({ prompt: "hello" }, {});
    assert.equal(first.message.content, "PI-MOCK-BLOCK");
    const second = await registered["before_agent_start"]({ prompt: "again" }, {});
    assert.equal(second, undefined, "no injection after the first prompt");
    // Resume: no spawn, no stash.
    calls.length = 0;
    mod.apply({}, { spawnBin: (b, a) => { calls.push({ b, a }); return { status: 0, stdout: "X", stderr: "" }; } });
    // (fresh module state is per-apply; drive a resume through the same handlers is covered below)
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("56. the pi adapter guards: resume/reload/fork reasons never stash; HORIZON_SUBAGENT fails open; nonzero spawn injects nothing", async () => {
  const dir = freshDir();
  const mod = await import(PI_ADAPTER);
  try {
    seed(dir, ["pi guard gap"]);
    for (const reason of ["resume", "reload", "fork", "new"]) {
      let spawned = 0;
      const registered = mod.apply({}, { spawnBin: () => { spawned += 1; return { status: 0, stdout: "X", stderr: "" }; } });
      await registered["session_start"]({ reason }, { cwd: dir });
      // reason "new" arrives after /new inside a running process: the context is
      // fresh but this pi process is not at startup, and the user just left a
      // session; horizon targets session starts. Only startup stashes.
      assert.equal(spawned, 0, `reason ${reason} must not spawn`);
      const out = await registered["before_agent_start"]({ prompt: "p" }, {});
      assert.equal(out, undefined, `reason ${reason} must not inject`);
    }
    // Subagent env var: session_start skips stashing entirely (fail-open is the
    // absence of the var, tested in 55; here the var is set).
    let spawned2 = 0;
    const registered2 = mod.apply({}, { spawnBin: () => { spawned2 += 1; return { status: 0, stdout: "X", stderr: "" }; } });
    const prev = process.env.HORIZON_SUBAGENT;
    process.env.HORIZON_SUBAGENT = "1";
    try {
      await registered2["session_start"]({ reason: "startup" }, { cwd: dir });
      assert.equal(spawned2, 0, "HORIZON_SUBAGENT must suppress the spawn");
      const out = await registered2["before_agent_start"]({ prompt: "p" }, {});
      assert.equal(out, undefined);
    } finally {
      if (prev === undefined) delete process.env.HORIZON_SUBAGENT; else process.env.HORIZON_SUBAGENT = prev;
    }
    // Nonzero spawn: nothing stashed, first prompt injects nothing.
    let calls = 0;
    const registered3 = mod.apply({}, { spawnBin: () => { calls += 1; return { status: 7, stdout: "", stderr: "boom" }; } });
    await registered3["session_start"]({ reason: "startup" }, { cwd: dir });
    assert.equal(calls, 1);
    const out3 = await registered3["before_agent_start"]({ prompt: "p" }, {});
    assert.equal(out3, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("57. the pi adapter session_shutdown closes the session with horizon session-end --harness pi --session <id>", async () => {
  const mod = await import(PI_ADAPTER);
  const calls = [];
  const registered = mod.apply({}, {
    spawnBin: (bin, args) => {
      calls.push({ bin, args });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  await registered["session_shutdown"]({ reason: "quit" }, { sessionManager: { getSessionId: () => "pi-sess-1" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "horizon");
  assert.deepEqual(calls[0].args, ["session-end", "--harness", "pi", "--session", "pi-sess-1"]);
  // A shutdown without a session id must not spawn a malformed command.
  calls.length = 0;
  await registered["session_shutdown"]({ reason: "quit" }, {});
  assert.equal(calls.length, 0, "no session id, no session-end spawn");
  // Fail-open: a throwing spawn must not reject.
  const registered2 = mod.apply({}, { spawnBin: () => { throw new Error("ENOENT"); } });
  await assert.doesNotReject(registered2["session_shutdown"]({ reason: "quit" }, { sessionManager: { getSessionId: () => "s" } }));
});

test("58. the pi adapter end-to-end: startup stash flows the real horizon-inject block into the first prompt", async () => {
  const dir = freshDir();
  try {
    seed(dir, ["End-to-end pi gap"]);
    const mod = await import(PI_ADAPTER);
    const registered = mod.apply({}); // real bins via the repo checkout
    await registered["session_start"]({ reason: "startup" }, { cwd: dir });
    const first = await registered["before_agent_start"]({ prompt: "go" }, {});
    assert.ok(first.message.content.startsWith("This project has a horizon"));
    assert.ok(first.message.content.includes("g_00000001  End-to-end pi gap"));
    assert.equal(first.message.customType, "horizon-line");
    // The nudge twin: empty store still injects the nudge (composition, not gap-detection).
    const empty = freshDir();
    try {
      seed(empty, []);
      const registered2 = mod.apply({});
      await registered2["session_start"]({ reason: "startup" }, { cwd: empty });
      const out = await registered2["before_agent_start"]({ prompt: "go" }, {});
      assert.ok(out.message.content.startsWith("Horizon: none set"));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- opencode adapter (DEGRADED, D4) ---

test("59. the opencode adapter prepends the block once per session on the heuristic and excludes subagents via parentID", async () => {
  const dir = freshDir();
  const mod = await import(OPENCODE_ADAPTER);
  try {
    seed(dir, ["opencode gap"]);
    const calls = [];
    const hooks = await mod.apply({
      client: { session: { get: async ({ path }) => {
        calls.push({ kind: "get", path });
        if (path.sessionID === "sess-child") return { data: { id: path.sessionID, parentID: "sess-parent", time: { created: 1, updated: 1 } } };
        return { data: { id: path.sessionID, time: { created: 1, updated: 1 } } };
      } } },
      directory: dir,
    }, {
      spawnBin: (bin, args) => {
        calls.push({ bin, args });
        return { status: 0, stdout: "OPENCODE-MOCK-BLOCK", stderr: "" };
      },
      now: () => 10_000,
    });
    assert.ok(hooks["chat.message"]);
    // Fresh session, first message: prepend.
    const parts = [{ type: "text", text: "user text" }];
    await hooks["chat.message"]({ sessionID: "sess-new", messageID: "m1" }, { message: { id: "m1" }, parts });
    assert.ok(parts[0].type === "text" && parts[0].text === "OPENCODE-MOCK-BLOCK");
    assert.ok(parts[0].id, "prepended part must carry an id");
    assert.equal(parts[1].text, "user text", "the user's own text must survive after the prepend");
    // Second message in the same session: nothing (once per session).
    const parts2 = [{ type: "text", text: "second" }];
    await hooks["chat.message"]({ sessionID: "sess-new" }, { message: { id: "m2" }, parts2 });
    assert.deepEqual(parts2, [{ type: "text", text: "second" }]);
    // Subagent: excluded via parentID.
    const parts3 = [{ type: "text", text: "child" }];
    await hooks["chat.message"]({ sessionID: "sess-child" }, { message: { id: "m3" }, parts3 });
    assert.deepEqual(parts3, [{ type: "text", text: "child" }]);
    // Resumed session (old created time, nonempty history count via messages): skipped.
    hooks2: {
      const calls2 = [];
      const hooks2 = await mod.apply({
        client: { session: { get: async ({ path }) => ({ data: { id: path.sessionID, time: { created: 1, updated: 1 } } }), messages: async () => ({ data: Array.from({ length: 3 }, () => ({})) }) } },
        directory: dir,
      }, {
        spawnBin: (bin, args) => { calls2.push({ bin }); return { status: 0, stdout: "X", stderr: "" }; },
        now: () => 10_000,
      });
      const parts4 = [{ type: "text", text: "resumed" }];
      await hooks2["chat.message"]({ sessionID: "sess-old" }, { message: { id: "m4" }, parts4 });
      assert.deepEqual(parts4, [{ type: "text", text: "resumed" }], "resumed session must not be modified");
      assert.equal(calls2.length, 0, "no spawn for a resumed session");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("60. the opencode adapter never writes session records: no close hook in the returned object, no spawn other than horizon-inject", async () => {
  const mod = await import(OPENCODE_ADAPTER);
  const calls = [];
  const hooks = await mod.apply({
    client: { session: { get: async ({ path }) => ({ data: { id: path.sessionID, time: { created: Date.now(), updated: Date.now() } } }) } },
    directory: "/tmp",
  }, {
    spawnBin: (bin) => { calls.push(bin); return { status: 0, stdout: "X", stderr: "" }; },
    now: () => Date.now(),
  });
  // The degraded contract: exactly one hook, no lifecycle/close hooks at all.
  assert.deepEqual(Object.keys(hooks).sort(), ["chat.message"]);
  const parts = [{ type: "text", text: "hi" }];
  await hooks["chat.message"]({ sessionID: "s9" }, { message: { id: "m" }, parts });
  assert.ok(parts.length === 2, "fresh session gets the prepend");
  for (const c of calls) assert.equal(c, "horizon-inject", `opencode must only ever spawn horizon-inject, saw: ${c}`);
});

test("61. the opencode adapter fails open: client errors, spawn errors, and absent sessions never throw", async () => {
  const mod = await import(OPENCODE_ADAPTER);
  const hooks = await mod.apply({
    client: { session: { get: async () => { throw new Error("server gone"); } } },
    directory: "/tmp",
  }, { spawnBin: () => { throw new Error("ENOENT"); } });
  await assert.doesNotReject(hooks["chat.message"]({ sessionID: "s" }, { message: { id: "m" }, parts: [{ type: "text", text: "x" }] }));
  const parts = [{ type: "text", text: "x" }];
  await hooks["chat.message"]({ sessionID: "s" }, { message: { id: "m" }, parts });
  assert.deepEqual(parts, [{ type: "text", text: "x" }]);
});
