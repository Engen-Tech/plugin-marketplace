# Platform-native solutions

The lazy senior dev's first question: does the platform already do this? Before adding a dependency, scan here.

## HTML elements
| You think you need | The platform has |
|-|-|
| Date / time / color / range picker library | `<input type="date|time|color|range">` |
| Modal/dialog library | `<dialog>` + `dialog.showModal()` |
| Accordion component | `<details><summary>…</summary></details>` |
| Progress / meter component | `<progress>` / `<meter>` |

## CSS capabilities
| You reach for JS for | CSS has |
|-|-|
| Responsive font size | `font-size: clamp(1rem, 2.5vw, 2rem)` |
| Dark mode | `@media (prefers-color-scheme: dark)` |
| Responsive grid without breakpoints | `grid-template-columns: repeat(auto-fill, minmax(250px, 1fr))` |
| Sticky header | `position: sticky; top: 0` |

## JavaScript / browser APIs
| You think you need | The runtime ships |
|-|-|
| `query-string` / `qs` | `new URLSearchParams(location.search)` |
| `lodash.clonedeep` | `structuredClone(obj)` |
| `uuid` v4 | `crypto.randomUUID()` |
| `date-fns` format | `new Intl.DateTimeFormat(...)` |
| `clipboard.js` | `navigator.clipboard.writeText(text)` |

## Node.js standard library
| You think you need | Node has |
|-|-|
| `mkdirp` | `fs.mkdirSync(path, { recursive: true })` |
| `rimraf` | `fs.rmSync(path, { recursive: true, force: true })` |
| `uuid` v4 | `crypto.randomUUID()` |
| `array-uniq` | `[...new Set(arr)]` |

## Python standard library
| You think you need | Python ships |
|-|-|
| `python-dateutil` (basic) | `datetime.fromisoformat()` |
| `pytz` | `zoneinfo.ZoneInfo("America/New_York")` |
| `attrs` (simple) | `@dataclass` |
| `uuid` lib confusion | `uuid` is stdlib — just `import uuid` |
| `click` (single command) | `argparse` |

## Database
| You think you need app code for | The database has |
|-|-|
| Pagination | `LIMIT 20 OFFSET 40` |
| Uniqueness | `UNIQUE` constraint, not app-level checks |
| Referential integrity | `FOREIGN KEY`, not app-level checks |
| Value ranges | `CHECK (price > 0)` |
| UUID generation | `gen_random_uuid()` (Postgres) |

When the native solution is genuinely insufficient (old browser support, edge cases, ergonomics at scale), the library earns its place. Install it then, not before.
