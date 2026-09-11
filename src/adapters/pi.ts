// deep-horizon pi adapter.
//
// Glue only (D6): this module spawns the bins and hands their stdout to the
// harness. It never composes the section-10 texts — those live in the core
// (`horizon-inject` is the single composer) and a test greps this file to
// keep it that way (spec acceptance 36).
//
// Injection follows the claude-rules.ts pattern (research/02 Part 2):
// `session_start` shells out to `horizon-inject --json` and stashes the total
// answer — the composed text plus the store dir the composer resolved;
// `before_agent_start` returns the text as the injected message on the first
// prompt, exactly once, while the store rides separately to the close hook.
// The `reason` enum decides fresh vs not: only `startup` stashes (a process
// launch is the one event that is certainly a new session; `new`/`resume`/
// `fork`/`reload` arrive inside a running process or replay an existing
// horizon).
//
// Subagent exclusion (09-open-items item C): `HORIZON_SUBAGENT` set to a truthy
// value (`1`, `true`, `yes`) suppresses injection. FAIL-OPEN: absent the
// variable, injection happens — a subagent that receives the horizon is noise,
// not harm.
//
// Close: `session_shutdown` runs `horizon session-end --harness pi --session
// <id>`, passing `--store` with the dir the startup injection resolved when
// one was stashed — teardown must not re-discover (the harness process may
// have chdir'd since). Without a stashed store (a storeless startup, or a
// shutdown after no startup) the command keeps its cwd-discovery form.
// Hooks fail open (D2): an unresolvable bin injects nothing and the session
// proceeds.
//
// Entry point: pi loads a package extension via its jiti loader and calls the
// DEFAULT export as `default(pi)` — the factory registers the three handlers
// on the ExtensionAPI. `apply(overrides)` is the testable core the default
// export delegates to; tests drive handlers without a live harness.
// The spawn/parse plumbing (runBin, parseInjectAnswer, truthy) is the shared
// policy in ./support.ts — one timeout, one PATH fallback for every TS
// adapter.
import { parseInjectAnswer, runBin, truthy } from "./support.ts";

const HARNESS = "pi";

// Plugin entry point. `ctx` is unused (pi passes the extension API, the
// handlers need nothing from it); `overrides` exists only for tests
// (spawnBin, now). Handlers are async (await-able, never sync-throwing) and
// returned so tests can drive them without a live harness.
export function apply(ctx, overrides = {}) {
  const spawnBin = overrides.spawnBin ?? runBin;
  // Stash for the startup answer ({text, store, sessionId, cwd}); also
  // remembers the session id for the close hook. WeakMap on ctx is not
  // possible (ctx may be a plain object), so one instance per apply() call —
  // pi rebinds extensions per session (session_shutdown then a fresh
  // session_start), which is exactly one horizon lifecycle per apply().
  let stashed = null;
  // The store the delivered horizon was composed from, kept past the text
  // stash (before_agent_start consumes the text exactly once) so the close
  // hook can hand it back with --store even after delivery. Null when the
  // startup answer was storeless — the close command then keeps its
  // cwd-discovery form.
  let deliveredStore = null;

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
        result = await spawnBin("horizon-inject", ["--harness", HARNESS, "--json", "--cwd", cwd]);
      } catch {
        return; // fail open (D2): unresolvable bin injects nothing
      }
      if (!result || result.status !== 0) return;
      const answer = parseInjectAnswer(result.stdout);
      if (!answer || answer.text.length === 0) return;
      stashed = { text: answer.text, store: answer.store, sessionId, cwd };
    } catch {
      // session_start is a setup event; it must never take the session down.
    }
  }

  async function onBeforeAgentStart(event, _pictx = {}) {
    try {
      if (!stashed) return undefined;
      const text = stashed.text;
      deliveredStore = stashed.store; // rides to the close hook (--store)
      stashed = null; // once per session, exactly
      return { message: { customType: "deep-horizon", content: text, display: false } };
    } catch {
      return undefined;
    }
  }

  async function onSessionShutdown(event, pictx = {}) {
    try {
      // Prefer a live id from the ctx; fall back to what session_start saw.
      const sessionId = pictx?.sessionManager?.getSessionId?.() ?? stashed?.sessionId ?? null;
      // The store the composer resolved, delivered or not — teardown must
      // not re-discover it (the process may have chdir'd since startup).
      const store = deliveredStore ?? stashed?.store ?? null;
      stashed = null;
      deliveredStore = null;
      if (!sessionId || typeof sessionId !== "string") return;
      try {
        const args = ["session-end", "--harness", HARNESS, "--session", sessionId];
        if (store !== null) args.push("--store", store);
        await spawnBin("horizon", args);
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
