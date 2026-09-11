// horizon-inject's composer (D6): pure composition. Runs the `show` logic
// against the resolved store, then prints exactly one locked section-10
// variant by state: the horizon block when gaps exist; with no gaps, the
// warm nudge when an about line is set, the bootstrap nudge when neither
// is. No store writes, no new commands.
//
// bin/horizon-inject.js is a shim to this module's main() — the way
// bin/horizon.js wraps src/cli.ts — so the selection state machine, the
// usage text, and the flag loop are importable and unit-testable directly,
// not reachable only through the bin's subprocess.
//
// Flags mirror the CLI's global options so harness glue can forward them
// (--cwd, --harness, --session, --origin); only --cwd changes behaviour.
// --json is the total answer for a cwd: {"text": <string>, "store":
// <string|null>} — the composed text plus the store directory resolution
// already paid for, null when no store was found (the silence and
// storeless-nudge cases). Plain stdout stays text-only: empty output means
// silent, the contract the non-json callers rely on. Unknown flags are a
// usage error (exit 2).
import { homedir } from "node:os";
import { cliVersion } from "./cli.ts";
import { readGapsFile, resolveStore, suppressBootstrap } from "./store.ts";
import { BOOTSTRAP_NUDGE_TEXT, NUDGE_TEXT, aboutPrefix, gapLine, horizonBlock } from "./texts.ts";

// The flags horizon-inject accepts: the CLI's global options (--help and
// --version answer here too). --harness, --session, and --origin are
// accepted and ignored — harness glue forwards them; only --cwd changes
// behaviour.
const VALUE_FLAGS = new Set(["--cwd", "--harness", "--session", "--origin"]);
const BOOL_FLAGS = new Set(["--json", "--help", "--version"]);

// The bin's own thin flag loop. It mirrors the CLI parser's --flag=value
// handling (takeFlag in src/cli.ts) so --cwd=<path> means the same thing on
// both bins — the CLI always accepted the = form while the bin answered
// "unknown option" (exit 2), a divergence nothing pinned. It does not reuse
// that parser itself: there are no positionals here (any bare token is an
// unknown option), --help/--version answer mid-loop, and the messages carry
// the bin's own name.
function parseArgs(argv) {
  const opts = {};
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    if (t === "--") break; // rest ignored: no positional contract
    let name = t;
    let value = null;
    let hasEq = false;
    const eq = t.indexOf("=");
    if (eq !== -1) {
      name = t.slice(0, eq);
      value = t.slice(eq + 1);
      hasEq = true;
    }
    if (!VALUE_FLAGS.has(name) && !BOOL_FLAGS.has(name)) {
      process.stderr.write(`horizon-inject: unknown option: ${t}\n`);
      return { error: 2 };
    }
    if (name === "--help") return { help: true };
    if (name === "--version") return { version: true };
    if (BOOL_FLAGS.has(name)) {
      if (hasEq) {
        process.stderr.write(`horizon-inject: ${name} takes no value\n`);
        return { error: 2 };
      }
      opts[name.slice(2)] = true;
      i += 1;
      continue;
    }
    if (!hasEq) {
      if (i + 1 >= argv.length) {
        process.stderr.write(`horizon-inject: ${name} requires a value\n`);
        return { error: 2 };
      }
      value = argv[i + 1];
      i += 2;
    } else {
      i += 1;
    }
    opts[name.slice(2)] = value;
  }
  return { opts };
}

function helpText() {
  return (
    "usage: horizon-inject [--cwd <path>] [--json] [--harness <name>] [--session <id>] [--origin <human|agent-proposed>]\n" +
    "\n" +
    "Prints the about line (when set) and a blank line, then the section-10 horizon\n" +
    "block when the store has open gaps; with no gaps, the warm nudge when an about\n" +
    "line is set, the bootstrap nudge when neither is.\n" +
    "--json prints one JSON line instead: {\"text\": <string>, \"store\": <string|null>}\n" +
    "— the composed text plus the resolved store directory (null when no store was\n" +
    "found). Plain stdout stays text-only; empty output means silent.\n" +
    "Read-only: never writes the store. The composition twin of `horizon show` (spec D6).\n"
  );
}

// The section-10 variant selection, pure: exactly one variant per store
// state (spec 10) — gaps → the block; about but no gaps → the warm nudge;
// neither → the bootstrap nudge, silenced to empty when the storeless cwd
// IS the home directory ($HOME is not a project). The gap lines render
// through gapLine and enter the block via horizonBlock — the function
// replacement, so $-patterns in user-authored gap text ($&, $`, $', $$, $1
// — DEF-1) reach the block verbatim. aboutPrefix is empty with no about
// line, so the block and the warm nudge compose with their prefix and the
// bootstrap case carries none (spec 10.4).
export function compose({ gaps, about, silence }) {
  let core;
  if (gaps.length > 0) {
    core = horizonBlock(gaps.map(gapLine).join("\n") + "\n");
  } else if (typeof about === "string") {
    core = NUDGE_TEXT;
  } else if (silence) {
    core = "";
  } else {
    core = BOOTSTRAP_NUDGE_TEXT;
  }
  return aboutPrefix(about) + core;
}

// The total answer for one cwd: the composed text plus the store directory
// the resolution already paid for (null when no store was found — the
// silence and storeless-nudge cases). Read-only (D6): resolve+read, never
// write — the tmp sweep and store materialization stay CLI-only side
// effects. `home` is injectable so tests can fake $HOME and never touch
// the real one. Errors come back as { error: { code, message } } and stay
// unwrapped: stderr keeps the store's message and stdout stays empty even
// under --json.
export function resolveInjection(dir, { home }) {
  const found = resolveStore(dir, { readonly: true });
  const store = found ? found.dir : null;
  if (found && found.open.code !== undefined) return { error: found.open };
  let gaps = [];
  let about;
  if (found) {
    const g = readGapsFile(found.dir);
    if (!g.ok) return { error: { code: g.code, message: g.message } };
    gaps = g.data.gaps;
    about = g.data.about;
  }
  // A storeless $HOME is not a project: emit nothing (exit 0, empty stdout —
  // the adapters treat empty stdout as a silent no-op).
  const silence = suppressBootstrap({ cwd: dir, storeFound: !!found, home });
  return { text: compose({ gaps, about, silence }), store };
}

// The bin entry, mirroring src/cli.ts's main: writes stdout and stderr
// itself and returns the exit code for the shim to exit with.
export async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    return parsed.error;
  }
  if (parsed.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`horizon-inject ${cliVersion()}\n`);
    return 0;
  }

  const cwd = parsed.opts?.cwd;
  const json = !!parsed.opts?.json;
  let answer;
  try {
    answer = resolveInjection(cwd ?? process.cwd(), { home: homedir() });
  } catch {
    process.stderr.write("horizon-inject: store read failed\n");
    return 7;
  }
  if (answer.error) {
    process.stderr.write(`${answer.error.message}\n`);
    return answer.error.code;
  }
  if (json) {
    process.stdout.write(JSON.stringify({ text: answer.text, store: answer.store }) + "\n");
  } else {
    process.stdout.write(answer.text);
  }
  return 0;
}
