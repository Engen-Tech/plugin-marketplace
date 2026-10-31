# Secret Scan

## What it does

hatch runs a secret scan **before each commit** during build. The scan inspects the staged diff — only the changes about to be committed, not the full working tree — and blocks the commit if it finds a credential, token, key, or other secret pattern.

## On a hit

When the scan finds a match it blocks the commit and surfaces the finding: the file, line, and matched pattern. The build halts at that item; no commit is written. The item is marked failed with the scan output attached. Resolution requires removing or rotating the secret before the item can be retried.

## Allow-list

Some matches are benign — test fixtures, example placeholders, documentation snippets. These are recorded in-repo in an allow-list file (e.g. `.hatch/secret-scan-allowlist`) as path/pattern entries:

```
# path glob : pattern description
tests/fixtures/** : example-api-key
docs/examples/*.md : placeholder-token
```

An entry suppresses the matching finding for the matched path. Allow-list entries are reviewed alongside the code that adds them — they are part of the commit record, not a silent bypass.

## Bundled scanner

The scan runs one bundled script so every build scans the same way — `scripts/scan_secrets.py`, run with `uv run skills/hatch-build/scripts/scan_secrets.py`. It is PEP 723 (a `# /// script` header), stdlib-only, and does its matching in Python; it does not shell out to `grep`/`find` or assume WSL exists. The one external tool is `git` — the scanner reads the staged diff with `git diff --cached`, the same git backbone the build already runs on.

Run it from the worktree or repo root. It reads the full staged diff (not a directory-scoped subset), so a secret staged anywhere in the worktree is seen no matter where the scan starts. It applies a fixed high-signal pattern set, applies the allow-list above (default path `.hatch/secret-scan-allowlist`, override with `--allowlist`), and exits non-zero with `file:line:pattern` for each unsuppressed hit.

The pattern set is the low-false-positive core of the public gitleaks / detect-secrets / trufflehog rules. Each rule keys on a distinctive prefix or an explicit key-shaped assignment:

| Pattern | Catches |
|-|-|
| `aws-access-key-id` | `AKIA`/`ASIA`/`ABIA`… + 16 chars |
| `aws-secret-access-key` | an `aws`…`secret`/`private`… 40-char assignment |
| `github-token` | `ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_` + 36 chars |
| `github-fine-grained-pat` | `github_pat_`… |
| `gitlab-pat` | `glpat-`… |
| `slack-token` / `slack-webhook` | `xox[baprs]-`… / `hooks.slack.com/services/`… |
| `private-key-block` | `-----BEGIN … PRIVATE KEY-----` (RSA/EC/DSA/OpenSSH/PGP) |
| `stripe-secret-key` / `google-api-key` | `sk_live_`… / `AIza`… |
| `anthropic-key` / `openai-key` / `jwt` | `sk-ant-`… / `sk-` + 40 chars (the `sk-ant-` form excluded) / `eyJ`….`eyJ`…. |
| `high-entropy-assignment` | a `secret_key`/`client_secret`/`token`/`api_key`-named literal above an entropy floor |

The `anthropic-key` and `openai-key` rules do not overlap: `openai-key` requires 40+ characters and skips the `sk-ant-` form, so one provider key produces one finding.

`uv run skills/hatch-build/scripts/scan_secrets.py --self-test` runs the embedded fixtures and exits 0/1 — the gate's own regression guard.

## Scope

The secret scan is a floor safety check. It catches accidental credential commits during the build loop. It is not a replacement for the project's own secret tooling (e.g. git-secrets, trufflehog, detect-secrets configured in CI). Projects with existing secret scanning should treat hatch's check as an additional early gate, not a substitute.
