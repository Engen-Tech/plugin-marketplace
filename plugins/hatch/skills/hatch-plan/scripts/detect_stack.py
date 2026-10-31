# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Detect a repo's stack from its manifests: dependency names + languages.

Zero dependencies (pure stdlib), so every invocation form behaves identically —
nothing has to be provisioned before it runs:
  python3 detect_stack.py <repo-root>        # print {"dependencies", "languages", "versions"}
  python3 detect_stack.py --self-test        # run embedded fixtures, exit 0/1
  uv run --script detect_stack.py <repo-root>  # also fine — no deps to install

Manifests read (repo root AND its sub-trees, to a bounded depth — so a monorepo
whose manifests live under backend/ or packages/<pkg>/ still matches its packs;
results across every scanned directory are unioned):
  package.json (dependencies + devDependencies), pyproject.toml (project.dependencies
  + tool.poetry.dependencies), requirements*.txt, go.mod (require module paths),
  Cargo.toml ([dependencies] keys), Gemfile (gem "name"), composer.json (require keys).
The walk prunes dependency/build/VCS noise (node_modules, dist, target, .git, …)
and hidden directories, and never follows symlinks. Languages derive
deterministically from which manifests exist: python (any python manifest),
javascript + node (package.json), go (go.mod), rust (Cargo.toml), ruby (Gemfile),
php (composer.json).

Stack-pack matching consumes this output: a pack applies when one of its match
tokens equals (case-insensitively) a detected dependency name or language.
`versions` never affects matching; it is the context a version-aware pack rule
reads (for example Angular's OnPush default from v22). It maps a dependency name
to the sorted distinct version specifiers the manifests DECLARE for it — ranges
as written (`^22.0.1`, `>=0.110`, `~> 7.1`), not a lockfile resolution — plus the
toolchain pins `go` (go.mod `go` directive) and `python` (requires-python or the
poetry `python` key). A dependency declared without a version has no entry;
several entries mean the monorepo declares it more than once.
Unparseable manifests warn on stderr and are skipped — the JSON on stdout stays valid.
"""
from __future__ import annotations
import argparse, json, re, sys, tomllib
from pathlib import Path

# Leading package-name token of a requirement spec: everything before any of
# ==, >=, <=, ~=, !=, [, ; (or any other non-name character).
_REQ_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_GEM_RE = re.compile(r"""^\s*gem\s+["']([^"']+)["']""")
# Each further positional string argument of a `gem` line is a version constraint.
_GEM_ARG_RE = re.compile(r"""\s*,\s*(["'])([^"']*)\1""")


def _req_name(spec: str) -> str | None:
    m = _REQ_NAME_RE.match(spec.strip())
    return m.group(0) if m else None


def _req_version(spec: str) -> str | None:
    """The version specifier of a PEP 508 requirement: the text after the name,
    minus extras and environment markers (`celery[redis]~=5.3 ; ...` -> `~=5.3`)."""
    spec = spec.strip()
    m = _REQ_NAME_RE.match(spec)
    if not m:
        return None
    rest = spec[m.end():].split(";", 1)[0].strip()
    if rest.startswith("["):
        rest = rest.partition("]")[2].strip()
    return rest or None


def _toml_version(value) -> str | None:
    """A Cargo/poetry dependency value: a bare version string or a table with `version`."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and isinstance(value.get("version"), str):
        return value["version"]
    return None


# Directories the walk never descends into: version control, dependency caches,
# and build output. Nothing under them is the repo's own declared stack, and a
# node_modules tree would otherwise flood the result with transitive manifests.
# Hidden directories (leading '.') are skipped too, whether or not listed here.
_SKIP_DIRS = frozenset({
    "node_modules", "vendor", "venv", "env", "__pycache__",
    "dist", "build", "target", "out", "coverage",
})
# Repo root is depth 0; the walk reads manifests down to this many levels, which
# covers the usual monorepo shapes (backend/, packages/<pkg>/, services/<svc>/)
# without wandering into deep source trees.
_MAX_DEPTH = 3


def _iter_dirs(root: Path, max_depth: int):
    """Yield `root` and every descendant directory to `max_depth` (breadth-first,
    directory names sorted for determinism), pruning the dependency/build/VCS
    noise in `_SKIP_DIRS`, hidden directories, and symlinks — so the walk can
    neither cycle through a link nor escape the tree."""
    queue: list[tuple[Path, int]] = [(root, 0)]
    while queue:
        d, depth = queue.pop(0)
        yield d
        if depth >= max_depth:
            continue
        try:
            children = sorted(p for p in d.iterdir() if p.is_dir())
        except OSError:
            continue
        for child in children:
            if (child.is_symlink() or child.name.startswith(".")
                    or child.name in _SKIP_DIRS):
                continue
            queue.append((child, depth + 1))


def _scan_dir(d: Path, root: Path, deps: set[str], langs: set[str],
              versions: dict[str, set[str]], warnings: list[str]) -> None:
    """Read every manifest directly in directory `d`, folding dependency names
    into `deps`, languages into `langs`, and declared version specifiers into
    `versions`. Warnings are labelled with the path
    relative to `root` so a monorepo's two package.json files stay distinct.
    Unparseable manifests warn and are skipped; valid output is never dropped."""

    def _label(path: Path) -> str:
        try:
            return str(path.relative_to(root))
        except ValueError:
            return path.name

    def load_json(path: Path) -> dict:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as e:
            warnings.append(f"{_label(path)}: skipped ({e})")
            return {}
        return data if isinstance(data, dict) else {}

    def load_toml(path: Path) -> dict:
        try:
            return tomllib.loads(path.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError, UnicodeDecodeError) as e:
            warnings.append(f"{_label(path)}: skipped ({e})")
            return {}

    def version(name: str, spec) -> None:
        if isinstance(spec, str) and spec.strip():
            versions.setdefault(name, set()).add(spec.strip())

    def read_lines(path: Path) -> list[str]:
        try:
            return path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError) as e:
            warnings.append(f"{_label(path)}: skipped ({e})")
            return []

    pj = d / "package.json"
    if pj.is_file():
        langs.update(("javascript", "node"))
        data = load_json(pj)
        for key in ("dependencies", "devDependencies"):
            section = data.get(key)
            if isinstance(section, dict):
                deps.update(section)
                for name, spec in section.items():
                    version(name, spec)

    pp = d / "pyproject.toml"
    if pp.is_file():
        langs.add("python")
        data = load_toml(pp)
        project = data.get("project") or {}
        version("python", project.get("requires-python"))
        for spec in project.get("dependencies") or []:
            if isinstance(spec, str) and (name := _req_name(spec)):
                deps.add(name)
                version(name, _req_version(spec))
        poetry = ((data.get("tool") or {}).get("poetry") or {}).get("dependencies") or {}
        if isinstance(poetry, dict):
            # tool.poetry.dependencies.python pins the interpreter, not a dependency
            for k, v in poetry.items():
                if k.lower() == "python":
                    version("python", _toml_version(v))
                else:
                    deps.add(k)
                    version(k, _toml_version(v))

    for req_file in sorted(d.glob("requirements*.txt")):
        langs.add("python")
        for line in read_lines(req_file):
            line = line.strip()
            if not line or line.startswith(("#", "-")):
                continue  # comments and pip options (-r, -e, --index-url, …)
            if name := _req_name(line):
                deps.add(name)
                version(name, _req_version(line))

    gm = d / "go.mod"
    if gm.is_file():
        langs.add("go")
        in_block = False
        for raw in read_lines(gm):
            line = raw.split("//", 1)[0].strip()
            if not line:
                continue
            if in_block:
                if line == ")":
                    in_block = False
                else:
                    parts = line.split()
                    deps.add(parts[0])
                    version(parts[0], parts[1] if len(parts) > 1 else None)
            elif line.startswith("require"):
                rest = line[len("require"):].strip()
                if rest == "(" or not rest:
                    in_block = True
                else:
                    parts = rest.split()
                    deps.add(parts[0])
                    version(parts[0], parts[1] if len(parts) > 1 else None)
            elif line.split()[0] == "go" and len(line.split()) > 1:
                version("go", line.split()[1])

    ct = d / "Cargo.toml"
    if ct.is_file():
        langs.add("rust")
        data = load_toml(ct)
        section = data.get("dependencies")
        if isinstance(section, dict):
            deps.update(section)
            for name, spec in section.items():
                version(name, _toml_version(spec))

    gf = d / "Gemfile"
    if gf.is_file():
        langs.add("ruby")
        for line in read_lines(gf):
            if m := _GEM_RE.match(line):
                deps.add(m.group(1))
                constraints, pos = [], m.end()
                while a := _GEM_ARG_RE.match(line, pos):
                    constraints.append(a.group(2))
                    pos = a.end()
                version(m.group(1), ", ".join(c for c in constraints if c) or None)

    cj = d / "composer.json"
    if cj.is_file():
        langs.add("php")
        data = load_json(cj)
        section = data.get("require")
        if isinstance(section, dict):
            deps.update(section)
            for name, spec in section.items():
                version(name, spec)


def detect(root: Path) -> tuple[dict, list[str]]:
    """Scan the repo root and its sub-trees (to `_MAX_DEPTH`) for manifests,
    unioning the results. Returns ({"dependencies", "languages", "versions"},
    warnings); the first two lists keep their original shape for existing consumers.
    Sub-tree scanning is what lets a monorepo whose manifests live under
    backend/ or packages/<pkg>/ match its stack packs."""
    deps: set[str] = set()
    langs: set[str] = set()
    versions: dict[str, set[str]] = {}
    warnings: list[str] = []
    for d in _iter_dirs(root, _MAX_DEPTH):
        _scan_dir(d, root, deps, langs, versions, warnings)
    return {"dependencies": sorted(deps), "languages": sorted(langs),
            "versions": {k: sorted(versions[k]) for k in sorted(versions)}}, warnings


# --- Self-test -----------------------------------------------------------------

def _run_self_test() -> int:
    import tempfile
    failures = 0

    def case(name: str, files: dict[str, str], want_deps: set[str], want_langs: set[str],
             want_warnings: int = 0, want_versions: dict | None = None) -> None:
        nonlocal failures
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            for rel, content in files.items():
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(content, encoding="utf-8")
            result, warnings = detect(root)
            ok = (set(result["dependencies"]) == want_deps
                  and set(result["languages"]) == want_langs
                  and result["dependencies"] == sorted(result["dependencies"])
                  and result["languages"] == sorted(result["languages"])
                  and len(warnings) == want_warnings
                  and (want_versions is None or result["versions"] == want_versions))
            print(f"[{'PASS' if ok else 'FAIL'}] {name}: {result}"
                  f"{' warnings=' + repr(warnings) if warnings else ''}")
            if not ok:
                failures += 1

    case("node app (deps + devDeps)",
         {"package.json": json.dumps({
             "dependencies": {"vue": "^3.4.0", "@vue/runtime-core": "^3.4.0"},
             "devDependencies": {"vite": "^5.0.0"}})},
         {"vue", "@vue/runtime-core", "vite"}, {"javascript", "node"})

    case("pyproject (PEP 621 + poetry, interpreter pin excluded)",
         {"pyproject.toml": (
             '[project]\nname = "x"\nversion = "0"\n'
             'dependencies = ["fastapi>=0.110", "uvicorn[standard]>=0.23", "pydantic==2.7.0"]\n'
             '[tool.poetry.dependencies]\npython = "^3.11"\nhttpx = "^0.27"\n')},
         {"fastapi", "uvicorn", "pydantic", "httpx"}, {"python"})

    case("requirements*.txt (comments, options, extras, markers)",
         {"requirements.txt": ("# pinned\nrequests==2.32.0\nflask>=3.0\ncelery[redis]~=5.3\n"
                               "-r requirements-dev.txt\ngunicorn ; python_version >= \"3.10\"\n"),
          "requirements-dev.txt": "pytest!=8.0.0\n"},
         {"requests", "flask", "celery", "gunicorn", "pytest"}, {"python"})

    case("go.mod (block + single require, // indirect)",
         {"go.mod": ("module example.com/app\n\ngo 1.22\n\n"
                     "require (\n\tgithub.com/gin-gonic/gin v1.9.1\n"
                     "\tgolang.org/x/sync v0.6.0 // indirect\n)\n\n"
                     "require gopkg.in/yaml.v3 v3.0.1\n")},
         {"github.com/gin-gonic/gin", "golang.org/x/sync", "gopkg.in/yaml.v3"}, {"go"})

    case("Cargo.toml ([dependencies] only, dev-dependencies excluded)",
         {"Cargo.toml": ('[package]\nname = "x"\nversion = "0.1.0"\n'
                         '[dependencies]\nserde = "1"\n'
                         'tokio = { version = "1", features = ["full"] }\n'
                         '[dev-dependencies]\ncriterion = "0.5"\n')},
         {"serde", "tokio"}, {"rust"})

    case("Gemfile (double and single quotes)",
         {"Gemfile": 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\ngem \'puma\'\n'},
         {"rails", "puma"}, {"ruby"})

    case("composer.json (require keys, as-is)",
         {"composer.json": json.dumps({"require": {"php": ">=8.2", "laravel/framework": "^11.0"}})},
         {"php", "laravel/framework"}, {"php"})

    case("polyglot repo unions manifests",
         {"package.json": json.dumps({"dependencies": {"react": "^18"}}),
          "requirements.txt": "django==5.0\n"},
         {"react", "django"}, {"javascript", "node", "python"})

    case("monorepo unions manifests across sub-trees",
         {"backend/pyproject.toml": ('[project]\nname = "x"\nversion = "0"\n'
                                     'dependencies = ["fastapi>=0.110"]\n'),
          "ui/package.json": json.dumps({"dependencies": {"vue": "^3.4.0"}})},
         {"fastapi", "vue"}, {"python", "javascript", "node"})

    case("skips dependency/build noise dirs",
         {"package.json": json.dumps({"dependencies": {"react": "^18"}}),
          "node_modules/leftpad/package.json": json.dumps({"dependencies": {"nope": "1"}}),
          "dist/package.json": json.dumps({"dependencies": {"built": "1"}})},
         {"react"}, {"javascript", "node"})

    case("skips hidden directories",
         {"pyproject.toml": '[project]\nname = "x"\nversion = "0"\ndependencies = ["real"]\n',
          ".cache/pyproject.toml": '[project]\nname = "y"\nversion = "0"\ndependencies = ["hidden"]\n'},
         {"real"}, {"python"})

    case("scans to the depth bound but no deeper",
         {"lvl3/a/b/package.json": json.dumps({"dependencies": {"found": "1"}}),
          "lvl4/a/b/c/package.json": json.dumps({"dependencies": {"toodeep": "1"}})},
         {"found"}, {"javascript", "node"})

    case("declared versions: every manifest kind, extras/markers stripped, toolchain pins",
         {"package.json": json.dumps({"dependencies": {"@angular/core": "^22.0.1"},
                                      "devDependencies": {"@angular/cli": "~22.0.0"}}),
          "pyproject.toml": ('[project]\nname = "x"\nversion = "0"\nrequires-python = ">=3.11"\n'
                             'dependencies = ["uvicorn[standard]>=0.23", "httpx"]\n'
                             '[tool.poetry.dependencies]\npydantic = { version = "^2.7" }\n'),
          "requirements.txt": "celery[redis]~=5.3 ; python_version >= '3.10'\n",
          "go.mod": "module m\n\ngo 1.22\n\nrequire gopkg.in/yaml.v3 v3.0.1\n",
          "Cargo.toml": '[dependencies]\nserde = "1"\nlocal = { path = "../l" }\n',
          "Gemfile": 'gem "rails", "~> 7.1", ">= 7.1.2"\ngem "puma"\n',
          "composer.json": json.dumps({"require": {"laravel/framework": "^11.0"}})},
         {"@angular/core", "@angular/cli", "uvicorn", "httpx", "pydantic", "celery",
          "gopkg.in/yaml.v3", "serde", "local", "rails", "puma", "laravel/framework"},
         {"javascript", "node", "python", "go", "rust", "ruby", "php"},
         want_versions={"@angular/cli": ["~22.0.0"], "@angular/core": ["^22.0.1"],
                        "celery": ["~=5.3"], "go": ["1.22"], "gopkg.in/yaml.v3": ["v3.0.1"],
                        "laravel/framework": ["^11.0"], "pydantic": ["^2.7"],
                        "python": [">=3.11"], "rails": ["~> 7.1, >= 7.1.2"], "serde": ["1"],
                        "uvicorn": [">=0.23"]})

    case("monorepo keeps each distinct declared specifier",
         {"a/package.json": json.dumps({"dependencies": {"vue": "^2.7.16"}}),
          "b/package.json": json.dumps({"dependencies": {"vue": "^3.4.0"}}),
          "c/package.json": json.dumps({"dependencies": {"vue": "^3.4.0"}})},
         {"vue"}, {"javascript", "node"}, want_versions={"vue": ["^2.7.16", "^3.4.0"]})

    case("empty repo", {}, set(), set(), want_versions={})

    case("malformed manifest warns, others still scanned",
         {"package.json": "{nope",
          "Gemfile": 'gem "sinatra"\n'},
         {"sinatra"}, {"javascript", "node", "ruby"}, want_warnings=1)

    print(f"\n{'all' if not failures else str(failures) + ' FAILED of'} self-test cases"
          f"{' passed' if not failures else ''}")
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", type=Path, metavar="repo-root")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return _run_self_test()
    if not args.root:
        ap.error("provide a repo root or --self-test")
    if not args.root.is_dir():
        print(f"error: '{args.root}' is not a directory", file=sys.stderr)
        return 1
    result, warnings = detect(args.root)
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
