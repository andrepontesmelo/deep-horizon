// horizon doctor + horizon install (tickets 09 / 10): the machine-wiring
// pair. doctor is the read-only diagnostic — per harness, one PASS/FAIL line
// per check with the fix hint, exit 0 all-pass else 1; it never writes.
// install is its write twin: zcode's GLOBAL config via parse → merge →
// validate → backup → atomic write, hermes's plugin files plus a tolerant,
// surgical config.yaml append — idempotent (re-running changes nothing when
// already wired, and no backup is taken when nothing will be written), and
// refusing loudly (exit 2, named reason, fix-it-by-hand hint) whenever a
// config's shape is unrecognized. Never a blind write: research/01 §5 found
// that an unparseable config fails WHOLE (`config.file.invalid`), so the one
// unrecoverable move is writing over a document we could not read.
//
// Global scope only, by design: project hooks are trust-gated with
// stale-prone grants and double-fire once trusted when both scopes declare
// the same hook (research/01 §5), so exactly one surface per machine — this
// one.
//
// Test seams: HORIZON_ZCODE_CONFIG and HORIZON_HERMES_HOME relocate the two
// surfaces. They exist for the suite (fixture dirs, never the real home —
// the real machine is wired at release time by hand); no production
// semantics hang on them and the docs never mention them.

import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The exact commands install writes — the README's documented block
// verbatim, including the shell quotes around the `$(npm root -g)`
// expansion (ZCode runs `command` hooks through a shell; the quotes keep a
// spaced npm prefix one word).
const SESSION_START_CMD = "\"$(npm root -g)/deep-horizon/adapters/zcode/session-start\"";
const PRE_EXECUTE_CMD = "\"$(npm root -g)/deep-horizon/adapters/zcode/pre-execute\"";
// The matcher spellings: `startup|resume` is the supported spelling for
// "every fresh app-instance opening" (research/01 §3 — resume is the only
// other source this runtime fires), and the PreToolUse matcher is pinned to
// the tools whose arguments carry absolute targets.
const SESSION_START_MATCHER = "startup|resume";
const PRE_EXECUTE_MATCHER = "Bash|Read|Edit|Write|NotebookEdit";

// The desired entries, written fresh on every install: inner `enabled: true`
// is load-bearing (ZCode disables config-file hooks by default) and the
// PreToolUse timeout stays modest — hooks run inline before the tool call.
function desiredSessionStartEntry() {
  return { matcher: SESSION_START_MATCHER, hooks: [{ type: "command", command: SESSION_START_CMD, enabled: true }] };
}

function desiredPreToolUseEntry() {
  return { matcher: PRE_EXECUTE_MATCHER, hooks: [{ type: "command", command: PRE_EXECUTE_CMD, enabled: true, timeout: 10 }] };
}

function zcodeConfigPath() {
  return process.env.HORIZON_ZCODE_CONFIG || join(homedir(), ".zcode", "cli", "config.json");
}

function hermesHome() {
  return process.env.HORIZON_HERMES_HOME || join(homedir(), ".hermes");
}

function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Structural JSON equality, key order irrelevant: a foreign config that
// spells the same wiring with different key order must count as already
// wired, or install would not be idempotent.
function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && jsonEqual(a[k], b[k]));
}

// install's own --harness collection: repeatable and comma-separated (the
// upgrade path is `horizon install --harness zcode --harness hermes`). The
// shared parser is last-wins for every other flag and caller, so install
// scans the raw argv itself with the same token rules — the = form counts,
// "--" ends flags.
export function collectHarnessValues(argv) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--") break;
    if (t === "--harness") {
      if (i + 1 < argv.length) values.push(argv[(i += 1)]);
    } else if (t.startsWith("--harness=")) {
      values.push(t.slice("--harness=".length));
    }
  }
  return values.flatMap((v) => v.split(",")).map((s) => s.trim()).filter((s) => s.length > 0);
}

// --- doctor ---

// A bin resolves on PATH: some PATH directory holds a file of that name (the
// .cmd/.exe companions too on Windows, where npm's shims carry extensions).
// isFile is deliberately lax about the executable bit — npm's POSIX shims
// and .cmd launchers both pass, and doctor reports wiring, not permissions.
// Note the honest limit: this is THE CURRENT PATH; a harness whose gateway
// runs with a different PATH can still be wired here and fail there.
function onPath(bin) {
  const dirs = (process.env.PATH || "").split(delimiter).filter((d) => d.length > 0);
  const names = process.platform === "win32" ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
  for (const dir of dirs) {
    for (const name of names) {
      try {
        if (statSync(join(dir, name)).isFile()) return true;
      } catch { /* not here */ }
    }
  }
  return false;
}

// The command strings one matcher-entry declares (tolerant: a malformed
// entry contributes nothing and never throws — doctor reads configs it does
// not own).
function entryCommands(entry) {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) return [];
  return entry.hooks.filter((h) => isRecord(h) && typeof h.command === "string").map((h) => h.command);
}

// True when an entry's matcher accepts every SessionStart source zcode
// fires: "startup" and "startup|resume" are both correct spellings
// (research/01 §3 — the "|" tokens are startup and resume, nothing else).
function matcherAcceptable(matcher) {
  if (typeof matcher !== "string") return false;
  const tokens = matcher.split("|");
  return tokens.includes("startup") && tokens.every((t) => t === "startup" || t === "resume");
}

// The hooks.events object of a parsed config, or null when the walk finds
// nothing shaped like one (an absent or malformed config is FAIL lines
// below, never a crash).
function eventsOf(config) {
  if (!isRecord(config) || !isRecord(config.hooks) || !isRecord(config.hooks.events)) return null;
  return config.hooks.events;
}

function eventWires(config, event, bin, checkMatcher) {
  const events = eventsOf(config);
  if (!events || !Array.isArray(events[event])) return false;
  return events[event].some(
    (entry) =>
      (!checkMatcher || matcherAcceptable(isRecord(entry) ? entry.matcher : undefined)) &&
      entryCommands(entry).some((c) => c.includes("deep-horizon") && c.includes(bin)),
  );
}

const INSTALL_ZCODE = "run: horizon install --harness zcode";
const INSTALL_HERMES = "run: horizon install --harness hermes";

function zcodeChecks() {
  const cfgPath = zcodeConfigPath();
  const checks = [
    {
      label: "horizon-inject resolves on PATH",
      pass: onPath("horizon-inject"),
      hint: "install the CLI first: npm i -g deep-horizon (hooks fail open without the bin)",
    },
  ];
  // Read the config once; the wiring checks below read the parsed document
  // or, when it never parsed, print their FAIL lines anyway — absent config
  // is a FAIL line, not a crash.
  let config = null;
  let raw = null;
  let readReason = null;
  try {
    raw = readFileSync(cfgPath, "utf8");
  } catch (err) {
    readReason = err && err.code === "ENOENT" ? "missing" : `cannot read: ${err.message}`;
  }
  let parseReason = null;
  if (raw !== null) {
    try {
      config = JSON.parse(raw);
    } catch (err) {
      parseReason = `invalid JSON: ${err.message}`;
    }
  }
  checks.push({
    label: `${cfgPath} exists and parses as JSON`,
    pass: raw !== null && parseReason === null,
    detail: raw === null ? readReason : parseReason,
    hint:
      raw === null
        ? `${INSTALL_ZCODE} (it starts from an empty config)`
        : "fix the config by hand — zcode rejects the whole file when it does not parse",
  });
  checks.push({
    label: "SessionStart wired to session-start (matcher startup or startup|resume)",
    pass: config !== null && eventWires(config, "SessionStart", "session-start", true),
    hint: INSTALL_ZCODE,
  });
  checks.push({
    // The F3 detector: pre-execute shipped but PreToolUse unwired is exactly
    // the "installed but not wired" state that killed the param trigger.
    label: "PreToolUse wired to pre-execute (the param trigger)",
    pass: config !== null && eventWires(config, "PreToolUse", "pre-execute", false),
    hint: INSTALL_ZCODE,
  });
  return checks;
}

function hermesChecks() {
  const home = hermesHome();
  const pluginDir = join(home, "plugins", "deep-horizon");
  const yamlPath = join(home, "config.yaml");
  const checks = [
    {
      label: `plugin files present at ${pluginDir} (deep_horizon.py)`,
      pass: existsSync(join(pluginDir, "deep_horizon.py")),
      hint: INSTALL_HERMES,
    },
  ];
  let parsed = { ok: true, plugins: [] };
  let detail;
  try {
    const text = readFileSync(yamlPath, "utf8");
    parsed = pluginsEnabled(text);
    if (!parsed.ok) detail = parsed.reason;
  } catch (err) {
    detail = err && err.code === "ENOENT" ? "missing" : `cannot read: ${err.message}`;
  }
  checks.push({
    label: `${yamlPath} lists deep-horizon in plugins.enabled`,
    pass: parsed.ok && parsed.plugins.includes("deep-horizon"),
    detail,
    hint: parsed.ok ? INSTALL_HERMES : "fix the yaml by hand — horizon install refuses to write over a shape it cannot read",
  });
  checks.push({
    label: "horizon and horizon-inject resolve on PATH",
    pass: onPath("horizon") && onPath("horizon-inject"),
    detail: [onPath("horizon") ? null : "horizon", onPath("horizon-inject") ? null : "horizon-inject"].filter(Boolean).join(", ") || undefined,
    hint: "install the CLI: npm i -g deep-horizon (the gateway spawns the same bins)",
  });
  return checks;
}

// One PASS/FAIL line per check, the fix hint riding the FAIL — the whole
// report. stdout carries it (the exit code carries the verdict), so a test
// greps one stream.
export function runDoctor({ only, sink }) {
  let allPass = true;
  for (const harness of only ? [only] : ["zcode", "hermes"]) {
    for (const c of harness === "zcode" ? zcodeChecks() : hermesChecks()) {
      if (c.pass) {
        sink.stdout(`${harness}: PASS ${c.label}\n`);
      } else {
        allPass = false;
        sink.stdout(`${harness}: FAIL ${c.label}${c.detail ? ` (${c.detail})` : ""} — ${c.hint}\n`);
      }
    }
  }
  return allPass ? 0 : 1;
}

// --- the tolerant config.yaml reader / surgeon ---
//
// hermes's config.yaml is a human config, not a schema'd document: doctor
// must read it without crashing on shapes it never predicted, and install
// must edit the one list it owns without disturbing anything else. A
// deliberately bounded line scan, NOT a YAML implementation — its whole
// tolerance contract:
//   - finds the top-level `plugins:` block mapping;
//   - within its DIRECT children, the `enabled:` key (nested mappings —
//     entries:, per-provider tweaks — are invisible to this scan);
//   - reads the list in either spelling: flow `enabled: [a, b]` or block
//     `enabled:` followed by `- item` lines;
//   - anything it cannot confidently read (no plugins block → empty list;
//     no enabled key → empty; a `plugins:` value that is not a block
//     mapping; an enabled value that is not a list) is REPORTED, never
//     guessed at — the reader returns { ok: false, reason } and the callers
//     turn that into a FAIL line (doctor) or a refusal (install).

function leadingSpaces(line) {
  const m = line.match(/^ */);
  return m ? m[0].length : 0;
}

function unquote(s) {
  return s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) ? s.slice(1, -1) : s;
}

// The indent of the first content line after `from` (comments and blanks
// skipped), or null when the block has no children.
function childIndentOf(lines, from, minIndent) {
  for (let i = from; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const ind = leadingSpaces(lines[i]);
    return ind > minIndent ? ind : null;
  }
  return null;
}

// The `enabled` child of the plugins block whose `plugins:` line is at
// `at`: { index, indent, value } or null.
function findEnabledChild(lines, at) {
  const pluginsIndent = leadingSpaces(lines[at]);
  const childIndent = childIndentOf(lines, at + 1, pluginsIndent);
  if (childIndent === null) return null;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const ind = leadingSpaces(line);
    if (ind <= pluginsIndent) break; // the next top-level key: block ended
    if (ind !== childIndent) continue; // nested content: not a direct child
    const m = trimmed.match(/^enabled\s*:\s*(.*)$/);
    if (m) return { index: i, indent: childIndent, value: m[1] };
  }
  return null;
}

function pluginsBlockAt(lines) {
  const at = lines.findIndex((l) => /^plugins\s*:\s*$/.test(l));
  if (at !== -1) return at;
  return lines.some((l) => /^plugins\s*:\s*\S/.test(l)) ? -2 : -1;
}

function readFlowList(value) {
  const flow = value.match(/^\[(.*)\]$/);
  if (!flow) return null;
  return flow[1].split(",").map((s) => unquote(s.trim())).filter((s) => s.length > 0);
}

function pluginsEnabled(text) {
  const lines = text.split("\n");
  const at = pluginsBlockAt(lines);
  if (at === -2) return { ok: false, reason: "plugins: is not a block mapping" };
  if (at === -1) return { ok: true, plugins: [] };
  const child = findEnabledChild(lines, at);
  if (!child) return { ok: true, plugins: [] };
  const value = child.value.replace(/\s*#.*$/, "").trim();
  if (value === "") {
    // Block list: the `- item` lines under the key, until a line at the
    // key's indent or shallower (the next sibling key) ends the list.
    const items = [];
    for (let j = child.index + 1; j < lines.length; j += 1) {
      const l2 = lines[j];
      const trimmed = l2.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      if (leadingSpaces(l2) <= child.indent) break;
      const item = trimmed.match(/^-\s*(.*?)\s*(#.*)?$/);
      if (!item) break;
      items.push(unquote(item[1]));
    }
    return { ok: true, plugins: items };
  }
  const list = readFlowList(value);
  return list ? { ok: true, plugins: list } : { ok: false, reason: `plugins.enabled: ${value} is not a plugin list` };
}

// The surgical append: add `name` to plugins.enabled without touching any
// other byte, the new name LAST in the list it joins (ticket 10: append +
// backup; never reorders). { ok, text } on success, { ok: false, reason }
// for shapes it cannot edit safely.
function appendEnabled(text, name) {
  const lines = text.split("\n");
  const at = pluginsBlockAt(lines);
  if (at === -2) return { ok: false, reason: "plugins: is not a block mapping" };
  if (at === -1) {
    // No plugins block: append one — the minimal edit that names the
    // plugin, never a rewrite of whatever else the file holds. The file's
    // own trailing newline (the empty last split element) becomes the
    // block's; a file that lacked one gains it.
    const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
    const body = trailingNewline ? lines.slice(0, -1) : lines;
    return { ok: true, text: [...body, "plugins:", "  enabled:", `    - ${name}`, ""].join("\n") };
  }
  const child = findEnabledChild(lines, at);
  if (!child) {
    // plugins: exists without enabled: — insert the key as its first child,
    // at the block's own child indent (2 when the block is empty).
    const indent = childIndentOf(lines, at + 1, leadingSpaces(lines[at])) ?? 2;
    return {
      ok: true,
      text: [...lines.slice(0, at + 1), `${" ".repeat(indent)}enabled:`, `${" ".repeat(indent + 2)}- ${name}`, ...lines.slice(at + 1)].join("\n"),
    };
  }
  const value = child.value.replace(/\s*#.*$/, "").trim();
  if (value === "") {
    // Block list: insert after the last existing item (or right under the
    // key when the list is empty), at the items' indent.
    let lastDash = -1;
    let dashIndent = child.indent + 2;
    for (let j = child.index + 1; j < lines.length; j += 1) {
      const l2 = lines[j];
      if (l2.trim().length === 0) continue;
      const ind = leadingSpaces(l2);
      if (ind <= child.indent) break;
      if (!/^- /.test(l2.trim())) break;
      lastDash = j;
      dashIndent = ind;
    }
    const next = [...lines];
    next.splice(lastDash === -1 ? child.index + 1 : lastDash + 1, 0, `${" ".repeat(dashIndent)}- ${name}`);
    return { ok: true, text: next.join("\n") };
  }
  const list = readFlowList(value);
  if (!list) return { ok: false, reason: `plugins.enabled: ${value} is not a plugin list` };
  // Flow list: extend the brackets in place, trailing comment preserved.
  const m = lines[child.index].match(/^(.*?enabled\s*:\s*\[)([^\]]*)(\].*)$/);
  const inner = m[2].trim();
  const sep = inner.length > 0 ? ", " : "";
  const next = [...lines];
  next[child.index] = `${m[1]}${inner}${sep}${name}${m[3]}`;
  return { ok: true, text: next.join("\n") };
}

// --- install ---

// Local time, human-read: a backup name is forensics on THIS machine, not a
// parsed field (Andre's config.json.bak-pre-horizon-YYYYMMDD convention).
function backupStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function refuse(sink, reason) {
  sink.stderr(`horizon: install refused — ${reason}\n`);
  return 2;
}

// The store's atomic-write discipline (temp in the same directory, fsync,
// rename over the live file) without the rename-retry ladder: an install is
// a human-rare command, not a per-add hot path. Returns null on success or
// a refusal reason naming the file.
let wiringTmpSeq = 0;

function writeTextAtomic(path, text) {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.tmp.${process.pid}.${(wiringTmpSeq += 1)}`);
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch { /* never created */ }
    return `${path}: cannot write: ${err.message}`;
  }
  return null;
}

// JSON round trip BEFORE the rename (ticket 10's validate step): what lands
// must parse back to exactly the merged document, because zcode rejects an
// invalid config whole.
function writeJsonAtomic(path, doc) {
  let text;
  try {
    text = JSON.stringify(doc, null, 2) + "\n";
    if (!jsonEqual(JSON.parse(text), doc)) {
      return "internal: the merged config failed its JSON round trip; nothing was written";
    }
  } catch (err) {
    return `internal: the merged config failed its JSON round trip: ${err.message}; nothing was written`;
  }
  return writeTextAtomic(path, text);
}

// Replace any existing deep-horizon entry in one event array while keeping
// every foreign entry — matched by a hook command containing "deep-horizon"
// (ticket 10). The desired entry goes last; the merge IS the migration, so
// a stale matcher or command from an older install is simply displaced, and
// Stop (and every other event) is never touched.
function mergeEvent(next, event, bin, desired, actions) {
  const existing = next.hooks.events[event] ?? [];
  const foreign = existing.filter((entry) => !entryCommands(entry).some((c) => c.includes("deep-horizon")));
  const merged = [...foreign, desired];
  if (jsonEqual(merged, existing)) return;
  next.hooks.events[event] = merged;
  const replaced = existing.length !== foreign.length;
  actions.push(`wired ${event} (matcher "${desired.matcher}" → ${bin})${replaced ? ", replacing the previous deep-horizon entry" : ""}`);
}

function installZcode(sink) {
  const path = zcodeConfigPath();
  let raw = null;
  let config = {};
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      return refuse(sink, `${path}: cannot read: ${err.message} — fix it by hand; horizon install never writes blind`);
    }
  }
  if (raw !== null) {
    try {
      config = JSON.parse(raw);
    } catch (err) {
      return refuse(sink, `${path}: invalid JSON: ${err.message} — fix the config by hand (a config.json.bak-* copy may hold the last good version); horizon install never writes over a config it cannot parse`);
    }
    if (!isRecord(config)) {
      return refuse(sink, `${path}: the config is not a JSON object — fix it by hand`);
    }
  }
  // Shape gates before any merge: an unrecognized hooks shape is a LOUD
  // refusal, never a guess (research/01: a malformed hooks block risks the
  // whole config being rejected by zcode).
  if (config.hooks !== undefined && !isRecord(config.hooks)) {
    return refuse(sink, `${path}: hooks is not an object — unrecognized shape; fix the config by hand`);
  }
  if (isRecord(config.hooks) && config.hooks.events !== undefined && !isRecord(config.hooks.events)) {
    return refuse(sink, `${path}: hooks.events is not an object — unrecognized shape; fix the config by hand`);
  }
  const events = isRecord(config.hooks) ? config.hooks.events : undefined;
  for (const event of ["SessionStart", "PreToolUse"]) {
    if (isRecord(events) && events[event] !== undefined && !Array.isArray(events[event])) {
      return refuse(sink, `${path}: hooks.events.${event} is not an array — unrecognized shape; fix the config by hand`);
    }
  }
  // Merge on a clone: every foreign key — model, MCP servers, hooks
  // timeoutMs, Stop hooks — survives byte-for-value.
  const next = structuredClone(config);
  if (!isRecord(next.hooks)) next.hooks = {};
  if (!isRecord(next.hooks.events)) next.hooks.events = {};
  const actions = [];
  if (next.hooks.enabled === undefined) {
    next.hooks.enabled = true;
    actions.push("set hooks.enabled = true (was absent)");
  }
  mergeEvent(next, "SessionStart", "session-start", desiredSessionStartEntry(), actions);
  mergeEvent(next, "PreToolUse", "pre-execute", desiredPreToolUseEntry(), actions);
  if (actions.length === 0) {
    sink.stdout("zcode: already wired; nothing to change\n");
    return 0;
  }
  // An explicit false is a deliberate disable: the wiring is written, the
  // user's switch is left alone, and the report says so.
  if (next.hooks.enabled === false) {
    sink.stdout("zcode: note — hooks.enabled is false; wiring written, hooks stay disabled until you enable them\n");
  }
  // Backup first, only when a change will be written, and never for a
  // config that does not exist yet (nothing to back up).
  if (raw !== null) {
    const bak = `${path}.bak-pre-horizon-${backupStamp()}`;
    try {
      copyFileSync(path, bak);
    } catch (err) {
      return refuse(sink, `${path}: cannot back up (${err.message}); nothing was written`);
    }
    sink.stdout(`zcode: backed up ${path} → ${bak}\n`);
  }
  for (const a of actions) sink.stdout(`zcode: ${a}\n`);
  const err = writeJsonAtomic(path, next);
  if (err) return refuse(sink, err);
  sink.stdout(`zcode: wrote ${path}\n`);
  return 0;
}

// The shipped plugin files: beside dist/ in the installed package, beside
// src/ in a checkout — one level up from this module either way. Only the
// three plugin files are copied, never __pycache__ (gitignored dev residue
// — a checkout may carry it; the whitelist never copies it) and never the
// directory wholesale.
const HERMES_PLUGIN_FILES = ["deep_horizon.py", "__init__.py", "plugin.yaml"];

function hermesAdapterDir() {
  return fileURLToPath(new URL("../adapters/hermes/", import.meta.url));
}

function sameBytes(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false; // either side absent or unreadable: copy (the safe direction)
  }
}

function installHermes(sink) {
  const home = hermesHome();
  const pluginDir = join(home, "plugins", "deep-horizon");
  // Copy the plugin files (idempotent: byte-identical files are skipped).
  const actions = [];
  let copied = 0;
  try {
    for (const name of HERMES_PLUGIN_FILES) {
      const dst = join(pluginDir, name);
      if (sameBytes(join(hermesAdapterDir(), name), dst)) continue;
      mkdirSync(pluginDir, { recursive: true });
      copyFileSync(join(hermesAdapterDir(), name), dst);
      copied += 1;
      actions.push(`copied ${name} → ${pluginDir}`);
    }
  } catch (err) {
    return refuse(sink, `copying the plugin failed: ${err.message}`);
  }
  // Stale bytecode dies with the replaced files (scripts/sync-hermes-adapter.sh's
  // rm, inlined — Python would otherwise keep importing the old module from
  // __pycache__ across an upgrade).
  if (copied > 0) {
    const pyc = join(pluginDir, "__pycache__");
    try {
      if (existsSync(pyc)) {
        rmSync(pyc, { recursive: true, force: true });
        actions.push("removed stale __pycache__");
      }
    } catch { /* best effort, like the copy's other side effects */ }
  }
  for (const a of actions) sink.stdout(`hermes: ${a}\n`);
  // config.yaml: create it, or append deep-horizon to the enabled list with
  // a timestamped backup — same loud-refusal discipline as the JSON side.
  const yamlPath = join(home, "config.yaml");
  let text = null;
  try {
    text = readFileSync(yamlPath, "utf8");
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      return refuse(sink, `${yamlPath}: cannot read: ${err.message} — fix it by hand; horizon install never writes blind`);
    }
  }
  if (text === null) {
    const err = writeTextAtomic(yamlPath, "plugins:\n  enabled:\n    - deep-horizon\n");
    if (err) return refuse(sink, err);
    sink.stdout(`hermes: created ${yamlPath} with deep-horizon enabled\n`);
    return 0;
  }
  const parsed = pluginsEnabled(text);
  if (!parsed.ok) {
    return refuse(sink, `${yamlPath}: ${parsed.reason} — fix it by hand; horizon install never writes blind`);
  }
  if (parsed.plugins.includes("deep-horizon")) {
    if (actions.length === 0) sink.stdout("hermes: already installed; nothing to change\n");
    return 0;
  }
  const appended = appendEnabled(text, "deep-horizon");
  if (!appended.ok) {
    return refuse(sink, `${yamlPath}: ${appended.reason} — fix it by hand`);
  }
  const bak = `${yamlPath}.bak-pre-horizon-${backupStamp()}`;
  try {
    copyFileSync(yamlPath, bak);
  } catch (err) {
    return refuse(sink, `${yamlPath}: cannot back up (${err.message}); nothing was written`);
  }
  sink.stdout(`hermes: backed up ${yamlPath} → ${bak}\n`);
  sink.stdout("hermes: added deep-horizon to plugins.enabled\n");
  const err = writeTextAtomic(yamlPath, appended.text);
  if (err) return refuse(sink, err);
  sink.stdout(`hermes: wrote ${yamlPath}\n`);
  return 0;
}

// Run the requested harnesses in order; a refusal on one does not block the
// other (each surface is independent), and any refusal fails the command.
export function runInstall(harnesses, sink) {
  let code = 0;
  for (const h of harnesses) {
    const r = h === "zcode" ? installZcode(sink) : installHermes(sink);
    if (r !== 0) code = r;
  }
  return code;
}
