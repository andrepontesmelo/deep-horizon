#!/usr/bin/env node
// horizon-inject (D6): pure composition. Runs the `show` logic against the
// resolved store, then prints the locked section-10 horizon block when gaps
// exist, or the nudge when they do not. No store writes, no new commands.
//
// Flags mirror the CLI's global options so harness glue can forward them
// (--cwd, --harness, --session, --origin); only --cwd changes behaviour.
// --json swaps the composed text for {"text": <string>} for programmatic
// callers. Unknown flags are a usage error (exit 2).
import { existsSync, readFileSync } from "node:fs";
import { resolveStore, readGapsFile } from "../src/store.ts";
import { HORIZON_BLOCK_TEMPLATE, NUDGE_TEXT } from "../src/texts.ts";

const GLOBAL_FLAGS = new Set(["--cwd", "--json", "--help", "--version", "--harness", "--session", "--origin"]);

function parseArgs(argv) {
  const opts = {};
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    if (t === "--") break; // rest ignored: no positional contract
    if (!GLOBAL_FLAGS.has(t)) {
      process.stderr.write(`horizon-inject: unknown option: ${t}\n`);
      return { error: 2 };
    }
    if (t === "--help") return { help: true };
    if (t === "--version") return { version: true };
    if (t === "--json") {
      opts.json = true;
      i += 1;
      continue;
    }
    if (i + 1 >= argv.length) {
      process.stderr.write(`horizon-inject: ${t} requires a value\n`);
      return { error: 2 };
    }
    opts[t.slice(2)] = argv[i + 1];
    i += 2;
  }
  return { opts };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error !== undefined) {
    process.exitCode = parsed.error;
    return;
  }
  if (parsed.help) {
    process.stdout.write(
      "usage: horizon-inject [--cwd <path>] [--json] [--harness <name>] [--session <id>] [--origin <human|agent-proposed>]\n" +
        "\n" +
        "Prints the section-10 horizon block when the store has open gaps, the nudge when it does not.\n" +
        "Read-only: never writes the store. The composition twin of `horizon show` (spec D6).\n",
    );
    return;
  }
  if (parsed.version) {
    let v = "0.0.0";
    try {
      v = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? v;
    } catch {}
    process.stdout.write(`horizon-inject ${v}\n`);
    return;
  }

  const cwd = parsed.opts?.cwd;
  const json = !!parsed.opts?.json;
  let text;
  let exitCode = 0;
  try {
    // readonly (D6): pure composition — resolve+read, never write. The tmp
    // sweep and store materialization stay CLI-only side effects.
    const found = resolveStore(cwd ?? process.cwd(), { readonly: true });
    let stdoutText = "";
    if (found) {
      if (found.open.code !== undefined) {
        process.stderr.write(`${found.open.message}\n`);
        exitCode = found.open.code;
      } else {
        const g = readGapsFile(found.dir);
        if (!g.ok) {
          process.stderr.write(`${g.message}\n`);
          exitCode = g.code;
        } else if (g.data.gaps.length > 0) {
          stdoutText = g.data.gaps.map((gap) => `${gap.id}  ${gap.text}`).join("\n") + "\n";
        }
      }
    }
    if (exitCode === 0) {
      text = stdoutText.length > 0 ? HORIZON_BLOCK_TEMPLATE.replace("{{GAPS}}", () => stdoutText) : NUDGE_TEXT;
    }
  } catch {
    process.stderr.write("horizon-inject: store read failed\n");
    exitCode = 7;
  }
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    return;
  }
  if (json) {
    process.stdout.write(JSON.stringify({ text }) + "\n");
  } else {
    process.stdout.write(text);
  }
}

main();
