# Routing knowledge base

Routing knowledge base for the orchestrator. WHICH model and effort to pick is here; HOW to set it is in "Model and effort mechanics" below. Built 2026-09-03 from Anthropic's pricing and docs via web search; revised 2026-09-22 for Opus 5.5's launch, the drop of Haiku 4.5 and Opus 5 from the matrix, and the move of the coder profile from Sonnet 5 xhigh to Opus 5.5 medium; revised 2026-10-03 for Sonnet 5.5 replacing Sonnet 5; revised 2026-10-09 for Haiku 5.5 and the mechanic's move to it; revised 2026-10-11 for per-call effort, the top reviewer's move to Opus 5.5 max, and the decision to keep everyday review on Sonnet 5.5 high; revised 2026-10-12 for routing ad-hoc browser chores to the Haiku mechanic, and for the top reviewer's move to Opus 5.5 xhigh (Opus never runs at max).

## Cost ranking (per MTok, input / output / cache read), cheapest to dearest (cited: platform.claude.com/docs/en/about-claude/pricing, fetched 2026-09-22, re-fetched 2026-10-03 and 2026-10-08)
| Model | Input | Output | Cache read |
|-|-|-|-|
| Haiku 5.5 | $0.10 (over 100K-token prompts: $0.50) | $0.50 ($2.50) | $0.01 ($0.05) |
| Sonnet 5.5 | $2 | $10 | $0.10 |
| Opus 5.5 | $4 | $20 | $0.20 |
| Fable 5.1 = Mythos 5.1 | $10 | $50 | $0.25 |

Fable 5.1 is no longer pinned to any profile (2026-10-11); it runs only when the operator asks for it by name, through a per-call model override on the top reviewer. See "Top reviewer on Opus 5.5 xhigh; Opus never at max" below.

The 2026-10-03 pricing page lists Sonnet 5.5 at the same $2/$10/$0.20 as Sonnet 5 and now includes Opus 5.5 at $4/$20/$0.20 (its cache reads are priced at 0.05x input). On 2026-09-22 the page said the $2/$10 Sonnet 5 price, originally introductory, had become standard; the planned 2026-09-01 increase to $3/$15 did not happen. Sonnet 5.5 cache reads were halved to $0.10 on 2026-10-07 (anthropic.com/claude-haiku-5-5), so Sonnet and Opus no longer tie on cache reads (Opus $0.20).

Sonnet is 5x cheaper than Fable and 2x cheaper than Opus 5.5; Opus 5.5 is 2.5x cheaper than Fable. Haiku 5.5 is 20x cheaper than Sonnet on input and output and 10x on cache reads below 100K prompt tokens, 4x and 2x above. Cache reads: Sonnet 5.5 $0.10, Opus 5.5 $0.20, Fable 5.1 $0.25. Any correct delegation off the main thread saves tokens.

Prices and model ids are as of 2026-10-08; the Claude Code profiles use aliases (haiku, sonnet, opus, fable) so they track each machine's current model, which means this table can drift. Re-check before quoting a number.

## Opus 5.5 (launched 2026-09-22, cited: anthropic.com/claude-opus-5-5)
- "It performs at the level of Claude Fable 5.1 on most work and costs 40% less to run than Opus 5."
- "Input and output tokens are $4 and $20 per million, 20% less than Opus 5. Cache reads (which make up the majority of agentic and coding work costs) are $0.20 per million tokens, 60% less than Opus 5."
- "Opus 5.5 also generates output more than 30% faster than Opus 5."
- "much less likely than recent models to take hard-to-reverse actions or act outside the boundaries it's been given, and it's more resistant than Opus 5 to prompt injection."
- "Because Opus 5.5 is comparable to Claude Mythos 5.1 in biology and cybersecurity, we're deploying it with safeguards similar to those on Claude Fable 5.1."

Effort: Opus 5.5 accepts low, medium, high, xhigh, max. Anthropic's pre-launch Opus 5.5 migration guide (bundled inside Claude Code's `claude-api` skill, cached 2026-06-24; not a public web page, so treat as unconfirmed on the web) says the API default effort is `medium` (Opus 5's was `high`), thinking cannot be disabled, and at a given level Opus 5.5 thinks more per turn than Opus 5, especially at xhigh and max, so turns run longer. Steward never runs Opus at max (operator decision 2026-10-12). Steward profiles set effort explicitly, so the default does not affect them; the longer-turn point is why steward-delegation:deep-reasoner-opus-xhigh stays at xhigh only for the hardest work.

### Coder on Opus 5.5 (2026-09-22)
The earlier "Sonnet 5 xhigh for pure coding" preference was a Sonnet-versus-Haiku choice made 2026-09-03, before Opus 5.5 existed. It was never a preference against Opus 5.5, so Opus 5.5's launch supersedes it rather than overriding it.

Anthropic's pre-launch Opus 5.5 migration guide (same source as above: bundled in Claude Code's `claude-api` skill, cached 2026-06-24, not a public web page, unconfirmed on the web) states that at its default `medium` effort, Opus 5.5 "matched or beat Claude Opus 5's high-effort results" on multistep work in a real codebase, carrying a change through a large repository until its tests pass, "in fewer steps and with about half the tokens." It adds that "on several coding evaluations `low` comes close to it at much lower cost," and recommends: "Start at medium and test the neighboring levels; reserve xhigh and max for work where you have measured a quality gain." That workload, carrying a spec-and-tests change through a repository to green, is exactly the coder profile's job. `steward-delegation:coder-opus-medium` is set at `medium` on that basis.

Cost per token is 2x Sonnet 5 on input and output ($4/$20 versus $2/$10, see "Cost ranking" above), but cache reads tie at $0.20, and Anthropic's launch page says cache reads "make up the majority of agentic and coding work costs" (anthropic.com/claude-opus-5-5, 2026-09-22). Note 2026-10-09: the tie ended 2026-10-07, when Sonnet 5.5 cache reads dropped to $0.10 against Opus 5.5's $0.20. Fewer steps and fewer tokens per task, per the migration guide's claim above, narrow the per-token gap further. What matters is cost per completed task, not cost per token, and nobody has measured that for this profile yet; say so plainly rather than implying a saving that has not been checked.

If a `steward-delegation:coder-opus-medium` run misses its gate, escalate in one step: rerun the same profile (its frontmatter effort stands) and flag the miss to the deep-reasoner, or hand the task to `steward-delegation:deep-reasoner-opus-xhigh` directly.

Sonnet 5.5 stays pinned for everyday review, research, and writing; mechanical work moved to Haiku 5.5 on 2026-10-09 (see "Haiku 5.5" below). Its price is the point there, and the high-stakes path already runs on Opus.

## Sonnet 5.5 (launched 2026-09-28, cited: platform.claude.com/docs/en/models/sonnet-5-5/overview, fetched 2026-10-03)
- Model id `claude-sonnet-5-5`; 1M context, 128K max output; adaptive thinking; API default effort `high`; knowledge cutoff Jun 2026.
- Price is the same as Sonnet 5: $2/$10, cache reads $0.20 (pricing page, fetched 2026-10-03). Note 2026-10-09: cache reads dropped to $0.10 on 2026-10-07, ending the tie with Opus 5.5 at $0.20. Moving the sonnet profiles to it cost nothing extra per token; three sonnet profiles remain after 2026-10-09, when the mechanic moved to Haiku 5.5.
- Effort: the Models API on this machine's proxy reports low, medium, high, xhigh and max as supported (`GET /v1/models/claude-sonnet-5-5`, 2026-10-03), so the profiles' low, medium and high settings all apply.
- On Claude Code the profiles use the `sonnet` alias, which already resolves to Sonnet 5.5 here (see the alias caveat below). On pi the profiles name it directly: `anthropic/claude-sonnet-5-5`.

## Haiku 5.5 (launched 2026-10-07, cited: anthropic.com/claude-haiku-5-5, platform.claude.com/docs/en/build-with-claude/effort, fetched 2026-10-08)
- Model id `claude-haiku-5-5`; 1M context, 128K max output; the first Haiku with effort levels, all five (low, medium, high, xhigh, max); default effort `medium`.
- Two price cards: $0.10/$0.50, cache reads $0.01 for prompts up to 100K tokens; $0.50/$2.50, cache reads $0.05 for prompts over 100K tokens.
- Fit, in Anthropic's words: "best suited to more narrowly scoped tasks ... like compaction, summarization, or subagent work" and "Sonnet 5.5 and Opus 5.5 remain better choices for complex agentic coding tasks".
- Effort guidance: "Start with `medium` for most work, including agentic coding ... In long agent prompts, the model is more likely to skip a search, stop early, or skip a check at `low`". A bare steward subagent prompt is about 55K tokens, which is a long agent prompt, so the mechanic is pinned at medium, not low.
- Local probe, 2026-10-08: the same rename-and-test task gave a byte-identical correct diff on Haiku low (2 runs), medium (2), high (1) and Sonnet low (1), at $0.011 to $0.013 input-side cost per Haiku run against $0.136 for Sonnet low, at the same wall time, with no request over 100K.

### Why the other Sonnet profiles did not move
- Researcher: in the probe (one run per cell) Haiku high found more than Sonnet low at $0.135 versus $0.239, but took 195s versus 47s with 15 of 24 requests over the 100K card, and no measured invented-finding rate exists.
- Writer: in the probe Haiku high passed the prose checks but omitted facts Sonnet medium included.
- Reviewer: no Haiku code-review result exists, and on Artificial Analysis Terminal-Bench Haiku max scores 32.8% versus Sonnet high 43.9%.
- Coder: stays on Opus medium (Artificial Analysis index 51 at $1.34 per task versus Sonnet high 47 at $0.88 and Sonnet xhigh 52 at $2.01); cost per completed spec-coding task is still unmeasured.

Roundtable, 2026-10-09: four responding panelists (pi-seated DeepSeek, Qwen, MiniMax, Ember; GLM and MiMo returned nothing) agreed 4 of 4 on mechanic to Haiku and on keeping coder, deep-reasoner and writer; they split on mechanic effort (3 low, 1 medium), researcher (2 Sonnet low, 1 Sonnet medium, 1 Haiku high), reviewer (3 Sonnet high, 1 Opus medium) and the Fable profile (2 remove, 1 repoint to Opus max, 1 keep). The tables behind all of this are in `docs/evaluations/2026-10-09-model-assignment-evidence.md`.

### Reviewer stays on Sonnet 5.5 high (operator decision 2026-10-11)
Closes the 2026-10-09 open question on moving everyday review to Opus 5.5 medium. Everyday diff review stays on `steward-delegation:reviewer-sonnet-high`; diffs touching auth, payments, concurrency or data migrations, and other security-sensitive or high-stakes diffs, go to `steward-delegation:deep-reasoner-opus-xhigh`. This is the split CodeRabbit adopted for its own product and Pondero recommends.
- CodeRabbit Signal, 13 hard known-bug cases: Sonnet 5.5 thinking on caught 6/13 at 41.2% precision (35.3% without one 2-to-1 judge vote), thinking off 5/13 at 38.5%; Opus Standard 8/13 at 66.7%; Opus Max 10/13 at 52.0%. Counting outside-diff findings: Sonnet 8/13, both Opus configurations 10/13. Sonnet 5.5's Claude calls cost $0.47 per review; no Opus cost per review was published.
- CodeRabbit OSS August, 80 cases: Opus Standard 63.8% recall at 38.6% precision against a 61.3% baseline; Standard beat Max overall. Sonnet 5.5's judged scores on the 44-PR subset are still pending.
- CodeRabbit's choice: Sonnet 5.5 for simple and moderate reviews on every PR, Opus for high-risk changes. Pondero: Sonnet with thinking on for every PR, Opus for auth, payments, concurrency and migrations.
- Roundtable 2026-10-09: 3 of 4 responding panelists for Sonnet high, 1 for Opus medium.
- Gap: nearly every code-review figure traces to one vendor's test (CodeRabbit); 13 cases is a small sample; no Sonnet 5.5 versus Opus 5.5 head-to-head on ordinary PRs exists; GitHub's ReviewBench (219 PRs) had no Claude 5.5 rows as read 2026-10-11.
- Re-check when CodeRabbit publishes Sonnet 5.5's judged scores on the 44-PR set, or when any Sonnet 5.5 versus Opus 5.5 head-to-head on ordinary PRs appears.
Full figures: `docs/evaluations/2026-10-09-model-assignment-evidence.md`, section "Reviewer question, 2026-10-11".

## Top reviewer on Opus 5.5 xhigh; Opus never at max (operator decision 2026-10-12)
The operator decided on 2026-10-12: "Opus max must never be used." "max will always be opus 5.5 xhigh." From 0.13.0 the top reviewer runs Opus 5.5 at xhigh on Claude Code (`steward-delegation:reviewer-opus-max`, `effort: xhigh`), pi (`steward.top-reviewer`, `thinking: xhigh`) and GitHub Copilot (`steward-delegation:top-reviewer`, `reasoning_effort: xhigh`).
- Claude Opus never runs at max effort or thinking. Where a brief, a skill or the operator names max for Opus, use xhigh. Each edict states this rule; `plugins/steward-delegation/tests/test_no_opus_max.py` checks the profiles, the edicts and this file; the repo root's `tests/test_no_opus_max.py` checks the onboarding template, the README, this repo's `.pi/settings.json` and the example plans.
- The Claude Code profile keeps the name `reviewer-opus-max`. Renaming would break saved briefs, and Claude Code has no profile aliases.
- The top reviewer and `steward-delegation:deep-reasoner-opus-xhigh` now share model and effort. The top reviewer stays a separate profile for its role: a gap-review prompt, used on the operator's request or when a deep-reasoner pass is not enough.
- Fable 5.1 stays unpinned. A request for Fable by name still runs the top reviewer with a per-call Fable model at the level the operator names (`xhigh` if none).
- Codex is unchanged: its top reviewer is `gpt-6-astra`, not Opus.

This supersedes the 2026-10-11 section below, which stays as history.

## Top reviewer on Opus 5.5 max (operator decision 2026-10-11)
Superseded on 2026-10-12 by "Top reviewer on Opus 5.5 xhigh; Opus never at max" above; kept as history.
The top reviewer moved from Fable 5.1 at xhigh to `steward-delegation:reviewer-opus-max` (Opus 5.5, max) in 0.9.0. Fable 5.1 runs only when the operator asks for it by name: `subagent_type: steward-delegation:reviewer-opus-max`, `model: fable`, `effort` as the operator names (`xhigh` if none). Figures read 2026-10-11; cite them with that date, since one outlet notes Artificial Analysis rescaled its index between September snapshots.

Artificial Analysis (AA):
- artificialanalysis.ai/models/comparisons/claude-opus-5-5-xhigh-vs-claude-fable-5-1-xhigh: Intelligence Index Opus 5.5 56, Fable 5.1 53.
- artificialanalysis.ai/models/comparisons/claude-opus-5-5-vs-claude-fable-5-1 (max versus max): Index 58 vs 53; AA-Briefcase 1822 vs 1678; GDPval-AA 1846 vs 1735; AutomationBench-AA 70% vs 59%; Terminal-Bench 4.0 60% vs 52%; SciCode 67% vs 63%; Humanity's Last Exam 61% vs 59%. Time to first token at max: Fable 276s, Opus 685s.

Anthropic's table (anthropic.com/claude-opus-5-5): Opus 5.5 ahead on all nine rows. Terminal-Bench 4.0 66.4 vs 55.8; FrontierCode 54.4 vs 50.3; CursorBench 57.8 vs 51.8; GDPval-AA 1846 vs 1735; AutomationBench 40.0 vs 31.4; HLE with tools 67.7 vs 65.6; Terminal-Bench-Science 58.7 vs 52.6; OSWorld 2.0 81.8 vs 80.7; Chartography with tools 89.0 vs 88.4. Opus results are at max effort except Terminal-Bench, at xhigh.

Caveats:
- Fable leads at low effort: AA index 46.8 vs 42.3 (modelfatigue.news, reading AA on 2026-10-04). The top reviewer never runs at low, so this does not bear on the profile.
- Fable leads 2 of 11 AA per-test scores at xhigh (same source).
- Anthropic: "In our own use, the gap between Opus 5.5 and Claude Fable 5.1 is narrower than these scores suggest."
- Nothing tests dense plan or spec review, the profile's actual job.

Why max, not xhigh (history, superseded 2026-10-12):
- xhigh would duplicate `steward-delegation:deep-reasoner-opus-xhigh`; the top reviewer exists for the pass after that one falls short.
- AA index 58 at max vs 56 at xhigh, at $5.98 vs $3.46 cost per index task.
- CodeRabbit's Opus max configuration caught 10 of 13 hard bugs at 52.0% precision vs 8 of 13 at 66.7% for standard. Gap review values recall over precision, so the trade favors max.
- Max turns run long (about 119K output tokens per AA task, and the 685s time to first token above), which fits a rare, background, highest-stakes pass.

The evidence is also logged in `docs/evaluations/2026-10-09-model-assignment-evidence.md`, section "Re-verification of the Fable claim, 2026-10-11".

## Browser chores on Haiku 5.5 (operator decision 2026-10-12)
Ad-hoc browser chores (open a page, read, click, fill, count, screenshot via a CDP/chrome-devtools MCP server or playwright-cli) go to `steward-delegation:mechanic-haiku-medium` with a turn cap in the brief, not to the main thread.
- The subagent returns a short answer plus the evidence it saw: the URL, the page title, and the element text or counts. It never returns full snapshots.
- It hands back to the main thread for login walls and 2FA, for payment or destructive clicks, and for any flow that fails twice.
- Long multi-step flows and flaky dynamic UIs go to a stronger profile: `steward-delegation:researcher-sonnet-low` for read-only flows, `steward-delegation:coder-opus-medium` when the flow changes something.

Basis (all read 2026-10-12):
- Anthropic's Haiku 5.5 launch post, https://www.anthropic.com/claude-haiku-5-5 (2026-10-07): it "works especially well for speed-sensitive tasks like live customer support and browser use", "pairs well with Opus 5.5 and Sonnet 5.5 as a subagent", and is "best suited to more narrowly scoped tasks". OSWorld 2.1 offline subset: Haiku 5.5 72.4%, Sonnet 5.5 83.9%. Terminal-Bench 4.0: Haiku 39.2%, Sonnet 70.6%. Those gaps are why long or flaky flows go to a stronger profile.
- Claude Code subagent docs, https://code.claude.com/docs/en/sub-agents: the subagent "does that work in its own context and returns only the summary". Page snapshots stay in the subagent's context instead of the main thread's.
- Anthropic Help Center, https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code: Opus "uses meaningfully more of your quota", and Haiku is for "quick mechanical work".
- Checkly, https://www.checklyhq.com/blog/mcp-vs-cli-token-efficiency/ (2026-07-30): Playwright MCP and playwright-cli measured at "more or less the same token consumption" (45-50k tokens for one task). Picking one tool over the other saves little; moving the work off the main thread is the main saving.

## Dropped models (2026-09-22)
- **Haiku 4.5** ($1/$5/$0.10): dropped. Nearest retirement floor of any model in the matrix (tentative, not sooner than 2026-10-15, three weeks out at drop time; platform.claude.com/docs/en/about-claude/model-deprecations, fetched 2026-09-22), 200K context versus 1M for the rest, no effort dial, and Sonnet 5 at `low` effort now covers the same rote work with an explicit effort setting. Cost for that rote work doubles per token, $1/$5 to $2/$10. Those reasons (200K context, no effort dial, near retirement) do not apply to Haiku 5.5, which took the mechanic profile back on 2026-10-09; see "Haiku 5.5" above.
- **Opus 5** ($5/$25/$0.50): dropped. Superseded by Opus 5.5 at a 20% lower input/output price, 60% lower cache reads, and Fable-level quality on most work (anthropic.com/claude-opus-5-5, quoted above). The `opus` alias already resolves to Opus 5.5 on the installed Claude Code 2.1.280 binary here; see the alias-lag caveat below. Deprecation page: Active, tentative retirement not sooner than 2027-07-24.

Other matrix models' tentative retirement floors, same deprecations page: Sonnet 5 2027-06-30, Fable 5.1 2027-09-01. The models overview (platform.claude.com/docs/en/models/overview, fetched 2026-10-03) gives Opus 5.5 not sooner than 2027-09-22 and Sonnet 5.5 not sooner than 2027-09-28.

## Pinned profiles (in the steward-delegation plugin `agents/` directory), delegate by subagent_type
- **steward-delegation:coder-opus-medium** (opus, medium): pure implementation with spec and tests (TDD), well-defined bug fixes, approved plans. See "Coder on Opus 5.5" above for why it moved off Sonnet 5 xhigh.
- **steward-delegation:deep-reasoner-opus-xhigh** (opus, xhigh): architecture, ambiguous design, cross-repo synthesis/plans, security review, high-stakes/subtle code review. Escalate to the main thread only if it falls short.
- **steward-delegation:reviewer-sonnet-high** (sonnet, high): everyday code review of a diff/PR; diffs touching auth, payments, concurrency or data migrations go to steward-delegation:deep-reasoner-opus-xhigh.
- **steward-delegation:researcher-sonnet-low** (sonnet, low): thorough read-only investigation/search, plan inputs, findings docs.
- **steward-delegation:writer-sonnet-medium** (sonnet, medium): docs, README sections, substantive PR bodies, plain-language rewrites.
- **steward-delegation:mechanic-haiku-medium** (haiku, medium): single lookups, rote edits, file ops, running known commands, status collation, trivial PR one-liners. Returned to Haiku on 2026-10-09 (0.6.0), after running on Sonnet at low effort from 0.2.0, when Haiku 4.5 was dropped; see "Haiku 5.5" above.
- **steward-delegation:reviewer-opus-max** (opus, xhigh): highest-stakes gap reviews of plans/specs; use on the operator's request or when a deep-reasoner pass is not enough. Moved off Fable 5.1 xhigh on 2026-10-11 and to xhigh on 2026-10-12, since Claude Opus never runs at max; the name stays. Fable runs only by per-call `model: fable` override on the operator's request. See "Top reviewer on Opus 5.5 xhigh; Opus never at max" above.

## Rubric (task to profile)
| Task | Profile |
|-|-|
| Pure coding, spec+tests (TDD) | steward-delegation:coder-opus-medium (steward-delegation:mechanic-haiku-medium if single trivial file) |
| Refactor / simplify | steward-delegation:coder-opus-medium (steward-delegation:mechanic-haiku-medium for small rote refactors) |
| Deep architecture / ambiguous design | steward-delegation:deep-reasoner-opus-xhigh, escalate to main thread if short |
| Cross-repo synthesis / plan writing | steward-delegation:deep-reasoner-opus-xhigh (or a coordinator plus sonnet workers if huge and splittable) |
| Read-only investigation / search | steward-delegation:researcher-sonnet-low (steward-delegation:mechanic-haiku-medium for one targeted lookup) |
| Code review | steward-delegation:reviewer-sonnet-high (steward-delegation:deep-reasoner-opus-xhigh for auth, payments, concurrency, data migrations, or other high-stakes/complex) |
| Security review | steward-delegation:deep-reasoner-opus-xhigh |
| Mechanical edits / file ops | steward-delegation:mechanic-haiku-medium |
| Docs / prose | steward-delegation:writer-sonnet-medium (steward-delegation:mechanic-haiku-medium for short) |
| PR-body drafting | steward-delegation:writer-sonnet-medium (steward-delegation:mechanic-haiku-medium for trivial diffs) |
| Status / collation | steward-delegation:mechanic-haiku-medium (steward-delegation:researcher-sonnet-low if reconciling conflicting reports) |
| Ad-hoc browser chores (open a page, read, click, fill, count, screenshot via a CDP/chrome-devtools MCP server or playwright-cli) | steward-delegation:mechanic-haiku-medium with a turn cap in the brief (steward-delegation:researcher-sonnet-low or steward-delegation:coder-opus-medium for long multi-step flows or flaky dynamic UIs) |

Browser chores: the subagent returns a short answer plus the evidence it saw (URL, page title, the element text or counts), never full snapshots. It hands back to the main thread for login walls and 2FA, payment or destructive clicks, and any flow that fails twice. See "Browser chores on Haiku 5.5" below.

## Keep it inline on the main thread when
one dependent chain fits a single context with no splittable pieces; every step needs frontier judgment; the context is already resident in the orchestrator thread; it is the final synthesis/arbitration the orchestrator owns; or there is no cheap way to verify a delegate's output.

## Caveats to remember (do not overclaim)
- "Mythos-class, tier above Opus" is cited: anthropic.com/claude/fable says "Claude Fable 5.1 is a Mythos-level model." Primary-source validation on 2026-09-03 confirmed every other cited fact too (prices, 0.025x vs 0.1x cache reads, cost ranking, all four model ids then in the matrix, 1M/1M/1M/200K context windows, the Opus-at-half-price quote, the 47-55% savings figure). The 2026-09-22 revision re-verified pricing and deprecations against primary sources; see "Cost ranking", "Opus 5.5", and "Dropped models" above for those citations.
- Multi-model cost-savings percentages (the 40%, 20%, 60%, 30% figures above) are Anthropic's own comparisons against Opus 5, not guaranteed on any particular workload; measure before trusting a specific number.
- Pinned profiles are the default source of effort. A per-call Agent `effort` (Claude Code 2.1.292+) overrides a profile's frontmatter effort, but pass it only when the edict, a skill, or the operator names a level; a per-call `model` alone leaves effort unchanged (see "Model and effort mechanics" below).
- Aliases checked 2026-10-03 on Claude Code 2.1.288 by running `claude -p --model <alias>` and reading the model id from the JSON output: `sonnet` ran `claude-sonnet-5-5`, `opus` ran `claude-opus-5-5`, `fable` ran `claude-fable-5-1`. Checked 2026-10-08 on Claude Code 2.1.295: `haiku` ran `claude-haiku-5-5`; the docs require 2.1.293 or later.
- Alias lag: code.claude.com/docs/en/model-config, as crawled 2026-09-22, still says `opus` resolves to Opus 4.8 and `sonnet` to Sonnet 4.6, both behind the current launches. The installed Claude Code 2.1.280 binary on this machine labels its Opus picker entry "Opus 5.5 - best for everyday, complex tasks" and its default-model string names Opus 5.5, so `opus` means Opus 5.5 here; check the binary, not just the docs page, before trusting an alias. The env vars `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_FABLE_MODEL` override what an alias resolves to, and a full id in agent frontmatter overrides the alias too.

# Model and effort mechanics

Operational reference for choosing and setting a subagent's model and reasoning effort. Effort comes from the pinned profile's frontmatter by default; a per-call Agent `effort` parameter overrides it when a level is explicitly requested. Pair with the routing knowledge base above to decide WHICH model and effort; this section is HOW to set it. Sources: code.claude.com/docs/en/sub-agents.md and code.claude.com/docs/en/model-config.md (confirmed 2026-09-03; sub-agents page re-read 2026-10-11 for per-call effort), and the Claude Code changelog entry for 2.1.292. The earlier claim that effort is definition-only for subagents is outdated as of 2.1.292.

## Frontmatter keys (agent file in the steward-delegation plugin `agents/` directory)
Same YAML block:
- `model`: alias `sonnet` | `opus` | `haiku` | `fable`, OR a full id (for example `claude-sonnet-5-5`), OR `inherit`. The mechanic profile uses `haiku` as of 0.6.0.
- `effort`: `low` | `medium` | `high` | `xhigh` | `max` (which levels are valid is model-dependent).

Minimal example:
```markdown
---
name: example-profile-name
description: <when to use>
model: claude-sonnet-5-5
effort: xhigh
tools: <optional; omit to inherit all>
---
<system prompt>
```

## The rule that decides routing
**Pinned profiles are the default; per-call effort is for explicitly named levels.** Facts:
- code.claude.com/docs/en/sub-agents, "Choose an effort level" (read 2026-10-11): "To run a subagent at its own effort level, set the `effort` field in its definition. When you ask Claude to run a non-fork subagent at a specific effort level, it can also pass an `effort` parameter for that invocation. The parameter overrides the `effort` field and stays in effect when the subagent is resumed. The `CLAUDE_CODE_EFFORT_LEVEL` environment variable takes precedence over both. The per-invocation parameter requires Claude Code v2.1.292 or later."
- Same page, frontmatter table, `effort`: "Overrides the session effort level, but not the `CLAUDE_CODE_EFFORT_LEVEL` environment variable."
- Changelog 2.1.292: "Added an `effort` parameter to the Agent tool, so Claude runs a sub-agent at the effort level you ask for".
- The Agent tool's schema says to set `effort` only when the user, or instructions such as CLAUDE.md or a skill, explicitly ask for a level, never on the agent's own judgment, and that a fork ignores it.
- Local evidence 2026-10-08, Claude Code 2.1.295: runs of the mechanic profile, then named `mechanic-sonnet-low` in the steward plugin (frontmatter effort low; its name before 0.6.0 moved it to Haiku) with per-call `effort: medium` and `effort: high` recorded medium and high in their run logs, so the override works.

So:
- Delegate via `subagent_type` to a pinned profile; its frontmatter `model` and `effort` apply. Omit per-call `effort` unless the edict, a skill, or the operator names a level.
- When a level is named, pass `effort` on that call; it overrides the profile's frontmatter for that invocation and any resume.
- `model` can be overridden per-invocation (Agent tool `model`), and that override sits at the top of the model-resolution order. A per-call `model` alone does not change effort; the profile's frontmatter effort still applies. Example: the operator's Fable request runs as `subagent_type: steward-delegation:reviewer-opus-max`, `model: fable`, `effort: xhigh` (or the level the operator names).

## Independence and inheritance
- `model` and `effort` do not interact: overriding the model does not reset effort.
- `model: inherit` does not imply effort inherits. Effort inherits from the parent only when the `effort` key is omitted. Set both explicitly to be safe.

## Effort can be set four ways (for a subagent, highest precedence first)
1. Env `CLAUDE_CODE_EFFORT_LEVEL`: outranks both the per-call parameter and frontmatter (sub-agents page, quoted above).
2. Per-call Agent `effort` parameter: Claude Code 2.1.292+, overrides frontmatter, persists on resume, ignored by forks. Pass it only for an explicitly named level.
3. Agent-file frontmatter `effort:`: overrides the session effort level (use this for pinned profiles).
4. Session-level settings: `--effort` flag, `/effort` command, `settings.json` `effortLevel` or `modelSettings.<model>.effortLevel`. Their order relative to one another is not stated in the docs quoted here.

## Caveats
- Version note: before v2.1.251, `CLAUDE_CODE_SUBAGENT_MODEL` outranked both per-invocation `model` and frontmatter `model`; on current versions per-invocation `model` is top.
- `effort` frontmatter is ignored on the `--agent <name>` session-persona path while `model` still applies (community report GitHub #81677, v2.1.219/220; confirmed locally 2026-10-11 on Claude Code 2.1.296 with `settings.json` `effortLevel: xhigh`: `claude -p --agent steward-delegation:reviewer-opus-max` ran `claude-opus-5-5` at xhigh, while the same profile delegated through the Agent tool with no per-call `effort` ran `claude-opus-5-5` at max, read from each run's log). Normal Agent-tool subagents honor frontmatter effort over the session level. If a pinned profile seems to ignore effort, check which path launched it.

## How to apply this
Delegate by `subagent_type` to the pinned profile agents in the steward-delegation plugin `agents/` directory (model and effort fixed) for the recurring task archetypes. Pass a per-call `effort` only when the edict, a skill, or the operator names a level; otherwise omit it so the profile's frontmatter effort stands. Use the Agent `model` override to swap a profile's model; it keeps the profile's effort unless `effort` is passed too. Do not use per-call `effort` to redesign escalation: after a missed gate, rerun the same profile or hand the task to the deep-reasoner.
