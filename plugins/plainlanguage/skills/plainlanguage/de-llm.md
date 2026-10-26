# De-LLM: Phase 1 transformation catalog

This is the full reference for Phase 1 of the plainlanguage skill. The job is to strip the tics of AI-generated writing while preserving every fact. Work through these transformations in priority order, then hand the result to Phase 2 (the plain-language pass in SKILL.md).

**Two rules govern everything below.**

1. **The goal is reader usefulness, not the absence of AI fingerprints.** Remove noise; stop before the text becomes strange, over-formal, or performatively human.
2. **Nothing here outranks meaning.** Facts, obligations, deadlines, numbers, and exceptions survive every transformation. See "What to protect, in order" and "Do not overcorrect" in SKILL.md.

You do not need to apply every category — apply the ones that fire. **Read category 0 first.** As of 2026 the vocabulary categories are necessary but no longer sufficient: providers have trained the famous words out, and the reliable signals moved into structure. A text can pass categories 1–15 completely and still read as machine-written.

Each category is tagged with how much weight its hits carry:

- **[hard evidence]** — near-conclusive on a single hit.
- **[strong]** — reliable when several co-occur.
- **[soft]** — meaningful only as a cluster; any single instance is ordinary writing.

## 0. Structure first — the vocabulary list is no longer where the signal is  [strong]

The single most useful correction to this catalog: **surface edits barely move detection.** In a 2026 study, AI-generated stories were rewritten by a span-level editing framework built from professional writers' edits, targeting cliché, redundant exposition, and purple prose — exactly the layer categories 1–15 cover. Detection fell from 95.5% to 93.9%. A point and a half. Meanwhile a University of Maryland / Google DeepMind analysis of 61,608 stories (StoryScope) identified AI-written fiction 93.2% of the time using *narrative structure alone*, no vocabulary features at all.

Fix these before spending time on word swaps.

- **Sentence-length uniformity.** LLM sentences cluster in a narrow band, roughly 15–25 words, with very few outliers. Human writing has outliers everywhere. The test is predictability, not arithmetic: *can you predict the shape of the next sentence?* If a passage runs eight or more sentences at near-identical length, rewrite for variance — but only where the meaning allows it. Do not force a short or long sentence that the content doesn't want. Uniform rhythm in a numbered procedure is correct; uniform rhythm across four paragraphs of argument is a tell.
- **Uniform paragraph and section length.** Every item given equal weight and equal wordcount regardless of what it deserves. Weight paragraphs by importance instead: a minor exception can be one line, the main path gets room. The rule is *do not pad the unimportant to match the important* — not *manufacture imbalance*.
- **The rule of three, everywhere.** Triads of adjectives, clauses, and parallel phrases, paragraph after paragraph. Keep a triplet when each item is distinct and useful — "The API returns a status code, a message, and a request ID." Cut it when it's there for cadence, emphasis, or polish — "safe, fast, and reliable," unless those are actual specifications.
- **Hedging on every claim.** "It's important to note that…", "while there are many factors…", "this can potentially…". A seatbelt on every sentence. **Remove empty hedges; keep real uncertainty and make it explicit.** "It is important to note that this may only apply in some cases" becomes "This applies only to federal employees" — the hedge was hiding a condition. If the uncertainty is genuine, say what it depends on. In policy, safety, and legal text the uncertainty is usually material: see "High-stakes writing" in SKILL.md.
- **Abstraction where a concrete detail belongs.** Conceptual nouns chosen over specifics — "solutions", "outcomes", "challenges" — because the model has no particular case in mind. Replace with the actual example from the source, or cut the sentence. Do not invent the example (see category 17).
- **The theme stated outright.** The text explains its own point instead of letting it land (reported at 77% of AI stories vs 52% of human ones). Cut sentences that restate the previous point without adding anything. Keep a summary that gives the reader a next action: "In conclusion, these points are important" goes; "To deploy the update, run the migration, restart the service, and verify the health check" stays.
- **One tidy track.** No digressions, no loose ends, everything resolving neatly. The problem is not neatness — a how-to should be a clean path. The problem is neatness that hides uncertainty, skips exceptions, or flattens a real tradeoff. Do not manufacture digressions; do restore the exception the tidy version dropped.

## 1. Remove AI vocabulary  [soft]

These still fire on older text and cheaper models, so the pass is worth running — but a clean result means nothing on its own. The classic list has been actively trained against since roughly 2024.

- **Additionally** → Also, Moreover, or restructure the sentence
- **crucial / pivotal / key** (as adjectives) → important, or remove
- **delve** → explore, examine, look at, or remove
- **enhance** → improve, or be specific about what improves
- **foster / cultivate** (figurative) → encourage, support, create
- **garner** → gain, receive, get
- **highlight / underscore** (as verbs) → show, demonstrate, or remove
- **intricate / intricacies** → complex, detailed, or be specific
- **landscape** (abstract) → field, area, situation, or be specific
- **showcase** → show, display, demonstrate
- **tapestry** (abstract) → remove entirely, be specific
- **testament** → evidence, proof, example, or remove
- **vibrant** → lively, active, or be specific
- **enduring** → lasting, or remove if redundant
- **interplay** → interaction, relationship
- **valuable** → useful, helpful, or remove

Still in heavy rotation despite the training-out: *navigate* (figurative), *realm*, *symphony*, *beacon*, *empower*, *leverage*, *transformative*, *holistic*, *elevate*, *seamless*, *pivotal*.

### 1a. The replacement lexicon  [soft — cluster only]

As the famous words got scrubbed, a newer register moved in — plainer, punchier, easy to mistake for good editing. The **"quiet" family**: *quietly* ("quietly building", "quietly dominating"), *quiet confidence*, *the quiet truth*. Alongside it: *shift*, *matters*, *earn*, *compound*, *hold*, *the work* (as a bare noun phrase), *built different*.

**Do not delete these one at a time.** Every one is an ordinary English word, and a search-and-replace pass over them produces mangled prose and false accusations. Treat the list as a cluster signal only: if a passage carries three or more *and* the rest of the catalog has already been cleaned, flag the passage and look at its structure — the register is a symptom, the structure is the disease.

Cluster that fires:

> The company quietly built a product, quietly earned trust, and quietly shifted the market.

Fixed by rewriting the structure, not by swapping the word:

> The company built a product and kept shipping until users came back.

This sub-list is observed rather than established — editor and trade-press reporting through 2026, not a controlled study.

## 2. Eliminate puffery and significance claims  [soft]

- "stands / serves as a testament to" → is, shows
- "is a testament / reminder" → shows, demonstrates
- "plays a vital / significant / crucial / pivotal role" → is important to, contributes to
- "underscores / highlights its importance / significance" → remove entirely
- "reflects broader trends" → remove or be specific
- "symbolizing its ongoing / enduring" → remove
- "contributing to the" → remove if vague
- "setting the stage for" → before, leading to
- "marking / shaping the" → remove or simplify
- "represents / marks a shift" → changed, moved toward
- "key turning point" → turning point, or be specific
- "evolving landscape" → changes in, current state of
- "focal point" → focus, center
- "indelible mark" → lasting effect, or be specific
- "deeply rooted" → based in, from

## 3. Fix superficial analyses  [soft]

Trailing -ing phrases that add hollow commentary:

- "..., highlighting the importance of X" → remove
- "..., underscoring the significance of X" → remove
- "..., emphasizing X" → remove
- "..., ensuring X" → remove unless truly causal
- "..., reflecting X" → remove
- "..., symbolizing X" → remove
- "..., contributing to X" → remove if vague
- "..., fostering X" → remove
- "align with" → match, follow
- "resonate with" → appeal to, connect with

## 4. Remove promotional language  [soft]

- "boasts a" → has
- "vibrant" → remove or be specific
- "rich" (figurative) → remove or be specific
- "profound" → significant, deep, or remove
- "showcasing" → showing
- "exemplifies" → shows, is an example of
- "commitment to" → focus on, effort toward
- "natural beauty" → be specific or remove
- "nestled" → located, situated
- "in the heart of" → in, in central
- "groundbreaking" → new, innovative, or be specific
- "renowned" → known, well-known

In marketing copy this category is largely the genre. Apply it only when the user asked for it.

## 5. Fix copula avoidance  [soft]

- "serves as" → is
- "stands as" → is
- "marks" → is
- "represents" → is
- "boasts / features / offers" → has
- "holds the distinction of being" → is

## 6. Simplify negative parallelisms  [soft]

- "Not only X, but Y" → X and Y, or restructure
- "It is not just about X, it's Y" → simplify
- "Not X, but Y" → Y (if X is an obvious contrast)

**"However" is not on this list.** It is a normal English connective. Cut it when it signals a contrast that isn't there — "The feature works. However, it has a bug." → "The feature has a bug." Keep it when the reader needs the pivot — "The feature works in most cases. However, it fails when the token expires."

## 7. Break the rule of three  [soft]

See category 0. Keep the triplet if each item is distinct and useful; cut or reduce it if it's there for cadence.

## 8. Simplify elegant variation  [soft]

If the same thing is called "the company", "the firm", "the organization", and "the enterprise", standardize to one term. (Phase 2 enforces this too — see "Stay consistent" in SKILL.md.)

## 9. Fix false ranges  [soft]

"From X to Y" constructions where X and Y aren't on a meaningful scale should become a simple list, or go.

## 10. Fix formatting tells  [soft]

- **Headings** → sentence case *when no style guide applies*. Many house styles mandate title case; follow the reader's style guide over this rule, and ask if one might exist.
- **Excessive boldface** → remove emphasis unless it's doing work. Bold on every third phrase emphasizes nothing.
- **Inline-header lists** ("**Term:** description" bullets) → keep them when they help the reader scan genuinely parallel reference material:

  > - **Timeout:** the request fails after 30 seconds.
  > - **Retry:** the client retries once.
  > - **Fallback:** the cache serves the last known value.

  Convert to prose when the terms aren't parallel or the list is padding:

  > - **Importance:** the thing matters.
  > - **Value:** it has value.
  > - **Relevance:** it is relevant.

- **Em dashes** → check density *by paragraph*. If most paragraphs carry an aside em dash, convert some to commas, parentheses, or a sentence break; keep the ones that improve clarity. This targets false drama, not the ordinary aside. Stripping every em dash is the most common overcorrection of 2026 and leaves its own residue — flattened rhythm and comma splices where an aside used to be. The em dash predates the transformer by about four centuries.
- **Curly quotes** → straight quotes in source files, Markdown, and anything destined for a code path. In a final styled document, follow the style guide.

## 11. Remove meta-commentary  [soft]

- "It's important to note / remember"
- "It's worth noting"
- "It's crucial to consider"
- Knowledge-cutoff disclaimers
- "Based on available information"
- "As of [date]" (unless citing a source)

## 12. Fix vague attributions  [soft]

- "Experts argue" → name the expert or remove
- "Observers have cited" → name who or remove
- "Industry reports" → cite the specific report
- "Some critics argue" → name who or remove
- "Several sources" → be specific

Do not invent the attribution. If the source doesn't name anyone, cut the claim or flag it.

## 13. Remove empty conclusion patterns  [soft]

Cut summary openers that carry no information: "In summary", "In conclusion", "Overall, this is important", and any paragraph that restates what was just said.

Keep a closing paragraph that tells the reader what to do. "Overall, this is important" goes. "Do this before the next release" stays.

## 14. Fix challenge / future sections  [soft]

- "Despite its X, Y faces challenges"
- "Despite these challenges"
- "Future outlook / prospects" sections built on speculation

## 15. Cut dramatic sentence fragmentation  [soft]

LLMs chop clauses into ultra-short standalone "sentences" for false punch. Rejoin them:

- "One platform. Zero users." → "One platform with zero users."
- "It works. Every time." → "It works every time."
- "Neither scales." (standalone punch line) → fold into the preceding sentence
- A run of two- to four-word fragments used as a dramatic beat → merge into the adjacent sentence

This is the opposite of Phase 2's "break long sentences" rule, and they don't conflict. Rejoin fragments split for *drama* first; let Phase 2 break anything still overstuffed.

## 16. Delete chat leakage  [hard evidence]

Not a style tell — evidence. It survives into published text more often than you'd expect. Cut on sight:

- **Openers**: "Great question!", "Certainly! Here's the answer.", "Absolutely!", "I'd be happy to help with that."
- **Closers**: "I hope this helps!", "Let me know if you'd like me to expand this.", "Would you like a summary?", "Feel free to ask if anything is unclear."
- **Any second-person address to a requester who is not the reader**: "as you mentioned", "per your request", "the document you asked for".

If you find one, check the whole document for other prompt artifacts — placeholder brackets, "[Insert name here]", a numbered response to an instruction list, a stray restatement of the prompt.

## 17. Cut manufactured vulnerability and unearned specificity  [strong]

The newest register performs humanity rather than having it. Two linked patterns:

**Performed failure as a rapport device.** A confessional opener, an admitted flaw with no consequences attached, first person deployed to buy trust rather than report experience.

> I got this wrong for years. The old way was fine, but now I understand the truth.

Test: *did the writer actually lose something?* If the admission costs nothing, cut it. If there's a real consequence in the source, state it:

> The old approach failed when the queue filled.

**Sensory detail the author could not have earned.** A named city, a specific smell, a brand, a time of day — concrete anchors that make a claim feel lived-in. Specificity is normally a virtue, which is what makes this one nasty.

> On a gray Tuesday in March, a junior admin opened the console.

Test: *could this writer actually know this?* Decorative and unverifiable detail goes:

> An admin opened the console.

Detail that explains something and is in the source stays:

> The failure appeared on March 14 at 2:00 a.m., when the nightly batch ran.

## 18. Judge on the cluster, not the marker

Every pattern in this catalog appears in genuine human writing. Editors use em dashes. Academics delve. Good writers use triads deliberately. A single hit means nothing, and acting on one produces false accusations and mangled prose.

- **Hard evidence:** chat leakage, prompt artifacts.
- **Strong:** several category-0 structural tells co-occurring; performed vulnerability plus invented specificity.
- **Soft:** five or more vocabulary hits in one passage; sentence-length variance that never breaks the band.
- **Weak on its own:** any single word, any single em dash, any one triad, any one "however".

When revising rather than detecting, the rule inverts: **fix what actually fires, and leave alone anything that is simply the writer's voice.**

## Maintenance

The lexical categories decay as providers train against them; the structural ones have held so far, but the register moves roughly annually. When revisiting:

- Re-check each entry's tier. A word that no longer feels like a tell gets demoted to soft, then dropped.
- Promote nothing to **strong** without more than a single trade-press report behind it.
- Genre exceptions belong in the entry, not in the reader's head — if a pattern is normal in some genre (title case in house style, promotional language in marketing), say so inline.

**Provenance.** Category 0's structural findings come from the StoryScope work (University of Maryland / Google DeepMind, 61,608 stories) and the span-level editing result, both 2026, as reported in trade coverage rather than read from the primary papers — treat the effect sizes as directionally right rather than exact. Categories 1a, 16, and 17 come from editor and practitioner reporting through mid-2026 and are observational. Categories 1–15 are the long-standing consensus list and are stable.

## Example transformation

**Before:**

> The Statistical Institute of Catalonia was officially established in 1989, marking a pivotal moment in the evolution of regional statistics in Spain. The founding of Idescat represented a significant shift toward regional statistical independence, enabling Catalonia to develop a statistical system tailored to its unique socio-economic context. This initiative was part of a broader movement across Spain to decentralize administrative functions and enhance regional governance.

**After:**

> The Statistical Institute of Catalonia was established in 1989 to give Catalonia its own statistical system, separate from Spain's national statistics. This was part of Spain's broader effort to decentralize administrative functions.

Removed: "officially", "marking a pivotal moment", "evolution of", "represented a significant shift", "enabling…tailored to its unique socio-economic context", "enhance regional governance". Every fact in the original survives; the sentence count drops from three to two, and the second sentence is deliberately shorter than the first.

**What was not added.** An earlier version of this example appended "after the transition to democracy" to the last sentence. That context is accurate and useful — and it was not in the source. Adding it is a judgment call the author should make, not a default. If background genuinely helps, flag it as an addition rather than folding it in silently. See "High-stakes writing" in SKILL.md.
