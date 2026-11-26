// Pure drawing for the stackwell pane: view model + width -> one cell buffer.
// A calm status pane: grey by default, muted hues mark groups, saturated colour only for warn and crit.

import { isStewardPlugin } from './agents'
import { basename, fitPath, folderLabel, shortPath } from './folders'
import type { StackwellAccount, StackwellAgent, StackwellBinder, StackwellBreakdown, StackwellFolder, StackwellPalette, StackwellPeer, StackwellQuota, StackwellSteward, StackwellView } from '../types'

/**
 * Text from outside (paths, branches, names, descriptions) with nothing a terminal would act on:
 * whole escape sequences (CSI, OSC and the like, ESC or C1 led, through their end), then any C0,
 * DEL or C1 left, and the bidi controls U+202A-U+202E and U+2066-U+2069. Printable Unicode stays.
 */
const ESCAPES =
  /(?:\x1b\[|\x9b)[\x20-\x3f]*[\x40-\x7e]?|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[\x20-\x2f]*[\x30-\x7e]?/g
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g
export const printable = (s: string): string => s.replace(ESCAPES, '').replace(CONTROLS, '')
/** A code point a terminal acts on rather than prints: C0, DEL, C1 or a bidi control. */
const isControl = (cp: number) => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)

export const DEFAULT_COLOR = 0x01000000

// ---------------------------------------------------------------- colour

const hex = (s: string): number => parseInt(s.replace('#', ''), 16)

/** WCAG 2 relative luminance of 0xRRGGBB. */
export function luminance(c: number): number {
  const ch = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch((c >> 16) & 255) + 0.7152 * ch((c >> 8) & 255) + 0.0722 * ch(c & 255)
}

export function contrast(a: number, b: number): number {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** OKLCH (hue in degrees) to 0xRRGGBB, clipped to the sRGB gamut. */
export function oklch(L: number, C: number, h: number): number {
  const r = (h * Math.PI) / 180
  const a = C * Math.cos(r), b = C * Math.sin(r)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const [R, G, B] = lin.map(x => {
    const v = Math.max(0, Math.min(1, x))
    const g = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
    return Math.round(g * 255)
  }) as [number, number, number]
  return (R << 16) | (G << 8) | B
}

/** `share` of text over bg. */
export function blend(text: number, bg: number, share: number): number {
  const ch = (s: number) => Math.round(((text >> s) & 255) * share + ((bg >> s) & 255) * (1 - share))
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/**
 * Group hues in OKLCH degrees, spread apart. Hatch sits at 28 degrees with a lower chroma, a muted
 * clay: warm, yet far enough from crit and warn never to pass for them.
 */
export const HUES = { hatch: 28, git: 130, quota: 170, agents: 205, context: 245, steward: 280, session: 320 } as const
const CHROMA = 0.08
/** The hatch hue's lower chroma keeps it apart from a pink-red crit (mocha's). */
const HATCH_CHROMA = 0.05
const STEP = 0.1

export const isDarkBg = (bg: number) => luminance(bg) < 0.18

/** The OKLCH lightness nearest `start` that reaches `floor` against bg, moving away from bg. */
function lightnessFor(h: number, bg: number, start: number, floor: number, C = CHROMA): number {
  const dir = isDarkBg(bg) ? 0.01 : -0.01
  let L = start
  while (contrast(oklch(L, C, h), bg) < floor && L > 0 && L < 1) L += dir
  return L
}

/** Derives dim, the group hues and the context steps from four base colours. */
export function makePalette(bg: number, text: number, warn: number, crit: number): StackwellPalette {
  const dark = isDarkBg(bg)
  let share = 0.45
  while (contrast(blend(text, bg, share), bg) < 3 && share < 1) share += 0.01
  const dim = blend(text, bg, share)
  const start = dark ? 0.74 : 0.5
  const hue = (h: number) => oklch(lightnessFor(h, bg, start, 4.5), CHROMA, h)
  // context steps: lightness down from the context hue, the step shrunk until the darkest keeps 3:1
  const L0 = lightnessFor(HUES.context, bg, start, 4.5)
  let d = STEP
  // on a light background the steps darken towards black; a shorter step keeps them apart from it
  if (!dark) d = 0.06
  while (d > 0.02 && contrast(oklch(L0 - 3 * d, CHROMA, HUES.context), bg) < 3) d -= 0.01
  const steps = [0, 1, 2, 3].map(i => oklch(L0 - i * d, CHROMA, HUES.context))
  const Ls = lightnessFor(HUES.session, bg, start, 4.5)
  let ds = d
  while (ds > 0.02 && contrast(oklch(Ls - ds, CHROMA, HUES.session), bg) < 3) ds -= 0.01
  return {
    bg,
    text,
    dim,
    warn,
    crit,
    context: hue(HUES.context),
    quota: hue(HUES.quota),
    session: hue(HUES.session),
    agents: hue(HUES.agents),
    git: hue(HUES.git),
    hatch: oklch(lightnessFor(HUES.hatch, bg, start, 4.5, HATCH_CHROMA), HATCH_CHROMA, HUES.hatch),
    steward: hue(HUES.steward),
    steps,
    sessionStep: oklch(Ls - ds, CHROMA, HUES.session),
  }
}

const preset = (bg: string, text: string, warn: string, crit: string) => makePalette(hex(bg), hex(text), hex(warn), hex(crit))

export const PRESETS: Record<string, StackwellPalette> = {
  // the VGA console palette on black
  vga: preset('#000000', '#AAAAAA', '#FFAA55', '#FF5555'),
  mocha: preset('#1E1E2E', '#CDD6F4', '#F2CDCD', '#F38BA8'),
  'tokyo-night': preset('#1A1B26', '#C0CAF5', '#FF9E64', '#DB4B4B'),
  latte: preset('#EFF1F5', '#4C4F69', '#DD7878', '#D20F39'),
}

export const THEMES = ['auto', 'vga', 'mocha', 'tokyo-night', 'latte'] as const

/** Parses a `# >>> PALETTE` block of NAME=R,G,B lines; undefined when absent or short. */
export function parsePalette(script: string): StackwellPalette | undefined {
  const start = script.indexOf('# >>> PALETTE')
  const end = script.indexOf('# <<< PALETTE')
  if (start < 0 || end < start) return undefined
  const slots: Record<string, number> = {}
  for (const line of script.slice(start, end).split('\n')) {
    const m = /^\s*([A-Z0-9_]+)=(\d{1,3}),(\d{1,3}),(\d{1,3})/.exec(line)
    if (m) slots[m[1]!] = (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])
  }
  const text = slots.CTX_OK, warn = slots.CTX_WARN, crit = slots.CTX_CRIT
  if (text === undefined || warn === undefined || crit === undefined) return undefined
  const bg = slots.TEXT_FG ?? 0x000000
  // a known theme base: use that preset as is
  const known = Object.values(PRESETS).find(p => p.bg === bg && p.text === text)
  return known ?? makePalette(bg, text, warn, crit)
}

// ---------------------------------------------------------------- stored view

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isStr = (x: unknown): x is string => typeof x === 'string'
const isStrs = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr)
/** The list's elements of the right shape; anything but an array is none. */
const listOf = <T,>(a: unknown, isShape: (x: Record<string, unknown>) => boolean): T[] =>
  Array.isArray(a) ? (a.filter(x => isObj(x) && isShape(x)) as T[]) : []

const AGENT_STATUS: ReadonlySet<unknown> = new Set(['running', 'ok', 'failed'])
const PEER_ROLE: ReadonlySet<unknown> = new Set(['primary', 'secondary'])

const isQuota = (q: Record<string, unknown>) => isStr(q.kind) && isNum(q.pct)
const isAccount = (a: Record<string, unknown>) => isStr(a.name)
const isAgent = (a: Record<string, unknown>) => (isStr(a.kind) || isStr(a.name)) && AGENT_STATUS.has(a.status) && isNum(a.startedAt)
const isFolder = (f: Record<string, unknown>) => isStr(f.key) && isStr(f.name) && isNum(f.lastAt)
const isBinder = (b: Record<string, unknown>) =>
  isStr(b.slug) && isStrs(b.building) && isStrs(b.halted) && isNum(b.total) && isNum(b.merged) && isNum(b.wave) && isNum(b.waves)
const isPeer = (p: Record<string, unknown>) => isStr(p.name) && PEER_ROLE.has(p.role)

/** `x` with each optional field named dropped when it is not of its type, and the flags made booleans. */
function trim<T>(x: T, strs: string[], nums: string[], flags: string[] = []): T {
  const o = { ...(x as Record<string, unknown>) }
  for (const k of strs) if (o[k] !== undefined && !isStr(o[k])) delete o[k]
  for (const k of nums) if (o[k] !== undefined && !isNum(o[k])) delete o[k]
  for (const k of flags) o[k] = o[k] === true
  return o as T
}
const settleAgent = (a: StackwellAgent) => trim(a, ['id', 'agentId', 'name', 'kind', 'plugin', 'model', 'effort'], ['endedAt'], ['isBackground'])
const settleFolder = (f: StackwellFolder) => trim(f, ['branch', 'mainRoot', 'tag'], ['added', 'removed', 'untracked'], ['isRepo', 'isWorktree', 'isCwd', 'isOutside'])
const settleAccount = (a: StackwellAccount) => trim(a, [], ['h5', 'd7', 'h5At', 'd7At', 'updatedAt'])
const settleQuota = (q: StackwellQuota) => trim(q, [], ['resetsAt'])
const settlePeer = (p: StackwellPeer) => trim(p, ['sessionId', 'status'], ['since'])

/** The steward reading with its peers of the right shape; none without a role and an initiative. */
function settleSteward(x: unknown): StackwellSteward | undefined {
  if (!isObj(x) || !PEER_ROLE.has(x.role) || !isStr(x.initiative)) return undefined
  const out: StackwellSteward = { role: x.role as StackwellSteward['role'], initiative: x.initiative, peers: listOf<StackwellPeer>(x.peers, isPeer).map(settlePeer) }
  if (isNum(x.logMtime)) out.logMtime = x.logMtime
  return out
}

/** A palette with every colour a number; any other the fallback. */
function settlePalette(x: unknown): StackwellPalette {
  const fall = PRESETS.vga!
  if (!isObj(x) || !Array.isArray(x.steps) || x.steps.length !== 4 || !x.steps.every(isNum)) return fall
  for (const k of Object.keys(fall) as (keyof StackwellPalette)[]) if (k !== 'steps' && !isNum(x[k])) return fall
  return x as unknown as StackwellPalette
}

/**
 * The stored view with every list, count and colour in place, each list's elements of the shape
 * draw reads: a view an older build wrote (or one a reload cut short) may lack one or hold a null,
 * and render must never throw on it. Fields an older shape kept and this one dropped go too.
 */
export function settleView(v: Partial<StackwellView> | null | undefined): StackwellView {
  const x = (isObj(v) ? v : {}) as Record<string, unknown>
  const { toolCounts: _tc, bashFails: _bf, running: _ru, log: _lg, isToolsOpen: _to, compact: _cp, steward: _st, ...rest } = x
  const out = {
    ...rest,
    profile: isStr(x.profile) ? x.profile : 'default',
    quotas: listOf<StackwellQuota>(x.quotas, isQuota).map(settleQuota),
    accounts: listOf<StackwellAccount>(x.accounts, isAccount).map(settleAccount),
    trend: Array.isArray(x.trend) ? x.trend.filter(isNum) : [],
    agents: listOf<StackwellAgent>(x.agents, isAgent).map(settleAgent),
    folders: listOf<StackwellFolder>(x.folders, isFolder).map(settleFolder),
    binders: listOf<StackwellBinder>(x.binders, isBinder),
    turns: isNum(x.turns) ? x.turns : 0,
    now: isNum(x.now) ? x.now : 0,
    theme: isStr(x.theme) ? x.theme : 'auto',
    palette: settlePalette(x.palette),
  } as StackwellView
  const steward = settleSteward(x.steward)
  if (steward) out.steward = steward
  for (const k of ['cwd', 'home', 'model', 'branch'] as const) if (out[k] !== undefined && !isStr(out[k])) delete out[k]
  for (const k of ['tokens', 'window', 'percent', 'costUsd', 'startedAt', 'lastTurnMs'] as const) if (out[k] !== undefined && !isNum(out[k])) delete out[k]
  if (out.breakdown !== undefined && !(isObj(out.breakdown) && (['msgs', 'tools', 'sys', 'other', 'raw'] as const).every(k => isNum(out.breakdown![k])))) delete out.breakdown
  return out
}

// ---------------------------------------------------------------- screen

/** Where a section icon goes on a Screen: its cells there are blank. */
export type Slot = { x: number; y: number; icon: string; alt: string; isBadge: boolean }

/** A field a row shows cut, whole: `label` names it on the hover card. */
export type Field = { label: string; text: string }

/**
 * The hover card of a row whose text was cut: `y` its row on the Screen, `at` that row in the
 * pane (unique, the key), `lines` the card's text wrapped to `width - 4`; `top` the pane row of
 * its top border; `isUp` when it opens above its row; `text` what a press on the row copies,
 * every field whole, one per line, in the card's order.
 */
export type Card = { y: number; at: number; lines: string[]; width: number; isUp: boolean; top: number; text: string }

export class Screen {
  readonly cells: Uint32Array
  /** The icons painted on it, by cell. */
  readonly slots: Slot[] = []
  /** The hover cards of its cut rows. */
  readonly cards: Card[] = []
  constructor(readonly w: number, readonly h: number, fg: number) {
    this.cells = new Uint32Array(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      this.cells[i * 3] = 0x20
      this.cells[i * 3 + 1] = fg
      this.cells[i * 3 + 2] = DEFAULT_COLOR
    }
  }
  /** Writes `s` from column x, clipped to the screen; returns the column after it. */
  put(x: number, y: number, s: string, fg: number): number {
    if (y < 0 || y >= this.h) return x
    let X = x
    for (const ch of s) {
      if (X >= 0 && X < this.w) {
        const i = (y * this.w + X) * 3
        const cp = ch.codePointAt(0) ?? 0x20
        // one cell per character, so a control becomes `?` and the columns stay put
        this.cells[i] = isControl(cp) ? 0x3f : cp
        this.cells[i + 1] = fg
      }
      X++
    }
    return X
  }
  /** A copy of the w x h cells from (x, y), the slots inside it moved with them. */
  sub(x: number, y: number, w: number, h: number): Screen {
    const out = new Screen(w, h, 0)
    for (let r = 0; r < h; r++) out.cells.set(this.cells.subarray(((y + r) * this.w + x) * 3, ((y + r) * this.w + x + w) * 3), r * w * 3)
    for (const sl of this.slots) if (sl.y >= y && sl.y < y + h && sl.x >= x && sl.x < x + w) out.slots.push({ ...sl, x: sl.x - x, y: sl.y - y })
    for (const c of this.cards) if (c.y >= y && c.y < y + h) out.cards.push({ ...c, y: c.y - y })
    return out
  }
  /** The text of each row, for the non-terminal surfaces. */
  lines(): string[] {
    const out: string[] = []
    for (let y = 0; y < this.h; y++) {
      let row = ''
      for (let x = 0; x < this.w; x++) row += String.fromCodePoint(this.cells[(y * this.w + x) * 3]!)
      out.push(row.replace(/\s+$/, ''))
    }
    return out
  }
}

export function toBase64(words: Uint32Array): string {
  const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength)
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    parts.push(
      A[(n >> 18) & 63]! + A[(n >> 12) & 63]! +
        (i + 1 < bytes.length ? A[(n >> 6) & 63]! : '=') +
        (i + 2 < bytes.length ? A[n & 63]! : '='),
    )
  }
  return parts.join('')
}

// ---------------------------------------------------------------- formatting

/** `312k`, `1M`, `1.2M`, `850`. */
export function fmtTok(v: number): string {
  if (v >= 1_000_000) return String(Math.round(v / 100_000) / 10).replace(/\.0$/, '') + 'M'
  if (v >= 1000) return Math.round(v / 1000) + 'k'
  return String(Math.round(v))
}

/** `3d5h`, `2h05m`, `12m`; `now` when past. */
export function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  const m = Math.floor(ms / 60_000)
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${String(mm).padStart(2, '0')}m`
  return `${mm}m`
}

/** `1h12m`, `12m`. */
export function fmtElapsed(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

export const isStale = (updatedAt: number | undefined, now: number): boolean =>
  updatedAt !== undefined && now / 1000 - updatedAt > 600

/** What the minute tick would change on screen: the laid-out pane at that time. */
export function clockSignature(v: StackwellView, now: number): string {
  return JSON.stringify(layout({ ...v, now }, 48))
}

/** `claude-opus-5-5` -> `Opus 5.5`, `(1M)` added for a million-token window; the id when unknown. */
export function displayModel(id: string, window?: number): string {
  const isMillion = /\[1m\]/i.test(id) || (window ?? 0) >= 1_000_000
  const bare = id.replace(/\[1m\]/i, '').trim()
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+(?:-\d{1,2})*)(?:-\d{8})?$/i.exec(bare)
  let name = bare
  if (m) name = m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase() + ' ' + m[2]!.split('-').join('.')
  return isMillion && !/\(1M\)/.test(name) ? `${name} (1M)` : name
}

/** At most `n` cells: a longer text ends in `…`. */
const cut = (s: string, n: number) => {
  const a = Array.from(s)
  if (a.length <= n) return s
  return n <= 0 ? '' : a.slice(0, n - 1).join('') + '…'
}
const len = (s: string) => Array.from(s).length
const pctText = (p: number) => Math.round(p) + '%'

type Level = 'ok' | 'warn' | 'crit'
const ctxLevel = (p: number): Level => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : 'ok')
export const QUOTA_WARN = 80
const quotaLevel = (p: number): Level => (p >= 95 ? 'crit' : p >= QUOTA_WARN ? 'warn' : 'ok')
const stateCol = (l: Level, ok: number, P: StackwellPalette) => (l === 'crit' ? P.crit : l === 'warn' ? P.warn : ok)

/** Splits `n` cells by weights, largest remainder first; the parts sum to n. */
export function apportion(n: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0 || n <= 0) return weights.map(() => 0)
  const raw = weights.map(w => (w / total) * n)
  const out = raw.map(Math.floor)
  let left = n - out.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    out[i]!++
    left--
  }
  return out
}

// ---------------------------------------------------------------- rows

/**
 * A run of cells. With `icon`, the cells (two, blank) are where the terminal draws that
 * section's picture; `alt` is the word it stands for.
 */
type Seg = {
  text: string; fg: number; icon?: string; alt?: string; isBadge?: boolean
  /** A field's card label and whole value; `isCut` once its text shows less (or nothing: a marker of no cells). */
  label?: string; value?: string; isCut?: boolean
}
type Row = Seg[]

/** The section icons, one per group, each 2 columns by 1 row. */
export const SECTIONS = ['context', 'quota', 'session', 'agents', 'folders', 'steward', 'hatch'] as const
export type Section = (typeof SECTIONS)[number]
/** Columns an icon takes, and its gap: the label column when icons show. */
export const SECTION_COLS = 2
const ICON_LW = SECTION_COLS + 1

/**
 * Where a terminal draws no picture, the Image's alt fills its 2 cells: a glyph and a space.
 * Each is East Asian Width N (never ambiguous or wide) and no emoji, so it takes one cell anywhere.
 */
export const SECTION_ALT: Record<Section, string> = {
  context: '◔ ', quota: '◷ ', session: '≣ ', agents: '◉ ', folders: '▭ ', steward: '⚷ ', hatch: '◒ ',
}

/** The section's icon and its 1-cell gap; `alt` the section's glyph. */
const iconSegs = (name: Section, fg: number): Row => [
  { text: ' '.repeat(SECTION_COLS), fg, icon: name, alt: SECTION_ALT[name] },
  { text: ' ', fg },
]
/** The first row's label: the icon, or the word padded to w. */
const labelOf = (name: Section, word: string, w: number, fg: number, I: boolean): Row =>
  I ? iconSegs(name, fg) : [{ text: word.padEnd(w), fg }]
/** A later row's blank label, as wide as the first's. */
const indentOf = (w: number, I: boolean): Row => [{ text: ' '.repeat(I ? ICON_LW : w), fg: 0 }]
const rowLen = (r: Row) => r.reduce((n, x) => n + len(x.text), 0)

const SEGS = [
  ['msgs', 'msgs'],
  ['tools', 'tools'],
  ['sys', 'sys'],
  ['other', 'other'],
] as const satisfies readonly [keyof StackwellBreakdown, string][]

/** Text on the left, text on the right, the left cut to fit. */
function sides(W: number, left: Row, right: Row): Row {
  const rw = right.reduce((a, s) => a + len(s.text), 0)
  if (rw > W) return fitRow(right, W)
  const room = W - rw
  const l = fitRow(left, Math.max(0, room - (rw > 0 ? 1 : 0)))
  const lw = l.reduce((a, s) => a + len(s.text), 0)
  return [...l, { text: ' '.repeat(Math.max(0, W - lw - rw)), fg: 0 }, ...right]
}

/** Cuts a row to `n` cells, ending in `…`. */
function fitRow(row: Row, n: number): Row {
  const out: Row = []
  let used = 0
  const total = row.reduce((a, s) => a + len(s.text), 0)
  if (total <= n) return row
  let isFull = false
  for (const s of row) {
    const room = n - used
    const l = len(s.text)
    if (!isFull && room > 0 && used + l <= n) {
      out.push(s)
      used += l
    } else if (!isFull && room > 0 && !s.icon) {
      out.push({ ...s, text: cut(s.text, room), isCut: s.label !== undefined || s.isCut })
      used = n
      isFull = true
    } else {
      isFull = true
      // a field that no longer shows stays as a marker of no cells, for the card
      if (s.label !== undefined) out.push({ ...s, text: '', isCut: true })
    }
  }
  return out
}

/** A field's seg: `shown` the text drawn, `value` the whole; cut when they differ. */
const field = (label: string, value: string, shown: string, fg: number, isCut: boolean): Seg => ({ text: shown, fg, label, value, isCut })

/**
 * The fields a row's card lists: each field shown cut (a `…`, a shortened path) or dropped for
 * room, whole. Undefined for a row that shows every field whole.
 */
export function cardOf(row: Row): Field[] | undefined {
  // once one field is cut the card lists them all: a folder's path then its branch
  if (!row.some(s => s.isCut && s.label !== undefined && s.value)) return undefined
  const out: Field[] = []
  for (const s of row) {
    if (s.label === undefined || s.value === undefined || s.value === '') continue
    if (!out.some(f => f.label === s.label)) out.push({ label: s.label, text: s.value })
  }
  return out.length ? out : undefined
}

/** `text` in lines of at most `w` cells, broken at spaces where it can, hard where it cannot. */
export function wrapText(text: string, w: number): string[] {
  const n = Math.max(1, w)
  const out: string[] = []
  let line = ''
  for (const word of text.split(/(\s+)/)) {
    if (word === '') continue
    if (len(line + word) <= n) { line += word; continue }
    if (line.trim()) out.push(line.trimEnd())
    line = /^\s+$/.test(word) ? '' : word
    while (len(line) > n) {
      out.push(Array.from(line).slice(0, n).join(''))
      line = Array.from(line).slice(n).join('')
    }
  }
  if (line.trim() || out.length === 0) out.push(line.trimEnd())
  return out
}

/** The header's folder: cut when it shows less than the home-shortened path. */
const cwdSeg = (v: StackwellView, path: string, P: StackwellPalette): Seg =>
  field('cwd', v.cwd ?? '', path, P.dim, path !== shortPath(v.cwd ?? '', v.home ?? '', Infinity))

/** The model on the left; on the right the session folder, home-shortened, middle elided. */
function header(v: StackwellView, W: number, P: StackwellPalette): Row {
  const model = v.model ? displayModel(v.model, v.window ?? v.breakdown?.raw) : ''
  // the model stays whole; the path gives way
  const room = W - len(model) - 2
  const path = v.cwd && room >= 4 ? shortPath(v.cwd, v.home ?? '', room) : ''
  const right: Row = path ? [cwdSeg(v, path, P)] : []
  return sides(W, [{ text: model, fg: P.text }], fitRow(right, Math.max(0, room)))
}

function contextBar(v: StackwellView, W: number, P: StackwellPalette): Row {
  const pct = Math.max(0, Math.min(100, v.percent ?? 0))
  const level = ctxLevel(pct)
  const fill = Math.round((pct / 100) * W)
  const b = v.breakdown
  const weights = b ? SEGS.map(([k]) => b[k] as number) : [1]
  const parts = apportion(fill, weights.some(w => w > 0) ? weights : [1])
  const cells: number[] = []
  parts.forEach((n, i) => {
    const col = level === 'ok' ? (b ? P.steps[i]! : P.context) : stateCol(level, P.context, P)
    for (let k = 0; k < n; k++) cells.push(col)
  })
  const row: Row = cells.map(fg => ({ text: '━', fg }))
  for (let k = fill; k < W; k++) row.push({ text: '─', fg: P.dim })
  const win = v.window ?? b?.raw
  if (b?.autoCompact !== undefined && win) {
    const x = Math.round((b.autoCompact / win) * W)
    if (x > 0 && x < W) row[x] = { text: '┊', fg: P.dim }
  }
  return row
}

function legend(v: StackwellView, W: number, P: StackwellPalette): Row {
  const b = v.breakdown
  if (!b) return []
  let items = SEGS.map(([k, name], i) => ({ name, tokens: b[k] as number, col: P.steps[i]! })).filter(x => x.tokens > 0)
  const build = (gap: string): Row =>
    items.flatMap((x, i) => [
      ...(i > 0 ? [{ text: gap, fg: P.dim }] : []),
      { text: '▪ ', fg: x.col },
      { text: `${x.name} ${fmtTok(x.tokens)}`, fg: P.dim },
    ])
  const width = (r: Row) => r.reduce((a, s) => a + len(s.text), 0)
  while (items.length > 1 && width(build('  ')) > W) {
    const min = items.reduce((m, x) => (x.tokens < m.tokens ? x : m))
    items = items.filter(x => x !== min)
  }
  return fitRow(build('  '), W)
}

const quotaKind = (kind: string): string =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind.replace(/_.*/, '').slice(0, 4).toLowerCase()

const sortQuotas = (qs: StackwellQuota[]) => {
  const order = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2)
  return [...qs].sort((a, b) => order(a.kind) - order(b.kind))
}

/** `12m`, `5h`, `3d`. */
export function fmtAgo(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

/** A name with a status on the right; the status goes before the name is cut. */
function nameStatus(W: number, lead: Row, name: string, status: Seg | undefined): Row {
  const used = lead.reduce((n, x) => n + len(x.text), 0)
  const fitsAll = status && used + len(name) + 1 + len(status.text) <= W
  const named = field('session', name, name, 0, false)
  if (status && fitsAll) return sides(W, [...lead, named], [status])
  return fitRow([...lead, named], W)
}

/**
 * The steward section as a tree: `★ initiative` when this session is the primary (its
 * secondaries below), the initiative alone when a secondary (`↑` the primary, then the
 * siblings); the decision log's age last.
 */
function stewardLines(st: StackwellSteward, v: StackwellView, W: number, LW: number, isNarrow: boolean, P: StackwellPalette, I = false): Line[] {
  const head: Row = labelOf('steward', isNarrow ? 'stw' : 'steward', LW, P.steward, I)
  if (st.role === 'primary') head.push({ text: '★ ', fg: P.steward })
  head.push(field('initiative', st.initiative, st.initiative, P.text, false))
  const out: Line[] = [{ row: fitRow(head, W), kind: 'core' }]
  const hasLog = st.logMtime !== undefined
  const branches = st.peers.filter(p => p.role !== 'primary')
  // `busy 4m`, `idle 12m`: how long since the status changed; `offline` alone
  const status = (p: StackwellPeer): Seg | undefined =>
    p.status
      ? { text: p.status + (p.since !== undefined && p.status !== 'offline' ? ' ' + fmtAgo(v.now - p.since) : ''), fg: p.status === 'busy' ? P.text : P.dim }
      : undefined
  const named = (row: Row): Row => row.map(x => (x.fg === 0 ? { ...x, fg: P.text } : x))
  for (const p of st.peers.filter(p => p.role === 'primary'))
    out.push({ row: named(nameStatus(W, [{ text: '  ↑  ', fg: P.dim }], p.name, status(p))), kind: 'speer' })
  branches.forEach((p, i) => {
    const isLast = i === branches.length - 1 && !hasLog
    out.push({ row: named(nameStatus(W, [{ text: isLast ? '  └─ ' : '  ├─ ', fg: P.dim }], p.name, status(p))), kind: 'speer' })
  })
  if (hasLog) out.push({ row: fitRow([{ text: `  └─ log ${fmtAgo(v.now - st.logMtime!)} ago`, fg: P.dim }], W), kind: 'slog' })
  return out
}

/** A bar of n cells at pct, an optional `│` at cell `tick`. */
function bar(n: number, pct: number, fill: number, P: StackwellPalette, tick?: number): Row {
  const f = Math.max(0, Math.min(n, Math.round((pct / 100) * n)))
  const cells: Seg[] = []
  for (let i = 0; i < n; i++) cells.push(i < f ? { text: '━', fg: fill } : { text: '─', fg: P.dim })
  if (tick !== undefined && tick >= 0 && tick < n) cells[tick] = { text: '│', fg: P.text }
  return cells
}

const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 24 * 3600_000 }

/** The share of the window gone, when its length and reset are known. */
function paceShare(kind: string, resetsAt: number | undefined, now: number): number | undefined {
  const len = WINDOW_MS[kind]
  if (len === undefined || resetsAt === undefined) return undefined
  const share = (len - (resetsAt - now)) / len
  return share >= 0 && share <= 1 ? share : undefined
}

/** label, bar, percent, countdown: the shape of every quota and account row. */
function meterRow(
  W: number, label: Row, pct: number, resetsAt: number | undefined, now: number,
  fill: number, pctCol: number, P: StackwellPalette, pace?: number,
): Row {
  const pctT = ' ' + pctText(pct).padStart(4)
  const cd = resetsAt === undefined ? '' : fmtCountdown(resetsAt - now)
  const cdText = cd ? '  ' + cd.padStart(5) : ''
  const n = Math.max(3, W - rowLen(label) - len(pctT) - (cd ? 7 : 0))
  const tick = pace === undefined ? undefined : Math.round(pace * n)
  return fitRow([...label, ...bar(n, pct, fill, P, tick), { text: pctT, fg: pctCol }, { text: cdText, fg: P.dim }], W)
}

/** With icons: the icon (first row) or the indent, then the window's name in 4 cells. */
function quotaRow(q: StackwellQuota, v: StackwellView, W: number, LW: number, isNarrow: boolean, P: StackwellPalette, I = false, isFirst = true): Row {
  const level = quotaLevel(q.pct)
  const label: Row = I
    ? [...(isFirst ? iconSegs('quota', P.quota) : indentOf(LW, true)), { text: quotaKind(q.kind).padEnd(4), fg: P.quota }]
    : [{ text: (isNarrow ? quotaKind(q.kind) : 'quota ' + quotaKind(q.kind)).padEnd(LW), fg: P.quota }]
  return meterRow(W, label, q.pct, q.resetsAt, v.now, stateCol(level, P.quota, P), stateCol(level, P.text, P), P,
    paceShare(q.kind, q.resetsAt, v.now))
}

/** One row per other account: each window it reports, named, with percent and reset; or `stale`. */
function accountRows(v: StackwellView, W: number, LW: number, isNarrow: boolean, P: StackwellPalette): Row[] {
  const out: Row[] = []
  for (const a of v.accounts) {
    if (a.name === v.profile) continue
    const label = cut(isNarrow ? a.name : `acct ${a.name}`, LW - 2)
    if (isStale(a.updatedAt, v.now)) {
      out.push([{ text: cut(`${isNarrow ? a.name : 'acct ' + a.name}  stale`, W), fg: P.dim }])
      continue
    }
    const wins = [
      { kind: '5h', pct: a.h5, at: a.h5At },
      { kind: '7d', pct: a.d7, at: a.d7At },
    ].filter((w): w is { kind: string; pct: number; at: number | undefined } => typeof w.pct === 'number' && Number.isFinite(w.pct))
    if (wins.length === 0) continue
    const segs = (w: (typeof wins)[number]): Row => [
      { text: w.kind + ' ', fg: P.dim },
      { text: pctText(w.pct), fg: stateCol(quotaLevel(w.pct), P.text, P) },
      ...(w.at === undefined ? [] : [{ text: '  ' + fmtCountdown(w.at - v.now), fg: P.dim }]),
    ]
    const build = (ws: typeof wins): Row => [
      { text: label.padEnd(LW), fg: P.dim },
      ...ws.flatMap((w, i) => [...(i > 0 ? [{ text: '   ', fg: P.dim }] : []), ...segs(w)]),
    ]
    let row = build(wins)
    // both do not fit: the fuller window alone, still named
    if (row.reduce((n, x) => n + len(x.text), 0) > W) row = build([wins.reduce((m, x) => (x.pct > m.pct ? x : m))])
    out.push(fitRow(row, W))
  }
  return out
}

/** `+9k`, `−5k`, `+0`. */
const signedTok = (n: number) => (n < 0 ? '−' : '+') + fmtTok(Math.abs(n))

/** Mean growth over the last 5 turns, or undefined with fewer than two points. */
function growth(trend: number[]): number | undefined {
  const pts = trend.slice(-6)
  if (pts.length < 2) return undefined
  return (pts[pts.length - 1]! - pts[0]!) / (pts.length - 1)
}

/** The context row's projection, best first: growth and turns left, then turns left alone, shortened. */
function trendTexts(v: StackwellView): string[] {
  const g = growth(v.trend)
  if (g === undefined) return []
  const per = `${signedTok(g)}/turn`
  const thr = v.breakdown?.autoCompact
  const cur = v.tokens ?? v.trend[v.trend.length - 1]!
  const n = g > 0 && thr !== undefined && thr > cur ? Math.round((thr - cur) / g) : undefined
  if (n === undefined || n > 999) return [per]
  return [`${per} · ~${n} turns left`, `~${n} turns left`, `~${n} turns`]
}

/** `context  ~87 turns left   131k / 1M  13%`: `+Xk/turn` goes first, then the window, then `left`, then all of it. */
function contextRow(v: StackwellView, W: number, isNarrow: boolean, P: StackwellPalette, I = false): Row {
  const label: Row = I ? iconSegs('context', P.context) : [{ text: (isNarrow ? 'ctx' : 'context') + '  ', fg: P.context }]
  const win = v.window ?? v.breakdown?.raw
  const pct: Seg = { text: '  ' + pctText(v.percent ?? 0).padStart(4), fg: stateCol(ctxLevel(v.percent ?? 0), P.text, P) }
  const nums = (withWin: boolean): Row =>
    v.tokens === undefined ? [pct] : [{ text: fmtTok(v.tokens) + (withWin && win ? ` / ${fmtTok(win)}` : ''), fg: P.text }, pct]
  const width = (r: Row) => r.reduce((n, x) => n + len(x.text), 0)
  const texts = trendTexts(v)
  const tries: [string, Row][] = texts.length === 1
    ? [[texts[0]!, nums(true)], [texts[0]!, nums(false)]]
    : [[texts[0], nums(true)], [texts[1], nums(true)], [texts[1], nums(false)], [texts[2], nums(false)]].filter((x): x is [string, Row] => x[0] !== undefined)
  for (const [t, r] of tries) {
    if (rowLen(label) + len(t) + 2 + width(r) <= W) return sides(W, [...label, { text: t, fg: P.dim }], r)
  }
  return sides(W, label, fitRow(nums(true), W - rowLen(label)))
}

/** `0.4s`, `12s`, `2m10s`, `1h05m`. */
export function fmtDur(ms: number): string {
  const s = ms / 1000
  if (s < 10) return s.toFixed(1) + 's'
  if (s < 60) return Math.round(s) + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(Math.floor(s % 60)).padStart(2, '0')}s`
  return fmtElapsed(ms)
}

type Piece = { text: string; fg: number; drop?: number }

/** `session  $47.04 est · $22/h · 2h11m   turn 14 · 2m10s · +12k`; pieces with a `drop` rank go lowest first. */
function sessionRow(v: StackwellView, W: number, LW: number, isNarrow: boolean, P: StackwellPalette, I = false): Row | undefined {
  const el = v.startedAt === undefined ? undefined : v.now - v.startedAt
  const left: Piece[][] = []
  if (v.costUsd !== undefined) {
    left.push([{ text: `$${v.costUsd.toFixed(2)}`, fg: P.session }, { text: ' est', fg: P.dim }])
    if (el !== undefined && el >= 5 * 60_000) {
      const rate = v.costUsd / (el / 3600_000)
      left.push([{ text: `$${rate >= 10 ? Math.round(rate) : rate.toFixed(1)}/h`, fg: P.dim, drop: 2 }])
    }
  }
  if (el !== undefined) left.push([{ text: fmtElapsed(el), fg: P.dim }])
  const right: Piece[][] = []
  if (v.turns >= 1) {
    right.push([{ text: `turn ${v.turns}`, fg: P.dim, drop: 4 }])
    if (v.lastTurnMs !== undefined) right.push([{ text: fmtDur(v.lastTurnMs), fg: P.dim, drop: 3 }])
    const g = v.trend.length >= 2 ? v.trend[v.trend.length - 1]! - v.trend[v.trend.length - 2]! : undefined
    if (g !== undefined) right.push([{ text: signedTok(g), fg: P.dim, drop: 1 }])
  }
  if (left.length === 0 && right.length === 0) return undefined
  const join = (gs: Piece[][]): Row => gs.flatMap((g, i) => (i ? [{ text: ' · ' + g[0]!.text, fg: g[0]!.fg }, ...g.slice(1)] : g))
  const width = (r: Row) => r.reduce((n, x) => n + len(x.text), 0)
  const keep = (gs: Piece[][], rank: number) => gs.filter(g => (g[0]!.drop ?? 99) > rank)
  const head = labelOf('session', isNarrow ? 'sess' : 'session', LW, P.session, I)
  for (let rank = 0; rank <= 4; rank++) {
    const l: Row = [...head, ...join(keep(left, rank))], r = join(keep(right, rank))
    if (width(l) + (r.length ? 2 + width(r) : 0) <= W) return r.length ? sides(W, l, r) : l
  }
  return fitRow([...head, ...join(keep(left, 4))], W)
}

const FOLDER_ROWS = 4

/**
 * A Raster cell takes one width-1 BMP character: escape sequences and controls go whole
 * (`printable`), then anything outside printable ASCII becomes `?`, one per UTF-16 unit.
 */
const clean = (s: string) => printable(s).replace(/[^\x20-\x7e]/g, '?')
/**
 * The printable path from `~` when its cleaned form lies under the cleaned home: the card shows the
 * whole name. `clean` keeps a printable string's length, so the home's length cuts it in step.
 */
const homedRaw = (key: string, home: string) => {
  const p = printable(key)
  const c = clean(p)
  return home && (c === home || c.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
}

/** `+2 −0`, with `?3` for untracked files; `clean`; `—` for a repo outside the cwd's (no git runs there); nothing outside a repo. */
const changesOf = (f: StackwellFolder): string => {
  if (f.isRepo && f.isOutside) return '—'
  if (!f.isRepo || f.added === undefined) return ''
  const n = (f.added ?? 0) + (f.removed ?? 0)
  const q = f.untracked ? ` ?${f.untracked}` : ''
  return n === 0 && !f.untracked ? 'clean' : `+${f.added ?? 0} −${f.removed ?? 0}${q}`
}

const ageOf = (ms: number) => (ms < 60_000 ? 'now' : fmtAgo(ms))

/** The session folder first, then the others most recently touched first. */
export const sortFolders = (fs: StackwellFolder[]): StackwellFolder[] =>
  [...fs].sort((a, b) => Number(b.isCwd) - Number(a.isCwd) || b.lastAt - a.lastAt)

/**
 * `folders`, then one row per folder: mark, name, branch, changes, age, tag; past the cap a
 * `+N more` toggle (a Button), `show less` while open. With icons the word row goes: the icon
 * leads the first folder row, later rows keep its indent.
 */
function folderLines(v: StackwellView, W: number, LW: number, P: StackwellPalette, I = false): Line[] {
  if (v.folders.length === 0) return []
  const all = sortFolders(v.folders)
  const isOpen = v.isFoldersOpen === true && all.length > FOLDER_ROWS
  const shown = isOpen ? all : all.slice(0, FOLDER_ROWS)
  const out: Line[] = I ? [] : [{ row: [{ text: 'folders', fg: P.git }], kind: 'folder' }]
  // the lead before the mark: 2 blank cells, or the icon (first row) and its indent
  const leadW = I ? ICON_LW : 2
  const changes = shown.map(changesOf)
  // where each folder is: from the cwd, near it, or from ~
  // the view holds cwd and home cleaned for the cells: the key is cleaned the same way to match them
  const names = shown.map(f => (f.isCwd ? f.name ?? basename(f.key) : clean(folderLabel(clean(f.key), v.cwd ?? '', v.home ?? ''))))
  // the cwd row is always `now`: no age there
  const ageText = (f: StackwellFolder) => (f.isCwd ? '' : ageOf(v.now - f.lastAt))
  const rights = shown.map(f => ageText(f).padStart(f.isCwd ? 0 : 3) + (f.tag ? '  ' + f.tag : ''))
  const cw = Math.max(0, ...changes.map(len))
  const rw = Math.max(...rights.map(len))
  // name and branch share what is left; the name takes the larger part
  const rest = Math.max(2, W - leadW - 2 - rw - 2 - (cw ? cw + 2 : 0) - 2)
  const maxName = Math.max(...names.map(len))
  const maxBranch = Math.max(0, ...shown.map(f => len(f.branch ?? '')))
  let nw = Math.min(maxName, Math.max(Math.ceil(rest * 0.55), rest - maxBranch))
  let bw = rest - nw
  if (maxBranch === 0) { nw = Math.min(maxName, rest + 2); bw = 0 }
  shown.forEach((f, i) => {
    const mark = f.isCwd ? '●' : f.isWorktree ? '⎇' : ' '
    const lead: Row = I ? (i === 0 ? iconSegs('folders', P.git) : indentOf(LW, true)) : [{ text: '  ', fg: P.dim }]
    const shownName = fitPath(names[i]!, nw)
    const row: Row = [
      ...lead,
      { text: `${mark} `, fg: f.isCwd ? P.git : P.dim },
      field('path', homedRaw(f.key, v.home ?? ''), shownName.padEnd(nw), P.text, shownName !== names[i]),
    ]
    const br = f.branch ?? ''
    if (bw > 0) row.push(field('branch', br, '  ' + cut(br, bw).padEnd(bw), P.dim, len(br) > bw))
    else if (br) row.push(field('branch', br, '', P.dim, true))
    if (cw) row.push(field('changes', changes[i]!, '  ' + changes[i]!.padEnd(cw), changes[i] === 'clean' ? P.dim : P.text, false))
    const right: Row = ageText(f) ? [{ text: ageText(f), fg: P.dim }] : []
    if (f.tag) right.push({ text: (right.length ? '  ' : '') + f.tag, fg: P.dim })
    out.push({ row: sides(W, fitRow(row, Math.max(0, W - rw - 1)), right), kind: i === 0 ? 'folder' : 'frow' })
  })
  // the toggle: `show less` stays as long as the section does, so an open list can always close
  if (isOpen) out.push({ row: [{ text: cut(' '.repeat(leadW + 2) + 'show less', W), fg: P.dim }], kind: 'fless' })
  else if (all.length > FOLDER_ROWS) out.push({ row: [{ text: cut(' '.repeat(leadW + 2) + `+${all.length - FOLDER_ROWS} more`, W), fg: P.dim }], kind: 'fmore' })
  return out
}

const BINDER_BLOCKS = 2

/** The hatch section: a block per running binder (at most 2), and one light line for those not started. */
function hatchLines(v: StackwellView, W: number, LW: number, P: StackwellPalette, I = false): Line[] {
  if (v.binders.length === 0) return []
  const running = v.binders.filter(b => b.isRunning)
  const ready = v.binders.filter(b => !b.isRunning)
  const out: Line[] = []
  const label = (first: boolean): Row => (first ? labelOf('hatch', 'hatch', LW, P.hatch, I) : indentOf(LW, I))
  running.slice(0, BINDER_BLOCKS).forEach((b, i) => {
    out.push({
      row: fitRow([...label(i === 0), field('binder', b.slug, b.slug, P.text, false), { text: ` · wave ${b.wave}/${b.waves}`, fg: P.dim }], W),
      kind: 'hhead',
    })
    const tail = ` ${b.merged}/${b.total} merged`
    const n = Math.max(3, W - 2 - len(tail))
    out.push({ row: fitRow([{ text: '  ', fg: P.dim }, ...bar(n, b.total ? (b.merged / b.total) * 100 : 0, P.hatch, P), { text: tail, fg: P.dim }], W), kind: 'hhead' })
    const names = (xs: string[], mark: string, fg: number, word: string) => {
      if (xs.length === 0) return
      const room = W - 2 - len(word) - 1
      const parts: Row = []
      const all = xs.join(', ')
      let used = 0
      for (const [k, x] of xs.entries()) {
        const t = (k ? '  ' : '') + mark + ' ' + x
        if (used + len(t) > room) {
          const left = room - used
          if (left > 3) parts.push(field(word, all, cut(t, left), fg, true))
          break
        }
        parts.push(field(word, all, t, fg, false))
        used += len(t)
      }
      out.push({ row: sides(W, [{ text: '  ', fg: P.dim }, ...parts], [{ text: word, fg: P.dim }]), kind: 'hitems' })
    }
    names(b.building, '•', P.text, 'building')
    names(b.halted, '✕', P.warn, 'halted')
  })
  if (running.length > BINDER_BLOCKS) out.push({ row: [{ text: cut(`  +${running.length - BINDER_BLOCKS} more running`, W), fg: P.dim }], kind: 'hitems' })
  if (ready.length) {
    const list = ready.map(b => `${b.slug} ${b.total} ${b.total === 1 ? 'item' : 'items'}`)
    if (running.length === 0) {
      out.push({ row: fitRow([...label(true), { text: `${ready.length} ${ready.length === 1 ? 'binder' : 'binders'} ready`, fg: P.dim }], W), kind: 'hhead' })
    }
    // as many as fit, then `+N more`
    let text = '  ' + (running.length ? 'ready: ' : '')
    let shownN = 0
    for (const [k, x] of list.entries()) {
      const more = list.length - k - 1
      const add = (k ? ' · ' : '') + x
      const tailRoom = more ? len(` · +${more} more`) : 0
      if (len(text + add) + tailRoom > W) break
      text += add
      shownN++
    }
    if (shownN < list.length) text += (shownN ? ' · ' : '') + `+${list.length - shownN} more`
    out.push({ row: [field('ready', ready.map(b => b.slug).join(', '), cut(text, W), P.dim, len(text) > W)], kind: 'hhead' })
  }
  return out
}

const AGENT_KEEP = 5 * 60_000
const isAgentShown = (a: StackwellAgent, now: number) => a.status === 'running' || (a.endedAt !== undefined && now - a.endedAt < AGENT_KEEP)

/** `claude-opus-5-5` -> `opus 5.5`, an alias (`opus`) as given: an agent row's model, short. */
export function agentModel(id: string): string {
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+(?:-\d{1,2})*)(?:-\d{8})?$/i.exec(id.replace(/\[1m\]/i, '').trim())
  return m ? `${m[1]!.toLowerCase()} ${m[2]!.split('-').join('.')}` : id
}

const EFFORT_CODES: Record<string, string> = { low: 'l', medium: 'm', high: 'h', xhigh: 'xh', max: 'max' }
/** `xhigh` -> `xh`, `medium` -> `m`; a budget as given. */
export const effortCode = (e: string): string => EFFORT_CODES[e] ?? e

/**
 * `[✓] [badge] kind  description  model effort  age`: the steward badge before a steward
 * plugin's kind; when tight the description shortens (then goes), then the effort goes,
 * then the model; kind and age stay. An agent stored before kinds shows its name where the
 * kind goes. The card always lists every field, whole.
 */
function agentRow(a: StackwellAgent, lead: Row, v: StackwellView, W: number, P: StackwellPalette, I = false): Row {
  const isDone = a.status !== 'running'
  const kindT = a.kind ?? a.name ?? 'agent'
  const desc = a.kind && a.name && a.name !== a.kind ? a.name : ''
  // the card's fields in its order, as markers of no cells: cardOf lists a label's first seg
  const status = (a.status === 'ok' ? 'done' : a.status) + (a.isBackground ? ', background' : '')
  // a stored view may hold anything: only strings draw
  const modelId = typeof a.model === 'string' && a.model ? a.model : ''
  const effortId = typeof a.effort === 'string' && a.effort ? a.effort : ''
  const card: [string, string][] = [
    ['kind', kindT], ['plugin', a.plugin ?? 'none'], ['model', modelId || 'unknown'], ['effort', effortId || 'unknown'],
    ...(desc ? [['task', desc] as [string, string]] : []), ['started', hhmm(a.startedAt)], ['status', status],
  ]
  const head: Row = [...lead, ...card.map(([label, value]) => field(label, value, '', P.dim, true))]
  if (isDone) head.push({ text: a.status === 'ok' ? '✓ ' : '✕ ', fg: P.dim })
  if (a.kind && isStewardPlugin(a.plugin))
    head.push(...(I ? iconSegs('steward', P.steward).map((x, k) => (k === 0 ? { ...x, isBadge: true } : x)) : [{ text: 'stw ', fg: P.steward }]))
  head.push(field('kind', kindT, kindT, isDone ? P.dim : P.text, false))
  const el = fmtElapsed((isDone ? a.endedAt ?? v.now : v.now) - a.startedAt)
  const room = W - rowLen(head) - len(el) - 1
  const model = modelId ? agentModel(modelId) : ''
  const effort = effortId ? effortCode(effortId) : ''
  // the model and effort shown, longest first; the description takes what is left, at least 6
  // cells, and never comes back once the model is gone
  const metas = [...new Set([model && effort ? `  ${model} ${effort}` : '', model ? `  ${model}` : ''].filter(Boolean)), '']
  let metaT = ''
  let descT = ''
  for (const m of metas) {
    if (len(m) > room) continue
    const d = room - len(m) - 2
    metaT = m
    descT = desc && d >= 6 && (m || !model) ? '  ' + cut(desc, d) : ''
    break
  }
  const left: Row = [...head]
  if (descT) left.push({ text: descT, fg: P.dim })
  if (metaT) left.push({ text: metaT, fg: P.dim })
  return sides(W, left, [{ text: el, fg: P.dim }])
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`

type Kind = 'core' | 'acct' | 'folder' | 'frow' | 'fmore' | 'fless' | 'done' | 'slog' | 'speer' | 'hhead' | 'hitems'
type Line = { row: Row; kind: Kind }

/** Columns the icon and its gap take from the header rows. */
export const ICON_COLS = 4
const ICON_GAP = 1

/** The header beside the icon: the model, then the session folder, dim. */
function iconHeader(v: StackwellView, W: number, P: StackwellPalette): Row[] {
  const model = v.model ? displayModel(v.model, v.window ?? v.breakdown?.raw) : ''
  const top = fitRow([{ text: model, fg: P.text }], W)
  const path = v.cwd ? shortPath(v.cwd, v.home ?? '', W) : ''
  return [top, path ? [cwdSeg(v, path, P)] : []]
}

/** `I`: section icons in place of the section words. */
function groups(v: StackwellView, W: number, hasIcon = false, I = false): Line[][] {
  const P = v.palette
  const isNarrow = W < 44
  // every label is at most LW - 2 long: 2 spaces always stand before the content
  const LW = isNarrow ? 7 : 12
  const core = (row: Row): Line => ({ row, kind: 'core' })
  const out: Line[][] = [hasIcon ? iconHeader(v, W - ICON_COLS - ICON_GAP, P).map(core) : [core(header(v, W, P))]]
  if (v.percent === undefined && v.tokens === undefined) {
    out.push([core([{ text: cut('waiting for first turn', W), fg: P.dim }])])
    return out
  }
  // context
  const ctx: Line[] = [core(contextRow(v, W, isNarrow, P, I)), core(contextBar(v, W, P))]
  const leg = legend(v, W, P)
  if (leg.length) ctx.push(core(leg))
  out.push(ctx)
  // quota
  const quota: Line[] = sortQuotas(v.quotas.filter(q => Number.isFinite(q.pct))).map((q, i) => core(quotaRow(q, v, W, LW, isNarrow, P, I, i === 0)))
  for (const r of accountRows(v, W, LW, isNarrow, P)) quota.push({ row: r, kind: 'acct' })
  out.push(quota)
  // steward: only while this session is in the registry
  out.push(v.steward ? stewardLines(v.steward, v, W, LW, isNarrow, P, I) : [])
  // hatch: while binders exist in a folder's repo
  out.push(hatchLines(v, W, LW, P, I))
  // folders, in place of a single git row
  out.push(folderLines(v, W, LW, P, I))
  // agents: running newest first, then finished newest first
  const shown = v.agents.filter(a => isAgentShown(a, v.now))
  const running = shown.filter(a => a.status === 'running').sort((a, b) => b.startedAt - a.startedAt)
  const done = shown.filter(a => a.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  out.push(
    [...running, ...done].map((a, i) => ({
      row: agentRow(a, i === 0 ? labelOf('agents', isNarrow ? 'agt' : 'agents', LW, P.agents, I) : indentOf(LW, I), v, W, P, I),
      kind: a.status === 'running' ? ('core' as const) : ('done' as const),
    })),
  )
  // session, last
  const sess: Line[] = []
  const s = sessionRow(v, W, LW, isNarrow, P, I)
  if (s) sess.push(core(s))
  out.push(sess)
  return out
}

// `show less` goes only with the section's last row: an open list can always close
const DROP: Kind[] = ['done', 'hitems', 'fmore', 'frow', 'acct', 'hhead', 'folder', 'fless', 'slog', 'speer']

/** The pane, top to bottom, at most H rows; where the folders toggle is (-1 when absent). */
export function layoutAt(v: StackwellView, W: number, H = Infinity, hasIcon = false, I = false): { rows: Row[]; moreAt: number } {
  let gs = groups(v, W, hasIcon, I)
  const flat = (xs: Line[][]): Line[] => {
    const lines: Line[] = []
    for (const g of xs.filter(g => g.length > 0)) {
      if (lines.length) lines.push({ row: [], kind: 'core' })
      lines.push(...g)
    }
    return lines
  }
  for (const k of DROP) {
    if (flat(gs).length <= H) break
    gs = gs.map(g => g.filter(l => l.kind !== k))
  }
  const lines = flat(gs)
  const moreAt = lines.findIndex(l => l.kind === 'fmore' || l.kind === 'fless')
  const cut = lines.map(l => l.row).slice(0, H === Infinity ? undefined : Math.max(1, H))
  return { rows: cut, moreAt: moreAt < cut.length ? moreAt : -1 }
}

export const layout = (v: StackwellView, W: number, H = Infinity, hasIcon = false, I = false): Row[] => layoutAt(v, W, H, hasIcon, I).rows

export type { Row, Seg }

type PaneCard = Omit<Card, 'y'>

/** `cards` by layout row, `base` the layout row of rows[0]. */
function paint(rows: Row[], cols: number, top: number, bottom: number, fg: number, left = 2, base = 0, cards?: Map<number, PaneCard>): Screen {
  const sc = new Screen(cols, rows.length + top + bottom, fg)
  rows.forEach((r, y) => {
    const c = cards?.get(base + y)
    if (c) sc.cards.push({ ...c, y: y + top })
    let x = left
    for (const s of r) {
      if (s.icon) sc.slots.push({ x, y: y + top, icon: s.icon, alt: s.alt ?? s.icon, isBadge: s.isBadge === true })
      x = sc.put(x, y + top, s.text, s.fg || fg)
    }
  })
  return sc
}

/** A row's icons by cell from its start, for a row drawn outside a Raster. */
export function rowSlots(row: Row): Slot[] {
  const out: Slot[] = []
  let x = 0
  for (const s of row) {
    if (s.icon) out.push({ x, y: 0, icon: s.icon, alt: s.alt ?? s.icon, isBadge: s.isBadge === true })
    x += len(s.text)
  }
  return out
}

/** A run of painted rows (a Raster), or a row the caller draws as a Button: the `folders` toggle. */
export type PanePiece = { screen: Screen } | { button: 'folders'; row: Row }

/** The pane: the icon's header beside it, then the pieces top to bottom. */
export type Parts = { head?: Screen; pieces: PanePiece[] }

/**
 * The pane inside its margins (1 row top and bottom, 2 columns each side), cut where elements
 * other than a Raster go: with the icon, the 2-row header (`head`, drawn right of the icon, the
 * top margin above it); the folders toggle (a Button).
 */
export function drawParts(v: StackwellView, columns: number, rows = Infinity, hasIcon = false, hasSections = false): Parts {
  const cols = Math.max(5 + (hasIcon ? ICON_COLS + ICON_GAP : 0), columns)
  const { rows: all, moreAt } = layoutAt(v, cols - 4, Math.max(1, rows - 2), hasIcon, hasSections)
  const fg = v.palette.text
  const cards = paneCards(all, cols, rows, [moreAt].filter(k => k >= 0), hasIcon)
  const out: Parts = { pieces: [] }
  let content = all
  let shift = 0
  let topMargin = 1
  if (hasIcon) {
    // the header Raster sits right of the icon: no left margin of its own, the right one kept
    out.head = paint(all.slice(0, 2), cols - 2 - ICON_COLS - ICON_GAP, 1, 0, fg, 0, 0, cards)
    content = all.slice(2)
    shift = 2
    topMargin = 0
  }
  const cuts = ([[moreAt - shift, 'folders']] as const).filter(c => c[0] >= 0)
  let from = 0
  for (const [at, button] of cuts) {
    out.pieces.push({ screen: paint(content.slice(from, at), cols, from === 0 ? topMargin : 0, 0, fg, 2, shift + from, cards) })
    out.pieces.push({ button, row: content[at]! })
    from = at + 1
  }
  out.pieces.push({ screen: paint(content.slice(from), cols, from === 0 ? topMargin : 0, 1, fg, 2, shift + from, cards) })
  return out
}

/** Fields a card puts on one line, `a · b`, when the pair fits. */
const CARD_PAIRS: [string, string][] = [['kind', 'plugin'], ['model', 'effort'], ['started', 'status'], ['branch', 'changes']]
/** Fields a card lists last, after every other. */
const CARD_LAST = ['task']

/** A field as its card shows it: the value, with a word where the value alone says too little. */
function cardField(f: Field): string {
  const t = printable(f.text)
  switch (f.label) {
    case 'plugin': return t === 'none' ? 'no plugin' : t
    case 'model': return t === 'unknown' ? 'model unknown' : t
    case 'effort': return t === 'unknown' ? 'effort unknown' : t
    case 'started': case 'building': case 'halted': case 'ready': return `${f.label} ${t}`
    default: return t
  }
}

/** A card's fields as lines of shown text, in its order: paired fields together, `task` last. */
function cardGroups(fields: Field[]): string[][] {
  const groups: string[][] = []
  const last: string[][] = []
  const done = new Set<Field>()
  for (const f of fields) {
    if (done.has(f)) continue
    const pair = CARD_PAIRS.find(p => p.includes(f.label))
    const members = pair ? pair.flatMap(l => fields.filter(x => x.label === l && !done.has(x))) : [f]
    for (const m of members) done.add(m)
    ;(CARD_LAST.includes(f.label) ? last : groups).push(members.map(cardField))
  }
  return [...groups, ...last]
}

/** What a press on a cut row copies: each field whole, one per line, in the card's order. */
export function cardText(fields: Field[]): string {
  return cardGroups(fields).flat().join('\n')
}

/**
 * A card's lines, `w` cells wide: paired fields on one line, `a · b`, where the pair fits;
 * otherwise each value on lines of its own, wrapped at spaces (by character where a word is
 * wider), the lines after its first indented 2. Nothing is ever cut.
 */
export function cardLines(fields: Field[], w: number): string[] {
  const n = Math.max(3, w)
  const one = (t: string) => {
    const first = wrapText(t, n)[0]!
    const rest = Array.from(t.trimStart()).slice(len(first)).join('').trimStart()
    return [first, ...(rest ? wrapText(rest, n - 2).map(l => '  ' + l) : [])]
  }
  return cardGroups(fields).flatMap(g => {
    const joined = g.join(' · ')
    return len(joined) <= n ? [joined] : g.flatMap(one)
  })
}

/**
 * Each cut row's card, by layout row: its text wrapped to the pane, never cut, and where it opens.
 * Layout row k sits on pane row k + 1 (the top margin, or the icon header's). A card opens below
 * its row unless that would run past the pane's `rows` or over a Button row, then above; too tall
 * either way, at the pane's top over all of it; only taller than the pane, cut to it with a last
 * `…` line. The icon header's open below the header.
 */
function paneCards(all: Row[], cols: number, rows: number, buttonsAt: number[], hasIcon: boolean): Map<number, PaneCard> {
  const out = new Map<number, PaneCard>()
  const buttons = buttonsAt.map(k => k + 1)
  const width = cols
  all.forEach((r, k) => {
    const fields = cardOf(r)
    if (!fields) return
    const lines = cardLines(fields, width - 4)
    const text = cardText(fields)
    const h = lines.length + 2
    const y = k + 1
    if (hasIcon && k < 2) return void out.set(k, { at: y, lines, text, width, isUp: false, top: 3 })
    // the rows free below and above, counted to h at most: inside the pane, up to the first Button
    const free = (step: 1 | -1) => {
      let n = 0
      for (let r = y + step; n < h && r >= 0 && r < rows && !buttons.includes(r); r += step) n++
      return n
    }
    if (h <= free(1)) return void out.set(k, { at: y, lines, text, width, isUp: false, top: y + 1 })
    if (h <= free(-1)) return void out.set(k, { at: y, lines, text, width, isUp: true, top: y - h })
    if (h <= rows) return void out.set(k, { at: y, lines, text, width, isUp: false, top: 0 })
    // taller than the pane: the lines that fit, then `…`
    if (rows < 3) return
    out.set(k, { at: y, lines: [...lines.slice(0, rows - 3), '…'], text, width, isUp: false, top: 0 })
  })
  return out
}
