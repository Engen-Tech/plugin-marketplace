---
name: hatch-plainlanguage
model: sonnet
effort: medium
description: Write or revise prose so a real reader can use it on the first read. Apply this whenever drafting or editing user-facing writing — documentation, READMEs, guides, announcements, emails, policies, regulations, release notes, help text, error messages, public-facing copy, or any message someone has to act on. Also apply when the user says "make this clearer," "simplify this," "rewrite in plain English," "less jargon," "tighten this up," asks for an edit pass on existing prose, or wants text to read less like AI/LLM output — "remove the AI tells," "de-slop this," "make it sound human-written," "less ChatGPT-sounding." Skip for code, code comments, commit messages, and internal log lines — those follow different conventions.
---

# Plain Language

Adapted from the U.S. federal Plain Language guidance (digital.gov) and the Plain Writing Act of 2010. The goal of plain language is not "dumbed-down" writing — it's writing that a specific reader can act on without rereading.

## Two passes: de-LLM, then plain language

Run prose through two passes, in this order:

1. **Phase 1 — De-LLM.** Strip the tics of AI-generated writing. Start with *structure* — sentence-length uniformity, rhetorical triads, blanket hedging, evenly-weighted paragraphs — then the lexical tells: inflated vocabulary, hollow significance claims, copula avoidance, fake-punch fragments, formatting. This removes *noise* — the residue that makes text sound generated rather than written.
2. **Phase 2 — Plain language.** Everything from "The one rule" down. This adds *signal* — reader focus, the bottom line up front, active voice, and structure the reader can scan.

Do Phase 1 first. A de-LLM'd draft is shorter and more honest, which makes the Phase 2 decisions (what's the bottom line, who's the reader, what can be cut) much easier. Running Phase 2 on slop just polishes the slop.

The two passes mostly reinforce each other, with four seams worth knowing:

- **Sentence length.** Phase 1 rejoins fragments split for drama ("It works. Every time." → "It works every time."); Phase 2 breaks sentences that are genuinely overstuffed. Rejoin first, then split what's still too long. No conflict.
- **Sentence *variance*.** Applied mechanically, Phase 2's "break long sentences" produces a page of uniform medium-length sentences — which is itself the strongest structural AI tell. Break the overstuffed ones, then check the spread. A passage where every sentence lands in the 15–25 word band reads as generated no matter how plain the words are. Leave the short ones short.
- **Em dashes.** Phase 1 trims em dashes used for *false drama*; plain language still uses the em dash for an ordinary aside. Calibrate on density (two or three per 200 words is a signal), not presence. Stripping them all is its own tell.
- **Formatting.** Phase 2 pushes toward tables, lists and subheads for scannability. Phase 1 warns against over-formatting and evenly-weighted sections. Both are right: structure the material the reader must navigate, but do not give every item the same wordcount just because it sits in the same list. Real emphasis is uneven.

**Phase 1 in brief** (full catalog with replacement lists in [de-llm.md](de-llm.md)):

- **Fix structure first — this is where the signal is.** Vary sentence length so the spread is uneven. Break rhetorical triads. Delete the hedge on every claim. Let unimportant items be short instead of padding them to match. Replace abstraction with the concrete case. Cut the sentence that explains the point the reader just read. The word lists below are worth running, but a text can pass all of them and still read as generated; surface edits alone move AI-detection by about a point.
- **Cut AI vocabulary**: delve, leverage, crucial/pivotal/key, foster, garner, tapestry, landscape, vibrant, showcase, intricate, testament, underscore — replace with the plain word or delete. Also the newer register that moved in behind these: the "quiet" family (*quietly building*, *quiet confidence*), *shift*, *matters*, *earn*, *compound*, *the work*.
- **Delete chat leakage**: "Great question!", "I hope this helps!", "Certainly! Here's…", trailing offers to continue. Not a style tell — hard evidence.
- **Kill significance claims**: "stands as a testament to," "plays a vital role," "marks a turning point," "reflects broader trends" — delete or state the fact plainly.
- **Drop hollow -ing tails**: "..., highlighting the importance of X," "..., underscoring the significance of Y," "..., ensuring Z" — delete.
- **Undo copula avoidance**: "serves as / stands as / represents" → **is**; "boasts / features / offers" → **has**.
- **Simplify negative parallelism and rule-of-three**: "Not only X, but Y" → "X and Y"; trim "adjective, adjective, and adjective" triplets.
- **Rejoin dramatic fragments**: strings of two-to-four-word punch "sentences" → one normal sentence.
- **Fix formatting tells**: title-case headings → sentence case; remove excessive bold; convert "**Term:** description" bullet lists to prose; curly quotes → straight quotes.
- **Remove meta-commentary and conclusion patterns**: "It's important to note," "It's worth noting," "In summary," "In conclusion," "Overall," knowledge-cutoff disclaimers.
- **Replace vague attributions**: "experts argue," "some critics say," "several sources" → name the source or cut.

When the user hands you AI-generated text and asks for a rewrite, run both passes and **lead with the rewritten prose**, then a short note on what changed. When they explicitly ask only to "de-slop" or "remove AI tells," Phase 1 may be enough — but a light Phase 2 read almost always helps; mention if you skipped it.

## The one rule

**Write for the reader, not the writer.** Most other rules in this skill are corollaries.

A reader opens a doc, an email, or a policy with a job to do — apply for the grant, fix the build, decide whether to upgrade. They are not curling up by a fire to enjoy the prose. Match their vocabulary, tell them what applies to them, and put what they need where they'll look first.

This means the same idea may need different prose for different audiences. Don't write for an 8th grader if your readers are PhDs; don't write for PhDs if your readers are working parents. When in doubt, ask: *who is going to read this, and what do they need to walk away with?*

## Before you write

Answer these in your head (or on paper) before drafting:

- Who is the reader?
- What do they already know?
- What do they need to learn or decide?
- What questions will they show up with?
- What outcome does the reader want? What outcome do you want?

If you can't answer "who is the reader," stop and ask. Generic content for "anyone" tends to serve no one.

When the document genuinely has multiple audiences (e.g., applicants vs. reviewers, end users vs. ops), address them in **separate sections** rather than mixing the material. Mixed audiences are the most common cause of "I couldn't find what applied to me" complaints.

## Organize for scanning, not reading

People scan first and read second. Optimize for the scan.

- **Lead with the bottom line — Bottom Line Up Front (BLUF).** State the purpose, the answer, or the action in the first sentence or two. Background goes near the end if it goes in at all.
- **One topic sentence per paragraph.** A reader skimming first sentences should get the gist of the whole document.
- **Use a real table of contents or subheadings on anything long.** Subheads should read like a roadmap of the reader's actual journey, not a taxonomy of your topic.
- **Pick an order and commit to it.** Two orders work well by default:
  - **Process order** — present steps in the sequence the reader will perform them. Best for how-tos, onboarding, regulations, applications.
  - **General first, exceptions later** — cover what applies to most readers, then handle conditions, edge cases, and specialized rules. Best for policy and reference material.
- **Use tables and lists when structure is parallel.** Side-by-side comparisons and *if/then* routing decisions belong in a table — e.g., "If you submit expenses → do X. If you approve expenses → do Y." Five parallel items belong in a list, not a sentence.
- **Frame sections from the reader's point of view.** Prefer "How do I apply?" over "Application Procedures." Prefer "If you want X, do Y" over passive descriptions of what the system does.

## Short and simple

Wordiness is the single biggest issue in institutional writing. Tightening is mostly about deleting, not rewriting.

### Cut unnecessary words and filler modifiers

Read each sentence and ask: *does this word earn its place?* Empty modifiers like *absolutely, actually, completely, really, quite, totally, very, particularly, somewhat* almost always weaken sentences rather than strengthen them — and meaningless adjectives like *joint* sneak in too.

| Say | Instead of |
|-|-|
| HUD and FAA issued a report. | HUD and FAA issued a joint report. |
| This information is critical. | This information is really critical. |
| Their claim was absurd. | Their claim was totally unrealistic. |
| It is difficult to reconcile the team's differing views. | It is particularly difficult to reconcile the somewhat differing views expressed by the management team. |
| Disclosing all facts is important to an accurate picture of the agency's finances. | Total disclosure of all facts is very important to make sure we draw up a total and completely accurate picture of the agency's financial position. |

### Cut doublets and triplets

Legal-style phrasing often pairs two or three near-synonyms. Pick one.

| Say | Instead of |
|-|-|
| Due | Due and payable |
| Stop | Cease and desist |
| Either knowledge or information | Knowledge and information |
| Help | Aid and assist |
| Use | Use and employ |

### Prefer pronouns, active voice, and base verbs

These three together tend to remove a quarter of the words from typical institutional writing without changing meaning.

- Pronouns: "**you** must submit" instead of "the applicant must submit"
- Active voice: "**we will review** your form" instead of "your form will be reviewed"
- Base verbs (watch for verbs hidden inside nouns): "**decide**" instead of "make a decision"; "**apply**" instead of "submit an application"; "**examine**" instead of "perform an examination of"; "**investigate**" instead of "conduct an investigation of". *Made a decision*, *performed an examination*, *conducted an investigation* — all carry filler. Reach for the verb.

### Use familiar words

Inflated formal vocabulary is the #1 jargon source after technical terms. Reach for the everyday word.

| Say | Instead of |
|-|-|
| use | utilize |
| help | assist |
| about | regarding |
| before | prior to |
| after | subsequent to |
| because | due to the fact that |
| enough | sufficient |
| must | is required to |
| now | at this point in time |
| if | in the event that |
| to | in order to |

### Stay consistent

Don't reach for synonyms to keep prose "interesting." If you call them *senior citizens* in paragraph one, don't switch to *the elderly* in paragraph three — the reader will wonder if you mean a different group. Federal-style and technical writing aren't literature. Clarity beats variety.

## Avoid jargon

Jargon is language that signals expertise to insiders rather than communicating to readers. The fix is not to strip out all technical terms — sometimes a *brinulator valve control ring* really is the only correct name for the thing — but to use technical terms only when they pull their weight.

A useful test: would a reader in your target audience have to pause to look this up? If yes, and there's a plainer word that means the same thing, use the plainer word.

| Say | Instead of |
|-|-|
| Tighten the brinulator valve control ring securely. | Apply sufficient torque to the brinulator valve control ring to ensure that the control ring assembly is securely attached to the terminal such that loosening cannot occur under normal conditions. |
| River birds | Riverine avifauna |
| Unhoused | Involuntarily undomiciled |
| The patient is on a respirator. | The patient is being given positive-pressure ventilatory support. |
| The exhaust gas eventually damages the coating of most existing ceramics. | Most refractory coatings to date exhibit a lack of reliability when subject to the impingement of entrained particulate matter in the propellant stream under extended firing durations. |

### Definitions

When you do need a technical term, define it where the reader meets it. A few rules of thumb:

- Avoid front-loaded definition sections that the reader has to wade through before getting to anything actionable.
- If you must collect definitions, put them at the **end** and list them **alphabetically** (don't number them — alphabetical lets you add or remove terms without renumbering, and lets the reader find what they want).
- **Don't define common words** with their ordinary meaning. Defining *bicycle* as "every device propelled solely by human power upon which a person or persons may ride on land, having one, two, or more wheels, except a manual wheelchair" actively confuses the reader.
- **Don't define words you don't use.** Readers see a definition and expect that term to appear later. If it doesn't, they hunt for it and lose trust.

## When you're given existing prose to revise

Work in this order — it produces the largest improvement for the least effort:

1. **Identify the audience and the action.** Who reads this? What do they need to do? If the original doesn't make this clear, your revision should.
2. **Move the bottom line to the top.** Lead paragraph should answer "what is this and what do I do?"
3. **Cut filler.** One pass for unnecessary modifiers, one pass for doublets, one pass for whole sentences that don't earn their place.
4. **Swap jargon for everyday words** where the meaning survives the swap.
5. **Convert to active voice and second-person** ("you") where appropriate.
6. **Break long sentences** at natural seams. A sentence with three commas and an *and* is usually two sentences.
7. **Add subheads or a list** if the reader has to navigate a wall of text.
8. **Read it aloud, or whisper it.** Sentences that are hard to say are hard to read.

When the user hands you prose and asks for a rewrite, **lead with the rewritten prose**. If a change is non-obvious, follow with one or two short notes ("moved the bottom line up; split the manager and vendor steps into separate sections"). Don't narrate every edit — they can read the diff.

## Red flags to scan for in your own draft

When proofreading, these patterns almost always mean you can tighten:

- **Empty openers**: *"It is important to note that…", "There are several reasons why…", "It should be observed that…"* — cut them and start with the actual point.
- **Buried subjects**: a sentence with two clauses before the subject appears. The reader is hunting for the actor.
- **Stacked conditions**: *"If X, and provided that Y, except where Z…"* — usually three sentences.
- **A paragraph whose first sentence isn't the topic**. The lead has been buried.
- **Different terms for the same thing** across sections — drift introduced during editing.
- **Definitions of words a reader already knows.**
- **Verbs hiding inside nouns**: *make a decision, conduct an analysis, give consideration to.*

## A short checklist before shipping

- [ ] Sentence lengths are uneven — short ones next to long ones, not a uniform 15–25 word band (Phase 1).
- [ ] No AI tells remain — rhetorical triads, blanket hedging, evenly-weighted sections, inflated vocabulary, significance claims, hollow -ing tails, copula avoidance, fake-punch fragments, meta-commentary, chat leakage (Phase 1; see [de-llm.md](de-llm.md)).
- [ ] A new reader can tell, from the first paragraph or first screen, what this is and what to do with it.
- [ ] If there's more than one audience, each one has its own clearly-marked section.
- [ ] Section headings answer reader questions, not document the topic.
- [ ] No unnecessary modifiers, doublets, or triplets remain.
- [ ] Technical terms are either familiar to the audience or defined where they appear.
- [ ] Voice is active and uses *you* / *we* where natural.
- [ ] Long lists or steps are formatted as lists, not buried in prose.
- [ ] Same concept = same word throughout.

The standard, in one line: **a reader from the intended audience can read it once and act.**

## What this skill is *not* for

- Code or code comments — those follow language idioms, not prose conventions.
- Commit messages and changelogs — terse, structured, often imperative; their own genre.
- Marketing copy where voice and persuasion matter more than instruction.
- Literary or expressive writing.
- Internal logs, telemetry, error strings meant for machines.

If the user is writing one of those, mention you noticed and ask whether they still want a plain-language pass — sometimes they do, sometimes not.
