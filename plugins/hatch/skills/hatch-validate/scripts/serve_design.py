#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
from __future__ import annotations

import argparse
import contextlib
import functools
import http.server
import json
import subprocess
import tempfile
import threading
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import urlopen


def iter_html_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*.html"):
        try:
            depth = len(path.relative_to(root).parts)
        except ValueError:
            continue
        if depth <= 2 and "print" not in path.name.lower():
            files.append(path)
    return sorted(files, key=lambda p: str(p).lower())


def resolve_design_file(design_path: Path) -> Path:
    path = design_path.expanduser().resolve()
    if path.is_file():
        if path.suffix.lower() != ".html":
            raise SystemExit(f"Design path is not an HTML file: {path}")
        return path
    if not path.is_dir():
        raise SystemExit(f"Design path does not exist: {path}")

    html_files = iter_html_files(path)
    standalone = [p for p in html_files if "standalone" in p.name.lower()]
    candidates = standalone or html_files
    if not candidates:
        raise SystemExit(f"No design HTML files found at {path}")
    return candidates[0]


def _git_toplevel(start: Path) -> Path | None:
    """The Git worktree root enclosing `start`, or None when it is not in a repo."""
    try:
        result = subprocess.run(
            ["git", "-C", str(start), "rev-parse", "--show-toplevel"],
            text=True,
            capture_output=True,
            timeout=10,
         encoding="utf-8")
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    top = result.stdout.strip()
    return Path(top).resolve() if top else None


def _contains(ancestor: Path, descendant: Path) -> bool:
    """True when `descendant` is `ancestor` itself or nested under it."""
    try:
        descendant.relative_to(ancestor)
        return True
    except ValueError:
        return False


def enforce_document_root_containment(document_root: Path) -> None:
    """Refuse to serve a whole repository/worktree tree as the design document root.

    One rule for both explicit-file and directory-discovery modes, applied before a
    socket is ever opened. The chosen design file's parent is the document root the
    static server would expose. Inside Git, the enclosing worktree root is resolved
    from that parent and the document root is refused when it is that root itself or
    an ancestor that contains it — so a directory at or above the repository can
    never serve the whole tree, while a design directory strictly inside it (e.g.
    docs/) stays allowed. Outside Git, only a filesystem root is refused."""
    document_root = document_root.resolve()
    repo_root = _git_toplevel(document_root)
    if repo_root is not None:
        if _contains(document_root, repo_root):
            raise SystemExit(
                f"Refusing to serve a repository/worktree root as a design document root: "
                f"{document_root} (Git worktree root {repo_root}). Point --design-path at a "
                f"design subdirectory such as docs/ instead of the repository root."
            )
    elif document_root.parent == document_root:
        raise SystemExit(
            f"Refusing to serve a filesystem root as a design document root: {document_root}."
        )


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        root = Path(self.directory).resolve()
        target = Path(self.translate_path(self.path))
        candidates = [target]
        if target.is_dir():
            candidates += [target / name for name in ("index.html", "index.htm")]
        if any(not _contains(root, path.resolve()) for path in candidates):
            self.send_error(403, "Requested file is outside the design directory")
            return None
        return super().send_head()

    def log_message(self, format: str, *args: object) -> None:
        return


def verify_url(url: str) -> int:
    try:
        with contextlib.closing(urlopen(url, timeout=5)) as response:
            return int(response.status)
    except HTTPError as exc:
        return int(exc.code)
    except URLError as exc:
        raise SystemExit(f"Design server did not respond at {url}: {exc}") from exc


def metadata_path(arg: str | None) -> Path:
    if arg:
        return Path(arg).expanduser().resolve()
    root = Path(tempfile.gettempdir()) / "hatch-validate"
    root.mkdir(parents=True, exist_ok=True)
    return root / "design-server.json"


def run_server(design_file: Path, metadata_out: Path) -> None:
    enforce_document_root_containment(design_file.parent)
    handler = functools.partial(QuietHandler, directory=str(design_file.parent))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = int(server.server_address[1])
    design_url = f"http://127.0.0.1:{port}/{quote(design_file.name)}"

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    status = verify_url(design_url)
    if status != 200:
        server.shutdown()
        raise SystemExit(f"Design page returned HTTP {status}: {design_url}")

    metadata = {
        "design_file": str(design_file),
        "design_dir": str(design_file.parent),
        "design_url": design_url,
        "host": "127.0.0.1",
        "port": port,
        "metadata": str(metadata_out),
    }
    metadata_out.parent.mkdir(parents=True, exist_ok=True)
    metadata_out.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps(metadata), flush=True)

    try:
        thread.join()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()


def _git_init(path: Path) -> None:
    for args in (
        ["git", "init", "-q"],
        ["git", "config", "user.email", "hatch@example.com"],
        ["git", "config", "user.name", "hatch"],
    ):
        subprocess.run(args, cwd=str(path), check=True, capture_output=True, text=True, encoding="utf-8")


def _refuses(document_root: Path) -> bool:
    try:
        enforce_document_root_containment(document_root)
        return False
    except SystemExit:
        return True


def self_test() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        html = root / "demo.standalone.html"
        html.write_text("<!doctype html><title>hatch</title><div id='root'>ok</div>", encoding="utf-8")
        design_file = resolve_design_file(root)
        assert design_file == html.resolve()

        handler = functools.partial(QuietHandler, directory=str(root))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}/{html.name}"
            assert verify_url(url) == 200
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    # Containment: one rule for explicit-file and directory-discovery modes.
    with tempfile.TemporaryDirectory() as tmp:
        # A repository whose design lives strictly inside it (docs/, and a nested
        # exports/ under it) is served in both discovery and explicit-file modes.
        allowed_repo = Path(tmp).resolve() / "allowed"
        docs = allowed_repo / "docs"
        nested = docs / "exports"
        nested.mkdir(parents=True)
        _git_init(allowed_repo)
        docs_html = docs / "page.standalone.html"
        docs_html.write_text("<!doctype html><div id='root'>ok</div>", encoding="utf-8")
        nested_html = nested / "view.standalone.html"
        nested_html.write_text("<!doctype html><div id='root'>ok</div>", encoding="utf-8")
        assert not _refuses(resolve_design_file(docs).parent)          # directory discovery
        assert not _refuses(resolve_design_file(nested_html).parent)   # explicit nested file
        assert not _refuses(resolve_design_file(nested).parent)        # nested directory

        # A repository whose only design HTML sits at its root is refused, whether
        # reached by directory discovery of the root or by an explicit file there,
        # so the whole tree can never be served as a subtree.
        root_repo = Path(tmp).resolve() / "at-root"
        root_repo.mkdir()
        _git_init(root_repo)
        root_html = root_repo / "index.standalone.html"
        root_html.write_text("<!doctype html><div id='root'>ok</div>", encoding="utf-8")
        assert _refuses(resolve_design_file(root_repo).parent)   # directory discovery of the root
        assert _refuses(resolve_design_file(root_html).parent)   # explicit file at the root
        assert _refuses(root_repo)                               # the Git root itself

    # Outside Git, only a filesystem root is refused; an ordinary directory serves.
    with tempfile.TemporaryDirectory() as tmp:
        plain = Path(tmp).resolve()
        (plain / "lonely.standalone.html").write_text("<!doctype html><div id='root'>ok</div>", encoding="utf-8")
        if _git_toplevel(plain) is None:
            assert not _refuses(resolve_design_file(plain).parent)
        assert _refuses(Path(plain.anchor))

    print("serve_design self-test passed")


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve a Hatch design HTML file on localhost.")
    parser.add_argument("--design-path", help="Design HTML file or directory containing one.")
    parser.add_argument("--metadata-out", help="Path for JSON metadata. Defaults to the OS temp dir.")
    parser.add_argument("--self-test", action="store_true", help="Run a local self-test and exit.")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return
    if not args.design_path:
        parser.error("--design-path is required unless --self-test is used")

    design_file = resolve_design_file(Path(args.design_path))
    run_server(design_file, metadata_path(args.metadata_out))


if __name__ == "__main__":
    main()
