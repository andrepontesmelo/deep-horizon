// The three locked injection strings (spec section 10). They live in the core
// package so every adapter imports them instead of carrying its own copy.
//
// BYTE-CONTRACT (DEF-3 ruling, 2026-09-09): each export equals the inside of
// its spec §10 fenced block EXACTLY — no leading/trailing newline added,
// none stripped. The fence backticks are markdown, not content. Verified by
// test 34, which extracts all three fences from the spec file and asserts
// character equality.
//
// Selection is state-sensitive (spec 10): gaps open → the block, prefixed by
// the about line when set; about set, no gaps → the warm nudge, prefixed;
// neither (store absent or empty) → the bootstrap nudge, alone.
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
  "Some gaps carry extended context beyond their one line —\n" +
  "`horizon detail <id>` prints it.\n" +
  "\n" +
  "Three things are yours to do. When the user wants something that outlives this\n" +
  "session, offer `horizon add \"<one line>\"`. When something here looks done, offer\n" +
  "`horizon close <id>`. If no about line heads this block and the work tells you\n" +
  "what the project is about, offer `horizon about \"<one line>\"`; if the user says\n" +
  "it themselves, offer to set or update it with their words. All need the user's\n" +
  "yes — the horizon is theirs, you only hold the pen.";

// The bootstrap nudge (spec 10.2): injected when the store carries neither an
// about line nor gaps — an absent store and an empty store are the same state
// here. Composed alone: there is no about line to prefix.
export const BOOTSTRAP_NUDGE_TEXT =
  "This project has no horizon yet — no about line, no gaps. If the work at hand\n" +
  "tells you what the project is about, offer once to set it:\n" +
  "`horizon about \"<one line>\"` with your draft, after the user's yes. If the\n" +
  "user says it themselves, offer their words instead. When the user names a want\n" +
  "that outlives this session, offer `horizon add \"<one line>\"` the same way.\n" +
  "A decline ends the offering for this session.";

// The warm nudge (spec 10.3): injected when an about line is set but no gaps
// are. Composed AFTER aboutPrefix, so "the line above" is the about line.
export const NUDGE_TEXT =
  "No gaps yet. `horizon add \"<one line>\"` if the user names a want that\n" +
  "outlives this session. If what the user says the project is about no longer\n" +
  "matches the line above, offer to update it — `horizon about`, their words,\n" +
  "after their yes.";

// Function replacement: a string replacement would expand $-patterns
// ($&, $`, $', $$, $1) from user-authored gap text (DEF-1).
export function horizonBlock(gapsStdout) {
  return HORIZON_BLOCK_TEMPLATE.replace("{{GAPS}}", () => gapsStdout);
}

// The about-line composition (spec 10.4): when the store carries an about
// line, the injected text opens with `This project is about: <about>` and a
// blank line ahead of the locked block or the warm nudge. Unset (or not a
// string), the prefix is empty and the composed output is exactly the
// block/nudge alone — the locked strings never change to carry it. The
// bootstrap nudge is the no-about case, so it never carries a prefix.
// Composed by horizon-inject (D6: single-sourced there, never per-adapter).
export function aboutPrefix(about) {
  return typeof about === "string" ? `This project is about: ${about}\n\n` : "";
}
