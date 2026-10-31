---
name: python-fastapi
description: Pydantic + FastAPI do's and don'ts
match: ["fastapi", "pydantic"]
see_also: ["python", "platform-native#database"]
---
## Do
- Define request and response bodies as Pydantic models; set `response_model` on routes.
- Type every route signature; let FastAPI derive validation from the hints.
- Use dependency injection (`Depends`) for shared resources (DB sessions, auth, settings).
- Use `async def` for I/O-bound path operations; keep blocking work off the event loop.
- Load configuration through `pydantic-settings` (`BaseSettings`; on Pydantic v1, `pydantic.BaseSettings`) — the settings object the python pack calls for.
- Raise `HTTPException` (or a registered exception handler) for error responses; return typed models for success.

## Don't
- Don't return raw `dict`s from routes when a response model fits; don't leak ORM models directly as response bodies.
- Don't do blocking I/O (sync DB driver, `requests`, `time.sleep`) inside an `async def` route.
- Don't disable Pydantic validation to make a check pass.

## Patterns
- Routers per resource (`APIRouter`), included into the app; keep `main.py` thin.
- A service/repository layer between routes and the data store; routes stay declarative.
- On Pydantic v2, its idioms: `model_config`, `field_validator`, `model_validator`; `ConfigDict` over class-based `Config`.

## Review checklist
- [ ] fapi.1 — Every changed route declares request/response types (Pydantic model or explicit `response_model`).
- [ ] fapi.2 — No blocking I/O inside an `async def` route.
