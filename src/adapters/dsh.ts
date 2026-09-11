// deep-horizon DSH adapter (reference implementation, D3).
//
// Glue only (D6): this module spawns the bins and hands their stdout to the
// harness. It never composes the section-10 texts — those live in the core
// (`horizon-inject` is the single composer) and a test greps this file to
// keep it that way (spec acceptance 36).
//
// Injection follows moving-target's proven DSH pattern (HL-10 research):
// `agent/session-start` guarded on source === "startup" and on
// delegationDepth/origin, seeding via agent.inject() without waking the
// driver. Hooks fail open (D2): an unresolvable bin injects nothing and the
// session proceeds.
//
// Session-end uses the mid-session fallback from day one (D3): DSH has no
// agent/session-end event, and agent/disposed fires unawaited after the loop
// stops, so on every turn stop of a top-level session the agent is steered
// once to run `horizon session-end` while model text is still available.
//
// The param trigger (HL-23, parity with hermes' pre_llm_call trigger): the
// `tools/pre-execute` waterfall fires for every tool execution with the
// call's parsed arguments, so a session launched in repo A that touches repo
// B mid-session (`git -C B`, absolute paths, a workdir argument) still gets
// repo B's horizon — queued once per store per session via agent.inject,
// and only for stores that already exist (no bootstrap here; that is the
// startup path's job). A tool call is never vetoed: the handler is
// pass-through by construction (it always returns next()) and fail-open
// inside.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isRecord, resolveStore } from "../store.ts";

const HARNESS = "dsh";

// Resolve and run a horizon bin. A repo checkout (this file still sitting in
// src/adapters/) runs bin/<name>.js with the current node; an installed
// package relies on the global bin on PATH (D2). Throws when the binary
// cannot be spawned at all (ENOENT) — callers treat that as fail-open.
function defaultSpawnBin(binName, args) {
  const local = new URL(`../../bin/${binName}.js`, import.meta.url);
  const res = existsSync(local)
    ? spawnSync(process.execPath, [local.pathname, ...args], { encoding: "utf8" })
    : spawnSync(binName, args, { encoding: "utf8" });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function message(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "deep-horizon", form: "instructions" },
  };
}

// Cheap guards only, mirroring moving-target: top-level sessions only, and
// only real startups (resume/compact replay the original injection).
function injectable(header, source) {
  if (!header || typeof header !== "object") return false;
  if (!header.cwd || typeof header.cwd !== "string") return false;
  if (source !== "startup") return false;
  return !subagentHeader(header);
}

// The one subagent rule every handler shares: a delegationDepth above zero
// or a subagent origin is never injected into. An unreadable header counts
// as a subagent (fail closed for injection — noise is avoidable, a missing
// horizon is not harm).
function subagentHeader(header) {
  if (!header || typeof header !== "object") return true;
  if ((header.delegationDepth ?? 0) > 0) return true;
  return header.origin === "subagent";
}

// Agents already nudged toward a mid-session session-end (one addendum per
// session, not one per turn). Weak so disposal can collect them.
const prompted = new WeakSet();

// Session starts seed once per agent object: some harnesses re-fire
// agent/session-start with source "startup", and the block must not land
// twice. Seeded only after a delivered inject, so a fail-open miss stays
// retryable. Weak so disposal can collect them.
const seeded = new WeakSet();

// Horizon stores already served this session, per agent: the param trigger
// injects a store at most once per session, and the store the startup
// injection served is recorded here too, so a session launched inside a
// repo never re-injects that repo's horizon on a mid-session touch. Weak
// like the sets above.
const served = new WeakMap();

function servedFor(agent) {
  let seen = served.get(agent);
  if (!seen) {
    seen = new Set();
    served.set(agent, seen);
  }
  return seen;
}

// Candidate target directories in one tool call's parsed arguments (the
// harness hands them deep-frozen — read-only here, nothing is mutated).
// Field-based, not tool-name-based, so unknown tool shapes simply yield no
// candidates. Relative paths never candidate: the adapter cannot know the
// shell's cwd, and resolving one against the harness process would guess
// (the hermes trigger drops them for the same reason).
const ABS_PATH = /(?:^|[\s(=;,"'`])((?:~\/|\/)[^\s'"`;|&)]*)/g;

function candidateDirs(args) {
  if (!isRecord(args)) return [];
  const out = [];
  const push = (value) => {
    if (typeof value !== "string" || value.length === 0) return;
    if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
    if (isAbsolute(value)) out.push(value);
  };
  push(args.workdir);
  for (const key of ["file_path", "path"]) {
    if (typeof args[key] === "string") push(dirname(args[key]));
  }
  if (typeof args.command === "string") {
    // Absolute tokens cover `git -C <dir>` targets too: they are just
    // whitespace-delimited absolute paths in the command string.
    for (const m of args.command.matchAll(ABS_PATH)) push(m[1]);
  }
  return out;
}

function turnStoppingAddendum(agent) {
  if (subagentHeader(agent?.session?.header)) return;
  if (prompted.has(agent)) return;
  if (typeof agent.id !== "string" || agent.id.length === 0) return;
  const sid = agent.id;
  const text =
    `Horizon bookkeeping (once per session): while you can still act on the answer, decide now whether this session closed or advanced anything the user agreed to. If yes, run this mid-session — do not wait for session close; this harness has no reliable close hook:\n` +
    `horizon session-end --harness ${HARNESS} --session ${sid} --summary "<one paragraph>"\n` +
    `The --summary must be the user's own account of the session, only with their explicit approval of those exact words; with no approval, omit --summary entirely (the record then carries no summary). A project without a horizon store: the command is a safe no-op.`;
  agent.steer(message(text));
  prompted.add(agent);
}

// Plugin entry point. `ctx` is the cordis plugin context; `overrides` exists
// only for tests (spawnBin). Handlers are async (await-able, never sync-
// throwing) and returned so tests can drive them without a live harness.
export function apply(ctx, overrides = {}) {
  const spawnBin = overrides.spawnBin ?? defaultSpawnBin;

  async function onSessionStart({ agent, source }) {
    const header = agent?.session?.header;
    if (!injectable(header, source)) return;
    if (seeded.has(agent)) return;
    let result;
    try {
      result = spawnBin("horizon-inject", ["--harness", HARNESS, "--cwd", header.cwd]);
    } catch {
      return; // fail open (D2): unresolvable bin injects nothing
    }
    if (!result || result.status !== 0) return;
    const text = typeof result.stdout === "string" ? result.stdout : "";
    if (text.length === 0) return;
    try {
      agent.inject(message(text));
      seeded.add(agent);
    } catch {
      // A rejecting inject must never take the session down; the horizon
      // returns next startup.
      return;
    }
    // Whatever the launch cwd's startup injection served counts as served:
    // a mid-session touch of the launch repo must not re-inject it.
    try {
      const found = resolveStore(header.cwd, { readonly: true });
      if (found) servedFor(agent).add(found.dir);
    } catch {
      // Fail open: an unresolvable launch store only means the param
      // trigger may serve it later.
    }
  }

  // The HL-23 param trigger. `tools/pre-execute` is a cordis waterfall: a
  // listener that never calls next() vetoes the tool call, so this handler
  // is pass-through by construction — it always returns next()'s result,
  // and everything it does before that is fail-open. The gate shapes it may
  // return are next()'s own (allow), never deny/ask.
  async function onPreExecute(exec, next) {
    try {
      const agent = exec?.agent;
      if (agent && typeof agent.inject === "function" && !subagentHeader(agent?.session?.header)) {
        for (const dir of candidateDirs(exec.arguments)) {
          const found = resolveStore(dir, { readonly: true });
          if (!found || found.open.code !== undefined) continue;
          const seen = servedFor(agent);
          if (seen.has(found.dir)) continue;
          seen.add(found.dir);
          let delivered = false;
          try {
            const result = spawnBin("horizon-inject", ["--harness", HARNESS, "--cwd", dir]);
            if (result && result.status === 0 && typeof result.stdout === "string" && result.stdout.length > 0) {
              agent.inject(message(result.stdout));
              delivered = true;
            }
          } catch {
            // Fail open (D2): an unresolvable bin or a rejecting inject
            // leaves the session untouched.
          }
          if (!delivered) seen.delete(found.dir);
        }
      }
    } catch {
      // A trigger error must never reach the tool call.
    }
    return next();
  }

  async function onTurnStopping(event) {
    try {
      turnStoppingAddendum(event?.agent ?? event);
    } catch {
      // Emit-mode listeners swallow errors; keep it that way explicitly.
    }
  }

  if (ctx && typeof ctx.on === "function") {
    ctx.on("agent/session-start", onSessionStart);
    ctx.on("agent/turn-stopping", onTurnStopping);
    ctx.on("tools/pre-execute", onPreExecute);
  }
  return { "agent/session-start": onSessionStart, "agent/turn-stopping": onTurnStopping, "tools/pre-execute": onPreExecute };
}
