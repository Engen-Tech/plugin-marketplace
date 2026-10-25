# Engen-Tech plugin marketplace: design and build plan

Date: 2026-10-25. Status: design only; no code in any repo yet.
Repo: `github.com/Engen-Tech/plugin-marketplace`, public, GitHub only, no Forgejo copy (operator decided). Marketplace `name`: `engen-tech`; ids `steward-delegation@engen-tech`, `steward-prose-gate@engen-tech`, `steward-orchestration@engen-tech`, `plainlanguage@engen-tech` (operator decided).
Paths below are `steward ...` (`/mnt/agent-storage/vader/src/steward`, main 050887f), `common-skills ...`, `pi docs ...` (`earendil-pi packages/coding-agent/docs/`) and `FINDINGS.md` (`hatch docs/backlog/engen-tech-plugin-marketplace/FINDINGS.md`, background research only).

## The release rule

(operator decided) A release starts only when the operator pushes a release tag `<plugin>--v<version>` to the product repo. That push starts the product repo's pipeline, which builds the plugin's marketplace folder and pushes one commit to `Engen-Tech/plugin-marketplace` main. The release is that push. One tag releases exactly one plugin. Nothing else starts a release: no workflow in the marketplace, no `workflow_dispatch`, no schedule, no watcher, no detection of new tags or commits. Everything a release writes is a plain file in that one commit, so its diff is the release record, and a dry run shows the same commit before the tag is pushed.

## Scope

- In: steward-delegation, steward-prose-gate, steward-orchestration (from `TejGandham/steward`) and plainlanguage (from Forgejo `stackhouse/common-skills`) (operator decided).
- The steward repo stops being a distribution point. Its catalogs keep only `steward` pinned to `v0.14.2`; its READMEs point here; its root `package.json` stays for local development (operator decided).
- Dependencies between plugins stay manual, with no `dependencies` field; the README lists the sets (operator decided).
- Non-goals: other products, including hatch, are not covered. No checks or CI inside the marketplace. No npm publishing.

## Facts this design rests on

| Fact | Source |
|-|-|
| Copilot CLI 1.0.99 reads `.claude-plugin/marketplace.json` and finds `.github/plugin/plugin.json` inside `plugins/<name>/` (debug log: Plugins loaded steward-delegation@steward, steward-prose-gate@steward) | steward docs/roadmap/plugin-split.md:533 |
| Codex CLI 0.164.0 installs `{"source":"local","path":"./plugins/<name>"}` from `.agents/plugins/marketplace.json`, loads a hooks-only plugin from the manifest's `codex/hooks.json`; `codex exec` skips untrusted plugin hooks silently | plugin-split.md:533 |
| Claude Code 2.1.310 installs relative-path entries and the plugins work from the plugin cache, all gates live-checked | plugin-split.md:533 |
| pi 1.4.0 loads a root `package.json` `pi` field with paths into subfolders and applies resource filters; pi cannot git-install a subfolder | plugin-split.md:235, :533; pi docs packages.md:59-74, :97-121 |
| Claude Code: a `version` in `plugin.json` wins over the catalog's, and `claude plugin validate` warns | FINDINGS.md:42 |
| The same plugin name from two marketplaces installs as two ids whose components collide | FINDINGS.md:43 |
| `skills: [plainlanguage]` in an agent preloads a plugin-installed plainlanguage | plugin-split.md:531 |
| pi keeps the first of two skills with one name and warns | pi docs skills.md:85 |
| Forgejo on brahma: `uses:` needs a full URL; runner label `ubuntu-latest`; common-skills has Actions enabled (API `has_actions: true`, 2026-10-25) | gringotts .forgejo/workflows/ci.yml:10-15 |
| The three `*--v0.15.0` tags are on GitHub at 050887f; steward has no workflow | `git ls-remote origin`, 2026-10-25 |

## Marketplace repo layout

```
.claude-plugin/marketplace.json   catalog "engen-tech" for Claude Code; Copilot reads it too
.agents/plugins/marketplace.json  catalog "engen-tech" for Codex
package.json                      the pi package: static fields plus the pi field (operator decided)
plugins.lock.json                 one entry per plugin
README.md                         install lines and plugin sets
docs/design.md                    this file
plugins/<name>/                   shipped files only
```

- No `scripts/`, `tests/` or workflows here (operator decided). No check lives here either (designer's call: every release validates the whole tree before it pushes, so a hand edit fails the next release, and anyone can re-check a lock entry with one `git rev-parse`).
- One catalog serves Claude Code and Copilot, so Copilot lists steward-orchestration, which is Claude Code only; the README says so (designer's call: a `.github/plugin/marketplace.json` only to hide one entry is a second file to keep in step, and the listing was harmless in plugin-split.md:533).

### Where each generated field comes from

| File | Entries | Fields |
|-|-|-|
| `.claude-plugin/marketplace.json` | every plugin | `name` = folder; `description` = `.claude-plugin/plugin.json` `description`; `source` = `"./plugins/<name>"`; no `version` (FINDINGS.md:42) |
| `.agents/plugins/marketplace.json` | plugins with `.codex-plugin/plugin.json` (orchestration has none, as today) | `name`; `source` = `{"source":"local","path":"./plugins/<name>"}`; `category` = manifest `interface.category`; `policy` = constant `{"installation":"AVAILABLE","authentication":"ON_INSTALL"}`, as steward .agents/plugins/marketplace.json:14-17 |
| `package.json` `pi` | plugins with pi resources | the lock's `pi` lists, each prefixed `./plugins/<name>/`; `agents` go under `subagents.agents` |

Static fields come from the skeleton and no release touches them: catalog `name` `engen-tech`, `owner.name` `Engen-Tech`, Codex `interface.displayName` `Engen-Tech`. The `package.json` copies the shape of steward package.json:1-18,36-38 (`private`, `keywords: ["pi-package"]`, `type: module`, `peerDependencies` `@earendil-works/pi-coding-agent: "*"`), with name `engen-tech-plugins` and a fixed `version` `1.0.0` that is not a release number (same rule as plugin-split.md:217).

### Lock file

`plugins.lock.json`: one JSON object keyed by plugin name (designer's call: keys make a duplicate entry impossible and keep a one-plugin diff small).

```json
{
  "steward-delegation": {
    "version": "1.0.0",
    "source": "https://github.com/TejGandham/steward",
    "tag": "steward-delegation--v1.0.0",
    "commit": "<40-hex commit the tag points at>",
    "tree": "<40-hex git tree id of plugins/steward-delegation>",
    "pi": {"extensions": ["pi/extensions/steward-delegation/index.ts"], "skills": ["pi/skills"], "agents": ["pi/agents"]}
  }
}
```

`tree` is git's own tree id (designer's call): no custom hash code, it covers file modes (`hooks/delegation_hook.py` is 100755), and anyone re-checks it with `git rev-parse HEAD:plugins/<name>`. Before the commit the publisher reads it with `git write-tree --prefix=plugins/<name>/`; on a scratch copy of steward-delegation both commands gave the same id (checked 2026-10-25). plainlanguage's `source` is the Forgejo URL, which is on the tailnet; public readers cannot open it, which is acceptable for a provenance record.

## Shipped set

- Steward plugins: the tracked files of `plugins/<name>/` at the tag, minus `tests/`, taken with `git archive <tag> plugins/<name>` so caches never ship (designer's call: tests are 30 of delegation's 71 files and nothing at runtime reads them). Result at 050887f: delegation 41 files, prose-gate 10, orchestration 6. READMEs ship.
- Checked: a grep of `hooks/`, `pi/`, `codex/`, `copilot/`, `skills/`, `agents/`, `data/` in all three plugins finds no runtime read of `tests/`. The hits are prose: `skills/delegating/routing.md:74` names a test file; `hooks/delegation_hook.py:89` `STEWARD_DELEGATION_ROOT` is test-only and falls back to the script's own folder; comments at `pi/extensions/steward-delegation/index.ts:374-384`.
- steward tests/test_layout.py:197-256 already runs every hook from a lone copy of each folder; build step 15 proves the shipped set live.
- plainlanguage: see "Delivering plainlanguage".

## Release pipeline (product side)

| Part | steward | common-skills |
|-|-|-|
| Workflow | `.github/workflows/release-marketplace.yml`, GitHub Actions, `on: push: tags: ["steward-delegation--v*", "steward-prose-gate--v*", "steward-orchestration--v*"]` | `.forgejo/workflows/release-marketplace.yml`, Forgejo Actions, `on: push: tags: ["plainlanguage--v*"]`, `uses: https://code.forgejo.org/actions/checkout@v4`, `runs-on: ubuntu-latest` |
| Assembly | `scripts/release_marketplace.sh` | `scripts/release_marketplace.sh` |
| Publisher | `scripts/publish_marketplace.py` (canonical copy) | the same file, copied byte for byte |
| Secret | Actions secret `MARKETPLACE_TOKEN` | Forgejo Actions secret `MARKETPLACE_TOKEN` |

Designer's call: one publisher shared by copy, plus a short assembly script per product. The marketplace edits must be the same in both products or they clobber each other; only the assembly differs. The publisher writes its own sha256 into each commit body, so a drifted copy shows in marketplace history.

Steps for tag `T` = `<plugin>--v<version>`:
1. Check `T`: the name is one of this repo's plugins and the version is `MAJOR.MINOR.PATCH`; the tag's commit is on origin/main (AGENTS.md "Deploy from main only"); every manifest the plugin has (`.claude-plugin`, `.codex-plugin`, `.github/plugin`) carries `"version"` equal to `<version>`. Any mismatch fails the run.
2. Steward only: run the suite at the tag with `PI_SUBAGENTS_DIR=/nonexistent npm test`, which skips the two pi-subagents version tests (plugin-split.md:537).
3. Assemble the plugin folder in a temp dir (steward: `git archive` minus `tests/`; plainlanguage: below).
4. pi lists: steward takes the entries under `./plugins/<name>/` from its root `package.json` `pi` field, its only pi declaration (plugin-split.md:235-245); common-skills passes `skills: ["skills"]`.
5. Publisher: shallow-clone marketplace main; replace `plugins/<name>/`; read-modify-write only this plugin's entry in the two catalogs, the lock and the `package.json` pi lists; run the validator on the whole tree; commit `release: <plugin> <version>` with body lines `source:`, `tag:`, `commit:`, `publisher: <sha256>` and no other trailers; push.
6. Push: plain `git push origin HEAD:main`. If main moved (the other product released meanwhile), discard the clone and redo step 5 from a fresh clone, at most 3 times, then fail. Never force-push. Designer's call: a fresh-clone retry handles three tags pushed together and a race between the two products, keeps every product's entries, and needs no concurrency feature of either CI (how GitHub concurrency groups treat pending runs was not checked).

Rules for the shared files:
- The publisher refuses to replace a lock entry whose `source` is not its own repo URL, so neither product can overwrite the other's plugins.
- JSON is written as `json.dumps(indent=2)` plus a newline, entries sorted by name, the format the skeleton starts with, so other entries' bytes never change.
- The commit author is set as plain values in the workflow file (the operator's git identity; operator to confirm). The token goes in an HTTP auth header from the secret, never in the remote URL or the log.

Dry run: `scripts/release_marketplace.sh <tag> --dry-run [--marketplace <url>]` runs steps 1-5 for a local tag, stops after the commit, prints the temp clone path and `git show --stat HEAD`, and pushes nothing. The default marketplace URL is the GitHub repo, cloned read-only; tests pass a `file://` bare repo.

Failures: a failed run leaves the marketplace unchanged; fix the cause and re-run the job from the Actions page. Re-pushing an existing tag starts nothing, and no tag is moved or force-pushed without the operator's say. A bad release is fixed by a new patch tag. GitHub runs the workflow file of the commit the tag points at, so a tag on a commit without the workflow starts nothing; that is why the three `--v0.15.0` tags never released. Forgejo is expected to do the same; step 14 is the first proof.

### Validator (in the publisher, before the commit)

| Check | Catches |
|-|-|
| Folders under `plugins/` and lock keys match one to one; `git write-tree --prefix=plugins/<name>/` equals the lock `tree` for every plugin | hand edits under `plugins/`, a bad copy, a lost entry |
| Every manifest in a folder has `name` equal to the folder and `version` equal to the lock | wrong folder, half-bumped version |
| Claude catalog: one entry per plugin, fields as in the table, no `version` | catalog drift, a clobbered entry |
| Codex catalog: entries for exactly the plugins with `.codex-plugin/plugin.json`, fields as in the table | the same |
| `package.json` `pi` equals the lock's pi lists and every path exists | missing or stale pi paths |
| `claude plugin validate .` when `claude` is on PATH | schema errors; runs in the operator's dry runs, skipped with a printed note on runners |

## Delivering plainlanguage

(operator decided) plainlanguage stays canonical in common-skills (`plainlanguage/`: `SKILL.md`, `de-llm.md`, `ste100.md`), ships as its own plugin through its own Forgejo pipeline, tag `plainlanguage--v<version>` starting at `plainlanguage--v1.0.0`, and is not bundled into any steward plugin. Where its manifests live:

| Option | Version lives in | Downside |
|-|-|-|
| (a) manifests inside `plainlanguage/` | `plainlanguage/.claude-plugin/plugin.json` and two more | the deploy copies `plainlanguage/` whole (AGENTS.md "Deploying skills from common-skills"), so every deployed copy gains three manifest folders no harness's skill loader was tested with |
| (b) the pipeline generates manifests from a descriptor | a descriptor JSON | the manifests users get appear only in the marketplace commit, never as files in common-skills |
| (c) manifests in a sibling folder `plainlanguage-plugin/` | its three manifests | two folders for one plugin |

Pick (c) (designer's call, operator to confirm): the manifests are plain files in common-skills where the operator edits them, and the deployed skill folder stays byte-identical to today.

- `plainlanguage-plugin/.claude-plugin/plugin.json`: `name` `plainlanguage`, `version`, `description`, `author`, `license`, `"skills": "./skills/"` (shape of common-skills exa-rest/.claude-plugin/plugin.json).
- `plainlanguage-plugin/.codex-plugin/plugin.json`: the same plus `interface` with `category` `Productivity` (shape of common-skills exa-rest/.codex-plugin/plugin.json).
- `plainlanguage-plugin/.github/plugin/plugin.json`: `name`, `version`, `description`, `"skills": ["skills/"]` (shape of steward plugins/steward-delegation/.github/plugin/plugin.json:16-18).
- Assembly: copy `plainlanguage-plugin/` to the plugin root and every tracked file of `plainlanguage/` (today the three) to `skills/plainlanguage/`, keeping them siblings as `SKILL.md` links them (SKILL.md:82, :219, :232). Result: 6 files.
- Version: one value in the three wrap manifests; step 1 checks it against the tag.
- Trigger: the operator pushes `plainlanguage--v1.0.0` to Forgejo.
- Lock: Forgejo URL, tag, commit, tree, `pi: {"skills": ["skills"]}`; `package.json` gains `./plugins/plainlanguage/skills`.
- Preload: steward-delegation's writer lists `skills: [plainlanguage]` on Claude Code (steward plugins/steward-delegation/agents/writer-sonnet-medium.md:6) and `skills: plainlanguage` on pi (pi/agents/writer.md:12). A skill folder `skills/plainlanguage/` whose SKILL.md says `name: plainlanguage` keeps both: Claude Code preloads a plugin-installed plainlanguage under the bare name (plugin-split.md:531), and pi matches by skill name. The Copilot and Codex agents preload nothing.
- This design changes nothing in common-skills now; the edits are build step 12.

## Marketplace README

Install lines per harness; install only the plugins in your set.

```
# Claude Code (each CLAUDE_CONFIG_DIR profile)
claude plugin marketplace add https://github.com/Engen-Tech/plugin-marketplace.git
claude plugin install plainlanguage@engen-tech --scope user
claude plugin install steward-prose-gate@engen-tech --scope user
claude plugin install steward-delegation@engen-tech --scope user
claude plugin install steward-orchestration@engen-tech --scope user
# GitHub Copilot (close running sessions first, steward README.md:60)
copilot plugin marketplace add Engen-Tech/plugin-marketplace
copilot plugin install plainlanguage@engen-tech
copilot plugin install steward-prose-gate@engen-tech
copilot plugin install steward-delegation@engen-tech
# Codex (then trust each plugin's hooks once with /hooks)
codex plugin marketplace add Engen-Tech/plugin-marketplace
codex plugin add plainlanguage@engen-tech
codex plugin add steward-prose-gate@engen-tech
codex plugin add steward-delegation@engen-tech
# pi
pi install npm:pi-subagents
pi install git:github.com/Engen-Tech/plugin-marketplace
```

- Claude Code uses the HTTPS URL, the form checked in plugin-split.md:538-542 (an SSH clone broke `plugin update` with the `github` shape). Copilot and Codex use the shorthand checked in plugin-split.md:538 and :543.
- Codex: in `codex exec`, hooks of an untrusted plugin are skipped silently (steward README.md:72).
- pi filters: the extension filters of steward README.md:85-111 work unchanged with `"source": "git:github.com/Engen-Tech/plugin-marketplace"`, since the paths are the same. `"skills": []` now also drops plainlanguage. The filter string that drops only plainlanguage is settled in build step 15.
- steward-orchestration is Claude Code only; Copilot lists it, but do not install it there.

| You want | Install |
|-|-|
| Plain prose | plainlanguage, steward-prose-gate |
| Delegation | plainlanguage, steward-delegation; add steward-prose-gate to enforce the prose half of the edict |
| Orchestration (Claude Code) | all four |

Soft dependencies: steward-delegation's edict and the prose-gate block messages name the plainlanguage skill, and both work without it (plugins/steward-delegation/skills/delegating/SKILL.md:12 fallback; plugins/steward-prose-gate/README.md:8). steward-orchestration says once when steward-delegation is missing (steward README.md:37).

## Migration for existing steward users

| From | Do |
|-|-|
| Claude Code `steward@steward` 0.14.2 | `claude plugin uninstall steward@steward`; `claude plugin marketplace remove steward`; add this marketplace; install your set; move the gate and prose-patterns files (plugin-split.md:507) |
| Copilot `steward@steward` 0.14.2, or a direct `TejGandham/steward` install at 0.13.0 | close sessions; `copilot plugin uninstall steward`; remove the `steward` marketplace; add this one; install; fix the link and `steward:<role>` keys (plugin-split.md:514-515) |
| Codex `steward@steward-codex` 0.14.2 | remove it and the `steward-codex` marketplace; add this one; `codex plugin add` your set; trust the new keys `steward-delegation@engen-tech:codex/hooks.json:session_start:0:0`, `steward-prose-gate@engen-tech:codex/hooks.json:pre_tool_use:0:0` and `:stop:0:0`; delete the `steward@steward-codex:*` entries |
| pi `git:github.com/tejgandham/steward`, pinned or not | `pi remove` that entry; `pi install git:github.com/Engen-Tech/plugin-marketplace`; move config (plugin-split.md:524-525) |
| `<x>@steward` 0.15.0 from steward main | uninstall it before installing `<x>@engen-tech`; both would load (FINDINGS.md:43) |

Users who do nothing stay on 0.14.2 through the catalog pin (steward tests/test_catalogs.py:26-39). Once `plainlanguage@engen-tech` is installed, the operator may delete the hand-deployed copies in `~/.claude/skills/` and `~/.agents/skills/` by hand (operator decided).

## Steward repo changes

- Catalogs: remove the three entries (`.claude-plugin/marketplace.json:17-31`, `.agents/plugins/marketplace.json:20-43`); replace `tests/test_catalogs.py:42-72`, which requires them, with a test that `steward` is the only entry (operator decided).
- READMEs point here: root README.md:39-115; plugins/steward-delegation/README.md:36-64, :85; plugins/steward-prose-gate/README.md:21-45; plugins/steward-orchestration/README.md:17-18. The plugin READMEs ship in the copies, so this lands before the 1.0.0 tags (designer's call).
- Version 1.0.0 for all three plugins (operator decided): the seven manifests and `plugins/steward-delegation/tests/test_delegation_manifests.py:11`, `plugins/steward-prose-gate/tests/test_prose_gate_manifests.py:11`, `plugins/steward-orchestration/tests/test_orchestration_content.py:39`. Root `package.json` stays 0.15.0 (designer's call: dev only, not a release number, plugin-split.md:217).
- The three `--v0.15.0` tags stay as history and are never released here (operator decided). The first release is a version-bump commit on steward main after the workflow lands, then three new 1.0.0 tags.

## Build plan

Each step is one commit or one named operator act, re-runnable from its done-check if quota runs out. Marks: **[outside]** writes outside this repo; **[push]** pushes; **[operator]** the operator does it by hand. Branches merge with `--no-ff`; nothing is rebased.

| # | Step | Where | Done-check |
|-|-|-|-|
| 1 | Skeleton: two catalogs with `plugins: []`, `package.json` static fields and empty pi lists, `plugins.lock.json` `{}`, README stub | this repo | each file parses; `claude plugin validate .` output recorded |
| 2 | `scripts/publish_marketplace.py` and `tests/test_publish_marketplace.py` | steward branch [outside] | suite passes; against a temp `file://` bare marketplace: an upsert leaves other entries byte-identical; each validator row rejects its drift case; a foreign `source` is refused; a dry run pushes nothing; a rejected push re-clones, keeps the other product's entry, then pushes |
| 3 | `scripts/release_marketplace.sh` and the workflow | steward branch [outside] | `release_marketplace.sh steward-prose-gate--v0.15.0 --dry-run --marketplace file://<skeleton>` builds one commit with 10 files under `plugins/steward-prose-gate/` and no `tests/` (a test, never pushed); a tag whose version differs from the manifests fails |
| 4 | Re-point READMEs and catalogs; rewrite `tests/test_catalogs.py` | steward branch [outside] | suite; no install line for `@steward` or `@steward-codex` is left outside migration text |
| 5 | Bump the three plugins to 1.0.0 | steward branch [outside] | suite; `grep -rn '"version": "0.15.0"' plugins/` is empty |
| 6 | Create `Engen-Tech/plugin-marketplace`, public; push the skeleton and this doc | GitHub [operator] [push] | `gh repo view Engen-Tech/plugin-marketplace --json visibility` says PUBLIC; remote main equals local |
| 7 | Steward token: fine-grained PAT, resource owner Engen-Tech, repository access only `plugin-marketplace`, repository permission Contents read and write (Metadata read is added by GitHub), nothing else; save as Actions secret `MARKETPLACE_TOKEN` in `TejGandham/steward`. Confirm the org allows fine-grained PATs; note the expiry date | GitHub [operator] | `gh secret list -R TejGandham/steward` lists `MARKETPLACE_TOKEN` |
| 8 | Merge the steward branch to main; push main | steward [outside] [push, operator authorizes] | origin/main holds the workflow and the 1.0.0 manifests |
| 9 | Create the three 1.0.0 annotated tags locally on the step 8 merge; dry-run each against the GitHub marketplace | steward checkout, local | each dry run prints one commit with 41, 10 or 6 plugin files, its lock entry and catalog entries; `claude plugin validate .` passes in the temp clone |
| 10 | Push the tags one at a time, each after the previous run is green | steward [operator] [push, starts CD] | three marketplace commits `release: <plugin> 1.0.0`; for each, `git rev-parse HEAD:plugins/<name>` equals the lock `tree` |
| 11 | Live checks of the three steward plugins (below), before plainlanguage changes anything | scratch homes only | Claude Code, Codex and pi rows of step 15 pass for the steward plugins |
| 12 | common-skills: `plainlanguage-plugin/` at 1.0.0, both scripts (publisher copied from steward), the Forgejo workflow; merge to main, push | common-skills [outside] [push, operator authorizes] | a dry run of a local `plainlanguage--v1.0.0` builds `plugins/plainlanguage/` with 6 files; both publisher copies have one sha256; `git diff --stat <main before step 12> -- plainlanguage/` is empty |
| 13 | Second token as in step 7; save as Forgejo Actions secret `MARKETPLACE_TOKEN` in `stackhouse/common-skills` | Forgejo [operator] | the secret is listed in the repo's Actions settings |
| 14 | Push `plainlanguage--v1.0.0` to Forgejo | common-skills [operator] [push, starts CD] | marketplace commit `release: plainlanguage 1.0.0`; its diff leaves the steward entries unchanged |
| 15 | Live checks of all four plugins from the GitHub marketplace, in scratch homes | scratch homes only | Claude Code: four installs, prose-gate block, PR-gate deny, delegation-gate deny, edict once, writer preloads plainlanguage. Copilot: installs, debug log loads the plugins; the three gate checks after the quota reset (about 2026-10-31, plugin-split.md:533). Codex: installs, `/hooks` trust, prose-gate block, PR-gate deny, edict once, plainlanguage listed. pi: install, seven `steward.*` agents, both gates, the prose-gate-only filter, plainlanguage present, the plainlanguage-only filter string. A result paragraph is added here |
| 16 | Full marketplace README | this repo [push, operator authorizes] | every command in it ran in step 15 |
| 17 | Steward step 23 on the operator's machine, re-pointed: marketplace `engen-tech`, ids `<x>@engen-tech`, the Codex trust keys above, pi entry `git:github.com/Engen-Tech/plugin-marketplace` | operator's machine [operator] | each harness starts a session with one edict and no duplicate gates |

Order notes: steps 2-5 sit on one steward branch and can run in any order. Steps 6 and 7 come before step 8 so the steward README never points at a missing repo for long. Step 11 proves the steward releases before a second product writes to the shared files.

## Open questions

- License: the repo is public; steward manifests say MIT but steward has no LICENSE file; common-skills has none and exa-rest says UNLICENSED. The operator picks a LICENSE for this repo and a `license` value for the plainlanguage manifests.
- Forgejo has not yet run a tag-triggered workflow for common-skills, or pushed to github.com from its runner; step 14 is the first proof.
