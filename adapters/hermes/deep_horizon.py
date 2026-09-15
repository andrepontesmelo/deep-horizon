"""deep-horizon Hermes plugin.

Glue only: this plugin spawns the horizon bins and hands their stdout to the
core. It never composes the section-10 texts itself — ``horizon-inject`` is
the single composer (the spec's acceptance test 36 bans a literal copy of the
injected strings in any adapter), and it deliberately does NOT import
``hermes_cli`` for composition (CLI-as-core, like every other harness).

Injection: ``register_system_prompt_section("deep-horizon", <callable>)`` —
the persistent, every-turn mechanism. The callable receives the core's
read-only session-info mapping — ``types.MappingProxyType``, a ``Mapping`` but
NOT a ``dict`` (``plugins_dispatch.py:402``) — carrying ``session_id``,
``cwd``, ``profile_name``, ..., and returns
``horizon-inject --harness hermes --session <id> --cwd <cwd>`` stdout, or
``""`` when nothing should be injected. The core renders the section once for
a new session, freezes it on the agent, and persists it verbatim; on resume
the stored bytes are recovered from the persisted prompt, so the horizon is
never duplicated. Caps: the section is registered with ``max_chars=4000`` (the
core's hard maximum); the worst-case block (5 gaps x 512 code points plus
boilerplate) renders at ~3.5k chars, and an oversized render is dropped by the
core rather than breaking the session (fail open).

Provenance: every ``horizon-inject`` spawn carries ``--session <session_id>``
(spec amendment 07-D1 — the composer bakes a provenance footer naming
``--harness {{HARNESS}} --session {{SESSION}}`` into the block and both
nudges when the flag is present); ``horizon session-end`` has carried
``--session`` since the close hook landed. The section takes the id from
``session_info``, the param path from its payload (validated non-empty
before any spawn); an absent or empty id spawns without the flag, the same
rule a hand-run probe follows.

Subagent exclusion (ticket 06): the two paths split. The param path really
excludes children — its payload carries ``parent_session_id`` whenever the
core built a delegate child (wired 2026-07-27), and the guard below skips on
it. The section path accepts the noise: the session-info mapping still
exposes only ``session_id``, ``model``, ``provider``, ``platform``,
``profile_name`` and ``cwd`` — no parent/depth discriminator, and dropping
the section for cwd-less session-info would silence real sessions too — so
it fails open, the pi adapter's trade, carried as the upstream ask. The
guard still accepts every convention the core might adopt
(``parent_session_id``, ``is_subagent``, ``delegation_depth``,
``origin: "subagent"``) and the explicit ``HORIZON_SUBAGENT=1`` opt-out.

Candidate rule (ticket 06): a non-empty session cwd is the ONLY candidate —
the section spawns ``horizon-inject`` for it exactly once and never defers
to the process working directory. That defer existed for the pre-0.21.2
empty-cwd shape; hermes 0.21.2 resolves the ``terminal.cwd: "."`` placeholder
to the home fallback (``tools/terminal_scope.py``,
``_resolve_scope_cwd_placeholder``), so gateway/telegram/cron sessions now
carry ``cwd=/home/andre`` — real but storeless — and horizon-inject's own
$HOME-silence answers ``""``. That silence is the "silence on absence"
philosophy holding, not failing: home-cwd sessions were never project-dir
sessions, and their horizons arrive via the param path; freezing the launch
dir's nudge behind them (the old defer) was the F5 false-nudge bug. An empty
cwd (the local CLI with ``terminal.cwd`` unset: ``resolve_context_cwd()``
returns ``None``) still falls back to the process working directory, the
launch dir. The plugin never walks the filesystem for stores itself — store
existence is the bin's answer (``--json``'s ``store`` field), one rule; a
storeless answer is taken verbatim (the nudge for a storeless project dir,
silence for $HOME). A frozen storeless nudge can still coexist with a later
param-path block in the same session — accepted and bounded (ticket 06):
the section freezes once, the param block arrives later and real, and they
cannot be reconciled without rewriting frozen prompts. The pre_llm_call
path never distrusts (its repo paths
come from the model's own tool-call parameters and are ground truth); a
storeless answer there is silence — the nudge never fires from a param
probe.

Multi-store stash (ticket 05): ``_session_store`` maps session id -> the SET
of stores this session's injections were composed from. ``_section_text``
stashes its answer's store; ``_pre_llm_call`` stashes the store behind every
store-backed param injection — a telegram session that touched three
projects stashes three stores.

Close: ``on_session_finalize`` runs ``horizon session-end --harness hermes
--session <id> --store <store>`` ONCE PER STASHED STORE — every store that
injected records, so a multi-store session leaves one record per project,
each honest in its own log, with ``summary: null`` (never a fabricated
summary). The partial-close world is accepted and documented (research/02):
the hook fires ONLY on CLI /new, gateway /new|/reset, gateway shutdown, and
TUI close — ``cron_complete``, ``cli_close``, ``agent_close``, and
``compression`` book state.db rows but fire no hook, so cron and plain-CLI/
kanban sessions that never finalize record nothing (documented degradation,
carried as the upstream ask). A session that never injected (no stash) falls
back to ``--cwd`` with the first cwd candidate — the payload cwd (absent at
every 0.21.2 finalize site), then the process working directory;
session-end on a storeless cwd is a safe no-op. Hooks fail open (D2): an
unresolvable or failing bin injects nothing, records nothing, and the
session proceeds — and one store's failing session-end never blocks the
others.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
from collections.abc import Mapping

logger = logging.getLogger("deep-horizon")

SECTION_ID = "deep-horizon"
HARNESS = "hermes"
SPAWN_TIMEOUT_S = 15
# Explicit subagent opt-out, mirroring the pi adapter's HORIZON_SUBAGENT. The
# Hermes session-info mapping exposes no parent/depth discriminator today, so
# this env var is the one signal an embedder can always set.
SUBAGENT_ENV = "HORIZON_SUBAGENT"
_TRUTHY = ("1", "true", "yes", "on")

_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_BIN_DIR = os.path.normpath(os.path.join(_PLUGIN_DIR, "..", "..", "bin"))

# The only repo roots matched, per the design: absolute ``/home/andre/git/``
# or its ``~/git/`` form. ``HORIZON_GIT_ROOT`` overrides the root for tests
# only (default is the fixed corpus; no production override exists by design).
def _git_root() -> str:
    root = os.environ.get("HORIZON_GIT_ROOT", "") or os.path.expanduser("~/git")
    return root if root.endswith("/") else root + "/"


# Path-like tokens inside a param string; _repo_root_of validates the prefix,
# so the tokenizer itself stays dumb (a token alone never triggers anything).
_CANDIDATE_RE = re.compile(r"~/[^\s\"'`]*|/[^\s\"'`]*")

def _spawn_bin(bin_name: str, args: list[str]) -> tuple[int, str, str]:
    """Run a horizon bin, returning (status, stdout, stderr).

    A repo checkout (this plugin still sitting in adapters/hermes/ of a clone)
    runs bin/<name>.js with node — the bare bins are not on PATH yet; an
    installed package relies on the global bin on PATH (D2). Raises when the
    binary cannot be resolved at all — callers treat that as fail-open. The
    timeout guards against a hung bin stalling a session start.
    """
    local = os.path.join(_REPO_BIN_DIR, f"{bin_name}.js")
    if os.path.isfile(local):
        node = shutil.which("node")
        if node is None:
            raise FileNotFoundError("node")
        cmd = [node, local, *args]
    else:
        resolved = shutil.which(bin_name)
        if resolved is None:
            raise FileNotFoundError(bin_name)
        cmd = [resolved, *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=SPAWN_TIMEOUT_S, check=False)
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def _parse_answer(stdout: object) -> dict | None:
    """Parse a horizon-inject --json answer: {"text": str, "store": str|None}.

    Anything off-shape is a failed probe (None), never an injection — the
    plugin trusts only the total answer the composer documents. The store
    field is the one store-existence rule: a str is the store the answer was
    composed from (stashed for the close hook on both paths), None is
    storeless (silence on the param path, the verbatim nudge-or-silence
    answer on the section path)."""
    if not isinstance(stdout, str) or not stdout.strip():
        return None
    try:
        parsed = json.loads(stdout)
    except ValueError:
        return None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("text"), str):
        return None
    store = parsed.get("store")
    if store is not None and not isinstance(store, str):
        return None
    return {"text": parsed["text"], "store": store}


def _inject_args(cwd: str, session_id: object) -> list[str]:
    """The horizon-inject argv for one candidate cwd: the total-answer flags
    plus the session id (spec amendment 07-D1 — the composer bakes the
    provenance footer from --harness/--session, so every adapter spawn rides
    the id it holds). An absent or empty id spawns without the flag — the
    same no-footer rule a hand-run probe follows."""
    args = ["--harness", HARNESS]
    if isinstance(session_id, str) and session_id:
        args += ["--session", session_id]
    return args + ["--json", "--cwd", cwd]


def _spawn_answer(cwd: str, session_id: object = "") -> dict | None:
    """horizon-inject --json for one cwd, parsed; None on any failure (D2).

    Fail open: an unresolvable bin, a timeout, a nonzero exit, or an
    off-shape payload all mean the same thing — this probe never happened."""
    try:
        status, stdout, _stderr = _spawn_bin("horizon-inject", _inject_args(cwd, session_id))
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        return None  # fail open (D2): unresolvable bin injects nothing
    if status != 0:
        return None
    return _parse_answer(stdout)


def _is_subagent(session_info) -> bool:
    """Best-effort subagent detection for the section callable.

    The live mapping carries no parent/depth discriminator, so accept every
    convention the core might adopt, plus the HORIZON_SUBAGENT env opt-out.
    """
    parent = session_info.get("parent_session_id")
    if isinstance(parent, str) and parent.strip():
        return True
    if session_info.get("is_subagent") is True:
        return True
    origin = session_info.get("origin")
    if isinstance(origin, str) and origin.strip() == "subagent":
        return True
    try:
        if int(session_info.get("delegation_depth") or 0) > 0:
            return True
    except (TypeError, ValueError):
        pass
    return str(os.environ.get(SUBAGENT_ENV, "")).strip().lower() in _TRUTHY


def _cwd_candidates(session_cwd: object) -> list[str]:
    """The cwd candidates for a session-derived spawn, best-first — at most one.

    Ticket 06: a non-empty session cwd is the ONLY candidate; the process
    working directory follows ONLY when the session cwd is empty (the local
    CLI's unset ``terminal.cwd`` — the launch dir). Store existence is the
    bin's answer (--json's store field), never a local walk — the only path
    knowledge left here is spawning bins and remembering what they
    answered."""

    if isinstance(session_cwd, str) and session_cwd.strip():
        return [session_cwd]
    try:
        proc_cwd = os.getcwd()
    except OSError:
        return []
    return [proc_cwd] if proc_cwd else []


def _resolve_horizon_cwd(session_cwd: object) -> str:
    """The cwd for a session-derived spawn with no stashed store, "" when unusable.

    Candidate order (ticket 06): the session cwd when non-empty, else the
    process working directory — the first candidate stands, and with the
    single-candidate rule that is the whole list. Used only by the close
    hook's no-stash fallback: the session never injected, the first
    candidate is the best guess, and session-end on a storeless cwd is a
    safe no-op anyway.
    """
    candidates = _cwd_candidates(session_cwd)
    return candidates[0] if candidates else ""


def _section_text(session_info) -> str:
    """The system-prompt section callable. Returns the composed horizon block
    (or nudge) for top-level sessions with a working directory, "" for subagent
    sessions and whenever the bin is missing or fails. Must never raise: the core
    freezes a render-time failure as an absent section."""
    try:
        # The core hands a read-only view, not a dict: plugins_dispatch.py:396
        # does ``types.MappingProxyType(dict(session_info))``. A dict-only guard
        # is False for that object and silently renders nothing in every real
        # session, so accept any Mapping (test 67 pins this).
        if not isinstance(session_info, Mapping):
            return ""
        if _is_subagent(session_info):
            return ""
        # The candidate (ticket 06): a non-empty session cwd is the ONLY
        # candidate — one spawn, no process-cwd defer. The defer existed for
        # the pre-0.21.2 empty-cwd shape (terminal.cwd "." resolving to the
        # gateway process cwd); 0.21.2 resolves the placeholder to $HOME
        # instead, so the gateway home session's answer is horizon-inject's
        # own $HOME silence — correct, nothing to defer to. An empty cwd
        # falls back to the launch dir (the local CLI's shape) and its
        # answer stands the same way. Store existence is the bin's answer:
        # a storeless answer is taken verbatim — the nudge for a storeless
        # project dir, silence for $HOME.
        sid = session_info.get("session_id")
        candidates = _cwd_candidates(session_info.get("cwd"))
        answer = _spawn_answer(candidates[0], sid) if candidates else None
        if answer is None:
            return ""
        if answer["store"] is not None and isinstance(sid, str) and sid:
            # Remember the store THIS session's horizon was composed from, so
            # the close hook can hand it back with --store even though the
            # finalize payload arrives with no cwd and the process may have
            # chdir'd by then (_session_store below — a set: the param path
            # adds its own stores alongside this one).
            _session_store.setdefault(sid, set()).add(answer["store"])
        return answer["text"]
    except Exception:  # noqa: BLE001 — the section must never break a session
        logger.warning("deep-horizon section render failed", exc_info=True)
        return ""


def _on_session_finalize(payload=None, **kwargs) -> None:
    """Close hook: one session-end record per stashed store, summary omitted
    (null). Swallows everything — finalize is teardown; nothing here may
    break it.

    Sync by contract: hermes' invoke_hook dispatches callbacks synchronously
    (0.21.2 also resolves coroutine results, but sync stays correct) — an
    async def here would have silently never executed before it. Keep this a
    plain def; there is nothing to await anyway.

    The dispatcher calls hooks with FLAT kwargs — session_id=…, platform=…,
    reason=… (plugins_dispatch.py:159) — not a single payload dict, so a
    payload-only signature never binds and the hook no-ops (verified live,
    2026-09-11). Accept both shapes: read session_id/cwd from the kwargs
    first, then from a positional payload dict. The hook fires only on CLI
    /new, gateway /new|/reset, gateway shutdown, and TUI close (research/02)
    — the partial-close world this loop's fail-open per store lives in."""
    try:
        session_id = kwargs.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            info = payload if isinstance(payload, dict) else {}
            session_id = info.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            return
        info = payload if isinstance(payload, dict) else {}
        # One record per stashed store (ticket 05): pop the whole set, then
        # session-end once per store — a session that touched three projects
        # leaves three records, each honest in its own project's log (the
        # store format allows one session id on many records; the telegram
        # shape is exactly why). Sorted for determinism: a set iterates
        # arbitrarily and the record order should not. The loop fails open
        # PER STORE (D2) — one store's unresolvable bin or failed spawn
        # never blocks the others.
        stores = _session_store.pop(session_id, set())
        if stores:
            for store in sorted(stores):
                args = ["session-end", "--harness", HARNESS, "--session", session_id, "--store", store]
                try:
                    _spawn_bin("horizon", args)
                except (FileNotFoundError, subprocess.SubprocessError, OSError):
                    continue  # fail open (D2) — the remaining stores still record
            return
        # No stash (a session that never injected, or whose spawns failed):
        # the cwd candidates remain the fallback — the payload cwd (if a
        # future core adds it), then the process cwd; the first candidate
        # stands, and session-end on a storeless cwd is a safe no-op.
        cwd = _resolve_horizon_cwd(
            kwargs.get("cwd") if isinstance(kwargs.get("cwd"), str) and kwargs.get("cwd") else info.get("cwd")
        )
        if cwd:
            args = ["session-end", "--harness", HARNESS, "--session", session_id, "--cwd", cwd]
            try:
                _spawn_bin("horizon", args)
            except (FileNotFoundError, subprocess.SubprocessError, OSError):
                return  # fail open (D2)
    except Exception:  # noqa: BLE001
        logger.warning("deep-horizon session finalize failed", exc_info=True)


# ---------------------------------------------------------------------------
# pre_llm_call injection keyed on tool-call parameters (HL-22).
#
# Locked design (cwd-triggered rejected by data: agent shell cd into repo in
# only 12.7-13.8% of project-work telegram sessions): each LLM call, scan ONLY
# NEW assistant tool_calls since the previous LLM call (delta, not full
# history). Parse tool PARAMETERS for absolute /home/andre/git/<repo> paths
# (and the ~/git/ form). Tool RESULTS and user messages are NEVER scanned —
# "list all files in my workspace" must inject nothing.
#
# Arrival contract (accepted): the horizon lands on the LLM call AFTER the
# first tool touch of a repo. The first action is uninformed; scanning user
# text to fix that is explicitly out of scope.
# ---------------------------------------------------------------------------

# Per (session_id, repo) memory: a repo's block injects once per session, on
# the first LLM call after its first tool-touch. Keyed by session because the
# gateway caches agents across turns — module state alone would leak.
_seen: dict[tuple[str, str], int] = {}
# Highest assistant-tool_calls count already scanned per session (the delta
# cursor). The count is NOT a monotone clock over the history: a session_id
# absent from this dict is "first sight" — fresh session turn 1 (empty,
# tool-call-free history) or a resumed session after a gateway restart (FULL
# restored history) — and first sight consumes the whole history silently, so
# the restored past can never re-inject. And turn-start compaction can REWRITE
# the history below the cursor, so a fire whose history holds fewer tool_calls
# than the stored cursor resets the cursor to zero and rescans (the shrink
# guard); see _pre_llm_call.
_scanned: dict[str, int] = {}

# Per-session store memory for the close hook — session id -> the SET of
# stores this session's injections were composed from. The finalize payload
# carries no cwd key at any 0.21.2 dispatch site (research/02), and by exit
# time the process cwd may have moved, so the stores a record belongs in are
# the ones the horizon-inject --json answers named at injection time.
# _section_text stashes the section answer's store; _pre_llm_call stashes
# every store-backed param injection's store — a telegram session that
# touched three projects stashes three. _on_session_finalize records once
# per stashed store and pops the entry whole. A session whose finalize never
# fires (the partial-close world: cron_complete, cli_close, agent_close,
# compression book rows but fire no hook — research/02) leaves a few short
# strings behind — the same growth shape as _seen below.
_session_store: dict[str, set[str]] = {}

# Allowlist: which tools' params are scanned, and which string params per
# tool count as path-bearing. terminal's command string is where ``git -C`` /
# ``cd`` sightings live, so both its keys are scanned. Unknown tools (mcp_*,
# skill names, future additions) are ignored so a new tool's params can never
# smuggle a repo path into the injection stream.
_PARAM_KEYS: dict[str, tuple[str, ...]] = {
    "terminal": ("command", "workdir"),
    "read_file": ("path",),
    "write_file": ("path",),
    "patch": ("path",),
    "search_files": ("path",),
    "execute_code": ("code",),
}

# A repo touch is <root><name>[/...]: the name segment must be non-empty so a
# bare root prefix alone never matches (it is a root, not a repo, and has no
# .horizon to stat). The match then extends to the end of the segment run so
# the longest repo path wins per param.
def _repo_root_of(path: str) -> str | None:
    """Return <git-root>/<repo> for a touched path, else None.

    ``~/git/`` expands against the live user (developer shells agree). The
    test seam ``HORIZON_GIT_ROOT`` redirects the root (unit tests only).
    Relative paths can never name a repo root — return None.
    """
    expanded = os.path.expanduser(path) if path.startswith("~/") else path
    root = _git_root()
    if not expanded.startswith(root):
        return None
    name = expanded[len(root):].split("/", 1)[0]
    if not name or name in (".", ".."):
        return None
    return root + name


def _repos_in_params(tool_name: str, args: object) -> set[str]:
    """Repo roots referenced in the path-bearing params of one tool call."""
    keys = _PARAM_KEYS.get(tool_name)
    if not keys or not isinstance(args, dict):
        return set()
    found: set[str] = set()
    for key in keys:
        value = args.get(key)
        if not isinstance(value, str) or not value:
            continue
        for token in _CANDIDATE_RE.findall(value):
            root = _repo_root_of(token)
            if root is not None:
                found.add(root)
    return found


def _new_tool_calls(conversation_history: object, session_id: str) -> list:
    """Assistant tool_calls since the previous pre_llm_call (delta).

    Walks the history in order, counting every assistant message that carries
    a tool_calls list; returns the calls of messages past the per-session
    cursor and advances it. Shape-tolerant: persisted rows are dicts with
    ``{"function": {"name": ..., "arguments": ...}}`` (chat_completion_helpers
    :_assistant_tool_call_dict); anything else is skipped, never raised on.
    """
    if not isinstance(conversation_history, list):
        return []
    start = _scanned.get(session_id, 0)
    index = 0
    new_calls: list = []
    for msg in conversation_history:
        if not isinstance(msg, dict):
            continue
        calls = msg.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call in calls:
            if index >= start:
                new_calls.append(call)
            index += 1
    _scanned[session_id] = index
    return new_calls


def _tool_call_count(conversation_history: object) -> int:
    """Total assistant tool_calls carried by a history, shape-tolerantly."""
    if not isinstance(conversation_history, list):
        return 0
    count = 0
    for msg in conversation_history:
        if isinstance(msg, dict) and isinstance(msg.get("tool_calls"), list):
            count += len(msg["tool_calls"])
    return count


def _mark_history_seen(conversation_history: object, session_id: str) -> set[str]:
    """Classify every repo touch in a history and mark it seen — never inject.

    Shared consume-without-inject path: the history handed to a first sight is
    one the session already lived through (a fresh session's empty turn 1, or
    the byte-exact restored transcript after a gateway restart), so marking
    every touched repo seen without spawning horizon-inject is what keeps the
    once-per-(session, repo) invariant across restarts. Shape-tolerant like
    _new_tool_calls: anything off-shape is skipped, never raised on.
    """
    touched: set[str] = set()
    if not isinstance(conversation_history, list):
        return touched
    for msg in conversation_history:
        if not isinstance(msg, dict):
            continue
        calls = msg.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call in calls:
            name, args = _call_args(call)
            touched.update(_repos_in_params(name, args))
    for repo in touched:
        _seen[(session_id, repo)] = 1
    return touched


def _call_args(call: object) -> tuple[str, object]:
    """(tool name, args) from a persisted tool_call dict; ("", {}) when off-shape."""
    if not isinstance(call, dict):
        return "", {}
    fn = call.get("function")
    if not isinstance(fn, dict):
        return "", {}
    name = fn.get("name")
    args = fn.get("arguments")
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except (ValueError, TypeError):
            return name if isinstance(name, str) else "", {}
    if not isinstance(name, str):
        return "", {}
    return name, args if isinstance(args, dict) else {}


def _first_turn_frozen_repo(is_first_turn: object, terminal_cwd: object) -> str | None:
    """The repo the frozen section already covers on turn one, if any.

    When a turn-one touch lands inside the session's launch repo, the frozen
    section (rendered once at session start, persisted verbatim) already
    carries that repo's horizon, so the per-turn hook must stay silent for it.
    terminal_cwd is a test seam / defensive fallback only: the production core
    sends no cwd in pre_llm_call payloads and TERMINAL_CWD is unset in the
    gateway env, so the guard is inert in production — and harmless, because
    turn 1 has no tool_calls. Reads terminal_cwd (what the tests pass)
    falling back to the live TERMINAL_CWD env — never os.getcwd().
    """
    if is_first_turn is not True:
        return None
    raw = terminal_cwd if isinstance(terminal_cwd, str) and terminal_cwd else os.environ.get("TERMINAL_CWD", "")
    if not raw:
        return None
    return _repo_root_of(raw.strip())


def _pre_llm_call(
    session_id: str = "",
    conversation_history=None,
    user_message: str = "",
    is_first_turn: bool = False,
    parent_session_id: str = "",
    terminal_cwd: str = "",
    **_ignored,
) -> dict:
    """pre_llm_call hook: {"context": block} for newly tool-touched stored repos.

    Returns {"context": ""} (falsy context = no injection) whenever: the
    payload marks a subagent (parent_session_id set), no NEW tool-call params
    name a repo, the bin's --json answer for a touched repo comes back
    storeless (silence, never the nudge — param triggers stay silent without
    a store), or the (session, repo) pair already injected. A failed spawn
    releases the (session, repo) claim so a transient failure can retry.
    Fail open everywhere: any spawn failure or timeout injects nothing. Must
    never raise — the core logs hook errors and runs without the context.
    """
    try:
        if isinstance(parent_session_id, str) and parent_session_id.strip():
            return {"context": ""}
        if not isinstance(session_id, str) or not session_id:
            return {"context": ""}
        if session_id not in _scanned:
            # Skip-on-first-sight (DEF-A1): absent from the cursor means a
            # fresh session's turn 1 (empty, tool-call-free history) or a
            # resumed session after a gateway restart (FULL restored
            # history). Either way consume the whole history silently —
            # mark its touches seen without injecting — so the restored
            # past can never re-inject a block the session already has.
            _scanned[session_id] = _tool_call_count(conversation_history)
            _mark_history_seen(conversation_history, session_id)
            return {"context": ""}
        if _tool_call_count(conversation_history) < _scanned[session_id]:
            # Compaction shrink guard (DEF-A2): turn-start compaction
            # rewrote the history below the cursor, so per-call indexes
            # shifted. Rescan from zero — every already-injected repo stays
            # silent via _seen, so only touches the stale cursor never
            # reached (the post-compaction ones) can inject.
            _scanned[session_id] = 0
        frozen_repo = _first_turn_frozen_repo(is_first_turn, terminal_cwd)
        repos: set[str] = set()
        for call in _new_tool_calls(conversation_history, session_id):
            name, args = _call_args(call)
            repos.update(_repos_in_params(name, args))
        if frozen_repo is not None:
            repos.discard(frozen_repo)
        blocks: list[str] = []
        for repo in sorted(repos):
            if (session_id, repo) in _seen:
                continue
            _seen[(session_id, repo)] = 1
            try:
                status, stdout, _stderr = _spawn_bin("horizon-inject", _inject_args(repo, session_id))
            except (FileNotFoundError, subprocess.SubprocessError, OSError):
                # Release the claim: a transient spawn failure must never
                # silence this repo for the rest of the session — the next
                # touch retries (the dsh param trigger's pinned contract).
                del _seen[(session_id, repo)]
                continue  # fail open (D2)
            if status != 0:
                del _seen[(session_id, repo)]  # same release for a failed bin run
                continue
            answer = _parse_answer(stdout)
            if answer is None:
                del _seen[(session_id, repo)]  # off-shape payload: retryable, not silence
                continue
            if answer["store"] is None:
                continue  # storeless: silence, never the nudge — remembered for the session
            # Stash the store THIS injection was composed from (ticket 05):
            # finalize records once per stashed store, so the param path
            # contributes its stores alongside whatever the section froze.
            _session_store.setdefault(session_id, set()).add(answer["store"])
            if answer["text"]:
                blocks.append(answer["text"])
        return {"context": "\n\n".join(blocks)}
    except Exception:  # noqa: BLE001 — the hook must never break a turn
        logger.warning("deep-horizon pre_llm_call failed", exc_info=True)
        return {"context": ""}


def register(ctx) -> None:
    """Plugin entry point: the persistent section plus the close hook."""
    ctx.register_system_prompt_section(SECTION_ID, _section_text, max_chars=4000)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("on_session_finalize", _on_session_finalize)
