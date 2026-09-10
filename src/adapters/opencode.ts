// deep-horizon opencode adapter — DEGRADED (D4).
//
// Glue only (D6): this module spawns the bin and prepends its stdout to the
// first user message. It never composes the section-10 texts — those live in
// the core (`horizon-inject` is the single composer) and a test greps this
// file to keep it that way (spec acceptance 36).
//
// Degraded, stated plainly (D4): opencode has no session-start hook and no
// close hook at all (the dispose hook receives no arguments, so not even a
// session id survives), so this adapter
//
//   - injects via a `chat.message` prepend, once per session, on the
//     heuristic (fresh `session.time.created` + empty persisted history),
//   - excludes subagents via `session.parentID`,
//   - writes NO session records. opencode sessions are invisible to
//     sessions.jsonl; its gaps still read and write like everyone else's.
//
// New-vs-resumed is a heuristic, not a guarantee (research/01 Part 2 §3):
// nothing in the `chat.message` hook says whether the session is fresh. The
// adapter treats a session as fresh when it was created within
// FRESH_WINDOW_MS of now AND has no persisted messages. That is correct for
// new sessions; a resumed session a few ms old with an empty history could
// double-inject (cosmetic: the horizon block appears twice; the horizon is
// inherited, not assigned).
//
// Hooks fail open (D2): an unresolvable bin or an unreachable client injects
// nothing and the session proceeds.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const HARNESS = "opencode";
const FRESH_WINDOW_MS = 60_000;

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
  // types for files under node_modules, so the sibling bin can die with a
  // module-error exit before printing anything. Fall back to the PATH bin
  // once on any nonzero sibling result (a wrapper, a compiled install, or a
  // newer Node provides a working one).
  if (existsSync(local) && res.status !== 0) {
    const pathRes = spawnSync(binName, args, { encoding: "utf8", timeout: 15_000 });
    if (!pathRes.error) return { status: pathRes.status ?? -1, stdout: pathRes.stdout ?? "", stderr: pathRes.stderr ?? "" };
  }
  return res;
}

function truthy(v) {
  return ["1", "true", "yes"].includes(String(v ?? "").toLowerCase());
}

// Plugin entry point. `input` carries the opencode plugin context ({ client,
// directory, ... }); `overrides` exists only for tests (spawnBin, now).
// Returns the Hooks object.
export async function apply(input, overrides = {}) {
  const spawnBin = overrides.spawnBin ?? defaultSpawnBin;
  const now = overrides.now ?? (() => Date.now());
  const client = input?.client;
  // One injection per plugin instance. opencode instantiates the plugin once
  // per server process, not per session, so freshness is tracked per session
  // id: first chat.message wins, every later message in that session is a
  // no-op regardless of what the heuristic would say.
  const injected = new Set();

  async function chatMessage(msgInput, output) {
    try {
      const sessionID = msgInput?.sessionID;
      if (!sessionID || typeof sessionID !== "string" || injected.has(sessionID)) return;
      if (truthy(process.env.HORIZON_SUBAGENT)) return; // belt-and-braces: the parentID check is the real guard
      // Subagent exclusion (research/01 Part 2 §4): child sessions carry
      // parentID. A client that cannot answer means we cannot tell — skip.
      // Verified against opencode 1.18.29's server: the client call shape is
      // { path: { id }, query: { directory } } and the Session comes back on
      // res.data (the raw Session object).
      let info = null;
      if (client?.session?.get) {
        try {
          const res = await client.session.get({ path: { id: sessionID }, query: { directory: input?.directory }, throwOnError: true });
          info = res?.data ?? res ?? null;
        } catch {
          return; // unreachable client: fail open with nothing injected
        }
      }
      if (!info) return;
      if (info.parentID) return;
      // Fresh heuristic: created within the window AND no persisted history.
      const created = typeof info?.time?.created === "number" ? info.time.created : 0;
      if (created <= 0 || now() - created > FRESH_WINDOW_MS) return;
      let count = 0;
      if (client?.session?.messages) {
        try {
          const res = await client.session.messages({ path: { id: sessionID }, query: { directory: input?.directory }, throwOnError: true });
          const list = res?.data ?? res;
          count = Array.isArray(list) ? list.length : 0;
        } catch {
          count = 0; // cannot read history: treat as empty (fresh-leaning)
        }
      }
      if (count > 0) return;
      let result;
      try {
        result = spawnBin("horizon-inject", ["--harness", HARNESS, "--cwd", input?.directory ?? process.cwd()]);
      } catch {
        return; // fail open (D2)
      }
      if (!result || result.status !== 0) return;
      const text = typeof result.stdout === "string" ? result.stdout : "";
      if (text.length === 0) return;
      const parts = output?.parts;
      if (!Array.isArray(parts)) return;
      // opencode 1.18.29 TextPart requires id/sessionID/messageID — and the
      // id must match the part-id format ("prt_" prefix, schema-validated).
      // Build a fully-formed part from the existing first part's identifiers
      // so the persisted message stays schema-valid.
      const base = parts.find((p) => p && typeof p === "object") ?? {};
      parts.unshift({
        id: typeof base.id === "string" ? `prt_${base.id.slice(4, 20)}h` : `prt_horizon${Date.now().toString(36)}`,
        type: "text",
        text,
        sessionID: base.sessionID ?? sessionID,
        messageID: base.messageID ?? msgInput?.messageID ?? output?.message?.id,
      });
      injected.add(sessionID);
    } catch {
      // A plugin must never take the session down; the horizon returns next
      // session (within the freshness window).
    }
  }

  return { "chat.message": chatMessage };
}
