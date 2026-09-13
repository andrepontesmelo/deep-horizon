// deep-horizon DSH adapter (reference implementation, D3).
//
// Glue only (D6): this module spawns the bins and hands their stdout to the
// harness. It never composes the section-10 texts — those live in the core
// (`horizon-inject` is the single composer) and a test greps this file to
// keep it that way (spec acceptance 36).
//
// Injection follows moving-target's proven DSH pattern (HL-10 research):
// `agent/session-start` guarded on source === "startup" and on
// delegationDepth/origin. Hooks fail open (D2): an unresolvable bin injects
// nothing and the session proceeds.
//
// The startup block is resolved at session-start but delivered at the
// session's first `agent/pre-step`: session-start is a fire-and-forget emit
// (the loop never awaits its listeners), so an agent.inject() there races
// turn 1's inbox claim, loses, and lands in next-step — the model's second
// step. The pre-step waterfall is awaited by the loop and its decision's
// message list is exactly what the step's request commits, so the seed
// prepends there. The emit runs the listener body synchronously up to its
// first await, so the spawn promise is armed during the emit itself and the
// pre-step handler awaits it — step 1 waits for the still-running bin
// (bounded by the support.ts timeout) instead of going out without the
// horizon.
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
// repo B's horizon — queued once per store per session via agent.inject.
// The trigger never discovers stores for itself: it asks the bin
// (`horizon-inject --json`), whose total answer carries the text plus the
// resolved store dir the dedup keys on — null for a storeless target (no
// bootstrap here; that is the startup path's job), remembered so a storeless
// repo never re-spawns on every tool call. A call's fresh dirs probe
// concurrently — the spawns are independent and the waterfall awaits the
// batch either way — and N dirs resolving to one store still inject exactly
// once. A tool call is never vetoed: the
// handler is pass-through by construction (it always returns next()) and
// fail-open inside.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
// The shared spawn/parse policy (support.ts): one resolution order, one
// timeout, one PATH fallback — the DEF-ADV-14-1 fix lives here now, so this
// adapter can no longer hang a tool call on a stuck bin.
import { isRecord, parseInjectAnswer, runBin } from "./support.ts";

const HARNESS = "dsh";

function message(text) {
  return {
    // dsh's inbox dedupes pending messages by id across both queues, and an
    // absent id still collides ("undefined" is already pending) — every
    // message needs a fresh identity or the session's second delivery dies
    // inside the harness.
    id: `deep-horizon-${randomUUID()}`,
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

// Session starts arm the spawn once per agent object: some harnesses re-fire
// agent/session-start with source "startup", and the bin must not be spawned
// twice. `seeded` lands when the answer is in hand (the armed promise's
// settlement), so a fail-open miss stays re-armable; delivery releases the
// armed entry. Weak so disposal can collect them.
const seeded = new WeakSet();

// The startup seed per agent: the promise of the bin's answer (the text, or
// null for a fail-open miss), armed synchronously at the session-start emit
// — the emit calls the listener body up to its first await, so the promise
// already exists when turn 1's pre-step fires, though the loop never awaits
// that emit. The pre-step handler awaits it there; the support.ts timeout
// bounds the wait. Weak so disposal can collect them.
const seeds = new WeakMap();

// What a session already knows, per agent. `served` — the horizon stores
// already injected this session (the startup injection's store included):
// the once-per dedup key. `probed` — every repo path the bin has already
// answered for this session, mapped to that answer (null = storeless:
// silence, and never a re-spawn). A failed delivery releases both the
// store's claim and the dir's probe so the next call retries. Weak like the
// sets above, so disposal can collect them.
const memories = new WeakMap();

function memoryFor(agent) {
  let mem = memories.get(agent);
  if (!mem) {
    mem = { served: new Set(), probed: new Map() };
    memories.set(agent, mem);
  }
  return mem;
}

// Candidate target directories in one tool call's parsed arguments (the
// harness hands them deep-frozen — read-only here, nothing is mutated).
// Field-based, not tool-name-based, so unknown tool shapes simply yield no
// candidates. Relative paths never candidate: the adapter cannot know the
// shell's cwd, and resolving one against the harness process would guess
// (the hermes trigger drops them for the same reason). Absolute tokens are
// lexically normalized (path.resolve — no filesystem access) so token
// spellings of one path (`/a/b`, `/a/b//b`, `/a/b/.`) share one probe key,
// and a dir named twice in one call is probed once.
const ABS_PATH = /(?:^|[\s(=;,"'`])((?:~\/|\/)[^\s'"`;|&)]*)/g;

function candidateDirs(args) {
  if (!isRecord(args)) return [];
  const out = [];
  const seen = new Set();
  const push = (value) => {
    if (typeof value !== "string" || value.length === 0) return;
    if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
    if (!isAbsolute(value)) return;
    const dir = resolve(value);
    if (!seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
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
  const spawnBin = overrides.spawnBin ?? runBin;

  async function onSessionStart({ agent, source }) {
    const header = agent?.session?.header;
    if (!injectable(header, source)) return;
    if (seeded.has(agent) || seeds.has(agent)) return;
    // Armed before the first await, so the stash exists while the bin is
    // still running — turn 1's pre-step fires inside that window, and a
    // stash that waited for the answer would not exist yet (the seed then
    // lands at step 2 and step 1 goes out blind). The awaiting happens in
    // onPreStep instead.
    let spawning;
    try {
      spawning = spawnBin("horizon-inject", ["--harness", HARNESS, "--json", "--cwd", header.cwd]);
    } catch {
      return; // fail open (D2): a spawn that cannot even be armed injects nothing
    }
    const pending = Promise.resolve(spawning)
      .then((result) => {
        const answer = result && result.status === 0 ? parseInjectAnswer(result.stdout) : null;
        if (!answer || answer.text.length === 0) {
          seeds.delete(agent); // a fail-open miss: the re-fired startup may re-arm
          return null;
        }
        // The bin's answer is this session's knowledge of the launch dir: the
        // store it served counts as served (a mid-session touch must not
        // re-inject it), and the launch dir counts as probed so the param path
        // never re-asks the bin for it.
        const mem = memoryFor(agent);
        if (answer.store !== null) mem.served.add(answer.store);
        mem.probed.set(header.cwd, answer.store);
        seeded.add(agent);
        return answer.text;
      })
      .catch(() => {
        seeds.delete(agent); // a rejecting spawn releases the same way
        return null;
      });
    seeds.set(agent, pending);
  }

  // The startup seed's delivery point. `agent/pre-step` is the awaited
  // waterfall whose decision's messages are exactly the step's committed
  // request, so the seed prepends there and the model's first call sees the
  // horizon ahead of the launch prompt — including the live race where the
  // bin is still running when step 1 assembles: the decision waits for the
  // armed promise, never the reverse. Pass-through by construction: no
  // pending seed returns next()'s decision untouched; a reject (or an empty
  // step) leaves the seed pending for the next one.
  async function onPreStep(input, next) {
    const pending = input?.agent ? seeds.get(input.agent) : undefined;
    if (!pending) return next();
    const decision = await next();
    if (decision?.kind !== "enter" || decision.messages.length === 0) return decision;
    const text = await pending;
    if (text === null) return decision; // a fail-open miss: nothing to prepend, the entry is already released
    seeds.delete(input.agent);
    return { ...decision, messages: [message(text), ...decision.messages] };
  }

  // One dir's probe, as its own concurrent task: ask the bin, remember the
  // answer, deliver at most one inject per store. Fail-open per probe; a
  // failed delivery releases both the store's claim and the dir's probe so
  // the next call retries (dsh-param-9). All post-spawn bookkeeping runs on
  // the single thread, so check-then-claim is atomic per answer and N dirs
  // resolving to one store still inject exactly once.
  async function probeAndDeliver(agent, mem, dir) {
    let result;
    try {
      result = await spawnBin("horizon-inject", ["--harness", HARNESS, "--json", "--cwd", dir]);
    } catch {
      return; // fail open (D2); the dir stays unprobed — the next call retries
    }
    const answer = result && result.status === 0 ? parseInjectAnswer(result.stdout) : null;
    if (!answer) return; // nonzero or off-shape: unprobed, unclaimed — retry next call
    // The bin's answer is the one store-existence rule: store null is
    // silence (never the nudge), remembered so a storeless repo does
    // not re-spawn on every tool call.
    mem.probed.set(dir, answer.store);
    if (answer.store === null) return;
    if (mem.served.has(answer.store)) return;
    mem.served.add(answer.store);
    if (answer.text.length === 0) return; // a total silence: claimed, nothing to deliver
    let delivered = false;
    try {
      agent.inject(message(answer.text));
      delivered = true;
    } catch {
      // A rejecting inject releases the claim below: the next identical
      // call retries the delivery (dsh-param-9).
    }
    if (!delivered) {
      mem.served.delete(answer.store);
      mem.probed.delete(dir);
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
        const mem = memoryFor(agent);
        // Fresh dirs probe concurrently: the spawns are independent, and the
        // waterfall awaits the batch either way — `cp /a/x /b/y /c/z` with
        // three unseen dirs must not pay three serial node startups inside
        // it. Keys are normalized (candidateDirs), so duplicates are already
        // gone; each survivor's once-per bookkeeping is its own task.
        const fresh = candidateDirs(exec.arguments).filter((dir) => !mem.probed.has(dir));
        await Promise.all(fresh.map((dir) => probeAndDeliver(agent, mem, dir)));
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
    ctx.on("agent/pre-step", onPreStep);
    ctx.on("agent/turn-stopping", onTurnStopping);
    ctx.on("tools/pre-execute", onPreExecute);
  }
  return { "agent/session-start": onSessionStart, "agent/pre-step": onPreStep, "agent/turn-stopping": onTurnStopping, "tools/pre-execute": onPreExecute };
}
