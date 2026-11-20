#!/usr/bin/env python3
"""Builder launcher: runs ``code-puppy`` (ACP mode) with a few editor-friendly tweaks.

Run with the *same Python that code-puppy is installed in* (the venv python), e.g.

    ~/.code-puppy-venv/bin/python builder_launcher.py --acp [--no-tools]

Why not just run ``code-puppy --acp``?  Because a few of code-puppy's process-wide
behaviours are right for a terminal but surprising for an editor:

1. ``set_model_name`` writes straight through to ``puppy.cfg``.  In an editor every
   chat has its own model dropdown; picking a model in one chat must not silently
   change the default model of your CLI.  We make it in-memory only (unless
   ``BUILDER_PERSIST_MODEL=1``).
2. ``/agent <name>`` persists the chosen agent in a per-terminal cache keyed by the
   parent PID.  All Builder agent processes share one parent (the extension host),
   so we make that cache a no-op, and ``BUILDER_AGENT`` pins the agent every
   Builder process starts with (independent of ``default_agent`` in ``puppy.cfg``).
3. For the Tab-autocomplete / inline-edit helper processes (``BUILDER_UTILITY=1``)
   we replace the large coding-agent system prompt with a tiny, deterministic one.
   Faster, cheaper, and the model stops trying to "be a puppy".

Everything is best-effort: if an internal API moved, we log to stderr and keep
going with stock behaviour.  Stdout is the JSON-RPC channel - never print there.
"""

from __future__ import annotations

import os
import sys


def _log(msg: str) -> None:
    sys.stderr.write(f"[builder-launcher] {msg}\n")
    sys.stderr.flush()


UTILITY_SYSTEM_PROMPT = (
    "You are a precise code-editing engine embedded in a text editor. "
    "You never chat, never greet, never explain, never use tools. "
    "You follow the output format requested in the user message exactly."
)


def _patch_model_persistence() -> None:
    if os.environ.get("BUILDER_PERSIST_MODEL") == "1":
        return
    try:
        import code_puppy.config as cfg

        def set_model_name(model: str) -> None:  # in-memory only
            cfg._SESSION_MODEL = model
            try:
                cfg.clear_model_cache()
            except Exception:  # noqa: BLE001
                pass

        cfg.set_model_name = set_model_name
        _log("model selection is in-memory only (puppy.cfg untouched)")
    except Exception as exc:  # noqa: BLE001
        _log(f"could not patch set_model_name: {exc!r}")


def _patch_agent_cache() -> None:
    try:
        import code_puppy.agents.agent_manager as am

        if hasattr(am, "_save_session_data"):
            am._save_session_data = lambda *_a, **_k: None
        if hasattr(am, "_load_session_data"):
            am._load_session_data = lambda *_a, **_k: {}
    except Exception as exc:  # noqa: BLE001
        _log(f"could not patch agent session cache: {exc!r}")


def _pin_agent() -> None:
    name = os.environ.get("BUILDER_AGENT", "").strip()
    if not name:
        return
    try:
        import code_puppy.config as cfg

        cfg.get_default_agent = lambda: name
        _log(f"agent pinned to {name!r}")
    except Exception as exc:  # noqa: BLE001
        _log(f"could not pin agent: {exc!r}")


def _patch_utility_prompt() -> None:
    if os.environ.get("BUILDER_UTILITY") != "1":
        return
    try:
        from code_puppy.agents.base_agent import BaseAgent

        BaseAgent.get_full_system_prompt = lambda self: UTILITY_SYSTEM_PROMPT  # type: ignore[assignment]
        _log("utility mode: minimal system prompt")
    except Exception as exc:  # noqa: BLE001
        _log(f"could not patch system prompt: {exc!r}")


def main() -> None:
    _patch_model_persistence()
    _patch_agent_cache()
    _pin_agent()
    _patch_utility_prompt()

    from code_puppy.main import main_entry

    sys.argv = ["code-puppy", *sys.argv[1:]]
    main_entry()


if __name__ == "__main__":
    main()
