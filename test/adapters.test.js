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
    id: `gap-${i + 1}`,
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
  // The literal block lives in the main README's Claude Code section (folded
  // out of README.dsh.md, which the docs consolidation deleted).
  const text = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(text.includes('"SessionStart"'), "README must document the SessionStart hook");
  assert.ok(text.includes('"matcher": "startup"'), "README must pin the matcher to startup only");
  assert.ok(text.includes("horizon-inject --harness claude-code"), "README must spawn horizon-inject for claude-code");
  assert.ok(text.includes('"SessionEnd"'), "README must document the SessionEnd close hook");
  assert.ok(/horizon session-end[^`]*--harness claude-code|horizon session-end --harness claude-code/.test(text),
    "SessionEnd must close with the CLI: 'horizon session-end --harness claude-code'");
});

// --- Hermes: adapters/hermes/ Python plugin ---

test("51. the Hermes plugin manifest is valid, names deep-horizon, and the package imports without hermes_cli", () => {
  assert.ok(existsSync(join(HERMES_PLUGIN_DIR, "plugin.yaml")), "plugin.yaml must exist");
  assert.ok(existsSync(join(HERMES_PLUGIN_DIR, "deep_horizon.py")), "the plugin module must exist");
  const manifest = readFileSync(join(HERMES_PLUGIN_DIR, "plugin.yaml"), "utf8");
  assert.match(manifest, /^name:\s*deep-horizon\s*$/m);
  // The glue must not import hermes_cli (CLI-as-core, acceptance 36's spirit):
  // it spawns the bins like every other harness.
  const py = readFileSync(join(HERMES_PLUGIN_DIR, "deep_horizon.py"), "utf8");
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
      "import deep_horizon",
      "info = {'session_id': 's-1', 'cwd': " + JSON.stringify(dir) + ", 'parent_session_id': '', 'model': 'm', 'platform': 'cli', 'profile_name': 'dev'}",
      "text = deep_horizon._section_text(info)",
      "sys.stdout.write(text)",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.ok(r.stdout.startsWith("This project has a horizon"), `got: ${r.stdout.slice(0, 80)}`);
    assert.ok(r.stdout.includes("gap-1  Hermes section gap"));
    // The detail pointer rides the same composed block: the hermes path never
    // composes texts itself, so it inherits the core's pointer line verbatim.
    assert.ok(r.stdout.includes("`horizon detail <id>` prints it"), "the hermes section must carry the core's detail pointer");
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
      "import deep_horizon",
      "base = {'session_id': 's-1', 'cwd': " + JSON.stringify(dir) + ", 'model': 'm', 'platform': 'cli', 'profile_name': 'dev'}",
      "child = dict(base, parent_session_id='parent-9')",
      "assert deep_horizon._section_text(child) == '', 'subagent must render empty'",
      "text = deep_horizon._section_text(base)",
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
      "import deep_horizon",
      "calls = []",
      "class Ctx:",
      "    def register_system_prompt_section(self, id, content, **kw):",
      "        calls.append(('section', id, content, kw))",
      "    def register_hook(self, name, cb):",
      "        calls.append(('hook', name, cb))",
      "deep_horizon.register(Ctx())",
      "kinds = [c[0] for c in calls]",
      "assert kinds.count('section') == 1, kinds",
      "hooks = sorted(c[1] for c in calls if c[0] == 'hook')",
      "assert hooks == ['on_session_finalize', 'pre_llm_call'], hooks",
      "sec = [c for c in calls if c[0] == 'section'][0]",
      "assert sec[1] == 'deep-horizon', sec[1]",
      "assert sec[3].get('max_chars') == 4000, sec[3]",
      "assert callable(sec[2]), 'content must be the callable'",
      "# A child session renders empty even with the bins missing (fail open).",
      "assert deep_horizon._section_text({'session_id': 'x', 'cwd': '/tmp', 'parent_session_id': 'p'}) == ''",
      "# The subagent guard returns before cwd resolution: nothing is stashed",
      "# for it, so its (never-firing) finalize can never inherit a cwd.",
      "assert 'x' not in deep_horizon._session_cwd, 'subagent renders must not stash a cwd'",
      "# The finalize handler swallows a spawn failure (fail open). Stripping",
      "# PATH does NOT hide the bins here — _spawn_bin prefers the repo's own",
      "# bin/ dir in a checkout — so simulate the unresolvable bin directly.",
      "import inspect",
      "fin = [c for c in calls if c[0] == 'hook' and c[1] == 'on_session_finalize'][0][2]",
      "assert inspect.iscoroutinefunction(fin) or callable(fin)",
      "def _boom(bin_name, args):",
      "    raise FileNotFoundError(bin_name)",
      "deep_horizon._spawn_bin = _boom",
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
    assert.ok(first.message.content.includes("gap-1  End-to-end pi gap"));
    assert.ok(first.message.content.includes("`horizon detail <id>` prints it"), "the pi path must carry the core's detail pointer");
    assert.equal(first.message.customType, "deep-horizon");
    // The bootstrap-nudge twin: empty store still injects the nudge (composition, not gap-detection).
    const empty = freshDir();
    try {
      seed(empty, []);
      const registered2 = mod.apply({});
      await registered2["session_start"]({ reason: "startup" }, { cwd: empty });
      const out = await registered2["before_agent_start"]({ prompt: "go" }, {});
      assert.ok(out.message.content.startsWith("This project has no horizon yet"));
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

test("62. the Hermes section falls back to the process cwd when the core hands an empty cwd", () => {
  // _plugin_session_info() sets cwd=str(resolve_context_cwd() or ""), and
  // resolve_context_cwd() returns None when terminal.cwd is unset. The runtime
  // docstring says the local CLI "leaves it unset and relies on the launch dir",
  // but that launch-dir fallback lives in resolve_agent_cwd(), NOT in
  // resolve_context_cwd() — so the plugin is handed cwd="". Injecting nothing
  // there means a session launched from a project root silently loses its
  // horizon. The section falls back to the process working directory instead.
  const dir = freshDir();
  try {
    seed(dir, ["Hermes cwd fallback gap"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "text = deep_horizon._section_text({'session_id': 's-1', 'cwd': '', 'model': 'm', 'platform': 'cli', 'profile_name': 'dev'})",
      "sys.stdout.write(text)",
      "",
    ].join("\n"));
    const r = runPython([script], { cwd: dir });
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.ok(r.stdout.startsWith("This project has a horizon"),
      `empty cwd must fall back to the process cwd, got: ${JSON.stringify(r.stdout.slice(0, 80))}`);
    assert.ok(r.stdout.includes("Hermes cwd fallback gap"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("63. the Hermes section suppresses injection for every subagent discriminator the core could expose, plus HORIZON_SUBAGENT", () => {
  // The live mapping exposes only session_id/model/provider/platform/
  // profile_name/cwd — no parent_session_id. So the guard must accept any of the
  // conventions the core might adopt (parent_session_id, is_subagent,
  // delegation_depth, origin) AND an explicit env opt-out mirroring the pi
  // adapter, rather than depending on the single key that never arrives.
  const dir = freshDir();
  try {
    seed(dir, ["Hermes subagent gap"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import os, sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "base = {'session_id': 's-1', 'cwd': " + JSON.stringify(dir) + ", 'model': 'm', 'platform': 'cli', 'profile_name': 'dev'}",
      "assert deep_horizon._section_text(base), 'top-level session must receive the horizon'",
      "for key, val in (('parent_session_id', 'p'), ('is_subagent', True), ('delegation_depth', 1), ('origin', 'subagent')):",
      "    info = dict(base, **{key: val})",
      "    assert deep_horizon._section_text(info) == '', 'discriminator %s must render empty' % key",
      "os.environ['HORIZON_SUBAGENT'] = '1'",
      "assert deep_horizon._section_text(base) == '', 'HORIZON_SUBAGENT=1 must render empty'",
      "os.environ['HORIZON_SUBAGENT'] = '0'",
      "assert deep_horizon._section_text(base), 'HORIZON_SUBAGENT=0 must still inject'",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("64. the Hermes section never raises with no store and an empty cwd — it returns the bootstrap nudge", () => {
  const dir = freshDir();
  try {
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "text = deep_horizon._section_text({'session_id': 's-1', 'cwd': '', 'model': 'm', 'platform': 'cli', 'profile_name': 'dev'})",
      "sys.stdout.write(text)",
      "",
    ].join("\n"));
    const r = runPython([script], { cwd: dir });
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.ok(r.stdout.includes("This project has no horizon yet"),
      `no store must yield the nudge, not silence: ${JSON.stringify(r.stdout.slice(0, 80))}`);
    assert.ok(r.stdout.length < 4000, "the nudge must fit the cap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("65. the Hermes plugin loads under the real directory-plugin contract: __init__.py exporting register()", () => {
  // hermes_cli/plugins_loader.py:429-431 requires __init__.py inside the plugin
  // directory (a bare module file cannot be imported that way), and :302 then does
  // getattr(module, "register", None) and calls register(PluginContext). Shipping
  // only deep_horizon.py + plugin.yaml makes `hermes plugins doctor` fail with
  // "No __init__.py" and silently disables the whole Hermes adapter.
  assert.ok(existsSync(join(HERMES_PLUGIN_DIR, "__init__.py")),
    "the plugin directory must ship __init__.py or Hermes cannot register it");
  const dir = freshDir();
  try {
    const script = join(dir, "drive.py");
    // Faithful reproduction of _load_directory_module: import __init__.py as
    // hermes_plugins.<slug> with the plugin dir as the package search path.
    writeFileSync(script, [
      "import importlib.util, sys, types",
      "plugin_dir = " + JSON.stringify(HERMES_PLUGIN_DIR),
      "init_file = plugin_dir + '/__init__.py'",
      "ns = types.ModuleType('hermes_plugins')",
      "ns.__path__ = []",
      "ns.__package__ = 'hermes_plugins'",
      "sys.modules['hermes_plugins'] = ns",
      "name = 'hermes_plugins.deep_horizon'",
      "spec = importlib.util.spec_from_file_location(name, init_file, submodule_search_locations=[plugin_dir])",
      "mod = importlib.util.module_from_spec(spec)",
      "mod.__package__ = name",
      "mod.__path__ = [plugin_dir]",
      "sys.modules[name] = mod",
      "spec.loader.exec_module(mod)",
      "register = getattr(mod, 'register', None)",
      "assert register is not None, 'no register() reachable from __init__.py'",
      "calls = []",
      "class Ctx:",
      "    def register_system_prompt_section(self, i, c, **kw): calls.append(('section', i, c, kw))",
      "    def register_hook(self, n, cb): calls.append(('hook', n, cb))",
      "register(Ctx())",
      "assert [c[0] for c in calls].count('section') == 1, calls",
      "hooks = sorted(c[1] for c in calls if c[0] == 'hook')",
      "assert hooks == ['on_session_finalize', 'pre_llm_call'], hooks",
      "assert callable([c for c in calls if c[0] == 'section'][0][2]), 'section content must stay callable'",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("66. every hook the Hermes plugin registers is declared in plugin.yaml provides_hooks", () => {
  // `hermes plugins doctor` WARNs when register() subscribes to a hook the
  // manifest does not declare, and ERRORS when a declared hook name is not in
  // VALID_HOOKS. Declaring the close hook makes the manifest a truthful contract
  // rather than documentation.
  const dir = freshDir();
  try {
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import re, sys",
      "plugin_dir = " + JSON.stringify(HERMES_PLUGIN_DIR),
      "sys.path.insert(0, plugin_dir)",
      "import deep_horizon",
      "calls = []",
      "class Ctx:",
      "    def register_system_prompt_section(self, i, c, **kw): calls.append(('section', i))",
      "    def register_hook(self, n, cb): calls.append(('hook', n))",
      "deep_horizon.register(Ctx())",
      "registered = {c[1] for c in calls if c[0] == 'hook'}",
      "assert registered, 'the plugin must register at least the close hook'",
      "manifest = open(plugin_dir + '/plugin.yaml', encoding='utf-8').read()",
      "m = re.search(r'provides_hooks:\\s*(?:\\[(?P<inline>[^\\]]*)\\]|(?P<block>(?:\\s*-\\s*[A-Za-z0-9_]+\\s*)+))', manifest)",
      "assert m, 'plugin.yaml must declare provides_hooks'",
      "if m.group('inline') is not None:",
      "    declared = {n.strip() for n in m.group('inline').split(',') if n.strip()}",
      "else:",
      "    declared = set(re.findall(r'-\\s*([A-Za-z0-9_]+)', m.group('block')))",
      "assert declared == registered, 'manifest declares %s but register() subscribes %s' % (sorted(declared), sorted(registered))",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("68. the Hermes pre_llm_call hook injects the block only for NEW tool-call params touching a stored repo", () => {
  // Locked design: scan assistant tool_calls (PARAMS only, delta since the last
  // call) for /home/andre/git/<repo> paths. Tool RESULTS and user text are
  // never scanned. No store -> silence (nudge never fires from params).
  // parent_session_id set -> skip. Same (session, repo) twice -> once.
  const dir = freshDir();
  try {
    const alpha = join(dir, "alpha");
    const beta = join(dir, "beta");
    seed(alpha, ["alpha gap"]);
    seed(beta, ["beta gap"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import json, sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "import os",
      "os.environ['HORIZON_GIT_ROOT'] = " + JSON.stringify(dir + "/"),
      "deep_horizon._seen.clear()",
      "deep_horizon._scanned.clear()",
      "def call(session, history, **kw):",
      "    return deep_horizon._pre_llm_call(session_id=session, conversation_history=history, **kw)",
      "alpha = " + JSON.stringify(alpha),
      "beta = " + JSON.stringify(beta),
      "# Positive: terminal command string with git -C.",
      "r = call('s-a', [], user_message='go', terminal_cwd='/tmp')",
      "assert r == '' or r is None or (isinstance(r, dict) and not r.get('context')), 'no tool touch yet: %r' % (r,)",
      "hist1 = [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c1', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'git -C ' + alpha + ' status'})}},",
      "]}]",
      "r = call('s-a', hist1, user_message='go', terminal_cwd='/tmp')",
      "ctx = r.get('context', '') if isinstance(r, dict) else (r or '')",
      "assert 'alpha gap' in ctx, 'git -C touch must inject alpha: %r' % (ctx[:80],)",
      "# Delta: same history again injects nothing (already seen).",
      "r = call('s-a', hist1, user_message='go', terminal_cwd='/tmp')",
      "ctx = r.get('context', '') if isinstance(r, dict) else (r or '')",
      "assert not ctx, 'repeat history must not re-inject: %r' % (ctx[:80],)",
      "# Distinct repo on the next delta injects its own block.",
      "hist2 = hist1 + [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c2', 'function': {'name': 'read_file', 'arguments': json.dumps({'path': beta + '/notes.md'})}},",
      "]}]",
      "r = call('s-a', hist2, user_message='go', terminal_cwd='/tmp')",
      "ctx = r.get('context', '') if isinstance(r, dict) else (r or '')",
      "assert 'beta gap' in ctx, 'read_file touch must inject beta: %r' % (ctx[:80],)",
      "# workdir arg + cd inside the command string.",
      "hist3 = hist2 + [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c3', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'cd ' + alpha + ' && ls', 'workdir': beta})}},",
      "]}]",
      "# A fresh session always fires turn 1 with an empty history (HL-22f",
      "# skip-on-first-sight: a first fire already carrying a full history is",
      "# the restart-resume shape and must consume silently, so seed the",
      "# turn-1 fire before the delta).",
      "r = call('s-b', [], user_message='go', terminal_cwd='/tmp')",
      "ctx = r.get('context', '') if isinstance(r, dict) else (r or '')",
      "assert not ctx, 'turn-1 empty history must inject nothing: %r' % (ctx[:80],)",
      "r = call('s-b', hist3, user_message='go', terminal_cwd='/tmp')",
      "ctx = r.get('context', '') if isinstance(r, dict) else (r or '')",
      "assert 'alpha gap' in ctx and 'beta gap' in ctx, 'fresh session sees both repos: %r' % (ctx[:120],)",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("69. the Hermes pre_llm_call hook ignores tool results, user text, unknown tools, and store-less repos", () => {
  const dir = freshDir();
  try {
    const repo = join(dir, "repo");
    seed(repo, ["repo gap"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import json, sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "import os",
      "os.environ['HORIZON_GIT_ROOT'] = " + JSON.stringify(dir + "/"),
      "deep_horizon._seen.clear()",
      "deep_horizon._scanned.clear()",
      "def call(session, history, **kw):",
      "    return deep_horizon._pre_llm_call(session_id=session, conversation_history=history, **kw)",
      "repo = " + JSON.stringify(repo),
      "# Tool RESULT carrying a repo path: params carry nothing -> silence.",
      "hist = [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c1', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'ls /tmp'})}},",
      "]}, {'role': 'tool', 'content': 'files under ' + repo + ': a, b, c'}]",
      "r = call('s-neg', hist, user_message='go')",
      "ctx = r.get('context', '') if isinstance(r, dict) else (r or '')",
      "assert not ctx, 'tool results must never trigger: %r' % (ctx[:80],)",
      "# User message carrying a repo path: never scanned -> silence.",
      "r = call('s-neg', [], user_message='look at ' + repo + '/notes.md')",
      "ctx = r.get('context', '') if isinstance(r, dict) else (r or '')",
      "assert not ctx, 'user text must never trigger: %r' % (ctx[:80],)",
      "# Unknown tool (mcp_*, skill): params ignored.",
      "hist2 = [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c2', 'function': {'name': 'mcp__x__read', 'arguments': json.dumps({'path': repo + '/f'})}},",
      "]}]",
      "r = call('s-neg', hist2, user_message='go')",
      "ctx = r.get('context', '') if isinstance(r, dict) else (r or '')",
      "assert not ctx, 'unknown tools must be ignored: %r' % (ctx[:80],)",
      "# ~/git root without a store: silence, never the nudge.",
      "hist3 = [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c3', 'function': {'name': 'read_file', 'arguments': json.dumps({'path': os.environ['HORIZON_GIT_ROOT'] + 'nostore-xyz/README.md'})}},",
      "]}]",
      "r = call('s-neg', hist3, user_message='go')",
      "ctx = r.get('context', '') if isinstance(r, dict) else (r or '')",
      "assert not ctx, 'store-less repo must stay silent: %r' % (ctx[:80],)",
      "# parent_session_id set: subagent skip even with a real touch.",
      "hist4 = [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c4', 'function': {'name': 'read_file', 'arguments': json.dumps({'path': repo + '/notes.md'})}},",
      "]}]",
      "r = call('s-neg', hist4, user_message='go', parent_session_id='p-1')",
      "ctx = r.get('context', '') if isinstance(r, dict) else (r or '')",
      "assert not ctx, 'subagent must be skipped: %r' % (ctx[:80],)",
      "# First-turn launch-cwd repo: the frozen section owns it, not this hook.",
      "r = call('s-first', hist4, user_message='go', is_first_turn=True, terminal_cwd=repo)",
      "ctx = r.get('context', '') if isinstance(r, dict) else (r or '')",
      "assert not ctx, 'first-turn frozen repo must not duplicate: %r' % (ctx[:80],)",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("70. the Hermes pre_llm_call hook survives a simulated gateway restart: the restored history is consumed silently and new touches still inject", () => {
  // DEF-A1: the per-session state (_seen, _scanned) dies with the gateway
  // process. A resumed session's first post-restart fire carries the FULL
  // restored history with an empty cursor, so the old delta logic
  // reclassified every historical touch as new and RE-INJECTED the block the
  // persisted sidecar already restored (it then existed twice in context).
  // Skip-on-first-sight consumes that history silently instead; the cursor
  // still advances past it, so the next real touch keeps working.
  const dir = freshDir();
  try {
    const alpha = join(dir, "alpha");
    const beta = join(dir, "beta");
    seed(alpha, ["alpha gap"]);
    seed(beta, ["beta gap"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import json, sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "import os",
      "os.environ['HORIZON_GIT_ROOT'] = " + JSON.stringify(dir + "/"),
      "deep_horizon._seen.clear()",
      "deep_horizon._scanned.clear()",
      "def ctx(r):",
      "    return r.get('context', '') if isinstance(r, dict) else (r or '')",
      "def call(session, history, **kw):",
      "    return ctx(deep_horizon._pre_llm_call(session_id=session, conversation_history=history, **kw))",
      "alpha = " + JSON.stringify(alpha),
      "beta = " + JSON.stringify(beta),
      "hist1 = [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c1', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'git -C ' + alpha + ' status'})}},",
      "]}]",
      "hist2 = hist1 + [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c2', 'function': {'name': 'read_file', 'arguments': json.dumps({'path': beta + '/notes.md'})}},",
      "]}]",
      "# Pre-restart behavior: turn 1 empty, the alpha touch injects.",
      "assert not call('s-r', [], user_message='go'), 'turn 1 must inject nothing'",
      "c = call('s-r', hist1, user_message='go')",
      "assert 'alpha gap' in c, 'pre-restart alpha touch must inject: %r' % (c[:80],)",
      "# SIMULATED RESTART: clearing both dicts is exactly what a gateway",
      "# restart produces; the same full history comes back from persistence.",
      "deep_horizon._seen.clear()",
      "deep_horizon._scanned.clear()",
      "c = call('s-r', hist1, user_message='go')",
      "assert not c, 'post-restart resume must NOT re-inject: %r' % (c[:80],)",
      "# The cursor advanced past the restored history: a NEW touch works,",
      "# and alpha does not re-appear alongside it.",
      "c = call('s-r', hist2, user_message='go')",
      "assert 'beta gap' in c, 'post-restart new touch must inject beta: %r' % (c[:80],)",
      "assert 'alpha gap' not in c, 'restored alpha must not re-appear: %r' % (c[:120],)",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("71. the Hermes pre_llm_call hook survives turn-start compaction: the shrink guard rescans a shrunken history so the post-compaction touch still injects", () => {
  // DEF-A2: Hermes turn-start compaction REWRITES conversation_history below
  // the _scanned cursor, so the old delta logic skipped the re-indexed new
  // touch (under-injection, once per compaction event). The shrink guard
  // treats a fire whose history holds fewer tool_calls than the cursor as a
  // rescan from zero; _seen keeps already-injected repos silent, so only the
  // post-compaction touch can land.
  const dir = freshDir();
  try {
    const alpha = join(dir, "alpha");
    const beta = join(dir, "beta");
    seed(alpha, ["alpha gap"]);
    seed(beta, ["beta gap"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import json, sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "import os",
      "os.environ['HORIZON_GIT_ROOT'] = " + JSON.stringify(dir + "/"),
      "deep_horizon._seen.clear()",
      "deep_horizon._scanned.clear()",
      "def ctx(r):",
      "    return r.get('context', '') if isinstance(r, dict) else (r or '')",
      "def call(session, history, **kw):",
      "    return ctx(deep_horizon._pre_llm_call(session_id=session, conversation_history=history, **kw))",
      "alpha = " + JSON.stringify(alpha),
      "beta = " + JSON.stringify(beta),
      "# hist1 carries two tool_calls (a non-repo filler + the alpha touch),",
      "# so the cursor sits at 2 — above anything a one-call compaction keeps.",
      "hist1 = [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c1', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'ls /tmp'})}},",
      "    {'id': 'c2', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'git -C ' + alpha + ' status'})}},",
      "]}]",
      "assert not call('s-c', [], user_message='go'), 'turn 1 must inject nothing'",
      "c = call('s-c', hist1, user_message='go')",
      "assert 'alpha gap' in c, 'alpha touch must inject: %r' % (c[:80],)",
      "# Compaction rewrite: the shrunken history holds only the beta call",
      "# (fewer tool_calls than the stored cursor).",
      "shrunk = [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c3', 'function': {'name': 'read_file', 'arguments': json.dumps({'path': beta + '/notes.md'})}},",
      "]}]",
      "c = call('s-c', shrunk, user_message='go')",
      "assert 'beta gap' in c, 'post-compaction touch must still inject: %r' % (c[:80],)",
      "assert 'alpha gap' not in c, 'alpha must not re-inject (_seen holds it): %r' % (c[:120],)",
      "# Normal delta behavior resumes on the same shrunken history.",
      "c = call('s-c', shrunk, user_message='go')",
      "assert not c, 'repeat shrunken history must not re-inject: %r' % (c[:80],)",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("72. the once-per-(session, repo) invariant holds across simulated gateway restarts", () => {
  // Restart-resume end to end: every fire's context is recorded, and each
  // repo's block must appear EXACTLY ONCE in the whole stream — never
  // re-injected by a post-restart resume, never duplicated by a fresh
  // touch of an already-seen repo.
  const dir = freshDir();
  try {
    const alpha = join(dir, "alpha");
    const beta = join(dir, "beta");
    seed(alpha, ["alpha gap"]);
    seed(beta, ["beta gap"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import json, sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "import os",
      "os.environ['HORIZON_GIT_ROOT'] = " + JSON.stringify(dir + "/"),
      "deep_horizon._seen.clear()",
      "deep_horizon._scanned.clear()",
      "stream = []",
      "def fire(session, history, **kw):",
      "    r = deep_horizon._pre_llm_call(session_id=session, conversation_history=history, **kw)",
      "    c = r.get('context', '') if isinstance(r, dict) else (r or '')",
      "    stream.append(c)",
      "    return c",
      "def restart():",
      "    deep_horizon._seen.clear()",
      "    deep_horizon._scanned.clear()",
      "alpha = " + JSON.stringify(alpha),
      "beta = " + JSON.stringify(beta),
      "alpha_hist = [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c1', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'git -C ' + alpha + ' status'})}},",
      "]}]",
      "both_hist = alpha_hist + [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c2', 'function': {'name': 'read_file', 'arguments': json.dumps({'path': beta + '/notes.md'})}},",
      "]}]",
      "# touch alpha -> inject.",
      "assert not fire('s-i', [], user_message='go'), 'turn 1 must inject nothing'",
      "assert 'alpha gap' in fire('s-i', alpha_hist, user_message='go'), 'alpha must inject once'",
      "# simulated restart; same history -> no inject.",
      "restart()",
      "assert not fire('s-i', alpha_hist, user_message='go'), 'resume must not re-inject alpha'",
      "# touch beta -> inject beta only.",
      "assert 'beta gap' in fire('s-i', both_hist, user_message='go'), 'beta must inject once'",
      "assert 'alpha gap' not in stream[-1], 'alpha must not re-appear with beta'",
      "# simulated restart; full history -> no inject.",
      "restart()",
      "assert not fire('s-i', both_hist, user_message='go'), 'resume must not re-inject either repo'",
      "alpha_hits = sum(1 for c in stream if 'alpha gap' in c)",
      "beta_hits = sum(1 for c in stream if 'beta gap' in c)",
      "assert alpha_hits == 1, 'alpha block must appear exactly once, got %d: %r' % (alpha_hits, stream,)",
      "assert beta_hits == 1, 'beta block must appear exactly once, got %d: %r' % (beta_hits, stream,)",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("67. the section renders for the read-only mapping the core actually passes", () => {
  // hermes_cli/plugins_dispatch.py:396 builds the object the callable receives:
  //     frozen_info = types.MappingProxyType(dict(session_info))
  // `isinstance(MappingProxyType({...}), dict)` is False, so a dict-only guard
  // returns "" in production while every plain-dict unit test keeps passing —
  // the section then renders into exactly zero real sessions.
  const dir = freshDir();
  try {
    const proj = join(dir, "proj");
    seed(proj, ["ship deep-horizon to npm"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import sys, types",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "info = {'session_id': 's1', 'model': 'm', 'provider': 'p', 'platform': 'cli',",
      "        'profile_name': 'default', 'cwd': " + JSON.stringify(proj) + "}",
      "frozen = types.MappingProxyType(dict(info))  # exactly what the core passes",
      "out = deep_horizon._section_text(frozen)",
      "assert isinstance(out, str), 'section must return str, got %s' % type(out).__name__",
      "assert out.strip(), 'section returned nothing for the core read-only mapping'",
      "assert 'gap-1' in out, 'gap id missing from the rendered block'",
      "assert len(out) < 4000, 'the block must fit the registered cap'",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("73. the Hermes section distrusts a storeless session cwd: the launch dir's store wins (terminal.cwd '.' resolves to the home fallback)", () => {
  // The live bug: hermes config carries terminal.cwd: "." (a placeholder), so
  // the core resolves the session cwd to the home fallback /home/andre —
  // non-empty but wrong. Trusting it verbatim spawned horizon-inject in a dir
  // with no store, which injected the nudge: the project's about line and gaps
  // never landed. The fix: a non-empty session cwd with no VISIBLE store is
  // distrusted, and the process cwd (the launch dir) wins when it has one.
  const dir = freshDir();
  try {
    const launch = join(dir, "launch");
    const sessionCwd = join(dir, "session-cwd");
    mkdirSync(launch, { recursive: true });
    mkdirSync(sessionCwd, { recursive: true });
    seed(launch, ["launch dir gap"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "text = deep_horizon._section_text({'session_id': 's-1', 'cwd': " + JSON.stringify(sessionCwd) + ", 'model': 'm', 'platform': 'cli', 'profile_name': 'dev'})",
      "sys.stdout.write(text)",
      "",
    ].join("\n"));
    const r = runPython([script], { cwd: launch });
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.ok(r.stdout.startsWith("This project has a horizon"),
      `storeless session cwd must defer to the launch dir's store, got: ${JSON.stringify(r.stdout.slice(0, 80))}`);
    assert.ok(r.stdout.includes("launch dir gap"), "the injection must be composed from the launch dir's store");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("74. the Hermes section prefers the session cwd when it has a store, even if the launch dir also has one", () => {
  const dir = freshDir();
  try {
    const launch = join(dir, "launch");
    const sessionCwd = join(dir, "session-cwd");
    mkdirSync(launch, { recursive: true });
    mkdirSync(sessionCwd, { recursive: true });
    seed(launch, ["launch dir gap"]);
    seed(sessionCwd, ["session cwd gap"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "text = deep_horizon._section_text({'session_id': 's-1', 'cwd': " + JSON.stringify(sessionCwd) + ", 'model': 'm', 'platform': 'cli', 'profile_name': 'dev'})",
      "sys.stdout.write(text)",
      "",
    ].join("\n"));
    const r = runPython([script], { cwd: launch });
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.ok(r.stdout.includes("session cwd gap"), "a stored session cwd must win");
    assert.ok(!r.stdout.includes("launch dir gap"), "the launch dir's store must not bleed into a stored session cwd's block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("75. the Hermes section keeps the first candidate when neither cwd has a store — the bootstrap nudge for the session cwd, not silence", () => {
  // A genuinely storeless project dir must still get its nudge (that is
  // correct behavior), and the first candidate (the session cwd) stands —
  // the launch dir never hijacks a storeless session.
  const dir = freshDir();
  try {
    const launch = join(dir, "launch");
    const sessionCwd = join(dir, "session-cwd");
    mkdirSync(launch, { recursive: true });
    mkdirSync(sessionCwd, { recursive: true });
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "assert deep_horizon._resolve_horizon_cwd(" + JSON.stringify(sessionCwd) + ") == " + JSON.stringify(sessionCwd) + ", 'storeless: first candidate stands'",
      "text = deep_horizon._section_text({'session_id': 's-1', 'cwd': " + JSON.stringify(sessionCwd) + ", 'model': 'm', 'platform': 'cli', 'profile_name': 'dev'})",
      "sys.stdout.write(text)",
      "",
    ].join("\n"));
    const r = runPython([script], { cwd: launch });
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.ok(r.stdout.includes("This project has no horizon yet"),
      `both storeless must yield the nudge, got: ${JSON.stringify(r.stdout.slice(0, 80))}`);
    assert.ok(r.stdout.length < 4000, "the nudge must fit the cap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("76. the Hermes session-end spawn resolves --cwd with the same rule: the launch dir's store wins, the first candidate otherwise", () => {
  // The close record must land in the store the session actually injected
  // from. Without --cwd the bin would resolve from the gateway's own working
  // directory instead, so the finalize hook passes the _resolve_horizon_cwd
  // result explicitly.
  const dir = freshDir();
  try {
    const launch = join(dir, "launch");
    const sessionCwd = join(dir, "session-cwd");
    const other = join(dir, "other");
    mkdirSync(launch, { recursive: true });
    mkdirSync(sessionCwd, { recursive: true });
    mkdirSync(other, { recursive: true });
    seed(launch, ["launch dir gap"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "spawns = []",
      "def fake_spawn(bin_name, args):",
      "    spawns.append((bin_name, list(args)))",
      "    return (0, '', '')",
      "deep_horizon._spawn_bin = fake_spawn",
      "def ran_args():",
      "    assert len(spawns) == 1, spawns",
      "    name, args = spawns[0]",
      "    assert name == 'horizon', name",
      "    assert args[:3] == ['session-end', '--harness', 'hermes'], args",
      "    i = args.index('--cwd')",
      "    assert args[args.index('--session') + 1] == 's-end', args",
      "    return args[i + 1]",
      "# Storeless session cwd + stored launch dir: the launch dir wins.",
      "deep_horizon._on_session_finalize({'session_id': 's-end', 'cwd': " + JSON.stringify(sessionCwd) + ", 'reason': 'shutdown'})",
      "assert ran_args() == " + JSON.stringify(launch) + ", 'session-end must spawn --cwd <launch dir>'",
      "# Both storeless: the first candidate (the session cwd) stands.",
      "import os",
      "os.chdir(" + JSON.stringify(other) + ")",
      "spawns.clear()",
      "deep_horizon._on_session_finalize({'session_id': 's-end', 'cwd': " + JSON.stringify(sessionCwd) + ", 'reason': 'shutdown'})",
      "assert ran_args() == " + JSON.stringify(sessionCwd) + ", 'storeless: session-end must spawn --cwd <session cwd>'",
      "# No cwd in the payload at all: the process cwd is the only candidate.",
      "os.chdir(" + JSON.stringify(launch) + ")",
      "spawns.clear()",
      "deep_horizon._on_session_finalize({'session_id': 's-end', 'reason': 'shutdown'})",
      "assert ran_args() == " + JSON.stringify(launch) + ", 'cwd-less payload must spawn --cwd <process cwd>'",
      "# The stash: the section freezes the resolved cwd per session, so a",
      "# cwd-less finalize (the real -z payload) uses the FROZEN cwd, not the",
      "# exit-time process cwd. Simulate the -z shape: section rendered for a",
      "# storeless session cwd from the stored launch dir, then chdir away,",
      "# then finalize with no cwd key at all.",
      "deep_horizon._section_text({'session_id': 's-stash', 'cwd': " + JSON.stringify(sessionCwd) + "})",
      "os.chdir(" + JSON.stringify(other) + ")",
      "spawns.clear()",
      "deep_horizon._on_session_finalize({'session_id': 's-stash', 'reason': 'shutdown'})",
      "assert len(spawns) == 1, spawns",
      "_n, _a = spawns[0]",
      "assert _a[_a.index('--session') + 1] == 's-stash', _a",
      "assert _a[_a.index('--cwd') + 1] == " + JSON.stringify(launch) + ", 'cwd-less finalize must use the section-frozen cwd, not ' + os.getcwd()",
      "# Pop-on-use: the stash entry is consumed by that finalize, so a",
      "# second one for the same id takes the payload/process fallback.",
      "spawns.clear()",
      "deep_horizon._on_session_finalize({'session_id': 's-stash', 'reason': 'shutdown'})",
      "assert len(spawns) == 1, spawns",
      "_n, _a = spawns[0]",
      "assert _a[_a.index('--cwd') + 1] == " + JSON.stringify(other) + ", 'the stash must pop on use: the second finalize falls back to the process cwd'",
      "# An unseen session id still takes the payload/process fallback.",
      "spawns.clear()",
      "deep_horizon._on_session_finalize({'session_id': 's-unseen', 'reason': 'shutdown'})",
      "assert len(spawns) == 1, spawns",
      "_n, _a = spawns[0]",
      "assert _a[_a.index('--cwd') + 1] == " + JSON.stringify(other) + ", 'unseen session falls back to the process cwd'",
      "# The REAL dispatcher shape: flat kwargs, no payload dict — plugins_dispatch",
      "# calls callback(**flat) with session_id/platform/reason as keywords. The",
      "# exact -z production path: section frozen from the stored launch dir,",
      "# process chdir'd away, finalize arrives as keywords only.",
      "os.chdir(" + JSON.stringify(launch) + ")",
      "deep_horizon._section_text({'session_id': 's-flat', 'cwd': " + JSON.stringify(sessionCwd) + "})",
      "os.chdir(" + JSON.stringify(other) + ")",
      "spawns.clear()",
      "deep_horizon._on_session_finalize(session_id='s-flat', platform='cli', reason='shutdown')",
      "assert len(spawns) == 1, spawns",
      "_n, _a = spawns[0]",
      "assert _a[_a.index('--session') + 1] == 's-flat', _a",
      "assert _a[_a.index('--cwd') + 1] == " + JSON.stringify(launch) + ", 'flat-kwargs finalize must read session_id and use the section-frozen cwd'",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script], { cwd: launch });
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
