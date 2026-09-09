import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLOSES_FILE,
  GAPS_FILE,
  HORIZON_DIR,
  MAX_GAPS,
  MAX_TEXT_POINTS,
  SESSIONS_FILE,
  appendLine,
  codePoints,
  ensureStoreDir,
  mintId,
  readCloses,
  readGapsFile,
  readSessions,
  resolveStore,
  usage,
  utcNow,
  writeGapsFile,
} from "./store.ts";

const COMMANDS = ["show", "add", "close", "amend", "log", "session-end", "init"];
const VALUE_FLAGS = new Set(["--cwd", "--harness", "--session", "--origin", "--summary", "--limit"]);
const BOOL_FLAGS = new Set(["--json", "--help", "--version"]);

function flagKey(name) {
  return name.slice(2);
}

function stdout(s) {
  process.stdout.write(s);
}

function stderr(s) {
  process.stderr.write(s);
}

function cliVersion() {
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
    "  add \"<text>\"               append a gap; prints the new id\n" +
    "  close <id>                remove a gap; frees a slot\n" +
    "  amend <id> \"<text>\"         rewrite a gap's text in place\n" +
    "  log [--limit N]           print session records, newest first\n" +
    "  session-end --harness <h> --session <id> [--summary \"<text>\"]\n" +
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

function validateGapText(text) {
  if (text.length === 0) return "horizon: gap text is empty; not saved.";
  if (text.trim().length === 0) return "horizon: gap text is blank; not saved.";
  if (text.includes("\n") || text.includes("\r")) {
    return "horizon: gap text contains a newline; not saved.";
  }
  const n = codePoints(text);
  if (n > MAX_TEXT_POINTS) {
    return `horizon: gap text is ${n} code points; the limit is ${MAX_TEXT_POINTS}. Not saved.`;
  }
  return null;
}

function capMessage(gaps) {
  const lines = gaps.map((g) => `${g.id}  ${g.text}`);
  return `horizon: at capacity: ${gaps.length} gaps already open; close one first.\n${lines.join("\n")}`;
}

// Test-only hook: simulates a concurrent writer committing between our read
// and our compare-and-swap write, so test 21 can exercise the exit-6 path.
function maybeRaceHook(storeDir) {
  if (process.env.HORIZON_CLI_TEST_RACE_HOOK !== "bump") return;
  const cur = readGapsFile(storeDir);
  if (!cur.ok) return;
  const bumped = { ...cur.data, revision: cur.data.revision + 1 };
  writeFileSync(join(storeDir, GAPS_FILE), JSON.stringify(bumped, null, 2) + "\n", "utf8");
}

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
  if (command === undefined) return fail(2, "horizon: no command given");
  if (!COMMANDS.includes(command)) return fail(2, `horizon: unknown command: ${command}`);

  // Per-command parsing: add/amend take their text positionally first so a
  // text starting with dashes is still treated as text.
  let text = null;
  let targetId = null;
  if (command === "add") {
    if (rest.length === 0) return fail(2, "horizon: add requires <text>");
    text = rest[0];
  } else if (command === "close") {
    if (rest.length === 0) return fail(2, "horizon: close requires <id>");
    targetId = rest[0];
  } else if (command === "amend") {
    if (rest.length === 0) return fail(2, "horizon: amend requires <id> <text>");
    if (rest.length === 1) return fail(2, "horizon: amend requires <text>");
    targetId = rest[0];
    text = rest[1];
  }
  const flagTokens =
    command === "add" ? rest.slice(1) : command === "close" ? rest.slice(1) : command === "amend" ? rest.slice(2) : rest;
  const cmdOpts = {};
  const cmdExplicit = new Set();
  const p2 = parseFlags(flagTokens, cmdOpts, cmdExplicit);
  if (p2.error) return fail(2, p2.error);
  if (p2.positionals.length > 0) return fail(2, `horizon: unexpected argument: ${p2.positionals[0]}`);

  const opts = { ...globals, ...cmdOpts };
  const explicit = new Set([...globalExplicit, ...cmdExplicit]);
  json = !!opts.json;

  if (opts.help) {
    stdout(helpText() + "\n");
    return 0;
  }
  if (opts.version) {
    stdout(`horizon ${cliVersion()}\n`);
    return 0;
  }

  const cwd = opts.cwd ?? process.cwd();
  const harness = opts.harness ?? process.env.HORIZON_HARNESS ?? "unknown";
  const session = opts.session ?? "unknown";
  const origin = opts.origin ?? "human";
  if (origin !== "human" && origin !== "agent-proposed") {
    return fail(2, `horizon: --origin must be human or agent-proposed, got: ${origin}`);
  }

  switch (command) {
    case "show": {
      const storeDir = resolveStore(cwd);
      if (!storeDir) {
        if (json) stdout("[]\n");
        return 0;
      }
      const g = readGapsFile(storeDir);
      if (!g.ok) return fail(g.code, g.message);
      if (json) {
        stdout(JSON.stringify(g.data.gaps) + "\n");
      } else if (g.data.gaps.length > 0) {
        stdout(g.data.gaps.map((gap) => `${gap.id}  ${gap.text}`).join("\n") + "\n");
      }
      return 0;
    }

    case "add": {
      const bad = validateGapText(text);
      if (bad) return fail(3, bad);
      let storeDir = resolveStore(cwd);
      let created = null;
      if (!storeDir) {
        const r = ensureStoreDir(cwd);
        storeDir = r.dir;
        if (r.created) created = `horizon: created ${storeDir}`;
      }
      const cur = readGapsFile(storeDir);
      if (!cur.ok) return fail(cur.code, cur.message);
      if (cur.data.gaps.length >= MAX_GAPS) return fail(4, capMessage(cur.data.gaps));
      maybeRaceHook(storeDir);
      let id = mintId();
      const taken = new Set(cur.data.gaps.map((g) => g.id));
      while (taken.has(id)) id = mintId();
      const gap = {
        id,
        text,
        added_at: utcNow(),
        provenance: {
          harness,
          session_id: session,
          tty: process.stdin.isTTY === true,
          origin,
        },
      };
      const next = { version: 1, revision: cur.data.revision + 1, gaps: [...cur.data.gaps, gap] };
      const w = writeGapsFile(storeDir, cur.data.revision, next);
      if (w) return fail(w.code, w.message);
      if (created) stderr(`${created}\n`);
      stdout(`${id}\n`);
      return 0;
    }

    case "close": {
      const storeDir = resolveStore(cwd);
      if (!storeDir) return fail(5, `horizon: unknown gap id: ${targetId}`);
      const cur = readGapsFile(storeDir);
      if (!cur.ok) return fail(cur.code, cur.message);
      const gap = cur.data.gaps.find((g) => g.id === targetId);
      if (!gap) return fail(5, `horizon: unknown gap id: ${targetId}`);
      maybeRaceHook(storeDir);
      const next = {
        version: 1,
        revision: cur.data.revision + 1,
        gaps: cur.data.gaps.filter((g) => g.id !== targetId),
      };
      const w = writeGapsFile(storeDir, cur.data.revision, next);
      if (w) return fail(w.code, w.message);
      appendLine(storeDir, CLOSES_FILE, {
        ts: utcNow(),
        session_id: session,
        gap_id: targetId,
        added_session_id:
          gap.provenance && typeof gap.provenance.session_id === "string" ? gap.provenance.session_id : "unknown",
      });
      return 0;
    }

    case "amend": {
      const storeDir = resolveStore(cwd);
      if (!storeDir) return fail(5, `horizon: unknown gap id: ${targetId}`);
      const cur = readGapsFile(storeDir);
      if (!cur.ok) return fail(cur.code, cur.message);
      const idx = cur.data.gaps.findIndex((g) => g.id === targetId);
      if (idx === -1) return fail(5, `horizon: unknown gap id: ${targetId}`);
      const bad = validateGapText(text);
      if (bad) return fail(3, bad);
      maybeRaceHook(storeDir);
      const gaps = cur.data.gaps.map((g) => (g.id === targetId ? { ...g, text } : g));
      const w = writeGapsFile(storeDir, cur.data.revision, { version: 1, revision: cur.data.revision + 1, gaps });
      if (w) return fail(w.code, w.message);
      return 0;
    }

    case "log": {
      let limit = 20;
      if (explicit.has("limit")) {
        if (!/^\d+$/.test(opts.limit)) return fail(2, `horizon: --limit must be a non-negative integer, got: ${opts.limit}`);
        limit = parseInt(opts.limit, 10);
      }
      const storeDir = resolveStore(cwd);
      if (!storeDir) return 0;
      const recs = readSessions(storeDir).reverse().slice(0, limit);
      for (const r of recs) {
        if (json) {
          stdout(JSON.stringify(r) + "\n");
        } else {
          const added = Array.isArray(r.gaps_added) ? r.gaps_added.length : 0;
          const closed = Array.isArray(r.gaps_closed) ? r.gaps_closed.length : 0;
          const summary = r.summary ?? "(no summary)";
          stdout(`${logTimestamp(r.ts)}  ${r.harness}  +${added} -${closed}  ${summary}\n`);
        }
      }
      return 0;
    }

    case "session-end": {
      if (!explicit.has("harness") || !explicit.has("session")) {
        return fail(2, "horizon: session-end requires --harness and --session");
      }
      const summary = explicit.has("summary") ? opts.summary : null;
      const storeDir = resolveStore(cwd);
      if (!storeDir) return 0;
      const g = readGapsFile(storeDir);
      if (!g.ok) return fail(g.code, g.message);
      const sid = opts.session;
      const closes = readCloses(storeDir, sid);
      const added = [];
      for (const gap of g.data.gaps) {
        if (gap.provenance && gap.provenance.session_id === sid && !added.includes(gap.id)) added.push(gap.id);
      }
      for (const c of closes) {
        if (c.added_session_id === sid && !added.includes(c.gap_id)) added.push(c.gap_id);
      }
      appendLine(storeDir, SESSIONS_FILE, {
        ts: utcNow(),
        harness: opts.harness,
        session_id: sid,
        summary,
        gaps_added: added,
        gaps_closed: closes.map((c) => c.gap_id),
      });
      return 0;
    }

    case "init": {
      const r = ensureStoreDir(cwd);
      if (r.created) stderr(`horizon: created ${r.dir}\n`);
      return 0;
    }

    default:
      return fail(2, `horizon: unknown command: ${command}`);
  }
}
