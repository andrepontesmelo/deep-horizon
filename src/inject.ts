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
// (--cwd, --harness, --session, --origin). --cwd changes the store
// resolution; since 0.4.0 (spec 10.5) --session and --harness compose the
// provenance footer — no --session, no footer; --origin stays
// accepted-and-ignored. --json is the total answer for a cwd:
// {"text": <string>, "store": <string|null>} — the composed text plus the
// store directory resolution already paid for, null when no store was found
// (the silence and storeless-nudge cases). Plain stdout stays text-only:
// empty output means silent, the contract the non-json callers rely on.
// Unknown flags are a usage error (exit 2).
import { homedir } from "node:os";
import { cliVersion } from "./cli.ts";
import { appendHooksLog, readGapsFile, resolveStore, suppressBootstrap } from "./store.ts";
import { BOOTSTRAP_NUDGE_TEXT, NUDGE_TEXT, aboutPrefix, gapLine, horizonBlock, provenanceFooter } from "./texts.ts";

// The flags horizon-inject accepts: the CLI's global options (--help and
// --version answer here too). --origin is accepted and ignored — harness glue
// forwards it; --cwd resolves the store and --harness/--session feed the
// provenance footer (spec 10.5).
const VALUE_FLAGS = new Set(["--cwd", "--harness", "--session", "--origin"]);
const BOOL_FLAGS = new Set(["--json", "--help", "--version"]);

// The output sink: the two writers main() reports through, defaulting to the
// process streams. The bin never passes one — byte-identical behavior — and
// the test harness hands a capturing pair, so a suite round is a function
// call instead of a process spawn. Bound at call time, never import time.
function processSink() {
  return {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  };
}

// The bin's own thin flag loop. It mirrors the CLI parser's --flag=value
// handling (takeFlag in src/cli.ts) so --cwd=<path> means the same thing on
// both bins — the CLI always accepted the = form while the bin answered
// "unknown option" (exit 2), a divergence nothing pinned. It does not reuse
// that parser itself: there are no positionals here (any bare token is an
// unknown option), --help/--version answer mid-loop, and the messages carry
// the bin's own name.
function parseArgs(argv, sink) {
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
      sink.stderr(`horizon-inject: unknown option: ${t}\n`);
      return { error: 2 };
    }
    // The = rejection outranks the short-circuits: --help=x and --version=x
    // are usage errors, exactly like --json=x — never a help answer.
    if (BOOL_FLAGS.has(name) && hasEq) {
      sink.stderr(`horizon-inject: ${name} takes no value\n`);
      return { error: 2 };
    }
    if (name === "--help") return { help: true };
    if (name === "--version") return { version: true };
    if (BOOL_FLAGS.has(name)) {
      opts[name.slice(2)] = true;
      i += 1;
      continue;
    }
    if (!hasEq) {
      if (i + 1 >= argv.length) {
        sink.stderr(`horizon-inject: ${name} requires a value\n`);
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
    "line is set, the bootstrap nudge when neither is. With --session, a provenance\n" +
    "footer follows after one blank line: the harness and session id to append to\n" +
    "`horizon add`/`horizon close` so the store's records name this session. No\n" +
    "--session, no footer.\n" +
    "--json prints one JSON line instead: {\"text\": <string>, \"store\": <string|null>}\n" +
    "— the composed text plus the resolved store directory (null when no store was\n" +
    "found). Plain stdout stays text-only; empty output means silent.\n" +
    "Read-only toward the store's data. The one write it ever makes is a single\n" +
    "best-effort line in the store's .horizon/hooks.log (the bin-fire log): an\n" +
    "unwritable log costs the line, never the injection. The composition twin of\n" +
    "`horizon show` (spec D6).\n"
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
// bootstrap case carries none (spec 10.4). The provenance footer (spec
// 10.5) rides every variant but silence, after the prefix and core,
// blank-line separated — the footer applies to the block AND both nudges
// (a storeless session's first bootstrap add deserves real provenance
// too), and only when a session id is known. Empty output stays empty:
// empty stdout means silent, whatever the flags said.
export function compose({ gaps, about, silence, harness, session }) {
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
  const footer = core === "" ? "" : provenanceFooter(harness, session);
  return aboutPrefix(about) + core + (footer === "" ? "" : `\n\n${footer}`);
}

// The total answer for one cwd: the composed text plus the store directory
// the resolution already paid for (null when no store was found — the
// silence and storeless-nudge cases) and the fire's outcome for hooks.log
// (ticket 09): injected when the block composes, nudged for either nudge,
// silent when empty. Read-only toward the store's DATA (D6): resolve+read,
// never write — no tmp sweep, no materialization; the one sanctioned write
// is the bin-fire log line main() appends to .horizon/hooks.log. `home` is
// injectable so tests can fake $HOME and never touch the real one. Errors
// come back as { error: { code, message }, store, outcome } and stay
// unwrapped: stderr keeps the store's message and stdout stays empty even
// under --json; the store rides along so main() can still log the failed
// fire against it.
export function resolveInjection(dir, { home, harness, session }) {
  const found = resolveStore(dir, { readonly: true });
  const store = found ? found.dir : null;
  if (found && found.open.code !== undefined) return { error: found.open, store, outcome: "error" };
  let gaps = [];
  let about;
  if (found) {
    const g = readGapsFile(found.dir);
    if (!g.ok) return { error: { code: g.code, message: g.message }, store, outcome: "error" };
    gaps = g.data.gaps;
    about = g.data.about;
  }
  // A storeless $HOME is not a project: emit nothing (exit 0, empty stdout —
  // the adapters treat empty stdout as a silent no-op).
  const silence = suppressBootstrap({ cwd: dir, storeFound: !!found, home });
  const text = compose({ gaps, about, silence, harness, session });
  const outcome = text === "" ? "silent" : gaps.length > 0 ? "injected" : "nudged";
  return { text, store, outcome };
}

// The bin entry, mirroring src/cli.ts's main: writes stdout and stderr
// itself (through the sink) and returns the exit code for the shim to exit
// with — in-process, the return value IS the code.
export async function main(argv, sink = processSink()) {
  const parsed = parseArgs(argv, sink);
  if (parsed.error !== undefined) {
    return parsed.error;
  }
  if (parsed.help) {
    sink.stdout(helpText());
    return 0;
  }
  if (parsed.version) {
    sink.stdout(`horizon-inject ${cliVersion()}\n`);
    return 0;
  }

  const cwd = parsed.opts?.cwd;
  const json = !!parsed.opts?.json;
  // The footer's inputs (spec 10.5): --session gates it — absent, no footer,
  // so a human running the bin by hand gets none. The harness only names the
  // footer, so it always resolves: flag, then HORIZON_HARNESS, else
  // "unknown".
  const harness = parsed.opts?.harness ?? process.env.HORIZON_HARNESS ?? "unknown";
  const session = parsed.opts?.session;
  let answer;
  try {
    answer = resolveInjection(cwd ?? process.cwd(), { home: homedir(), harness, session });
  } catch {
    // Nothing is known about the store here, so the fire stays unlogged —
    // the log helper needs the resolved dir, and guessing one would be a
    // second resolution this fail-open path must not pay for.
    sink.stderr("horizon-inject: store read failed\n");
    return 7;
  }
  // hooks.log (ticket 09): one best-effort line per bin fire into the
  // resolved store. Storeless fires (the $HOME silence, the storeless
  // nudge) have no store to log into and stay unlogged. The append never
  // raises and never changes the exit code below — an unwritable hooks.log
  // costs the line, never the hook.
  if (answer.store) {
    appendHooksLog(answer.store, { harness, bin: "horizon-inject", session, outcome: answer.outcome });
  }
  if (answer.error) {
    sink.stderr(`${answer.error.message}\n`);
    return answer.error.code;
  }
  if (json) {
    sink.stdout(JSON.stringify({ text: answer.text, store: answer.store }) + "\n");
  } else {
    sink.stdout(answer.text);
  }
  return 0;
}
