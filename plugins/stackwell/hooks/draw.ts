// Pure drawing for the stackwell pane: view model + width -> one cell buffer.
// A calm status pane: grey by default, muted hues mark groups, saturated colour only for warn and crit.

import type { StackwellAgent, StackwellBreakdown, StackwellLogEntry, StackwellPalette, StackwellPeer, StackwellQuota, StackwellSteward, StackwellView } from '../types'

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

/** Group hues in OKLCH degrees, spread apart and kept off the orange-red arc of warn and crit. */
export const HUES = { tools: 95, git: 130, quota: 170, agents: 205, context: 245, steward: 280, session: 320 } as const
const CHROMA = 0.08
const STEP = 0.1

const isDarkBg = (bg: number) => luminance(bg) < 0.18

/** The OKLCH lightness nearest `start` that reaches `floor` against bg, moving away from bg. */
function lightnessFor(h: number, bg: number, start: number, floor: number): number {
  const dir = isDarkBg(bg) ? 0.01 : -0.01
  let L = start
  while (contrast(oklch(L, CHROMA, h), bg) < floor && L > 0 && L < 1) L += dir
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
    tools: hue(HUES.tools),
    session: hue(HUES.session),
    agents: hue(HUES.agents),
    git: hue(HUES.git),
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

// ---------------------------------------------------------------- screen

export class Screen {
  readonly cells: Uint32Array
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
        this.cells[i] = ch.codePointAt(0) ?? 0x20
        this.cells[i + 1] = fg
      }
      X++
    }
    return X
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

/** `mcp__server__tool` -> `tool`. */
export const toolName = (name: string): string => (name.startsWith('mcp__') ? name.split('__').pop() || name : name)

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

type Seg = { text: string; fg: number }
type Row = Seg[]

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
  for (const s of row) {
    const room = n - used
    if (room <= 0) break
    const l = len(s.text)
    if (used + l <= n) {
      out.push(s)
      used += l
    } else {
      out.push({ text: cut(s.text, room), fg: s.fg })
      used = n
    }
  }
  return out
}

function header(v: StackwellView, W: number, P: StackwellPalette): Row {
  const model = v.model ? displayModel(v.model, v.window ?? v.breakdown?.raw) : ''
  const run = v.running[v.running.length - 1]
  const runText = run ? 'running ' + toolName(run.tool) : ''
  // the model stays whole; the branch gives way first, then the running tool
  const room = W - len(model) - 1
  const sep = v.branch && runText ? ' · ' : ''
  let branch = v.branch ?? ''
  if (len(branch) + len(sep) + len(runText) > room) {
    const left = room - len(sep) - len(runText)
    branch = left >= 4 ? cut(branch, left) : ''
  }
  const right: Row = []
  if (branch) right.push({ text: branch, fg: P.dim })
  if (runText) right.push({ text: (branch ? ' · ' : '') + runText, fg: P.text })
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
  if (v.compact) {
    const t = `compacted · ${v.compact.before !== undefined ? fmtTok(v.compact.before) : '?'} → ${v.compact.after !== undefined ? fmtTok(v.compact.after) : '?'}`
    return [{ text: cut(t, W), fg: P.dim }]
  }
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

/** The tools group's one row: `▸` and the call count when collapsed, `▾` and the top 3 when open. */
function toolsRow(v: StackwellView, W: number, LW: number, P: StackwellPalette): Row | undefined {
  const top = Object.entries(v.toolCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
  if (top.length === 0) return undefined
  const label = (v.isToolsOpen ? '▾ ' : '▸ ') + 'tools'
  const LWt = Math.max(LW, len(label) + 2)
  const fail: Row = v.bashFails > 0 ? [{ text: `✕ ${v.bashFails}`, fg: P.warn }] : []
  const room = W - LWt - (fail.length ? len(fail[0]!.text) + 1 : 0)
  const head: Seg = { text: label.padEnd(LWt), fg: P.tools }
  if (!v.isToolsOpen) {
    const n = Object.values(v.toolCounts).reduce((a, b) => a + b, 0)
    return sides(W, [head, ...fitRow([{ text: `${n} ${n === 1 ? 'call' : 'calls'}`, fg: P.dim }], Math.max(0, room))], fail)
  }
  let items = top
  const build = (): Row =>
    items.flatMap(([name, n], i) => [
      { text: (i > 0 ? '  ' : '') + cut(toolName(name), 12) + ' ', fg: P.dim },
      { text: String(n), fg: P.tools },
    ])
  const width = (r: Row) => r.reduce((a, s) => a + len(s.text), 0)
  while (items.length > 1 && width(build()) > room) items = items.slice(0, -1)
  return sides(W, [head, ...fitRow(build(), Math.max(0, room))], fail)
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
  if (status && fitsAll) return sides(W, [...lead, { text: name, fg: 0 }], [status])
  return fitRow([...lead, { text: name, fg: 0 }], W)
}

/**
 * The steward section as a tree: `★ initiative` when this session is the primary (its
 * secondaries below), the initiative alone when a secondary (`↑` the primary, then the
 * siblings); the decision log's age last.
 */
function stewardLines(st: StackwellSteward, v: StackwellView, W: number, LW: number, isNarrow: boolean, P: StackwellPalette): Line[] {
  const head: Row = [{ text: (isNarrow ? 'stw' : 'steward').padEnd(LW), fg: P.steward }]
  if (st.role === 'primary') head.push({ text: '★ ', fg: P.steward })
  head.push({ text: st.initiative, fg: P.text })
  const out: Line[] = [{ row: fitRow(head, W), kind: 'core' }]
  const hasLog = st.logMtime !== undefined
  const branches = st.peers.filter(p => p.role !== 'primary')
  const status = (p: StackwellPeer): Seg | undefined =>
    p.status ? { text: p.status, fg: p.status === 'busy' ? P.text : P.dim } : undefined
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
  W: number, LW: number, label: Seg, pct: number, resetsAt: number | undefined, now: number,
  fill: number, pctCol: number, P: StackwellPalette, pace?: number,
): Row {
  const pctT = ' ' + pctText(pct).padStart(4)
  const cd = resetsAt === undefined ? '' : fmtCountdown(resetsAt - now)
  const cdText = cd ? '  ' + cd.padStart(5) : ''
  const n = Math.max(3, W - LW - len(pctT) - (cd ? 7 : 0))
  const tick = pace === undefined ? undefined : Math.round(pace * n)
  return fitRow(
    [{ ...label, text: label.text.padEnd(LW) }, ...bar(n, pct, fill, P, tick), { text: pctT, fg: pctCol }, { text: cdText, fg: P.dim }],
    W,
  )
}

function quotaRow(q: StackwellQuota, v: StackwellView, W: number, LW: number, isNarrow: boolean, P: StackwellPalette): Row {
  const level = quotaLevel(q.pct)
  const label = isNarrow ? quotaKind(q.kind) : 'quota ' + quotaKind(q.kind)
  return meterRow(W, LW, { text: label, fg: P.quota }, q.pct, q.resetsAt, v.now, stateCol(level, P.quota, P), stateCol(level, P.text, P), P,
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

const SPARK = '▁▂▃▄▅▆▇█'
/** One cell per value; `lo` the floor of the scale (the minimum when undefined). */
function spark(values: number[], lo?: number): string {
  if (values.length === 0) return ''
  const min = lo ?? Math.min(...values), max = Math.max(...values)
  const span = max - min
  return values.map(x => SPARK[span > 0 ? Math.max(0, Math.min(7, Math.round(((x - min) / span) * 7))) : 0]!).join('')
}

/** `+9k`, `−5k`, `+0`. */
const signedTok = (n: number) => (n < 0 ? '−' : '+') + fmtTok(Math.abs(n))

/** Mean growth over the last 5 turns, or undefined with fewer than two points. */
function growth(trend: number[]): number | undefined {
  const pts = trend.slice(-6)
  if (pts.length < 2) return undefined
  return (pts[pts.length - 1]! - pts[0]!) / (pts.length - 1)
}

function trendRow(v: StackwellView, W: number, LW: number, P: StackwellPalette): Row | undefined {
  const g = growth(v.trend)
  if (g === undefined) return undefined
  let right = `${signedTok(g)}/turn`
  const thr = v.breakdown?.autoCompact
  const cur = v.tokens ?? v.trend[v.trend.length - 1]!
  if (g > 0 && thr !== undefined && thr > cur) {
    const n = Math.round((thr - cur) / g)
    if (n <= 999) right += ` · ~${n} turns left`
  }
  // short of room: `~204 turns`, then cut
  if (LW + 3 + len(right) > W) right = right.replace(/ turns left$/, ' turns')
  if (LW + 3 + len(right) > W) right = cut(right, Math.max(0, W - LW - 3))
  const room = Math.max(1, W - LW - len(right) - 2)
  return sides(W, [{ text: 'trend'.padEnd(LW), fg: P.context }, { text: spark(v.trend.slice(-room)), fg: P.steps[1]! }], [{ text: right, fg: P.dim }])
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

function sessionRow(v: StackwellView, W: number, LW: number, isNarrow: boolean, P: StackwellPalette): Row | undefined {
  const parts: Row = []
  const el = v.startedAt === undefined ? undefined : v.now - v.startedAt
  if (v.costUsd !== undefined) {
    parts.push({ text: `$${v.costUsd.toFixed(2)}`, fg: P.session }, { text: ' est', fg: P.dim })
    if (el !== undefined && el >= 5 * 60_000) {
      const rate = v.costUsd / (el / 3600_000)
      parts.push({ text: ` · $${rate >= 10 ? Math.round(rate) : rate.toFixed(1)}/h`, fg: P.dim })
    }
  }
  if (el !== undefined) parts.push({ text: (parts.length ? ' · ' : '') + fmtElapsed(el), fg: P.dim })
  if (parts.length === 0) return undefined
  return fitRow([{ text: (isNarrow ? 'sess' : 'session').padEnd(LW), fg: P.session }, ...parts], W)
}

function costRow(v: StackwellView, W: number, LW: number, P: StackwellPalette): Row | undefined {
  if (v.turns < 1) return undefined
  let right = `turn ${v.turns}`
  if (v.lastTurnMs !== undefined) right += ` · ${fmtDur(v.lastTurnMs)}`
  const g = v.trend.length >= 2 ? v.trend[v.trend.length - 1]! - v.trend[v.trend.length - 2]! : undefined
  if (g !== undefined) right += ` · ${signedTok(g)}`
  if (LW + 3 + len(right) > W) right = cut(right, Math.max(0, W - LW - 3))
  const room = Math.max(1, W - LW - len(right) - 2)
  return sides(W, [{ text: 'cost'.padEnd(LW), fg: P.session }, { text: spark(v.turnCosts.slice(-room), 0), fg: P.sessionStep }], [{ text: right, fg: P.dim }])
}

function gitRow(v: StackwellView, W: number, LW: number, P: StackwellPalette): Row | undefined {
  const g = v.git
  if (!g) return undefined
  const row: Row = [{ text: 'git'.padEnd(LW), fg: P.git }]
  if (g.files === 0 && g.ahead === 0) row.push({ text: 'clean', fg: P.dim })
  else {
    if (g.files > 0) {
      row.push({ text: String(g.files), fg: P.text }, { text: g.files === 1 ? ' file' : ' files', fg: P.dim })
      if (g.added || g.removed) row.push({ text: `  +${g.added} −${g.removed}`, fg: P.text })
    }
    if (g.ahead > 0) row.push({ text: `${g.files > 0 ? '  ' : ''}↑${g.ahead}`, fg: P.text })
  }
  if (g.worktree) row.push({ text: `  wt ${g.worktree}`, fg: P.dim })
  return fitRow(row, W)
}

const AGENT_KEEP = 5 * 60_000
const isAgentShown = (a: StackwellAgent, now: number) => a.status === 'running' || (a.endedAt !== undefined && now - a.endedAt < AGENT_KEEP)

function agentRow(a: StackwellAgent, label: string, v: StackwellView, W: number, LW: number, P: StackwellPalette): Row {
  const isDone = a.status !== 'running'
  const left: Row = [{ text: label.padEnd(LW), fg: P.agents }]
  if (isDone) left.push({ text: a.status === 'ok' ? '✓ ' : '✕ ', fg: P.dim })
  else if (a.isBackground) left.push({ text: 'bg ', fg: P.dim })
  left.push({ text: a.name, fg: isDone ? P.dim : P.text })
  if (a.model) left.push({ text: '  ' + a.model, fg: P.dim })
  const el = fmtElapsed((isDone ? a.endedAt ?? v.now : v.now) - a.startedAt)
  return sides(W, left, [{ text: el, fg: P.dim }])
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`

const NAME_CAP = 16

/** One log line: time, the tool's name in a column `col` wide, the target, the duration. */
function logRow(e: StackwellLogEntry, W: number, col: number, P: StackwellPalette): Row {
  const right: Seg =
    e.status === 'running' ? { text: '…', fg: P.dim }
    : e.status === 'failed' ? { text: '✕ ' + (e.ms === undefined ? '' : fmtDur(e.ms)), fg: P.warn }
    : { text: e.ms === undefined ? '' : fmtDur(e.ms), fg: P.dim }
  const lead: Row = [
    { text: hhmm(e.at) + '  ', fg: P.dim },
    { text: cut(toolName(e.tool), col).padEnd(col), fg: P.tools },
  ]
  const used = 5 + 2 + col + (len(right.text) ? len(right.text) + 1 : 0)
  // the target shrinks first; under 4 cells it goes
  const room = W - used - 2
  const isMcp = e.tool.startsWith('mcp__')
  const left: Row = room >= 4 && e.target ? [...lead, { text: '  ' + cut(e.target, room), fg: isMcp ? P.dim : P.text }] : lead
  return sides(W, left, [right])
}

/** The name column: as wide as the longest name shown, at most NAME_CAP. */
const nameColumn = (log: StackwellLogEntry[]) => Math.min(NAME_CAP, Math.max(1, ...log.map(e => len(toolName(e.tool)))))

type Kind = 'core' | 'trend' | 'acct' | 'cost' | 'git' | 'done' | 'tools' | 'slog' | 'speer'
type Line = { row: Row; kind: Kind }

/** The pane's groups, top to bottom, without the tool log. */
function groups(v: StackwellView, W: number): Line[][] {
  const P = v.palette
  const isNarrow = W < 44
  // every label is at most LW - 2 long: 2 spaces always stand before the content
  const LW = isNarrow ? 7 : 12
  const core = (row: Row): Line => ({ row, kind: 'core' })
  const out: Line[][] = [[core(header(v, W, P))]]
  if (v.percent === undefined && v.tokens === undefined) {
    out.push([core([{ text: cut('waiting for first turn', W), fg: P.dim }])])
    return out
  }
  // context
  const pct = v.percent ?? 0
  const nums: Row = []
  const win = v.window ?? v.breakdown?.raw
  if (v.tokens !== undefined) nums.push({ text: fmtTok(v.tokens) + (win ? ` / ${fmtTok(win)}` : ''), fg: P.text })
  nums.push({ text: '  ' + pctText(pct).padStart(4), fg: stateCol(ctxLevel(pct), P.text, P) })
  const ctx: Line[] = [core(sides(W, [{ text: (isNarrow ? 'ctx' : 'context') + '  ', fg: P.context }], fitRow(nums, W))), core(contextBar(v, W, P))]
  const leg = legend(v, W, P)
  if (leg.length) ctx.push(core(leg))
  const tr = trendRow(v, W, LW, P)
  if (tr) ctx.push({ row: tr, kind: 'trend' })
  out.push(ctx)
  // quota
  const quota: Line[] = sortQuotas(v.quotas.filter(q => Number.isFinite(q.pct))).map(q => core(quotaRow(q, v, W, LW, isNarrow, P)))
  for (const r of accountRows(v, W, LW, isNarrow, P)) quota.push({ row: r, kind: 'acct' })
  out.push(quota)
  // session
  const sess: Line[] = []
  const s = sessionRow(v, W, LW, isNarrow, P)
  if (s) sess.push(core(s))
  const c = costRow(v, W, LW, P)
  if (c) sess.push({ row: c, kind: 'cost' })
  out.push(sess)
  // steward: only while this session is in the registry
  out.push(v.steward ? stewardLines(v.steward, v, W, LW, isNarrow, P) : [])
  // git
  const g = gitRow(v, W, LW, P)
  out.push(g ? [{ row: g, kind: 'git' }] : [])
  // agents: running newest first, then finished newest first
  const shown = v.agents.filter(a => isAgentShown(a, v.now))
  const running = shown.filter(a => a.status === 'running').sort((a, b) => b.startedAt - a.startedAt)
  const done = shown.filter(a => a.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  out.push(
    [...running, ...done].map((a, i) => ({
      row: agentRow(a, i === 0 ? (isNarrow ? 'agt' : 'agents') : '', v, W, LW, P),
      kind: a.status === 'running' ? ('core' as const) : ('done' as const),
    })),
  )
  // tools
  const t = toolsRow(v, W, LW, P)
  out.push(t ? [{ row: t, kind: 'tools' }] : [])
  return out
}

const DROP: Kind[] = ['done', 'tools', 'cost', 'acct', 'git', 'slog', 'speer', 'trend']

/** The pane, top to bottom, at most H rows, and where the tools row is (-1 when absent). */
export function layoutAt(v: StackwellView, W: number, H = Infinity): { rows: Row[]; toolsAt: number } {
  let gs = groups(v, W)
  const flat = (xs: Line[][]): Line[] => {
    const lines: Line[] = []
    for (const g of xs.filter(g => g.length > 0)) {
      if (lines.length) lines.push({ row: [], kind: 'core' })
      lines.push(...g)
    }
    return lines
  }
  // the log goes first: once anything else had to go, it stays out
  let hasDropped = false
  for (const k of DROP) {
    if (flat(gs).length <= H) break
    gs = gs.map(g => g.filter(l => l.kind !== k))
    hasDropped = true
  }
  const lines = flat(gs)
  const toolsAt = lines.findIndex(l => l.kind === 'tools')
  const rows = lines.map(l => l.row)
  if (toolsAt >= 0 && v.isToolsOpen && !hasDropped && rows.length < H) {
    const log = [...v.log].reverse().slice(0, H === Infinity ? undefined : H - rows.length)
    const col = nameColumn(log)
    rows.push(...log.map(e => logRow(e, W, col, v.palette)))
  }
  const cut = rows.slice(0, H === Infinity ? undefined : Math.max(1, H))
  return { rows: cut, toolsAt: toolsAt < cut.length ? toolsAt : -1 }
}

export const layout = (v: StackwellView, W: number, H = Infinity): Row[] => layoutAt(v, W, H).rows

export type { Row, Seg }

function paint(rows: Row[], cols: number, top: number, bottom: number, fg: number): Screen {
  const sc = new Screen(cols, rows.length + top + bottom, fg)
  rows.forEach((r, y) => {
    let x = 2
    for (const s of r) x = sc.put(x, y + top, s.text, s.fg || fg)
  })
  return sc
}

/**
 * The pane inside its margins (1 row top and bottom, 2 columns each side), cut at the tools row:
 * what is above it, the row itself (drawn as a Button by the caller), what is below.
 */
export function drawParts(v: StackwellView, columns: number, rows = Infinity): { top: Screen; tools?: Row; bottom?: Screen } {
  const cols = Math.max(5, columns)
  const { rows: content, toolsAt } = layoutAt(v, cols - 4, Math.max(1, rows - 2))
  const fg = v.palette.text
  if (toolsAt < 0) return { top: paint(content, cols, 1, 1, fg) }
  return {
    top: paint(content.slice(0, toolsAt), cols, 1, 0, fg),
    tools: content[toolsAt]!,
    bottom: paint(content.slice(toolsAt + 1), cols, 0, 1, fg),
  }
}

/** The whole pane as one Screen (the tools row painted in place). */
export function draw(v: StackwellView, columns: number, rows = Infinity): Screen {
  const cols = Math.max(5, columns)
  return paint(layout(v, cols - 4, Math.max(1, rows - 2)), cols, 1, 1, v.palette.text)
}
