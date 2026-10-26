---
name: plainlanguage
description: Write or revise prose so a real reader can use it on the first read. Apply this whenever drafting or editing user-facing writing — documentation, READMEs, guides, announcements, emails, policies, regulations, release notes, help text, user-facing error messages, public-facing copy, or any message someone has to act on. Also apply when the user says "make this clearer," "simplify this," "rewrite in plain English," "less jargon," "tighten this up," asks for an edit pass on existing prose, or wants text to read less like AI/LLM output — "remove the AI tells," "de-slop this," "make it sound human-written," "less ChatGPT-sounding." Skip for code, code comments, commit messages, internal log lines, and machine-facing error strings — those follow different conventions.
---

# Plain Language

Adapted from the U.S. federal Plain Language guidance (digital.gov) and the Plain Writing Act of 2010. The goal of plain language is not "dumbed-down" writing — it's writing that a specific reader can act on without rereading.

**The goal is reader usefulness, not the absence of AI fingerprints.** Use the de-LLM catalog to remove noise, then stop — before the text becomes strange, over-formal, or performatively human. A text can be clear, useful, and human-sounding without looking like it was never near a model.

## Pick the job first

Three different requests hide behind "fix this writing." Decide which one you were handed before touching anything:

| Job | Trigger | What you do |
|-|-|-|
| **Clarify** | "make this clearer," "simplify," "less jargon," "rewrite for X audience" | Phase 2 only. Restructure freely. |
| **De-slop** | "remove the AI tells," "de-slop this," "sound less like ChatGPT" | Phase 1 only. Keep the document's architecture. |
| **Both** | AI-generated draft handed over for a real rewrite; no constraint stated | Phase 1, then Phase 2. |

A de-slop request is not a licence to reorganize the document, and a clarify request is not a licence to hunt for tells. When the ask is ambiguous, do **Both** and say so in one line.

Two senses of "structure" collide here, so be precise about which one a de-slop pass may touch:

- **Document architecture** — section order, headings, what lives where, what the piece argues. A de-slop pass leaves this alone. Only **Clarify** and **Both** may move it.
- **Prose structure** — sentence rhythm, paragraph weighting, triads, hedging, fragments. This is category 0 of the catalog and it *is* the de-slop pass. Fixing it is the job, not scope creep.

Then decide the reader:

- Who is this for, and what do they already know?
- What must they do after reading?
- What mistake are they likely to make?

If the audience is genuinely unclear, ask. If the user didn't specify and asking would stall the work, assume the most likely professional audience and **state that assumption** with the rewrite.

## What to protect, in order

When two rules in this skill collide, the higher item wins:

1. **Facts, obligations, deadlines, numbers, exceptions.** Never casualties of style.
2. **Reader action.** What the reader must do, and when.
3. **Structure.** Can a reader find the part that applies to them?
4. **Word choice.** Plain words, active voice, no jargon that isn't earning its place.
5. **AI-tic removal.** Vocabulary, rhythm, fragments, hedging.
6. **Rhythm and voice.** Variance, emphasis, personality.

**If an edit makes the reader less able to act, don't make it.** That single test resolves most of the conflicts below.

## Do not overcorrect

The failure mode of this skill is a text that has been scrubbed until it reads like nobody wrote it. Do not:

- Replace every em dash, or every triad, or every hedge — calibrate on density and function.
- Force sentences to different lengths when the meaning wants uniform ones.
- Add casual language, contractions, anecdotes, or sensory detail to sound human. Invented voice is a worse tell than the one you removed.
- Turn a policy into a blog post, or formal register into chattiness.
- Add facts, causes, or context that were not in the source.
- Delete a caveat that carries legal, safety, or operational meaning.
- Flatten a text past what the material justifies.

**If a pattern is just the writer's voice, leave it alone.** Frequency and function decide, not presence.

## Two passes: de-LLM, then plain language

For the **Both** job, run these in order:

1. **Phase 1 — De-LLM.** Strip the tics of AI-generated writing. Start with *structure* — sentence-length uniformity, rhetorical triads, blanket hedging, evenly-weighted paragraphs — then the lexical tells. This removes *noise*.
2. **Phase 2 — Plain language.** Everything from "The one rule" down. This adds *signal* — reader focus, the bottom line up front, active voice, scannable structure.

Phase 1 first. A de-LLM'd draft is shorter and more honest, which makes the Phase 2 decisions easier. Running Phase 2 on slop just polishes the slop.

Four seams where the passes appear to disagree:

- **Sentence length.** Phase 1 rejoins fragments split for drama ("It works. Every time." → "It works every time."); Phase 2 breaks genuinely overstuffed sentences. Rejoin first, then split what's still too long.
- **Sentence *variance*.** Applied mechanically, Phase 2's "break long sentences" produces a page of uniform medium-length sentences — itself the strongest structural AI tell. Break the overstuffed ones, then check the spread. Leave the short ones short.
- **Em dashes.** Phase 1 trims em dashes used for false drama; plain language still uses one for an ordinary aside. Calibrate on density, not presence.
- **Formatting.** Phase 2 pushes toward tables, lists, subheads. Phase 1 warns against over-formatting and evenly-weighted sections. Both are right: structure what the reader must navigate, but don't pad every item to the same wordcount. Real emphasis is uneven.

### Phase 1 in brief

**[de-llm.md](de-llm.md) is the source of truth for the catalog.** Read it for anything more than a quick pass — every list, every calibration rule, and the overcorrection guardrails live there.

Priority order: **structure first** (sentence-length uniformity, rhetorical triads, hedging on every claim, evenly-weighted sections, abstraction where a concrete case belongs, sentences that restate the point just made), then **hard evidence** (chat leakage: "Great question!", "I hope this helps!"), then **vocabulary and formatting** (delve, leverage, crucial, foster, showcase, testament, underscore; the "quiet" family; significance claims; hollow *-ing* tails; copula avoidance; dramatic fragments; title-case headings). Surface edits alone move AI-detection by about a point — a text can pass every word list and still read as generated.

## The one rule

**Write for the reader, not the writer.** Most other rules in this skill are corollaries. **If an edit makes the reader less able to act, don't make it.**

A reader opens a doc, an email, or a policy with a job to do — apply for the grant, fix the build, decide whether to upgrade. They are not curling up by a fire to enjoy the prose. Match their vocabulary, tell them what applies to them, and put what they need where they'll look first.

The same idea may need different prose for different audiences. Don't write for an 8th grader if your readers are PhDs; don't write for PhDs if your readers are working parents.

## Before you write

Answer these before drafting:

- Who is the reader?
- What do they already know?
- What do they need to learn or decide?
- What questions will they show up with?
- What outcome does the reader want? What outcome do you want?

If you can't answer "who is the reader," stop and ask. Generic content for "anyone" tends to serve no one.

When the document genuinely has multiple audiences (applicants vs. reviewers, end users vs. ops), address them in **separate sections**. Mixed audiences are the most common cause of "I couldn't find what applied to me."

## Organize for scanning, not reading

People scan first and read second. Optimize for the scan.

- **Lead with the bottom line — Bottom Line Up Front (BLUF).** State the purpose, the answer, or the action in the first sentence or two. Background goes near the end if it goes in at all.
- **One topic sentence per paragraph.** A reader skimming first sentences should get the gist of the whole document.
- **Use a real table of contents or subheadings on anything long.** Subheads should read like a roadmap of the reader's journey, not a taxonomy of your topic.
- **Pick an order and commit to it.**
  - **Process order** — steps in the sequence the reader performs them. Best for how-tos, onboarding, regulations, applications.
  - **General first, exceptions later** — what applies to most readers, then conditions and edge cases. Best for policy and reference material.
- **Use tables and lists when structure is parallel.** *If/then* routing belongs in a table — "If you submit expenses → do X. If you approve expenses → do Y." Five parallel items belong in a list, not a sentence.
- **Frame sections from the reader's point of view.** Prefer "How do I apply?" over "Application Procedures."

## Short and simple

Wordiness is the single biggest issue in institutional writing. Tightening is mostly about deleting, not rewriting.

### Cut unnecessary words and filler modifiers

Read each sentence and ask: *does this word earn its place?* Empty modifiers like *absolutely, actually, completely, really, quite, totally, very, particularly, somewhat* almost always weaken sentences — and meaningless adjectives like *joint* sneak in too.

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
- Base verbs (watch for verbs hidden inside nouns): "**decide**" instead of "make a decision"; "**apply**" instead of "submit an application"; "**examine**" instead of "perform an examination of"; "**investigate**" instead of "conduct an investigation of".

### Use familiar words

Inflated formal vocabulary is the #1 jargon source after technical terms.

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

Exception: `must / should / may / cannot` are load-bearing — see "High-stakes writing" below. Never swap one for another while simplifying.

### Stay consistent

Don't reach for synonyms to keep prose "interesting." If you call them *senior citizens* in paragraph one, don't switch to *the elderly* in paragraph three — the reader will wonder if you mean a different group. Clarity beats variety.

## Avoid jargon

Jargon is language that signals expertise to insiders rather than communicating to readers. The fix is not to strip out all technical terms — sometimes a *brinulator valve control ring* really is the only correct name for the thing — but to use technical terms only when they pull their weight.

A useful test: would a reader in your target audience have to pause and look this up? If yes, and a plainer word means the same thing, use the plainer word.

| Say | Instead of |
|-|-|
| Tighten the brinulator valve control ring securely. | Apply sufficient torque to the brinulator valve control ring to ensure that the control ring assembly is securely attached to the terminal such that loosening cannot occur under normal conditions. |
| River birds | Riverine avifauna |
| Unhoused | Involuntarily undomiciled |
| The patient is on a respirator. | The patient is being given positive-pressure ventilatory support. |
| The exhaust gas eventually damages the coating of most existing ceramics. | Most refractory coatings to date exhibit a lack of reliability when subject to the impingement of entrained particulate matter in the propellant stream under extended firing durations. |

### Definitions

Define a technical term where the reader meets it.

- Avoid front-loaded definition sections the reader must wade through before anything actionable.
- If you must collect definitions, put them at the **end**, **alphabetically** — no numbering, so terms can be added or removed freely.
- **Don't define common words** with their ordinary meaning. Defining *bicycle* as "every device propelled solely by human power upon which a person or persons may ride on land, having one, two, or more wheels, except a manual wheelchair" actively confuses the reader.
- **Don't define words you don't use.** Readers see a definition and expect the term later. If it never appears, they hunt for it and lose trust.

## High-stakes writing

For legal, regulatory, safety, compliance, medical, and financial text, plain language improves structure and word choice. It must not change rights, obligations, exceptions, deadlines, or risk.

- **Preserve the modal exactly.** *Must*, *should*, *may*, *cannot*, and *will* are different obligations. If the source says "you may update within 30 days," the rewrite says *may* — not "you need to."
- **Keep real uncertainty; cut empty hedging.** Delete "it is important to note that this may only apply in some cases." Keep the condition it was hiding: "This applies only to federal employees." If the uncertainty is genuine, state what it depends on.
- **Add no facts that weren't in the source.** No causes, dates, background, or motivations you inferred. If context genuinely helps and it's common knowledge, mark it as an addition so the author can approve or strike it. When unsure, ask.
- **Preserve every number, date, threshold, and named exception** verbatim unless the user asks you to change one.

## Genre notes

Different documents fail differently. Common ones:

| Genre | What matters most |
|-|-|
| Technical how-to | Steps exact and in order; active voice; no hype. Use [ste100.md](ste100.md) when a stranger must follow it unaided |
| Policy / regulation | Modals preserved; if/then routing; exceptions findable |
| Release notes | What changed, who's affected, what to do |
| Announcement | Persuasive tone kept; unsupported claims cut |
| Legal notice | Clarify wording and structure; never touch obligations |
| AI-generated essay | Fix structure first, then vocabulary |
| User-facing error message | Say what happened and what to do next |
| Marketing copy | Preserve voice unless asked; remove obvious AI tics only |

## Controlled register (STE100)

When the document is one a stranger has to execute without asking anyone, and the user asked for it or the house standard requires it, write it in a controlled register: ASD-STE100 Simplified Technical English. Apply it to the procedural and safety passages, not to the surrounding prose.

[ste100.md](ste100.md) carries the rules, the limits, and the approved words. The three that change output most: 20-word instruction sentences and 25-word descriptive ones; one instruction per sentence, in the imperative; no semicolons, contractions, or dropped articles. Safety writing has its own structure: warning for injury or death, caution for equipment damage, note for information only.

The register is stricter than this skill and chooses plainer, more repetitive wording on purpose, so inside a register passage it overrides the de-LLM preference for rhythm variance. It never overrides "What to protect": facts, obligations, and safety levels stay exactly as the source gives them, and no step, condition, or warning is dropped to make a word count.

## When you're given existing prose to revise

Work in this order — largest improvement for the least effort:

1. **Identify the audience and the action.** If the original doesn't make this clear, your revision should.
2. **Move the bottom line to the top.** The lead paragraph answers "what is this and what do I do?"
3. **Cut filler.** One pass for modifiers, one for doublets, one for whole sentences that don't earn their place.
4. **Swap jargon for everyday words** where the meaning survives the swap.
5. **Convert to active voice and second person** where appropriate.
6. **Break long sentences** at natural seams. A sentence with three commas and an *and* is usually two sentences.
7. **Add subheads or a list** if the reader has to navigate a wall of text.
8. **Read it aloud, or whisper it.** Sentences that are hard to say are hard to read.

### The reverse check

After cutting, before shipping, ask what you lost:

- Did I remove a caveat that carried real meaning?
- Did I remove a useful example or the only concrete case?
- Did I remove a contrast the reader needs?
- Is every date, number, obligation, and exception still there and still correct?
- Is the text flatter than the material justifies?

Any yes: put it back.

### What to hand back

1. **The rewritten prose**, first and unprefaced.
2. **Two to five bullets** naming the major changes — not every edit; they can read the diff.
3. **Assumptions and open questions**, if you made any (audience assumed, context added, term you couldn't verify).

Example:

> You must submit the form by Friday. If your request is denied, you will receive an email explaining why.
>
> - Moved the deadline into the first sentence.
> - Active voice throughout.
> - Cut "It is important to note that."
> - Kept the denial condition and the *must*.

For a de-slop-only job, one line is enough: "Removed the chat-adjacent opener, cut two hedges, rejoined three dramatic fragments. Structure untouched."

## Red flags to scan for in your own draft

- **Empty openers**: *"It is important to note that…", "There are several reasons why…"* — cut and start with the point.
- **Buried subjects**: two clauses before the subject appears. The reader is hunting for the actor.
- **Stacked conditions**: *"If X, and provided that Y, except where Z…"* — usually three sentences.
- **A paragraph whose first sentence isn't the topic.** The lead is buried.
- **Different terms for the same thing** across sections — drift introduced during editing.
- **Definitions of words a reader already knows.**
- **Verbs hiding inside nouns**: *make a decision, conduct an analysis, give consideration to.*

## A short checklist before shipping

Items marked *(Phase 1)* apply to the De-slop and Both jobs; skip them on a pure Clarify pass.

- [ ] Every fact, number, date, obligation, and exception from the source survived — with its modal intact.
- [ ] Nothing was added that wasn't in the source, or additions are flagged.
- [ ] A new reader can tell, from the first screen, what this is and what to do with it.
- [ ] If there's more than one audience, each has its own marked section.
- [ ] Section headings answer reader questions.
- [ ] No unnecessary modifiers, doublets, or triplets remain.
- [ ] Technical terms are familiar to the audience or defined where they appear.
- [ ] Voice is active and uses *you* / *we* where natural.
- [ ] Long lists or steps are formatted as lists.
- [ ] In a controlled-register passage, the STE limits and approved words in [ste100.md](ste100.md) hold.
- [ ] Same concept = same word throughout.
- [ ] Sentence lengths are uneven where the meaning allows (Phase 1).
- [ ] AI tells that actually fired are gone; ones that were just the writer's voice are still there (Phase 1; see [de-llm.md](de-llm.md)).

The standard, in one line: **a reader from the intended audience can read it once and act.**

## What this skill is *not* for

- Code or code comments — those follow language idioms, not prose conventions.
- Commit messages and changelogs — terse, structured, imperative; their own genre.
- Literary or expressive writing.
- Internal logs, telemetry, and error strings meant for machines.

Marketing copy is a partial case: voice and persuasion carry the work, so preserve them unless asked otherwise, and limit yourself to removing obvious AI tics.

If the user is writing one of the excluded genres, say you noticed and ask whether they still want a pass.
