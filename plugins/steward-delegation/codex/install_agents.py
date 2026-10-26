#!/usr/bin/env python3
"""Install optional standalone Codex agents from the canonical role table."""
import argparse
import json
import os
from pathlib import Path


def render_agents():
    profiles = json.loads((Path(__file__).parent / "skills/delegating/profiles.json").read_text())
    return {
        f"steward-{role}.toml": "\n".join(
            f"{key} = {json.dumps(value, ensure_ascii=False)}"
            for key, value in {
                "name": f"steward-{role}",
                "description": profile["description"],
                "model": profile["model"],
                "model_reasoning_effort": profile["reasoning_effort"],
                "developer_instructions": profile["instructions"],
            }.items()
        ) + "\n"
        for role, profile in profiles.items()
    }


def install(destination):
    files = render_agents()
    # Check every collision before writing anything. Keep local edits intact.
    for name, text in files.items():
        path = destination / name
        if path.exists() and path.read_text() != text:
            raise ValueError(f"Existing agent differs: {path}. Move it aside before reinstalling.")
    destination.mkdir(parents=True, exist_ok=True)
    for name, text in files.items():
        path = destination / name
        if not path.exists():
            with path.open("x", encoding="utf-8") as output:
                output.write(text)
    return len(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path,
                        default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "agents")
    args = parser.parse_args()
    try:
        count = install(args.destination)
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    print(f"Installed {count} Steward agents in {args.destination}")


if __name__ == "__main__":
    main()
