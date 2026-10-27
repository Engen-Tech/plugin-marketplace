"""`/steward-models apply` for pi (Phase 3 of docs/roadmap/pi-model-plan.md).

Compiles the USER model plan (``<agent-dir>/steward-delegation/model-plan.json``) into
pi-subagents user settings (``<agent-dir>/settings.json``) and writes the
pi-subagents profile file ``<agent-dir>/profiles/pi-subagents/steward.json``.
It never reads cwd, a project plan, project settings or allow/deny lists:
user settings apply in every repo, so per-repo pinning stays in the repo's
own ``.pi/settings.json``.

What it writes
--------------
Only ``subagents.agentOverrides["steward.<role>"].model`` and ``.thinking``,
and ``subagents.agentOverridesByProvider.<p>["steward.<role>"]`` (model,
thinking). Stale old-name steward keys (``STALE_KEYS``) move to the
role-only names, keeping every field of the old entry the new entry lacks.
Every other key, and other fields on steward entries such as ``machine``,
stay as they are. It never writes ``defaultModel``, ``modelThinkingLevels``,
``enabledModels``, ``modelScope``, ``maxThinking`` or the subagent
``config.json``.

Rules
-----
- A binding is the first available candidate of the role (bound model, then
  fallbacks): in the registry facts, with credentials, its provider not
  ``enabled: false`` in the plan. ``main`` becomes ``"inherit"``. Thinking is
  the candidate's ``:level`` when a fallback carries one, else the role's
  level as written (never clamped).
- ``byMainProvider.<p>`` compiles to ``agentOverridesByProvider.<p>``, with
  the same candidate order and the same rank rule as the check (a ``"*"``
  entry does not replace a role's own model or thinking).
- Apply sets only what the plan names. A role, field or provider entry the
  plan does not name is left as it is and reported (``leftover-override``,
  ``thinking-not-in-plan``). A role with no available candidate is left
  unchanged, with a ``no-available-candidate`` finding. Nothing that is not a
  steward key is ever removed.
- The one exception (0.12.0 release review, B1): for a role the plan names,
  ``agentOverridesByProvider.<p>["steward.<role>"]`` is removed for every
  provider the plan does not list for it (the provider object stays, ``{}``
  when emptied), and a provider entry with a model always carries thinking.
  pi-subagents lays provider entries over agentOverrides, so a stale one would
  beat the plan while the check reports drift.
- The profile leaves out entries pi-subagents' profile validator rejects
  (``profile-entry-skipped``), so it always loads.
- Refusals (``Refused``, nothing written): no user plan, a plan that is not
  JSON or has any schema error, settings that are not JSON (NaN, Infinity
  and overflowing numbers included) or have a
  ``subagents`` shape pi-subagents would reject, a file changed since the
  preview (``expect`` hashes of the plan, settings and profile) or between the first read and the write, or a
  settings lock held by another writer.

Writing
-------
Read, compute, then under pi's settings lock (``settings.json.lock``,
proper-lockfile) and pi-subagents' lease (``<real path>.write-lock``) re-read
and refuse on any change (sha256 of the bytes), back up once per changing
run to ``settings.json.bak-<YYYYMMDD-HHMMSS>``, write a temp file in the
same directory, fsync, rename over the real file (both temp files and both
backups are ready before the first rename; a failed profile rename after the
settings rename is a reported partial write, ``partial: true``) (a symlinked settings file
stays a symlink) and fsync the directory. Mode is kept. Formatting follows
the file: its indent unit (pi writes two spaces), its trailing newline
(pi writes none) and its key order. A run that changes nothing writes
nothing and makes no backup. The profile file gets the same temp-file and
rename, a backup when it exists and changes, and pi-subagents' own style
(``JSON.stringify(value, null, 2) + "\\n"``, PS/src/profiles/profiles.js:18-21).

Sources (pi 1.1.0, pi-subagents 0.83.0): pi settings writes,
PI/dist/core/settings-manager.js:126-171,450-471; pi-subagents profile
format and load, PS/src/profiles/profiles.js:39-71,359-386; leases,
PS/src/shared/file-lease.js and settings-file-lease.js.
"""

import copy
import datetime
import errno
import hashlib
import json
import os
import socket
import tempfile
import time
import uuid

import model_plan as mp

STALE_KEYS = mp.STALE_KEYS
ROLES = mp.ROLES
PROFILE_NAME = "steward"
# proper-lockfile's default stale time; a pi lock younger than this is live.
PI_LOCK_STALE_S = 10.0
DEFAULT_LOCK_WAIT_S = 1.0


class Refused(Exception):
    """apply wrote nothing, for the reason in the message."""


def content_hash(data):
    """sha256 of a file's bytes; None for a missing file."""
    if data is None:
        return None
    return hashlib.sha256(data).hexdigest()


def _read_bytes(path):
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise Refused("%s could not be read (%s)" % (path, exc.strerror or type(exc).__name__))


def _decode(data, path):
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused("%s is not UTF-8" % path)
    bom = text.startswith("\ufeff")
    return (text[1:] if bom else text), bom


def _style(text):
    """(indent unit, trailing newline) of a JSON file's text."""
    indent = "  "
    for line in text.splitlines()[1:]:
        stripped = line.lstrip(" \t")
        if stripped and len(stripped) < len(line):
            indent = line[: len(line) - len(stripped)]
            break
    return indent, text.endswith("\n")


def _dump(value, indent, newline, bom=False):
    # allow_nan=False: Infinity and NaN are not JSON, and pi could not read the file.
    text = json.dumps(value, indent=indent, ensure_ascii=False, allow_nan=False)
    return ("\ufeff" if bom else "") + text + ("\n" if newline else "")


# ---------------------------------------------------------------- inputs

def _clean_models(facts):
    if not isinstance(facts, dict) or not isinstance(facts.get("models"), list):
        raise ValueError("model_facts.models must be a list")
    findings = mp._Findings()
    models = mp._clean_models(facts["models"], findings)
    if not models:
        raise ValueError("model_facts.models has no usable entry")
    return models


def _read_user_plan(agent_dir):
    path = os.path.join(agent_dir, "steward-delegation", "model-plan.json")
    data = _read_bytes(path)
    if data is None:
        raise Refused("no user plan at %s; write one first (README \"Model plan on pi\")" % path)
    text, _ = _decode(data, path)
    try:
        parsed = _loads(text)
    except (ValueError, RecursionError) as exc:
        raise Refused("the user plan %s is not valid JSON (%s)" % (path, str(exc)[:200]))
    plan, found = mp.parse_plan(parsed, path, False)
    errors = [item for item in found if item["severity"] == "error"]
    if plan is None or errors:
        shown = "; ".join(item["message"] for item in errors[:3])
        more = " and %d more" % (len(errors) - 3) if len(errors) > 3 else ""
        raise Refused("the user plan %s has %d schema error(s): %s%s. Fix them (/steward-models check lists "
                      "them); nothing was written" % (path, len(errors), shown, more))
    return path, plan, data


class _NonFinite(ValueError):
    pass


def _finite_float(text):
    value = float(text)
    if value != value or value in (float("inf"), float("-inf")):
        raise _NonFinite("the number %s is out of range" % text[:40])
    return value


def _no_constant(name):
    raise _NonFinite("%s is not JSON" % name)


def _loads(text):
    """json.loads that refuses NaN, Infinity and numbers too large for a double."""
    return json.loads(text, parse_float=_finite_float, parse_constant=_no_constant)


def _read_settings(path):
    """(bytes, data, style). Refused when pi-subagents could not use the file."""
    raw = _read_bytes(path)
    if raw is None:
        return None, {}, ("  ", False, False)
    text, bom = _decode(raw, path)
    try:
        data = _loads(text) if text.strip() else {}
    except (ValueError, RecursionError) as exc:
        raise Refused("%s is not valid JSON (%s); nothing was written" % (path, str(exc)[:200]))
    if not isinstance(data, dict):
        raise Refused("%s must hold a JSON object; nothing was written" % path)
    sub = data.get("subagents")
    # null sections are valid for pi-subagents and mean "none"
    if sub is not None:
        if not isinstance(sub, dict):
            raise Refused("%s: subagents must be an object; nothing was written" % path)
        overrides = sub.get("agentOverrides")
        if overrides is not None:
            if not isinstance(overrides, dict):
                raise Refused("%s: subagents.agentOverrides must be an object; nothing was written" % path)
            for key, value in overrides.items():
                if not isinstance(value, dict):
                    raise Refused("%s: subagents.agentOverrides[%s] must be an object; nothing was written"
                                  % (path, json.dumps(key)))
        by_provider = sub.get("agentOverridesByProvider")
        if by_provider is not None:
            if not isinstance(by_provider, dict):
                raise Refused("%s: subagents.agentOverridesByProvider must be an object; nothing was written" % path)
            for prov, entries in by_provider.items():
                if not isinstance(entries, dict) or not all(isinstance(v, dict) for v in entries.values()):
                    raise Refused("%s: subagents.agentOverridesByProvider[%s] must be an object of objects; "
                                  "nothing was written" % (path, json.dumps(prov)))
    indent, newline = _style(text)
    return raw, data, (indent, newline, bom)


# ---------------------------------------------------------------- compile

def _availability(model, catalog, providers):
    """None when the candidate can bind, else why not."""
    provider = model.split("/", 1)[0]
    enabled = providers.get(provider, {}).get("enabled")
    if enabled and enabled[0] is False:
        return "its provider %s is disabled in the plan" % provider
    entry = catalog.get(model)
    if entry is None:
        return "it is not in pi's model catalog"
    if not entry["available"]:
        return "it has no configured credentials"
    return None


def _first_available(role, candidates, catalog, providers, findings, where):
    """(setting, level, fromFallback) of the first candidate that can bind, or None."""
    for ref, level, is_fallback in candidates:
        if ref["main"]:
            return "inherit", level, is_fallback
        why = _availability(ref["model"], catalog, providers)
        if why is None:
            return ref["model"], level, is_fallback
        findings.add("info", "candidate-skipped", role,
                     "%s: %s is skipped because %s." % (where, ref["model"], why))
    return None


def compile_plan(plan, plan_path, models):
    """Targets from the user plan: {role: {"overrides": {field: value},
    "byProvider": {p: {field: value}}, "named": bool}} plus findings."""
    findings = mp._Findings()
    merged = mp.merge_plans(plan, plan_path, None, None)
    catalog = {"%s/%s" % (m["provider"], m["id"]): m for m in models}
    providers = merged["providers"]
    targets = {}
    for role in ROLES:
        fields = merged["roles"].get(role) or {}

        def value(key):
            item = fields.get(key)
            return item[0] if item else None

        def rank(key):
            item = fields.get(key)
            return item[2] if item else -1

        model_ref, thinking, fallback = value("model"), value("thinking"), value("fallback") or []
        target = {"overrides": {}, "byProvider": {}, "byProviderDrop": {}, "byProviderKeep": set(),
                  "unchanged": False}

        def candidates(first, level):
            out = [(first, level, False)] if first else []
            out.extend((ref, ref["thinking"] or level, True) for ref in fallback)
            return out

        base = candidates(model_ref, thinking)
        if base:
            bound = _first_available(role, base, catalog, providers, findings, "steward.%s" % role)
            if bound is None:
                target["unchanged"] = True
                findings.add("warn", "no-available-candidate", role,
                             "No candidate for steward.%s is available (bound model and every fallback skipped); "
                             "its settings are left unchanged." % role)
            else:
                setting, level, _ = bound
                target["overrides"]["model"] = setting
                if level is not None:
                    target["overrides"]["thinking"] = level
        elif thinking is not None:
            target["overrides"]["thinking"] = thinking

        by_main = fields.get("byMainProvider", (None, None, None))[0] or {}
        for prov, sub in by_main.items():
            entry = {}
            sub_model = sub.get("model")
            sub_thinking = sub.get("thinking")
            use_model = sub_model is not None and sub_model[0] is not None and sub_model[2] >= rank("model")
            use_thinking = (sub_thinking is not None and sub_thinking[0] is not None
                            and sub_thinking[2] >= rank("thinking"))
            level = sub_thinking[0] if use_thinking else None
            if use_model:
                where = "steward.%s with the main thread on %s" % (role, prov)
                bound = _first_available(role, candidates(sub_model[0], level), catalog, providers, findings, where)
                if bound is None:
                    findings.add("warn", "no-available-candidate", role,
                                 "No candidate for %s is available; agentOverridesByProvider.%s is left unchanged."
                                 % (where, prov))
                    target["byProviderKeep"].add(prov)
                    continue
                setting, bound_level, _ = bound
                entry["model"] = setting
                # Always carry thinking: pi-subagents lays a byProvider entry over
                # agentOverrides, so a stale level here would win over the plan's.
                if bound_level is None:
                    bound_level = thinking
                if bound_level is not None:
                    entry["thinking"] = bound_level
            elif use_thinking:
                # The level of the candidate that is bound, as the check takes it:
                # a fallback with its own :level keeps that level.
                where = "steward.%s with the main thread on %s" % (role, prov)
                found = (_first_available(role, candidates(model_ref, level), catalog, providers,
                                          mp._Findings(), where) if base else None)
                entry["thinking"] = found[1] if found is not None and found[1] is not None else level
                if "model" in target["overrides"]:
                    # The role's own model applies on this provider; a stale byProvider model would beat it.
                    target["byProviderDrop"][prov] = ["model"]
            if entry:
                target["byProvider"][prov] = entry
        target["named"] = bool(target["overrides"] or target["byProvider"] or target["unchanged"])
        targets[role] = target
    return targets, findings


def _rename_key(mapping, old, new):
    """Rename a key in place, keeping its position."""
    items = [(new if key == old else key, value) for key, value in mapping.items()]
    mapping.clear()
    mapping.update(items)


def _migrate(entries, where, changes, findings):
    for old in [key for key in entries if key in STALE_KEYS]:
        new = "steward." + STALE_KEYS[old]
        if new not in entries:
            _rename_key(entries, old, new)
            changes.append("%s: moved \"%s\" to \"%s\"" % (where, old, new))
            continue
        moved = [field for field in entries[old] if field not in entries[new]]
        for field in moved:
            entries[new][field] = entries[old][field]
        del entries[old]
        changes.append("%s: merged \"%s\" into \"%s\"%s" % (
            where, old, new, " (%s)" % ", ".join(moved) if moved else " (no field moved)"))
        findings.add("info", "stale-key-merged", STALE_KEYS[old],
                     "%s: \"%s\" and \"%s\" both existed; the new key's fields were kept and the old key removed."
                     % (where, old, new))


def _show(value):
    return "(unset)" if value is None else json.dumps(value)


def build_settings(data, targets, findings):
    """(new settings data, change lines). data is not modified."""
    new = copy.deepcopy(data)
    changes = []
    sub = new.get("subagents") if isinstance(new.get("subagents"), dict) else None

    if sub is not None:
        if isinstance(sub.get("agentOverrides"), dict):
            _migrate(sub["agentOverrides"], "agentOverrides", changes, findings)
        for prov, entries in (sub.get("agentOverridesByProvider") or {}).items():
            _migrate(entries, "agentOverridesByProvider.%s" % prov, changes, findings)

    def section(*keys):
        nonlocal sub
        if sub is None:
            sub = new["subagents"] = {}
        node = sub
        for key in keys:
            if not isinstance(node.get(key), dict):
                node[key] = {}  # absent or null: pi-subagents reads null as none
            node = node[key]
        return node

    for role in ROLES:
        key = "steward." + role
        target = targets[role]
        if target["overrides"]:
            overrides = section("agentOverrides")
            entry = overrides.setdefault(key, {})
            for field, value in target["overrides"].items():
                if entry.get(field) != value:
                    changes.append("%s %s: %s -> %s" % (key, field, _show(entry.get(field)), _show(value)))
                    entry[field] = value
            if "thinking" not in target["overrides"] and "thinking" in entry:
                findings.add("info", "thinking-not-in-plan", role,
                             "%s keeps thinking %s: the plan names no thinking level for it." % (key, _show(entry["thinking"])))
        for prov, fields in target["byProvider"].items():
            entry = section("agentOverridesByProvider", prov).setdefault(key, {})
            for field, value in fields.items():
                if entry.get(field) != value:
                    changes.append("agentOverridesByProvider.%s %s %s: %s -> %s"
                                   % (prov, key, field, _show(entry.get(field)), _show(value)))
                    entry[field] = value
            for field in target["byProviderDrop"].get(prov, ()):
                if field in entry:
                    changes.append("agentOverridesByProvider.%s %s %s: %s -> (unset)"
                                   % (prov, key, field, _show(entry[field])))
                    del entry[field]

        current = sub or {}
        existing = (current.get("agentOverrides") or {}).get(key) or {}
        if not target["named"] and ("model" in existing or "thinking" in existing):
            findings.add("info", "leftover-override", role,
                         "%s is not in the plan; its settings (%s) are left as they are." % (
                             key, ", ".join("%s %s" % (f, _show(existing[f])) for f in ("model", "thinking") if f in existing)))
        for prov, entries in (current.get("agentOverridesByProvider") or {}).items():
            if key not in entries or prov in target["byProvider"] or prov in target["byProviderKeep"]:
                continue
            if target["unchanged"]:
                continue  # no available candidate: the role's settings are left unchanged
            if target["named"]:
                # The one exception to the leftover rule: for a role the plan
                # names, model and thinking in a byProvider entry for a
                # provider the plan does not list would override the plan's
                # binding there. Only those two fields go; every other field
                # stays. An emptied entry is removed; the provider object
                # stays, as {} when nothing else is in it.
                entry = entries[key]
                if not isinstance(entry, dict):
                    continue
                popped = {f: entry.pop(f) for f in ("model", "thinking") if f in entry}
                if not popped:
                    continue
                if not entry:
                    del entries[key]
                changes.append("agentOverridesByProvider.%s %s: removed %s; the plan lists no binding for "
                               "this provider" % (prov, key, ", ".join(
                                   "%s %s" % (f, json.dumps(v, ensure_ascii=False)) for f, v in popped.items())))
            else:
                findings.add("info", "leftover-override", role,
                             "agentOverridesByProvider.%s %s is not in the plan; it is left as it is." % (prov, key))
    return new, changes


def profile_entry_problem(value):
    """Why pi-subagents 0.83.0 would reject this agentOverrides entry in a
    profile, or None. Mirrors validateSubagentProfile and
    validateOptionalMachine (PS/src/profiles/profiles.js:39-65,
    PS/src/agents/agents.js:752-763); settings accept more (model: false)."""
    if not isinstance(value, dict):
        return "expected an object"
    model = value.get("model")
    if "model" in value and not isinstance(model, str):
        return "model must be a string in a profile (settings allow %s)" % _show(model)
    thinking = value.get("thinking")
    if "thinking" in value and thinking is not False and not isinstance(thinking, str):
        return "thinking must be a string or false"
    machine = value.get("machine", False)
    if machine is not False:
        if not isinstance(machine, str) or not machine.strip():
            return "machine must be a non-empty string or false"
        trimmed = machine.strip()
        if len(trimmed) > 128:
            return "machine must be 128 characters or fewer"
        if any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in trimmed):
            return "machine contains control characters"
    if "fallbackModels" in value:
        return "fallbackModels was removed from pi-subagents"
    return None


def build_profile(settings, findings=None):
    """pi-subagents profile data carrying the whole mapping after apply.
    An entry pi-subagents' profile validator would reject is left out (with
    a warn finding), so the profile always loads."""
    sub = settings.get("subagents") if isinstance(settings.get("subagents"), dict) else {}
    overrides = {}
    for name, value in (sub.get("agentOverrides") or {}).items():
        problem = profile_entry_problem(value)
        if problem is None:
            overrides[name] = copy.deepcopy(value)
        elif findings is not None:
            role = name[len("steward."):] if name.startswith("steward.") else None
            findings.add("warn", "profile-entry-skipped", role if role in ROLES else None,
                         "agentOverrides[%s] is left out of the steward profile: %s. pi-subagents would refuse to "
                         "load the profile with it; settings keep it, but loading the steward profile drops it."
                         % (json.dumps(name, ensure_ascii=False), problem))
    # Always written, even empty: loading the profile then clears byProvider
    # entries another profile added.
    out = {"agentOverrides": overrides,
           "agentOverridesByProvider": copy.deepcopy(sub.get("agentOverridesByProvider") or {})}
    return {"subagents": out}


# ---------------------------------------------------------------- writing

def _proc_start(pid):
    """/proc/<pid>/stat start time, as pi-subagents records it (file-lease.js:9-17)."""
    try:
        with open("/proc/%d/stat" % pid, "r") as handle:
            raw = handle.read()
        return raw[raw.rindex(")") + 1:].split()[19]
    except (OSError, ValueError, IndexError):
        return None


def _read_owner(path):
    """A lease's owner.json as pi-subagents validates it (file-lease.js:18-27), or None."""
    try:
        with open(os.path.join(path, "owner.json"), "r", encoding="utf-8") as handle:
            owner = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(owner, dict):
        return None
    token, pid = owner.get("token"), owner.get("pid")
    if not isinstance(token, str) or not token or len(token) > 64 \
            or not all(ch.isascii() and (ch.isalnum() or ch == "-") for ch in token):
        return None
    if not isinstance(owner.get("hostname"), str) or isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    return owner


def _dead_owner(owner):
    """pi-subagents' rule (file-lease.js:29-40): same host and the pid is gone
    or now belongs to another process."""
    if owner["hostname"] != socket.gethostname():
        return False
    try:
        os.kill(owner["pid"], 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    current = _proc_start(owner["pid"])
    return owner.get("processStart") is not None and current is not None and owner["processStart"] != current


class _Locks:
    """pi's proper-lockfile lock and pi-subagents' settings lease, both
    mkdir-based. A lock another live process holds is never removed. Stale
    locks follow their owners' rules: pi's lock is stale when its mtime is
    older than PI_LOCK_STALE_S (proper-lockfile), the lease when its owner is
    a dead process on this host (it is moved aside as pi-subagents does)."""

    def _reclaim(self, path, owner):
        """True when a stale lock at path was cleared and the take can retry."""
        if not owner:
            try:
                age = time.time() - os.stat(path).st_mtime
            except FileNotFoundError:
                return True
            except OSError:
                return False
            if age <= PI_LOCK_STALE_S:
                return False
            try:
                os.rmdir(path)
            except FileNotFoundError:
                pass
            except OSError:
                return False
            return True
        previous = _read_owner(path)
        if previous is None or not _dead_owner(previous):
            return False
        retired = "%s.retired-%s" % (path, previous["token"])
        try:
            os.rename(path, retired)
        except FileNotFoundError:
            return True
        except OSError:
            return False
        # pi-subagents 0.83.0 src/shared/file-lease.js:64-65: the moved lease
        # must still be the dead owner's; otherwise a live holder's lease was
        # moved in between the read and the rename.
        moved = _read_owner(retired)
        if moved is None or moved.get("token") != previous["token"]:
            raise Refused("the settings lock owner changed during recovery of %s; run /steward-models apply "
                          "again (nothing was written)" % path)
        return True

    def __init__(self, settings_path, wait):
        self.pi_lock = os.path.abspath(settings_path) + ".lock"
        real = os.path.realpath(settings_path)
        self.lease = real + ".write-lock"
        self.wait = wait
        self.held = []
        self.token = str(uuid.uuid4())

    def _take(self, path, owner):
        deadline = time.monotonic() + self.wait
        while True:
            try:
                os.mkdir(path, 0o700)
            except FileExistsError:
                if self._reclaim(path, owner):
                    continue
                if time.monotonic() >= deadline:
                    if owner and _read_owner(path) is None:
                        raise Refused("the settings lock %s has no readable owner, so pi-subagents never clears it; "
                                      "if no pi is writing settings, remove %s and run /steward-models apply again "
                                      "(nothing was written)" % (path, path))
                    raise Refused("another process holds the settings lock %s; try again in a moment "
                                  "(nothing was written)" % path)
                time.sleep(0.02)
                continue
            if owner:
                body = json.dumps({"token": self.token, "pid": os.getpid(), "hostname": socket.gethostname(),
                                   "processStart": _proc_start(os.getpid())})
                owner_file = os.path.join(path, "owner.json")
                try:
                    fd = os.open(owner_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "w") as handle:
                        handle.write(body)
                except BaseException as exc:
                    # An ownerless lease is never evicted by pi-subagents: remove it.
                    for cleanup in (lambda: os.unlink(owner_file), lambda: os.rmdir(path)):
                        try:
                            cleanup()
                        except OSError:
                            pass
                    if isinstance(exc, OSError):
                        raise Refused("could not take the settings lock %s (%s); nothing was written"
                                      % (path, exc.strerror or type(exc).__name__))
                    raise
            self.held.append(path)
            return

    def __enter__(self):
        try:
            self._take(self.pi_lock, False)
            self._take(self.lease, True)
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def __exit__(self, *exc):
        for path in reversed(self.held):
            try:
                owner = os.path.join(path, "owner.json")
                if os.path.exists(owner):
                    with open(owner, "r") as handle:
                        if json.load(handle).get("token") != self.token:
                            continue
                    os.unlink(owner)
                os.rmdir(path)
            except (OSError, ValueError):
                pass
        self.held = []
        return False


def _fsync_dir(path):
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _backup(path, data, mode, now):
    stamp = now.strftime("%Y%m%d-%H%M%S")
    base = "%s.bak-%s" % (path, stamp)
    candidate, n = base, 1
    while True:
        try:
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
            break
        except FileExistsError:
            n += 1
            candidate = "%s-%d" % (base, n)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(candidate, mode)
    except BaseException:
        try:
            os.unlink(candidate)  # no partial backup left behind
        except OSError:
            pass
        raise
    return candidate


def _default_mode():
    umask = os.umask(0)
    os.umask(umask)
    return 0o666 & ~umask


def _prepare_write(path, text):
    """Temp file beside the real file, written and fsynced, with the real
    file's mode and owner. Returns (temp path, rename target); the caller
    renames with _commit_write or removes the temp file with _discard."""
    target = os.path.realpath(path)
    directory = os.path.dirname(target)
    os.makedirs(directory, exist_ok=True)
    try:
        st = os.stat(target)
        mode, owner = st.st_mode & 0o7777, (st.st_uid, st.st_gid)
    except FileNotFoundError:
        mode, owner = _default_mode(), None
    data = text.encode("utf-8")
    fd, tmp = tempfile.mkstemp(dir=directory, prefix="." + os.path.basename(target) + ".steward-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        if owner is not None:
            try:
                os.chown(tmp, *owner)
            except OSError:
                pass
    except BaseException:
        _discard(tmp)
        raise
    return tmp, target


def _commit_write(prepared):
    tmp, target = prepared
    try:
        os.replace(tmp, target)
    except BaseException:
        _discard(tmp)
        raise
    _fsync_dir(os.path.dirname(target))


def _discard(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def _mode_of(path):
    try:
        return os.stat(path).st_mode & 0o7777
    except OSError:
        return 0o600


# ---------------------------------------------------------------- entry

def apply(facts, env=None, dry_run=True, expect=None, now=None, before_write=None,
          lock_wait=DEFAULT_LOCK_WAIT_S):
    """Compile the user plan and, unless dry_run, write it. Returns a
    JSON-safe result; raises Refused (nothing written) or ValueError (bad
    facts). `expect` is the `hashes` of an earlier dry run: the files must
    still match it. `before_write` is a test hook run after the first read."""
    env = dict(os.environ if env is None else env)
    models = _clean_models(facts)
    agent_dir = mp.agent_dir_from_env(env)
    plan_path, plan, plan_raw = _read_user_plan(agent_dir)
    settings_path = os.path.join(agent_dir, "settings.json")
    profile_path = os.path.join(agent_dir, "profiles", "pi-subagents", PROFILE_NAME + ".json")

    settings_raw, settings, (indent, newline, bom) = _read_settings(settings_path)
    profile_raw = _read_bytes(profile_path)
    # The plan is hashed too: the confirmed write must compile the plan the preview showed.
    hashes = {"settings": content_hash(settings_raw), "profile": content_hash(profile_raw),
              "plan": content_hash(plan_raw)}
    if expect is not None:
        for key, path in (("plan", plan_path), ("settings", settings_path), ("profile", profile_path)):
            if key in expect and expect[key] != hashes[key]:
                raise Refused("%s changed since the preview; run /steward-models apply again (nothing was written)" % path)

    targets, findings = compile_plan(plan, plan_path, models)
    new_settings, changes = build_settings(settings, targets, findings)
    settings_changed = new_settings != settings
    settings_text = _dump(new_settings, indent, newline, bom) if settings_changed else None

    profile_text = _dump(build_profile(new_settings, findings), 2, True)
    profile_changed = profile_raw is None or profile_raw.decode("utf-8", "replace") != profile_text
    if profile_changed:
        changes.append("profile %s: %s" % (profile_path, "create" if profile_raw is None else "update"))

    result = {
        "dryRun": bool(dry_run), "changed": settings_changed or profile_changed,
        "settingsChanged": settings_changed, "profileChanged": profile_changed,
        "planFile": plan_path, "settingsFile": settings_path, "profileFile": profile_path,
        "changes": changes, "findings": findings.items, "backups": [], "hashes": hashes,
        "newSettings": new_settings, "partial": False, "planWarnings": [],
    }
    if dry_run:
        # Per-model warnings for plan bindings that do not launch yet: the
        # session block leaves them out, so the preview shows them.
        result["planWarnings"] = mp.evaluate(facts, env=env).get("planWarnings") or []
    if dry_run or not result["changed"]:
        result["report"] = render(result)
        return result

    now = now or datetime.datetime.now()
    if before_write:
        before_write()
    # Everything happens inside both locks. Backups and both temp files are
    # ready before the first rename, so a failure up to there writes nothing.
    with _Locks(settings_path, lock_wait):
        if content_hash(_read_bytes(settings_path)) != hashes["settings"]:
            raise Refused("%s changed while apply was running; run /steward-models apply again "
                          "(nothing was written)" % settings_path)
        if content_hash(_read_bytes(profile_path)) != hashes["profile"]:
            raise Refused("%s changed while apply was running; run /steward-models apply again "
                          "(nothing was written)" % profile_path)
        prepared = []
        try:
            if settings_changed and settings_raw is not None:
                result["backups"].append(_backup(settings_path, settings_raw, _mode_of(settings_path), now))
            if profile_changed and profile_raw is not None:
                result["backups"].append(_backup(profile_path, profile_raw, _mode_of(profile_path), now))
            if settings_changed:
                prepared.append(("settings", _prepare_write(settings_path, settings_text)))
            if profile_changed:
                prepared.append(("profile", _prepare_write(profile_path, profile_text)))
        except (OSError, UnicodeError) as exc:
            for _, (tmp, _target) in prepared:
                _discard(tmp)
            for path in result["backups"]:
                _discard(path)
            reason = exc.strerror if isinstance(exc, OSError) and exc.strerror else type(exc).__name__
            raise Refused("could not prepare the write (%s); nothing was written" % reason)
        for index, (which, item) in enumerate(prepared):
            try:
                _commit_write(item)
            except OSError as exc:
                for _, (tmp, _target) in prepared[index + 1:]:
                    _discard(tmp)
                if index == 0:
                    for path in result["backups"]:
                        _discard(path)
                    result["backups"] = []
                    raise Refused("could not write %s (%s); nothing was written"
                                  % (item[1], exc.strerror or type(exc).__name__))
                # Settings are written, the profile is not: report it, do not hide it.
                result["partial"] = True
                result["partialError"] = "%s was not written (%s)" % (
                    profile_path, exc.strerror or type(exc).__name__)
    result["report"] = render(result)
    return result


def render(result):
    """Plain-text summary for the /steward-models apply preview and result."""
    if not result["changed"]:
        head = "steward model plan apply: nothing to change"
    elif result.get("partial"):
        head = "steward model plan apply: PARTLY written (settings yes, steward profile no)"
    elif result["dryRun"]:
        head = "steward model plan apply: preview (nothing written yet)"
    else:
        head = "steward model plan apply: written"
    lines = [head, "", "Plan: %s" % result["planFile"],
             "Settings: %s%s" % (result["settingsFile"], "" if result["settingsChanged"] else " (no change)"),
             "Profile: %s%s" % (result["profileFile"], "" if result["profileChanged"] else " (no change)")]
    if result["changes"]:
        lines += ["", "Changes:"] + ["- %s" % line for line in result["changes"]]
    elif any(f["severity"] in ("error", "warn") for f in result["findings"]):
        lines += ["", "Nothing to write, but the plan is not fully applied: see the findings below."]
    else:
        lines += ["", "Settings and the steward profile already match the plan."]
    if result.get("partial"):
        undo = {0: "", 1: " Restore from the backup below to undo."}.get(
            len(result["backups"]), " Restore from the backups below to undo.")
        lines += ["", "The settings were written, but %s. Settings now follow the plan; the steward profile does "
                  "not, so do not run /subagents-load-profile steward until /steward-models apply has run again.%s"
                  % (result["partialError"], undo)]
    if result["backups"]:
        lines += ["", "Backups:"] + ["- %s" % path for path in result["backups"]]
    shown = [f for f in result["findings"] if f["severity"] in ("error", "warn")]
    notes = [f for f in result["findings"] if f["severity"] == "info"]
    if shown or notes:
        lines += ["", "Findings:"]
        lines += ["- %s %s: %s" % (f["severity"], f["code"], f["message"]) for f in shown + notes]
    if result.get("planWarnings"):
        lines += ["", "Plan binding warnings:"]
        lines += ["- %s %s (steward.%s): %s" % (f["severity"], f["code"], f["role"], f["message"])
                  for f in result["planWarnings"]]
    return "\n".join(lines)
