"""horizon-line Hermes plugin.

Glue only: this plugin spawns the horizon bins and hands their stdout to the
core. It never composes the section-10 texts itself — ``horizon-inject`` is
the single composer (the spec's acceptance test 36 bans a literal copy of the
injected strings in any adapter), and it deliberately does NOT import
``hermes_cli`` for composition (CLI-as-core, like every other harness).

Injection: ``register_system_prompt_section("horizon-line", <callable>)`` —
the persistent, every-turn mechanism. The callable receives the core's
read-only session-info mapping (``session_id``, ``cwd``, ``profile_name``,
...) and returns ``horizon-inject --harness hermes --cwd <cwd>`` stdout, or
``""`` when nothing should be injected. The core renders the section once for
a new session, freezes it on the agent, and persists it verbatim; on resume
the stored bytes are recovered from the persisted prompt, so the horizon is
never duplicated. Caps: the section is registered with ``max_chars=4000`` (the
core's hard maximum); the worst-case block (5 gaps x 512 code points plus
boilerplate) renders at ~3.5k chars, and an oversized render is dropped by the
core rather than breaking the session (fail open).

Subagent exclusion: delegate_task children run the same conversation loop, and
the session-info mapping mirrors the ``pre_llm_call`` payload's
``parent_session_id`` convention (research/02 Part 1 §4). A child render sees
a non-empty ``parent_session_id`` and returns ``""`` — the parent already
carries the horizon; a child must not.

Close: ``on_session_finalize`` (the real close hook: process exit, /new,
/reset — research/10, Hermes row) runs ``horizon session-end --harness hermes
--session <id>`` with no ``--summary``: the record carries ``summary: null``,
never a fabricated summary. Hooks fail open (D2): an unresolvable or failing
bin injects nothing, records nothing, and the session proceeds.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess

logger = logging.getLogger("horizon-line")

SECTION_ID = "horizon-line"
HARNESS = "hermes"
SPAWN_TIMEOUT_S = 15

_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_BIN_DIR = os.path.normpath(os.path.join(_PLUGIN_DIR, "..", "..", "bin"))


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


def _section_text(session_info) -> str:
    """The system-prompt section callable. Returns the composed horizon block
    (or nudge) for top-level sessions with a cwd, "" for subagent sessions and
    whenever the bin is missing or fails. Must never raise: the core freezes a
    render-time failure as an absent section."""
    try:
        if not isinstance(session_info, dict):
            return ""
        # Subagent exclusion via the parent_session_id convention: a child
        # sees a non-empty parent session id.
        parent = session_info.get("parent_session_id")
        if isinstance(parent, str) and parent.strip():
            return ""
        cwd = session_info.get("cwd")
        if not isinstance(cwd, str) or not cwd:
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


def register(ctx) -> None:
    """Plugin entry point: the persistent section plus the close hook."""
    ctx.register_system_prompt_section(SECTION_ID, _section_text, max_chars=4000)
    ctx.register_hook("on_session_finalize", _on_session_finalize)
