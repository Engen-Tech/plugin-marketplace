import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import * as drawModule from './draw'
import * as stewardModule from './steward'
import * as agentsModule from './agents'
import * as foldersModule from './folders'
import * as hatchModule from './hatch'
import { fitPath, folderLabel, shortPath, touchedFolders, touchedPaths } from './folders'
import { binderState, parseBinder } from './hatch'
import { pinShown, register } from './register'
import { PRESETS, layout, layoutAt, parsePalette } from './draw'
import type { StackwellPalette, StackwellView } from '../types'

const PANE = {
  plugin: 'stackwell',
  component: 'Pane',
  requestId: 'stackwell',
  props: {
    title: 'Stackwell',
    isFocused: false,
    bodyColumns: 53, // 48 content + 2 + 2 margin + the clipped last column
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 47 },
    view: {},
  },
} as const

const P = PRESETS['vga']! // the fallback palette
/** Two distinct 1x1 PNGs standing in for the dark and the light section icon sets. */
const DARK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='
const LIGHT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='
const NOW = Date.parse('2026-11-26T12:00:00Z')
const H = 3600_000

type Frame = { lines: string[]; fg: (x: number, y: number) => number | undefined; w: number }

const atob = (globalThis as unknown as { atob: (s: string) => string }).atob

function decode(props: Record<string, unknown>): Frame {
  const cols = props.columns as number
  const bin = atob(props.cells as string)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const words = new Uint32Array(bytes.buffer)
  const rows = words.length / 3 / cols
  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    let s = ''
    for (let x = 0; x < cols; x++) s += String.fromCodePoint(words[(y * cols + x) * 3]!)
    lines.push(s)
  }
  return { lines, fg: (x, y) => words[(y * cols + x) * 3 + 1], w: cols }
}

/** The content inside the margins: 1 row top and bottom, 2 columns left and right. */
function inner(f: Frame): Frame {
  const lines = f.lines.slice(1, -1).map(l => Array.from(l).slice(2, f.w - 2).join(''))
  return { lines, fg: (x, y) => f.fg(x + 2, y + 1), w: f.w - 4 }
}

const row = (f: Frame, re: RegExp) => f.lines.findIndex(l => re.test(l))
const pad2 = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`
/** Foreground colours of the cells of row y holding character ch. */
const colsOf = (f: Frame, y: number, ch: string) =>
  Array.from(f.lines[y]!).flatMap((c, x) => (c === ch ? [f.fg(x, y)!] : []))

const SUMMARY = [{ role: 'user' as const, text: 'summary of the work so far', toolUses: [] }]
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'stackwell', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 144 } })

type Quota = { profile: string; seven_day?: { used_percentage: number | null }; five_hour?: { used_percentage: number | null }; updated_at_epoch?: number }

/** The world beneath the plugin, as far as these tests need it. */
type Repo = {
  root: string; mainRoot?: string; branch?: string; changes?: number; untracked?: number
  /** The raw text of its HEAD file; absent, `ref: refs/heads/<branch>`. */
  head?: string
  /** Its `.git/packed-refs`, when it has one. */
  packed?: string
}
/** One `process.run` as the mock saw it. */
type Run = { argv: readonly string[]; cwd?: string; env?: Record<string, string> }
type Extra = {
  reads?: string[]
  files?: Record<string, string>
  appTheme?: string
  quotaDir?: string
  /** fs.list answers by folder. */
  dirs?: Record<string, { name: string; kind: 'file' | 'dir' }[]>
  /** fs.stat answers by path. */
  stats?: Record<string, { kind: 'file' | 'dir'; mtimeMs: number }>
  /** git for-each-ref output by repo. */
  refs?: Record<string, string[]>
  repos?: Repo[]
  panesOpen?: boolean
  /** The icon's base64, served for the plugin's .claude-plugin/icon.png. */
  icon?: string
  /** Serve the section icons under assets/sections/{dark,light}/ (DARK_PNG or LIGHT_PNG). */
  sections?: boolean
  /** Calls by op name. */
  calls?: Record<string, number>
  /** Every process.run, in order. */
  runs?: Run[]
  /** Awaited by each vcs.status: a test holds the git reads open with it. */
  statusGate?: () => Promise<void>
  /** While true, ui.panes fails. */
  panesFail?: boolean
  /** Pids `kill -0` finds alive; every other pid is gone. */
  live?: number[]
  /** What session.messages serves: main's rows, and each agent's (an agent absent is a deny). */
  transcript?: Transcript
  /** The arguments of each session.messages call. */
  messageArgs?: Record<string, unknown>[]
  /** Awaited by each session.messages: a test holds the history read open with it. */
  messagesGate?: () => Promise<void>
}

/**
 * Lets the reads a hook started after it returned run to their end: the world's clock settles the
 * event loop. (The engine loads its own copy of the plugin's module, not this file's import of it.)
 */
let idle: () => Promise<void> = () => Promise.resolve()

type Transcript = { main: SessionMessage[]; agents?: Record<string, SessionMessage[]> }
type Use = { tool: string; input: Record<string, unknown>; agentId?: string }
let rowId = 0
/** An assistant row holding these tool uses, each answered, with a fresh uuid. */
const said = (...uses: Use[]): SessionMessage => ({
  role: 'assistant', text: '', uuid: `row-${++rowId}`,
  toolUses: uses.map((u, i) => ({ tool_use_id: `tu-${rowId}-${i}`, tool: u.tool, input: u.input, text: 'ok', ...(u.agentId ? { agentId: u.agentId } : {}) })),
})
type Steward = { registry?: string; mtime?: number; sessionId?: string; peers?: { name: string; status: string; sessionId?: string; since?: number }[]; logMtime?: number; reads?: string[]; dir?: string }

function world(on: On, opts: { model?: string; branch?: string; profile?: string; quotas?: Quota[]; git?: { changes: number; ahead?: number; worktree?: boolean }; steward?: Steward; extra?: Extra; home?: string; cwd?: string } = {}) {
  const ex = opts.extra ?? {}
  const count = (op: string) => {
    if (ex.calls) ex.calls[op] = (ex.calls[op] ?? 0) + 1
  }
  const quotaDir = ex.quotaDir ?? '/u/tester/.claude/quota'
  if (ex.appTheme)
    on('config.list', () => ({
      value: [{ key: 'theme', label: 'Theme', kind: 'enum', value: ex.appTheme, provider: { kind: 'core' }, isLocked: false }] as never,
    }))
  const opened: string[] = []
  const closed: string[] = []
  mock.store(on)
  const st = opts.steward
  mock.env(on, {
    HOME: opts.home ?? '/u/tester',
    HOSTNAME: 'host1',
    ...(opts.profile ? { CLAUDE_PROFILE: opts.profile } : {}),
    ...(st?.dir ? { STEWARD_ORCHESTRATION_DIR: st.dir } : {}),
  })
  const regPath = `${st?.dir ?? '/u/tester/.claude/orchestration'}/initiatives.md`
  on('session.id', () => ({ value: st?.sessionId ?? '99999999-9999-4999-8999-999999999999' }))
  on('fs.stat', (_, e) => {
    count('fs.stat')
    count(`stat:${e.path}`)
    const xs = ex.stats?.[e.path]
    if (xs) return { value: { kind: xs.kind, size: 1, mtimeMs: xs.mtimeMs, isLink: false } }
    if (st?.registry !== undefined && e.path === regPath) return { value: { kind: 'file' as const, size: st.registry.length, mtimeMs: st.mtime ?? 1, isLink: false } }
    if (st?.logMtime !== undefined && e.path === '/u/tester/notes/widget-log.md') return { value: { kind: 'file' as const, size: 1, mtimeMs: st.logMtime, isLink: false } }
    const g = gitFs(e.path)
    if (g) return { value: { kind: g.kind, size: 1, mtimeMs: 1, isLink: false } }
    throw new Error('ENOENT')
  })
  if (st?.peers) {
    // each peer a session file under this session's own config folder
    const dir = '/u/tester/.claude/sessions'
    ex.dirs = { ...ex.dirs, [dir]: st.peers.map((_, i) => ({ name: `${100 + i}.json`, kind: 'file' as const })) }
    st.peers.forEach((pe, i) => {
      const path = `${dir}/${100 + i}.json`
      ex.files = { ...ex.files, [path]: JSON.stringify({ sessionId: pe.sessionId, name: pe.name, status: pe.status, statusUpdatedAt: pe.since }) }
      ex.stats = { ...ex.stats, [path]: { kind: 'file', mtimeMs: 1 } }
    })
  }
  const clock = mock.clock(on, { now: NOW })
  idle = () => clock.settle()
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => {
    if (ex.panesFail) throw new Error('panes unavailable')
    return { value: (ex.panesOpen ? [{ id: 'stackwell' }] : []) as never }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: opts.model ?? 'claude-opus-5-5' }))
  const cwd = opts.cwd ?? (opts.git?.worktree ? '/work/sample-repo/.worktrees/feat-x' : '/work/sample-repo')
  on('session.cwd', () => ({ value: cwd }))
  // the test's own list, live: a repo added later is found from then on
  const repos: Repo[] = ex.repos ?? []
  if (opts.branch || opts.git)
    repos.push({ root: cwd, mainRoot: opts.git?.worktree ? '/work/sample-repo' : undefined, branch: opts.branch ?? 'main', changes: opts.git?.changes })
  const repoOf = (path: string) => repos.find(r => path === r.root || path.startsWith(r.root + '/'))
  /**
   * The repos' git files as Git lays them out: a main checkout's `.git` folder with its HEAD
   * (and packed-refs), a linked worktree's `.git` file naming its gitdir under the main's
   * `.git/worktrees/<name>`, that gitdir's HEAD, commondir and gitdir, and the main's listing.
   */
  const gitFs = (path: string): { kind: 'file' | 'dir'; text?: string; list?: string[] } | undefined => {
    const nameOf = (p: string) => p.split('/').pop()!
    const wtSuffix = '/.git/worktrees'
    if (path.endsWith(wtSuffix)) {
      const main = path.slice(0, -wtSuffix.length)
      const wts = repos.filter(w => w.mainRoot === main && w.root !== main)
      if (wts.length) return { kind: 'dir', list: wts.map(w => nameOf(w.root)) }
    }
    for (const r of repos) {
      const head = r.head ?? `ref: refs/heads/${r.branch ?? 'main'}\n`
      if (!r.mainRoot || r.mainRoot === r.root) {
        if (path === `${r.root}/.git`) return { kind: 'dir' }
        if (path === `${r.root}/.git/HEAD`) return { kind: 'file', text: head }
        if (path === `${r.root}/.git/packed-refs` && r.packed !== undefined) return { kind: 'file', text: r.packed }
        continue
      }
      const gd = `${r.mainRoot}/.git/worktrees/${nameOf(r.root)}`
      if (path === `${r.root}/.git`) return { kind: 'file', text: `gitdir: ${gd}\n` }
      if (path === gd) return { kind: 'dir' }
      if (path === `${gd}/HEAD`) return { kind: 'file', text: head }
      if (path === `${gd}/commondir`) return { kind: 'file', text: '../..\n' }
      if (path === `${gd}/gitdir`) return { kind: 'file', text: `${r.root}/.git\n` }
    }
    return undefined
  }
  on('vcs.detect', (_, e) => {
    count('vcs.detect')
    count(`detect:${e.path}`)
    const r = repoOf(e.path)
    if (!r) throw new Error('not a working copy')
    return { vcs: 'git', root: r.root, mainRoot: r.mainRoot ?? null, revision: null, branch: r.branch ?? 'main', defaultBranch: 'main', remote: null }
  })
  on('vcs.status', async (_, e) => {
    count('vcs.status')
    count(`status:${e.path}`)
    if (ex.statusGate) await ex.statusGate()
    const r = repoOf(e.path)
    if (!r || r.changes === undefined) throw new Error('no status')
    return {
      changes: [
        ...Array.from({ length: r.changes }, (_, i) => ({ path: `f${i}.ts`, state: 'modified' as const })),
        ...Array.from({ length: r.untracked ?? 0 }, (_, i) => ({ path: `u${i}.ts`, state: 'untracked' as const })),
      ],
      unpublished: 0,
    }
  })
  on('vcs.diff', (_, e) => {
    count('vcs.diff')
    count(`diff:${e.path}`)
    const r = repoOf(e.path)
    if (!r || r.changes === undefined) throw new Error('no diff')
    return {
      base: 'HEAD',
      files: Array.from({ length: r.changes }, (_, i) => ({ path: `f${i}.ts`, renamedFrom: null, added: 40, removed: 10, isBinary: false, isUntracked: false })),
    }
  })
  on('process.run', (_, e) => {
    count('process.run')
    count(`run:${e.init?.cwd ?? ''}`)
    ex.runs?.push({ argv: e.argv, ...(e.init?.cwd !== undefined ? { cwd: e.init.cwd } : {}), ...(e.init?.env ? { env: e.init.env } : {}) })
    if (e.argv[0] === 'kill') {
      count('kill')
      const isLive = ex.live?.includes(Number(e.argv[2])) === true
      return { value: { exitCode: isLive ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const refs = ex.refs?.[e.init?.cwd ?? '']
    return { value: { exitCode: refs ? 0 : 1, stdout: (refs ?? []).join('\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', (_, e) => {
    count('fs.list')
    const xd = ex.dirs?.[e.path]
    if (xd) return { value: xd.map(d => ({ ...d, size: 1 })) as never }
    const g = gitFs(e.path)
    if (g?.list) return { value: g.list.map(name => ({ name, kind: 'dir' as const, size: 1 })) as never }
    if (e.path !== quotaDir || !opts.quotas) throw new Error('ENOENT')
    return { value: opts.quotas.map(q => ({ name: `${q.profile}.json`, kind: 'file' as const, size: 10 })) as never }
  })
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/assets/header-icon.png')) {
      count('icon')
      if (ex.icon) return { value: { base64: ex.icon } as never }
      throw new Error('ENOENT')
    }
    if (e.path.endsWith('/.claude-plugin/icon.png')) {
      // the listing's 1024 px icon: never read into a render tree
      count('listingIcon')
      throw new Error('ENOENT')
    }
    if (e.path.includes('/assets/sections/')) {
      count('section')
      const m = /\/assets\/sections\/(dark|light)\/[a-z]+\.png$/.exec(e.path)
      if (ex.sections && m) return { value: { base64: m[1] === 'dark' ? DARK_PNG : LIGHT_PNG } as never }
      throw new Error('ENOENT')
    }
    count('fs.read')
    ex.reads?.push(e.path)
    if (ex.files?.[e.path] !== undefined) return { value: ex.files[e.path]! }
    if (st?.registry !== undefined && e.path === regPath) {
      st.reads?.push(e.path)
      return { value: st.registry }
    }
    const g = gitFs(e.path)
    if (g?.text !== undefined) return { value: g.text }
    const q = opts.quotas?.find(x => e.path === `${quotaDir}/${x.profile}.json`)
    if (!q) throw new Error('ENOENT')
    return { value: JSON.stringify(q) }
  })
  on('session.messages', async (_, e) => {
    count('session.messages')
    ex.messageArgs?.push({ ...e })
    if (ex.messagesGate) await ex.messagesGate()
    const tr = ex.transcript ?? { main: [] }
    const rows = e.agentId === undefined ? tr.main : tr.agents?.[e.agentId]
    if (!rows) return { value: { deny: `no agent ${e.agentId}` } as never }
    if (e.after !== undefined) {
      const i = rows.findIndex(r => r.uuid === e.after)
      return { value: (i < 0 ? { deny: `no row ${e.after}` } : rows.slice(i + 1)) as never }
    }
    if (e.last !== undefined) return { value: rows.slice(-e.last) as never }
    return { value: rows.map(({ uuid: _u, ...r }) => r) as never }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => {
    count('turn.complete')
    return { text: '' }
  })
  return { opened, closed, clock, ex }
}

type Cell = { ch: string; fg: number | undefined }
type El = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/**
 * A drawn tree as rows of cells: Box columns stack, Box rows join side by side, a Raster's cells,
 * a Button or Text as its text; an Image as its alt (`withAlt`) or blank cells, cut to its columns.
 */
function flatten(node: unknown, withAlt = false): Cell[][] {
  if (typeof node === 'string') return [Array.from(node).map(ch => ({ ch, fg: undefined }))]
  const el = node as El
  if (!el || typeof el !== 'object') return []
  const props = el.props ?? {}
  // a placed Box (a hover card) takes no room in the flow
  if (el.type === 'Box' && props.position === 'absolute') return []
  const kids = (el.children ?? []).filter(k => k !== null && k !== undefined && k !== false)
  if (el.type === 'Raster') {
    const f = decode(props)
    return f.lines.map((l, y) => Array.from(l).map((ch, x) => ({ ch, fg: f.fg(x, y) })))
  }
  if (el.type === 'Image') {
    const cols = props.columns as number, rows = props.rows as number
    const alt = withAlt ? Array.from(String(props.alt)) : []
    return Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => ({ ch: (y === 0 && alt[x]) || ' ', fg: undefined })))
  }
  if (el.type === 'Text' || el.type === 'Button') {
    const color = typeof props.color === 'string' ? parseInt(props.color.slice(1), 16) : undefined
    if (el.type === 'Text') return [kids.flatMap(k => (typeof k === 'string' ? Array.from(k).map(ch => ({ ch, fg: color })) : flatten(k, withAlt)[0] ?? []))]
    return [kids.flatMap(k => flatten(k, withAlt)[0] ?? [])]
  }
  // a Box
  const parts = kids.map(k => flatten(k, withAlt))
  const isRow = props.flexDirection === 'row'
  let out: Cell[][]
  if (isRow) {
    const h = Math.max(0, ...parts.map(p => p.length))
    out = Array.from({ length: h }, (_, y) => parts.flatMap(p => {
      const w = Math.max(0, ...p.map(r => r.length))
      const r = p[y] ?? []
      return [...r, ...Array.from({ length: w - r.length }, () => ({ ch: ' ', fg: undefined }))]
    }))
  } else out = parts.flat()
  const left = typeof props.paddingLeft === 'number' ? props.paddingLeft : 0
  const top = typeof props.paddingTop === 'number' ? props.paddingTop : 0
  if (left) out = out.map(r => [...Array.from({ length: left }, () => ({ ch: ' ', fg: undefined })), ...r])
  for (let k = 0; k < top; k++) out.unshift([])
  return out
}

/** The whole pane for `cols` content columns and `rows` body rows, as the terminal draws it. */
async function rawAt($: Engine, cols = 48, rows = 47, withAlt = false): Promise<Frame> {
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: cols + 5, scroll: { offset: 0, bodyRows: rows } }, surface: 'terminal' })
  const tree = await ui.drawn()
  await ui.unmount()
  const cells = flatten(tree, withAlt)
  expect(cells.length).toBeGreaterThan(0)
  const w = Math.max(...cells.map(r => r.length))
  const full = cells.map(r => [...r, ...Array.from({ length: w - r.length }, () => ({ ch: ' ', fg: undefined }))])
  return { lines: full.map(r => r.map(c => c.ch).join('')), fg: (x, y) => full[y]?.[x]?.fg, w }
}
const frameAt = async ($: Engine, cols = 48, rows = 47) => inner(await rawAt($, cols, rows))
const frame = ($: Engine) => frameAt($, 48)

/** Each event, then the reads it started after it returned. */
const start = async ($: Engine) => {
  await $.session.start({ cwd: '/work/sample-repo', surface: 'terminal', isInteractive: true })
  await idle()
}
const complete = async ($: Engine, durationMs = 1) => {
  await $.turn.complete({ answer: '', durationMs, isAborted: false, turnId: 't1', reason: 'answer' })
  await idle()
}
/** An agent's own turn start and end. */
const agentStart = async ($: Engine, agentId: string) => {
  await $.turn.start({ text: '', turnId: `t-${agentId}`, agentId })
  await idle()
}
const agentEnd = async ($: Engine, agentId: string, isAborted = false) => {
  await $.turn.complete({ answer: '', durationMs: 1, isAborted, turnId: `t-${agentId}`, reason: 'answer', agentId } as never)
  await idle()
}

type Limit = { kind: string; percentUsed: number; resetsAt?: string }
const measure = async ($: Engine, percent: number, rateLimits: Limit[] = [], window = 200_000) => {
  await $.session.measure({
    context: { tokens: Math.round((percent / 100) * window), window, percent },
    rateLimits,
    cost: { usd: 1.23 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  await idle()
}

const d7 = (pct: number): Limit => ({ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(NOW + (3 * 24 + 5) * H + 60_000).toISOString() })

/** A 1M-window session: 312k used, as messages 240k, tools 40k, system 18k, other 14k. */
function millionSession(on: On, opts: { percent?: number; autoCompact?: number; limits?: Limit[] } = {}) {
  const used = (name: string, tokens: number) => ({ name, tokens, color: 'text', isDeferred: false, kind: 'used' as const })
  const percent = opts.percent ?? 31
  const breakdown = {
    categories: [
      used('System prompt', 18_000), used('System tools', 31_000), used('MCP tools', 9_000), used('Custom agents', 2_000),
      used('Memory files', 5_000), used('Skills', 7_000), used('Messages', 240_000),
      { name: 'Free space', tokens: 655_000, color: 'text', isDeferred: false, kind: 'free' as const },
      { name: 'Autocompact buffer', tokens: 33_000, color: 'text', isDeferred: false, kind: 'buffer' as const },
    ],
    totalTokens: 312_000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, autocompactSource: 'auto' as const, percentage: percent,
    gridRows: [], model: 'claude-opus-5-5', memoryFiles: [], mcpTools: [], agents: [], autoCompactThreshold: opts.autoCompact ?? 917_000,
    isAutoCompactEnabled: true, apiUsage: null,
    messageBreakdown: {
      toolCallTokens: 0, toolResultTokens: 0, attachmentTokens: 0, assistantMessageTokens: 49700, userMessageTokens: 17600,
      redirectedContextTokens: 0, unattributedTokens: 0, attachmentsByType: [], toolCallsByType: [],
    },
  }
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 72 * 60_000,
      context: { tokens: Math.round(percent * 10_000 + 2_000), window: 1_000_000, percent, breakdown },
      rateLimits: opts.limits ?? [d7(23)],
      cost: { usd: 1.23 },
    },
  }))
}

// ---------------------------------------------------------------- the whole pane

test('a realistic session renders the calm pane', async ($, on) => {
  world(on, { branch: 'main' })
  millionSession(on)
  await start($)
  await complete($)
  const f = await frame($)
  const text = f.lines.map(l => l.trimEnd()).join('\n').trimEnd()
  expect(text).toBe(
    [
      'Opus 5.5 (1M)'.padEnd(31) + '/work/sample-repo',
      '',
      'context'.padEnd(33) + '312k / 1M   31%',
      '━'.repeat(15) + '─'.repeat(29) + '┊' + '─'.repeat(3),
      '▪ msgs 240k  ▪ tools 40k  ▪ sys 18k  ▪ other 14k',
      '',
      'quota 7d    ' + '━'.repeat(6) + '─'.repeat(7) + '│' + '─'.repeat(10) + '  23%   3d5h',
      '',
      'folders',
      '  ● sample-repo  main',
      '',
      'session     $1.23 est · 1h12m' + 'turn 1 · 0.0s'.padStart(19),
    ].join('\n'),
  )
  for (const l of f.lines) expect(Array.from(l).length).toBe(48)
})

test('before any data: header and waiting', async ($, on) => {
  world(on)
  const f = await frame($)
  expect(f.lines.join('\n')).toContain('waiting for first turn')
  expect(f.lines.join('\n')).not.toContain('context')
  expect(f.fg(0, row(f, /waiting/))).toBe(P.dim)
})

// ---------------------------------------------------------------- header

test('header: the model, then the session folder dim; nothing of a tool call', async ($, on) => {
  world(on, { branch: 'feat/x' })
  millionSession(on)
  await start($)
  const f = await frame($)
  expect(f.lines[0]!.trimEnd()).toMatch(/^Opus 5\.5 \(1M\)\s+\/work\/sample-repo$/)
  expect(f.lines.join('\n')).not.toContain('running')
  const bx = f.lines[0]!.indexOf('/work')
  expect(f.fg(0, 0)).toBe(P.text)
  expect(f.fg(bx, 0)).toBe(P.dim)
})

// ---------------------------------------------------------------- context

test('context bar: proportional fill in at most 4 segments over a full-width track', async ($, on) => {
  world(on)
  millionSession(on)
  await start($)
  const f = await frame($)
  const y = row(f, /^[━─┊]+$/)
  const cells = Array.from(f.lines[y]!)
  expect(cells.length).toBe(48)
  const filled = cells.filter(c => c === '━').length
  expect(filled).toBe(Math.round(0.31 * 48))
  // fill is contiguous from the left, track runs to the right edge
  expect(cells.slice(0, filled).every(c => c === '━')).toBe(true)
  expect(cells[47]).toBe('─')
  const fills = new Set(colsOf(f, y, '━'))
  expect(fills.size).toBeGreaterThan(1)
  expect(fills.size).toBeLessThanOrEqual(4)
  for (const c of fills) expect(P.steps).toContain(c)
  expect(new Set(colsOf(f, y, '─'))).toEqual(new Set([P.dim]))
  // lightest step first: messages
  expect(f.fg(0, y)).toBe(P.steps[0])
})

test('the auto-compact tick sits at its position, and is omitted when outside the bar', async ($, on) => {
  world(on)
  millionSession(on, { autoCompact: 500_000 })
  await start($)
  const f = await frame($)
  const y = row(f, /^[━─┊]+$/)
  expect(Array.from(f.lines[y]!).indexOf('┊')).toBe(24)
  expect(f.fg(24, y)).toBe(P.dim)
})

test('an auto-compact threshold at or past the window draws no tick', async ($, on) => {
  world(on)
  millionSession(on, { autoCompact: 1_000_000 })
  await start($)
  const f = await frame($)
  expect(f.lines.join('\n')).not.toContain('┊')
})

test('context warn at 75% and crit at 90%: fill and percent take the colour, no !', async ($, on) => {
  world(on)
  await measure($, 80)
  let f = await frame($)
  let y = row(f, /^[━─┊]+$/)
  expect(new Set(colsOf(f, y, '━'))).toEqual(new Set([P.warn]))
  let py = row(f, /^context/)
  expect(f.fg(f.lines[py]!.indexOf('80%'), py)).toBe(P.warn)
  await measure($, 92)
  f = await frame($)
  y = row(f, /^[━─┊]+$/)
  expect(new Set(colsOf(f, y, '━'))).toEqual(new Set([P.crit]))
  py = row(f, /^context/)
  expect(f.fg(f.lines[py]!.indexOf('92%'), py)).toBe(P.crit)
  expect(f.lines.join('\n')).not.toContain('!')
})

// ---------------------------------------------------------------- quota

test('an absent 5h window is hidden, and a null quota is never drawn as 0%', async ($, on) => {
  world(on, { profile: 'me', quotas: [{ profile: 'other', five_hour: { used_percentage: null }, seven_day: { used_percentage: null }, updated_at_epoch: NOW / 1000 }] })
  await start($)
  await measure($, 30, [d7(23)])
  const all = (await frame($)).lines.join('\n')
  expect(all).toContain('quota 7d')
  expect(all).not.toContain('quota 5h')
  expect(all).not.toMatch(/\b0%/)
  expect(all).not.toContain('acct')
})

test('quota warn at 80% and crit at 95% colour the fill and percent, no !', async ($, on) => {
  world(on)
  await measure($, 30, [{ kind: 'five_hour', percentUsed: 85 }, d7(96)])
  const f = await frame($)
  const y5 = row(f, /^quota 5h/), y7 = row(f, /^quota 7d/)
  expect(y5).toBeLessThan(y7)
  expect(new Set(colsOf(f, y5, '━'))).toEqual(new Set([P.warn]))
  expect(f.fg(f.lines[y5]!.indexOf('85%'), y5)).toBe(P.warn)
  expect(new Set(colsOf(f, y7, '━'))).toEqual(new Set([P.crit]))
  expect(f.fg(f.lines[y7]!.indexOf('96%'), y7)).toBe(P.crit)
  expect(f.lines.join('\n')).not.toContain('!')
})

test('a calm quota uses the quota hue', async ($, on) => {
  world(on)
  await measure($, 30, [d7(40)])
  const f = await frame($)
  const y = row(f, /^quota 7d/)
  expect(new Set(colsOf(f, y, '━'))).toEqual(new Set([P.quota]))
})

test('every other account shows a row; stale ones say so; absent windows are hidden', async ($, on) => {
  world(on, {
    profile: 'me',
    quotas: [
      { profile: 'me', seven_day: { used_percentage: 90 }, updated_at_epoch: NOW / 1000 },
      { profile: 'beta', seven_day: { used_percentage: 82 }, five_hour: { used_percentage: 10 }, updated_at_epoch: NOW / 1000 },
      { profile: 'calm', seven_day: { used_percentage: 79 }, updated_at_epoch: NOW / 1000 },
      { profile: 'old', seven_day: { used_percentage: 99 }, updated_at_epoch: NOW / 1000 - 3600 },
    ],
  })
  await start($)
  await measure($, 30, [d7(23)])
  const f = await frame($)
  const accts = f.lines.filter(l => l.startsWith('acct')).map(l => l.trimEnd())
  expect(accts.map(a => a.split(/\s+/).slice(0, 2).join(' '))).toEqual(['acct beta', 'acct calm', 'acct old'])
  expect(accts[1]).toBe('acct calm   7d 79%')
  expect(accts[2]).toBe('acct old  stale')
  // beta reports both windows: each is named; 7d 82% is at warn
  expect(accts[0]).toBe('acct beta   5h 10%   7d 82%')
  const y = row(f, /^acct beta/)
  expect(f.fg(0, y)).toBe(P.dim)
  expect(f.fg(f.lines[y]!.indexOf('5h'), y)).toBe(P.dim)
  expect(f.fg(f.lines[y]!.indexOf('82%'), y)).toBe(P.warn)
  expect(f.fg(f.lines[y]!.indexOf('10%'), y)).toBe(P.text)
  expect(f.lines.join('\n')).not.toContain('━━━━━━━━━━━━━━━━━━━━━━━━  79%')
  expect(f.lines.join('\n')).not.toContain('acct me')
})

// ---------------------------------------------------------------- tools and session

test('narrow widths never exceed the width', async ($, on) => {
  world(on, { branch: 'a-very-long-branch-name-indeed', profile: 'me', quotas: [{ profile: 'beta-with-a-long-name', seven_day: { used_percentage: 97 }, updated_at_epoch: NOW / 1000 }] })
  millionSession(on, { limits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 2 * H).toISOString() }, d7(23)] })
  await start($)
  await complete($)
  for (const cols of [20, 30, 38, 43, 44, 48]) {
    const f = await frameAt($, cols)
    expect(f.w).toBe(cols)
    for (const l of f.lines) expect(Array.from(l).length, `width ${cols}`).toBe(cols)
    const all = f.lines.join('\n')
    expect(all, `bar at ${cols}`).toContain('━')
    expect(all, `pct at ${cols}`).toContain('31%')
  }
})

test('every laid-out row fits the width before any clipping', () => {
  const v: StackwellView = {
    profile: 'me', model: 'claude-opus-5-5[1m]', branch: 'feature/a-really-long-branch-name', tokens: 912_345, window: 1_000_000, percent: 91,
    quotas: [{ kind: 'five_hour', pct: 100, resetsAt: NOW + 2 * H }, { kind: 'seven_day', pct: 96, resetsAt: NOW + 6 * 24 * H }],
    costUsd: 1234.56, startedAt: NOW - 30 * H,
    breakdown: { msgs: 800_000, tools: 60_000, sys: 30_000, other: 22_345, raw: 1_000_000, autoCompact: 917_000 },
    accounts: [{ name: 'an-account-with-a-very-long-name', d7: 99, h5: 97, d7At: NOW + H, updatedAt: NOW / 1000 }],
    now: NOW, theme: 'auto', palette: P,
    trend: [100_000, 300_000, 500_000, 912_345], turns: 1234, lastTurnMs: 7_654_321,
    folders: [
      { key: '/w/a-very-long-folder-name-for-sure', name: 'a-very-long-folder-name-for-sure', isRepo: true, isWorktree: true, isCwd: true, branch: 'hatch/some-slug/item-a-long-id', added: 999_999, removed: 888_888, untracked: 77, lastAt: NOW - 50 * H, tag: 'hatch' },
      ...Array.from({ length: 6 }, (_, i) => ({ key: `/w/f${i}`, name: `f${i}`, isRepo: false, isWorktree: false, isCwd: false, lastAt: NOW - i * M })),
    ],
    cwd: '/w/a-very-long-folder-name-for-sure/and/deeper/still', home: '/u/tester',
    binders: [
      { slug: 'a-long-binder-slug-name', total: 120, isRunning: true, merged: 33, wave: 3, waves: 9, building: ['x-long-item-a', 'x-long-item-b', 'x-long-item-c'], halted: ['h1', 'h2'] },
      { slug: 'b', total: 2, isRunning: true, merged: 0, wave: 1, waves: 1, building: [], halted: [] },
      { slug: 'c', total: 2, isRunning: true, merged: 0, wave: 1, waves: 1, building: [], halted: [] },
      { slug: 'ready-one', total: 5, isRunning: false, merged: 0, wave: 1, waves: 2, building: [], halted: [] },
    ],
    agents: [
      { id: 'a', name: 'a-very-long-agent-description-here', model: 'sonnet', isBackground: true, status: 'running', startedAt: NOW - 100 * H },
      { id: 'b', name: 'done-agent-with-long-name', model: 'opus', isBackground: false, status: 'failed', startedAt: NOW - H, endedAt: NOW - 60_000 },
    ],
  }
  for (const W of [12, 20, 30, 38, 43, 44, 48]) {
    for (const r of layout(v, W)) {
      const width = r.reduce((a, s) => a + Array.from(s.text).length, 0)
      expect(width, `width ${W}: ${r.map(s => s.text).join('')}`).toBeLessThanOrEqual(W)
    }
  }
})

test('elapsed time shows after a turn even without a session start', async ($, on) => {
  world(on)
  millionSession(on)
  await measure($, 31, [d7(23)], 1_000_000)
  await complete($)
  const f = await frame($)
  expect(f.lines[row(f, /^session/)]).toContain('1h12m')
})

test('each group label and the cost take the group hue; names, units, header and accounts stay neutral', async ($, on) => {
  world(on, { branch: 'main', git: { changes: 1 }, profile: 'me', quotas: [{ profile: 'beta', seven_day: { used_percentage: 82 }, updated_at_epoch: NOW / 1000 }] })
  millionSession(on, { limits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 2 * H).toISOString() }, d7(23)] })
  await start($)
  await complete($)
  const f = await frame($)
  const all = (y: number, from: number, to: number) => new Set(Array.from({ length: to - from }, (_, i) => f.fg(from + i, y)))
  const yc = row(f, /^context/), y5 = row(f, /^quota 5h/), y7 = row(f, /^quota 7d/), ys = row(f, /^session/)
  expect(all(yc, 0, 7)).toEqual(new Set([P.context]))
  expect(all(y5, 0, 8)).toEqual(new Set([P.quota]))
  expect(all(y7, 0, 8)).toEqual(new Set([P.quota]))
  expect(all(ys, 0, 7)).toEqual(new Set([P.session]))
  const ls = f.lines[ys]!
  expect(all(ys, ls.indexOf('$'), ls.indexOf('$') + 5)).toEqual(new Set([P.session]))
  expect(all(ys, ls.indexOf(' est'), ls.indexOf(' est') + 4)).toEqual(new Set([P.dim]))
  expect(f.fg(0, 0)).toBe(P.text)
  expect(f.fg(f.lines[0]!.indexOf('/work'), 0)).toBe(P.dim)
  const ya = row(f, /^acct beta/)
  expect(all(ya, 0, 8)).toEqual(new Set([P.dim]))
  const yg = row(f, /^folders/)
  expect(all(yg, 0, 7)).toEqual(new Set([P.git]))
})

// ---------------------------------------------------------------- the fuller pane (pure layout)

const M = 60_000

function base(over: Partial<StackwellView> = {}): StackwellView {
  return {
    profile: 'me', model: 'claude-opus-5-5', branch: 'main', tokens: 131_000, window: 1_000_000, percent: 13,
    quotas: [], accounts: [],
    breakdown: { msgs: 79_000, tools: 7_000, sys: 3_000, other: 42_000, raw: 1_000_000, autoCompact: 917_000 },
    trend: [], turns: 0, agents: [], folders: [], binders: [],
    now: NOW, theme: 'auto', palette: P, ...over,
  }
}
type LRow = ReturnType<typeof layout>[number]
const txt = (r: LRow) => r.map(s => s.text).join('').trimEnd()
const lines = (v: StackwellView, W = 48, Hh = 200) => layout(v, W, Hh).map(txt)
const find = (v: StackwellView, re: RegExp, W = 48, Hh = 200) => layout(v, W, Hh).find(r => re.test(txt(r)))
/** The colour of the segment that holds `text`. */
const colourOf = (r: LRow | undefined, text: string) => r?.find(s => s.text.includes(text))?.fg

test('context row: growth and turns left before auto-compact, beside the numbers; no trend row', () => {
  const v = base({ trend: [86_000, 95_000, 104_000, 113_000, 122_000, 131_000] })
  expect(lines(v, 60).find(l => l.startsWith('context'))).toBe('context  +9k/turn · ~87 turns left' + '131k / 1M   13%'.padStart(26))
  const r = find(v, /^context/)!
  expect(colourOf(r, '~87')).toBe(P.dim)
  expect(colourOf(r, 'context')).toBe(P.context)
  // short of room: +Xk/turn goes first, then the window, then `left`, then the projection
  expect(lines(v, 48).find(l => l.startsWith('context'))).toBe('context  ~87 turns left' + '131k / 1M   13%'.padStart(25))
  expect(lines(v, 30).find(l => l.startsWith('ctx'))).toBe('ctx  ~87 turns' + '131k   13%'.padStart(16))
  expect(lines(v, 24).find(l => l.startsWith('ctx'))).toBe('ctx' + '131k / 1M   13%'.padStart(21))
  for (const W of [30, 48, 60]) expect(lines(v, W).some(l => l.startsWith('trend'))).toBe(false)
  expect(lines(v, 48).join('\n')).not.toMatch(/[▁▂▃▄▅▆▇█]/)
})

test('context row: projection hidden when growth is zero or less, or past 999 turns', () => {
  const ctx = (trend: number[], W = 48) => lines(base({ trend }), W).find(l => /^c(ontext|tx)/.test(l))!
  expect(ctx([140_000, 135_000, 131_000])).toMatch(/^context  −5k\/turn\s+131k/)
  expect(ctx([131_000, 131_000])).toMatch(/^context  \+0\/turn\s+131k/)
  expect(ctx([130_500, 131_000])).not.toContain('turns')
  expect(ctx([131_000])).toMatch(/^context\s+131k \/ 1M   13%$/)
})

test('quota pace tick sits at the even-use position, and is omitted when unknown', () => {
  // 7d window with 3 days 22.4 hours left: 44% elapsed
  const left = 7 * 24 * H * 0.56
  const v = base({ quotas: [{ kind: 'seven_day', pct: 44, resetsAt: NOW + left }, { kind: 'five_hour', pct: 10 }] })
  const r = find(v, /^quota 7d/)!
  const cells = Array.from(txt(r)).slice(12, 36)
  expect(cells.indexOf('│')).toBe(Math.round(0.44 * 24))
  expect(cells.filter(c => c === '━').length + cells.filter(c => c === '─').length).toBe(23)
  const tick = r.find(s => s.text === '│')
  expect(tick?.fg).toBe(P.text)
  expect(txt(find(v, /^quota 5h/)!)).not.toContain('│')
})

test('accounts: every window named with percent and reset, no bar; warn and crit on the percent; absent windows hidden', () => {
  const v = base({
    accounts: [
      { name: 'beta', h5: 58, h5At: NOW + 58 * M + 30_000, d7: 8, d7At: NOW + (5 * 24 + 12) * H + 30_000, updatedAt: NOW / 1000 },
      { name: 'hot', h5: 96, h5At: NOW + 2 * H, updatedAt: NOW / 1000 },
      { name: 'none', updatedAt: NOW / 1000 },
      { name: 'me', d7: 50, updatedAt: NOW / 1000 },
    ],
  })
  const all = lines(v)
  const beta = all.find(l => l.startsWith('acct beta'))!
  expect(beta).toBe('acct beta   5h 58%  58m   7d 8%  5d12h')
  const br = find(v, /^acct beta/)!
  expect(colourOf(br, '5h')).toBe(P.dim)
  expect(colourOf(br, '58%')).toBe(P.text)
  expect(colourOf(br, '58m')).toBe(P.dim)
  expect(br.some(s => s.text.includes('━'))).toBe(false)
  // too narrow for both: the fuller window alone, still named
  const narrow = layout(v, 24, 200).map(txt).find(l => l.startsWith('beta'))!
  expect(narrow).toBe('beta   5h 58%  58m')
  expect(all.some(l => l.startsWith('acct none'))).toBe(false)
  expect(all.some(l => l.startsWith('acct me'))).toBe(false)
  const hot = find(v, /^acct hot/)!
  expect(txt(hot)).toBe('acct hot    5h 96%  2h00m')
  expect(colourOf(hot, '96%')).toBe(P.crit)
  expect(colourOf(hot, 'acct')).toBe(P.dim)
})

test('session row: cost, $/h, elapsed and the turn stats; least important dropped first', () => {
  const v = base({ costUsd: 47.04, startedAt: NOW - (2 * 60 + 11) * M, turns: 14, lastTurnMs: 130_000, trend: [119_000, 131_000] })
  const sess = (W: number) => lines(v, W).find(l => /^sess/.test(l))
  expect(sess(70)).toBe('session     $47.04 est · $22/h · 2h11m' + 'turn 14 · 2m10s · +12k'.padStart(32))
  // drop order: the context delta, $/h, the turn's duration, the turn count
  expect(sess(56)).toBe('session     $47.04 est · $22/h · 2h11m' + 'turn 14 · 2m10s'.padStart(18))
  expect(sess(48)).toBe('session     $47.04 est · 2h11m' + 'turn 14 · 2m10s'.padStart(18))
  expect(sess(40)).toBe('sess   $47.04 est · 2h11m' + 'turn 14'.padStart(15))
  expect(sess(30)).toBe('sess   $47.04 est · 2h11m')
  const r = find(v, /^session/, 70)!
  expect(colourOf(r, 'session')).toBe(P.session)
  expect(colourOf(r, 'turn')).toBe(P.dim)
  for (const W of [30, 48, 70]) expect(lines(v, W).some(l => l.startsWith('cost'))).toBe(false)
  const early = base({ costUsd: 0.5, startedAt: NOW - 4 * M })
  expect(lines(early).find(l => l.startsWith('session'))).toBe('session     $0.50 est · 4m')
})

const folder = (o: Partial<StackwellView['folders'][number]> & { name: string }): StackwellView['folders'][number] => ({
  key: `/w/${o.name}`, isRepo: true, isWorktree: false, isCwd: false, lastAt: NOW, ...o,
})

test('folders: the cwd first with ●, worktrees ⎇, changes, age, a far-right tag; 4 rows and +N more', () => {
  const v = base({
    folders: [
      folder({ name: 'tools-repo', branch: 'main', added: 2, removed: 0, untracked: 3, lastAt: NOW - 3 * M }),
      folder({ name: 'sample-repo', branch: 'main', added: 0, removed: 0, isCwd: true, lastAt: NOW }),
      folder({ name: 'sample-repo-worktrees/item-x', isWorktree: true, branch: 'hatch/s/item-x', added: 5, removed: 1, lastAt: NOW - H, tag: 'hatch' }),
      folder({ name: 'notes', isRepo: false, lastAt: NOW - 12 * M }),
      folder({ name: 'old-a', lastAt: NOW - 2 * H }),
      folder({ name: 'old-b', lastAt: NOW - 3 * H }),
    ],
  })
  const all = lines(v)
  const i = all.indexOf('folders')
  expect(i).toBeGreaterThanOrEqual(0)
  const rows = all.slice(i + 1, i + 6)
  expect(rows[0]).toMatch(/^ {2}● sample-repo\s+main\s+clean$/)
  expect(rows[1]).toMatch(/^ {4}tools-repo\s+main\s+\+2 −0 \?3\s+3m$/)
  expect(rows[2]).toMatch(/^ {4}notes\s+12m$/)
  expect(rows[3]).toMatch(/^ {2}⎇ item-x\s+hatch\/s\S*\s+\+5 −1\s+1h {2}hatch$/)
  expect(rows[4]).toBe('    +2 more')
  for (const r of rows) expect(Array.from(r).length).toBeLessThanOrEqual(48)
  const lr = layout(v, 48, 200)
  expect(colourOf(lr[i]!, 'folders')).toBe(P.git)
  expect(colourOf(lr[i + 4]!, 'hatch')).toBe(P.dim)
})

test('folder label: inside the cwd by name or relative path; near it with up to two ../; else from ~ or /', () => {
  const cwd = '/u/tester/src/sample-repo', home = '/u/tester'
  expect(folderLabel('/u/tester/src/sample-repo', cwd, home)).toBe('sample-repo')
  expect(folderLabel('/u/tester/src/sample-repo/docs', cwd, home)).toBe('docs')
  expect(folderLabel('/u/tester/src/sample-repo/packages/api', cwd, home)).toBe('packages/api')
  expect(folderLabel('/u/tester/src/utils', cwd, home)).toBe('../utils')
  expect(folderLabel('/u/tester/src/other/x', '/u/tester/src/team/sample-repo', home)).toBe('../../other/x')
  expect(folderLabel('/u/tester/src', cwd, home)).toBe('..')
  expect(folderLabel('/u/tester/.config/x', cwd, home)).toBe('~/.config/x')
  expect(folderLabel('/u/tester/.config/mods/abc/stackwell', '/u/tester/src/team/sample-repo', home)).toBe('~/.config/mods/abc/stackwell')
  expect(folderLabel('/srv/data/shared', cwd, home)).toBe('/srv/data/shared')
  expect(folderLabel('/srv/data/shared', '', home)).toBe('shared')
})

test('fitPath shortens from the middle and keeps the last part whole', () => {
  expect(fitPath('~/src/utils', 20)).toBe('~/src/utils')
  expect(fitPath('~/.config/mods/abc/stackwell', 22)).toBe('~/…/mods/abc/stackwell')
  expect(fitPath('~/.config/mods/abc/stackwell', 13)).toBe('~/…/stackwell')
  expect(fitPath('../../other/src/utils', 12)).toBe('…/src/utils')
  expect(fitPath('../../other/src/utils', 10)).toBe('../…/utils')
  expect(fitPath('../../other/src/utils', 8)).toBe('…/utils')
  expect(fitPath('/srv/a/b/src/utils', 11)).toBe('…/src/utils')
  expect(fitPath('a-very-long-folder-name', 10)).toBe('a-very-lo…')
  expect(fitPath('~/work/plugin-market', 13)).toBe('plugin-market')
  expect(fitPath('../utils', 4)).toBe('uti…')
})

test('folders: rows outside the cwd show where they are, worktrees too, shortened to fit', () => {
  const v = base({
    cwd: '/u/tester/src/team/sample-repo', home: '/u/tester',
    folders: [
      folder({ key: '/u/tester/src/team/sample-repo', name: 'sample-repo', branch: 'main', isCwd: true, lastAt: NOW }),
      folder({ key: '/u/tester/src/team/sample-repo/packages/api', name: 'api', branch: 'main', lastAt: NOW - M }),
      folder({ key: '/u/tester/src/team/utils', name: 'utils', branch: 'main', isWorktree: true, lastAt: NOW - 2 * M }),
      folder({ key: '/u/tester/.config/mods/abc/stackwell', name: 'stackwell', isRepo: false, lastAt: NOW - 3 * M }),
    ],
  })
  const all = lines(v, 48)
  const rows = all.slice(all.indexOf('folders') + 1, all.indexOf('folders') + 5)
  expect(rows[0]).toMatch(/^ {2}● sample-repo\s+main$/)
  expect(rows[1]).toMatch(/^ {4}packages\/api\s+main\s+1m$/)
  expect(rows[2]).toMatch(/^ {2}⎇ \.\.\/utils\s+main\s+2m$/)
  expect(rows[3]).toMatch(/^ {4}~\/\S*stackwell\s+3m$/)
  const narrow = lines(v, 30)
  const far = narrow.find(l => l.includes('stackwell'))!
  expect(far).toMatch(/^ {4}(~\/)?…\/\S*stackwell\s+3m$/)
  for (const l of [...all, ...narrow]) expect(l).not.toMatch(/\/u\/tester/)
})

test('folders: the section shows the cwd row even when it is all there is', () => {
  const all = lines(base({ folders: [folder({ name: 'sample-repo', branch: 'main', added: 0, removed: 0, isCwd: true })] }))
  expect(all.filter(l => /^ {2}● sample-repo/.test(l)).length).toBe(1)
})

test('touched folders per tool', () => {
  const t = (tool: string, input: Record<string, unknown>) => touchedFolders(tool, input, '/w/here', '/u/tester')
  expect(t('Read', { file_path: '/w/a/src/x.ts' })).toEqual(['/w/a/src'])
  expect(t('Edit', { file_path: 'rel/y.md' })).toEqual(['/w/here/rel'])
  expect(t('Write', { file_path: '~/notes/n.md' })).toEqual(['/u/tester/notes'])
  expect(t('NotebookEdit', { notebook_path: '/w/nb/a.ipynb' })).toEqual(['/w/nb'])
  expect(t('Grep', { pattern: 'x', path: '/w/b' })).toEqual(['/w/b'])
  expect(t('Glob', { pattern: '*.ts', path: '../c' })).toEqual(['/w/c'])
  expect(t('Grep', { pattern: 'x' })).toEqual([])
  expect(t('Bash', { command: 'cd /w/d && make' })).toEqual(['/w/d'])
  expect(t('Bash', { command: 'git -C /w/e status --short' })).toEqual(['/w/e'])
  expect(t('Bash', { command: 'ls /w/f/src /w/g/readme.md | head' })).toEqual(['/w/f/src', '/w/g'])
  expect(t('Bash', { command: 'echo hi; cat /w/h/x.txt' })).toEqual([])
  expect(t('WebFetch', { url: 'https://example.com' })).toEqual([])
})

test('the header path: home shortened, the middle elided, at widths 30 to 60', () => {
  expect(shortPath('/u/tester/src/sample-repo', '/u/tester', 40)).toBe('~/src/sample-repo')
  expect(shortPath('/u/tester/a/b/src/sample-repo', '/u/tester', 18)).toBe('~/…/src/sample-repo'.length <= 18 ? '~/…/src/sample-repo' : '~/…/sample-repo')
  expect(shortPath('/srv/a/b/c/sample-repo', '', 16)).toBe('/…/c/sample-repo')
  expect(shortPath('/srv/a/b/c/sample-repo', '', 15)).toBe('/…/sample-repo')
  expect(shortPath('/srv/a/a-very-long-final-folder', '', 10)).toBe('…al-folder')
  const v = base({ cwd: '/u/tester/work/projects/clients/sample-repo', home: '/u/tester' })
  for (let W = 30; W <= 60; W++) {
    const h = txt(layout(v, W, 200)[0]!)
    expect(Array.from(h).length, `width ${W}`).toBeLessThanOrEqual(W)
    expect(h, `width ${W}`).toMatch(/^Opus 5\.5 \(1M\) +\S*(sample-repo|…\S+)$/)
  }
})

test('agents: running and finished rows; a finished agent drops off after 5 minutes', () => {
  const agents: StackwellView['agents'] = [
    { id: '1', name: 'researcher', model: 'sonnet', isBackground: false, status: 'running', startedAt: NOW - 1 * M },
    { id: '2', name: 'coder', model: 'opus', isBackground: false, status: 'ok', startedAt: NOW - 8 * M, endedAt: NOW - 4 * M },
    { id: '3', name: 'old', model: 'opus', isBackground: false, status: 'failed', startedAt: NOW - 20 * M, endedAt: NOW - 5 * M },
    { id: '4', name: 'bgjob', isBackground: true, status: 'running', startedAt: NOW - 3 * M },
  ]
  const v = base({ agents })
  const all = lines(v)
  const i = all.findIndex(l => l.startsWith('agents'))
  expect(all[i]).toMatch(/^agents      researcher  sonnet\s+1m$/)
  expect(all[i + 1]).toMatch(/^            bgjob\s+3m$/)
  expect(all[i + 2]).toMatch(/^            ✓ coder  opus\s+4m$/)
  expect(all.join('\n')).not.toContain('old')
  const rows = layout(v, 48, 200)
  expect(colourOf(rows[i], 'agents')).toBe(P.agents)
  expect(colourOf(rows[i + 2], 'coder')).toBe(P.dim)
  expect(colourOf(rows[i], 'researcher')).toBe(P.text)
  // every agent finished more than 5 minutes ago: the group is gone
  const gone = base({ agents: [{ ...agents[2]! }] })
  expect(lines(gone).some(l => l.startsWith('agents'))).toBe(false)
})

test('a short height drops, in order: finished agents, hatch items, folders, accounts, hatch', () => {
  const v = base({
    costUsd: 5, startedAt: NOW - H, turns: 2, lastTurnMs: 1000,
    trend: [100_000, 131_000],
    quotas: [{ kind: 'seven_day', pct: 20 }],
    accounts: [{ name: 'beta', d7: 12, updatedAt: NOW / 1000 }],
    folders: [folder({ name: 'cwd-repo', isCwd: true, branch: 'main' }), folder({ name: 'other-a', lastAt: NOW - M }), folder({ name: 'other-b', lastAt: NOW - 2 * M }), folder({ name: 'other-c', lastAt: NOW - 3 * M }), folder({ name: 'other-d', lastAt: NOW - 4 * M })],
    binders: [{ slug: 'packs', total: 4, isRunning: true, merged: 1, wave: 1, waves: 2, building: ['item-a'], halted: [] }],
    agents: [
      { id: '1', name: 'runner', isBackground: false, status: 'running', startedAt: NOW - M },
      { id: '2', name: 'doner', isBackground: false, status: 'ok', startedAt: NOW - 2 * M, endedAt: NOW - M },
    ],
    steward: { role: 'primary', initiative: 'widget-release', peers: [{ name: 'beta-sec', role: 'secondary', status: 'busy' }], logMtime: NOW - 12 * M },
  })
  const has = (Hh: number) => {
    const all = lines(v, 48, Hh)
    expect(all.length, `rows ${Hh}`).toBeLessThanOrEqual(Hh)
    return {
      done: all.some(l => l.includes('doner')),
      acct: all.some(l => l.startsWith('acct')),
      fmore: all.some(l => /^ +\+\d+ more$/.test(l)), frow: all.some(l => l.includes('other-a')), folder: all.some(l => l === 'folders'),
      hitems: all.some(l => l.includes('• item-a')), hhead: all.some(l => l.startsWith('hatch')),
      runner: all.some(l => l.includes('runner')),
      slog: all.some(l => /└─ log \d+\w ago/.test(l)), speer: all.some(l => l.includes('beta-sec')),
      steward: all.some(l => l.startsWith('steward')),
    }
  }
  const fullH = lines(v, 48, 200).length
  const seen: string[] = []
  let prev = has(fullH)
  expect(Object.values(prev).every(Boolean)).toBe(true)
  for (let Hh = fullH - 1; Hh >= 8; Hh--) {
    const now = has(Hh)
    const KEYS = ['done', 'hitems', 'fmore', 'frow', 'acct', 'hhead', 'folder', 'slog', 'speer'] as const
    for (const k of KEYS) if (prev[k] && !now[k]) seen.push(k)
    prev = now
  }
  expect(seen).toEqual(['done', 'hitems', 'fmore', 'frow', 'acct', 'hhead', 'folder', 'slog', 'speer'])
})

test('the realistic full state fits 48 x 40', () => {
  const v = base({
    costUsd: 47.04, startedAt: NOW - (2 * 60 + 11) * M, turns: 14, lastTurnMs: 130_000,
    trend: [86_000, 88_000, 95_000, 99_000, 104_000, 108_000, 113_000, 119_000, 122_000, 131_000],
    quotas: [{ kind: 'seven_day', pct: 44, resetsAt: NOW + (3 * 24 + 4) * H + M }],
    accounts: [{ name: 'beta', d7: 12, d7At: NOW + (5 * 24 + 1) * H + M, updatedAt: NOW / 1000 }],
    folders: [folder({ name: 'sample-repo', isCwd: true, branch: 'main', added: 120, removed: 40 })],
    agents: [
      { id: '1', name: 'researcher', model: 'sonnet', isBackground: false, status: 'running', startedAt: NOW - M },
      { id: '2', name: 'coder', model: 'opus', isBackground: false, status: 'ok', startedAt: NOW - 8 * M, endedAt: NOW - 4 * M },
    ],
  })
  const rows = layout(v, 48, 40)
  expect(rows.length).toBeGreaterThan(15)
  expect(rows.length).toBeLessThanOrEqual(40)
  for (const r of rows) expect(Array.from(r.map(s => s.text).join('')).length).toBeLessThanOrEqual(48)
})

// ---------------------------------------------------------------- collection through the engine

test('turn ends record the context trend and the turn stats', async ($, on) => {
  world(on)
  let tokens = 100_000, usd = 1
  on('session.usage', () => ({ value: { startedAt: NOW - H, context: { tokens, window: 1_000_000, percent: 10 }, rateLimits: [], cost: { usd } } }))
  await start($)
  tokens = 110_000; usd = 1.5
  await complete($, 65_000)
  tokens = 125_000; usd = 2.5
  await complete($, 5_000)
  const f = await frame($)
  expect(f.lines[row(f, /^context/)]!.trimEnd()).toMatch(/^context  \+15k\/turn\s+125k \/ 1M/)
  expect(f.lines[row(f, /^session/)]!.trimEnd()).toMatch(/turn 2 · 5\.0s$/)
  expect(f.lines.some(l => /^(trend|cost)\b/.test(l))).toBe(false)
})

test('folders: the turn\'s tool uses group by repo root; plain folders by their folder; worktrees get ⎇', async ($, on) => {
  const calls: Record<string, number> = {}
  const transcript: Transcript = { main: [] }
  world(on, { branch: 'main', extra: { calls, transcript, repos: [{ root: '/work/alpha', branch: 'dev', changes: 1 }, { root: '/work/alpha-wt/item', mainRoot: '/work/alpha', branch: 'hatch/s/item-x', changes: 0 }] } })
  millionSession(on)
  await start($)
  transcript.main.push(
    said({ tool: 'Read', input: { file_path: '/work/alpha/src/a.ts' } }, { tool: 'Read', input: { file_path: '/work/alpha/docs/b.md' } }),
    said({ tool: 'Read', input: { file_path: '/work/alpha/src/c.ts' } }),
    said({ tool: 'Edit', input: { file_path: '/work/alpha-wt/item/x.ts', old_string: 'a', new_string: 'b' } }, { tool: 'Write', input: { file_path: '/data/notes/n.md', content: 'x' } }),
  )
  await complete($)
  const f = await frame($)
  const i = row(f, /^folders\s*$/)
  const rows = f.lines.slice(i + 1, i + 5).map(l => l.trimEnd())
  expect(rows[0]).toMatch(/^ {2}● sample-repo\s+main/)
  expect(rows.filter(r => /alpha /.test(r)).length).toBe(1)
  expect(rows.find(r => r.includes('item'))).toMatch(/^ {2}⎇ \S*item\s+hatch\S*\s+—\s+now {2}hatch$/)
  expect(rows.find(r => r.includes('notes'))).toMatch(/^ {4}\/data\/notes\s+now$/)
  // one walk up to `.git` per folder asked about: src twice, but never again; never a detect outside the cwd's repo
  expect(calls['stat:/work/alpha/src/.git']).toBe(1)
  expect(Object.keys(calls).filter(k => k.startsWith('detect:/work/alpha'))).toEqual([])
})

test('folders: no vcs calls on render; refresh only at start, turn end and the minute tick', async ($, on) => {
  const calls: Record<string, number> = {}
  world(on, { branch: 'main', extra: { calls, transcript: { main: [said({ tool: 'Read', input: { file_path: '/work/alpha/a.ts' } })] }, repos: [{ root: '/work/alpha', changes: 1 }] } })
  millionSession(on)
  await start($)
  const before = { ...calls }
  for (let k = 0; k < 5; k++) await frame($)
  expect(calls).toEqual(before)
  await complete($)
  expect((calls['vcs.status'] ?? 0)).toBeGreaterThan(before['vcs.status'] ?? 0)
})

test('an agent appears from the list at its own turn start and ends on its own turn.complete; an aborted one failed', async ($, on) => {
  world(on)
  millionSession(on)
  const agents = agentList(on)
  await start($)
  agents.push(listed({ id: 'ag-bg', description: 'survey', type: 'Explore', status: 'running' }), listed({ id: 'ag-fg', description: 'coder', type: 'example.coder', status: 'running' }))
  await agentStart($, 'ag-bg')
  let all = (await frame($)).lines.map(l => l.trimEnd())
  expect(all.find(l => l.includes('survey'))).toMatch(/ Explore  survey\s+0m$/)
  expect(all.find(l => l.includes('coder'))).toMatch(/ example\.coder  coder\s+0m$/)
  await agentEnd($, 'ag-bg')
  await agentEnd($, 'ag-fg', true)
  all = (await frame($)).lines.map(l => l.trimEnd())
  expect(all.find(l => l.includes('survey'))).toMatch(/✓ Explore  survey\s+0m$/)
  expect(all.find(l => l.includes('coder'))).toMatch(/✕ example\.coder  coder\s+0m$/)
})

// ---------------------------------------------------------------- steward

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_D = '44444444-4444-4444-8444-444444444444'
const REGISTRY = [
  '# Initiatives',
  '',
  '| Initiative | Primary (ListAgents name, session id) | Secondaries (ListAgents name, repo) | Decision log | Since |',
  '|-|-|-|-|-|',
  `| widget-release | alpha-main (session ${ID_A}; socket /tmp/alpha.sock) | beta-sec (session ${ID_B}; repo: /work/beta) and gamma-sec (session 33333333-3333-4333-8333-333333333333; second profile, by name); repo: /work/gamma | \`~/notes/widget-log.md\` | 2026-01-02 |`,
  `| old-thing | delta-main (session ${ID_D}) | none (epsilon closed 2026-01-01) | /work/old/log.md | 2025-12-01 |`,
].join('\n')

const stewardRows = (f: Frame) => {
  const i = row(f, /^steward/)
  if (i < 0) return []
  const out = [f.lines[i]!.trimEnd()]
  for (let k = i + 1; k < f.lines.length && f.lines[k]!.startsWith('  ') && f.lines[k]!.trim() !== ''; k++) out.push(f.lines[k]!.trimEnd())
  return out
}

test('steward: hidden with no registry, no match, or a closed (none) row', async ($, on) => {
  world(on, { steward: { sessionId: ID_A } })
  millionSession(on)
  await start($)
  expect(stewardRows(await frame($))).toEqual([])
})

test('steward: hidden when the session matches no row', async ($, on) => {
  world(on, { steward: { registry: REGISTRY, sessionId: '55555555-5555-4555-8555-555555555555' } })
  millionSession(on)
  await start($)
  const f = await frame($)
  expect(stewardRows(f)).toEqual([])
  expect(f.lines.join('\n')).not.toContain('steward')
})

test('steward: a row whose secondaries are none is closed and hidden', async ($, on) => {
  world(on, { steward: { registry: REGISTRY, sessionId: ID_D } })
  millionSession(on)
  await start($)
  expect(stewardRows(await frame($))).toEqual([])
})

test('steward: primary view with peer states from ListAgents and the decision log age', async ($, on) => {
  world(on, {
    steward: { registry: REGISTRY, sessionId: ID_A, logMtime: NOW - 12 * 60_000, peers: [{ name: 'beta-sec', status: 'busy', sessionId: ID_B, since: NOW - 4 * 60_000 }] },
  })
  millionSession(on)
  await start($)
  const f = await frame($)
  expect(stewardRows(f)).toEqual([
    'steward     ★ widget-release',
    '  ├─ beta-sec'.padEnd(41) + 'busy 4m',
    '  ├─ gamma-sec'.padEnd(41) + 'offline',
    '  └─ log 12m ago',
  ])
  const y = row(f, /^steward/)
  expect(f.fg(0, y)).toBe(P.steward)
  expect(f.fg(f.lines[y + 1]!.indexOf('busy'), y + 1)).toBe(P.text)
  expect(f.fg(f.lines[y + 2]!.indexOf('offline'), y + 2)).toBe(P.dim)
  // after quota, before the session group
  expect(y).toBeLessThan(row(f, /^session/))
  expect(y).toBeGreaterThan(row(f, /^quota 7d/))
})

test('steward: secondary view, matched by the session id inside a messy cell', async ($, on) => {
  world(on, { steward: { registry: REGISTRY, sessionId: ID_B } })
  millionSession(on)
  await start($)
  expect(stewardRows(await frame($))).toEqual([
    'steward     widget-release',
    '  ↑  alpha-main'.padEnd(41) + 'offline',
    '  └─ gamma-sec'.padEnd(41) + 'offline',
  ])
})

test('steward: the registry is parsed again only when its mtime changes', async ($, on) => {
  const st: Steward = { registry: REGISTRY, sessionId: ID_A, mtime: 100, reads: [] }
  world(on, { steward: st })
  millionSession(on)
  await start($)
  expect(st.reads!.length).toBe(1)
  await complete($)
  await complete($)
  expect(st.reads!.length).toBe(1)
  st.mtime = 200
  st.registry = REGISTRY.replace('widget-release', 'widget-launch')
  await complete($)
  expect(st.reads!.length).toBe(2)
  expect(stewardRows(await frame($))[0]).toBe('steward     ★ widget-launch')
})

test('steward: STEWARD_ORCHESTRATION_DIR moves the registry', async ($, on) => {
  world(on, { steward: { registry: REGISTRY, sessionId: ID_A, dir: '/srv/orchestration' } })
  millionSession(on)
  await start($)
  expect(stewardRows(await frame($))[0]).toBe('steward     ★ widget-release')
})


// ---------------------------------------------------------------- configuration

const PALETTE_FILE = [
  '#!/bin/sh',
  '# >>> PALETTE',
  'CTX_OK=200,190,170',
  'CTX_WARN=230,160,60',
  'CTX_CRIT=230,70,70',
  'TEXT_FG=40,34,30',
  '# <<< PALETTE',
].join('\n')

test('config defaults: theme auto, quota files under ~/.claude/quota, no palette file read', async ($, on) => {
  const reads: string[] = []
  world(on, { profile: 'me', quotas: [{ profile: 'beta', seven_day: { used_percentage: 12 }, updated_at_epoch: NOW / 1000 }], extra: { reads } })
  millionSession(on)
  await start($)
  const f = await frame($)
  expect(f.lines.some(l => l.startsWith('acct beta'))).toBe(true)
  expect(reads.filter(r => !r.startsWith('/u/tester/.claude/quota/'))).toEqual([])
  // auto with no palette file and no app theme: the neutral dark preset
  expect(f.fg(0, row(f, /^context/))).toBe(PRESETS.vga!.context)
})

test('quotaDir moves the account files; a missing folder hides the accounts silently', { options: { quotaDir: '/data/q' } }, async ($, on) => {
  world(on, { profile: 'me', quotas: [{ profile: 'beta', seven_day: { used_percentage: 12 }, updated_at_epoch: NOW / 1000 }], extra: { quotaDir: '/data/q' } })
  millionSession(on)
  await start($)
  expect((await frame($)).lines.some(l => l.startsWith('acct beta'))).toBe(true)
})

test('a quotaDir that does not exist: no account rows, nothing else lost', { options: { quotaDir: '/nowhere' } }, async ($, on) => {
  world(on, { profile: 'me', quotas: [{ profile: 'beta', seven_day: { used_percentage: 12 }, updated_at_epoch: NOW / 1000 }] })
  millionSession(on)
  await start($)
  const f = await frame($)
  expect(f.lines.some(l => l.startsWith('acct'))).toBe(false)
  expect(f.lines.some(l => l.startsWith('quota 7d'))).toBe(true)
})

test('paletteFile set: auto takes its colours', { options: { paletteFile: '/etc/palette.sh' } }, async ($, on) => {
  const reads: string[] = []
  world(on, { extra: { reads, files: { '/etc/palette.sh': PALETTE_FILE } } })
  millionSession(on)
  await start($)
  expect(reads).toContain('/etc/palette.sh')
  const f = await frame($)
  expect(f.fg(0, 0)).toBe(0xc8beaa)
})

test('auto with no palette file follows a light app theme', async ($, on) => {
  world(on, { extra: { appTheme: 'light' } })
  millionSession(on)
  await start($)
  const f = await frame($)
  expect(f.fg(0, row(f, /^context/))).toBe(PRESETS.latte!.context)
})

test('the theme option picks a preset', { options: { theme: 'mocha' } }, async ($, on) => {
  world(on)
  millionSession(on)
  await start($)
  const f = await frame($)
  const y = row(f, /^▪ msgs/)
  expect(f.fg(f.lines[y]!.indexOf('msgs'), y)).toBe(PRESETS.mocha!.dim)
})

// ---------------------------------------------------------------- nothing local ships

// The words are split so this list does not itself carry them.
const LOCAL = [['/ho', 'me'], ['dev-', 'mods'], ['va', 'der'], ['r', 'aj'], ['t', 'ej'], ['myth-', 'gecko'], ['ts.', 'net'],
  ['bra', 'hma'], ['stack', 'house'], ['home', 'lab'], ['ut', 'ils/'], ['status', 'line.sh'], ['ghost', 'ty'],
  ['claude-', 'profiles'], ['claude-', 'configs'], ['an', 'vil'], ['/tmp/', 'claude'], ['/mnt/agent-', 'storage']].map(p => p.join(''))
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

// The kit gives a test no disk and imports code files only, so the shipped code is read as every
// module's exports; README, LICENSE and plugin.json are outside its reach.
test('no local names, paths or real ids in the shipped code', () => {
  const modules = [{ register }, drawModule, stewardModule, agentsModule, foldersModule, hatchModule]
  const sources = modules.flatMap(m => Object.values(m))
    .filter(x => typeof x === 'function' || (typeof x === 'object' && x !== null))
    .map(x => (typeof x === 'function' ? String(x) : JSON.stringify(x)))
  expect(sources.length).toBeGreaterThan(20)
  const text = sources.join('\n').toLowerCase()
  for (const w of LOCAL) expect(text.includes(w), w).toBe(false)
  for (const id of text.match(UUID) ?? []) expect(/^(\d)\1{7}-/.test(id), id).toBe(true)
  // the registry fixture uses patterned ids only
  for (const id of REGISTRY.match(UUID) ?? []) expect(/^(\d)\1{7}-/.test(id), id).toBe(true)
})

// ---------------------------------------------------------------- spacing and names

test('every group label has at least 2 spaces before its content, at widths 30 to 60', () => {
  const v = base({
    costUsd: 5, startedAt: NOW - H, turns: 2, lastTurnMs: 1000, trend: [100_000, 131_000],
    quotas: [{ kind: 'five_hour', pct: 10, resetsAt: NOW + H }, { kind: 'seven_day', pct: 20, resetsAt: NOW + 24 * H }],
    accounts: [{ name: 'work-account', d7: 12, d7At: NOW + H, updatedAt: NOW / 1000 }],
    folders: [folder({ name: 'cwd-repo', isCwd: true, branch: 'main' })],
    binders: [{ slug: 'packs', total: 4, isRunning: true, merged: 1, wave: 1, waves: 2, building: ['a'], halted: [] }],
    agents: [{ id: '1', name: 'runner', isBackground: false, status: 'running', startedAt: NOW - M }],
    steward: { role: 'primary', initiative: 'widget-release', peers: [{ name: 'beta-sec', role: 'secondary', status: 'busy' }] },
  })
  const LABEL = /^(context|ctx|quota \w+|5h|7d|acct [\w…-]+|work[\w…-]*|session|sess|steward|stw|hatch|agents|agt)( *)(\S)/
  for (let W = 30; W <= 60; W++) {
    const rows = layout(v, W, 200).map(txt)
    let seen = 0
    for (const l of rows) {
      const m = LABEL.exec(l)
      if (!m) continue
      seen++
      expect(m[2]!.length, `width ${W}: "${l}"`).toBeGreaterThanOrEqual(2)
    }
    expect(seen, `width ${W}`).toBeGreaterThanOrEqual(7)
  }
})

test('steward peers: a tree from a 2-space indent, the name whole; status goes first when tight', () => {
  const long = 'a-rather-long-secondary-name'
  const st = (x: NonNullable<StackwellView['steward']>) => x
  const v = base({
    steward: st({ role: 'primary', initiative: 'widget-release', peers: [{ name: long, role: 'secondary', status: 'idle' }, { name: 'b', role: 'secondary', status: 'busy' }] }),
  })
  const at = (W: number) => {
    const all = layout(v, W, 200).map(txt)
    const i = all.findIndex(l => l.startsWith('steward') || l.startsWith('stw'))
    return all.slice(i, i + 3)
  }
  expect(at(48)).toEqual(['steward     ★ widget-release', '  ├─ ' + long + 'idle'.padStart(48 - 5 - long.length), '  └─ b'.padEnd(44) + 'busy'])
  // 34 columns: the status no longer fits beside the whole name, so it goes; the name stays whole
  expect(at(34)[1]).toBe('  ├─ ' + long)
  // 30 columns: only then the name is cut
  expect(at(30)[1]).toBe('  ├─ ' + long.slice(0, 24) + '…')
  const rows = layout(v, 48, 200)
  const r = rows.find(x => txt(x).includes('busy'))!
  expect(colourOf(r, 'busy')).toBe(P.text)
  expect(colourOf(rows.find(x => txt(x).includes('idle')), 'idle')).toBe(P.dim)
  expect(colourOf(r, '└─')).toBe(P.dim)
})

test('group order: context, quota, steward, hatch, folders, agents, session', () => {
  const v = base({
    costUsd: 5, startedAt: NOW - H, turns: 2, lastTurnMs: 1000, trend: [100_000, 131_000],
    quotas: [{ kind: 'seven_day', pct: 20 }],
    accounts: [{ name: 'work', d7: 12, updatedAt: NOW / 1000 }],
    folders: [folder({ name: 'cwd-repo', isCwd: true, branch: 'main' })],
    binders: [{ slug: 'packs', total: 4, isRunning: true, merged: 1, wave: 1, waves: 2, building: [], halted: [] }],
    agents: [{ id: '1', name: 'runner', isBackground: false, status: 'running', startedAt: NOW - M }],
    steward: { role: 'primary', initiative: 'widget-release', peers: [] },
  })
  const all = lines(v)
  const at = (re: RegExp) => all.findIndex(l => re.test(l))
  const order = [/^context/, /^quota 7d/, /^acct work/, /^steward/, /^hatch/, /^folders$/, /^agents/, /^session/].map(at)
  for (const i of order) expect(i).toBeGreaterThanOrEqual(0)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  // a blank row between groups; the context legend leads straight into the blank
  expect(all[at(/^session/) - 1]).toBe('')
  // the session row is the last
  expect(all.slice(at(/^session/) + 1).every(l => l === '')).toBe(true)
})

// ---------------------------------------------------------------- hatch

const BINDER = JSON.stringify({
  slug: 'packs',
  work_items: [
    { id: 'core', depends_on: [] },
    { id: 'api', depends_on: ['core'] },
    { id: 'ui', depends_on: ['core'] },
    { id: 'docs', depends_on: ['api', 'ui'] },
    { id: 'notes', depends_on: [] },
  ],
})
const REFS = [
  'refs/heads/hatch/packs/integration',
  'refs/hatch/packs/item-core/accepted',
  'refs/hatch/packs/item-notes/done',
  'refs/heads/hatch/packs/item-api',
  'refs/heads/hatch/packs/item-ui',
  'refs/hatch/packs/item-ui/failed',
  'refs/tags/hatch/packs/wave-1',
]

test('binder state: merged, building, halted, wave from depth and tags', () => {
  const b = binderState(parseBinder(BINDER)!, REFS)
  expect(b).toEqual({ slug: 'packs', total: 5, isRunning: true, merged: 2, wave: 2, waves: 3, building: ['api'], halted: ['ui'] })
  const idle = binderState(parseBinder(BINDER)!, [])
  expect(idle.isRunning).toBe(false)
  expect(idle.wave).toBe(1)
  expect(parseBinder('{"nope": 1}')).toBeUndefined()
})

const running = (o: Partial<StackwellView['binders'][number]> = {}): StackwellView['binders'][number] => ({
  slug: 'packs', total: 7, isRunning: true, merged: 4, wave: 2, waves: 3, building: ['install-api', 'install-ui'], halted: ['install-docs'], ...o,
})

test('hatch block: header with wave, merged bar, building and halted rows', () => {
  const v = base({ binders: [running()] })
  const all = lines(v)
  const i = all.findIndex(l => l.startsWith('hatch'))
  expect(all[i]).toBe('hatch       packs · wave 2/3')
  expect(all[i + 1]).toMatch(/^ {2}━+─+ 4\/7 merged$/)
  expect(Array.from(all[i + 1]!).length).toBe(48)
  expect(all[i + 2]).toMatch(/^ {2}• install-api {2}• install-ui\s+building$/)
  expect(all[i + 3]).toMatch(/^ {2}✕ install-docs\s+halted$/)
  const rows = layout(v, 48, 200)
  expect(colourOf(rows[i], 'hatch')).toBe(P.hatch)
  expect(colourOf(rows[i + 3], '✕ install-docs')).toBe(P.warn)
  expect(colourOf(rows[i + 1], '━')).toBe(P.hatch)
})

test('hatch light mode: binders declared, none running', () => {
  const v = base({ binders: [running({ slug: 'packs-install', isRunning: false, total: 7 }), running({ slug: 'docs-sweep', isRunning: false, total: 3 })] })
  const all = lines(v)
  const i = all.findIndex(l => l.startsWith('hatch'))
  expect(all.slice(i, i + 2)).toEqual(['hatch       2 binders ready', '  packs-install 7 items · docs-sweep 3 items'])
  expect(all[i + 2] ?? '').toBe('')
})

test('hatch mixed: running blocks, the ready ones on one light line; max 2 blocks', () => {
  const v = base({ binders: [running({ slug: 'a' }), running({ slug: 'b', building: [], halted: [] }), running({ slug: 'c' }), running({ slug: 'later', isRunning: false, total: 2 })] })
  const all = lines(v)
  const i = all.findIndex(l => l.startsWith('hatch'))
  const end = all.indexOf('', i)
  const block = all.slice(i, end < 0 ? all.length : end)
  expect(block[0]).toBe('hatch       a · wave 2/3')
  expect(block.some(l => l.startsWith('            b · wave'))).toBe(true)
  expect(block.some(l => l.includes('c · wave'))).toBe(false)
  expect(block).toContain('  +1 more running')
  expect(block[block.length - 1]).toBe('  ready: later 2 items')
})

test('hatch through the engine: binders read once by mtime, one ref listing per repo, nothing on render', async ($, on) => {
  const calls: Record<string, number> = {}
  const bdir = '/work/sample-repo/.hatch/binders'
  world(on, {
    branch: 'main',
    extra: {
      calls,
      stats: { [bdir]: { kind: 'dir', mtimeMs: 5 } },
      dirs: { [bdir]: [{ name: 'packs.json', kind: 'file' }, { name: 'archive', kind: 'dir' }] },
      files: { [`${bdir}/packs.json`]: BINDER },
      refs: { '/work/sample-repo': REFS },
    },
  })
  millionSession(on)
  await start($)
  let f = await frame($)
  expect(f.lines[row(f, /^hatch/)]).toMatch(/^hatch {7}packs · wave 2\/3/)
  const runs = calls['process.run']!
  const reads = calls['fs.read']!
  expect(runs).toBe(1)
  for (let k = 0; k < 4; k++) f = await frame($)
  expect(calls['process.run']).toBe(runs)
  await complete($)
  expect(calls['process.run']).toBe(runs + 1)
  // the binders folder's mtime is unchanged: not read again
  expect(calls['fs.read']).toBe(reads)
})

test('hatch hidden without binders; light without an integration branch', async ($, on) => {
  const bdir = '/work/sample-repo/.hatch/binders'
  world(on, { branch: 'main', extra: { stats: { [bdir]: { kind: 'dir', mtimeMs: 5 } }, dirs: { [bdir]: [{ name: 'packs.json', kind: 'file' }] }, files: { [`${bdir}/packs.json`]: BINDER }, refs: { '/work/sample-repo': [] } } })
  millionSession(on)
  await start($)
  const f = await frame($)
  expect(f.lines[row(f, /^hatch/)]!.trimEnd()).toBe('hatch       1 binder ready')
})

test('no hatch section in a repo without binders', async ($, on) => {
  world(on, { branch: 'main' })
  millionSession(on)
  await start($)
  expect((await frame($)).lines.some(l => l.startsWith('hatch'))).toBe(false)
})

// ---------------------------------------------------------------- peer sessions

test('peer status from session files: by session id, age since the change, offline when none', async ($, on) => {
  world(on, {
    steward: { registry: REGISTRY, sessionId: ID_A, peers: [{ name: 'renamed', status: 'idle', sessionId: ID_B, since: NOW - 12 * 60_000 }] },
  })
  millionSession(on)
  await start($)
  const rows = stewardRows(await frame($))
  expect(rows[1]).toBe('  ├─ beta-sec'.padEnd(40) + 'idle 12m')
  expect(rows[2]).toBe('  └─ gamma-sec'.padEnd(41) + 'offline')
})

test('peer session files are read again only when their mtime changes', async ($, on) => {
  const calls: Record<string, number> = {}
  world(on, { steward: { registry: REGISTRY, sessionId: ID_A, peers: [{ name: 'beta-sec', status: 'busy', sessionId: ID_B, since: NOW }] }, extra: { calls } })
  millionSession(on)
  await start($)
  const reads = calls['fs.read']!
  await complete($)
  await complete($)
  expect(calls['fs.read']).toBe(reads)
})

test('sessionDirs with a * part lists every matching folder', { options: { sessionDirs: ['~/.profiles/*/sessions'] } }, async ($, on) => {
  const dirA = '/u/tester/.profiles/one/sessions', dirB = '/u/tester/.profiles/two/sessions'
  world(on, {
    steward: { registry: REGISTRY, sessionId: ID_A },
    extra: {
      dirs: {
        '/u/tester/.profiles': [{ name: 'one', kind: 'dir' }, { name: 'two', kind: 'dir' }, { name: 'x.txt', kind: 'file' }],
        [dirA]: [{ name: '1.json', kind: 'file' }],
        [dirB]: [{ name: '2.json', kind: 'file' }],
      },
      files: {
        [`${dirA}/1.json`]: JSON.stringify({ sessionId: ID_B, name: 'beta-sec', status: 'busy', statusUpdatedAt: NOW }),
        [`${dirB}/2.json`]: JSON.stringify({ sessionId: '33333333-3333-4333-8333-333333333333', name: 'gamma-sec', status: 'idle', statusUpdatedAt: NOW - 60_000 }),
      },
      stats: { [`${dirA}/1.json`]: { kind: 'file', mtimeMs: 1 }, [`${dirB}/2.json`]: { kind: 'file', mtimeMs: 1 } },
    },
  })
  millionSession(on)
  await start($)
  const rows = stewardRows(await frame($))
  expect(rows[1]).toMatch(/beta-sec\s+busy 0m$/)
  expect(rows[2]).toMatch(/gamma-sec\s+idle 1m$/)
})

test('the 15 s tick runs only while the steward section shows and the pane is open; it stats the peers\' files and reads no file', async ($, on) => {
  const calls: Record<string, number> = {}
  const peers = [
    { name: 'beta-sec', status: 'busy', sessionId: ID_B, since: NOW },
    { name: 'gamma-sec', status: 'idle', sessionId: '33333333-3333-4333-8333-333333333333', since: NOW },
  ]
  const registry3 = REGISTRY.replace('(session 33333333', 'and delta-sec (session 66666666-6666-4666-8666-666666666666) and gamma-sec (session 33333333').replace('beta-sec (session', 'beta-sec (session')
  const { clock } = world(on, { steward: { registry: registry3, sessionId: ID_A, peers: [...peers, { name: 'delta-sec', status: 'idle', sessionId: '66666666-6666-4666-8666-666666666666', since: NOW }] }, extra: { calls, panesOpen: true } })
  millionSession(on)
  await start($)
  const statsBefore = calls['fs.stat']!, readsBefore = calls['fs.read']!
  await clock.advance(15_000)
  // three peers: three stats, no reads (mtimes unchanged)
  expect(calls['fs.stat']! - statsBefore).toBe(3)
  expect(calls['fs.read']).toBe(readsBefore)
})

test('no 15 s tick without a steward section', async ($, on) => {
  const calls: Record<string, number> = {}
  const { clock } = world(on, { extra: { calls, panesOpen: true } })
  millionSession(on)
  await start($)
  const statsBefore = calls['fs.stat'] ?? 0
  await clock.advance(15_000)
  expect(calls['fs.stat'] ?? 0).toBe(statsBefore)
})

// ---------------------------------------------------------------- icon

const ICON = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='

test('icon: the small render copy read once across renders, alt a glyph within its columns, header beside it', async ($, on) => {
  const calls: Record<string, number> = {}
  world(on, { branch: 'main', extra: { calls, icon: ICON } })
  millionSession(on)
  await start($)
  for (let k = 0; k < 5; k++) {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const img = await ui.find({ type: 'Image' })
    expect(img?.props.alt).toBe('◫')
    expect(Array.from(String(img?.props.alt)).length).toBeLessThanOrEqual(img?.props.columns as number)
    expect(img?.props.columns).toBe(4)
    expect(img?.props.rows).toBe(2)
    const head = await ui.find({ key: 'pane-head' })
    const lines = decode(head!.props).lines
    expect(lines[0]!.trim()).toBe('')
    expect(lines[1]).toMatch(/^Opus 5\.5 \(1M\)/)
    expect(lines[2]!.trimEnd()).toBe('/work/sample-repo')
    await ui.unmount()
  }
  expect(calls.icon).toBe(1)
  expect(calls.listingIcon ?? 0).toBe(0)
})

test('icon: showIcon off draws none and reads nothing', { options: { showIcon: false } }, async ($, on) => {
  const calls: Record<string, number> = {}
  world(on, { extra: { calls, icon: ICON } })
  millionSession(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.unmount()
  expect(calls.icon ?? 0).toBe(0)
})

test('icon: the header beside it fits at widths 30 to 60', () => {
  const v = base({ cwd: '/u/tester/work/projects/clients/sample-repo', home: '/u/tester' })
  for (let W = 30; W <= 60; W++) {
    const rows = layoutAt(v, W, 200, true).rows
    for (const r of rows.slice(0, 2)) expect(Array.from(txt(r)).length, `width ${W}`).toBeLessThanOrEqual(W - 5)
    expect(txt(rows[0]!)).toMatch(/^Opus 5\.5 \(1M\)/)
    expect(txt(rows[1]!)).toMatch(/sample-repo$/)
  }
})

// ---------------------------------------------------------------- margins

test('margins: 1 blank row top and bottom, 2 blank columns each side, at 48 and narrow', async ($, on) => {
  world(on, { branch: 'main' })
  millionSession(on)
  await start($)
  for (const [cols, rows] of [[48, 47], [30, 20], [20, 10]] as const) {
    const f = await rawAt($, cols, rows)
    expect(f.w, `width ${cols}`).toBe(cols + 4)
    expect(f.lines.length, `height ${cols}`).toBeLessThanOrEqual(rows)
    expect(f.lines[0]!.trim(), 'top').toBe('')
    expect(f.lines[f.lines.length - 1]!.trim(), 'bottom').toBe('')
    for (const l of f.lines) {
      const a = Array.from(l)
      expect(a.slice(0, 2).join('') + a.slice(-2).join(''), `sides ${cols}`).toBe('    ')
    }
    expect(f.lines.slice(1, -1).some(l => l.trim() !== '')).toBe(true)
  }
})

test('content height plus the two margin rows never exceeds the rows', async ($, on) => {
  const transcript: Transcript = { main: Array.from({ length: 30 }, (_, i) => said({ tool: 'Read', input: { file_path: `/data/f${i}/x.txt` } })) }
  world(on, { branch: 'main', extra: { transcript } })
  millionSession(on)
  await start($)
  await complete($)
  await run($, '')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: FOLDERS_KEY })
  await ui.unmount()
  for (const rows of [6, 10, 15, 25, 47]) {
    const f = await rawAt($, 48, rows)
    expect(f.lines.length, `rows ${rows}`).toBeLessThanOrEqual(rows)
  }
})

// ---------------------------------------------------------------- commands and surfaces

test('off closes the pane and keeps it closed at the next start', async ($, on) => {
  const { opened, closed } = world(on)
  await start($)
  expect(opened).toEqual(['stackwell'])
  const out = await run($, 'off')
  expect(out.text).toContain('off')
  expect(closed).toEqual(['stackwell'])
  await start($)
  expect(opened).toEqual(['stackwell'])
  await run($, 'on')
  expect(opened).toEqual(['stackwell', 'stackwell'])
})

test('theme picks a preset', async ($, on) => {
  world(on)
  const out = await run($, 'theme latte')
  expect(out.text).toContain('latte')
  await measure($, 95)
  const f = await frame($)
  const y = row(f, /^[━─┊]+$/)
  expect(f.fg(0, y)).toBe(0xd20f39) // latte crit
  const bad = await run($, 'theme neon')
  expect(bad.text).toContain('Themes:')
})

test('other surfaces get rows of text', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /waiting for first turn/ }))?.text).toContain('waiting')
  await ui.unmount()
})

// ---------------------------------------------------------------- contrast

// WCAG 2 relative luminance, written apart from the implementation.
function lum(c: number): number {
  const ch = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch((c >> 16) & 255) + 0.7152 * ch((c >> 8) & 255) + 0.0722 * ch(c & 255)
}
function ratio(a: number, b: number): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

const AUTO_ODD = [
  '# >>> PALETTE',
  'CTX_OK=200,190,170',
  'CTX_WARN=230,160,60',
  'CTX_CRIT=230,70,70',
  'TEXT_FG=40,34,30',
  '# <<< PALETTE',
].join('\n')

test('every theme meets the contrast floors', () => {
  const themes: [string, StackwellPalette][] = Object.entries(PRESETS)
  const auto = parsePalette(AUTO_ODD)
  expect(auto).toBeDefined()
  expect(auto!.bg).toBe(0x28221e)
  themes.push(['auto(odd bg)', auto!])
  for (const [name, p] of themes) {
    expect(ratio(p.text, p.bg), `${name} text`).toBeGreaterThanOrEqual(4.5)
    for (const k of ['context', 'quota', 'session', 'agents', 'git', 'steward', 'hatch'] as const)
      expect(ratio(p[k], p.bg), `${name} ${k}`).toBeGreaterThanOrEqual(4.5)
    expect(p.steps.length, `${name} steps`).toBe(4)
    expect(p.steps[0], `${name} steps[0]`).toBe(p.context)
    expect(ratio(p.steps[3]!, p.bg), `${name} darkest step`).toBeGreaterThanOrEqual(3)
    expect(ratio(p.dim, p.bg), `${name} dim`).toBeGreaterThanOrEqual(3)
    expect(ratio(p.steps[1]!, p.bg), `${name} trend step`).toBeGreaterThanOrEqual(3)
    expect(ratio(p.sessionStep, p.bg), `${name} session step`).toBeGreaterThanOrEqual(3)
    expect(new Set([p.context, p.quota, p.session, p.agents, p.git, p.steward, p.hatch]).size, `${name} distinct hues`).toBe(7)
  }
})

// ---------------------------------------------------------------- agents reseeded at session.start

type ListedAgent = { id: string; description: string; type: string; status: string; startTime?: number; teammateId?: string; cwd?: string; model?: string; lastRequest?: unknown; effort?: string }
const listed = (a: ListedAgent) => ({ kind: 'local_agent', taskStatus: 'running', label: a.description, startTime: NOW, ...a })
/** The agent list the engine answers, live: a test adds rows and edits them. */
function agentList(on: On): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  on('agent.list', () => ({ value: rows as never }))
  return rows
}
const agentLines = async ($: Engine, name: string) => (await frame($)).lines.map(l => l.trimEnd()).filter(l => l.includes(name))

test('session.start reseeds a running agent from $.agent.list(), named by description else type', async ($, on) => {
  world(on)
  millionSession(on)
  on('agent.list', () => ({
    value: [
      listed({ id: 'ag-run', description: 'survey', type: 'general-purpose', status: 'running', startTime: NOW - 2 * 60_000 }),
      listed({ id: 'ag-wait', description: '', type: 'steward-delegation:coder', status: 'waiting' }),
    ] as never,
  }))
  await start($)
  expect((await agentLines($, 'survey'))[0]).toMatch(/ survey\s+2m$/)
  expect(await agentLines($, 'coder')).toHaveLength(1)
})

test('a reseed does not duplicate an agent already listed, nor add a completed one', async ($, on) => {
  world(on)
  millionSession(on)
  let isSpawned = false
  on('agent.list', () => ({
    value: [
      ...(isSpawned ? [listed({ id: 'ag-1', description: 'survey', type: 'general-purpose', status: 'running' })] : []),
      listed({ id: 'ag-done', description: 'finished-one', type: 'general-purpose', status: 'completed' }),
      listed({ id: 'ag-dead', description: 'killed-one', type: 'general-purpose', status: 'killed' }),
    ] as never,
  }))
  await start($)
  isSpawned = true
  await agentStart($, 'ag-1')
  await start($)
  expect(await agentLines($, 'survey')).toHaveLength(1)
  expect(await agentLines($, 'finished-one')).toHaveLength(0)
  expect(await agentLines($, 'killed-one')).toHaveLength(0)
})

test("a reseeded agent ends on its own turn.complete", async ($, on) => {
  world(on)
  millionSession(on)
  on('agent.list', () => ({ value: [listed({ id: 'ag-re', description: 'reseeded', type: 'general-purpose', status: 'running' })] as never }))
  await start($)
  expect((await agentLines($, 'reseeded'))[0]).toMatch(/ reseeded\s+0m$/)
  await agentEnd($, 'ag-re')
  expect((await agentLines($, 'reseeded'))[0]).toMatch(/✓ general-purpose  reseeded\s+0m$/)
})

test('$.agent.list() throwing leaves the pane working', async ($, on) => {
  world(on)
  millionSession(on)
  on('agent.list', () => {
    throw new Error('no agents for you')
  })
  await start($)
  const f = await frame($)
  expect(f.lines.some(l => l.startsWith('context'))).toBe(true)
  expect(f.lines.some(l => l.startsWith('agents'))).toBe(false)
})

// ---------------------------------------------------------------- agent kind and the steward badge

test('agent kind: the part after the last colon, the model-effort suffix and a repeated plugin name gone', () => {
  const table: [string, string, string | undefined][] = [
    ['steward-delegation:reviewer-opus-max', 'reviewer', 'steward-delegation'],
    ['steward-delegation:deep-reasoner-opus-xhigh', 'deep-reasoner', 'steward-delegation'],
    ['steward-delegation:coder-opus-medium', 'coder', 'steward-delegation'],
    ['steward-delegation:mechanic-haiku-medium', 'mechanic', 'steward-delegation'],
    ['Explore', 'Explore', undefined],
    ['general-purpose', 'general-purpose', undefined],
    ['helper', 'helper', undefined],
    ['hatch:hatch-safety-auditor', 'safety-auditor', 'hatch'],
    ['steward-orchestration:secondary', 'secondary', 'steward-orchestration'],
    ['plugin:worker-sonnet-low', 'worker', 'plugin'],
  ]
  for (const [type, kind, plugin] of table) {
    const k = agentsModule.agentKind(type)
    expect(k?.kind, type).toBe(kind)
    expect(k?.plugin, type).toBe(plugin)
  }
  expect(agentsModule.agentKind('')).toBeUndefined()
  expect(agentsModule.isStewardPlugin('steward-delegation')).toBe(true)
  expect(agentsModule.isStewardPlugin('steward-orchestration')).toBe(true)
  expect(agentsModule.isStewardPlugin('hatch')).toBe(false)
  expect(agentsModule.isStewardPlugin(undefined)).toBe(false)
})

test('agent rows: [badge] kind, description, model, age; the stw badge only for steward plugins', async ($, on) => {
  world(on)
  millionSession(on)
  const agents = agentList(on)
  await start($)
  agents.push(
    listed({ id: 'ag-1', description: 'Design icon', type: 'steward-delegation:reviewer-opus-max', status: 'running' }),
    listed({ id: 'ag-2', description: 'Audit diff', type: 'hatch:hatch-safety-auditor', status: 'running' }),
    listed({ id: 'ag-3', description: '', type: 'Explore', status: 'running' }),
  )
  await agentStart($, 'ag-1')
  for (const id of ['ag-1', 'ag-2', 'ag-3']) await agentEnd($, id)
  const all = (await frame($)).lines.map(l => l.trimEnd())
  // the profile name's model and effort (a fallback: max on Opus is xhigh)
  expect(all.find(l => l.includes('reviewer'))).toMatch(/✓ stw reviewer  Design …  opus xh\s+0m$/)
  expect(all.find(l => l.includes('safety-auditor'))).toMatch(/✓ safety-auditor  Audit diff\s+0m$/)
  expect(all.find(l => l.includes('safety-auditor'))).not.toContain('stw')
  // no description: the kind once, not twice
  expect(all.find(l => l.includes('Explore'))).toMatch(/✓ Explore\s+0m$/)
})

test('agent row: the description shortens first, then the model goes; kind and age stay', () => {
  const a: StackwellView['agents'][number] = {
    id: '1', name: 'Write the generator for every icon', kind: 'deep-reasoner', plugin: 'steward-delegation', model: 'opus',
    isBackground: false, status: 'running', startedAt: NOW - 2 * M,
  }
  const at = (W: number) => lines(base({ agents: [a] }), W).find(l => l.includes('deep-'))!
  expect(at(80)).toMatch(/^agents      stw deep-reasoner  Write the generator for every icon  opus\s+2m$/)
  expect(at(60)).toBe('agents      stw deep-reasoner  Write the generator…  opus 2m')
  for (let W = 30; W <= 80; W++) {
    const l = at(W)
    expect(Array.from(l).length, `width ${W}`).toBeLessThanOrEqual(W)
    expect(l, `width ${W}`).toMatch(/deep-reasoner/)
    expect(l, `width ${W}`).toMatch(/2m$/)
    if (l.includes('Write')) expect(l, `width ${W}`).toContain('opus')
  }
  expect(at(36)).not.toContain('Write')
})

test('a reseeded agent gets its kind and the steward badge from its type', async ($, on) => {
  world(on)
  millionSession(on)
  on('agent.list', () => ({
    value: [
      listed({ id: 'ag-a', description: 'survey', type: 'steward-delegation:researcher-sonnet-low', status: 'running' }),
      listed({ id: 'ag-b', description: '', type: 'general-purpose', status: 'running' }),
    ] as never,
  }))
  await start($)
  expect((await agentLines($, 'survey'))[0]).toMatch(/stw researcher  survey  sonnet l\s+0m$/)
  expect(await agentLines($, 'general-purpose')).toHaveLength(1)
})

// ---------------------------------------------------------------- section icons

/** Every Image in the terminal pane at `cols` content columns. */
async function images($: Engine, cols = 48) {
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: cols + 5 }, surface: 'terminal' })
  const imgs = await ui.findAll({ type: 'Image' })
  const rasters = await ui.findAll({ type: 'Raster' })
  const rows = hoverRows(await ui.drawn())
  await ui.unmount()
  return { imgs, rasters: rasters.map(r => decode(r.props)), rows }
}

/** The rows drawn as Text runs in a hover scope (rows with a card), each run joined, by scope. */
function hoverRows(tree: unknown): string[] {
  const by = new Map<string, string>()
  for (const el of allOf(tree)) {
    const h = hoverOf(el)
    if (el.type !== 'Text' || typeof h?.scope !== 'string' || h.backgroundColor === undefined) continue
    by.set(h.scope, (by.get(h.scope) ?? '') + textOf(el))
  }
  return [...by.values()]
}

/** A session with every section on show. */
async function fullSession($: Engine, on: On, extra: Extra = {}, opts: { appTheme?: string } = {}) {
  world(on, { branch: 'main', steward: { registry: REGISTRY, sessionId: ID_A }, extra: { sections: true, appTheme: opts.appTheme, ...extra } })
  millionSession(on)
  const agents = agentList(on)
  await start($)
  agents.push(listed({ id: 'ag-icon', description: 'Design icon', type: 'steward-delegation:reviewer-opus-max', status: 'running' }))
  await agentStart($, 'ag-icon')
  await agentEnd($, 'ag-icon')
  await complete($)
  return agents
}

const SECTIONS = ['context', 'quota', 'steward', 'folders', 'agents', 'session']

test('section icons: an Image per section, alt the old word, the dark set on a dark theme', async ($, on) => {
  await fullSession($, on)
  const { imgs, rasters, rows } = await images($)
  const sec = imgs.filter(i => String(i.key ?? '').startsWith('icon-'))
  const byName = (n: string) => sec.filter(i => String(i.key).startsWith(`icon-${n}-`))
  for (const n of SECTIONS) {
    expect(byName(n).length, n).toBe(1)
    const img = byName(n)[0]!
    expect(img.props.alt, n).toBe(ALT[n])
    expect(img.props.columns, n).toBe(2)
    expect(img.props.rows, n).toBe(1)
    expect((img.props.source as { png: string }).png, n).toBe(DARK_PNG)
  }
  // the steward badge on the agent row: the same picture, the steward glyph as alt
  const badge = sec.filter(i => String(i.key).startsWith('icon-badge-'))
  expect(badge.length).toBe(1)
  expect(badge[0]!.props.alt).toBe(ALT.steward)
  expect((badge[0]!.props.source as { png: string }).png).toBe(DARK_PNG)
  // the words are gone from the text: the label column went to the content
  const text = rasters.flatMap(r => r.lines).join('\n')
  for (const w of ['context  ', 'quota 7d', 'session ', 'agents ', 'folders', 'steward ']) expect(text, w).not.toContain(w)
  expect(text).toContain('7d')
  // the agent row has its card: Text runs in a hover scope
  expect(rows.join('\n')).toContain('reviewer')
})

test('section icons: the light set under a light app theme and under a light palette file', async ($, on) => {
  await fullSession($, on, {}, { appTheme: 'light' })
  const { imgs } = await images($)
  const sec = imgs.filter(i => String(i.key ?? '').startsWith('icon-'))
  expect(sec.length).toBeGreaterThan(0)
  for (const i of sec) expect((i.props.source as { png: string }).png).toBe(LIGHT_PNG)
})

const LIGHT_FILE = ['# >>> PALETTE', 'CTX_OK=60,60,60', 'CTX_WARN=200,120,0', 'CTX_CRIT=200,0,0', 'TEXT_FG=245,245,240', '# <<< PALETTE'].join('\n')

test('section icons: a palette file picks the set by its background', { options: { paletteFile: '/etc/palette.sh' } }, async ($, on) => {
  await fullSession($, on, { files: { '/etc/palette.sh': LIGHT_FILE } })
  const { imgs } = await images($)
  const sec = imgs.filter(i => String(i.key ?? '').startsWith('icon-'))
  expect(sec.length).toBeGreaterThan(0)
  for (const i of sec) expect((i.props.source as { png: string }).png).toBe(LIGHT_PNG)
})

/** Each section's alt: one single-width glyph and a space, East Asian Width N, no emoji. */
const ALT: Record<string, string> = {
  context: '◔ ', quota: '◷ ', session: '≣ ', agents: '◉ ', folders: '▭ ', steward: '⚷ ', hatch: '◒ ',
}

test('section icons: every alt is at most 2 cells, a glyph and no word, at any width', async ($, on) => {
  await fullSession($, on)
  for (const cols of [40, 48]) {
    const { imgs } = await images($, cols)
    const sec = imgs.filter(i => String(i.key ?? '').startsWith('icon-'))
    expect(sec.length).toBeGreaterThan(0)
    for (const i of sec) {
      const alt = String(i.props.alt)
      expect(Array.from(alt).length, alt).toBeLessThanOrEqual(2)
      expect(alt, alt).not.toMatch(/[a-z]/i)
      expect(/\p{Extended_Pictographic}/u.test(alt), alt).toBe(false)
    }
  }
  expect(Object.keys(ALT).sort()).toEqual([...drawModule.SECTIONS].sort())
  for (const a of Object.values(ALT)) expect(Array.from(a).length).toBe(2)
})

test('section icons: read once per session start, never on render', async ($, on) => {
  const calls: Record<string, number> = {}
  await fullSession($, on, { calls })
  expect(calls.section).toBe(14)
  for (let k = 0; k < 4; k++) await images($)
  expect(calls.section).toBe(14)
  await start($)
  expect(calls.section).toBe(28)
})

test('section icons: showIcon off gives the words and reads nothing', { options: { showIcon: false } }, async ($, on) => {
  const calls: Record<string, number> = {}
  await fullSession($, on, { calls })
  const { imgs } = await images($)
  expect(imgs).toHaveLength(0)
  expect(calls.section ?? 0).toBe(0)
  const all = (await frame($)).lines.map(l => l.trimEnd())
  expect(all.some(l => l.startsWith('context'))).toBe(true)
  expect(all.some(l => l.startsWith('agents      ✓ stw reviewer'))).toBe(true)
})

test('section icons: none on a surface without Image; the words instead', async ($, on) => {
  await fullSession($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^\s*context/ })).toBeDefined()
  await ui.unmount()
})

test('section icons: rows of a section after the first keep a 3-column indent', async ($, on) => {
  const agents = await fullSession($, on)
  agents.push(listed({ id: 'ag-2nd', description: 'Second one', type: 'general-purpose', status: 'running' }))
  await agentStart($, 'ag-2nd')
  await agentEnd($, 'ag-2nd')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = hoverRows(await ui.drawn())
  await ui.unmount()
  const second = rows.find(l => l.includes('Second one'))!
  // margin 2, indent 3: the kind's mark at column 5
  expect(second).toMatch(/^ {5}✓ general-purpose  Second one/)
})

test('section icons: every row fits the width with its icons at widths 30 to 60', () => {
  const v = base({
    costUsd: 5, startedAt: NOW - H, turns: 2, lastTurnMs: 1000, trend: [100_000, 131_000],
    quotas: [{ kind: 'five_hour', pct: 10, resetsAt: NOW + H }, { kind: 'seven_day', pct: 20, resetsAt: NOW + 24 * H }],
    folders: [folder({ name: 'cwd-repo', isCwd: true, branch: 'main' }), folder({ name: 'other', branch: 'dev' })],
    agents: [{ id: '1', name: 'A long description here', kind: 'deep-reasoner', plugin: 'steward-delegation', model: 'opus', isBackground: false, status: 'running', startedAt: NOW - M }],
    steward: { role: 'primary', initiative: 'widget-release', peers: [{ name: 'docs', role: 'secondary', status: 'busy', since: NOW - M }] },
    binders: [{ slug: 'packs', total: 7, isRunning: true, merged: 4, wave: 2, waves: 3, building: ['a'], halted: [] }],
  })
  for (let W = 30; W <= 60; W++) {
    const rows = layoutAt(v, W, 200, true, true).rows
    const names = rows.flatMap(r => r.filter(s => s.icon).map(s => s.icon))
    for (const n of ['context', 'quota', 'steward', 'hatch', 'folders', 'agents', 'session']) expect(names, `${n} at ${W}`).toContain(n)
    for (const r of rows) expect(Array.from(txt(r)).length, `width ${W}: ${txt(r)}`).toBeLessThanOrEqual(W)
    for (const r of rows) for (const s of r) if (s.icon) expect(s.text, `icon cells at ${W}`).toBe('  ')
  }
})

// ---------------------------------------------------------------- the folders toggle

/** Six plain folders a turn's Read uses named, after the session folder. */
async function sixFolders($: Engine, on: On, extra: Extra = {}) {
  const transcript: Transcript = { main: [] }
  world(on, { branch: 'main', extra: { transcript, ...extra } })
  millionSession(on)
  await start($)
  for (let i = 1; i <= 6; i++) transcript.main.push(said({ tool: 'Read', input: { file_path: `/data/f${i}/x.txt` } }))
  await complete($)
}
const FOLDERS_KEY = 'stackwell-folders'
const folderRows = (f: Frame) => f.lines.filter(l => /^ {2}[●⎇ ] \S/.test(l) && !/\+\d+ more$|show less$/.test(l.trim())).length

test('folders toggle: +N more opens all, show less closes; it keeps working click after click', async ($, on) => {
  await sixFolders($, on)
  let f = await frame($)
  expect(folderRows(f)).toBe(4)
  expect(f.lines.some(l => l.trim() === '+3 more')).toBe(true)
  for (let k = 1; k <= 5; k++) {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: FOLDERS_KEY })
    await ui.unmount()
    f = await frame($)
    const isOpen = k % 2 === 1
    expect(folderRows(f), `click ${k}`).toBe(isOpen ? 7 : 4)
    expect(f.lines.some(l => l.trim() === (isOpen ? 'show less' : '+3 more')), `click ${k}`).toBe(true)
    expect(f.lines.some(l => /tools/.test(l) && !/▪ tools/.test(l))).toBe(false)
  }
})

test('folders toggle: the open choice survives a redraw and a reload', async ($, on) => {
  await sixFolders($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: FOLDERS_KEY })
  await ui.unmount()
  expect(folderRows(await frame($))).toBe(7)
  expect(folderRows(await frame($))).toBe(7)
  await start($)
  expect(folderRows(await frame($))).toBe(7)
})

// ---------------------------------------------------------------- robust to older stored views

// The kit gives a test no way to write $.state, so the older views go through the same settling
// render applies (settleView), then through drawParts on every path render takes.
test('render paths never throw on a stored view missing lists and the new fields', () => {
  const older = [
    {},
    { profile: 'default', percent: 10, tokens: 1000, now: NOW, theme: 'auto', palette: P },
    {
      percent: 10, tokens: 1000, now: NOW, palette: P, toolCounts: { Bash: 2 }, isToolsOpen: true, log: null, binders: undefined,
      agents: [{ id: 'a', isBackground: false, status: 'running', startedAt: NOW }, { id: 'b', name: 'old-agent', isBackground: false, status: 'running', startedAt: NOW }],
      folders: [{ key: '/w/x', isRepo: false, isWorktree: false, isCwd: true, lastAt: NOW }],
      steward: { role: 'primary', initiative: 'w', peers: [] },
    },
  ]
  for (const raw of older) {
    const v = drawModule.settleView(raw as never)
    for (const cols of [48, 30, 16, 6])
      for (const hasIcon of [false, true])
        for (const I of [false, true]) {
          const parts = drawModule.drawParts(v, cols, 40, hasIcon, I)
          expect(parts.pieces.length, `${cols} ${hasIcon} ${I}`).toBeGreaterThan(0)
          for (const p of parts.pieces) if ('screen' in p) expect(() => p.screen.lines()).not.toThrow()
        }
  }
  expect(layout(drawModule.settleView(older[2] as never), 48).map(txt).join('\n')).toContain('old-agent')
})

test('a fresh view renders on every surface and width, icons on and off', async ($, on) => {
  world(on, { extra: { sections: true, icon: ICON } })
  await start($)
  for (const surface of ['terminal', 'desktop'] as const)
    for (const cols of [48, 20]) {
      const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: cols + 5 }, surface })
      expect(await ui.drawn(), `${surface} ${cols}`).toBeDefined()
      await ui.unmount()
    }
})

test('a fresh view renders with icons off', { options: { showIcon: false } }, async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 25 }, surface: 'terminal' })
  expect(await ui.drawn()).toBeDefined()
  await ui.unmount()
})

test('a folder without a name and an agent with neither kind nor name draw without throwing', () => {
  const v = base({
    folders: [{ key: '/w/nameless', isRepo: false, isWorktree: false, isCwd: true, lastAt: NOW } as never],
    agents: [{ id: 'x', isBackground: false, status: 'running', startedAt: NOW } as never],
  })
  for (const W of [48, 30]) for (const I of [false, true]) expect(() => layout(v, W, 200, false, I)).not.toThrow()
  expect(lines(v).some(l => /● nameless/.test(l))).toBe(true)
})

test('after a shape change empties the view, session.start still shows a running agent', async ($, on) => {
  // a fresh engine is the view a new shape tag leaves: nothing stored
  world(on)
  millionSession(on)
  on('agent.list', () => ({ value: [listed({ id: 'ag-k', description: 'kept', type: 'Explore', status: 'running', startTime: NOW - 3 * M })] as never }))
  await start($)
  expect((await agentLines($, 'kept'))[0]).toMatch(/Explore  kept\s+3m$/)
})

// ---------------------------------------------------------------- peers: id first, newest, alive

test('peers: name only when the party has no session id; the newest file of a session id wins; a dead pid is offline', async ($, on) => {
  const dir = '/u/tester/.claude/sessions'
  const files = {
    // an older and a newer file for beta's session (a resume)
    [`${dir}/1.json`]: JSON.stringify({ sessionId: ID_B, name: 'beta-sec', status: 'busy', statusUpdatedAt: NOW - 30 * M }),
    [`${dir}/2.json`]: JSON.stringify({ sessionId: ID_B, name: 'beta-sec', status: 'idle', statusUpdatedAt: NOW - 2 * M }),
    // a file named like gamma but of another session: gamma has an id, so no name match
    [`${dir}/3.json`]: JSON.stringify({ sessionId: '77777777-7777-4777-8777-777777777777', name: 'gamma-sec', status: 'busy', statusUpdatedAt: NOW }),
  }
  world(on, {
    steward: { registry: REGISTRY, sessionId: ID_A },
    extra: {
      dirs: { [dir]: Object.keys(files).map(p => ({ name: p.split('/').pop()!, kind: 'file' as const })) },
      files,
      stats: Object.fromEntries(Object.keys(files).map((p, i) => [p, { kind: 'file' as const, mtimeMs: i + 1 }])),
    },
  })
  millionSession(on)
  await start($)
  const rows = stewardRows(await frame($))
  expect(rows[1]).toMatch(/beta-sec\s+idle 2m$/)
  expect(rows[2]).toMatch(/gamma-sec\s+offline$/)
})

test('peers: a session file whose pid is not alive reads offline; probed only when the file changes', async ($, on) => {
  const dir = '/u/tester/.claude/sessions'
  const calls: Record<string, number> = {}
  world(on, {
    steward: { registry: REGISTRY, sessionId: ID_A },
    extra: {
      calls,
      dirs: { [dir]: [{ name: '1.json', kind: 'file' }] },
      files: { [`${dir}/1.json`]: JSON.stringify({ sessionId: ID_B, name: 'beta-sec', status: 'busy', pid: 4242, statusUpdatedAt: NOW }) },
      stats: { [`${dir}/1.json`]: { kind: 'file', mtimeMs: 1 } },
    },
  })
  millionSession(on)
  await start($)
  // the mock's process.run answers exit 1 here: kill -0 found no such process
  expect(stewardRows(await frame($))[1]).toMatch(/beta-sec\s+offline$/)
  const runs = calls['process.run'] ?? 0
  await complete($)
  await complete($)
  expect(calls['process.run'] ?? 0).toBe(runs)
})

// ---------------------------------------------------------------- folders: lost updates, detect retries

test('a folder an agent\'s end adds while the main turn end reads git is kept', async ($, on) => {
  let isSlow = false
  let release: () => void = () => {}
  let reached: () => void = () => {}
  const held = new Promise<void>(r => { release = r })
  const isReached = new Promise<void>(r => { reached = r })
  const statusGate = () => {
    if (!isSlow) return Promise.resolve()
    reached()
    return held
  }
  const transcript: Transcript = { main: [], agents: { 'ag-late': [said({ tool: 'Read', input: { file_path: '/data/late/x.txt' } })] } }
  world(on, { git: { changes: 1 }, extra: { statusGate, transcript } })
  millionSession(on)
  agentList(on).push(listed({ id: 'ag-late', description: 'late', type: 'Explore', status: 'running' }))
  await start($)
  isSlow = true
  const ending = complete($)
  // the turn end now waits in its git reads; an agent ends meanwhile
  await isReached
  await agentEnd($, 'ag-late')
  release()
  await ending
  await idle()
  expect((await frame($)).lines.some(l => l.includes('/data/late'))).toBe(true)
})

test('a failed detect is tried again after 5 minutes, not before', async ($, on) => {
  const calls: Record<string, number> = {}
  const transcript: Transcript = { main: [] }
  const { clock } = world(on, { extra: { calls, panesOpen: true, transcript } })
  millionSession(on)
  const turn = async (file: string) => {
    transcript.main.push(said({ tool: 'Read', input: { file_path: file } }))
    await complete($)
  }
  await start($)
  await turn('/data/plain/x.txt')
  const first = calls['stat:/data/plain/.git'] ?? 0
  expect(first).toBe(1)
  await turn('/data/plain/y.txt')
  expect(calls['stat:/data/plain/.git']).toBe(1)
  await clock.advance(6 * M)
  await turn('/data/plain/z.txt')
  expect(calls['stat:/data/plain/.git']).toBe(2)
})

test('a folder first seen as plain becomes a repo row once a retried detect finds it', async ($, on) => {
  const repos: Repo[] = []
  const transcript: Transcript = { main: [] }
  const { clock } = world(on, { extra: { repos, panesOpen: true, transcript } })
  millionSession(on)
  await start($)
  transcript.main.push(said({ tool: 'Read', input: { file_path: '/data/later/x.txt' } }))
  await complete($)
  expect((await frame($)).lines.find(l => l.includes('/data/later'))).not.toMatch(/feature/)
  repos.push({ root: '/data/later', branch: 'feature', changes: 0 })
  await clock.advance(6 * M)
  transcript.main.push(said({ tool: 'Read', input: { file_path: '/data/later/y.txt' } }))
  await complete($)
  // outside the cwd's repo: the branch from its HEAD file, no change counts
  expect((await frame($)).lines.find(l => l.includes('/data/later'))).toMatch(/\/data\/later\s+feature\s+—/)
})

test('the pid probe runs only for a matched peer file, once per change', async ($, on) => {
  const dir = '/u/tester/.claude/sessions'
  const calls: Record<string, number> = {}
  const other = '88888888-8888-4888-8888-888888888888'
  world(on, {
    steward: { registry: REGISTRY, sessionId: ID_A },
    extra: {
      calls,
      dirs: { [dir]: [{ name: '1.json', kind: 'file' }, { name: '2.json', kind: 'file' }, { name: '3.json', kind: 'file' }] },
      files: {
        [`${dir}/1.json`]: JSON.stringify({ sessionId: ID_B, name: 'beta-sec', status: 'busy', pid: 4242, statusUpdatedAt: NOW }),
        [`${dir}/2.json`]: JSON.stringify({ sessionId: other, name: 'stranger', status: 'busy', pid: 5151, statusUpdatedAt: NOW }),
        [`${dir}/3.json`]: JSON.stringify({ sessionId: other, name: 'stranger-2', status: 'idle', pid: 6161, statusUpdatedAt: NOW }),
      },
      stats: { [`${dir}/1.json`]: { kind: 'file', mtimeMs: 1 }, [`${dir}/2.json`]: { kind: 'file', mtimeMs: 1 }, [`${dir}/3.json`]: { kind: 'file', mtimeMs: 1 } },
    },
  })
  millionSession(on)
  await start($)
  expect(calls['process.run'] ?? 0).toBe(1)
  await complete($)
  expect(calls['process.run'] ?? 0).toBe(1)
})

// ---------------------------------------------------------------- touched folders: noise left out

test('touched folders leave out system and device paths, cd -, and relative paths without a cwd', () => {
  const t = (tool: string, input: Record<string, unknown>, cwd = '/w/here') => touchedFolders(tool, input, cwd, '/u/tester')
  expect(t('Bash', { command: 'ls /dev/null /proc/1 /sys/x /usr/lib /bin/sh /sbin/x /etc/hosts' })).toEqual([])
  expect(t('Read', { file_path: '/tmp/x/a.txt' })).toEqual([])
  expect(t('Read', { file_path: '/tmp/x/a.txt' }, '/tmp/x')).toEqual(['/tmp/x'])
  expect(t('Bash', { command: 'cd - && ls' })).toEqual([])
  expect(t('Read', { file_path: 'rel/a.txt' }, '')).toEqual([])
  expect(t('Read', { file_path: '/w/a/b.txt' })).toEqual(['/w/a'])
})

test('sessionDirs: a relative pattern is under the config folder', { options: { sessionDirs: ['sessions'] } }, async ($, on) => {
  const dir = '/u/tester/.claude/sessions'
  world(on, {
    steward: { registry: REGISTRY, sessionId: ID_A },
    extra: {
      dirs: { [dir]: [{ name: '1.json', kind: 'file' }] },
      files: { [`${dir}/1.json`]: JSON.stringify({ sessionId: ID_B, name: 'beta-sec', status: 'busy', statusUpdatedAt: NOW }) },
      stats: { [`${dir}/1.json`]: { kind: 'file', mtimeMs: 1 } },
    },
  })
  millionSession(on)
  await start($)
  expect(stewardRows(await frame($))[1]).toMatch(/beta-sec\s+busy 0m$/)
})

// ---------------------------------------------------------------- the hatch hue

/** CIE76 distance in OKLab, the same space the hues are set in. */
function oklabDist(a: number, b: number): number {
  const lab = (c: number) => {
    const lin = [(c >> 16) & 255, (c >> 8) & 255, c & 255].map(v => {
      const s = v / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2])
    const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2])
    const s2 = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2])
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s2, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s2, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s2]
  }
  const [x, y] = [lab(a), lab(b)]
  return Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!)
}

test('the hatch hue stays clear of crit and warn, in every theme', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    expect(oklabDist(p.hatch, p.crit), `${name} hatch/crit`).toBeGreaterThan(0.08)
    expect(oklabDist(p.hatch, p.warn), `${name} hatch/warn`).toBeGreaterThan(0.06)
  }
})

// ---------------------------------------------------------------- hover cards for cut text

const LONG_TASK = 'Survey every hover surface the pane draws and list the ones that cut text'
const longAgent = (o: Partial<StackwellView['agents'][number]> = {}): StackwellView['agents'][number] => ({
  id: 'a1', name: LONG_TASK, kind: 'general-purpose', model: 'claude-sonnet-5-5', isBackground: false, status: 'running', startedAt: NOW - M, ...o,
})
const cardOf = drawModule.cardOf
const fieldsOf = (r: LRow | undefined) => (r ? cardOf(r) ?? [] : [])

test('cards (pure): a cut agent row carries its full description and the dropped model; a whole row none', () => {
  const v = base({ agents: [longAgent(), longAgent({ id: 'a2', name: 'short', model: 'opus' })] })
  const rows = layout(v, 48, 200)
  const cutRow = rows.find(r => txt(r).includes('general-purpose') && !txt(r).includes('short'))!
  expect(cutRow).toBeDefined()
  expect(txt(cutRow)).not.toContain('Survey')
  const f = fieldsOf(cutRow)
  expect(f.find(x => x.label === 'task')?.text).toBe(LONG_TASK)
  expect(f.find(x => x.label === 'model')?.text).toBe('claude-sonnet-5-5')
  // an agent row shown whole still has its card
  const whole = rows.find(r => txt(r).includes('short'))!
  expect(fieldsOf(whole).find(x => x.label === 'task')?.text).toBe('short')
  // nothing cut anywhere: no row but the agent's has a card
  for (const r of layout(base({ agents: [longAgent({ name: 'tiny', model: 'opus' })] }), 48, 200))
    if (!txt(r).includes('tiny')) expect(cardOf(r), txt(r)).toBeUndefined()
})

test('cards (pure): folder path and branch, steward names, hatch items and slugs, header cwd', () => {
  const longBranch = 'feature/a-really-long-branch-name-that-cannot-fit'
  const v = base({
    cwd: '/home/u/src/a/very/deep/folder/structure/for/the/session/repo-name', home: '/home/u',
    folders: [
      folder({ name: 'repo-name', isCwd: true, branch: longBranch }),
      { ...folder({ name: 'other' }), key: '/srv/some/really/long/path/to/another/checkout/here' },
    ],
    steward: { role: 'primary', initiative: 'an-initiative-with-a-very-long-name-indeed-yes', peers: [{ name: 'secondary-session-with-a-very-long-name-here', role: 'secondary', status: 'busy', since: NOW - M }] },
    binders: [{ slug: 'a-binder-slug-that-is-much-too-long-for-the-row', total: 7, isRunning: true, merged: 4, wave: 2, waves: 3, building: ['item-one-long', 'item-two-long', 'item-three-long', 'item-four-long'], halted: [] }],
  })
  const rows = layout(v, 48, 200)
  const all = rows.flatMap(fieldsOf)
  const has = (label: string, text: string) => expect(all.some(x => x.label === label && x.text === text), `${label}: ${text}`).toBe(true)
  has('cwd', '/home/u/src/a/very/deep/folder/structure/for/the/session/repo-name')
  has('branch', longBranch)
  has('path', '/srv/some/really/long/path/to/another/checkout/here')
  has('initiative', 'an-initiative-with-a-very-long-name-indeed-yes')
  has('session', 'secondary-session-with-a-very-long-name-here')
  has('binder', 'a-binder-slug-that-is-much-too-long-for-the-row')
  has('building', 'item-one-long, item-two-long, item-three-long, item-four-long')
})

/** Every keyed Box in a drawn tree, and every key, in document order. */
function walk(node: unknown, out: { boxes: El[]; keys: string[] } = { boxes: [], keys: [] }) {
  const el = node as El & { key?: string }
  if (!el || typeof el !== 'object') return out
  const key = (el.props?.key ?? el.key) as string | undefined
  if (typeof key === 'string') out.keys.push(key)
  if (el.type === 'Box' && typeof key === 'string') out.boxes.push(el)
  for (const k of el.children ?? []) walk(k, out)
  return out
}
const textOf = (node: unknown): string => {
  if (typeof node === 'string') return node
  const el = node as El
  return (el?.children ?? []).map(textOf).join('')
}
const hoverOf = (el: unknown) => {
  const e = el as El & { hover?: Record<string, unknown> }
  return (e?.hover ?? e?.props?.hover) as Record<string, unknown> | undefined
}
/** A hidden placed card: an absolute Box drawn `display: "none"` that a hover reveals. */
const isCard = (k: unknown) => {
  const p = (k as El)?.props ?? {}
  return (k as El)?.type === 'Box' && p.position === 'absolute' && p.display === 'none' && hoverOf(k)?.display === 'flex'
}
/** Every element of a tree, in document order. */
const allOf = (node: unknown, out: El[] = []): El[] => {
  const el = node as El
  if (!el || typeof el !== 'object') return out
  out.push(el)
  for (const k of el.children ?? []) allOf(k, out)
  return out
}
/** The row `target` starts on, counted as `flatten` stacks the tree; undefined when absent. */
function yOf(node: unknown, target: unknown): number | undefined {
  if (node === target) return 0
  const el = node as El
  if (!el || typeof el !== 'object' || el.type !== 'Box' || el.props?.position === 'absolute') return undefined
  const kids = (el.children ?? []).filter(k => k !== null && k !== undefined && k !== false)
  const top = typeof el.props?.paddingTop === 'number' ? el.props.paddingTop : 0
  let y = top
  for (const k of kids) {
    const at = yOf(k, target)
    if (at !== undefined) return y + at
    if (el.props?.flexDirection !== 'row') y += flatten(k).length
  }
  return undefined
}
/** The root's cards, the rows that share each one's scope, and the root itself. */
function cardsOf(tree: unknown) {
  const root = tree as El
  const kids = (root.children ?? []).filter(k => k !== null && k !== undefined && k !== false) as El[]
  const cards = kids.filter(isCard)
  const scoped = allOf(root).filter(el => !isCard(el) && typeof hoverOf(el)?.scope === 'string')
  return { root, kids, cards, scoped }
}

/** A session with one agent of this description, and six folders: the folders toggle is a Button. */
async function cardSession($: Engine, on: On, desc = LONG_TASK) {
  const transcript: Transcript = { main: Array.from({ length: 6 }, (_, i) => said({ tool: 'Read', input: { file_path: `/data/f${i}/x.txt` } })) }
  const w = world(on, { branch: 'main', extra: { transcript } })
  millionSession(on)
  const agents = agentList(on)
  await start($)
  agents.push(listed({ id: 'ag-card', description: desc, type: 'general-purpose', status: 'running' }))
  await agentStart($, 'ag-card')
  await complete($)
  return { ...w, agents }
}

/** The documented hover shape: one scope per cut row, its card placed last in the root at the row's y. */
function expectCardTree(tree: unknown, surface: 'terminal' | 'desktop') {
  const { root, kids, cards, scoped } = cardsOf(tree)
  expect(cards.length).toBeGreaterThan(0)
  // every card comes after every row: the root's last children, painted over all rows
  const first = kids.findIndex(isCard)
  expect(kids.slice(first).every(isCard), 'cards are the root\'s last children').toBe(true)
  const scopes = cards.map(c => hoverOf(c)!.scope as string)
  expect(new Set(scopes).size).toBe(scopes.length)
  for (const s of scopes) {
    expect(s.length).toBeGreaterThan(0)
    expect(s.length).toBeLessThanOrEqual(64)
  }
  const buttonsY = allOf(root).filter(el => el.type === 'Button' && !String(el.props?.key ?? '').startsWith('stackwell-copy-')).map(b => yOf(root, b)!)
  for (const card of cards) {
    const scope = hoverOf(card)!.scope as string
    const members = scoped.filter(el => hoverOf(el)!.scope === scope)
    // the row's Box joins the group and holds no Raster: its cells are Text runs that take hover
    const rowBox = members.find(el => el.type === 'Box')
    expect(rowBox, `a row Box joins ${scope}`).toBeDefined()
    expect(allOf(rowBox).some(el => el.type === 'Raster'), 'a cut row is drawn as Text').toBe(false)
    // the visible highlight: a hover background on the row's own Text, not nested in a Text
    const texts = members.filter(el => el.type === 'Text')
    expect(texts.length).toBeGreaterThan(0)
    for (const t of texts) expect(typeof hoverOf(t)!.backgroundColor).toBe('string')
    expect(allOf(rowBox).filter(el => el.type === 'Text').every(t => hoverOf(t)?.scope === scope)).toBe(true)
    // placed against the root at the row's y: below it, or above it by its height
    const y = yOf(root, rowBox)!
    const h = (card.children ?? []).length + 2
    const top = card.props!.top as number
    expect(typeof top).toBe('number')
    if (surface === 'terminal') expect(top === y + 1 || top === y - h || top === 0 || top === flatten(rowBox).length + y, `card ${scope} top ${top} row ${y}`).toBe(true)
    // no card over a Button row
    for (const b of buttonsY) expect(b >= top && b < top + h, `card ${scope} over the Button on row ${b}`).toBe(false)
  }
  return cards
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`cards (${surface}): a cut row and its card share one hover scope; the card is last in the root; keys unique`, async ($, on) => {
    await cardSession($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    const tree = await ui.drawn()
    const { keys } = walk(tree)
    expect(new Set(keys).size, keys.join(' ')).toBe(keys.length)
    const cards = expectCardTree(tree, surface)
    const card = cards.find(c => (c.children ?? []).map(textOf).join(' ').replace(/\s+/g, ' ').includes(LONG_TASK))
    expect(card, 'a card holds the whole description').toBeDefined()
    expect(typeof card!.props!.backgroundColor).toBe('string')
    expect(typeof card!.props!.borderStyle).toBe('string')
    // the folders Button still presses
    expect(await ui.find({ key: FOLDERS_KEY })).toBeDefined()
    await ui.press({ key: FOLDERS_KEY })
    await ui.unmount()
    expect((await frame($)).lines.some(l => l.trim() === 'show less')).toBe(true)
  })
}

test('cards: no row cut, only the agent row\'s card and hover scope', async ($, on) => {
  await cardSession($, on, 'tiny')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const { cards, scoped } = cardsOf(await ui.drawn())
  await ui.unmount()
  expect(cards).toHaveLength(1)
  expect((cards[0]!.children ?? []).map(textOf).join(' ')).toMatch(/effort +unknown/)
  expect(new Set(scoped.map(el => hoverOf(el)!.scope)).size).toBe(1)
})

test('cards (pure): no card opens over a Button row, and cards near the bottom open upward', () => {
  const agents = Array.from({ length: 6 }, (_, i) => longAgent({ id: `a${i}`, startedAt: NOW - (i + 1) * M }))
  const folders = [folder({ name: 'cwd-repo', isCwd: true }), ...Array.from({ length: 5 }, (_, i) => folder({ name: `f${i}`, lastAt: NOW - i * M }))]
  const v = base({ agents, folders, costUsd: 1, startedAt: NOW - H, turns: 1 })
  for (const rowsH of [24, 30, 60]) {
    const parts = drawModule.drawParts(v, 53, rowsH)
    // pane rows of the Buttons and of every card's span
    let y = 0
    const buttons: number[] = []
    const spans: [number, number][] = []
    for (const p of parts.pieces) {
      if ('button' in p) { buttons.push(y); y += 1; continue }
      for (const c of p.screen.cards) {
        const at = y + c.y
        const h = c.lines.length + 2
        expect(c.top).toBe(c.isUp ? at - h : c.top === 0 ? 0 : at + 1)
        // a card too tall either way sits at the pane top over all of it, Buttons too
        if (c.top === 0 && !c.isUp) expect(h).toBeLessThanOrEqual(rowsH)
        else spans.push([c.top, c.top + h - 1])
        expect(c.at).toBe(at)
      }
      y += p.screen.h
    }
    expect(spans.length).toBeGreaterThan(0)
    expect(buttons.length).toBe(1)
    for (const [a, b] of spans) {
      for (const btn of buttons) expect(btn >= a && btn <= b, `rows ${rowsH}: card ${a}-${b} over button ${btn}`).toBe(false)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(rowsH)
    }
  }
})

test('cards with section icons: keys unique, the agent card holds the description', async ($, on) => {
  const agents = await fullSession($, on)
  agents.push(listed({ id: 'ag-long', description: LONG_TASK, type: 'general-purpose', status: 'running' }))
  await agentStart($, 'ag-long')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  const { keys } = walk(tree)
  await ui.unmount()
  expect(new Set(keys).size, keys.join(' ')).toBe(keys.length)
  const cards = expectCardTree(tree, 'terminal')
  expect(cards.some(c => (c.children ?? []).map(textOf).join(' ').replace(/\s+/g, ' ').includes(LONG_TASK))).toBe(true)
})

// ---------------------------------------------------------------- agent model and effort

test('profile suffix: every steward profile gives its model and effort; other types none', () => {
  const table: [string, string, string][] = [
    ['steward-delegation:coder-opus-medium', 'opus', 'medium'],
    ['steward-delegation:deep-reasoner-opus-xhigh', 'opus', 'xhigh'],
    ['steward-delegation:researcher-sonnet-low', 'sonnet', 'low'],
    ['steward-delegation:mechanic-haiku-medium', 'haiku', 'medium'],
    ['steward-delegation:reviewer-opus-max', 'opus', 'max'],
    ['steward-delegation:reviewer-sonnet-high', 'sonnet', 'high'],
    ['steward-delegation:writer-sonnet-medium', 'sonnet', 'medium'],
    ['steward.coder-opus-medium', 'opus', 'medium'],
  ]
  for (const [type, model, effort] of table) expect(agentsModule.profileOf(type), type).toEqual({ model, effort })
  for (const type of ['Explore', 'general-purpose', 'hatch:hatch-safety-auditor', '', undefined]) expect(agentsModule.profileOf(type), String(type)).toBeUndefined()
})

test('model and effort precedence: the engine, then the call, then the profile name', () => {
  const pick = agentsModule.pickModelEffort
  const suffix = agentsModule.profileOf('steward-delegation:reviewer-opus-max')
  const table: [Parameters<typeof pick>, { model?: string; effort?: string }][] = [
    [[{ model: 'claude-opus-5-5', effort: 'xhigh' }, { model: 'sonnet', effort: 'low' }, suffix], { model: 'claude-opus-5-5', effort: 'xhigh' }],
    [[undefined, { model: 'sonnet', effort: 'low' }, suffix], { model: 'sonnet', effort: 'low' }],
    [[undefined, undefined, suffix], { model: 'opus', effort: 'max' }],
    [[{ model: 'claude-opus-5-5' }, { effort: 'high' }, suffix], { model: 'claude-opus-5-5', effort: 'high' }],
    [[{ effort: 'xhigh' }, {}, suffix], { model: 'opus', effort: 'xhigh' }],
    [[{ model: '', effort: '' }, { model: 'haiku' }, undefined], { model: 'haiku' }],
    [[undefined, undefined, undefined], {}],
  ]
  for (const [args, want] of table) expect(pick(...args), JSON.stringify(args)).toEqual(want)
  expect(agentsModule.effortText('xhigh')).toBe('xhigh')
  expect(agentsModule.effortText(32000)).toBe('32000')
  expect(agentsModule.effortText('turbo')).toBeUndefined()
  expect(agentsModule.effortText(undefined)).toBeUndefined()
})

test('model short names and effort codes', () => {
  expect(drawModule.agentModel('claude-opus-5-5')).toBe('opus 5.5')
  expect(drawModule.agentModel('claude-sonnet-5-5[1m]')).toBe('sonnet 5.5')
  expect(drawModule.agentModel('claude-haiku-5-5-20261001')).toBe('haiku 5.5')
  expect(drawModule.agentModel('claude-fable-5-2')).toBe('fable 5.2')
  expect(drawModule.agentModel('opus')).toBe('opus')
  const codes: [string, string][] = [['low', 'l'], ['medium', 'm'], ['high', 'h'], ['xhigh', 'xh'], ['max', 'max'], ['32000', '32000']]
  for (const [e, c] of codes) expect(drawModule.effortCode(e), e).toBe(c)
})

const fullAgent = (o: Partial<StackwellView['agents'][number]> = {}): StackwellView['agents'][number] => ({
  id: 'm1', name: 'Write the icon generator', kind: 'coder', plugin: 'steward-delegation', model: 'claude-opus-5-5', effort: 'xhigh',
  isBackground: false, status: 'running', startedAt: NOW - 2 * M, ...o,
})

test('agent row: model short and the effort code; the description shortens first, then the effort goes, then the model', () => {
  const at = (W: number) => lines(base({ agents: [fullAgent()] }), W).find(l => l.includes('coder'))!
  expect(at(80)).toMatch(/^agents      stw coder  Write the icon generator  opus 5\.5 xh\s+2m$/)
  expect(at(48)).toBe('agents      stw coder  Write th…  opus 5.5 xh 2m')
  expect(at(30)).toBe('agt    stw coder  opus 5.5  2m')
  expect(at(26)).toBe('agt    stw coder' + '2m'.padStart(10))
  for (let W = 24; W <= 90; W++) {
    const l = at(W)
    expect(Array.from(l).length, `width ${W}`).toBeLessThanOrEqual(W)
    expect(l, `width ${W}`).toMatch(/coder/)
    expect(l, `width ${W}`).toMatch(/2m$/)
    if (l.includes(' xh')) expect(l, `width ${W}`).toContain('opus 5.5')
    if (l.includes('Write')) expect(l, `width ${W}`).toContain('opus 5.5 xh')
  }
})

test('agent card: always kind, plugin, model id, effort, task, started and status, even with nothing cut', () => {
  const rows = layout(base({ agents: [fullAgent({ name: 'Short' })] }), 80, 200)
  const r = rows.find(x => txt(x).includes('coder'))!
  expect(txt(r)).toContain('opus 5.5 xh')
  expect(fieldsOf(r).map(f => `${f.label}  ${f.text}`)).toEqual([
    'kind  coder', 'plugin  steward-delegation', 'model  claude-opus-5-5', 'effort  xhigh', 'task  Short', `started  ${hhmm(NOW - 2 * M)}`, 'status  running',
  ])
  // unknown model and effort, no plugin, finished in the background
  const bare = layout(base({ agents: [{ id: 'b', name: 'Explore', kind: 'Explore', isBackground: true, status: 'ok', startedAt: NOW - M, endedAt: NOW }] }), 48, 200)
  const b = bare.find(x => txt(x).includes('Explore'))!
  expect(fieldsOf(b).map(f => `${f.label}  ${f.text}`)).toEqual([
    'kind  Explore', 'plugin  none', 'model  unknown', 'effort  unknown', `started  ${hhmm(NOW - M)}`, 'status  done, background',
  ])
  // a stored view holding odd values still draws
  const odd = { ...fullAgent(), model: 5, effort: {} } as unknown as StackwellView['agents'][number]
  expect(() => layout(base({ agents: [odd] }), 48, 200)).not.toThrow()
  expect(() => drawModule.drawParts(base({ agents: [fullAgent(), fullAgent({ id: 'm2' })] }), 53)).not.toThrow()
  // a card taller than the room either way keeps inside the pane, its last line cut
  const tall = drawModule.drawParts(base({ agents: [fullAgent({ name: LONG_TASK.repeat(4) })] }), 53, 30)
  for (const p of tall.pieces) if ('screen' in p) for (const c of p.screen.cards) expect(c.lines.length).toBeLessThanOrEqual(28)
})

test('an agent takes its model and effort from the list when it first shows: they beat the profile suffix', async ($, on) => {
  world(on)
  millionSession(on)
  const agents = agentList(on)
  await start($)
  agents.push(listed({ id: 'ag-bg', description: 'survey', type: 'steward-delegation:researcher-sonnet-low', status: 'running', model: 'claude-opus-5-5', effort: 'xhigh' }))
  await agentStart($, 'ag-bg')
  // at 48 columns the description gives way to the model and effort
  expect(await agentLines($, 'researcher')).toHaveLength(1)
  expect((await agentLines($, 'researcher'))[0]).toMatch(/stw researcher  opus 5\.5 xh\s+0m$/)
})

test('a running agent\'s model and effort follow each list read while it runs, and stay at its end', async ($, on) => {
  world(on)
  millionSession(on)
  const agents = agentList(on)
  await start($)
  const row = listed({ id: 'ag-fg', description: 'fix', type: 'steward-delegation:coder-opus-medium', status: 'running' }) as Record<string, unknown>
  agents.push(row)
  await agentStart($, 'ag-fg')
  // the profile name only, until the engine says more
  expect((await agentLines($, 'fix'))[0]).toMatch(/stw coder  fix  opus m\s+0m$/)
  Object.assign(row, { model: 'claude-sonnet-5-5', lastRequest: { at: NOW, model: 'claude-sonnet-5-5', effort: 'high' } })
  await agentStart($, 'ag-fg')
  expect((await agentLines($, 'fix'))[0]).toMatch(/stw coder  fix  sonnet 5\.5 h\s+0m$/)
  await agentEnd($, 'ag-fg')
  expect((await agentLines($, 'fix'))[0]).toMatch(/✓ stw coder  fix  sonnet 5\.5 h\s+0m$/)
})

test('a reseeded agent takes the model and effort the list gives, else its profile suffix', async ($, on) => {
  world(on)
  millionSession(on)
  on('agent.list', () => ({
    value: [
      listed({ id: 'ag-s', description: 'suffix-only', type: 'steward-delegation:coder-opus-medium', status: 'running' }),
      listed({ id: 'ag-l', description: 'listed', type: 'steward-delegation:reviewer-opus-max', status: 'running', model: 'claude-opus-5-5', effort: 'max', lastRequest: { at: NOW, model: 'claude-opus-5-5', effort: 'xhigh' } } as never),
    ] as never,
  }))
  await start($)
  expect((await agentLines($, 'suffix-only'))[0]).toMatch(/stw coder  suffix-only  opus m\s+0m$/)
  // the effort a request carried beats the one set: Opus never runs at max
  expect((await agentLines($, 'listed'))[0]).toMatch(/stw reviewer  listed  opus 5\.5 xh\s+0m$/)
})

test('a running agent picks up the engine\'s model and effort at the main turn end', async ($, on) => {
  world(on)
  millionSession(on)
  const agents = agentList(on)
  await start($)
  const row = listed({ id: 'ag-t', description: 'later', type: 'steward-delegation:reviewer-opus-max', status: 'running' }) as Record<string, unknown>
  agents.push(row)
  await agentStart($, 'ag-t')
  // the profile name only, until the engine says more
  expect((await agentLines($, 'later'))[0]).toMatch(/later  opus xh\s+0m$/)
  Object.assign(row, { model: 'claude-opus-5-5', lastRequest: { at: NOW, model: 'claude-opus-5-5', effort: 'xhigh' } })
  await complete($)
  expect((await agentLines($, 'later'))[0]).toMatch(/later  opus 5\.5 xh\s+0m$/)
})

test('an agent that takes the session\'s effort gets it from its first request: at its next turn start, and at its end', async ($, on) => {
  world(on)
  millionSession(on)
  const agents = agentList(on)
  await start($)
  const row = listed({ id: 'ag-gp', description: 'probe', type: 'general-purpose', status: 'running', model: 'claude-opus-5-5' }) as Record<string, unknown>
  agents.push(row)
  await agentStart($, 'ag-gp')
  expect((await agentLines($, 'general-purpose'))[0]).toMatch(/general-purpose  probe  opus 5\.5\s+0m$/)
  // no effort set for it: the session's; its first request carries it
  row.lastRequest = { at: NOW, model: 'claude-opus-5-5', effort: 'high' }
  await agentStart($, 'ag-gp')
  expect((await agentLines($, 'general-purpose'))[0]).toMatch(/general-purpose  opus 5\.5 h\s+0m$/)
  // the end reads it once more
  row.lastRequest = { at: NOW, model: 'claude-opus-5-5', effort: 'xhigh' }
  await agentEnd($, 'ag-gp')
  expect(await agentLines($, 'general-purpose')).toHaveLength(1)
  expect((await agentLines($, 'general-purpose'))[0]).toMatch(/✓ general-purpose  opus 5\.5 xh\s+0m$/)
})

test('an agent ending on its own turn.complete reads its effort once more', async ($, on) => {
  world(on)
  millionSession(on)
  const agents = agentList(on)
  await start($)
  const row = listed({ id: 'ag-b2', description: 'bg', type: 'Explore', status: 'running', model: 'claude-haiku-5-5' }) as Record<string, unknown>
  agents.push(row)
  await agentStart($, 'ag-b2')
  row.lastRequest = { at: NOW, model: 'claude-haiku-5-5', effort: 'medium' }
  await agentEnd($, 'ag-b2')
  expect(await agentLines($, 'Explore')).toHaveLength(1)
  expect((await agentLines($, 'Explore'))[0]).toMatch(/✓ Explore  bg  haiku 5\.5 m\s+0m$/)
})

test('reviewer-opus-max before its first request: the profile\'s max on Opus shows as xh; a reported max stays max', async ($, on) => {
  world(on)
  millionSession(on)
  const agents = agentList(on)
  await start($)
  agents.push(listed({ id: 'ag-rv', description: 'rev', type: 'steward-delegation:reviewer-opus-max', status: 'running' }))
  await agentStart($, 'ag-rv')
  expect((await agentLines($, 'rev'))[0]).toMatch(/stw reviewer  rev  opus xh\s+0m$/)
  const rows = layout({ ...base(), agents: [{ id: 'x', name: 'rev', kind: 'reviewer', plugin: 'steward-delegation', model: 'opus', effort: agentsModule.suffixEffort('steward-delegation:reviewer-opus-max', 'opus'), isBackground: true, status: 'running', startedAt: NOW }] }, 48, 200)
  expect(fieldsOf(rows.find(r => txt(r).includes('reviewer'))).find(f => f.label === 'effort')?.text).toBe('xhigh')
  // a model the engine reports at max keeps max
  agents.push(listed({ id: 'ag-mx', description: 'gap', type: 'steward-delegation:reviewer-sonnet-high', status: 'running', model: 'claude-sonnet-5-5', lastRequest: { at: NOW, model: 'claude-sonnet-5-5', effort: 'max' } }))
  await complete($)
  // the description gives way at 48 columns
  expect(await agentLines($, 'sonnet 5.5 max')).toHaveLength(1)
})

// ---------------------------------------------------------------- 0.5.0 pre-release: hostile files, chains, turn end

const QDIR = '/u/tester/.claude/quota'
const BAD_JSON = { 'null.json': 'null', 'list.json': '[1, 2]', 'number.json': '5', 'broken.json': '{"profile": ' }

test('quota files holding null, an array, a number or broken JSON are skipped; the rest show', async ($, on) => {
  const files: Record<string, string> = Object.fromEntries(Object.entries(BAD_JSON).map(([n, t]) => [`${QDIR}/${n}`, t]))
  files[`${QDIR}/good.json`] = JSON.stringify({ profile: 'good', seven_day: { used_percentage: 40 }, updated_at_epoch: NOW / 1000 })
  const { opened } = world(on, {
    extra: { dirs: { [QDIR]: Object.keys(files).map(p => ({ name: p.split('/').pop()!, kind: 'file' as const })) }, files },
  })
  millionSession(on)
  await start($)
  expect(opened).toContain('stackwell')
  const accts = (await frame($)).lines.filter(l => l.startsWith('acct')).map(l => l.trimEnd())
  expect(accts).toEqual(['acct good   7d 40%'])
})

test('session files holding null, an array, a number or broken JSON read as no file', async ($, on) => {
  const dir = '/u/tester/.claude/sessions'
  const files: Record<string, string> = Object.fromEntries(Object.entries(BAD_JSON).map(([n, t]) => [`${dir}/${n}`, t]))
  files[`${dir}/good.json`] = JSON.stringify({ sessionId: ID_B, name: 'beta-sec', status: 'busy', statusUpdatedAt: NOW })
  const { opened } = world(on, {
    steward: { registry: REGISTRY, sessionId: ID_A },
    extra: {
      dirs: { [dir]: Object.keys(files).map(p => ({ name: p.split('/').pop()!, kind: 'file' as const })) },
      files,
      stats: Object.fromEntries(Object.keys(files).map(p => [p, { kind: 'file' as const, mtimeMs: 1 }])),
    },
  })
  millionSession(on)
  await start($)
  expect(opened).toContain('stackwell')
  const rows = stewardRows(await frame($))
  expect(rows[1]).toMatch(/beta-sec\s+busy 0m$/)
  expect(rows[2]).toMatch(/gamma-sec\s+offline$/)
})

test('a binder holding null, an array, a number or broken JSON is no binder', () => {
  for (const text of Object.values(BAD_JSON)) expect(parseBinder(text), text).toBeUndefined()
  expect(parseBinder('{"slug": "s", "work_items": [null, 3, {"id": "a"}]}')?.items).toEqual([{ id: 'a', deps: [] }])
})

test('session.start that fails a read still opens the pane', async ($, on) => {
  // a listing whose entry has no string name: the account read throws past its guards
  const { opened } = world(on, { extra: { dirs: { [QDIR]: [{ name: 42 as never, kind: 'file' }] } } })
  millionSession(on)
  await start($)
  expect(opened).toContain('stackwell')
})

test('a minute tick that throws once still arms the next one', async ($, on) => {
  const calls: Record<string, number> = {}
  const dirs: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {}
  const { clock } = world(on, { extra: { calls, dirs, panesOpen: true } })
  millionSession(on)
  await start($)
  dirs[QDIR] = [{ name: 42 as never, kind: 'file' }]
  const before = calls['fs.list'] ?? 0
  await clock.advance(M)
  // that tick listed the folder, then threw on the entry
  expect(calls['fs.list'] ?? 0).toBe(before + 1)
  delete dirs[QDIR]
  await clock.advance(M)
  expect(calls['fs.list'] ?? 0).toBe(before + 2)
})

test('a peer whose pid dies with no file change reads offline after the next minute tick', async ($, on) => {
  const dir = '/u/tester/.claude/sessions'
  const calls: Record<string, number> = {}
  const live = [4242]
  const { clock } = world(on, {
    steward: { registry: REGISTRY, sessionId: ID_A },
    extra: {
      calls,
      live,
      panesOpen: true,
      dirs: { [dir]: [{ name: '1.json', kind: 'file' }] },
      files: { [`${dir}/1.json`]: JSON.stringify({ sessionId: ID_B, name: 'beta-sec', status: 'busy', pid: 4242, statusUpdatedAt: NOW }) },
      stats: { [`${dir}/1.json`]: { kind: 'file', mtimeMs: 1 } },
    },
  })
  millionSession(on)
  await start($)
  expect(stewardRows(await frame($))[1]).toMatch(/beta-sec\s+busy 0m$/)
  live.length = 0
  // the 15 s ticks only stat: no probe while the file is unchanged
  await clock.advance(45_000)
  expect(stewardRows(await frame($))[1]).toMatch(/beta-sec\s+busy/)
  await clock.advance(15_000)
  expect(stewardRows(await frame($))[1]).toMatch(/beta-sec\s+offline$/)
  // one probe at start, one at the minute tick
  expect(calls.kill).toBe(2)
})

test('the main turn end hands the turn on before its reads finish', async ($, on) => {
  const calls: Record<string, number> = {}
  let isSlow = false
  let release: () => void = () => {}
  let reached: () => void = () => {}
  const held = new Promise<void>(r => { release = r })
  const isReached = new Promise<void>(r => { reached = r })
  const statusGate = () => {
    if (!isSlow) return Promise.resolve()
    reached()
    return held
  }
  world(on, { git: { changes: 1 }, extra: { calls, statusGate } })
  millionSession(on)
  await start($)
  isSlow = true
  const ending = complete($)
  await isReached
  expect(calls['turn.complete']).toBe(1)
  release()
  await ending
})

test('a failing read at the main turn end does not block the others', async ($, on) => {
  const repos: Repo[] = []
  world(on, { git: { changes: 1 }, extra: { repos } })
  let isBroken = false
  on('session.usage', () => ({
    value: { startedAt: NOW - H, context: isBroken ? (null as never) : { tokens: 100_000, window: 1_000_000, percent: 10 }, rateLimits: [], cost: { usd: 1 } },
  }))
  await start($)
  isBroken = true
  repos[0]!.changes = 3
  await complete($)
  const f = await frame($)
  expect(f.lines[row(f, /^session/)]!.trimEnd()).toMatch(/turn 1 · /)
  expect(f.lines.some(l => l.includes('+120 −30'))).toBe(true)
})

test('the turn end no longer detects the cwd for a branch nothing draws', async ($, on) => {
  const calls: Record<string, number> = {}
  world(on, { branch: 'main', extra: { calls } })
  millionSession(on)
  await start($)
  const before = calls['detect:/work/sample-repo'] ?? 0
  await complete($)
  // the folder refresh's one detect, no second for the title
  expect((calls['detect:/work/sample-repo'] ?? 0) - before).toBe(1)
})

test('touched folders: a stat decides a path without an extension; a file is its folder, never itself', () => {
  const kinds = new Map<string, 'file' | 'dir'>([['/u/tester/.local/bin/tool', 'file'], ['/var/log/syslog', 'file'], ['/w/f/src', 'dir']])
  const t = (command: string) => touchedFolders('Bash', { command }, '/w/here', '/u/tester', kinds)
  expect(t('~/.local/bin/tool --flag')).toEqual(['/u/tester/.local/bin'])
  expect(t('tail /var/log/syslog')).toEqual(['/var/log'])
  expect(t('ls /w/f/src')).toEqual(['/w/f/src'])
  // a path the stat did not find is no folder of its own
  expect(t('ls /w/gone/thing')).toEqual(['/w/gone'])
  expect(touchedFolders('Grep', { pattern: 'x', path: '/w/f/src' }, '/w/here', '/u/tester', kinds)).toEqual(['/w/f/src'])
  expect(touchedFolders('Grep', { pattern: 'x', path: '/var/log/syslog' }, '/w/here', '/u/tester', kinds)).toEqual(['/var/log'])
  // cd targets and file tools need no stat
  expect(touchedPaths('Bash', { command: 'ls /w/e; cd /w/d' }, '/w/here', '/u/tester')).toEqual([{ path: '/w/d', kind: 'dir' }, { path: '/w/e' }])
  expect(touchedPaths('Read', { file_path: '/w/a/x' }, '/w/here', '/u/tester')).toEqual([{ path: '/w/a/x', kind: 'file' }])
})

test('touched folders through the engine: program and log files show as their folders', async ($, on) => {
  const transcript: Transcript = { main: [said({ tool: 'Bash', input: { command: '~/.local/bin/tool --flag' } }, { tool: 'Bash', input: { command: 'tail -n 5 /var/log/syslog' } })] }
  world(on, { extra: { transcript, stats: { '/u/tester/.local/bin/tool': { kind: 'file', mtimeMs: 1 }, '/var/log/syslog': { kind: 'file', mtimeMs: 1 } } } })
  millionSession(on)
  await start($)
  await complete($)
  const all = (await frame($)).lines.join('\n')
  expect(all).toContain('~/.local/bin')
  expect(all).not.toContain('bin/tool')
  expect(all).toContain('/var/log')
  expect(all).not.toContain('syslog')
})

test('a running agent the list no longer reports as live is closed at the main turn end', async ($, on) => {
  world(on)
  millionSession(on)
  let list: unknown[] = ['lost', 'live', 'dead'].map(d => listed({ id: `ag-${d}`, description: d, type: 'Explore', status: 'running' }))
  on('agent.list', () => ({ value: list as never }))
  await start($)
  list = [
    listed({ id: 'ag-live', description: 'live', type: 'Explore', status: 'running' }),
    listed({ id: 'ag-dead', description: 'dead', type: 'Explore', status: 'killed' }),
  ]
  await complete($)
  expect((await agentLines($, 'lost'))[0]).toMatch(/✓ /)
  expect((await agentLines($, 'live'))[0]).not.toMatch(/[✓✕] /)
  expect((await agentLines($, 'dead'))[0]).toMatch(/✕ /)
})

test('a list that fails at the main turn end closes no agent', async ($, on) => {
  world(on)
  millionSession(on)
  let isBroken = false
  on('agent.list', () => {
    if (isBroken) throw new Error('no list')
    return { value: [listed({ id: 'ag-x', description: 'kept', type: 'Explore', status: 'running' })] as never }
  })
  await start($)
  isBroken = true
  await complete($)
  expect((await agentLines($, 'kept'))[0]).not.toMatch(/[✓✕] /)
})

test('a minute tick whose pane lookup fails skips that minute and keeps the chain', async ($, on) => {
  const calls: Record<string, number> = {}
  const { clock, ex } = world(on, { extra: { calls, panesOpen: true } })
  millionSession(on)
  await start($)
  const before = calls['fs.list'] ?? 0
  ex.panesFail = true
  await clock.advance(M)
  expect(calls['fs.list'] ?? 0).toBe(before)
  ex.panesFail = false
  await clock.advance(M)
  expect(calls['fs.list'] ?? 0).toBe(before + 1)
})

test('a peer read offline that a later probe finds alive reads its status again', async ($, on) => {
  const dir = '/u/tester/.claude/sessions'
  const live: number[] = []
  const { clock } = world(on, {
    steward: { registry: REGISTRY, sessionId: ID_A },
    extra: {
      live,
      panesOpen: true,
      dirs: { [dir]: [{ name: '1.json', kind: 'file' }] },
      files: { [`${dir}/1.json`]: JSON.stringify({ sessionId: ID_B, name: 'beta-sec', status: 'busy', pid: 4242, statusUpdatedAt: NOW }) },
      stats: { [`${dir}/1.json`]: { kind: 'file', mtimeMs: 1 } },
    },
  })
  millionSession(on)
  await start($)
  expect(stewardRows(await frame($))[1]).toMatch(/beta-sec\s+offline$/)
  live.push(4242)
  await clock.advance(M)
  expect(stewardRows(await frame($))[1]).toMatch(/beta-sec\s+busy/)
})

// ---------------------------------------------------------------- hover cards never cut their text

const TASK_160 = 'Survey every hover surface the pane draws, list each one that cuts its text, and then write a short note on which of them the operator sees most in a long session'
const NOSPACE_PATH = '/home/tester/src/a-very-long-folder-name-without-any-spaces/and-deeper-still/and-deeper-yet/leaf'
const LONG_MODEL = 'claude-opus-5-5-20261101-experimental-preview-with-a-very-long-identifier'
/** Every card of the pane, with its pane row. */
const paneCardsOf = (parts: ReturnType<typeof drawModule.drawParts>) => {
  const out: drawModule.Card[] = []
  for (const p of parts.pieces) if ('screen' in p) out.push(...p.screen.cards)
  if (parts.head) out.push(...parts.head.cards)
  return out
}
const squash = (s: string) => s.replace(/\s+/g, '')

test('cards wrap long values whole: task, a path with no spaces, a long model id at widths 48 and 30', () => {
  expect(TASK_160.length).toBeGreaterThanOrEqual(160)
  for (const W of [48, 30]) {
    const v = base({ cwd: NOSPACE_PATH, home: '/u/other', agents: [fullAgent({ name: TASK_160, model: LONG_MODEL })] })
    const cards = paneCardsOf(drawModule.drawParts(v, W, 200))
    const agent = cards.find(c => squash(c.lines.join('')).includes(squash(TASK_160)))?.lines
    expect(agent, `width ${W}: an agent card`).toBeDefined()
    const cwd = cards.find(c => squash(c.lines.join('')).includes(squash(NOSPACE_PATH)))?.lines
    expect(cwd, `width ${W}: a cwd card`).toBeDefined()
    for (const c of cards) {
      expect(c.width, `width ${W}: card as wide as the pane`).toBe(W)
      for (const l of c.lines) {
        expect(Array.from(l).length, `width ${W}: ${l}`).toBeLessThanOrEqual(c.width - 4)
        expect(l, `width ${W}: no … in a card that fits`).not.toContain('…')
      }
    }
    // a value's lines: its first at column 0, the rest indented 2 under it
    const valueLines = (ls: string[], start: string) => {
      const i = ls.findIndex(l => l.startsWith(start))
      expect(i, `width ${W}: a line starting ${start}`).toBeGreaterThanOrEqual(0)
      const out = [ls[i]!]
      for (let j = i + 1; j < ls.length && ls[j]!.startsWith('  '); j++) {
        expect(ls[j]![2], `width ${W}: continuation starts at the indent`).not.toBe(' ')
        out.push(ls[j]!.slice(2))
      }
      return out
    }
    expect(valueLines(agent!, LONG_MODEL.slice(0, 10)).join('')).toBe(LONG_MODEL)
    expect(valueLines(cwd!, NOSPACE_PATH.slice(0, 10)).join('')).toBe(NOSPACE_PATH)
    // the 160-character task breaks at word boundaries: no word split across lines
    const taskLines = valueLines(agent!, 'Survey')
    expect(taskLines.length).toBeGreaterThan(1)
    expect(taskLines.join(' ')).toBe(TASK_160)
  }
})

test('card placement: below when it fits, above when not, at the pane top when neither, cut with … only past the pane', () => {
  const v = (name: string) => base({ agents: [fullAgent({ name })] })
  const agentCard = (parts: ReturnType<typeof drawModule.drawParts>) => paneCardsOf(parts).find(c => squash(c.lines.join('')).includes(squash(TASK_160.slice(0, 40))))!
  // the agent row's pane row, and the pane's height in rows
  const full = drawModule.drawParts(v(TASK_160), 48, 200)
  const at = agentCard(full).at
  const h = agentCard(full).lines.length + 2
  expect(agentCard(full).top).toBe(at + 1)
  // too tall for the rows below, room above: opens upward
  if (at >= h) {
    const up = agentCard(drawModule.drawParts(v(TASK_160), 48, at + 2))
    expect(up.top).toBe(at - h)
    expect(up.lines.join('')).not.toContain('…')
  }
  // fits neither way but fits the pane: at the pane top, whole
  const tallTask = TASK_160 + ' ' + TASK_160
  const tallH = agentCard(drawModule.drawParts(v(tallTask), 48, 200)).lines.length + 2
  const rowsMid = Math.max(tallH, at + 3)
  const mid = agentCard(drawModule.drawParts(v(tallTask), 48, rowsMid))
  expect(mid.lines.length + 2).toBe(tallH)
  expect(mid.top).toBe(0)
  expect(mid.lines.join('')).not.toContain('…')
  expect(squash(mid.lines.join(''))).toContain(squash(tallTask).slice(-40))
  // taller than the whole pane: at the top, the pane's height, the last line `…`
  const small = Math.min(tallH - 1, Math.max(at + 3, 8))
  const cut = agentCard(drawModule.drawParts(v(tallTask), 48, small))
  expect(cut.top).toBe(0)
  expect(cut.lines.length + 2).toBe(small)
  expect(cut.lines[cut.lines.length - 1]).toBe('…')
  expect(cut.lines.slice(0, -1).join('')).not.toContain('…')
})

// ---------------------------------------------------------------- compact cards and click to copy

const NORMAL_TASK = 'Write the icon generator and wire it into the pane build step'
const agentCardOf = (parts: ReturnType<typeof drawModule.drawParts>, task: string) =>
  paneCardsOf(parts).find(c => squash(c.lines.join('')).includes(squash(task)))

test('compact agent card: paired fields, the task last, at most 6 lines at 48 columns', () => {
  const v = base({ agents: [fullAgent({ name: NORMAL_TASK })] })
  const c = agentCardOf(drawModule.drawParts(v, 48, 200), NORMAL_TASK)
  expect(c, 'an agent card').toBeDefined()
  expect(c!.lines.slice(0, 3)).toEqual(['coder · steward-delegation', 'claude-opus-5-5 · xhigh', `started ${hhmm(NOW - 2 * M)} · running`])
  expect(c!.lines.length).toBeLessThanOrEqual(6)
  expect(squash(c!.lines.slice(3).join(' '))).toBe(squash(NORMAL_TASK))
  // the copy text: one field per line, in the order shown
  expect(c!.text).toBe(['coder', 'steward-delegation', 'claude-opus-5-5', 'xhigh', `started ${hhmm(NOW - 2 * M)}`, 'running', NORMAL_TASK].join('\n'))
  // a bare agent's empty fields say what they are
  const bare = drawModule.drawParts(base({ agents: [{ id: 'b', name: 'Explore', kind: 'Explore', isBackground: true, status: 'ok', startedAt: NOW - M, endedAt: NOW }] }), 48, 200)
  const b = paneCardsOf(bare).find(x => x.lines.some(l => l.startsWith('Explore')))!
  expect(b.lines).toEqual(['Explore · no plugin', 'model unknown · effort unknown', `started ${hhmm(NOW - M)} · done, background`])
})

test('compact cards: folder path then branch; values that do not pair wrap whole with a hanging indent', () => {
  const longBranch = 'feature/a-really-long-branch-name-that-cannot-fit'
  const v = base({ home: '/home/u', folders: [folder({ name: 'repo-name', isCwd: true, branch: 'main' }), { ...folder({ name: 'other', branch: longBranch }), key: '/srv/some/really/long/path/to/another/checkout/here' }] })
  for (const W of [48, 30]) {
    const cards = paneCardsOf(drawModule.drawParts(v, W, 200))
    const c = cards.find(x => squash(x.lines.join('')).includes('/srv/some/really/long/path'))
    expect(c, `width ${W}: a folder card`).toBeDefined()
    expect(c!.text).toBe(['/srv/some/really/long/path/to/another/checkout/here', longBranch].join('\n'))
    for (const l of c!.lines) expect(Array.from(l).length, `width ${W}: ${l}`).toBeLessThanOrEqual(W - 4)
    // the first line of each field at column 0, its continuation lines indented 2
    const starts = c!.lines.filter(l => !l.startsWith(' '))
    expect(starts.length, `width ${W}: ${c!.lines.join(' | ')}`).toBe(2)
    for (const l of c!.lines.filter(l => l.startsWith(' '))) expect(l.startsWith('  ') && l[2] !== ' ').toBe(true)
    expect(squash(c!.lines.join(''))).toBe(squash(c!.text))
  }
})

test('compact cards: long task, path and model whole, no …, at 48 and 30', () => {
  for (const W of [48, 30]) {
    const v = base({ cwd: NOSPACE_PATH, home: '/u/other', agents: [fullAgent({ name: TASK_160, model: LONG_MODEL })] })
    const cards = paneCardsOf(drawModule.drawParts(v, W, 200))
    const agent = agentCardOf(drawModule.drawParts(v, W, 200), TASK_160)
    expect(agent, `width ${W}: an agent card`).toBeDefined()
    const cwd = cards.find(c => squash(c.lines.join('')).includes(squash(NOSPACE_PATH)))
    expect(cwd, `width ${W}: a cwd card`).toBeDefined()
    for (const c of cards) {
      expect(c.text).not.toContain('…')
      for (const l of c.lines) {
        expect(Array.from(l).length, `width ${W}: ${l}`).toBeLessThanOrEqual(c.width - 4)
        expect(l).not.toContain('…')
      }
    }
    expect(agent!.text.split('\n')).toContain(LONG_MODEL)
    expect(agent!.text.split('\n')).toContain(TASK_160)
    expect(cwd!.text.split('\n')).toContain(NOSPACE_PATH)
  }
})

/** The cut rows' copy Buttons of a drawn tree. */
const copyButtons = (tree: unknown) => allOf(tree).filter(el => el.type === 'Button' && String(el.props?.key ?? '').startsWith('stackwell-copy-'))

for (const surface of ['terminal', 'desktop'] as const) {
  test(`click to copy (${surface}): a press on a cut row copies its card's full text and toasts`, async ($, on) => {
    const copies: { text: string; surface?: string }[] = []
    const toasts: string[] = []
    let answer: { isCopied: true } | { isCopied: false; reason: 'no-clipboard' } = { isCopied: true }
    on('ui.copy', (_$, e) => (copies.push({ text: e.text, surface: e.surface }), { value: answer }))
    on('ui.toast', (_$, e, next) => (toasts.push(e.text), next(e)))
    await cardSession($, on)
    const ui = await $.ui.mount({ ...PANE, surface })
    const tree = await ui.drawn()
    const buttons = copyButtons(tree)
    expect(buttons.length, 'a cut row is pressable').toBeGreaterThan(0)
    // each copy Button sits in its card's scope Box and keeps the hover highlight
    const { cards, scoped } = cardsOf(tree)
    for (const b of buttons) expect(scoped.some(el => el.type === 'Box' && allOf(el).includes(b))).toBe(true)
    const agentCard = cards.find(c => (c.children ?? []).map(textOf).join(' ').replace(/\s+/g, ' ').includes(LONG_TASK))!
    const scope = hoverOf(agentCard)!.scope as string
    const rowBox = scoped.find(el => el.type === 'Box' && hoverOf(el)!.scope === scope)!
    const b = copyButtons(rowBox)[0]!
    await ui.press({ key: b.props!.key as string })
    expect(copies).toHaveLength(1)
    expect(copies[0]!.surface).toBe(surface)
    const lines = copies[0]!.text.split('\n')
    expect(lines).toContain(LONG_TASK)
    expect(lines).toContain('general-purpose')
    expect(copies[0]!.text).not.toContain('…')
    expect(toasts[toasts.length - 1]).toBe('copied')
    // a failed copy says why
    answer = { isCopied: false, reason: 'no-clipboard' }
    await ui.press({ key: b.props!.key as string })
    expect(toasts[toasts.length - 1]).toMatch(/copy failed.*no-clipboard/)
    // the folders Button still presses
    await ui.press({ key: FOLDERS_KEY })
    await ui.unmount()
    expect((await frame($)).lines.some(l => l.trim() === 'show less')).toBe(true)
  })
}

/** The placed cards a drawn tree shows without hover: pinned open. */
const pinnedOf = (tree: unknown) =>
  ((tree as El).children ?? []).filter(k => {
    const p = (k as El)?.props ?? {}
    return (k as El)?.type === 'Box' && p.position === 'absolute' && p.display !== 'none' && typeof hoverOf(k)?.scope === 'string'
  }) as El[]
const scopeOfCard = (c: El) => hoverOf(c)!.scope as string
/** The first copy Button of the row in `scope`. */
const rowButton = (tree: unknown, scope: string) => {
  const { scoped } = cardsOf(tree)
  const rowBox = scoped.find(el => el.type === 'Box' && hoverOf(el)!.scope === scope)!
  return copyButtons(rowBox)[0]!.props!.key as string
}

test('pin: a click copies and pins its card open; a second click unpins; another row moves the pin; 20 s unpins', async ($, on) => {
  const copies: string[] = []
  on('ui.copy', (_$, e) => (copies.push(e.text), { value: { isCopied: true } }))
  const { clock, agents } = await cardSession($, on)
  agents.push(listed({ id: 'ag-again', description: LONG_TASK + ' again', type: 'general-purpose', status: 'running' }))
  await agentStart($, 'ag-again')
  await complete($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const tree0 = await ui.drawn()
  expect(pinnedOf(tree0)).toHaveLength(0)
  const scopes = cardsOf(tree0).cards.map(scopeOfCard)
  expect(scopes.length).toBeGreaterThanOrEqual(2)
  const [a, b] = scopes as [string, string]
  // a click copies and pins
  await ui.press({ key: rowButton(tree0, a) })
  expect(copies).toHaveLength(1)
  let tree = await ui.drawn()
  expect(pinnedOf(tree).map(scopeOfCard)).toEqual([a])
  // the pinned card keeps its place and hover scope
  expect(pinnedOf(tree)[0]!.props!.top).toBe(cardsOf(tree0).cards.find(c => scopeOfCard(c) === a)!.props!.top)
  // the same row again: unpinned (and copied again)
  await ui.press({ key: rowButton(tree, a) })
  expect(copies).toHaveLength(2)
  tree = await ui.drawn()
  expect(pinnedOf(tree)).toHaveLength(0)
  // another row moves the pin
  await ui.press({ key: rowButton(tree, a) })
  tree = await ui.drawn()
  await ui.press({ key: rowButton(tree, b) })
  tree = await ui.drawn()
  expect(pinnedOf(tree).map(scopeOfCard)).toEqual([b])
  // 20 s after the last click it closes; not before
  await clock.advance(19_000)
  expect(pinnedOf(await ui.drawn()).map(scopeOfCard)).toEqual([b])
  await clock.advance(1_500)
  expect(pinnedOf(await ui.drawn())).toHaveLength(0)
  await ui.unmount()
})

test('compact cards open adjacent to their row: right below it when it fits, right above it when only that fits', () => {
  const v = base({ agents: [fullAgent({ name: NORMAL_TASK })] })
  const full = agentCardOf(drawModule.drawParts(v, 48, 200), NORMAL_TASK)!
  const h = full.lines.length + 2
  expect(full.top).toBe(full.at + 1)
  // room for the card below the row: still right below it
  const tight = agentCardOf(drawModule.drawParts(v, 48, full.at + 1 + h), NORMAL_TASK)!
  expect(tight.top).toBe(tight.at + 1)
  // one row short below, room above: its bottom border right above the row
  if (full.at >= h) {
    const up = agentCardOf(drawModule.drawParts(v, 48, full.at + h), NORMAL_TASK)!
    expect(up.isUp).toBe(true)
    expect(up.top + h).toBe(up.at)
  }
})

test('compact folder card: the path alone, then branch · status', () => {
  const path = '/srv/checkouts/a-really-long-folder-name-that-will-not-fit-here'
  const v = base({ home: '/home/u', folders: [folder({ name: 'repo-name', isCwd: true, branch: 'main' }), { ...folder({ name: 'other', branch: 'main', added: 0, removed: 0 }), key: path }] })
  const c = paneCardsOf(drawModule.drawParts(v, 48, 200)).find(x => squash(x.lines.join('')).includes(path.slice(0, 30)))!
  expect(c, layout(v, 44, 200).map(txt).join('\n')).toBeDefined()
  expect(c.lines).toEqual([path.slice(0, 44), '  ' + path.slice(44), 'main · clean'])
  expect(c.text).toBe(`${path}\nmain\nclean`)
})

test('pin (pure): a stored pin shows only until its time, so one whose timer a hot reload lost still closes', () => {
  const p = { at: 12, until: NOW + 20_000 }
  expect(pinShown(p, NOW)).toBe(12)
  expect(pinShown(p, NOW + 19_999)).toBe(12)
  expect(pinShown(p, NOW + 20_000)).toBe(-1)
  expect(pinShown({ at: -1, until: 0 }, NOW)).toBe(-1)
  // a stored value of another shape draws no pin, never throws
  expect(pinShown(undefined as never, NOW)).toBe(-1)
  expect(pinShown(-1 as never, NOW)).toBe(-1)
})

// ---------------------------------------------------------------- observe only: no hook in a call's path

/** Every event the module registers a hook on, by a recording `on`. */
function registered(): string[] {
  const names: string[] = []
  const chain = { catch: () => chain }
  const rec = ((name: string) => (names.push(name), chain)) as unknown as On
  register(rec, {})
  return names
}

test('only observe hooks are registered: no tool, spawn, append or compact hook sits in a call\'s path', () => {
  const names = registered()
  expect([...new Set(names)].sort()).toEqual(['command.run', 'session.measure', 'session.start', 'turn.complete', 'turn.start', 'ui.render'])
  for (const n of names) expect(n, n).not.toMatch(/^(tool|agent|session\.append|session\.compact)\b|\*/)
})

/** A gate a test holds a read open with: `hold()` arms it, `release()` lets every held read go. */
function gate() {
  let isHeld = false
  let release: () => void = () => {}
  let reached: () => void = () => {}
  const held = new Promise<void>(r => { release = r })
  const isReached = new Promise<void>(r => { reached = r })
  return {
    hold: () => { isHeld = true },
    wait: () => (isHeld ? (reached(), held) : Promise.resolve()),
    isReached,
    release: () => release(),
  }
}

test('turn.complete returns before its history and agent reads finish', async ($, on) => {
  const g = gate()
  const calls: Record<string, number> = {}
  world(on, { extra: { calls, messagesGate: g.wait } })
  millionSession(on)
  await start($)
  g.hold()
  // no idle here: the event alone, which must come back while the read is held
  const r = await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't9', reason: 'answer' })
  expect(r).toEqual({ text: '' })
  await g.isReached
  expect(calls['turn.complete']).toBe(1)
  g.release()
  await idle()
})

test('turn.start and session.start return before their reads finish', async ($, on) => {
  const listGate = gate()
  const g = gate()
  world(on, { git: { changes: 1 }, extra: { statusGate: g.wait } })
  on('agent.list', async () => (await listGate.wait(), { value: [] as never }))
  millionSession(on)
  g.hold()
  // session.start: the seed's git reads are held, the start is not
  const started = await $.session.start({ cwd: '/work/sample-repo', surface: 'terminal', isInteractive: true })
  expect(started).toEqual({ cwd: '/work/sample-repo' })
  await g.isReached
  g.release()
  await idle()
  listGate.hold()
  const turned = await $.turn.start({ text: 'hi', turnId: 't1', agentId: 'ag-z' })
  expect(turned).toEqual({ turnId: 't1' })
  await listGate.isReached
  listGate.release()
  await idle()
})

test('turn ends that come while the reads run never overlap them: one more run after, none dropped', async ($, on) => {
  const g = gate()
  const calls: Record<string, number> = {}
  const transcript: Transcript = { main: [said({ tool: 'Read', input: { file_path: '/data/one/x.txt' } })] }
  world(on, { extra: { calls, transcript, messagesGate: g.wait } })
  millionSession(on)
  await start($)
  g.hold()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer' })
  await g.isReached
  transcript.main.push(said({ tool: 'Read', input: { file_path: '/data/two/x.txt' } }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'b', reason: 'answer' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'c', reason: 'answer' })
  await idle()
  // the first read is still held: no second read started beside it
  expect(calls['session.messages']).toBe(1)
  g.release()
  await idle()
  // one more run after it, for both later ends; every turn counted
  expect(calls['session.messages']).toBe(2)
  const f = await frame($)
  expect(f.lines[row(f, /^session/)]).toMatch(/turn 3 · /)
  expect(f.lines.some(l => l.includes('/data/one'))).toBe(true)
  expect(f.lines.some(l => l.includes('/data/two'))).toBe(true)
})

// ---------------------------------------------------------------- agents from list reads

test('agents come from list reads: at a main turn start, at the main turn end, on the minute tick', async ($, on) => {
  const { clock } = world(on, { extra: { panesOpen: true } })
  millionSession(on)
  const agents = agentList(on)
  await start($)
  agents.push(listed({ id: 'ag-1', description: 'first', type: 'Explore', status: 'running' }))
  await $.turn.start({ text: 'go', turnId: 'm1' })
  await idle()
  expect(await agentLines($, 'first')).toHaveLength(1)
  agents.push(listed({ id: 'ag-2', description: 'second', type: 'Explore', status: 'running' }))
  await complete($)
  expect(await agentLines($, 'second')).toHaveLength(1)
  agents.push(listed({ id: 'ag-3', description: 'third', type: 'Explore', status: 'waiting' }))
  await clock.advance(M)
  await idle()
  expect(await agentLines($, 'third')).toHaveLength(1)
  // a completed one the view never held does not join
  agents.push(listed({ id: 'ag-4', description: 'fourth', type: 'Explore', status: 'completed' }))
  await clock.advance(M)
  await idle()
  expect(await agentLines($, 'fourth')).toHaveLength(0)
})

test('the 15 s tick reads the agent list while it runs', async ($, on) => {
  const calls: Record<string, number> = {}
  const peers = [{ name: 'beta-sec', status: 'busy', sessionId: ID_B, since: NOW }]
  const { clock } = world(on, { steward: { registry: REGISTRY, sessionId: ID_A, peers }, extra: { calls, panesOpen: true } })
  millionSession(on)
  const agents = agentList(on)
  await start($)
  agents.push(listed({ id: 'ag-f', description: 'fast-one', type: 'Explore', status: 'running' }))
  await clock.advance(15_000)
  await idle()
  expect(await agentLines($, 'fast-one')).toHaveLength(1)
})

test('an agent the view never held, seen first at its own end, joins as ended', async ($, on) => {
  world(on)
  millionSession(on)
  const agents = agentList(on)
  await start($)
  agents.push(listed({ id: 'ag-q', description: 'quick', type: 'Explore', status: 'completed', startTime: NOW - 2 * M }))
  await agentEnd($, 'ag-q')
  expect((await agentLines($, 'quick'))[0]).toMatch(/✓ Explore  quick\s+2m$/)
  // a stale list that still says running does not open it again
  agents[0]!.status = 'running'
  await agentStart($, 'ag-other')
  expect((await agentLines($, 'quick'))[0]).toMatch(/✓ /)
})

test('an Agent tool use run in the background marks its agent as background at the turn end', async ($, on) => {
  const transcript: Transcript = { main: [] }
  world(on, { extra: { transcript } })
  millionSession(on)
  const agents = agentList(on)
  await start($)
  agents.push(listed({ id: 'ag-bg', description: LONG_TASK, type: 'general-purpose', status: 'running' }))
  await agentStart($, 'ag-bg')
  const card = async () => (await rawAt($)).lines.join('\n')
  transcript.main.push(said({ tool: 'Agent', input: { description: 'x', prompt: 'p', run_in_background: true }, agentId: 'ag-bg' }))
  await complete($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const { cards } = cardsOf(await ui.drawn())
  await ui.unmount()
  expect(cards.map(c => (c.children ?? []).map(textOf).join(' ')).join(' ')).toContain('background')
  expect(await card()).toContain('general-purpose')
})

// ---------------------------------------------------------------- folders from the session history

test('folders come from the history after the turn: a first read of the newest rows, then only rows after the last', async ($, on) => {
  const messageArgs: Record<string, unknown>[] = []
  const transcript: Transcript = { main: [said({ tool: 'Read', input: { file_path: '/data/a/x.txt' } })] }
  world(on, { extra: { transcript, messageArgs, stats: { '/data/b': { kind: 'dir', mtimeMs: 1 } } } })
  millionSession(on)
  await start($)
  // nothing is read before a turn ends
  expect(messageArgs).toHaveLength(0)
  await complete($)
  expect(messageArgs).toEqual([{ last: 200 }])
  const first = transcript.main[0]!.uuid
  transcript.main.push(said({ tool: 'Grep', input: { pattern: 'x', path: '/data/b' } }, { tool: 'Bash', input: { command: 'cd /data/c && ls' } }))
  await complete($)
  expect(messageArgs[1]).toEqual({ after: first })
  const f = await frame($)
  for (const d of ['/data/a', '/data/b', '/data/c']) expect(f.lines.some(l => l.includes(d)), d).toBe(true)
  // a turn with no new rows reads after the same last row, and adds nothing
  await complete($)
  expect(messageArgs[2]).toEqual({ after: transcript.main[1]!.uuid })
})

test('a cursor a compaction left behind is dropped: the newest rows are read again', async ($, on) => {
  const messageArgs: Record<string, unknown>[] = []
  const transcript: Transcript = { main: [said({ tool: 'Read', input: { file_path: '/data/a/x.txt' } })] }
  world(on, { extra: { transcript, messageArgs } })
  millionSession(on)
  await start($)
  await complete($)
  // the compaction: the rows are new ones, the old uuid anchors no more
  transcript.main = [said({ tool: 'Read', input: { file_path: '/data/after/x.txt' } })]
  await complete($)
  expect(messageArgs.slice(1)).toEqual([{ after: expect.any(String) }, { last: 200 }])
  expect((await frame($)).lines.some(l => l.includes('/data/after'))).toBe(true)
})

test('an agent\'s own tool uses at its end: its history, against its own folder', async ($, on) => {
  const messageArgs: Record<string, unknown>[] = []
  const transcript: Transcript = { main: [], agents: { 'ag-w': [said({ tool: 'Edit', input: { file_path: 'pkg/mod.ts', old_string: 'a', new_string: 'b' } })] } }
  world(on, { extra: { transcript, messageArgs } })
  millionSession(on)
  const agents = agentList(on)
  await start($)
  agents.push(listed({ id: 'ag-w', description: 'worker', type: 'Explore', status: 'running', cwd: '/data/tree' }))
  await agentStart($, 'ag-w')
  await agentEnd($, 'ag-w')
  expect(messageArgs).toContainEqual({ agentId: 'ag-w', last: 200 })
  expect((await frame($)).lines.some(l => l.includes('/data/tree/pkg'))).toBe(true)
  // an agent the session cannot read: a deny, and nothing breaks
  agents.push(listed({ id: 'ag-gone', description: 'gone', type: 'Explore', status: 'running' }))
  await agentEnd($, 'ag-gone')
  expect((await agentLines($, 'gone'))[0]).toMatch(/✓ /)
})

test('non-ASCII home and cwd: paths resolve against the raw folders, and draw cleaned', async ($, on) => {
  const calls: Record<string, number> = {}
  const transcript: Transcript = { main: [said({ tool: 'Bash', input: { command: 'cd src && ls' } }, { tool: 'Read', input: { file_path: '~/notes/a.md' } })] }
  world(on, { home: '/Users/José', cwd: '/Users/José/app', extra: { calls, transcript } })
  millionSession(on)
  await start($)
  await complete($)
  expect(calls['stat:/Users/José/app/src/.git']).toBe(1)
  expect(calls['stat:/Users/José/notes/.git']).toBe(1)
  expect(Object.keys(calls).some(k => k.includes('Jos?'))).toBe(false)
  const f = await frame($)
  const i = row(f, /^folders\s*$/)
  const rows = f.lines.slice(i + 1, i + 5).map(l => l.trimEnd())
  expect(rows.some(r => /^ {4}src\s+now$/.test(r)), rows.join('\n')).toBe(true)
  expect(rows.some(r => /^ {4}~\/notes\s+now$/.test(r)), rows.join('\n')).toBe(true)
  expect(f.lines[0]).toContain('~/app')
})

// ---------------------------------------------------------------- stored views of any shape

/** The view-7 shape (with the tools section's fields) and the view-8 one, every list full. */
const SHAPES: Record<string, unknown>[] = [
  {
    profile: 'me', model: 'claude-opus-5-5', tokens: 131_000, window: 1_000_000, percent: 13, costUsd: 2, startedAt: NOW - H, lastTurnMs: 900,
    quotas: [{ kind: 'seven_day', pct: 20, resetsAt: NOW + H }], toolCounts: { Bash: 3 }, bashFails: 1, running: [{ id: 'r', tool: 'Bash' }],
    compact: { before: 1, after: 2 }, accounts: [{ name: 'beta', d7: 12, d7At: NOW + H, updatedAt: NOW / 1000 }], trend: [1, 2, 3], turns: 3,
    folders: [{ key: '/w/x', name: 'x', isRepo: true, isWorktree: false, isCwd: true, lastAt: NOW, branch: 'main', added: 1, removed: 2, untracked: 3, tag: 'hatch', mainRoot: '/w/x' }],
    cwd: '/w/x', home: '/u', binders: [{ slug: 'b', total: 2, isRunning: true, merged: 1, wave: 1, waves: 2, building: ['i'], halted: ['h'] }],
    agents: [{ id: 'a', agentId: 'ag', name: 'n', kind: 'k', plugin: 'steward-delegation', model: 'opus', effort: 'max', isBackground: true, status: 'ok', startedAt: NOW - M, endedAt: NOW }],
    log: [{ id: 'l', at: NOW, tool: 'Bash', target: 't', status: 'ok' }], isToolsOpen: true, isFoldersOpen: true,
    steward: { role: 'primary', initiative: 'i', peers: [{ name: 'p', role: 'secondary', status: 'busy', since: NOW, sessionId: 's' }], logMtime: NOW },
    breakdown: { msgs: 1, tools: 1, sys: 1, other: 1, raw: 1_000_000, autoCompact: 900_000 }, now: NOW, theme: 'auto', palette: { ...P, tools: 0x123456 },
  },
]
SHAPES.push(Object.fromEntries(Object.entries(SHAPES[0]!).filter(([k]) => !['toolCounts', 'bashFails', 'running', 'compact', 'log', 'isToolsOpen'].includes(k))))

/** Every path into a value: each key and index, nested. */
function pathsOf(x: unknown, at: (string | number)[] = []): (string | number)[][] {
  if (x === null || typeof x !== 'object') return [at]
  const kids = Array.isArray(x) ? x.map((v, i) => pathsOf(v, [...at, i])) : Object.entries(x).map(([k, v]) => pathsOf(v, [...at, k]))
  return [at, ...kids.flat()]
}
/** `x` with the value at `path` set to `to`, or taken out when `to` is the marker. */
function withAt(x: unknown, path: (string | number)[], to: unknown): unknown {
  if (path.length === 0) return to
  const copy = Array.isArray(x) ? [...x] : { ...(x as Record<string, unknown>) }
  const [k, ...rest] = path
  const c = copy as Record<string | number, unknown>
  if (rest.length === 0 && to === GONE) delete c[k!]
  else c[k!] = withAt(c[k!], rest, to)
  return copy
}
const GONE = Symbol('gone')

test('settleView: every field of a view-7 or view-8 shape missing, null or of the wrong type draws without throwing', () => {
  let n = 0
  for (const shape of SHAPES)
    for (const path of pathsOf(shape)) {
      if (path.length === 0) continue
      for (const to of [GONE, null, 'x', 7, [], {}, [null], true]) {
        const raw = withAt(shape, path, to)
        n++
        const where = `${path.join('.')} = ${String(typeof to === 'symbol' ? 'gone' : JSON.stringify(to))}`
        let v: StackwellView | undefined
        expect(() => (v = drawModule.settleView(raw as never)), where).not.toThrow()
        for (const [cols, hasIcon, I] of [[48, false, false], [30, true, true], [6, false, true]] as const) {
          expect(() => {
            const parts = drawModule.drawParts(v!, cols, 40, hasIcon, I)
            for (const p of parts.pieces) if ('screen' in p) p.screen.lines()
          }, `${where} at ${cols}`).not.toThrow()
        }
      }
    }
  expect(n).toBeGreaterThan(500)
})

test('settleView: list elements of the wrong shape are left out; the fields of a removed section go', () => {
  const v = drawModule.settleView({
    ...SHAPES[0],
    quotas: [null, { pct: 3 }, { kind: 'seven_day', pct: 20 }],
    accounts: [{ d7: 3 }, null, { name: 'ok' }],
    agents: [null, { id: 'x', isBackground: false, status: 'running', startedAt: NOW }, { id: 'y', name: 'kept', isBackground: false, status: 'running', startedAt: NOW, plugin: 5 }],
    folders: [{ key: '/w/nameless', isRepo: false, isWorktree: false, isCwd: true, lastAt: NOW }, null, { key: '/w/y', name: 'y', isRepo: false, isWorktree: false, isCwd: false, lastAt: NOW }],
    binders: [{ slug: 'nob', total: 1, isRunning: true, merged: 0, wave: 1, waves: 1 }, null],
    steward: { role: 'primary', initiative: 'i' },
  } as never)
  expect(v.quotas).toEqual([{ kind: 'seven_day', pct: 20 }])
  expect(v.accounts.map(a => a.name)).toEqual(['ok'])
  expect(v.agents.map(a => a.name)).toEqual(['kept'])
  expect(v.agents[0]!.plugin).toBeUndefined()
  expect(v.folders.map(f => f.key)).toEqual(['/w/y'])
  expect(v.binders).toEqual([])
  expect(v.steward?.peers).toEqual([])
  for (const k of ['toolCounts', 'bashFails', 'running', 'compact', 'log', 'isToolsOpen']) expect(k in v, k).toBe(false)
})

test('the header icon\'s alt is ◫ (U+25EB, East Asian Width N), never the ambiguous ▦', async ($, on) => {
  world(on, { extra: { icon: ICON } })
  millionSession(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const img = await ui.find({ key: 'stackwell-icon' })
  await ui.unmount()
  expect(String(img?.props.alt).codePointAt(0)).toBe(0x25eb)
  expect(String(img?.props.alt)).not.toContain('▦')
})

test('a re-read of the newest rows (after a compaction or a reload) adds folders but leaves the ages of those already shown', async ($, on) => {
  const transcript: Transcript = { main: [said({ tool: 'Read', input: { file_path: '/data/old/x.txt' } })] }
  const { clock } = world(on, { extra: { transcript } })
  millionSession(on)
  await start($)
  await complete($)
  await clock.advance(10 * M)
  // the compaction: the old uuid anchors no more; the newest rows name the old folder again, and a new one
  transcript.main = [said({ tool: 'Read', input: { file_path: '/data/old/y.txt' } }, { tool: 'Read', input: { file_path: '/data/new/x.txt' } })]
  await complete($)
  const f = await frame($)
  expect(f.lines.find(l => l.includes('/data/old'))!.trimEnd()).toMatch(/10m$/)
  expect(f.lines.find(l => l.includes('/data/new'))!.trimEnd()).toMatch(/now$/)
})

test('a history read that fails keeps its place: the next one reads on from the same row', async ($, on) => {
  const messageArgs: Record<string, unknown>[] = []
  const transcript: Transcript = { main: [said({ tool: 'Read', input: { file_path: '/data/a/x.txt' } })] }
  let isBroken = false
  world(on, { extra: { transcript, messageArgs, messagesGate: async () => { if (isBroken) throw new Error('read failed') } } })
  millionSession(on)
  await start($)
  await complete($)
  isBroken = true
  await complete($)
  isBroken = false
  await complete($)
  const anchor = transcript.main[0]!.uuid
  expect(messageArgs.slice(1)).toEqual([{ after: anchor }, { after: anchor }])
})

// ---------------------------------------------------------------- untrusted repos: no git outside the cwd's repo

const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.pager=cat']

test('a touched repo outside the cwd repo: no detect, status, diff or process.run there; branch from HEAD, changes —', async ($, on) => {
  const calls: Record<string, number> = {}
  const runs: Run[] = []
  const transcript: Transcript = { main: [] }
  const repos: Repo[] = [{ root: '/data/clone', branch: 'evil', changes: 3 }]
  const { clock } = world(on, { branch: 'main', git: { changes: 1 }, extra: { calls, runs, transcript, repos, panesOpen: true } })
  millionSession(on)
  await start($)
  transcript.main.push(said({ tool: 'Read', input: { file_path: '/data/clone/src/a.ts' } }))
  await complete($)
  await clock.advance(2 * M)
  await complete($)
  for (const k of ['detect:/data/clone', 'detect:/data/clone/src', 'status:/data/clone', 'diff:/data/clone', 'run:/data/clone']) expect(calls[k], k).toBeUndefined()
  expect(runs.filter(r => r.cwd?.startsWith('/data/clone'))).toEqual([])
  const f = await frame($)
  expect(f.lines.find(l => l.includes('/data/clone'))!.trimEnd()).toMatch(/^ {4}\/data\/clone\s+evil\s+—\s+\S+$/)
  // the cwd's own repo still gets its counts
  expect(f.lines.find(l => l.includes('● sample-repo'))).toMatch(/\+40 −10/)
  expect(calls['status:/work/sample-repo']).toBeGreaterThan(0)
})

test('a clone nested inside the cwd repo is outside it: its own .git wins, and no git runs there', async ($, on) => {
  const calls: Record<string, number> = {}
  const transcript: Transcript = { main: [] }
  const repos: Repo[] = [{ root: '/work/sample-repo/vendor/x', branch: 'vend', changes: 2 }]
  world(on, { branch: 'main', git: { changes: 1 }, extra: { calls, transcript, repos } })
  millionSession(on)
  await start($)
  transcript.main.push(said({ tool: 'Read', input: { file_path: '/work/sample-repo/vendor/x/lib/a.ts' } }))
  await complete($)
  for (const k of ['detect:/work/sample-repo/vendor/x', 'status:/work/sample-repo/vendor/x', 'diff:/work/sample-repo/vendor/x']) expect(calls[k], k).toBeUndefined()
  const f = await frame($)
  expect(f.lines.find(l => l.includes('vendor'))!.trimEnd()).toMatch(/vendor\/x\s+vend\s+—/)
})

test('a worktree outside the cwd repo: branch from the HEAD its gitdir file names, ⎇ and the hatch tag, no git', async ($, on) => {
  const calls: Record<string, number> = {}
  const transcript: Transcript = { main: [] }
  const repos: Repo[] = [{ root: '/data/main' }, { root: '/data/wt/feat', mainRoot: '/data/main', branch: 'hatch/s/item-q' }]
  world(on, { branch: 'main', extra: { calls, transcript, repos } })
  millionSession(on)
  await start($)
  transcript.main.push(said({ tool: 'Edit', input: { file_path: '/data/wt/feat/x.ts', old_string: 'a', new_string: 'b' } }))
  await complete($)
  expect(calls['fs.read']).toBeGreaterThan(0)
  for (const k of ['detect:/data/wt/feat', 'status:/data/wt/feat', 'diff:/data/wt/feat']) expect(calls[k], k).toBeUndefined()
  const f = await frame($)
  expect(f.lines.find(l => l.includes('feat'))!.trimEnd()).toMatch(/^ {2}⎇ \/data\/wt\/feat\s+hatch\/s\/item-q\s+—\s+now {2}hatch$/)
})

test('a detached HEAD outside the cwd repo shows no branch', async ($, on) => {
  const transcript: Transcript = { main: [] }
  world(on, { branch: 'main', extra: { transcript, repos: [{ root: '/data/det', head: '0123456789abcdef0123456789abcdef01234567\n' }] } })
  millionSession(on)
  await start($)
  transcript.main.push(said({ tool: 'Read', input: { file_path: '/data/det/a.ts' } }))
  await complete($)
  expect((await frame($)).lines.find(l => l.includes('/data/det'))!.trimEnd()).toMatch(/^ {4}\/data\/det\s+—\s+now$/)
})

test('a worktree of the cwd repo is trusted: its status and diff are read', async ($, on) => {
  const calls: Record<string, number> = {}
  const transcript: Transcript = { main: [] }
  const repos: Repo[] = [{ root: '/work/sample-repo-wt/side', mainRoot: '/work/sample-repo', branch: 'side', changes: 2 }]
  world(on, { branch: 'main', git: { changes: 0 }, extra: { calls, transcript, repos } })
  millionSession(on)
  await start($)
  transcript.main.push(said({ tool: 'Read', input: { file_path: '/work/sample-repo-wt/side/a.ts' } }))
  await complete($)
  expect(calls['status:/work/sample-repo-wt/side']).toBeGreaterThan(0)
  expect((await frame($)).lines.find(l => l.includes('side'))).toMatch(/side\s+\+80 −20/)
})

test('hatch: the cwd repo\'s ref listing runs git with the safety flags and env', async ($, on) => {
  const runs: Run[] = []
  const bdir = '/work/sample-repo/.hatch/binders'
  world(on, { branch: 'main', extra: { runs, stats: { [bdir]: { kind: 'dir', mtimeMs: 5 } }, dirs: { [bdir]: [{ name: 'packs.json', kind: 'file' }] }, files: { [`${bdir}/packs.json`]: BINDER }, refs: { '/work/sample-repo': REFS } } })
  millionSession(on)
  await start($)
  const git = runs.filter(r => r.argv[0] === 'git')
  expect(git).toHaveLength(1)
  expect(git[0]!.argv.slice(1, 1 + SAFE_GIT.length)).toEqual(SAFE_GIT)
  expect(git[0]!.argv.slice(1 + SAFE_GIT.length, 3 + SAFE_GIT.length)).toEqual(['for-each-ref', '--format=%(refname)'])
  expect(git[0]!.env).toEqual({ GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
  const f = await frame($)
  expect(f.lines[row(f, /^hatch/)]).toMatch(/^hatch {7}packs · wave 2\/3/)
})

test('hatch outside the cwd repo: refs read from packed-refs and loose ref files, never git', async ($, on) => {
  const calls: Record<string, number> = {}
  const transcript: Transcript = { main: [] }
  const bdir = '/data/clone/.hatch/binders'
  const g = '/data/clone/.git'
  const loose = ['refs/heads/hatch/packs/item-api', 'refs/heads/hatch/packs/item-ui', 'refs/hatch/packs/item-ui/failed']
  const packed = ['# pack-refs with: peeled fully-peeled sorted', ...REFS.filter(r => !loose.includes(r)).map(r => `${'a'.repeat(40)} ${r}`), `^${'b'.repeat(40)}`, `${'c'.repeat(40)} refs/heads/main`].join('\n')
  const dirs: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
    [bdir]: [{ name: 'packs.json', kind: 'file' }],
    [`${g}/refs/heads/hatch`]: [{ name: 'packs', kind: 'dir' }],
    [`${g}/refs/heads/hatch/packs`]: [{ name: 'item-api', kind: 'file' }, { name: 'item-ui', kind: 'file' }],
    [`${g}/refs/hatch`]: [{ name: 'packs', kind: 'dir' }],
    [`${g}/refs/hatch/packs`]: [{ name: 'item-ui', kind: 'dir' }],
    [`${g}/refs/hatch/packs/item-ui`]: [{ name: 'failed', kind: 'file' }],
  }
  world(on, { branch: 'main', extra: { calls, transcript, dirs, stats: { [bdir]: { kind: 'dir', mtimeMs: 5 } }, files: { [`${bdir}/packs.json`]: BINDER }, refs: { '/data/clone': REFS }, repos: [{ root: '/data/clone', packed }] } })
  millionSession(on)
  await start($)
  transcript.main.push(said({ tool: 'Read', input: { file_path: '/data/clone/a.ts' } }))
  await complete($)
  expect(calls['run:/data/clone']).toBeUndefined()
  const f = await frame($)
  expect(f.lines[row(f, /^hatch/)]).toMatch(/^hatch {7}packs · wave 2\/3/)
})

// ---------------------------------------------------------------- terminal escapes: printable text only

const CTRL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/

test('printable: drops ESC sequences, C0, DEL, C1 and bidi controls; keeps José and CJK', () => {
  const printable = drawModule.printable
  expect(printable('a\x1b[31mred\x1b[0m!')).toBe('ared!')
  expect(printable('\x1b]0;pwned\x07title')).toBe('title')
  expect(printable('\x1b]8;;http://x.example\x1b\\link\x1b]8;;\x1b\\')).toBe('link')
  expect(printable('x\x1bcy\x1b(Bz')).toBe('xyz')
  expect(printable('a‮b⁦c⁩d‪e')).toBe('abcde')
  expect(printable('t\x00a\tb\nc\x7fd\x9b2Je\x85f')).toBe('tabcdef')
  expect(printable('\x9b31mred\x9d0;t\x9cok')).toBe('redok')
  expect(printable('José 日本語 — ⎇ ●')).toBe('José 日本語 — ⎇ ●')
  expect(printable('trailing \x1b')).toBe('trailing ')
})

test('cards and copied text show no control characters: a hostile path, branch, agent description and session status', async ($, on) => {
  const copies: string[] = []
  on('ui.copy', (_$, e) => (copies.push(e.text), { value: { isCopied: true } }))
  on('ui.toast', () => ({ value: undefined }))
  const evilDir = '/data/José-\x1b[2Jdeep-folder-‮name-that-is-long-enough-to-cut'
  const transcript: Transcript = { main: [said({ tool: 'Read', input: { file_path: `${evilDir}/x.txt` } })] }
  const dir = '/u/tester/.claude/sessions'
  world(on, {
    branch: 'main',
    steward: { registry: REGISTRY, sessionId: ID_A },
    extra: {
      transcript,
      repos: [{ root: evilDir, head: 'ref: refs/heads/fe\x1b]0;pwn\x07at‮ure-branch-that-is-also-quite-long\n' }],
      dirs: { [dir]: [{ name: '1.json', kind: 'file' }] },
      files: { [`${dir}/1.json`]: JSON.stringify({ sessionId: ID_B, name: 'beta-sec', status: 'bu\x1b[2Jsy', statusUpdatedAt: NOW }) },
      stats: { [`${dir}/1.json`]: { kind: 'file', mtimeMs: 1 } },
    },
  })
  millionSession(on)
  const agents = agentList(on)
  await start($)
  agents.push(listed({ id: 'ag-x', description: `ta\x1b[31msk‮ ${LONG_TASK}`, type: 'general-purpose', status: 'running' }))
  await agentStart($, 'ag-x')
  await complete($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const tree = await ui.drawn()
    // every string in the tree, and every Raster's cells
    const strings: string[] = []
    for (const el of allOf(tree)) {
      for (const k of el.children ?? []) if (typeof k === 'string') strings.push(k)
      if (el.type === 'Raster') strings.push(...decode(el.props!).lines)
    }
    for (const t of strings) expect(CTRL.test(t), JSON.stringify(t)).toBe(false)
    // every placed card, hidden or pinned open by an earlier press
    const cards = ((tree as El).children ?? []).filter(k => (k as El)?.type === 'Box' && (k as El).props?.position === 'absolute') as El[]
    const cardTexts = cards.map(c => (c.children ?? []).map(textOf).join('\n'))
    const all = squash(cardTexts.join('\n'))
    expect(all).toContain('/data/José-deep-folder-name-that-is-long-enough-to-cut')
    expect(all).toContain('feature-branch-that-is-also-quite-long')
    expect(all).toContain(squash(`task ${LONG_TASK}`))
    for (const b of copyButtons(tree)) await ui.press({ key: b.props!.key as string })
    await ui.unmount()
  }
  expect(copies.length).toBeGreaterThan(0)
  // one field per line: the newlines between them are the only control characters
  for (const c of copies) for (const l of c.split('\n')) expect(CTRL.test(l), JSON.stringify(c)).toBe(false)
  expect(copies.some(c => c.includes('/data/José-deep-folder-name-that-is-long-enough-to-cut'))).toBe(true)
  // rows: the stored values lose the escape sequence whole, not only its ESC
  const f = await frame($)
  expect(stewardRows(f).find(l => l.includes('beta-sec'))).toMatch(/beta-sec\s+busy\b/)
  expect(f.lines.some(l => l.includes('task Survey'))).toBe(true)
  expect(f.lines.some(l => /\[2J|\[31m|0;pwn/.test(l))).toBe(false)
})

test('a raster cell never holds a control or bidi character, whatever reaches draw', () => {
  const v = base({ cwd: '/work/a\x1b[2Jb', model: 'claude-‮opus', folders: [folder({ name: 'x\x1by', key: '/work/x\x1b[31my', isRepo: true, branch: 'b\x9br⁦' })] })
  const parts = drawModule.drawParts(v, 48, 60)
  for (const p of parts.pieces) if ('screen' in p) for (const l of p.screen.lines()) expect(CTRL.test(l), JSON.stringify(l)).toBe(false)
  for (const c of paneCardsOf(parts)) {
    for (const l of c.text.split('\n')) expect(CTRL.test(l), JSON.stringify(c.text)).toBe(false)
    for (const l of c.lines) expect(CTRL.test(l), JSON.stringify(l)).toBe(false)
  }
})
