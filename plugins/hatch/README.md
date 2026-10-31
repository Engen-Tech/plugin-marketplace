# hatch

hatch is an orchestration plugin for coding agents. It turns a problem into a plan of work items, builds each item in its own git worktree, checks each item against its own acceptance check, and merges the results onto one integration branch for a person to review. It never opens a pull request and never pushes.

This folder is the hatch plugin as published in the Engen Inc. plugin marketplace. It holds the skills, agents, hooks, the Pi extension, and the runtime manifests. Source and full documentation: https://github.com/Engen-Tech/hatch

## Before you install

- git 2.23 or newer.
- [uv](https://docs.astral.sh/uv/). The hooks and helper scripts run through `uv run --script`.
- Python 3.11 or newer, as `python3` on `PATH`.
- For Pi: Node `>=22.19.0`.

## Install

The marketplace lives at https://github.com/Engen-Tech/plugin-marketplace.git. In the commands below, `<marketplace>` is the name your tool reports when you add it.

### Claude Code

```
/plugin marketplace add https://github.com/Engen-Tech/plugin-marketplace.git
/plugin install hatch@<marketplace>
```

### GitHub Copilot CLI

```
copilot plugin marketplace add https://github.com/Engen-Tech/plugin-marketplace.git
copilot plugin install hatch@<marketplace>
```

### Codex CLI

Open `/plugins`, add https://github.com/Engen-Tech/plugin-marketplace.git as a marketplace source, then install hatch. Review and trust the bundled hooks in `/hooks`.

### Pi

```
pi install https://github.com/Engen-Tech/plugin-marketplace.git@<approved-ref>
```

Pi loads the hatch extension. Its tools serve, and its skills are discovered, only in a project you have trusted.

## License

hatch is proprietary software. Publication in this marketplace grants no license; see [LICENSE](LICENSE).

## Credits

Created by Tej Gandham. Copyright (c) 2026 Engen Inc. All rights reserved.

---

Hatch by Engen Inc. · engen.tech
