// horizon-line pi adapter.
//
// Glue only (D6): this module spawns the bins and hands their stdout to the
// harness. It never composes the section-10 texts — those live in the core
// (`horizon-inject` is the single composer) and a test greps this file to
// keep it that way (spec acceptance 36).
//
// Injection follows the claude-rules.ts pattern (research/02 Part 2):
// `session_start` shells out and stashes the composed text; `before_agent_start`
// returns it as the injected message on the first prompt, exactly once. The
// `reason` enum decides fresh vs not: only `startup` stashes (a process launch
// is the one event that is certainly a new session; `new`/`resume`/`fork`/
// `reload` arrive inside a running process or replay an existing horizon).
//
// Subagent exclusion (09-open-items item C): `HORIZON_SUBAGENT` set to a truthy
// value (`1`, `true`, `yes`) suppresses injection. FAIL-OPEN: absent the
// variable, injection happens — a subagent that receives the horizon is noise,
// not harm.
//
// Close: `session_shutdown` runs `horizon session-end --harness pi --session
// <id>` (research/10 Part 4). Hooks fail open (D2): an unresolvable bin injects
// nothing and the session proceeds.
//
// Entry point: pi loads a package extension via its jiti loader and calls the
// DEFAULT export as `default(pi)` — the factory registers the three handlers
// on the ExtensionAPI. `apply(overrides)` is the testable core the default
// export delegates to; tests drive handlers without a live harness.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const HARNESS = "pi";

// Resolve and run a horizon bin. A repo checkout (this file still sitting in
// src/adapters/) runs bin/<name>.js with the current node; an installed
// package relies on the global bin on PATH (D2). Throws when the binary
// cannot be spawned at all (ENOENT) — callers treat that as fail-open. A
// timeout is set so a hung horizon-inject can never stall a session-start
// (spawnSync's no-timeout default would otherwise block the session forever —
// the DSH reference adapter's DEF-ADV-14-1 finding, fixed here at the shared
// pattern's root).
function defaultSpawnBin(binName, args) {
  const local = new URL(`../../bin/${binName}.js`, import.meta.url);
  let res;
  if (existsSync(local)) {
    res = spawnSync(process.execPath, [local.pathname, ...args], { encoding: "utf8", timeout: 15_000 });
  } else {
    res = spawnSync(binName, args, { encoding: "utf8", timeout: 15_000 });
  }
  if (res.error) throw res.error;
  // The installed package ships TS source; Node < 23.6 refuses to strip
  // types for files under node_modules, so the sibling bin dies with a
  // module-error exit before printing anything. Fall back to the PATH bin
  // (the global install from the same package has the same shape, but a
  // user-side compiled install, a wrapper, or a newer Node provides a
  // working one). Any nonzero sibling result falls through to PATH once.
  if (existsSync(local) && res.status !== 0) {
    const pathRes = spawnSync(binName, args, { encoding: "utf8", timeout: 15_000 });
    if (!pathRes.error) return { status: pathRes.status ?? -1, stdout: pathRes.stdout ?? "", stderr: pathRes.stderr ?? "" };
  }
  return res;
}

function message(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "horizon-line", form: "instructions" },
  };
}

function truthy(v) {
  return ["1", "true", "yes"].includes(String(v ?? "").toLowerCase());
}

// Plugin entry point. `ctx` is unused (pi passes the extension API, the
// handlers need nothing from it); `overrides` exists only for tests
// (spawnBin, now). Handlers are async (await-able, never sync-throwing) and
// returned so tests can drive them without a live harness.
export function apply(ctx, overrides = {}) {
  const spawnBin = overrides.spawnBin ?? defaultSpawnBin;
  // Stash for the composed text; also remembers the session id for the close
  // hook. WeakMap on ctx is not possible (ctx may be a plain object), so one
  // instance per apply() call — pi rebinds extensions per session
  // (session_shutdown then a fresh session_start), which is exactly one
  // horizon lifecycle per apply().
  let stashed = null; // { text, sessionId, cwd }

  async function onSessionStart(event, pictx = {}) {
    try {
      if (event?.reason !== "startup") return;
      if (truthy(process.env.HORIZON_SUBAGENT)) return; // item C, fail-open
      const cwd = typeof pictx?.cwd === "string" && pictx.cwd.length > 0
        ? pictx.cwd
        : process.cwd();
      const sessionId = pictx?.sessionManager?.getSessionId?.() ?? null;
      let result;
      try {
        result = spawnBin("horizon-inject", ["--harness", HARNESS, "--cwd", cwd]);
      } catch {
        return; // fail open (D2): unresolvable bin injects nothing
      }
      if (!result || result.status !== 0) return;
      const text = typeof result.stdout === "string" ? result.stdout : "";
      if (text.length === 0) return;
      stashed = { text, sessionId, cwd };
    } catch {
      // session_start is a setup event; it must never take the session down.
    }
  }

  async function onBeforeAgentStart(event, _pictx = {}) {
    try {
      if (!stashed) return undefined;
      const text = stashed.text;
      stashed = null; // once per session, exactly
      return { message: { customType: "horizon-line", content: text, display: false } };
    } catch {
      return undefined;
    }
  }

  async function onSessionShutdown(event, pictx = {}) {
    try {
      // Prefer a live id from the ctx; fall back to what session_start saw.
      const sessionId = pictx?.sessionManager?.getSessionId?.() ?? stashed?.sessionId ?? null;
      stashed = null;
      if (!sessionId || typeof sessionId !== "string") return;
      try {
        spawnBin("horizon", ["session-end", "--harness", HARNESS, "--session", sessionId]);
      } catch {
        // fail open (D2)
      }
    } catch {
      // Shutdown handlers must never break teardown.
    }
  }

  return {
    "session_start": onSessionStart,
    "before_agent_start": onBeforeAgentStart,
    "session_shutdown": onSessionShutdown,
  };
}

// pi's extension factory (jiti default export): register the handlers on the
// ExtensionAPI. Returns the same handler map so tests can drive it directly.
export default function horizonLine(pi) {
  const handlers = apply(undefined, {});
  pi.on("session_start", handlers["session_start"]);
  pi.on("before_agent_start", handlers["before_agent_start"]);
  pi.on("session_shutdown", handlers["session_shutdown"]);
  return handlers;
}
