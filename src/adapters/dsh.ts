// horizon-line DSH adapter (reference implementation, D3).
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
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

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
    source: { kind: "plugin", plugin: "horizon-line", form: "instructions" },
  };
}

// Cheap guards only, mirroring moving-target: top-level sessions only, and
// only real startups (resume/compact replay the original injection).
function injectable(header, source) {
  if (!header || typeof header !== "object") return false;
  if (!header.cwd || typeof header.cwd !== "string") return false;
  if (source !== "startup") return false;
  if ((header.delegationDepth ?? 0) > 0) return false;
  if (header.origin === "subagent") return false;
  return true;
}

// Agents already nudged toward a mid-session session-end (one addendum per
// session, not one per turn). Weak so disposal can collect them.
const prompted = new WeakSet();

function turnStoppingAddendum(agent) {
  const header = agent?.session?.header;
  if (!header || (header.delegationDepth ?? 0) > 0 || header.origin === "subagent") return;
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
    } catch {
      // A rejecting inject must never take the session down; the horizon
      // returns next startup.
    }
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
  }
  return { "agent/session-start": onSessionStart, "agent/turn-stopping": onTurnStopping };
}
