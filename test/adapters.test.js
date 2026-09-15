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
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seed, withDir } from "./harness.js";

const ROOT = new URL("..", import.meta.url).pathname;
const PI_ADAPTER = new URL("../src/adapters/pi.ts", import.meta.url).pathname;
const OPENCODE_ADAPTER = new URL("../src/adapters/opencode.ts", import.meta.url).pathname;
const SUPPORT_ADAPTER = new URL("../src/adapters/support.ts", import.meta.url).pathname;
const HERMES_PLUGIN_DIR = join(ROOT, "adapters", "hermes");


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

test("52. the Hermes section callable spawns horizon-inject --harness hermes and returns its stdout; caps fail open", async () => {
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("53. the Hermes section returns empty text for subagent sessions (parent_session_id set) and renders under the 4000-char cap at the 5x512 worst case", async () => {
  await withDir(async (dir) => {
    // Exactly 512 code points per title (510 + " " + one digit) — the real
    // worst case; the old hand-written seed wrote 514-point texts the CLI
    // itself would have rejected.
    seed(dir, Array.from({ length: 5 }, (_, i) => "g".repeat(510) + " " + i));
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
  }, "horizon-adapter-test-");
});

test("54. the Hermes plugin register() wires the section, the finalize hook, and fails open when the bins are missing", async () => {
  await withDir(async (dir) => {
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
      "# for it, so its (never-firing) finalize can never inherit a store.",
      "assert 'x' not in deep_horizon._session_store, 'subagent renders must not stash a store'",
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
  }, "horizon-adapter-test-");
});

// --- pi adapter ---

test("55. the pi adapter: session_start shells out and stashes only on fresh reasons, before_agent_start returns the message on the first prompt", async () => {
  await withDir(async (dir) => {
    const mod = await import(PI_ADAPTER);
    seed(dir, ["pi adapter gap"]);
    const calls = [];
    const registered = mod.apply({}, {
      spawnBin: (bin, args) => {
        calls.push({ bin, args });
        return { status: 0, stdout: JSON.stringify({ text: "PI-MOCK-BLOCK", store: join(dir, ".horizon") }), stderr: "" };
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
  }, "horizon-adapter-test-");
});

test("56. the pi adapter guards: resume/reload/fork reasons never stash; HORIZON_SUBAGENT fails open; nonzero spawn injects nothing", async () => {
  await withDir(async (dir) => {
    const mod = await import(PI_ADAPTER);
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
  }, "horizon-adapter-test-");
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

// The close hook hands back the store the startup --json answer resolved:
// teardown never re-discovers (the harness process may have chdir'd since).
test("pi-store-handoff. --store rides from the startup answer to session_shutdown, delivered or not; storeless closes keep the plain form", async () => {
  const mod = await import(PI_ADAPTER);
  const calls = [];
  const registered = mod.apply({}, {
    spawnBin: (bin, args) => {
      calls.push({ bin, args });
      return { status: 0, stdout: JSON.stringify({ text: "PI-JSON-BLOCK", store: "/pi-store" }), stderr: "" };
    },
  });
  await registered["session_start"]({ reason: "startup" }, { cwd: "/proj", sessionManager: { getSessionId: () => "pi-s-1" } });
  const first = await registered["before_agent_start"]({ prompt: "go" }, {});
  assert.equal(first.message.content, "PI-JSON-BLOCK");
  // The text stash is consumed by the first prompt, but the store survives
  // it and reaches the close hook.
  await registered["session_shutdown"]({ reason: "quit" }, { sessionManager: { getSessionId: () => "pi-s-1" } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ["session-end", "--harness", "pi", "--session", "pi-s-1", "--store", "/pi-store"]);
  // Storeless startup: nothing to hand back, the close keeps its
  // cwd-discovery form.
  const calls2 = [];
  const registered2 = mod.apply({}, {
    spawnBin: (bin, args) => {
      calls2.push({ bin, args });
      return { status: 0, stdout: JSON.stringify({ text: "NUDGE", store: null }), stderr: "" };
    },
  });
  await registered2["session_start"]({ reason: "startup" }, { cwd: "/proj", sessionManager: { getSessionId: () => "pi-s-2" } });
  await registered2["before_agent_start"]({ prompt: "go" }, {});
  await registered2["session_shutdown"]({ reason: "quit" }, { sessionManager: { getSessionId: () => "pi-s-2" } });
  assert.deepEqual(calls2[1].args, ["session-end", "--harness", "pi", "--session", "pi-s-2"], "a storeless answer closes without --store");
  // Undelivered stash (shutdown before the first prompt) still closes with
  // the store.
  const calls3 = [];
  const registered3 = mod.apply({}, {
    spawnBin: (bin, args) => {
      calls3.push({ bin, args });
      return { status: 0, stdout: JSON.stringify({ text: "NEVER-DELIVERED", store: "/undelivered-store" }), stderr: "" };
    },
  });
  await registered3["session_start"]({ reason: "startup" }, { cwd: "/proj", sessionManager: { getSessionId: () => "pi-s-3" } });
  await registered3["session_shutdown"]({ reason: "quit" }, {});
  assert.deepEqual(calls3[1].args, ["session-end", "--harness", "pi", "--session", "pi-s-3", "--store", "/undelivered-store"]);
});

test("58. the pi adapter end-to-end: startup stash flows the real horizon-inject block into the first prompt", async () => {
  await withDir(async (dir) => {
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
    await withDir(async (empty) => {
      seed(empty, []);
      const registered2 = mod.apply({});
      await registered2["session_start"]({ reason: "startup" }, { cwd: empty });
      const out = await registered2["before_agent_start"]({ prompt: "go" }, {});
      assert.ok(out.message.content.startsWith("This project has no horizon yet"));
    }, "horizon-adapter-test-");
  }, "horizon-adapter-test-");
});

// --- opencode adapter (DEGRADED, D4) ---

test("59. the opencode adapter prepends the block once per session on the heuristic and excludes subagents via parentID", async () => {
  await withDir(async (dir) => {
    const mod = await import(OPENCODE_ADAPTER);
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
  }, "horizon-adapter-test-");
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

test("62. the Hermes section falls back to the process cwd when the core hands an empty cwd", async () => {
  // _plugin_session_info() sets cwd=str(resolve_context_cwd() or ""), and
  // resolve_context_cwd() returns None when terminal.cwd is unset. The runtime
  // docstring says the local CLI "leaves it unset and relies on the launch dir",
  // but that launch-dir fallback lives in resolve_agent_cwd(), NOT in
  // resolve_context_cwd() — so the plugin is handed cwd="". Injecting nothing
  // there means a session launched from a project root silently loses its
  // horizon. The section falls back to the process working directory instead.
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("63. the Hermes section suppresses injection for every subagent discriminator the core could expose, plus HORIZON_SUBAGENT", async () => {
  // The live mapping exposes only session_id/model/provider/platform/
  // profile_name/cwd — no parent_session_id. So the guard must accept any of the
  // conventions the core might adopt (parent_session_id, is_subagent,
  // delegation_depth, origin) AND an explicit env opt-out mirroring the pi
  // adapter, rather than depending on the single key that never arrives.
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("64. the Hermes section never raises with no store and an empty cwd — it returns the bootstrap nudge", async () => {
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("65. the Hermes plugin loads under the real directory-plugin contract: __init__.py exporting register()", async () => {
  // hermes_cli/plugins_loader.py:429-431 requires __init__.py inside the plugin
  // directory (a bare module file cannot be imported that way), and :302 then does
  // getattr(module, "register", None) and calls register(PluginContext). Shipping
  // only deep_horizon.py + plugin.yaml makes `hermes plugins doctor` fail with
  // "No __init__.py" and silently disables the whole Hermes adapter.
  assert.ok(existsSync(join(HERMES_PLUGIN_DIR, "__init__.py")),
    "the plugin directory must ship __init__.py or Hermes cannot register it");
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("66. every hook the Hermes plugin registers is declared in plugin.yaml provides_hooks", async () => {
  // `hermes plugins doctor` WARNs when register() subscribes to a hook the
  // manifest does not declare, and ERRORS when a declared hook name is not in
  // VALID_HOOKS. Declaring the close hook makes the manifest a truthful contract
  // rather than documentation.
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("68. the Hermes pre_llm_call hook injects the block only for NEW tool-call params touching a stored repo", async () => {
  // Locked design: scan assistant tool_calls (PARAMS only, delta since the last
  // call) for /home/andre/git/<repo> paths. Tool RESULTS and user text are
  // never scanned. No store -> silence (nudge never fires from params).
  // parent_session_id set -> skip. Same (session, repo) twice -> once.
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("69. the Hermes pre_llm_call hook ignores tool results, user text, unknown tools, and store-less repos", async () => {
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("70. the Hermes pre_llm_call hook survives a simulated gateway restart: the restored history is consumed silently and new touches still inject", async () => {
  // DEF-A1: the per-session state (_seen, _scanned) dies with the gateway
  // process. A resumed session's first post-restart fire carries the FULL
  // restored history with an empty cursor, so the old delta logic
  // reclassified every historical touch as new and RE-INJECTED the block the
  // persisted sidecar already restored (it then existed twice in context).
  // Skip-on-first-sight consumes that history silently instead; the cursor
  // still advances past it, so the next real touch keeps working.
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("71. the Hermes pre_llm_call hook survives turn-start compaction: the shrink guard rescans a shrunken history so the post-compaction touch still injects", async () => {
  // DEF-A2: Hermes turn-start compaction REWRITES conversation_history below
  // the _scanned cursor, so the old delta logic skipped the re-indexed new
  // touch (under-injection, once per compaction event). The shrink guard
  // treats a fire whose history holds fewer tool_calls than the cursor as a
  // rescan from zero; _seen keeps already-injected repos silent, so only the
  // post-compaction touch can land.
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("72. the once-per-(session, repo) invariant holds across simulated gateway restarts", async () => {
  // Restart-resume end to end: every fire's context is recorded, and each
  // repo's block must appear EXACTLY ONCE in the whole stream — never
  // re-injected by a post-restart resume, never duplicated by a fresh
  // touch of an already-seen repo.
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("67. the section renders for the read-only mapping the core actually passes", async () => {
  // hermes_cli/plugins_dispatch.py:396 builds the object the callable receives:
  //     frozen_info = types.MappingProxyType(dict(session_info))
  // `isinstance(MappingProxyType({...}), dict)` is False, so a dict-only guard
  // returns "" in production while every plain-dict unit test keeps passing —
  // the section then renders into exactly zero real sessions.
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("73. the Hermes section distrusts a storeless session cwd: the launch dir's store wins (terminal.cwd '.' resolves to the home fallback)", async () => {
  // The live bug: hermes config carries terminal.cwd: "." (a placeholder), so
  // the core resolves the session cwd to the home fallback /home/andre —
  // non-empty but wrong. Trusting it verbatim spawned horizon-inject in a dir
  // with no store, which injected the nudge: the project's about line and gaps
  // never landed. The fix: a non-empty session cwd with no VISIBLE store is
  // distrusted, and the process cwd (the launch dir) wins when it has one.
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("74. the Hermes section prefers the session cwd when it has a store, even if the launch dir also has one", async () => {
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("75. the Hermes section keeps the first candidate when neither cwd has a store — the bootstrap nudge for the session cwd, not silence", async () => {
  // A genuinely storeless project dir must still get its nudge (that is
  // correct behavior), and the first candidate (the session cwd) stands —
  // the launch dir never hijacks a storeless session.
  await withDir(async (dir) => {
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
  }, "horizon-adapter-test-");
});

test("76. the Hermes session-end spawn hands back the stashed injection store with --store; the never-injected fallback keeps --cwd", async () => {
  // The close record must land in the store the session actually injected
  // from. The section freezes the --json answer's store per session; the
  // finalize hands it back with --store — immune to the missing payload cwd
  // and to any chdir since turn one. A session that never injected (no
  // stash) falls back to --cwd with the first candidate: payload cwd, else
  // the process cwd; session-end on a storeless cwd is a safe no-op.
  await withDir(async (dir) => {
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
      "# The section runs first, against the REAL bins, from the launch dir:",
      "# a storeless session cwd defers to the launch dir's store, and the",
      "# answer's store field is frozen for the close hook.",
      "deep_horizon._section_text({'session_id': 's-stash', 'cwd': " + JSON.stringify(sessionCwd) + "})",
      "assert deep_horizon._session_store.get('s-stash') == " + JSON.stringify(join(launch, ".horizon")) + ", deep_horizon._session_store",
      "# Now the spawn is fake, the process chdir'd away, and the finalize",
      "# arrives with no cwd key at all (the -z payload shape).",
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
      "    return args",
      "def run(session_id):",
      "    deep_horizon._on_session_finalize({'session_id': session_id, 'reason': 'shutdown'})",
      "    return ran_args()",
      "args = run('s-stash')",
      "assert args[args.index('--session') + 1] == 's-stash', args",
      "assert '--store' in args and args[args.index('--store') + 1] == " + JSON.stringify(join(launch, ".horizon")) + ", args",
      "assert '--cwd' not in args, 'a stashed store must not also carry --cwd: ' + str(args)",
      "# Pop-on-use: the stash entry is consumed by that finalize, so a",
      "# second one for the same id takes the payload/process fallback",
      "# (--cwd, never --store).",
      "import os",
      "os.chdir(" + JSON.stringify(other) + ")",
      "spawns.clear()",
      "args = run('s-stash')",
      "assert '--store' not in args, args",
      "assert args[args.index('--cwd') + 1] == " + JSON.stringify(other) + ", 'the stash must pop on use: the second finalize falls back to the process cwd'",
      "# An unseen session id takes the fallback with the first candidate:",
      "# a payload cwd (if a future core adds one) is trusted as-is.",
      "spawns.clear()",
      "deep_horizon._on_session_finalize({'session_id': 's-pay', 'cwd': " + JSON.stringify(sessionCwd) + ", 'reason': 'shutdown'})",
      "args = spawns[0][1]",
      "assert '--cwd' in args and args[args.index('--cwd') + 1] == " + JSON.stringify(sessionCwd) + ", args",
      "# The REAL dispatcher shape: flat kwargs, no payload dict, no cwd —",
      "# the process cwd stands.",
      "spawns.clear()",
      "deep_horizon._on_session_finalize(session_id='s-flat', platform='cli', reason='shutdown')",
      "args = spawns[0][1]",
      "assert '--cwd' in args and args[args.index('--cwd') + 1] == " + JSON.stringify(other) + ", args",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script], { cwd: launch });
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  }, "horizon-adapter-test-");
});

test("hermes-param-release. a failed or nonzero spawn releases the (session, repo) claim so the next touch retries; a storeless answer is remembered", async () => {
  // The once-per-(session, repo) contract aligned with dsh-param-9: the
  // claim is taken before the spawn and released on failure — one transient
  // failure must not silence a repo for the rest of the session. A
  // storeless --json answer, by contrast, is a total answer: the claim
  // holds and the repo never re-spawns.
  await withDir(async (dir) => {
    const repo = join(dir, "repo");
    seed(repo, ["hermes release gap"]);
    const script = join(dir, "drive.py");
    writeFileSync(script, [
      "import json, sys",
      "sys.path.insert(0, " + JSON.stringify(HERMES_PLUGIN_DIR) + ")",
      "import deep_horizon",
      "import os",
      "os.environ['HORIZON_GIT_ROOT'] = " + JSON.stringify(dir + "/"),
      "deep_horizon._seen.clear()",
      "deep_horizon._scanned.clear()",
      "repo = " + JSON.stringify(repo),
      "hist1 = [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c1', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'git -C ' + repo + ' status'})}},",
      "]}]",
      "hist2 = hist1 + [{'role': 'assistant', 'tool_calls': [",
      "    {'id': 'c2', 'function': {'name': 'read_file', 'arguments': json.dumps({'path': repo + '/notes.md'})}},",
      "]}]",
      "def ctx(r):",
      "    return r.get('context', '') if isinstance(r, dict) else (r or '')",
      "def first_sight():",
      "    return ctx(deep_horizon._pre_llm_call(session_id='s-rel', conversation_history=[]))",
      "def call(history):",
      "    return ctx(deep_horizon._pre_llm_call(session_id='s-rel', conversation_history=history))",
      "state = {'count': 0}",
      "def raising_spawn(bin_name, args):",
      "    state['count'] += 1",
      "    raise FileNotFoundError('transient')",
      "deep_horizon._spawn_bin = raising_spawn",
      "assert not first_sight(), 'turn 1 injects nothing'",
      "assert state['count'] == 0, 'turn 1 must not spawn'",
      "# The c1 touch claims the repo, the spawn fails, the claim releases.",
      "assert not call(hist1), 'a failed spawn injects nothing'",
      "assert state['count'] == 1, state",
      "assert ('s-rel', repo) not in deep_horizon._seen, 'a failed spawn must release the claim'",
      "# The retry: the NEXT touch (c2, the delta hook's retry unit) spawns",
      "# again and delivers — a transient failure never silenced the repo.",
      "def ok_spawn(bin_name, args):",
      "    state['count'] += 1",
      "    return (0, json.dumps({'text': 'RETRY-BLOCK', 'store': repo}), '')",
      "deep_horizon._spawn_bin = ok_spawn",
      "c = call(hist2)",
      "assert 'RETRY-BLOCK' in c, 'the released claim must allow the next touch to deliver: %r' % (c[:80],)",
      "assert state['count'] == 2, state",
      "# Once-per holds after delivery: the same history re-fires nothing.",
      "assert not call(hist2), 'a delivered repo must not re-inject'",
      "assert state['count'] == 2, 'a delivered repo must not re-spawn'",
      "# A nonzero exit releases the claim too.",
      "deep_horizon._seen.clear()",
      "deep_horizon._scanned.clear()",
      "state['count'] = 0",
      "def nonzero_spawn(bin_name, args):",
      "    state['count'] += 1",
      "    return (7, '', 'boom')",
      "deep_horizon._spawn_bin = nonzero_spawn",
      "assert not first_sight()",
      "assert not call(hist1)",
      "assert ('s-rel', repo) not in deep_horizon._seen, 'a nonzero exit must release the claim'",
      "# A storeless answer keeps its claim: remembered, never re-spawned.",
      "deep_horizon._seen.clear()",
      "deep_horizon._scanned.clear()",
      "state['count'] = 0",
      "def storeless_spawn(bin_name, args):",
      "    state['count'] += 1",
      "    return (0, json.dumps({'text': 'NUDGE-NOT-DELIVERED', 'store': None}), '')",
      "deep_horizon._spawn_bin = storeless_spawn",
      "assert not first_sight()",
      "assert not call(hist1), 'a storeless answer must stay silent on the param path'",
      "assert ('s-rel', repo) in deep_horizon._seen, 'a storeless answer keeps its claim'",
      "assert not call(hist1), 'a storeless repo must not re-spawn'",
      "assert state['count'] == 1, state",
      "print('OK')",
      "",
    ].join("\n"));
    const r = runPython([script]);
    assert.equal(r.code, 0, `python failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK");
  }, "horizon-adapter-test-");
});

// --- ZCode: adapters/zcode/ sh+jq hooks + the checked-in .zcode/config.json ---

const ZCODE_DIR = join(ROOT, "adapters", "zcode");

// The 0.4 marker home (ticket 04): ${XDG_CACHE_HOME:-$HOME/.cache}/
// deep-horizon/markers/horizon-zcode-<sid> — reboot durability matters now
// that session-start's reconciliation reads markers as the record of which
// sessions touched which stores.
function markerPath(cacheBase, sid) {
  return join(cacheBase, "deep-horizon", "markers", `horizon-zcode-${sid}`);
}

// The documented toolset as a COMPLETE PATH, the horizon bins deliberately
// absent: with horizon resolvable nowhere, the hooks' own bin resolution
// falls to this checkout's bin/ sibling — the zcode tests prove the
// worktree, not whatever ~/.local/bin's horizon symlinks point at today
// (they target the main checkout). Tests that count spawns instead win the
// resolution with a shim ahead of the real PATH (shimRunner below).
function hermeticPath(dir) {
  const fakeBin = join(dir, "fakebin-hermetic");
  mkdirSync(fakeBin, { recursive: true });
  for (const tool of ["sh", "jq", "node", "grep", "tr", "dirname", "cat", "mkdir"]) {
    const resolved = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
    if (resolved.status === 0 && resolved.stdout.trim()) {
      try { symlinkSync(resolved.stdout.trim(), join(fakeBin, tool)); } catch {}
    }
  }
  return fakeBin;
}

function runHook(script, { input, cwd, env = {} } = {}) {
  const r = spawnSync("sh", [script], {
    input: input ?? "",
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...env },
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

function sessionStartPayload(cwd, extra = {}) {
  // The stdin shape the harness sends (zcode.cjs fft(): camelCase native
  // fields plus snake_case aliases). No subagent discriminator exists on it.
  return JSON.stringify({
    hookEventName: "SessionStart",
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: "sess_z1",
    sessionId: "sess_z1",
    cwd,
    agentName: "zcode-main",
    agent_type: "zcode-main",
    mode: "yolo",
    model: "m",
    timestamp: "2026-09-11T00:00:00Z",
    ...extra,
  });
}

test("81. the ZCode session-start hook injects on every fresh app-instance opening — startup AND resume — through the additionalContext envelope the harness requires", async () => {
  // Probed zcode.cjs (3.11.2-22): parseHookStdout (jni) ignores stdout that
  // does not start with "{" — plain text never injects — and the output
  // mapping (Oni) reads only camelCase "additionalContext" into the session
  // history. The schema is strict (any extra key marks the run failed), so
  // the envelope must carry exactly that one key.
  await withDir(async (dir) => {
    seed(dir, ["ZCode startup gap"]);
    const run = (payload) => runHook(join(ZCODE_DIR, "session-start"), {
      input: payload,
      cwd: dir,
      // The hooks write their markers under XDG_CACHE_HOME; every run owns
      // a private one (unique session ids keep runs apart even where the
      // cache root is shared).
      env: { XDG_CACHE_HOME: dir, PATH: hermeticPath(dir) },
    });
    const r = run(sessionStartPayload(dir));
    assert.equal(r.code, 0, `hook failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ["additionalContext"],
      "the envelope must carry exactly additionalContext — the harness schema rejects extra keys");
    assert.ok(parsed.additionalContext.startsWith("This project has a horizon"));
    assert.ok(parsed.additionalContext.includes("gap-1  ZCode startup gap"));
    assert.ok(parsed.additionalContext.includes("`horizon detail <id>` prints it"),
      "the zcode path must carry the core's detail pointer");
    // Resume injects too (ticket 04, F4): additionalContext is ephemeral
    // (probed: 0 persisted hook_context rows in 15,208), so a session
    // resumed in a NEW app instance replays its history without the old
    // block — every instance must hand its session the horizon once, and
    // the old startup-only matcher was the bug. (A resume of the SAME
    // session seconds later is the simultaneity window's job — test 86.)
    const resumed = run(sessionStartPayload(dir, { source: "resume", sessionId: "sess_z1r", session_id: "sess_z1r" }));
    assert.equal(resumed.code, 0);
    assert.ok(JSON.parse(resumed.stdout).additionalContext.startsWith("This project has a horizon"),
      "a resumed session in a new instance must be re-injected (the F4 fix)");
    // The payload has no subagent discriminator (probed: no parent_session_id,
    // no task_type; agentName is ambiguous), so no guard is built — a payload
    // of the real shape injects, fail-open.
    assert.ok(!("parent_session_id" in JSON.parse(sessionStartPayload(dir))));
  }, "horizon-adapter-test-");
});

test("82. the ZCode session-start hook fails open: malformed stdin, empty stdin, and a missing bin all exit 0 silently", async () => {
  await withDir(async (dir) => {
    seed(dir, ["ZCode fail-open gap"]);
    for (const input of ["not json", "", "{}"]) {
      const r = runHook(join(ZCODE_DIR, "session-start"), { input, cwd: dir, env: { XDG_CACHE_HOME: dir } });
      assert.equal(r.code, 0, `input ${JSON.stringify(input)} must not fail the hook`);
      assert.equal(r.stdout, "", `input ${JSON.stringify(input)} must inject nothing`);
    }
    // Missing bin: run an isolated copy of the script (no ../../bin sibling)
    // with a PATH that has jq and node but no horizon bins — the exact
    // installed-package shape minus deep-horizon.
    const isolated = join(dir, "isolated");
    mkdirSync(isolated, { recursive: true });
    const fakeBin = join(dir, "fakebin");
    mkdirSync(fakeBin, { recursive: true });
    for (const tool of ["jq", "node", "sh", "dirname", "pwd", "cat", "command"]) {
      const resolved = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
      if (resolved.status === 0 && resolved.stdout.trim()) {
        try { symlinkSync(resolved.stdout.trim(), join(fakeBin, tool)); } catch {}
      }
    }
    copyFileSync(join(ZCODE_DIR, "session-start"), join(isolated, "session-start"));
    const r = runHook(join(isolated, "session-start"), {
      input: sessionStartPayload(dir),
      cwd: dir,
      env: { PATH: fakeBin, XDG_CACHE_HOME: dir },
    });
    assert.equal(r.code, 0, "a missing bin must never fail the hook");
    assert.equal(r.stdout, "", "a missing bin must inject nothing");
  }, "horizon-adapter-test-");
});

test("83. the ZCode session-start hook carries the session-end duty: a session id in the payload appends the close tail, its absence injects the horizon alone", async () => {
  // ZCode has no close hook (the retired stop-steer probe: Stop fires at the
  // end of every assistant turn), so the close duty rides the once-per-session
  // startup injection as adapter glue — the composer stays harness-agnostic.
  // The tail names the record the agent is to close, so it needs the payload's
  // real session id; without one, a placeholder id would write a wrong record.
  await withDir(async (dir) => {
    seed(dir, ["ZCode close gap"]);
    const sid = "sess_close1";
    const r = runHook(join(ZCODE_DIR, "session-start"), {
      input: sessionStartPayload(dir, { sessionId: sid, session_id: sid }),
      cwd: dir,
      env: { XDG_CACHE_HOME: dir, PATH: hermeticPath(dir) },
    });
    assert.equal(r.code, 0, `hook failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ["additionalContext"],
      "the envelope still carries exactly additionalContext — the harness schema rejects extra keys");
    assert.ok(parsed.additionalContext.startsWith("This project has a horizon"),
      "the horizon block must still lead the injection");
    assert.ok(parsed.additionalContext.includes(`horizon session-end --harness zcode --session ${sid}`),
      `the tail must name the close command with the real session id, got: ${parsed.additionalContext}`);
    assert.ok(parsed.additionalContext.includes("--summary"), "the tail must mention the optional summary");
    assert.ok(parsed.additionalContext.includes("summary: null"), "the tail must pin the no-summary record shape");
    // Without a session id the horizon injects and the tail does not — the
    // agent cannot run the command without its id.
    const bare = runHook(join(ZCODE_DIR, "session-start"), {
      input: sessionStartPayload(dir, { sessionId: null, session_id: null }),
      cwd: dir,
      env: { XDG_CACHE_HOME: dir, PATH: hermeticPath(dir) },
    });
    assert.equal(bare.code, 0);
    const bareParsed = JSON.parse(bare.stdout);
    assert.deepEqual(Object.keys(bareParsed).sort(), ["additionalContext"]);
    assert.ok(bareParsed.additionalContext.startsWith("This project has a horizon"),
      "the horizon must inject even without a session id");
    assert.ok(!bareParsed.additionalContext.includes("session-end"),
      "no session id, no tail");
    // A storeless dir that is $HOME: no output at all (os.homedir honours
    // $HOME on POSIX, pinned by inject's home-suppress-2) — the tail cannot
    // appear without the horizon text, and the empty-text check gates both.
    await withDir(async (storeless) => {
      const none = runHook(join(ZCODE_DIR, "session-start"), {
        input: sessionStartPayload(storeless, { sessionId: sid, session_id: sid }),
        cwd: storeless,
        env: { HOME: storeless, XDG_CACHE_HOME: dir, PATH: hermeticPath(storeless) },
      });
      assert.equal(none.code, 0);
      assert.equal(none.stdout, "", "a storeless dir must inject nothing, tail included");
    }, "horizon-adapter-test-");
  }, "horizon-adapter-test-");
});

test("84. the ZCode adapter ships its config and scripts: .zcode/config.json wires hooks.enabled true to the packaged, executable scripts", () => {
  const configPath = join(ROOT, ".zcode", "config.json");
  assert.ok(existsSync(configPath), "the project-local .zcode/config.json must be checked in");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(config.hooks.enabled, true, "config-file hooks are disabled by default; enabled:true is required");
  // SessionStart, matcher "startup|resume" — every fresh app-instance
  // opening injects (ticket 04: additionalContext is ephemeral, so a
  // session resumed in a new instance must be re-served; the pipe form is
  // the supported plain-token spelling — the bundle's $Nr does
  // split("|").includes).
  assert.ok(Array.isArray(config.hooks.events.SessionStart) && config.hooks.events.SessionStart.length === 1);
  assert.equal(config.hooks.events.SessionStart[0].matcher, "startup|resume");
  assert.equal(config.hooks.events.Stop, undefined, "no Stop hook is wired — SessionStart is the adapter's only event");
  // The event points at the shipped script, and the package ships it executable.
  const startCmd = config.hooks.events.SessionStart[0].hooks[0].command;
  assert.ok(startCmd.includes("adapters/zcode/session-start"), `SessionStart must run the shipped script, got: ${startCmd}`);
  for (const name of ["session-start", "pre-execute"]) {
    const script = join(ZCODE_DIR, name);
    assert.ok(existsSync(script), `adapters/zcode/${name} must exist`);
    assert.ok((statSync(script).mode & 0o111) !== 0, `adapters/zcode/${name} must be executable`);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.ok(pkg.files.includes(`adapters/zcode/${name}`), `package.json files must ship adapters/zcode/${name}`);
  }
});

test("85. the ZCode markers moved to the XDG cache dir: session-start seeds ${XDG_CACHE_HOME:-$HOME/.cache}/deep-horizon/markers/ and the legacy tmp path stays empty", async () => {
  // Ticket 04: /tmp dies on reboot (the Sep-13 reboot erased every marker),
  // which was tolerable while markers only fed pre-execute's dedup and is
  // not now that reconciliation (test 87) reads them as the record of which
  // sessions touched which stores. The move is clean — the legacy path is
  // neither read nor migrated.
  await withDir(async (dir) => {
    seed(dir, ["cache dir gap"]);
    const sid = "sess_cache1";
    const r = runHook(join(ZCODE_DIR, "session-start"), {
      input: sessionStartPayload(dir, { sessionId: sid, session_id: sid }),
      cwd: dir,
      env: { XDG_CACHE_HOME: dir, PATH: hermeticPath(dir) },
    });
    assert.equal(r.code, 0, `hook failed: ${r.stderr}`);
    const marker = markerPath(dir, sid);
    assert.ok(existsSync(marker), "the marker must live under the cache dir");
    const body = readFileSync(marker, "utf8");
    assert.ok(body.includes(`d ${dir}\n`), `the launch dir must be seeded, got: ${body}`);
    assert.ok(body.includes(`s ${join(dir, ".horizon")}\n`), `the launch store must be seeded, got: ${body}`);
    assert.ok(!existsSync(join(dir, `horizon-zcode-${sid}`)), "no marker may appear at the legacy tmp path");
    // The HOME fallback: XDG_CACHE_HOME unset, the marker lands under
    // $HOME/.cache/deep-horizon/markers/.
    const sid2 = "sess_cache2";
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const r2 = runHook(join(ZCODE_DIR, "session-start"), {
      input: sessionStartPayload(dir, { sessionId: sid2, session_id: sid2 }),
      cwd: dir,
      env: { HOME: home, XDG_CACHE_HOME: "", PATH: hermeticPath(dir) },
    });
    assert.equal(r2.code, 0, `hook failed: ${r2.stderr}`);
    assert.ok(existsSync(markerPath(join(home, ".cache"), sid2)),
      "XDG_CACHE_HOME unset must fall back to $HOME/.cache");
    // pre-execute reads the SAME file: the launch dir session-start seeded
    // is already known to it, so a touch of the launch repo probes nothing.
    const run = shimRunner(dir, { log: join(dir, "spawns.log"), delegate: join(ROOT, "bin", "horizon-inject.js") });
    const touch = run({ command: `git -C ${dir} status` }, { sid });
    assert.equal(touch.stdout, "", "pre-execute must read the cache-dir marker session-start seeded");
    assert.equal(touch.count, 0, `the seeded launch dir must not even probe, got: ${touch.spawns.join(" | ")}`);
  }, "horizon-adapter-test-");
});

test("86. the F7 simultaneity window: an identical seed pair younger than 10s suppresses the second fire whole; outside the window it injects and appends again", async () => {
  // Two app instances 0.8s apart both fired session-start for one session id
  // and duplicated the block into one context (proven: sess_15c584a4's
  // 142-byte marker is the seed pair twice). The dedup key is TIME, not
  // identity: identical pair + fresh mtime = another instance just injected
  // = stay silent; anything else — a restart hours later, F4 working —
  // injects and appends unconditionally, duplicate seed lines being
  // harmless to pre-execute's grep -Fx reads.
  await withDir(async (dir) => {
    seed(dir, ["simultaneity gap"]);
    const sid = "sess_race1";
    const fire = () => runHook(join(ZCODE_DIR, "session-start"), {
      input: sessionStartPayload(dir, { sessionId: sid, session_id: sid }),
      cwd: dir,
      env: { XDG_CACHE_HOME: dir, PATH: hermeticPath(dir) },
    });
    const first = fire();
    assert.equal(first.code, 0, `hook failed: ${first.stderr}`);
    assert.ok(JSON.parse(first.stdout).additionalContext.includes("simultaneity gap"));
    const marker = markerPath(dir, sid);
    const lines = () => readFileSync(marker, "utf8").trim().split("\n");
    assert.equal(lines().length, 2, `the first fire seeds exactly the pair, got: ${lines().join(" | ")}`);
    // The racing second instance: identical pair, mtime seconds old —
    // suppressed whole (no envelope, no tail, no extra seed lines).
    const second = fire();
    assert.equal(second.code, 0);
    assert.equal(second.stdout, "", "a fire inside the 10s window must inject nothing");
    assert.equal(lines().length, 2, "the suppressed fire must not touch the marker");
    // Outside the window (mtime backdated 11s): injects again and appends a
    // second pair.
    const stale = new Date(Date.now() - 11000);
    utimesSync(marker, stale, stale);
    const third = fire();
    assert.equal(third.code, 0);
    assert.ok(JSON.parse(third.stdout).additionalContext.includes("simultaneity gap"),
      "a stale pair must inject again");
    assert.equal(lines().length, 4, "the re-injection appends the pair again");
  }, "horizon-adapter-test-");
});

test("87. startup reconciliation: an orphan marker over this session's store is closed with horizon session-end (summary null); a live marker and a recorded sid are spared", async () => {
  // Ticket 03: no close hook (the 7-event enum is exhaustive) and
  // instruction-only close disproven by data — so at every startup the
  // adapter scans the markers dir for OTHER sessions' markers whose `s`
  // line names this session's resolved store, older than 60s (live
  // concurrent sessions stay out of scope) and not yet recorded in the
  // store's sessions.jsonl, and runs the real bin for each. Idempotent
  // twice over: the hook greps first, and the store's own once-guard (same
  // harness+session_id is a no-op) would eat a repeat anyway. A killed
  // session (SIGINT, closed terminal) leaves a marker, so signal deaths
  // reconcile by construction.
  await withDir(async (dir) => {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    seed(repo, ["reconcile gap"]);
    const store = join(repo, ".horizon");
    mkdirSync(join(dir, "deep-horizon", "markers"), { recursive: true });
    const backdate = (file, ms) => {
      const t = new Date(Date.now() - ms);
      utimesSync(file, t, t);
    };
    // The orphan: a dead session's marker over the same store, 2min old.
    const orphan = markerPath(dir, "sess_orphan");
    writeFileSync(orphan, `d ${repo}\ns ${store}\n`);
    backdate(orphan, 120000);
    // The live one: a concurrent session that started seconds ago — spared.
    const live = markerPath(dir, "sess_live");
    writeFileSync(live, `d ${repo}\ns ${store}\n`);
    backdate(live, 2000);
    // This session starts over the same store.
    const fire = (sid) => runHook(join(ZCODE_DIR, "session-start"), {
      input: sessionStartPayload(repo, { sessionId: sid, session_id: sid }),
      cwd: repo,
      env: { XDG_CACHE_HOME: dir, PATH: hermeticPath(dir) },
    });
    const r = fire("sess_now");
    assert.equal(r.code, 0, `hook failed: ${r.stderr}`);
    assert.ok(JSON.parse(r.stdout).additionalContext.includes("reconcile gap"),
      "the current session's injection must be unaffected by the scan");
    const sessionsFile = join(store, "sessions.jsonl");
    assert.ok(existsSync(sessionsFile), "reconciliation must have written the store's sessions.jsonl");
    const records = () => readFileSync(sessionsFile, "utf8").trim().split("\n")
      .filter((l) => l.length > 0).map((l) => JSON.parse(l));
    let recs = records();
    assert.equal(recs.length, 1, `exactly the orphan must record, got: ${JSON.stringify(recs)}`);
    assert.equal(recs[0].harness, "zcode");
    assert.equal(recs[0].session_id, "sess_orphan");
    assert.equal(recs[0].summary, null, "the reconciliation record carries summary: null");
    assert.deepEqual(recs[0].gaps_added, []);
    assert.deepEqual(recs[0].gaps_closed, []);
    // A second startup (different session, same store): the orphan is now
    // recorded — the grep spares it; the live marker is still inside its
    // 60s window; the firing sessions seed markers, not records.
    assert.equal(fire("sess_now2").code, 0);
    recs = records();
    assert.equal(recs.length, 1, `no double record for the recorded orphan, got: ${JSON.stringify(recs)}`);
    assert.ok(!recs.some((rec) => rec.session_id === "sess_live"), "a live session must never be reconciled");
    assert.ok(!recs.some((rec) => rec.session_id === "sess_now" || rec.session_id === "sess_now2"),
      "the firing sessions must not record themselves");
  }, "horizon-adapter-test-");
});

// --- ZCode pre-execute: the param trigger (PreToolUse → additionalContext) ---
//
// The 2026-09-13 live probe proved the mechanism this glue rides: a
// PreToolUse hook's stdout, emitted as strict single-key JSON, lands in the
// model's context appended to that tool call's result, and the hook fires on
// EVERY matching call — so the once-per-store dedup is the script's own job.
// These are tier-2 tests like session-start's: real processes, real tmp
// stores, and — wherever the spawn count is the assertion — a counting shim
// that wins the script's `command -v horizon-inject` resolution, exactly the
// seat the installed global bin occupies.

function preExecutePayload(cwd, toolInput, extra = {}) {
  // The stdin shape the harness sends for PreToolUse (probed live:
  // camelCase native fields plus snake_case aliases; ZCODE_SESSION_ID is
  // the env fallback for the session id).
  const sid = extra.sessionId ?? extra.session_id ?? "sess_param1";
  return JSON.stringify({
    hookEventName: "PreToolUse",
    hook_event_name: "PreToolUse",
    toolName: "Bash",
    tool_name: "Bash",
    toolInput,
    tool_input: toolInput,
    sessionId: sid,
    session_id: sid,
    cwd,
    mode: "yolo",
    riskLevel: "low",
    timestamp: "2026-09-13T00:00:00Z",
    ...extra,
  });
}

// The spawn camera: a fake horizon-inject that beats the checkout sibling
// (PATH-prepend), appends its argv to LOG per spawn, then either prints
// ANSWER (the canned --json body) or — with `delegate` — execs the real
// bin, so a test can hold the camera AND the real store resolution at once.
// The returned runner fires the hook and reports the spawn lines with it —
// count 0 is the marker fast path's claim to fame.
function shimRunner(dir, { log, answer, delegate } = {}) {
  const fakeBin = join(dir, "fakebin");
  mkdirSync(fakeBin, { recursive: true });
  const shim = join(fakeBin, "horizon-inject");
  const body = delegate
    ? "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LOG\"\nexec node \"$DELEGATE\" \"$@\"\n"
    : "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LOG\"\nprintf '%s' \"$ANSWER\"\n";
  writeFileSync(shim, body);
  chmodSync(shim, 0o755);
  return (toolInput, { answer: ans = answer, sid = "sess_shim1" } = {}) => {
    const r = runHook(join(ZCODE_DIR, "pre-execute"), {
      input: preExecutePayload(dir, toolInput, { sessionId: sid, session_id: sid }),
      cwd: dir,
      env: {
        XDG_CACHE_HOME: dir,
        PATH: `${fakeBin}:${process.env.PATH}`,
        LOG: log,
        ...(delegate ? { DELEGATE: delegate } : { ANSWER: typeof ans === "string" ? ans : JSON.stringify(ans) }),
      },
    });
    const spawns = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0) : [];
    return { ...r, spawns, count: spawns.length };
  };
}

test("zcode-param-1. the pre-execute hook injects a store-backed touched dir once, through exactly the strict single-key single-line envelope, and never again on the second touch", async () => {
  await withDir(async (dir) => {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    seed(repo, ["pre-execute gap"]);
    const call = () => runHook(join(ZCODE_DIR, "pre-execute"), {
      input: preExecutePayload(dir, { command: `git -C ${repo} status` }),
      cwd: dir,
      env: { XDG_CACHE_HOME: dir, PATH: hermeticPath(dir) },
    });
    const first = call();
    assert.equal(first.code, 0, `hook failed: ${first.stderr}`);
    assert.ok(first.stdout.length > 0, "the first touch of a store-backed dir must inject");
    const parsed = JSON.parse(first.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ["additionalContext"],
      "the envelope must carry exactly additionalContext — the harness schema rejects extra keys");
    assert.ok(parsed.additionalContext.startsWith("This project has a horizon"));
    assert.ok(parsed.additionalContext.includes("gap-1  pre-execute gap"));
    assert.ok(parsed.additionalContext.includes("`horizon detail <id>` prints it"),
      "the param path must carry the core's detail pointer like every other path");
    assert.ok(!first.stdout.slice(0, -1).includes("\n"), "the envelope must stay single-line JSON");
    const second = call();
    assert.equal(second.code, 0);
    assert.equal(second.stdout, "", "the second identical touch must not re-inject");
  }, "horizon-zcode-param-");
});

test("zcode-param-2. the bin is asked exactly once per fresh dir: storeless silence is remembered, spelling variants share one probe, and candidates come from workdir, file_path, path, and command", async () => {
  await withDir(async (dir) => {
    const run = shimRunner(dir, { log: join(dir, "spawns.log"), answer: { text: "", store: null } });
    const a = join(dir, "storeless-a");
    // First touch of a storeless dir: one probe, silence.
    let r = run({ command: `ls ${a}` });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "", "a storeless dir must stay silent on the param path");
    assert.equal(r.count, 1);
    assert.equal(r.spawns[0], `--harness zcode --json --session sess_shim1 --cwd ${a}`,
      `the bin must be asked with the provenance session id, the total-answer flags, and the candidate dir, got: ${r.spawns[0]}`);
    // The identical touch: remembered silence — no re-spawn (this is what
    // keeps a long session from paying a node startup on every call).
    r = run({ command: `ls ${a}` });
    assert.equal(r.stdout, "");
    assert.equal(r.count, 1, "a storeless dir must never re-spawn");
    // Spelling variants of one dir inside a single command collapse to one
    // probe (lexical path.resolve — no filesystem access).
    const b = join(dir, "b");
    r = run({ command: `ls ${b}//x ${b}/./x ${b}/x/` });
    assert.equal(r.stdout, "");
    assert.equal(r.count, 2, `spelling variants must share one probe, got: ${r.spawns.join(" | ")}`);
    // A workdir argument candidates as itself.
    const c = join(dir, "c");
    r = run({ workdir: c, command: "make" });
    assert.equal(r.count, 3, `a workdir argument must candidate, got: ${r.spawns.join(" | ")}`);
    // file_path and path candidate as their dirname, not the file.
    const d = join(dir, "d");
    r = run({ file_path: `${d}/notes.md` });
    assert.equal(r.count, 4);
    assert.ok(r.spawns.at(-1).endsWith(`--cwd ${d}`),
      `file_path must candidate as its dirname, got: ${r.spawns.at(-1)}`);
    const e = join(dir, "e");
    r = run({ path: `${e}/f` });
    assert.equal(r.count, 5);
    assert.ok(r.spawns.at(-1).endsWith(`--cwd ${e}`),
      `path must candidate as its dirname, got: ${r.spawns.at(-1)}`);
    // Relative paths never candidate: the hook cannot know the shell cwd.
    r = run({ command: "cd some/relative/dir && ls" });
    assert.equal(r.stdout, "");
    assert.equal(r.count, 5, "relative paths must be dropped");
    // Globbing stays off in the hook shell (set -f): a glob token reaches
    // the bin as the literal the model wrote, probed once — pathname
    // expansion would ask per matched dir and inject every block in one
    // fire, which is neither dsh's behavior nor once-per-anything.
    const g = join(dir, "globs");
    mkdirSync(join(g, "m1"), { recursive: true });
    mkdirSync(join(g, "m2"), { recursive: true });
    r = run({ command: `ls ${g}/*` });
    assert.equal(r.stdout, "");
    assert.equal(r.count, 6, `a glob token must be one literal probe, got: ${r.spawns.join(" | ")}`);
    assert.ok(r.spawns.at(-1).endsWith(`--cwd ${g}/*`),
      `the literal token must reach the bin unexpanded, got: ${r.spawns.at(-1)}`);
    // A candidate carrying a newline is dropped: the marker format is
    // line-based and cannot remember one, so it never candidates at all.
    r = run({ workdir: `${dir}/new\nline` });
    assert.equal(r.stdout, "");
    assert.equal(r.count, 6, "a newline dir must be dropped, not probed");
  }, "horizon-zcode-param-");
});

test("zcode-param-3. session-start seeds the param marker: the launch store is never re-injected, by root or by subdir, while a second repo still delivers once", async () => {
  await withDir(async (dir) => {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    seed(repo, ["launch repo gap"]);
    const sid = "sess_seed1";
    const start = runHook(join(ZCODE_DIR, "session-start"), {
      input: sessionStartPayload(repo, { sessionId: sid, session_id: sid }),
      cwd: repo,
      env: { XDG_CACHE_HOME: dir },
    });
    assert.equal(start.code, 0, `session-start failed: ${start.stderr}`);
    assert.ok(JSON.parse(start.stdout).additionalContext.includes("launch repo gap"),
      "the startup injection must deliver the launch horizon first");
    // The seed: the launch dir known, the launch store served (in the cache
    // marker dir).
    const marker = readFileSync(markerPath(dir, sid), "utf8");
    assert.ok(marker.includes(`d ${repo}\n`), `the launch dir must be seeded, got: ${marker}`);
    assert.ok(marker.includes(`s ${join(repo, ".horizon")}\n`), `the launch store must be seeded, got: ${marker}`);
    // Camera on the bin, real composition behind it: the shim logs the ask
    // and execs the checkout bin, so every store resolution below is the
    // real one — only the spawn count is borrowed from the fake. The launch
    // root must not even probe (the marker fast path); a subdir of it
    // probes once and lands on the served store — silence; a different
    // store-backed repo delivers exactly once.
    mkdirSync(join(repo, "sub"), { recursive: true });
    const second = join(dir, "second");
    mkdirSync(second, { recursive: true });
    seed(second, ["second repo gap"]);
    const run = shimRunner(dir, { log: join(dir, "spawns.log"), delegate: join(ROOT, "bin", "horizon-inject.js") });
    let r = run({ command: `git -C ${repo} status` }, { sid });
    assert.equal(r.stdout, "", "the launch repo's own horizon must not re-inject");
    assert.equal(r.count, 0, `the seeded launch dir must not even probe, got: ${r.spawns.join(" | ")}`);
    r = run({ file_path: `${repo}/sub/f.txt` }, { sid });
    assert.equal(r.stdout, "", "a subdir of the launch repo resolves to the served store: silence");
    assert.equal(r.count, 1, "the subdir itself was fresh: one probe");
    r = run({ command: `git -C ${second} status` }, { sid });
    assert.equal(r.code, 0);
    assert.ok(JSON.parse(r.stdout).additionalContext.includes("second repo gap"));
    assert.equal(r.count, 2, "a fresh dir over a fresh store: one probe, one inject");
    r = run({ command: `git -C ${second} status` }, { sid });
    assert.equal(r.stdout, "", "the second touch of the second repo stays silent");
    assert.equal(r.count, 2, "and it does not re-spawn");
  }, "horizon-zcode-param-");
});

test("zcode-param-4. the pre-execute hook fails open: malformed stdin, a payload with no session id, and a missing jq all exit 0 silently", async () => {
  await withDir(async (dir) => {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    seed(repo, ["fail-open gap"]);
    for (const input of ["not json", "", "{}"]) {
      const r = runHook(join(ZCODE_DIR, "pre-execute"), { input, cwd: dir, env: { XDG_CACHE_HOME: dir } });
      assert.equal(r.code, 0, `input ${JSON.stringify(input)} must not fail the hook`);
      assert.equal(r.stdout, "", `input ${JSON.stringify(input)} must inject nothing`);
    }
    // No session id in the payload or the env: no dedup key, no injection —
    // once-per-store is unenforceable without memory, and re-injecting on
    // every matching call would be spam. No id, no marker file either.
    const sidless = runHook(join(ZCODE_DIR, "pre-execute"), {
      input: preExecutePayload(dir, { command: `git -C ${repo} status` }, { sessionId: null, session_id: null }),
      cwd: dir,
      env: { XDG_CACHE_HOME: dir, ZCODE_SESSION_ID: "" },
    });
    assert.equal(sidless.code, 0);
    assert.equal(sidless.stdout, "", "a session without an id must not inject");
    // Missing jq with everything else present: the very first jq use (the
    // session id read) ends the run silently — PATH juggling like test 82's.
    const fakeBin = join(dir, "fakebin-nojq");
    mkdirSync(fakeBin, { recursive: true });
    for (const tool of ["node", "grep", "tr", "sh", "dirname", "pwd", "cat", "command"]) {
      const resolved = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
      if (resolved.status === 0 && resolved.stdout.trim()) {
        try { symlinkSync(resolved.stdout.trim(), join(fakeBin, tool)); } catch {}
      }
    }
    const nojq = runHook(join(ZCODE_DIR, "pre-execute"), {
      input: preExecutePayload(dir, { command: `git -C ${repo} status` }),
      cwd: dir,
      env: { PATH: fakeBin, XDG_CACHE_HOME: dir },
    });
    assert.equal(nojq.code, 0, "a missing jq must never fail the hook");
    assert.equal(nojq.stdout, "", "a missing jq must inject nothing");
  }, "horizon-zcode-param-");
});

test("zcode-param-5. the envelope encodes hostile text verbatim and stays single-line: quotes, backslashes, newlines, tabs, dollars", async () => {
  await withDir(async (dir) => {
    const hostile = "line1\n\"quoted\" \\backslash `tick` $dollar ${brace}\ttab";
    const run = shimRunner(dir, { log: join(dir, "spawns.log"), answer: { text: hostile, store: join(dir, ".horizon") } });
    const r = run({ command: `git -C ${dir}/repo status` });
    assert.equal(r.code, 0, `hook failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ["additionalContext"],
      "exactly one key — any extra key fails the harness schema and discards the output");
    assert.equal(parsed.additionalContext, hostile, "the text must survive the envelope byte-for-byte");
    assert.ok(!r.stdout.slice(0, -1).includes("\n"), "the envelope must stay single-line JSON");
  }, "horizon-zcode-param-");
});

test("zcode-param-6. several fresh stores touched by one call concatenate into the single allowed envelope, one probe per dir, delivered once", async () => {
  await withDir(async (dir) => {
    const fakeBin = join(dir, "fakebin");
    mkdirSync(fakeBin, { recursive: true });
    const shim = join(fakeBin, "horizon-inject");
    // Answer per candidate: the store IS the asked dir and the text names
    // it — a store-backed answer for every dir the script brings, so the
    // multi-store fire is exercisable with a stateless shim ($7 is --cwd's
    // value — $5 is the --session id since 0.4; tmp paths carry no JSON
    // metacharacters).
    writeFileSync(shim, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LOG\"\nprintf '{\"text\":\"BLOCK %s\",\"store\":\"%s\"}' \"$7\" \"$7\"\n");
    chmodSync(shim, 0o755);
    const a = join(dir, "a");
    const b = join(dir, "b");
    const call = () => runHook(join(ZCODE_DIR, "pre-execute"), {
      input: preExecutePayload(dir, { workdir: a, file_path: `${b}/f.txt` }),
      cwd: dir,
      env: { XDG_CACHE_HOME: dir, PATH: `${fakeBin}:${process.env.PATH}`, LOG: join(dir, "spawns.log") },
    });
    const r = call();
    assert.equal(r.code, 0, `hook failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ["additionalContext"]);
    assert.ok(parsed.additionalContext.includes(`BLOCK ${a}`), `the first store must ride the envelope: ${parsed.additionalContext}`);
    assert.ok(parsed.additionalContext.includes(`BLOCK ${b}`), `the second store must ride the same envelope: ${parsed.additionalContext}`);
    const marker = readFileSync(markerPath(dir, "sess_param1"), "utf8");
    assert.ok(marker.includes(`s ${a}\n`) && marker.includes(`s ${b}\n`), `both stores must be claimed, got: ${marker}`);
    // The replay: both dirs known, both stores served — silence, no spawns.
    const second = call();
    assert.equal(second.stdout, "", "the replayed fire must inject nothing");
    assert.equal(readFileSync(join(dir, "spawns.log"), "utf8").split("\n").filter((l) => l.length > 0).length, 2,
      "the replayed fire must not re-spawn for either dir");
  }, "horizon-zcode-param-");
});

test("zcode-param-7. an unseeded launch dir is probed honestly: with session-start never run, the launch dir's own horizon IS delivered mid-session, once", async () => {
  // Only session-start seeds the marker (its fire knows an injection
  // happened). Pre-execute materializes the marker empty, so a session
  // whose session-start never ran or failed gets its launch dir probed and
  // served like any other dir — under-silencing beats pre-silencing.
  await withDir(async (dir) => {
    seed(dir, ["unseeded launch gap"]);
    const sid = "sess_unseeded";
    const run = shimRunner(dir, { log: join(dir, "spawns.log"), delegate: join(ROOT, "bin", "horizon-inject.js") });
    let r = run({ command: `git -C ${dir} status` }, { sid });
    assert.equal(r.code, 0, `hook failed: ${r.stderr}`);
    assert.ok(r.stdout.includes("unseeded launch gap"),
      "no session-start seed: the launch dir must be probed and served like any other dir");
    assert.equal(r.count, 1, "exactly one probe");
    const marker = readFileSync(markerPath(dir, sid), "utf8");
    assert.ok(marker.includes(`s ${join(dir, ".horizon")}\n`), `the store must be claimed, got: ${marker}`);
    r = run({ command: `git -C ${dir} status` }, { sid });
    assert.equal(r.stdout, "", "the second touch stays silent");
    assert.equal(r.count, 1, "and does not re-spawn");
  }, "horizon-zcode-param-");
});

test("zcode-param-8. an off-shape --json answer — a missing store key — is never remembered: silence, and the next call re-probes", async () => {
  // The bin always emits the store key (null when storeless), so a missing
  // key is an off-shape answer, not a storeless one — the dsh
  // parseInjectAnswer trade: failed answers leave the dir unrecorded so
  // the next call retries.
  await withDir(async (dir) => {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    seed(repo, ["off-shape gap"]);
    const run = shimRunner(dir, { log: join(dir, "spawns.log"), answer: { text: "TEXT WITHOUT STORE" } });
    let r = run({ command: `git -C ${repo} status` });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "", "an off-shape answer injects nothing");
    assert.equal(r.count, 1);
    assert.ok(!readFileSync(markerPath(dir, "sess_shim1"), "utf8").includes(`d ${repo}\n`),
      "an off-shape answer must not record the dir");
    r = run({ command: `git -C ${repo} status` });
    assert.equal(r.stdout, "");
    assert.equal(r.count, 2, "the unrecorded dir re-probes on the next call");
  }, "horizon-zcode-param-");
});

// --- support.ts: the one spawn policy (runBin, parseInjectAnswer, truthy) ---

// DEF-ADV-14-1, pinned at its one remaining home: a bin that never exits is
// killed at the timeout and reported as status -1, fast. The 50ms bound keeps
// the pin cheap; the policy default is 15s (runBin's only caller-facing knob).
test("support-timeout. runBin kills a hung bin at the timeout — status -1, and the PID is gone", async () => {
  // withDir owns the dir; the PATH fake keeps its own restore — a second
  // duty the rmSync skeleton does not cover.
  await withDir(async (dir) => {
    const fakeBin = join(dir, "fakebin");
    mkdirSync(fakeBin, { recursive: true });
    // exec so the kill lands on the sleep itself, not a shell wrapper; the
    // recorded $$ is the same PID after the exec — the PID the kill must bury.
    const pidFile = join(dir, "sleepy.pid");
    writeFileSync(join(fakeBin, "horizon-support-sleepy"), `#!/bin/sh\necho "$$" > "$1"\nexec sleep 30\n`);
    chmodSync(join(fakeBin, "horizon-support-sleepy"), 0o755);
    const prev = process.env.PATH;
    process.env.PATH = `${fakeBin}:${prev}`;
    const started = Date.now();
    try {
      const mod = await import(SUPPORT_ADAPTER);
      const r = await mod.runBin("horizon-support-sleepy", [pidFile], { timeoutMs: 50 });
      assert.equal(r.status, -1, `a killed bin must report -1, got: ${r.status}`);
      assert.ok(Date.now() - started < 5000, `the kill must be timely, took: ${Date.now() - started}ms`);
      // The kill claim, proven: the sleeper recorded its PID and that PID is
      // gone — reaped, not merely signaled (kill(pid, 0) succeeds on a zombie).
      assert.ok(existsSync(pidFile), "the sleeper must have recorded its PID before the kill");
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      assert.ok(Number.isInteger(pid) && pid > 0, `a usable recorded PID: ${pid}`);
      let alive = true;
      try { process.kill(pid, 0); } catch (err) { alive = err.code !== "ESRCH"; }
      assert.equal(alive, false, `the killed bin's PID ${pid} must be gone`);
    } finally {
      process.env.PATH = prev;
    }
  }, "horizon-adapter-test-");
});

// The sibling-fails→PATH fallback needs a sibling, and runBin resolves the
// sibling relative to its own file — so the pin builds a fake checkout shape
// (bin/<name>.js beside a copy of support.ts) and lets the real resolution
// order do the work: the nonzero sibling (the installed package's Node < 23.6
// module-error shape) falls through to the PATH bin exactly once; a working
// sibling is never second-guessed.
test("support-fallback. a sibling that exits nonzero is retried on PATH; a working sibling is never second-guessed", async () => {
  await withDir(async (pkg) => {
    await withDir(async (pathBin) => {
      mkdirSync(join(pkg, "src", "adapters"), { recursive: true });
      mkdirSync(join(pkg, "bin"), { recursive: true });
      copyFileSync(SUPPORT_ADAPTER, join(pkg, "src", "adapters", "support.ts"));
      // The sibling: runs, prints nothing, exits nonzero.
      writeFileSync(join(pkg, "bin", "horizon-support-fake.js"), "process.exit(7);\n");
      // The PATH bin: the working one.
      writeFileSync(join(pathBin, "horizon-support-fake"), "#!/bin/sh\necho PATH-WINS\n");
      chmodSync(join(pathBin, "horizon-support-fake"), 0o755);
      const prev = process.env.PATH;
      process.env.PATH = `${pathBin}:${prev}`;
      try {
        const mod = await import(join(pkg, "src", "adapters", "support.ts"));
        const r = await mod.runBin("horizon-support-fake", []);
        assert.equal(r.status, 0, `the PATH retry must win, got: ${r.status} ${r.stderr}`);
        assert.equal(r.stdout, "PATH-WINS\n", "the nonzero sibling must fall through to the PATH bin");
        // A sibling that succeeds stands, even with a PATH bin offering itself.
        // The PATH bin marks the filesystem, not just stdout: runBin would
        // discard a retried attempt's output, so the marker file is the only
        // camera that catches a second-guess (a PATH ENOENT would silently
        // fall back to the sibling's result and look identical).
        writeFileSync(join(pkg, "bin", "horizon-support-fine.js"), 'process.stdout.write("SIBLING-WINS\\n");\n');
        writeFileSync(join(pathBin, "horizon-support-fine"), `#!/bin/sh\necho PATH-SECOND-GUESSED\ntouch "$1"\n`);
        chmodSync(join(pathBin, "horizon-support-fine"), 0o755);
        const secondGuess = join(pathBin, "second-guess.marker");
        const fine = await mod.runBin("horizon-support-fine", [secondGuess]);
        assert.equal(fine.status, 0);
        assert.equal(fine.stdout, "SIBLING-WINS\n", "a working sibling must not be second-guessed");
        assert.ok(!existsSync(secondGuess), "the PATH bin must never have run for a succeeding sibling");
      } finally {
        process.env.PATH = prev;
      }
    }, "horizon-support-path-");
  }, "horizon-support-pkg-");
});

// The fail-open contract every adapter catches: a bin resolvable nowhere (no
// sibling, no PATH entry) rejects — injecting nothing, breaking nothing.
test("support-unresolvable. a bin resolvable nowhere rejects; the adapters treat that as fail-open", async () => {
  const mod = await import(SUPPORT_ADAPTER);
  const prev = process.env.PATH;
  process.env.PATH = "/horizon-support-nowhere";
  try {
    await assert.rejects(mod.runBin("horizon-support-missing", []), { code: "ENOENT" });
  } finally {
    process.env.PATH = prev;
  }
});

// The real sibling through the real resolution: support.ts sitting in
// src/adapters/ runs bin/<name>.js with the current node, no PATH involved.
test("support-real. runBin drives the real repo bin through the sibling resolution", async () => {
  const mod = await import(SUPPORT_ADAPTER);
  const r = await mod.runBin("horizon", ["--help"]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.startsWith("usage: horizon"), `got: ${r.stdout.slice(0, 40)}`);
});

test("support-parse. parseInjectAnswer accepts exactly the total --json answer shape and rejects everything else", async () => {
  const mod = await import(SUPPORT_ADAPTER);
  const parse = mod.parseInjectAnswer;
  assert.deepEqual(parse('{"text":"T","store":"/s"}'), { text: "T", store: "/s" });
  assert.deepEqual(parse('{"text":"NUDGE","store":null}'), { text: "NUDGE", store: null });
  // The bin terminates its stdout with a newline; JSON.parse tolerates it.
  assert.deepEqual(parse('{"text":"T","store":null}\n'), { text: "T", store: null });
  // Fields beyond the contract ride along, unparsed and untrusted.
  assert.deepEqual(parse('{"text":"T","store":null,"x":1}'), { text: "T", store: null });
  for (const bad of [
    "",                    // empty stdout: a failed answer, never an injection
    "not json",
    '"a json string"',     // valid JSON, not a record
    "[]",
    "42",
    "null",
    '{"store":"/s"}',      // no text
    '{"text":"T"}',        // no store field at all
    '{"text":5,"store":null}',
    '{"text":"T","store":5}',
  ]) {
    assert.equal(parse(bad), null, `must reject: ${JSON.stringify(bad)}`);
  }
  // Non-string stdout (a caller bug) is a failed answer, not a throw.
  assert.equal(parse(42), null);
  assert.equal(parse(undefined), null);
  assert.equal(parse(null), null);
});

test("support-truthy. the README-documented HORIZON_SUBAGENT set: 1/true/yes, case-insensitive, nothing else", async () => {
  const mod = await import(SUPPORT_ADAPTER);
  for (const v of ["1", "true", "yes", "YES", "True", 1, true]) {
    assert.equal(mod.truthy(v), true, `truthy: ${String(v)}`);
  }
  // "on" is hermes' Python twin's extension, not this set's; no trimming, no
  // numeric coercion beyond String().
  for (const v of ["0", "false", "no", "on", "", " 1", "yes ", undefined, null, 0, false]) {
    assert.equal(mod.truthy(v), false, `not truthy: ${String(v)}`);
  }
});
