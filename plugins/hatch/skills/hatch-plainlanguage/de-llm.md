# De-LLM: Phase 1 transformation catalog

This is the full reference for Phase 1 of the plainlanguage skill. The job is to strip the tics of AI-generated writing while preserving every fact. Work through these transformations in priority order, then hand the result to Phase 2 (the plain-language pass in SKILL.md).

You do not need to apply every category to every text — apply the ones that fire. Categories 1–6 catch the most common *lexical* tells and are cheap to run; the rest are scan-and-fix.

**Read category 0 first.** As of 2026 the vocabulary categories below are necessary but no longer sufficient: model providers have trained the famous words out, and the reliable signals have moved into structure. A text can pass categories 1–15 completely and still read as machine-written.

## 0. Structure first — the vocabulary list is no longer where the signal is

The single most useful correction to this catalog: **surface edits barely move detection.** In a 2026 study, AI-generated stories were rewritten by a span-level editing framework built from professional writers' edits, targeting cliché, redundant exposition, and purple prose — exactly the layer categories 1–15 cover. Detection fell from 95.5% to 93.9%. A point and a half. Meanwhile a University of Maryland / Google DeepMind analysis of 61,608 stories (StoryScope) identified AI-written fiction 93.2% of the time using *narrative structure alone*, no vocabulary features at all.

The practical lesson: fix these before you spend time on word swaps.

- **Sentence-length uniformity.** LLM sentences cluster in a narrow band, roughly 15–25 words, with very few outliers. Human writing has outliers everywhere — a four-word sentence next to a forty-word one. If you can read the first half of a paragraph and predict the shape of the second half, rewrite for variance. Measure it if unsure: a standard deviation under ~4 words across a passage is suspicious.
- **Uniform paragraph and section length.** "Perfect balance on everything" — every item given equal weight and equal wordcount regardless of how much each actually deserves. Real writing is lopsided, because real interest is lopsided. Deliberately let the least important item be one line.
- **The rule of three, everywhere.** Category 7 treats this as a scan-and-fix; it belongs here instead. Triads of adjectives, of clauses, of parallel phrases, paragraph after paragraph. Concrete lists of three real things are fine; it is the *rhetorical* triad used for cadence that reads as machine-made.
- **Hedging on every claim.** "It's important to note that…", "while there are many factors…", "this can potentially…", "generally speaking…". A seatbelt on every sentence. Human writers commit and take the hit if they're wrong. Delete the hedge or state the actual uncertainty.
- **Abstraction where a concrete detail belongs.** Conceptual nouns chosen over specifics — "solutions", "outcomes", "challenges" — because the model has no particular case in mind. Replace with the actual example, or cut the sentence.
- **The theme stated outright.** The text explains its own point instead of letting it land (reported at 77% of AI stories vs 52% of human ones). Cut the sentence that tells the reader what they just read.
- **One tidy track.** No digressions, no loose ends, everything resolving neatly. Structural, not fixable by word choice.

## 1. Remove AI vocabulary (necessary, not sufficient)

These still fire on older text and on cheaper models, so the pass is worth running — but treat a clean result as meaning nothing on its own. The classic list has been actively trained against since roughly 2024, so its absence is no longer evidence of a human.

Replace or remove these overused words:

- **Additionally** → Also, Moreover, or restructure the sentence
- **crucial / pivotal / key** (as adjectives) → important, or remove if not needed
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

Still in heavy rotation despite the training-out, so keep scanning for these: *navigate* (figurative), *realm*, *symphony*, *beacon*, *empower*, *leverage*, *transformative*, *holistic*, *elevate*, *seamless*, *pivotal*.

### 1a. The replacement lexicon

As the famous words got scrubbed, a newer register moved in — plainer, punchier, and easy to mistake for good editing. Watch for the **"quiet" family** in particular: *quietly* ("quietly building", "quietly dominating"), *quiet confidence*, *the quiet truth*. Alongside it: *shift*, *matters*, *earn*, *compound*, *hold*, *the work* (as a bare noun phrase), *built different*.

Treat this sub-list as observed rather than established — it comes from editor and trade-press reporting through 2026, not from a controlled study, and any of these words is perfectly ordinary in isolation. Its value is as a cluster signal. If a piece has purged every word in the main list and leans on three of these, that pattern is itself informative.

## 2. Eliminate puffery and significance claims

Remove or rewrite phrases like:

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

## 3. Fix superficial analyses

Remove trailing -ing phrases that add hollow commentary:

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

## 4. Remove promotional language

Replace or remove:

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

## 5. Fix copula avoidance

Replace inflated constructions with simple "is / are":

- "serves as" → is
- "stands as" → is
- "marks" → is
- "represents" → is
- "boasts / features / offers" → has
- "holds the distinction of being" → is

## 6. Remove negative parallelisms

Simplify these constructions:

- "Not only X, but Y" → X and Y, or restructure
- "It is not just about X, it's Y" → simplify
- "Not X, but Y" → Y (if X is an obvious contrast)
- "However" at sentence start → remove or restructure

## 7. Break the rule of three

When you see "adjective, adjective, and adjective" or "phrase, phrase, and phrase" in threes, consider:

- Reducing to two items
- Picking the most important one
- Restructuring entirely

## 8. Simplify elegant variation

If the same thing is referred to multiple ways ("the company", "the firm", "the organization", "the enterprise"), standardize to one or two terms. (Phase 2 enforces this too — see "Stay consistent" in SKILL.md.)

## 9. Fix false ranges

"From X to Y" constructions where X and Y aren't on a meaningful scale should be rewritten as a simple list or removed.

## 10. Fix formatting tells

- **Title case in headings** → sentence case
- **Excessive boldface** → remove emphasis unless truly needed
- **Inline-header lists** ("**Term:** description" bullets) → convert to prose or simpler lists
- **Em-dash overuse** → replace some with commas, parentheses, or a sentence break. This targets em dashes used for false drama, not the ordinary em dash used for an aside. **Calibrate on density, not presence:** two or three in a 200-word passage is a real signal; one is just punctuation. Stripping every em dash is the most common overcorrection of 2026 and leaves its own residue — flattened rhythm and comma splices where an aside used to be. The em dash predates the transformer by about four centuries.
- **Curly quotes** → straight quotes

## 11. Remove meta-commentary

Remove:

- "It's important to note / remember"
- "It's worth noting"
- "It's crucial to consider"
- Knowledge-cutoff disclaimers
- "Based on available information"
- "As of [date]" (unless citing a source)

## 12. Fix vague attributions

- "Experts argue" → name the expert or remove
- "Observers have cited" → name who or remove
- "Industry reports" → cite the specific report
- "Some critics argue" → name who or remove
- "Several sources" → be specific

## 13. Remove conclusion patterns

Avoid:

- "In summary"
- "In conclusion"
- "Overall"
- Restating what was just said

## 14. Fix challenge / future sections

Rewrite or remove formulaic patterns:

- "Despite its X, Y faces challenges"
- "Despite these challenges"
- "Future outlook / prospects" sections built on speculation

## 15. Cut dramatic sentence fragmentation

LLMs chop clauses into ultra-short standalone "sentences" for false punch. Rejoin them into normal sentences:

- "One platform. Zero users." → "One platform with zero users." (or rewrite)
- "It works. Every time." → "It works every time."
- "Neither scales." (standalone punch line) → fold into the preceding sentence
- A run of two- to four-word fragments used as a dramatic beat → merge into the adjacent sentence

Watch for: verbless fragments used for emphasis, and strings of very short "sentences" in a row.

This is the opposite of Phase 2's "break long sentences" rule — and they don't conflict. Phase 1 rejoins fragments that were split for *drama*; Phase 2 splits sentences that are genuinely overstuffed. Rejoin first, then let Phase 2 break anything that's still too long.

## 16. Delete chat leakage

Not a style tell but hard evidence, and it survives into published text more often than you would expect. Cut on sight:

- Openers: "Great question!", "Certainly! Here's…", "Absolutely!"
- Closers: "I hope this helps!", "Let me know if you'd like…", "Would you like me to add a concluding paragraph or a bulleted summary?"
- Any second-person address to a requester who is not the reader.

If you find one, distrust the whole document rather than just fixing the line.

## 17. Cut manufactured vulnerability and unearned specificity

The newest register performs humanity rather than having it. Two linked patterns:

- **Performed failure as a rapport device.** A confessional "I got this wrong for years" opener, an admitted flaw with no consequences attached, first person deployed to buy trust rather than to report experience. Ask whether the writer took any actual risk. If the admission costs them nothing, cut it.
- **Sensory detail the author could not have earned.** A named city, a specific smell, a brand name, a time of day — concrete anchors that make a claim feel lived-in. Specificity is normally a virtue, which is what makes this one nasty. The test is provenance, not vividness: could this writer actually know this? Invented detail in service of authority should be cut even when it reads well.

## 18. Judge on the cluster, not the marker

Every pattern in this catalog appears in genuine human writing. Editors use em dashes. Academics delve. Good writers use triads deliberately. A single hit means nothing, and acting on one produces false accusations and mangled prose.

Weight the evidence roughly this way:

- **Strong:** chat leakage, several structural tells from category 0 co-occurring.
- **Moderate:** five or more vocabulary hits in one passage; sentence-length variance that never breaks the band.
- **Weak on its own:** any single word, any single em dash, any one triad.

When revising rather than detecting, the same rule applies inverted: fix what actually fires, and leave alone anything that is simply the writer's voice.

## Provenance

The structural findings in category 0 come from the StoryScope work (University of Maryland / Google DeepMind, 61,608 stories) and the span-level editing result, both 2026, as reported in trade coverage rather than read from the primary papers — the effect sizes should be treated as directionally right rather than exact. Categories 1a, 16 and 17 come from editor and practitioner reporting through mid-2026 and are observational. Categories 1–15 are the long-standing consensus list and are stable.

Revisit this file periodically. The lexical categories decay as providers train against them; the structural ones have held so far, but the register moves roughly annually.

## Example transformation

**Before:**

> The Statistical Institute of Catalonia was officially established in 1989, marking a pivotal moment in the evolution of regional statistics in Spain. The founding of Idescat represented a significant shift toward regional statistical independence, enabling Catalonia to develop a statistical system tailored to its unique socio-economic context. This initiative was part of a broader movement across Spain to decentralize administrative functions and enhance regional governance.

**After:**

> The Statistical Institute of Catalonia was established in 1989 to give Catalonia its own statistical system, separate from Spain's national statistics. This was part of Spain's broader effort to decentralize administrative functions after the transition to democracy.

Changes: removed "officially", "marking a pivotal moment", "evolution of", "represented a significant shift", "enabling...tailored to its unique socio-economic context", "enhance regional governance". Added brief context about why decentralization happened.
