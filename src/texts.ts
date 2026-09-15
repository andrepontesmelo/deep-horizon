// The three locked injection strings (spec section 10). They live in the core
// package so every adapter imports them instead of carrying its own copy.
// The add teachings are id-first (`horizon add <id> "<one line>"`) since the
// 0.4.0 amendment (D2): the CLI takes the id positionally, so teaching the
// two-arg form was teaching an exit 2. The id's grammar stays out of these
// strings — the CLI's rejection message and the docs own it.
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
  "Three things are yours to do. When the user wants something that outlives\n" +
  "this session, offer `horizon add <id> \"<one line>\"`. When something here looks\n" +
  "done, offer `horizon close <id>`. If no about line heads this block and the work\n" +
  "tells you what the project is about, offer `horizon about \"<one line>\"`; if the\n" +
  "user says it themselves, offer to set or update it with their words. All need\n" +
  "the user's yes — the horizon is theirs, you only hold the pen.";

// The bootstrap nudge (spec 10.2): injected when the store carries neither an
// about line nor gaps — an absent store and an empty store are the same state
// here. Composed alone: there is no about line to prefix.
export const BOOTSTRAP_NUDGE_TEXT =
  "This project has no horizon yet — no about line, no gaps. If the work at hand\n" +
  "tells you what the project is about, offer once to set it:\n" +
  "`horizon about \"<one line>\"` with your draft, after the user's yes. If the\n" +
  "user says it themselves, offer their words instead. When the user names a want\n" +
  "that outlives this session, offer `horizon add <id> \"<one line>\"` the same way.\n" +
  "A decline ends the offering for this session.";

// The warm nudge (spec 10.3): injected when an about line is set but no gaps
// are. Composed AFTER aboutPrefix, so "the line above" is the about line.
export const NUDGE_TEXT =
  "No gaps yet. `horizon add <id> \"<one line>\"` if the user names a want that\n" +
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

// The provenance footer (0.4.0 amendment D1, spec 10.5): teaches a session to
// name itself in the store's records. Composed OUTSIDE the locked strings —
// the §10.4 about-prefix precedent — so the byte-lock (test 34) keeps locking
// only the three fences, and the footer's own bytes are pinned against the
// spec's §10.5 fence by their own test. Substitution is function replacement
// (DEF-1): session ids are caller-authored, and a string replacement would
// expand $-patterns ($&, $`, $', $$, $1) out of them. No session id (absent
// or empty), no footer — a human running horizon-inject by hand gets none.
// The harness always arrives resolved (flag, HORIZON_HARNESS, "unknown").
export const PROVENANCE_FOOTER_TEMPLATE =
  "Provenance: when you run `horizon add` or `horizon close`, append\n" +
  "`--harness {{HARNESS}} --session {{SESSION}}` verbatim — it names this\n" +
  "session in the store's record.";

export function provenanceFooter(harness, session) {
  if (typeof session !== "string" || session.length === 0) return "";
  return PROVENANCE_FOOTER_TEMPLATE.replace("{{HARNESS}}", () => harness).replace("{{SESSION}}", () => session);
}

// The gap line (spec 3.1) — id, two spaces, text, one line per gap. Three
// renderers share it: `show` prints it per gap, the at-cap error lists the
// open gaps in it, and the injection composes the block's {{GAPS}} slot from
// it. One home so the two-spaces rule cannot drift apart between them.
export function gapLine(gap) {
  return `${gap.id}  ${gap.text}`;
}
