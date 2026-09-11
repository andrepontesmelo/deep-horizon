import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  SESSIONS_FILE,
  addGap,
  amendGap,
  appendLine,
  closeGap,
  ensureStoreDir,
  readCloses,
  readGap,
  readGapsFile,
  readSessions,
  resolveStore,
  setAbout,
  setDetail,
  usage,
  utcNow,
} from "./store.ts";
import { gapLine } from "./texts.ts";

const COMMANDS = ["show", "about", "add", "close", "amend", "detail", "log", "session-end", "init"];
const VALUE_FLAGS = new Set(["--cwd", "--harness", "--session", "--origin", "--summary", "--limit", "--detail", "--store"]);
const BOOL_FLAGS = new Set(["--json", "--help", "--version", "--clear"]);

function flagKey(name) {
  return name.slice(2);
}

function stdout(s) {
  process.stdout.write(s);
}

function stderr(s) {
  process.stderr.write(s);
}

// Shared with the composer: horizon-inject --version prints the same
// package version under the bin's own name (src/inject.ts imports this —
// one reader of package.json, one fallback).
export function cliVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function helpText() {
  return (
    usage() +
    "\n\ncommands:\n" +
    "  show                      print open gaps (id + two spaces + text)\n" +
    "  about                     print the about line\n" +
    "  about \"<text>\"            set or replace the about line (what this project is)\n" +
    "  about --clear             unset the about line\n" +
    "  add <id> \"<text>\"         append a gap under a caller-chosen slug id; prints the id (--detail \"<text>\" attaches details)\n" +
    "  close <id>                remove a gap; frees a slot\n" +
    "  amend <id> \"<text>\"       rewrite a gap's text in place\n" +
    "  detail <id>               print a gap's details\n" +
    "  detail <id> \"<text>\"      set or rewrite a gap's details (2048 code points max)\n" +
    "  detail <id> --clear       remove a gap's details\n" +
    "  log [--limit N]           print session records, newest first\n" +
    "  session-end --harness <name> --session <id> [--summary \"<text>\"] [--store <dir>]\n" +
    "  init                      create .horizon/ in --cwd\n"
  );
}

// Parse one flag at tokens[i]. Returns {next} or {error}.
function takeFlag(tokens, i, opts, explicit) {
  const t = tokens[i];
  let name = t;
  let value = null;
  let hasEq = false;
  const eq = t.indexOf("=");
  if (eq !== -1) {
    name = t.slice(0, eq);
    value = t.slice(eq + 1);
    hasEq = true;
  }
  if (BOOL_FLAGS.has(name)) {
    if (hasEq) return { error: `horizon: ${name} takes no value` };
    opts[flagKey(name)] = true;
    explicit.add(flagKey(name));
    return { next: i + 1 };
  }
  if (VALUE_FLAGS.has(name)) {
    if (!hasEq) {
      if (i + 1 >= tokens.length) return { error: `horizon: ${name} requires a value` };
      value = tokens[i + 1];
      opts[flagKey(name)] = value;
      explicit.add(flagKey(name));
      return { next: i + 2 };
    }
    opts[flagKey(name)] = value;
    explicit.add(flagKey(name));
    return { next: i + 1 };
  }
  return { error: `horizon: unknown option: ${name}` };
}

// Split tokens into flags and positionals. "--" ends flag parsing.
function parseFlags(tokens, opts, explicit) {
  const positionals = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (t.startsWith("--") && t.length > 2) {
      const r = takeFlag(tokens, i, opts, explicit);
      if (r.error) return { error: r.error };
      i = r.next;
    } else {
      positionals.push(t);
      i += 1;
    }
  }
  return { positionals };
}

// Text-shape validation (one-line cap, details cap) and every gaps.json
// mutation live in the store module: the verbs below hand it semantic inputs
// and report whatever { code, message } comes back, so the write invariant —
// revision bump, closed_ids, about preservation — is enforced in one place.

function logTimestamp(ts) {
  if (typeof ts === "string" && ts.length >= 16) return `${ts.slice(0, 10)} ${ts.slice(11, 16)}`;
  return String(ts);
}

export async function main(argv) {
  const globals = {};
  const globalExplicit = new Set();
  const p1 = parseFlags(argv, globals, globalExplicit);
  let json = !!globals.json;
  const fail = (code, message) => {
    if (json) {
      stdout(JSON.stringify({ error: { code, message } }) + "\n");
    } else if (code === 2) {
      stderr(`${message}\n${usage()}\n`);
    } else {
      stderr(`${message}\n`);
    }
    return code;
  };
  if (p1.error) return fail(2, p1.error);

  const command = p1.positionals[0];
  const rest = p1.positionals.slice(1);
  if (globals.help) {
    stdout(helpText() + "\n");
    return 0;
  }
  if (globals.version) {
    stdout(`horizon ${cliVersion()}\n`);
    return 0;
  }
  if (command === undefined) return fail(2, "horizon: no command given");
  if (!COMMANDS.includes(command)) return fail(2, `horizon: unknown command: ${command}`);

  // Per-command parsing: add/amend/about take their text positionally first
  // so a text starting with dashes is still treated as text.
  let text = null;
  let targetId = null;
  if (command === "add") {
    if (rest.length === 0) return fail(2, "horizon: add requires <id> <text>");
    if (rest.length === 1) return fail(2, "horizon: add requires <text>");
    targetId = rest[0];
    text = rest[1];
  } else if (command === "close") {
    if (rest.length === 0) return fail(2, "horizon: close requires <id>");
    targetId = rest[0];
  } else if (command === "amend") {
    if (rest.length === 0) return fail(2, "horizon: amend requires <id> <text>");
    if (rest.length === 1) return fail(2, "horizon: amend requires <text>");
    targetId = rest[0];
    text = rest[1];
  } else if (command === "detail") {
    // Like amend, with the text optional: `detail <id>` prints, `detail <id>
    // "<text>"` sets, `--clear` removes (rejected together with text below).
    if (rest.length === 0) return fail(2, "horizon: detail requires <id>");
    targetId = rest[0];
    if (rest.length > 1) text = rest[1];
  } else if (command === "about") {
    // Optional single positional: `about "<text>"` sets, bare `about` prints.
    if (rest.length > 0) text = rest[0];
  }
  const flagTokens =
    command === "add"
      ? rest.slice(2)
      : command === "close"
        ? rest.slice(1)
        : command === "amend"
          ? rest.slice(2)
          : command === "detail"
            ? rest.slice(2)
            : command === "about"
              ? rest.slice(1)
              : rest;
  const cmdOpts = {};
  const cmdExplicit = new Set();
  const p2 = parseFlags(flagTokens, cmdOpts, cmdExplicit);
  if (p2.error) return fail(2, p2.error);
  if (p2.positionals.length > 0) return fail(2, `horizon: unexpected argument: ${p2.positionals[0]}`);

  const opts = { ...globals, ...cmdOpts };
  const explicit = new Set([...globalExplicit, ...cmdExplicit]);
  json = !!opts.json;

  const cwd = opts.cwd ?? process.cwd();
  const harness = opts.harness ?? process.env.HORIZON_HARNESS ?? "unknown";
  const session = opts.session ?? "unknown";
  const origin = opts.origin ?? "human";
  if (origin !== "human" && origin !== "agent-proposed") {
    return fail(2, `horizon: --origin must be human or agent-proposed, got: ${origin}`);
  }

  switch (command) {
    case "show": {
      const r = resolveStore(cwd);
      if (!r) {
        if (json) stdout("[]\n");
        return 0;
      }
      if (r.open.code !== undefined) return fail(r.open.code, r.open.message);
      const storeDir = r.dir;
      const g = readGapsFile(storeDir);
      if (!g.ok) return fail(g.code, g.message);
      if (json) {
        stdout(JSON.stringify(g.data.gaps) + "\n");
      } else {
        // The about line prints as a header (`about` + two spaces + text,
        // the gap line format) ahead of the gap lines — and alone when the
        // store has an about but no gaps. --json output stays the bare gaps
        // array, unchanged (spec 3.1, 10.4).
        const lines = [];
        if (typeof g.data.about === "string") lines.push(`about  ${g.data.about}`);
        for (const gap of g.data.gaps) lines.push(gapLine(gap));
        if (lines.length > 0) stdout(lines.join("\n") + "\n");
      }
      return 0;
    }

    case "about": {
      const clear = !!opts.clear;
      if (clear && text !== null) return fail(2, "horizon: about --clear takes no text");
      if (!clear && text === null) {
        // Print mode: the current line, or nothing at all when unset —
        // emptiness is not an error (same shape as `show` on an empty store).
        const r = resolveStore(cwd);
        if (!r) return 0;
        if (r.open.code !== undefined) return fail(r.open.code, r.open.message);
        const g = readGapsFile(r.dir);
        if (!g.ok) return fail(g.code, g.message);
        if (typeof g.data.about === "string") stdout(`${g.data.about}\n`);
        return 0;
      }
      // Write mode: set/replace, or clear. The store operation owns store
      // creation (set may bootstrap one, clear never does), the revision
      // bump, and the unset-store-stays-without-the-field rule.
      const w = setAbout(cwd, clear ? { clear: true } : { text });
      if (w) return fail(w.code, w.message);
      return 0;
    }

    case "add": {
      // The id is caller-supplied and first (spec 3.2); the store operation
      // enforces grammar, title, and details in that order, then caps and
      // never-reuse. It prints nothing: the id on stdout is the verb's.
      const w = addGap(cwd, {
        id: targetId,
        text,
        details: opts.detail,
        harness,
        sessionId: session,
        tty: process.stdin.isTTY === true,
        origin,
      });
      if (w) return fail(w.code, w.message);
      stdout(`${targetId}\n`);
      return 0;
    }

    case "close": {
      // The store operation retires the id and records the close (record
      // first, ADV-3); a storeless cwd is an unknown id (exit 5).
      const w = closeGap(cwd, targetId, session);
      if (w) return fail(w.code, w.message);
      return 0;
    }

    case "amend": {
      const w = amendGap(cwd, targetId, text);
      if (w) return fail(w.code, w.message);
      return 0;
    }

    case "detail": {
      const clear = !!opts.clear;
      if (clear && text !== null) return fail(2, "horizon: detail --clear takes no text");
      if (!clear && text === null) {
        // Print mode: the stored details verbatim, or the explicit no-details
        // line — never silence (emptiness is not an error here, but it is
        // stated; the contract pins the wording).
        const g = readGap(cwd, targetId);
        if (!g.ok) return fail(g.code, g.message);
        if (typeof g.data.details === "string") stdout(`${g.data.details}\n`);
        else stdout(`no details for ${targetId}\n`);
        return 0;
      }
      // Write mode: set/rewrite, or clear. Like amend (which appends
      // nothing), detail changes log nothing: they are visible through the
      // revision counter only.
      const w = setDetail(cwd, targetId, clear ? { clear: true } : { text });
      if (w) return fail(w.code, w.message);
      return 0;
    }

    case "log": {
      let limit = 20;
      if (explicit.has("limit")) {
        // Leading zeros and values past Number.MAX_SAFE_INTEGER are usage
        // errors, matching the parser's strictness elsewhere (ADV-10/11).
        if (!/^\d+$/.test(opts.limit) || /^0\d/.test(opts.limit) || !Number.isSafeInteger(Number(opts.limit))) {
          return fail(2, `horizon: --limit must be a non-negative integer without leading zeros, at most ${Number.MAX_SAFE_INTEGER}, got: ${opts.limit}`);
        }
        limit = parseInt(opts.limit, 10);
      }
      const r = resolveStore(cwd);
      if (!r) return 0;
      if (r.open.code !== undefined) return fail(r.open.code, r.open.message);
      const s = readSessions(r.dir);
      if (!s.ok) return fail(s.code, s.message);
      for (const rec of s.records.slice(-limit).reverse()) {
        if (json) {
          stdout(JSON.stringify(rec) + "\n");
        } else {
          const added = Array.isArray(rec.gaps_added) ? rec.gaps_added.length : 0;
          const closed = Array.isArray(rec.gaps_closed) ? rec.gaps_closed.length : 0;
          const summary = rec.summary ?? "(no summary)";
          stdout(`${logTimestamp(rec.ts)}  ${rec.harness}  +${added} -${closed}  ${summary}\n`);
        }
      }
      return 0;
    }

    case "session-end": {
      if (!explicit.has("harness") || !explicit.has("session")) {
        return fail(2, "horizon: session-end requires --harness and --session");
      }
      const summary = explicit.has("summary") ? opts.summary : null;
      // --store is the close hooks' round-trip: the dir horizon-inject --json
      // already resolved, handed back so teardown does not re-discover (the
      // harness process may have chdir'd since the injection). A path that is
      // not an existing directory mirrors the storeless-cwd semantics — a
      // silent no-op, the store-vanished-mid-session case at teardown — while
      // anything that exists is read by the normal paths, so a malformed
      // store still exits 7.
      let storeDir = null;
      if (explicit.has("store")) {
        let st = null;
        try {
          st = statSync(opts.store);
        } catch { /* absent: the storeless twin */ }
        if (!st || !st.isDirectory()) return 0;
        storeDir = resolve(opts.store);
      } else {
        const r = resolveStore(cwd);
        if (!r) return 0;
        if (r.open.code !== undefined) return fail(r.open.code, r.open.message);
        storeDir = r.dir;
      }
      const g = readGapsFile(storeDir);
      if (!g.ok) return fail(g.code, g.message);
      const sid = opts.session;
      const c = readCloses(storeDir, sid);
      if (!c.ok) return fail(c.code, c.message);
      const added = [];
      for (const gap of g.data.gaps) {
        if (gap.provenance && gap.provenance.session_id === sid && !added.includes(gap.id)) added.push(gap.id);
      }
      // Count close records only for gaps that are actually gone (ADV-3):
      // an orphaned record from a crash between append and rename is a no-op,
      // not a phantom close.
      const openIds = new Set(g.data.gaps.map((gap) => gap.id));
      const closedIds = [];
      for (const rec of c.records) {
        if (!openIds.has(rec.gap_id) && !closedIds.includes(rec.gap_id)) closedIds.push(rec.gap_id);
      }
      for (const gapId of closedIds) {
        if (!added.includes(gapId)) added.push(gapId);
      }
      // Record first (ADV-3): append the session record before any other
      // store mutation; a failed append is exit 7 and nothing is written.
      const a = appendLine(storeDir, SESSIONS_FILE, {
        ts: utcNow(),
        harness: opts.harness,
        session_id: sid,
        summary,
        gaps_added: added,
        gaps_closed: closedIds,
      });
      if (a) return fail(a.code, a.message);
      return 0;
    }

    case "init": {
      const r = ensureStoreDir(cwd);
      if (r.code !== undefined) return fail(r.code, r.message);
      if (r.created) stderr(`horizon: created ${r.dir}\n`);
      return 0;
    }

    default:
      return fail(2, `horizon: unknown command: ${command}`);
  }
}
