---
name: python
description: Generic Python do's and don'ts
match: ["python"]
see_also: ["platform-native#python-standard-library"]
---
## Do
- Use type hints on every function signature.
- Load configuration through a settings object, not bare `os.environ` reads scattered in code.

## Don't
- Don't use mutable default arguments; don't use bare `except:`.
- Don't put secrets or environment-specific values in source; read them through settings.

## Review checklist
- [ ] py.1 — No bare `except:` and no mutable default arguments in changed code.
- [ ] py.2 — New config/secrets read through a settings object, not inline `os.environ`.
- [ ] py.3 — Changed public functions carry type hints on params and return.
- [ ] py.4 — No third-party wrapper for what the stdlib ships (`uuid`, `pathlib`, `zoneinfo`, `datetime.fromisoformat`) — name the stdlib equivalent (see platform-native).
