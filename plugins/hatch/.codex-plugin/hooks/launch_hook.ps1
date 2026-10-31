<#
.SYNOPSIS
    Windows launcher for hatch's Codex guard hooks.

.DESCRIPTION
    Codex hook manifests carry a POSIX `command` and an optional `commandWindows`.
    hatch's POSIX launcher is a `sh -c` one-liner, and `sh` is not on PATH on a
    stock Windows install — so before this launcher existed, every bundled guard
    failed at the launcher, not in the guard. The visible symptom was a Codex
    turn ending with `Stop hook (failed) — hook exited with code 1` on a repo with
    no active binder and nothing to block.

    A one-liner is not workable as the Windows counterpart: PowerShell would have
    to be embedded in a JSON string, quoted through the manifest, and repeated
    once per hook entry. This is a real file instead, and every `commandWindows`
    entry is a single call into it.

    Exit-code contract, identical to the POSIX launcher:

      * The guard's own exit code is propagated VERBATIM. 0 allows, 2 blocks with
        the reason on stderr (the Stop guard also writes its JSON decision to
        stdout). Anything else is a crashing guard and is reported as such.
      * Only LAUNCHER-level problems fail open with exit 0 — no root, no guard
        file, no usable interpreter, or an unexpected error in this script. That
        is the promise the hook manifests already make: if the plugin does not
        resolve on this Codex build, the hook allows rather than wedging the
        session.

    The distinction is deliberate. Collapsing every non-zero code to 0 would make
    a crashed fail-closed guard — binder immutability, pack-write validation —
    indistinguishable from one that deliberately allowed, and it would do so only
    on Windows. hatch's rule is two platforms, one behaviour: a guard that fails
    loudly on Linux must fail loudly here.

.PARAMETER Script
    Guard path, relative to the resolved root, with forward slashes.

.PARAMETER Root
    Which root to resolve `Script` against:
      Plugin — $env:PLUGIN_ROOT, the installed plugin (bundled hooks.json).
      GitTop — `git rev-parse --show-toplevel`, the hatch checkout itself
               (the repo-local .codex/hooks.json, which also launches a guard
               that lives outside .codex-plugin/).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Script,

    [Parameter(Position = 1)]
    [ValidateSet('Plugin', 'GitTop')]
    [string] $Root = 'Plugin'
)

# Fail open on anything this script did not anticipate: the trap catches every
# terminating error. ErrorActionPreference stays 'Continue' — under 'Stop', a
# native command merely WRITING to stderr through a redirection (git outside a
# repo, an interpreter probe's chatter) becomes a terminating error and lands
# in this trap, turning expected noise into a silent skip; worse, on hosts that
# promote native stderr globally, a guard's own deny reason would do the same.
trap { exit 0 }

function Resolve-Interpreter {
    <#
        Find a real CPython. Ordered `python3` then `python` to match the POSIX
        launcher's `python3`, then the `py` launcher as a last resort.

        Non-WindowsApps entries are tried first: Windows ships `python3.exe` and
        `python.exe` under WindowsApps as App Execution Aliases that, with no
        Python installed, open the Microsoft Store and exit non-zero instead of
        running anything. But a WindowsApps entry is not always that stub — a
        Store-INSTALLED Python lives at the same alias path and is a real
        interpreter, and on a machine where it is the only Python, skipping it
        outright would fail every hook open. So candidates are ordered, then
        VERIFIED: the first one that can actually run `-c "import sys"` wins.
        The probe costs one process start and removes the guess entirely.
    #>
    $candidates = @()
    foreach ($name in @('python3', 'python')) {
        $found = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue
        foreach ($f in @($found | Where-Object { $_.Source -notlike '*\WindowsApps\*' })) {
            $candidates += , @{ Exe = $f.Source; Pre = @() }
        }
    }
    $py = Get-Command 'py' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($py) { $candidates += , @{ Exe = $py.Source; Pre = @('-3') } }
    foreach ($name in @('python3', 'python')) {
        $found = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -like '*\WindowsApps\*' } |
            Select-Object -First 1
        if ($found) { $candidates += , @{ Exe = $found.Source; Pre = @() } }
    }
    foreach ($candidate in $candidates) {
        # -I -S: no site/user startup code runs, so the probe cannot read the
        # hook payload waiting on inherited stdin, and a shim cannot inject.
        # The version floor is the guards' own requires-python (>=3.11); an
        # older interpreter would die on their syntax AFTER launch, which reads
        # as a crashed guard rather than a missing interpreter.
        & $candidate.Exe @($candidate.Pre) -I -S -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return $candidate }
    }
    return $null
}

# --- resolve the root -----------------------------------------------------
if ($Root -eq 'GitTop') {
    # `git -C` the PROCESS working directory, not PowerShell's location: a
    # checkout path containing `[` is a wildcard to Set-Location, so PowerShell
    # cannot start IN such a directory and falls back to System32 — while the
    # Win32 CWD the harness set survives in [Environment]::CurrentDirectory.
    # Without -C, git would answer for the wrong directory (or no repo at all)
    # and every hook in a bracketed checkout would silently skip.
    # 2>$null and the $LASTEXITCODE check together: outside a repo git prints to
    # stderr and exits non-zero, which must fail open rather than throw. Every
    # OTHER git failure (dubious ownership, a lock, git missing) reads the same
    # way and also fails open — deliberately, because that is byte-for-byte what
    # the POSIX launcher's `2>/dev/null` + emptiness test does. Two platforms,
    # one behaviour; tightening one side alone would diverge them.
    $top = & git -C ([Environment]::CurrentDirectory) rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($top)) { exit 0 }
    $base = $top.Trim()
} else {
    $base = $env:PLUGIN_ROOT
    if ([string]::IsNullOrWhiteSpace($base)) { exit 0 }
}

# --- resolve the guard ----------------------------------------------------
# Join-Path per segment rather than string concatenation: the manifests spell
# Script with forward slashes (one spelling for both platforms) and this keeps
# the result a native path regardless.
$target = $base
foreach ($segment in ($Script -split '/')) {
    if ($segment -ne '') { $target = Join-Path $target $segment }
}
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { exit 0 }

$interpreter = Resolve-Interpreter
if ($null -eq $interpreter) { exit 0 }

# Match the interpreter behaviour these guards get on POSIX, where UTF-8 is the
# default for stdio and file reads. Without this, Python on Windows decodes the
# hook payload and the files the guards read as cp1252, and a single non-ASCII
# byte raises UnicodeDecodeError inside an otherwise correct guard.
#
# This is launcher-level parity, NOT a substitute for the guards naming their own
# encodings — that is tracked separately by the windows-parity binder, and stays
# necessary for every caller that does not come through this launcher.
$env:PYTHONUTF8 = '1'

# stdin is inherited, so the hook payload reaches the guard unread and unmodified
# by PowerShell; nothing here may consume it.
#
# On a host where native stderr becomes a terminating error
# (PSNativeCommandUseErrorActionPreference), a deny that writes its reason to
# stderr must still exit 2 — never fall into the trap and exit 0. That
# inversion would fail every fail-closed guard open, silently, and only on
# Windows. Forced Continue here even though it is already the default above,
# so no later edit can reintroduce it for the one call where it inverts a
# security verdict.
$ErrorActionPreference = 'Continue'
& $interpreter.Exe @($interpreter.Pre) $target
# Copilot CLI invokes this launcher as
#   powershell -Command "& launch_hook.ps1 ...; exit $LASTEXITCODE"
# and -Command reports 1 when a nested script exits 2, so it is the caller's
# trailing `exit $LASTEXITCODE` that carries a guard's 2 out. Codex's
# commandWindows uses -File, which passes this exit code through unchanged.
exit $LASTEXITCODE
