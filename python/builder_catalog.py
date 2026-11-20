#!/usr/bin/env python3
"""Print the agents and models Code Puppy offers, as JSON on the LAST line of stdout.

Run with code-puppy's venv python.  Importing code_puppy is slow (10-30 s on some
machines), so the extension runs this once in the background and caches the result.
"""

from __future__ import annotations

import io
import json
import sys


def main() -> None:
    real_stdout = sys.stdout
    sys.stdout = io.StringIO()  # swallow any chatter from imports / discovery
    out: dict = {"agents": {}, "models": [], "defaultAgent": None, "defaultModel": None}
    try:
        from code_puppy.agents.agent_manager import (
            get_agent_descriptions,
            get_available_agents,
        )

        try:
            descriptions = get_agent_descriptions()
        except Exception:  # noqa: BLE001
            descriptions = {}
        for name, display in get_available_agents().items():
            out["agents"][name] = {
                "display": display,
                "description": descriptions.get(name, ""),
            }
    except Exception as exc:  # noqa: BLE001
        out["agentsError"] = repr(exc)

    try:
        from code_puppy.command_line.model_picker_completion import load_model_names
        from code_puppy.config import get_default_agent, get_global_model_name

        out["models"] = list(load_model_names() or [])
        out["defaultModel"] = get_global_model_name()
        out["defaultAgent"] = get_default_agent()
    except Exception as exc:  # noqa: BLE001
        out["modelsError"] = repr(exc)

    sys.stdout = real_stdout
    sys.stdout.write("\n" + json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
