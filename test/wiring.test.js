// The observability + install slice (tickets 09/10): hooks.log, horizon
// doctor, horizon install — all through the same in-process seams the other
// suites use (runCli/runInject + fixture dirs), with the wiring module's
// env seams (HORIZON_ZCODE_CONFIG / HORIZON_HERMES_HOME, PATH overrides)
// pointing every round at fixtures, never at the real home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, runInject, seed, withDir } from "./harness.js";

const HERMES_SRC = new URL("../adapters/hermes", import.meta.url).pathname;

// --- fixtures ---

// The exact block install writes (and the README documents): healthy for
// doctor, and the pre-0.4 matcher for the upgrade-path tests.
function zcodeConfigText(matcher = "startup|resume") {
  return (
    JSON.stringify(
      {
        model: "test-model",
        hooks: {
          enabled: true,
          timeoutMs: 60000,
          events: {
            SessionStart: [
              {
                matcher,
                hooks: [{ type: "command", command: '"$(npm root -g)/deep-horizon/adapters/zcode/session-start"', enabled: true }],
              },
            ],
            PreToolUse: [
              {
                matcher: "Bash|Read|Edit|Write|NotebookEdit",
                hooks: [{ type: "command", command: '"$(npm root -g)/deep-horizon/adapters/zcode/pre-execute"', enabled: true, timeout: 10 }],
              },
            ],
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function makeFakeBin(dir) {
  mkdirSync(dir, { recursive: true });
  for (const bin of ["horizon", "horizon-inject"]) {
    writeFileSync(join(dir, bin), "#!/bin/sh\n");
    chmodSync(join(dir, bin), 0o755);
  }
  return dir;
}

function makeHermesHome(home, { enabled = ["deep-horizon"], style = "block" } = {}) {
  const pluginDir = join(home, "plugins", "deep-horizon");
  mkdirSync(pluginDir, { recursive: true });
  for (const name of ["deep_horizon.py", "__init__.py", "plugin.yaml"]) {
    copyFileSync(join(HERMES_SRC, name), join(pluginDir, name));
  }
  const list = style === "block" ? ["  enabled:", ...enabled.map((p) => `    - ${p}`)].join("\n") : `  enabled: [${enabled.join(", ")}]`;
  writeFileSync(join(home, "config.yaml"), `model:\n  default: m\nplugins:\n${list}\n  disabled:\n    - horizon-line\n`);
  return home;
}

// The wiring env: everything the real environment carries, with the two
// seams (and optionally PATH / HOME) pointed at the fixture.
function wiringEnv({ zcodeConfig, hermesHome, pathDir, home } = {}) {
  const env = { ...process.env };
  delete env.HORIZON_ZCODE_CONFIG;
  delete env.HORIZON_HERMES_HOME;
  if (zcodeConfig) env.HORIZON_ZCODE_CONFIG = zcodeConfig;
  if (hermesHome) env.HORIZON_HERMES_HOME = hermesHome;
  if (pathDir) env.PATH = pathDir;
  if (home) env.HOME = home;
  return env;
}

// The hooks.log line, split the way the format promises: ts harness bin
// session=<id|-> store=<dir> outcome=<...> — six space-separated tokens
// (fixture paths never carry spaces).
function logLines(storeDir) {
  return readFileSync(join(storeDir, "hooks.log"), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

function assertHookLine(line, { harness, bin, session, store, outcome }) {
  const parts = line.split(" ");
  assert.equal(parts.length, 6, `unexpected token count: ${line}`);
  assert.match(parts[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `iso ts: ${line}`);
  assert.equal(parts[1], harness);
  assert.equal(parts[2], bin);
  assert.equal(parts[3], `session=${session}`);
  assert.equal(parts[4], `store=${store}`);
  assert.equal(parts[5], `outcome=${outcome}`);
}

// --- hooks.log (ticket 09): the bins write it, fail-open all the way down ---

test("hooks-log-1. inject appends one line per fire into the resolved store: injected, harness and session named", async () => {
  await withDir(async (dir) => {
    seed(dir, ["Logged gap"]);
    const r = await runInject(["--cwd", dir, "--harness", "test", "--session", "s-1"]);
    assert.equal(r.code, 0);
    const lines = logLines(join(dir, ".horizon"));
    assert.equal(lines.length, 1);
    assertHookLine(lines[0], { harness: "test", bin: "horizon-inject", session: "s-1", store: join(dir, ".horizon"), outcome: "injected" });
  });
});

test("hooks-log-2. the nudged outcome: an empty store's bootstrap nudge logs nudged; no --session logs -", async () => {
  await withDir(async (dir) => {
    seed(dir, []);
    const r = await runInject(["--cwd", dir]);
    assert.equal(r.code, 0);
    const lines = logLines(join(dir, ".horizon"));
    assert.equal(lines.length, 1);
    assertHookLine(lines[0], { harness: "unknown", bin: "horizon-inject", session: "-", store: join(dir, ".horizon"), outcome: "nudged" });
  });
});

test("hooks-log-3. storeless fires stay unlogged: the storeless nudge and the $HOME silence create nothing", async () => {
  await withDir(async (dir) => {
    const r = await runInject(["--cwd", dir]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.startsWith("This project has no horizon yet"));
    assert.ok(!existsSync(join(dir, ".horizon")), "a storeless fire must not create a store to log into");
    await withDir(async (fakeHome) => {
      const silent = await runInject(["--cwd", fakeHome], { env: wiringEnv({ home: fakeHome }) });
      assert.equal(silent.code, 0);
      assert.equal(silent.stdout, "");
      assert.ok(!existsSync(join(fakeHome, ".horizon")), "the home silence must create nothing");
    });
  });
});

test("hooks-log-4. an unwritable store dir costs the line, never the hook (exit 0, text composed, no log)", async () => {
  if (process.platform === "win32") return; // POSIX permission model only
  const dir = freshGuard();
  try {
    seed(dir, ["Unwritable gap"]);
    chmodSync(join(dir, ".horizon"), 0o555);
    const r = await runInject(["--cwd", dir, "--harness", "test"]);
    assert.equal(r.code, 0, "the injection must succeed");
    assert.ok(r.stdout.includes("Unwritable gap"), "the injection must still compose");
    assert.ok(!existsSync(join(dir, ".horizon", "hooks.log")), "the unwritable log must cost only the line");
  } finally {
    chmodSync(join(dir, ".horizon"), 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks-log-5. append-only across fires; the error outcome logs against the store it found", async () => {
  await withDir(async (dir) => {
    seed(dir, ["First fire"]);
    await runInject(["--cwd", dir, "--harness", "test"]);
    await runInject(["--cwd", dir, "--harness", "test", "--session", "s-2"]);
    const lines = logLines(join(dir, ".horizon"));
    assert.equal(lines.length, 2, "append-only: one line per fire");
    assert.equal(lines[1].split(" ")[3], "session=s-2");
    // The error twin: a malformed store still names itself in the log.
    await withDir(async (bad) => {
      mkdirSync(join(bad, ".horizon"), { recursive: true });
      writeFileSync(join(bad, ".horizon", "gaps.json"), "{not json");
      const r = await runInject(["--cwd", bad, "--harness", "test"]);
      assert.equal(r.code, 7);
      assert.match(r.stderr, /gaps\.json/);
      const badLines = logLines(join(bad, ".horizon"));
      assert.equal(badLines.length, 1);
      assertHookLine(badLines[0], { harness: "test", bin: "horizon-inject", session: "-", store: join(bad, ".horizon"), outcome: "error" });
    });
  });
});

test("hooks-log-6. session-end logs recorded (the bin horizon-session-end); the --store form logs the named store; a repeat still logs recorded", async () => {
  await withDir(async (dir) => {
    seed(dir, ["Session log gap"]);
    const r = await runCli(["session-end", "--harness", "t", "--session", "se-1", "--cwd", dir]);
    assert.equal(r.code, 0, r.stderr);
    const lines = logLines(join(dir, ".horizon"));
    assert.equal(lines.length, 1);
    assertHookLine(lines[0], { harness: "t", bin: "horizon-session-end", session: "se-1", store: join(dir, ".horizon"), outcome: "recorded" });
    // The idempotent repeat: the record's pair already exists, the fire is
    // still logged recorded (the line says how the fire ended, not that
    // bytes moved).
    await runCli(["session-end", "--harness", "t", "--session", "se-1", "--cwd", dir]);
    assert.equal(logLines(join(dir, ".horizon")).length, 2);
    // The --store form logs the handed-back store, discovered nowhere.
    await withDir(async (elsewhere) => {
      const rs = await runCli(["session-end", "--harness", "t", "--session", "se-2", "--store", join(dir, ".horizon"), "--cwd", elsewhere]);
      assert.equal(rs.code, 0, rs.stderr);
      const storeLines = logLines(join(dir, ".horizon"));
      assert.equal(storeLines.length, 3);
      assertHookLine(storeLines[2], { harness: "t", bin: "horizon-session-end", session: "se-2", store: join(dir, ".horizon"), outcome: "recorded" });
    });
    // The malformed store's failed fire logs error and still exits 7.
    await withDir(async (broken) => {
      mkdirSync(join(broken, ".horizon"), { recursive: true });
      writeFileSync(join(broken, ".horizon", "gaps.json"), '{"version":1,"revision":1,"gaps":[null]}');
      const rb = await runCli(["session-end", "--harness", "t", "--session", "se-3", "--cwd", broken]);
      assert.equal(rb.code, 7);
      const badLines = logLines(join(broken, ".horizon"));
      assert.equal(badLines.length, 1);
      assertHookLine(badLines[0], { harness: "t", bin: "horizon-session-end", session: "se-3", store: join(broken, ".horizon"), outcome: "error" });
    });
  });
});

test("hooks-log-7. a storeless session-end creates no store and logs nothing; new stores ship hooks.log in .gitignore", async () => {
  await withDir(async (dir) => {
    const r = await runCli(["session-end", "--harness", "t", "--session", "s-none", "--cwd", dir]);
    assert.equal(r.code, 0);
    assert.ok(!existsSync(join(dir, ".horizon")), "session-end must never bootstrap a store");
    await withDir(async (fresh) => {
      await runCli(["init", "--cwd", fresh]);
      const body = readFileSync(join(fresh, ".horizon", ".gitignore"), "utf8");
      assert.match(body, /^sessions\.jsonl$/m);
      assert.match(body, /^hooks\.log$/m, "new stores must ignore the bin-fire log");
      assert.match(body, /^\*\.tmp\.\*$/m);
    });
  });
});

// --- doctor (ticket 09): read-only wiring checks ---

test("doctor-1. healthy zcode + hermes fixtures: exit 0, one PASS line per check (4 zcode, 3 hermes)", async () => {
  await withDir(async (tmp) => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, zcodeConfigText());
    const hermes = makeHermesHome(join(tmp, "hermes"));
    const r = await runCli(["doctor"], { env: wiringEnv({ zcodeConfig: cfg, hermesHome: hermes, pathDir: makeFakeBin(join(tmp, "bin")) }) });
    assert.equal(r.code, 0, r.stdout);
    const zLines = r.stdout.split("\n").filter((l) => l.startsWith("zcode: "));
    const hLines = r.stdout.split("\n").filter((l) => l.startsWith("hermes: "));
    assert.equal(zLines.length, 4, r.stdout);
    assert.equal(hLines.length, 3, r.stdout);
    for (const l of [...zLines, ...hLines]) assert.match(l, / PASS /, l);
    assert.ok(zLines.some((l) => l.includes("PreToolUse wired to pre-execute")));
    assert.ok(hLines.some((l) => l.includes("plugins.enabled")));
  });
});

test("doctor-2. matcher \"startup\" alone passes (both spellings are correct); --harness narrows; a bad value is a usage error", async () => {
  await withDir(async (tmp) => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, zcodeConfigText("startup"));
    const r = await runCli(["doctor", "--harness", "zcode"], { env: wiringEnv({ zcodeConfig: cfg, pathDir: makeFakeBin(join(tmp, "bin")) }) });
    assert.equal(r.code, 0, r.stdout);
    assert.ok(r.stdout.split("\n").every((l) => !l.startsWith("hermes:")), "--harness zcode must not check hermes");
    const bad = await runCli(["doctor", "--harness", "dsh"], { env: wiringEnv({ zcodeConfig: cfg }) });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /unknown harness: dsh/);
  });
});

test("doctor-3. the F3 state — SessionStart wired, PreToolUse absent — FAILs with the install hint, exit 1", async () => {
  await withDir(async (tmp) => {
    const cfg = join(tmp, "config.json");
    // This machine's actual pre-0.4 config: old matcher, no PreToolUse.
    writeFileSync(
      cfg,
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: '"$(npm root -g)/deep-horizon/adapters/zcode/session-start"', enabled: true }] }],
          },
        },
      }) + "\n",
    );
    const r = await runCli(["doctor", "--harness", "zcode"], { env: wiringEnv({ zcodeConfig: cfg, pathDir: makeFakeBin(join(tmp, "bin")) }) });
    assert.equal(r.code, 1);
    const fail = r.stdout.split("\n").find((l) => l.includes("PreToolUse wired to pre-execute"));
    assert.ok(fail, `no PreToolUse check line: ${r.stdout}`);
    assert.match(fail, /FAIL/);
    assert.match(fail, /run: horizon install --harness zcode/);
  });
});

test("doctor-4. a corrupt config is FAIL lines, not a crash: invalid JSON named, no stack leaked, exit 1", async () => {
  await withDir(async (tmp) => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, "{not json");
    const r = await runCli(["doctor", "--harness", "zcode"], { env: wiringEnv({ zcodeConfig: cfg, pathDir: makeFakeBin(join(tmp, "bin")) }) });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /parses as JSON.*\(invalid JSON:/);
    assert.ok(!/    at /m.test(r.stdout), `stack leaked: ${r.stdout}`);
    assert.match(r.stdout, /SessionStart wired/);
    assert.match(r.stdout, /PreToolUse wired/);
    assert.ok(r.stdout.includes("FAIL"), "the wiring checks must fail, not vanish");
  });
});

test("doctor-5. an absent config: FAIL lines with the install hint, exit 1, still no crash", async () => {
  await withDir(async (tmp) => {
    const r = await runCli(["doctor", "--harness", "zcode"], { env: wiringEnv({ zcodeConfig: join(tmp, "absent.json"), pathDir: makeFakeBin(join(tmp, "bin")) }) });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /parses as JSON \(missing\)/);
    assert.match(r.stdout, /horizon install --harness zcode/);
  });
});

test("doctor-6. the hermes checks: a missing plugin dir, a disabled yaml entry, and missing PATH shims each FAIL with the fix hint", async () => {
  await withDir(async (tmp) => {
    const hermes = join(tmp, "hermes"); // nothing installed at all
    const r = await runCli(["doctor", "--harness", "hermes"], { env: wiringEnv({ hermesHome: hermes, pathDir: makeFakeBin(join(tmp, "bin")) }) });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /plugin files present.*FAIL|FAIL plugin files present/);
    assert.match(r.stdout, /horizon install --harness hermes/);
    // Plugin present but the yaml names something else: the enabled check fails alone.
    await withDir(async (tmp2) => {
      makeHermesHome(join(tmp2, "hermes"), { enabled: ["other-plugin"] });
      const r2 = await runCli(["doctor", "--harness", "hermes"], { env: wiringEnv({ hermesHome: join(tmp2, "hermes"), pathDir: makeFakeBin(join(tmp2, "bin")) }) });
      assert.equal(r2.code, 1);
      const enabledFail = r2.stdout.split("\n").find((l) => l.includes("plugins.enabled"));
      assert.ok(enabledFail && enabledFail.includes("FAIL"), r2.stdout);
      assert.ok(!/plugin files present.*FAIL/.test(r2.stdout), "the plugin check must still pass");
    });
  });
});

test("doctor-7. the default paths resolve through $HOME (os.homedir honours it on POSIX)", async () => {
  await withDir(async (fakeHome) => {
    mkdirSync(join(fakeHome, ".zcode", "cli"), { recursive: true });
    writeFileSync(join(fakeHome, ".zcode", "cli", "config.json"), zcodeConfigText());
    const r = await runCli(["doctor", "--harness", "zcode"], { env: wiringEnv({ home: fakeHome, pathDir: makeFakeBin(join(fakeHome, "bin")) }) });
    assert.equal(r.code, 0, r.stdout);
    assert.ok(r.stdout.includes(join(fakeHome, ".zcode", "cli", "config.json")));
  });
});

// --- install (ticket 10): parse → merge → validate → backup → atomic write ---

test("install-1. zcode on an absent config: starts from {}, writes the exact block, no backup of nothing", async () => {
  await withDir(async (tmp) => {
    const cfg = join(tmp, "config.json");
    const r = await runCli(["install", "--harness", "zcode"], { env: wiringEnv({ zcodeConfig: cfg }) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(cfg, "utf8")), {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [
            { matcher: "startup|resume", hooks: [{ type: "command", command: '"$(npm root -g)/deep-horizon/adapters/zcode/session-start"', enabled: true }] },
          ],
          PreToolUse: [
            { matcher: "Bash|Read|Edit|Write|NotebookEdit", hooks: [{ type: "command", command: '"$(npm root -g)/deep-horizon/adapters/zcode/pre-execute"', enabled: true, timeout: 10 }] },
          ],
        },
      },
    });
    assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith("config.json.bak")), [], "nothing existed to back up");
    assert.match(r.stdout, /set hooks\.enabled = true/);
    assert.match(r.stdout, /wired SessionStart/);
    assert.match(r.stdout, /wired PreToolUse/);
    assert.match(r.stdout, /wrote .*config\.json/);
  });
});

test("install-2. the merge preserves every foreign key: other entries, Stop, hooks.timeoutMs, top-level keys; an explicit enabled:false is left alone", async () => {
  await withDir(async (tmp) => {
    const cfg = join(tmp, "config.json");
    const before = {
      model: "test-model",
      mcpServers: { firecrawl: { command: "npx", args: ["-y", "firecrawl"] } },
      hooks: {
        enabled: false,
        timeoutMs: 60000,
        events: {
          SessionStart: [
            { matcher: "startup", hooks: [{ type: "command", command: '"$(npm root -g)/deep-horizon/adapters/zcode/session-start"', enabled: true }] },
            { matcher: "manual", hooks: [{ type: "command", command: "foreign-thing --run", enabled: true }] },
          ],
          Stop: [{ hooks: [{ type: "command", command: '"$(npm root -g)/deep-horizon/adapters/zcode/stop-steer"', enabled: false }] }],
        },
      },
    };
    writeFileSync(cfg, JSON.stringify(before, null, 2) + "\n");
    const r = await runCli(["install", "--harness", "zcode"], { env: wiringEnv({ zcodeConfig: cfg }) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const wired = JSON.parse(readFileSync(cfg, "utf8"));
    // Foreign keys survive untouched.
    assert.equal(wired.model, "test-model");
    assert.deepEqual(wired.mcpServers, before.mcpServers);
    assert.equal(wired.hooks.timeoutMs, 60000);
    // An explicit false is a deliberate disable: left as set, stated loudly.
    assert.equal(wired.hooks.enabled, false);
    assert.match(r.stdout, /hooks\.enabled is false/);
    // SessionStart: the stale deep-horizon entry replaced, the foreign one kept.
    assert.equal(wired.hooks.events.SessionStart.length, 2);
    assert.deepEqual(wired.hooks.events.SessionStart[0], before.hooks.events.SessionStart[1], "the foreign entry survives");
    assert.equal(wired.hooks.events.SessionStart[1].matcher, "startup|resume");
    // Stop is never touched — not even its deep-horizon-named entry.
    assert.deepEqual(wired.hooks.events.Stop, before.hooks.events.Stop);
    // The backup carries the pre-install bytes.
    const baks = readdirSync(tmp).filter((n) => n.startsWith("config.json.bak-pre-horizon-"));
    assert.equal(baks.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, baks[0]), "utf8")), before);
  });
});

test("install-3. refusals: corrupt JSON and unrecognized hooks shapes are loud, exit 2, bytes untouched, no backup", async () => {
  await withDir(async (tmp) => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, "{not json");
    const bytes = readFileSync(cfg, "utf8");
    const r = await runCli(["install", "--harness", "zcode"], { env: wiringEnv({ zcodeConfig: cfg }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /invalid JSON/);
    assert.match(r.stderr, /never writes over a config it cannot parse/);
    assert.equal(readFileSync(cfg, "utf8"), bytes, "a refused install must not write");
    assert.deepEqual(readdirSync(tmp).filter((n) => n.includes(".bak") || n.includes(".tmp")), []);
    // The unrecognized-shape twins.
    for (const shape of [{ hooks: "nope" }, { hooks: { events: 42 } }, { hooks: { events: { SessionStart: "nope" } } }]) {
      writeFileSync(cfg, JSON.stringify(shape));
      const r2 = await runCli(["install", "--harness", "zcode"], { env: wiringEnv({ zcodeConfig: cfg }) });
      assert.equal(r2.code, 2, `shape ${JSON.stringify(shape)}: ${r2.stderr}`);
      assert.match(r2.stderr, /unrecognized shape|not an object|not an array/);
      assert.equal(readFileSync(cfg, "utf8"), JSON.stringify(shape), "a refused install must not write");
    }
  });
});

test("install-4. idempotent: the second run writes nothing new — same bytes, no second backup, and it says so", async () => {
  await withDir(async (tmp) => {
    const cfg = join(tmp, "config.json");
    // Start from the pre-0.4 state so the first run has real work.
    writeFileSync(
      cfg,
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: '"$(npm root -g)/deep-horizon/adapters/zcode/session-start"', enabled: true }] }],
          },
        },
      }) + "\n",
    );
    const first = await runCli(["install", "--harness", "zcode"], { env: wiringEnv({ zcodeConfig: cfg }) });
    assert.equal(first.code, 0, first.stderr);
    const wired = readFileSync(cfg, "utf8");
    assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith("config.json.bak-pre-horizon-")).length, 1);
    const second = await runCli(["install", "--harness", "zcode"], { env: wiringEnv({ zcodeConfig: cfg }) });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /already wired; nothing to change/);
    assert.equal(readFileSync(cfg, "utf8"), wired, "the idempotent run must not rewrite");
    assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith("config.json.bak-pre-horizon-")).length, 1, "no backup when nothing was written");
  });
});

test("install-5. hermes fresh: the three plugin files land byte-identical, stale __pycache__ dies, config.yaml is created", async () => {
  await withDir(async (tmp) => {
    const home = join(tmp, "hermes");
    const pluginDir = join(home, "plugins", "deep-horizon");
    mkdirSync(join(pluginDir, "__pycache__"), { recursive: true });
    writeFileSync(join(pluginDir, "__pycache__", "deep_horizon.cpython-313.pyc"), "stale bytecode");
    const r = await runCli(["install", "--harness", "hermes"], { env: wiringEnv({ hermesHome: home }) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    for (const name of ["deep_horizon.py", "__init__.py", "plugin.yaml"]) {
      assert.ok(existsSync(join(pluginDir, name)), `${name} must be copied`);
      assert.deepEqual(readFileSync(join(pluginDir, name)).equals(readFileSync(join(HERMES_SRC, name))), true, `${name} must be byte-identical`);
    }
    assert.ok(!existsSync(join(pluginDir, "__pycache__")), "stale bytecode must not survive an upgrade copy");
    assert.equal(readFileSync(join(home, "config.yaml"), "utf8"), "plugins:\n  enabled:\n    - deep-horizon\n");
    assert.match(r.stdout, /copied deep_horizon\.py/);
    assert.match(r.stdout, /removed stale __pycache__/);
    assert.match(r.stdout, /created .*config\.yaml/);
  });
});

test("install-6. hermes yaml append: flow and block lists gain deep-horizon last, order preserved, backup taken, rest untouched", async () => {
  await withDir(async (tmp) => {
    // Flow list.
    const flowHome = makeHermesHome(join(tmp, "flow"), { enabled: ["other-plugin"], style: "flow" });
    const flowYaml = join(flowHome, "config.yaml");
    const flowBefore = readFileSync(flowYaml, "utf8");
    const r1 = await runCli(["install", "--harness", "hermes"], { env: wiringEnv({ hermesHome: flowHome }) });
    assert.equal(r1.code, 0, r1.stderr);
    assert.match(readFileSync(flowYaml, "utf8"), /enabled: \[other-plugin, deep-horizon\]/);
    assert.ok(readFileSync(flowYaml, "utf8").startsWith(flowBefore.split("plugins:")[0]), "content before the plugins block must survive");
    assert.equal(readdirSync(flowHome).filter((n) => n.startsWith("config.yaml.bak-pre-horizon-")).length, 1);
    // Block list — the real machine's shape, disabled list included.
    const blockHome = makeHermesHome(join(tmp, "block"), { enabled: ["other-plugin"], style: "block" });
    const blockYaml = join(blockHome, "config.yaml");
    const r2 = await runCli(["install", "--harness", "hermes"], { env: wiringEnv({ hermesHome: blockHome }) });
    assert.equal(r2.code, 0, r2.stderr);
    const after = readFileSync(blockYaml, "utf8");
    assert.match(after, /  enabled:\n    - other-plugin\n    - deep-horizon\n/, `block append: ${after}`);
    assert.match(after, /  disabled:\n    - horizon-line\n/, "the disabled list must be untouched");
    // A yaml with no plugins block gains one appended at the end.
    const bareHome = join(tmp, "bare");
    mkdirSync(join(bareHome, "plugins", "deep-horizon"), { recursive: true });
    copyFileSync(join(HERMES_SRC, "deep_horizon.py"), join(bareHome, "plugins", "deep-horizon", "deep_horizon.py"));
    copyFileSync(join(HERMES_SRC, "__init__.py"), join(bareHome, "plugins", "deep-horizon", "__init__.py"));
    copyFileSync(join(HERMES_SRC, "plugin.yaml"), join(bareHome, "plugins", "deep-horizon", "plugin.yaml"));
    writeFileSync(join(bareHome, "config.yaml"), "model:\n  default: m\n");
    const r3 = await runCli(["install", "--harness", "hermes"], { env: wiringEnv({ hermesHome: bareHome }) });
    assert.equal(r3.code, 0, r3.stderr);
    assert.equal(readFileSync(join(bareHome, "config.yaml"), "utf8"), "model:\n  default: m\nplugins:\n  enabled:\n    - deep-horizon\n");
  });
});

test("install-7. hermes idempotent: byte-identical files and an already-enabled yaml change nothing", async () => {
  await withDir(async (tmp) => {
    const home = makeHermesHome(join(tmp, "hermes"));
    const first = await runCli(["install", "--harness", "hermes"], { env: wiringEnv({ hermesHome: home }) });
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const yaml = join(home, "config.yaml");
    const bytes = readFileSync(yaml, "utf8");
    const pyBytes = readFileSync(join(home, "plugins", "deep-horizon", "deep_horizon.py")).toString("hex");
    const second = await runCli(["install", "--harness", "hermes"], { env: wiringEnv({ hermesHome: home }) });
    assert.equal(second.code, 0);
    assert.match(second.stdout, /already installed; nothing to change/);
    assert.equal(readFileSync(yaml, "utf8"), bytes);
    assert.equal(readFileSync(join(home, "plugins", "deep-horizon", "deep_horizon.py")).toString("hex"), pyBytes);
    assert.deepEqual(readdirSync(home).filter((n) => n.startsWith("config.yaml.bak")), [], "no backup when nothing was written");
  });
});

test("install-8. hermes refusal: an unreadable-shape yaml is loud, exit 2, untouched", async () => {
  await withDir(async (tmp) => {
    const home = makeHermesHome(join(tmp, "hermes"));
    writeFileSync(join(home, "config.yaml"), "plugins: {nested: true}\n");
    const bytes = readFileSync(join(home, "config.yaml"), "utf8");
    const r = await runCli(["install", "--harness", "hermes"], { env: wiringEnv({ hermesHome: home }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /plugins: is not a block mapping/);
    assert.match(r.stderr, /fix it by hand/);
    assert.equal(readFileSync(join(home, "config.yaml"), "utf8"), bytes);
  });
});

test("install-9. both harnesses: repeated flags and comma lists; a refusal on one does not block the other; usage errors stay usage errors", async () => {
  await withDir(async (tmp) => {
    const zcfg = join(tmp, "z.json");
    const hermes = join(tmp, "hermes");
    const env = wiringEnv({ zcodeConfig: zcfg, hermesHome: hermes });
    const both = await runCli(["install", "--harness", "zcode", "--harness", "hermes"], { env });
    assert.equal(both.code, 0, both.stdout + both.stderr);
    assert.ok(existsSync(zcfg), "zcode wired");
    assert.ok(existsSync(join(hermes, "plugins", "deep-horizon", "deep_horizon.py")), "hermes wired");
    // The comma form means the same thing on fresh fixtures.
    await withDir(async (tmp2) => {
      const env2 = wiringEnv({ zcodeConfig: join(tmp2, "z.json"), hermesHome: join(tmp2, "hermes") });
      const comma = await runCli(["install", "--harness", "zcode,hermes"], { env: env2 });
      assert.equal(comma.code, 0, comma.stdout + comma.stderr);
      assert.ok(existsSync(join(tmp2, "z.json")));
      assert.ok(existsSync(join(tmp2, "hermes", "plugins", "deep-horizon", "deep_horizon.py")));
    });
    // A corrupt zcode config refuses loudly while hermes still installs,
    // and the command still fails.
    await withDir(async (tmp3) => {
      writeFileSync(join(tmp3, "z.json"), "{not json");
      const mixed = await runCli(["install", "--harness", "zcode", "--harness", "hermes"], { env: wiringEnv({ zcodeConfig: join(tmp3, "z.json"), hermesHome: join(tmp3, "hermes") }) });
      assert.equal(mixed.code, 2);
      assert.match(mixed.stderr, /invalid JSON/);
      assert.ok(existsSync(join(tmp3, "hermes", "plugins", "deep-horizon", "deep_horizon.py")), "hermes must not be blocked by zcode's refusal");
    });
    // Usage: install without --harness, or with an unknown name.
    const bare = await runCli(["install"], { env: wiringEnv({ zcodeConfig: join(tmp, "z2.json") }) });
    assert.equal(bare.code, 2);
    assert.match(bare.stderr, /requires --harness/);
    const unknown = await runCli(["install", "--harness", "dsh"], { env: wiringEnv({}) });
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown harness: dsh/);
  });
});

test("usage-1. help and usage name doctor and install", async () => {
  const h = await runCli(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /doctor \[--harness <name>\]/);
  assert.match(h.stdout, /install --harness <name>.*zcode, hermes; repeat the flag or comma-separate/);
  const unknown = await runCli(["no-such-verb"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /doctor\|install/);
});

// Minimal withDir twin for tests that need a fixture outside withDir's
// protected body (the permission test restores its own mode).
function freshGuard() {
  return mkdtempSync(join(tmpdir(), "horizon-test-"));
}
