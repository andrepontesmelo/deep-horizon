"""horizon-line Hermes plugin.

Glue only: this plugin spawns the horizon bins and hands their stdout to the
core. It never composes the section-10 texts itself — ``horizon-inject`` is
the single composer (the spec's acceptance test 36 bans a literal copy of the
injected strings in any adapter), and it deliberately does NOT import
``hermes_cli`` for composition (CLI-as-core, like every other harness).

Injection: ``register_system_prompt_section("horizon-line", <callable>)`` —
the persistent, every-turn mechanism. The callable receives the core's
read-only session-info mapping — ``types.MappingProxyType``, a ``Mapping`` but
NOT a ``dict`` (``plugins_dispatch.py:396``) — carrying ``session_id``,
``cwd``, ``profile_name``, ..., and returns
``horizon-inject --harness hermes --cwd <cwd>`` stdout, or
``""`` when nothing should be injected. The core renders the section once for
a new session, freezes it on the agent, and persists it verbatim; on resume
the stored bytes are recovered from the persisted prompt, so the horizon is
never duplicated. Caps: the section is registered with ``max_chars=4000`` (the
core's hard maximum); the worst-case block (5 gaps x 512 code points plus
boilerplate) renders at ~3.5k chars, and an oversized render is dropped by the
core rather than breaking the session (fail open).

Subagent exclusion: delegate_task children run the same conversation loop, so
the section must render nothing for them. The live session-info mapping exposes
only ``session_id``, ``model``, ``provider``, ``platform``, ``profile_name`` and
``cwd`` — it carries NO parent/depth discriminator, so the guard accepts every
convention the core might adopt (``parent_session_id``, ``is_subagent``,
``delegation_depth``, ``origin: "subagent"``) and adds an explicit
``HORIZON_SUBAGENT=1`` opt-out mirroring the pi adapter. None of those keys
arrive today, so the guard is best-effort and fails open, exactly like pi.

Working directory: ``cwd`` is the only selector, and it arrives as ``""`` when
``resolve_context_cwd()`` returns ``None`` (no ``terminal.cwd`` configured — the
local CLI's "relies on the launch dir" fallback lives in ``resolve_agent_cwd()``,
not in ``resolve_context_cwd()``). An empty cwd falls back to the process working
directory, so a session launched from a project root still receives that
project's horizon; if even the process cwd is unavailable, the section returns
nothing rather than raising.

Close: ``on_session_finalize`` (the real close hook: process exit, /new,
/reset — research/10, Hermes row) runs ``horizon session-end --harness hermes
--session <id>`` with no ``--summary``: the record carries ``summary: null``,
never a fabricated summary. Hooks fail open (D2): an unresolvable or failing
bin injects nothing, records nothing, and the session proceeds.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from collections.abc import Mapping

logger = logging.getLogger("horizon-line")

SECTION_ID = "horizon-line"
HARNESS = "hermes"
SPAWN_TIMEOUT_S = 15
# Explicit subagent opt-out, mirroring the pi adapter's HORIZON_SUBAGENT. The
# Hermes session-info mapping exposes no parent/depth discriminator today, so
# this env var is the one signal an embedder can always set.
SUBAGENT_ENV = "HORIZON_SUBAGENT"
_TRUTHY = ("1", "true", "yes", "on")

_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_BIN_DIR = os.path.normpath(os.path.join(_PLUGIN_DIR, "..", "..", "bin"))

# Tools worth scanning for /home/andre/git/<repo> references. Unknown tools
# (mcp_*, skill names, future additions) are ignored so a new tool's params
# can never smuggle a repo path into the injection stream.
_PARAM_TOOLS = frozenset({"terminal", "read_file", "write_file", "patch", "search_files", "execute_code"})

# Which string params count as path-bearing per tool. terminal's command is
# included (a command string is where ``git -C`` / ``cd`` sightings live):
# both its keys are scanned, nothing else is.
_PARAM_KEYS = {
    "terminal": ("command", "workdir"),
    "read_file": ("path",),
    "write_file": ("path", "content"),
    "patch": ("path", "old_string", "new_string"),
    "search_files": ("path", "pattern"),
    "execute_code": ("code",),
}

# The only repo roots matched, per the design: absolute ``/home/andre/git/``
# or its ``~/git/`` form. ``HORIZON_GIT_ROOT`` overrides the root for tests
# only (default is the fixed corpus; no production override exists by design).
def _git_root() -> str:
    root = os.environ.get("HORIZON_GIT_ROOT", "") or os.path.expanduser("~/git")
    return root if root.endswith("/") else root + "/"


# Path-like tokens inside a param string; _repo_root_of validates the prefix,
# so the tokenizer itself stays dumb (a token alone never triggers anything).
_CANDIDATE_RE = re.compile(r"~/[^\s\"'`]*|/[^\s\"'`]*")

# Per (session_id, repo) injection memory: a repo's block is injected once per
# session, on the first LLM call after its first tool-touch. The frozen section
# already covers launch-cwd repos on turn one, so first-turn touch of that same
# repo is excluded by the caller (see _pre_llm_call) rather than here.
_seen: dict[tuple[str, str], bool] = {}


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
        cwd = session_info.get("cwd")
        if not isinstance(cwd, str) or not cwd.strip():
            # The core hands "" when resolve_context_cwd() is None (no
            # terminal.cwd configured). Fall back to the process working
            # directory — the launch dir the CLI actually relies on — so a
            # session started in a project root still gets that horizon.
            try:
                cwd = os.getcwd()
            except OSError:
                return ""
        if not cwd:
            return ""
        try:
            status, stdout, _stderr = _spawn_bin("horizon-inject", ["--harness", HARNESS, "--cwd", cwd])
        except (FileNotFoundError, subprocess.SubprocessError, OSError):
            return ""  # fail open (D2): unresolvable bin injects nothing
        if status != 0:
            return ""
        return stdout if isinstance(stdout, str) else ""
    except Exception:  # noqa: BLE001 — the section must never break a session
        logger.warning("horizon-line section render failed", exc_info=True)
        return ""


async def _on_session_finalize(payload=None, **_ignored) -> None:
    """Close hook: append a session record with summary omitted (null).
    Swallows everything — finalize is teardown; nothing here may break it."""
    try:
        info = payload if isinstance(payload, dict) else {}
        session_id = info.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            return
        try:
            _spawn_bin("horizon", ["session-end", "--harness", HARNESS, "--session", session_id])
        except (FileNotFoundError, subprocess.SubprocessError, OSError):
            return  # fail open (D2)
    except Exception:  # noqa: BLE001
        logger.warning("horizon-line session finalize failed", exc_info=True)


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
# Highest assistant-tool_calls index already scanned per session (the delta
# cursor). A plain count works because conversation_history only ever grows
# within + across turns of one session; a new session_id starts at zero.
_scanned: dict[str, int] = {}

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

_TILDE_NOTE = "the ~/git/ form expands via os.path.expanduser (developer shells agree)"

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
            import json as _json

            args = _json.loads(args)
        except (ValueError, TypeError):
            return name if isinstance(name, str) else "", {}
    if not isinstance(name, str):
        return "", {}
    return name, args if isinstance(args, dict) else {}


def _first_turn_frozen_repo(is_first_turn: object, terminal_cwd: object) -> str | None:
    """The repo the frozen section already covers on turn one, if any.

    On is_first_turn the core resolves the session into its launch context
    (desktop setCwd / Kanban TERMINAL_CWD paths); when that resolves inside a
    repo the frozen section already carries it, so the per-turn hook must not
    duplicate for that same repo. Reads terminal_cwd (what the test passes)
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
    name a repo, no touched repo has a .horizon store (stat, never the nudge —
    param triggers stay silent without a store), or the (session, repo) pair
    already injected. Fail open everywhere: any spawn failure or timeout
    injects nothing. Must never raise — the core logs hook errors and runs
    without the context.
    """
    try:
        if isinstance(parent_session_id, str) and parent_session_id.strip():
            return {"context": ""}
        if not isinstance(session_id, str) or not session_id:
            return {"context": ""}
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
            if not os.path.isdir(os.path.join(repo, ".horizon")):
                continue  # no store: silence, never the nudge
            try:
                status, stdout, _stderr = _spawn_bin("horizon-inject", ["--harness", HARNESS, "--cwd", repo])
            except (FileNotFoundError, subprocess.SubprocessError, OSError):
                continue  # fail open (D2)
            if status != 0:
                continue
            if isinstance(stdout, str) and stdout.strip():
                blocks.append(stdout)
        return {"context": "\n\n".join(blocks)}
    except Exception:  # noqa: BLE001 — the hook must never break a turn
        logger.warning("horizon-line pre_llm_call failed", exc_info=True)
        return {"context": ""}


def register(ctx) -> None:
    """Plugin entry point: the persistent section plus the close hook."""
    ctx.register_system_prompt_section(SECTION_ID, _section_text, max_chars=4000)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("on_session_finalize", _on_session_finalize)
