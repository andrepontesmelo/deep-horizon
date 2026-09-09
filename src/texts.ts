// The two locked injection strings (spec section 10). They live in the core
// package so every adapter imports them instead of carrying its own copy.
//
// BYTE-CONTRACT (DEF-3 ruling, 2026-09-09): each export equals the inside of
// its spec §10 fenced block EXACTLY — no leading/trailing newline added,
// none stripped. The fence backticks are markdown, not content. Verified by
// test 34, which extracts both fences from the spec file and asserts
// character equality (lengths 885/98).
export const HORIZON_BLOCK_TEMPLATE =
  "This project has a horizon — a short list of what the user wants and doesn't\n" +
  "have yet. It was written across earlier sessions, by earlier agents, with the\n" +
  "user's approval:\n" +
  "\n" +
  "{{GAPS}}\n" +
  "\n" +
  "You have inherited it, not been assigned it. Nothing here is due today. Sessions\n" +
  "that touch none of these are perfectly normal; the horizon exists so the aim\n" +
  "survives between sessions, not so any one session delivers it.\n" +
  "\n" +
  "What it is not: a backlog, a task list, or work assigned to this session. A gap\n" +
  "may sit open for weeks across many sessions and that is the normal case. Do not\n" +
  "plan around closing them, and do not report progress against them.\n" +
  "\n" +
  "Two things are yours to do. When the user wants something that outlives this\n" +
  "session, offer `horizon add \"<one line>\"`. When something here looks done, offer\n" +
  "`horizon close <id>`. Both need the user's yes — the horizon is theirs, you only\n" +
  "hold the pen.";

export const NUDGE_TEXT =
  "Horizon: none set. `horizon add \"<one line>\"` if the user names a want that\n" +
  "outlives this session.";

// Function replacement: a string replacement would expand $-patterns
// ($&, $`, $', $$, $1) from user-authored gap text (DEF-1).
export function horizonBlock(gapsStdout) {
  return HORIZON_BLOCK_TEMPLATE.replace("{{GAPS}}", () => gapsStdout);
}
