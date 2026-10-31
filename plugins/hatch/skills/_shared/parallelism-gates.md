# Parallelism Gates

hatch runs work items in parallel by default and drops to serial only when running two together would produce a wrong or broken result. The table below lists every gate that forces serialization.

| Gate | Trigger |
|-|-|
| Dependency edge | dep not yet merged (correctness) |
| Shared / order-sensitive resource | wave-mates touch the same stateful resource — from a co-declared `shared_resources` annotation or overlapping `touches` manifests, else inferred from the item plans |
| Stateful env without injectable isolation | the repo's env command can't be parameterized |
| File-collision risk | wave-mates' `touches` manifests overlap (or, absent manifests, they likely edit the same files); `validate_binder.py` flags this at plan time when neither declares `serialize`/`shared_resources` |
| Explicit `serialize` | the binder marks items must-serialize |

## How to explain parallelism to users

hatch builds work items at the same time by default, to save time. It only drops back to one-at-a-time when running two together would produce a wrong or broken result. There are four such cases — everything else runs in parallel.

1. One item needs another finished first.
Item B uses something Item A creates, so B can't be built until A exists. B waits for A. This isn't a special rule — it's just correctness; B literally won't work without A. Example: the profile page can't be built until the app shell and routing exist.

2. Two items change the same order-sensitive shared thing.
A few things can only be changed one at a time, in a set order — a database migration, a shared lock file, a generated file. If two items both change one of these at once, they clobber each other. hatch catches this either by noticing both items plan to edit the same such file, or because the binder says these items share that resource. Example: two items that each add a database migration must run one after the other.

3. Two items in the same batch would edit the same files.
Even when neither item needs the other, if both edit the same file, building them side by side means their changes collide when hatch stacks the results together. So hatch runs them one at a time to avoid the merge mess. Example: two items that both edit the global stylesheet. hatch knows which files each item touches from its `touches` manifest when the plan provides one (otherwise it infers from the item's description), and `validate_binder.py` flags two same-wave items whose `touches` overlap unless one carries `serialize` or they share a `shared_resources` entry.

Editing a file an earlier item created is fine, and common. A later item may extend a file that an earlier item it depends on already produced — registering its route in an app shell's `app.ts`, mounting its endpoint in a `main.py` — as long as that file sits inside the binder's `scope.included`. The dependency edge (#1) already keeps the earlier item finished and merged before the later one starts, so the later item builds on top of a settled file, not against one in flight. There is no per-item scope; `scope.included` is the binder's one shared boundary, and any item may touch anything inside it that its work calls for.

The collision case is narrower: it's only two items in the *same wave* both editing the same file. That is exactly what this gate catches — it serializes the pair so their edits land in order instead of clobbering each other. Across waves there is no collision to catch, because the waves already run in sequence.

4. You said so.
You can mark items in the binder as "don't run these together." This is your override for interference hatch can't see — you know two items will step on each other for a reason that isn't visible in the file list.

The difference between #2 and #3, since they sound alike: #2 is about order (these changes must happen in sequence), #3 is about collision (these changes would conflict if merged). #2 and #1 keep results correct; #3 keeps the stacking clean; #4 is your manual escape hatch.
