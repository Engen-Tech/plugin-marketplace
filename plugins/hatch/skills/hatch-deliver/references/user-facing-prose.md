# User-facing prose is plain language

Everything hatch shows a person is written in plain language: a reader from the intended audience can read it once and act. This is the standard for every report, halt message, prompt, and summary hatch emits. The full reference is the bundled **hatch-plainlanguage** skill; this file is the short, self-contained version a skill session can apply without leaving its context.

## What this covers

|-|-|
| Apply plain language | Skip it |
|-|-|
| Run reports and summaries | Code and code comments |
| Halt and escalation calls-to-action | Commit messages, commit/ref markers |
| The Phase-4 four-way prompt and its questions | Git ref names and tags |
| Plan summaries and opt-out summaries | The binder JSON |
| Verdict summaries, "produced no changes", BLOCKED messages | The machine return envelope (the YAML the next stage reads) |
| Any message a person has to act on | Internal logs and telemetry |

The machine envelope is read by the next stage, not a person — leave it in its exact schema. Plain language is for the prose a human reads.

## The moves

- **Lead with the bottom line.** First sentence says the outcome or the action: what passed, what halted, what you need to decide. Background comes after, or not at all.
- **Plain words.** "use" not "utilize", "before" not "prior to", "now" not "at this point in time", "must" not "is required to". Cut empty modifiers (very, actually, really) and doublets (cease and desist → stop).
- **Short.** One topic per paragraph. Break a sentence with three commas into two. Delete words that do not earn their place.
- **Scannable.** Parallel items go in a list or a table, not a run-on sentence. For a halt, the ways forward are a short list, each one an action the reader can take.
- **Active voice and "you".** "hatch merged your item" not "the item was merged"; "you can accept or defer" not "an accept/defer decision may be made".
- **One name per thing.** Don't rename a concept to vary the prose — same idea, same word throughout.

## What plain does not change

Clarity, not meaning. Keep every operational claim, condition, ref name, marker, and invariant exactly as it is. Do not soften a rule ("the orchestrator is the single writer of the integration tip" stays absolute), drop a precondition, or rename a ref while making prose read better. If a precise term is the only correct name for the thing, keep it — plain language removes needless jargon, not necessary precision.
