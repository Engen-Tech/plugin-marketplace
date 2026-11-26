import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import * as drawModule from './draw'
import * as stewardModule from './steward'
import { register } from './register'
import { PRESETS, layout, parsePalette } from './draw'
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
type Extra = { reads?: string[]; files?: Record<string, string>; appTheme?: string; quotaDir?: string }
type Steward = { registry?: string; mtime?: number; sessionId?: string; peers?: { name: string; status: string }[]; logMtime?: number; reads?: string[]; dir?: string }

function world(on: On, opts: { model?: string; branch?: string; profile?: string; quotas?: Quota[]; git?: { changes: number; ahead?: number; worktree?: boolean }; steward?: Steward; extra?: Extra } = {}) {
  const ex = opts.extra ?? {}
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
    HOME: '/u/tester',
    HOSTNAME: 'host1',
    ...(opts.profile ? { CLAUDE_PROFILE: opts.profile } : {}),
    ...(st?.dir ? { STEWARD_ORCHESTRATION_DIR: st.dir } : {}),
  })
  const regPath = `${st?.dir ?? '/u/tester/.claude/orchestration'}/initiatives.md`
  on('session.id', () => ({ value: st?.sessionId ?? '99999999-9999-4999-8999-999999999999' }))
  on('fs.stat', (_, e) => {
    if (st?.registry !== undefined && e.path === regPath) return { value: { kind: 'file' as const, size: st.registry.length, mtimeMs: st.mtime ?? 1, isLink: false } }
    if (st?.logMtime !== undefined && e.path === '/u/tester/notes/widget-log.md') return { value: { kind: 'file' as const, size: 1, mtimeMs: st.logMtime, isLink: false } }
    throw new Error('ENOENT')
  })
  if (st?.peers) {
    const peers = st.peers
    on('tool.call', (_, e) =>
      e.tool === 'ListAgents'
        ? { result: { listing: '', sections: [{ kind: 'sessions', total: peers.length, rows: peers }] } as never, text: '' }
        : { result: {}, text: '' },
    )
  }
  mock.clock(on, { now: NOW })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: opts.model ?? 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: opts.git?.worktree ? '/work/sample-repo/.worktrees/feat-x' : '/work/sample-repo' }))
  if (opts.branch || opts.git) {
    const branch = opts.branch ?? 'main'
    const root = opts.git?.worktree ? '/work/sample-repo/.worktrees/feat-x' : '/work/sample-repo'
    const mainRoot = opts.git?.worktree ? '/work/sample-repo' : null
    on('vcs.detect', () => ({ vcs: 'git', root, mainRoot, revision: null, branch, defaultBranch: 'main', remote: null }))
  }
  if (opts.git) {
    const g = opts.git
    on('vcs.status', () => ({
      changes: Array.from({ length: g.changes }, (_, i) => ({ path: `f${i}.ts`, state: 'modified' as const })),
      unpublished: g.ahead ?? 0,
    }))
    on('vcs.diff', () => ({
      base: 'HEAD',
      files: Array.from({ length: g.changes }, (_, i) => ({ path: `f${i}.ts`, renamedFrom: null, added: 40, removed: 10, isBinary: false, isUntracked: false })),
    }))
  }
  on('fs.list', (_, e) => {
    if (e.path !== quotaDir || !opts.quotas) throw new Error('ENOENT')
    return { value: opts.quotas.map(q => ({ name: `${q.profile}.json`, kind: 'file' as const, size: 10 })) as never }
  })
  on('fs.read', (_, e) => {
    ex.reads?.push(e.path)
    if (ex.files?.[e.path] !== undefined) return { value: ex.files[e.path]! }
    if (st?.registry !== undefined && e.path === regPath) {
      st.reads?.push(e.path)
      return { value: st.registry }
    }
    const q = opts.quotas?.find(x => e.path === `${quotaDir}/${x.profile}.json`)
    if (!q) throw new Error('ENOENT')
    return { value: JSON.stringify(q) }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { opened, closed }
}

const TOOLS_KEY = 'stackwell-tools'

/** The whole pane for `cols` content columns and `rows` body rows: the Rasters with the tools Button row between. */
async function rawAt($: Engine, cols = 48, rows = 47): Promise<Frame> {
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: cols + 5, scroll: { offset: 0, bodyRows: rows } }, surface: 'terminal' })
  const rasters = await ui.findAll({ type: 'Raster' })
  const button = await ui.find({ key: TOOLS_KEY })
  await ui.unmount()
  expect(rasters.length).toBeGreaterThan(0)
  const parts = rasters.map(r => decode(r.props))
  const top = parts[0]!
  if (!button) return top
  const bottom = parts[1]!
  const w = top.w
  const mid = '  ' + Array.from(button.text ?? '').concat(Array(w).fill(' ')).slice(0, w - 4).join('') + '  '
  const lines = [...top.lines, mid, ...bottom.lines]
  const fg = (x: number, y: number) =>
    y < top.lines.length ? top.fg(x, y) : y === top.lines.length ? undefined : bottom.fg(x, y - top.lines.length - 1)
  return { lines, fg, w }
}
const frameAt = async ($: Engine, cols = 48, rows = 47) => inner(await rawAt($, cols, rows))
const frame = ($: Engine) => frameAt($, 48)

const start = ($: Engine) => $.session.start({ cwd: '/work/sample-repo', surface: 'terminal', isInteractive: true })
const complete = ($: Engine) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

type Limit = { kind: string; percentUsed: number; resetsAt?: string }
const measure = ($: Engine, percent: number, rateLimits: Limit[] = [], window = 200_000) =>
  $.session.measure({
    context: { tokens: Math.round((percent / 100) * window), window, percent },
    rateLimits,
    cost: { usd: 1.23 },
    changed: ['context', 'rateLimits', 'cost'],
  })

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
  on('tool.call', (_, e) => {
    const isFail = e.tool === 'Bash' && String((e as { command?: string }).command).startsWith('false')
    return isFail ? { result: {}, isError: true, text: 'Exit code 1' } : { result: {}, text: '' }
  })
  await start($)
  for (const c of ['ls', 'false a', 'false b']) await $.tool.call({ tool: 'Bash', command: c })
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  await $.tool.call({ tool: 'Read', file_path: '/b' })
  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'x', new_string: 'y' })
  await complete($)
  const f = await frame($)
  const text = f.lines.map(l => l.trimEnd()).join('\n').trimEnd()
  expect(text).toBe(
    [
      'Opus 5.5 (1M)'.padEnd(44) + 'main',
      '',
      'context'.padEnd(33) + '312k / 1M   31%',
      '━'.repeat(15) + '─'.repeat(29) + '┊' + '─'.repeat(3),
      '▪ msgs 240k  ▪ tools 40k  ▪ sys 18k  ▪ other 14k',
      '',
      'quota 7d    ' + '━'.repeat(6) + '─'.repeat(7) + '│' + '─'.repeat(10) + '  23%   3d5h',
      '',
      'session     $1.23 est · $1.0/h · 1h12m',
      'cost        ▁' + 'turn 1 · 0.0s'.padStart(35),
      '',
      '▸ tools     6 calls'.padEnd(45) + '✕ 2',
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

test('header: model, branch dim, and the running tool only while it runs', async ($, on) => {
  world(on, { branch: 'feat/x' })
  millionSession(on)
  let seen = ''
  on('tool.call', async () => {
    const f = await frame($)
    seen = f.lines[0]!
    return { result: {}, text: '' }
  })
  await start($)
  const idle = (await frame($)).lines[0]!
  expect(idle.trimEnd()).toMatch(/^Opus 5\.5 \(1M\)\s+feat\/x$/)
  expect(idle).not.toContain('running')
  await $.tool.call({ tool: 'Bash', command: 'sleep 1' })
  expect(seen.trimEnd()).toMatch(/feat\/x · running Bash$/)
  const after = await frame($)
  expect(after.lines[0]).not.toContain('running')
  const f = after
  const bx = f.lines[0]!.indexOf('feat/x')
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

test('after a compact the legend shows the reduction until the next turn completes', async ($, on) => {
  world(on)
  millionSession(on)
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 176_000, tokensAfter: 44_000 }))
  await start($)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  let f = await frame($)
  const y = row(f, /compacted/)
  expect(f.lines[y]!.trimEnd()).toBe('compacted · 176k → 44k')
  expect(f.fg(0, y)).toBe(P.dim)
  expect(f.lines.join('\n')).not.toContain('▪ msgs')
  await complete($)
  f = await frame($)
  expect(f.lines.join('\n')).not.toContain('compacted')
  expect(f.lines.join('\n')).toContain('▪ msgs')
})

test('a precompute is not a compaction', async ($, on) => {
  world(on)
  on('session.compact', () => ({ messages: SUMMARY }))
  await measure($, 30)
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  expect((await frame($)).lines.join('\n')).not.toContain('compacted')
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

test('the Bash ✕ appears only when a Bash call failed', async ($, on) => {
  world(on)
  let isFail = false
  on('tool.call', () => (isFail ? { result: {}, isError: true, text: 'Exit code 2' } : { result: {}, text: '' }))
  await measure($, 30)
  await run($, 'tools')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Read', file_path: '/x' })
  let f = await frame($)
  let y = row(f, /^▾ tools/)
  expect(f.lines[y]).toContain('Bash 1')
  expect(f.lines[y]).not.toContain('✕')
  isFail = true
  await $.tool.call({ tool: 'Bash', command: 'false' })
  f = await frame($)
  y = row(f, /^▾ tools/)
  expect(f.lines[y]!.trimEnd()).toMatch(/Bash 2  Read 1\s+✕ 1$/)
})

test('the tool.call hook returns what next answered, unchanged', async ($, on) => {
  world(on)
  const answer = { result: { stdout: 'hi', stderr: '' }, text: 'hi' }
  on('tool.call', () => answer)
  const got = await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(got).toEqual(answer)
})

test('narrow widths never exceed the width', async ($, on) => {
  world(on, { branch: 'a-very-long-branch-name-indeed', profile: 'me', quotas: [{ profile: 'beta-with-a-long-name', seven_day: { used_percentage: 97 }, updated_at_epoch: NOW / 1000 }] })
  millionSession(on, { limits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 2 * H).toISOString() }, d7(23)] })
  on('tool.call', () => ({ result: {}, text: '' }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Read', file_path: '/x' })
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'mcp__plugin_long__some_tool' } as never)
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
    toolCounts: { Bash: 1234, Read: 999, mcp__plugin_long__some_long_tool_name: 77, Edit: 5 }, bashFails: 123,
    running: [{ id: '1', tool: 'mcp__plugin_long__some_long_tool_name' }],
    accounts: [{ name: 'an-account-with-a-very-long-name', d7: 99, h5: 97, d7At: NOW + H, updatedAt: NOW / 1000 }],
    now: NOW, theme: 'auto', palette: P, isToolsOpen: true,
    trend: [100_000, 300_000, 500_000, 912_345], turnCosts: [1, 20, 300], costAtTurn: 1234.56, turns: 1234, lastTurnMs: 7_654_321,
    git: { files: 12345, added: 999_999, removed: 888_888, ahead: 77, worktree: 'a-very-long-worktree-name' },
    agents: [
      { id: 'a', name: 'a-very-long-agent-description-here', model: 'sonnet', isBackground: true, status: 'running', startedAt: NOW - 100 * H },
      { id: 'b', name: 'done-agent-with-long-name', model: 'opus', isBackground: false, status: 'failed', startedAt: NOW - H, endedAt: NOW - 60_000 },
    ],
    log: [{ id: 'l', at: NOW, tool: 'mcp__plugin_long__some_long_tool_name', target: 'a/very/long/target/path/that/goes/on', ms: 123_456, status: 'failed' }],
  }
  for (const W of [12, 20, 30, 38, 43, 44, 48]) {
    for (const r of layout(v, W)) {
      const width = r.reduce((a, s) => a + Array.from(s.text).length, 0)
      expect(width, `width ${W}: ${r.map(s => s.text).join('')}`).toBeLessThanOrEqual(W)
    }
  }
  for (const r of layout({ ...v, compact: { before: 976_000, after: 44_000 } }, 20))
    expect(r.reduce((a, s) => a + Array.from(s.text).length, 0)).toBeLessThanOrEqual(20)
})

test('elapsed time shows after a turn even without a session start (hot reload)', async ($, on) => {
  world(on)
  millionSession(on)
  await measure($, 31, [d7(23)], 1_000_000)
  await complete($)
  const f = await frame($)
  expect(f.lines[row(f, /^session/)]).toContain('1h12m')
})

test('each group label, the tool counts and the cost take the group hue; names, units, header and accounts stay neutral', async ($, on) => {
  world(on, { branch: 'main', git: { changes: 1 }, profile: 'me', quotas: [{ profile: 'beta', seven_day: { used_percentage: 82 }, updated_at_epoch: NOW / 1000 }] })
  millionSession(on, { limits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 2 * H).toISOString() }, d7(23)] })
  on('tool.call', () => ({ result: {}, text: '' }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
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
  expect(f.fg(f.lines[0]!.indexOf('main'), 0)).toBe(P.dim)
  const ya = row(f, /^acct beta/)
  expect(all(ya, 0, 8)).toEqual(new Set([P.dim]))
  const yg = row(f, /^git/)
  expect(all(yg, 0, 3)).toEqual(new Set([P.git]))
})

// ---------------------------------------------------------------- the fuller pane (pure layout)

const M = 60_000

function base(over: Partial<StackwellView> = {}): StackwellView {
  return {
    profile: 'me', model: 'claude-opus-5-5', branch: 'main', tokens: 131_000, window: 1_000_000, percent: 13,
    quotas: [], toolCounts: {}, bashFails: 0, running: [], accounts: [],
    breakdown: { msgs: 79_000, tools: 7_000, sys: 3_000, other: 42_000, raw: 1_000_000, autoCompact: 917_000 },
    trend: [], turnCosts: [], turns: 0, agents: [], log: [], isToolsOpen: true,
    now: NOW, theme: 'auto', palette: P, ...over,
  }
}
type LRow = ReturnType<typeof layout>[number]
const txt = (r: LRow) => r.map(s => s.text).join('').trimEnd()
const lines = (v: StackwellView, W = 48, Hh = 200) => layout(v, W, Hh).map(txt)
const find = (v: StackwellView, re: RegExp, W = 48, Hh = 200) => layout(v, W, Hh).find(r => re.test(txt(r)))
/** The colour of the segment that holds `text`. */
const colourOf = (r: LRow | undefined, text: string) => r?.find(s => s.text.includes(text))?.fg

test('trend: sparkline in a dimmer context step, growth and turns left before auto-compact', () => {
  const v = base({ trend: [86_000, 95_000, 104_000, 113_000, 122_000, 131_000] })
  const r = find(v, /^trend/)!
  expect(txt(r)).toMatch(/^trend\s+▁▂▄▅▇█\s+\+9k\/turn · ~87 turns left$/)
  expect(colourOf(r, '▁')).toBe(P.steps[1])
  expect(colourOf(r, 'trend')).toBe(P.context)
  expect(colourOf(r, '/turn')).toBe(P.dim)
  // short of room the unit shortens to `turns`
  expect(layout(v, 30).map(txt).find(l => l.startsWith('trend'))).toMatch(/\+9k\/turn · ~87 turns$/)
})

test('trend: projection hidden when growth is zero or less, or past 999 turns', () => {
  expect(txt(find(base({ trend: [140_000, 135_000, 131_000] }), /^trend/)!)).toMatch(/−5k\/turn$/)
  expect(txt(find(base({ trend: [131_000, 131_000] }), /^trend/)!)).toMatch(/\+0\/turn$/)
  expect(txt(find(base({ trend: [130_500, 131_000] }), /^trend/)!)).not.toContain('compact')
  expect(lines(base({ trend: [131_000] })).some(l => l.startsWith('trend'))).toBe(false)
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

test('session: $/h hidden under five minutes; cost row with turn stats', () => {
  const v = base({ costUsd: 47.04, startedAt: NOW - (2 * 60 + 11) * M, turnCosts: [0.1, 0.5, 1, 0.2], turns: 14, lastTurnMs: 130_000, trend: [119_000, 131_000] })
  expect(lines(v).find(l => l.startsWith('session'))).toBe('session     $47.04 est · $22/h · 2h11m')
  const c = find(v, /^cost/)!
  expect(txt(c)).toMatch(/^cost\s+▂▅█▂\s+turn 14 · 2m10s · \+12k$/)
  expect(colourOf(c, '█')).toBe(P.sessionStep)
  expect(colourOf(c, 'cost')).toBe(P.session)
  expect(colourOf(c, 'turn')).toBe(P.dim)
  const early = base({ costUsd: 0.5, startedAt: NOW - 4 * M })
  expect(lines(early).find(l => l.startsWith('session'))).toBe('session     $0.50 est · 4m')
  expect(lines(early).some(l => l.startsWith('cost'))).toBe(false)
})

test('git: files, lines, ahead, worktree; zeros omitted; hidden outside a repo', () => {
  const g = (git: StackwellView['git']) => lines(base({ git })).find(l => l.startsWith('git'))
  expect(g({ files: 3, added: 120, removed: 40, ahead: 2 })).toBe('git         3 files  +120 −40  ↑2')
  expect(g({ files: 1, added: 5, removed: 0, ahead: 0, worktree: 'feat-x' })).toBe('git         1 file  +5 −0  wt feat-x')
  expect(g({ files: 0, added: 0, removed: 0, ahead: 0 })).toBe('git         clean')
  expect(g(undefined)).toBeUndefined()
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
  expect(all[i + 1]).toMatch(/^            bg bgjob\s+3m$/)
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

const logOf = (n: number): StackwellView['log'] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), at: NOW - (n - i) * M, tool: 'Bash', target: `cmd ${i}`, ms: 400, status: 'ok' as const }))

test('tool log: newest first, time, tool in the tools hue, failed in warn with ✕', () => {
  const log: StackwellView['log'] = [
    { id: 'a', at: NOW - 2 * M, tool: 'Bash', target: 'git status --short', ms: 400, status: 'ok' },
    { id: 'b', at: NOW - M, tool: 'Edit', target: 'register.tsx', ms: 1500, status: 'failed' },
    { id: 'c', at: NOW, tool: 'Read', target: 'draw.ts', status: 'running' },
  ]
  const v = base({ toolCounts: { Bash: 1, Edit: 1, Read: 1 }, bashFails: 0, log })
  const rows = layout(v, 48, 200)
  const t = rows.findIndex(r => txt(r).startsWith('▾ tools'))
  expect(rows.slice(t + 1).map(txt)).toEqual([
    `${hhmm(NOW)}  Read  draw.ts` + '…'.padStart(28),
    `${hhmm(NOW - M)}  Edit  register.tsx` + '✕ 1.5s'.padStart(23),
    `${hhmm(NOW - 2 * M)}  Bash  git status --short` + '0.4s'.padStart(17),
  ])
  expect(colourOf(rows[t + 2], 'Edit')).toBe(P.tools)
  expect(colourOf(rows[t + 2], '1.5s')).toBe(P.warn)
  expect(colourOf(rows[t + 3], '0.4s')).toBe(P.dim)
  expect(colourOf(rows[t + 3], hhmm(NOW - 2 * M))).toBe(P.dim)
})

test('the tool log never takes more rows than there are', () => {
  const v = base({ toolCounts: { Bash: 30 }, log: logOf(30) })
  for (const Hh of [8, 12, 20, 30, 45]) {
    const rows = layout(v, 48, Hh)
    expect(rows.length, `rows ${Hh}`).toBeLessThanOrEqual(Hh)
  }
  const full = layout(v, 48, 200).map(txt)
  expect(full.filter(l => / {2}Bash {2}cmd/.test(l)).length).toBe(30)
})

test('a short height drops, in order: log, finished agents, cost row, accounts, git, trend', () => {
  const v = base({
    costUsd: 5, startedAt: NOW - H, turnCosts: [1, 2], turns: 2, lastTurnMs: 1000,
    trend: [100_000, 131_000],
    quotas: [{ kind: 'seven_day', pct: 20 }],
    accounts: [{ name: 'beta', d7: 12, updatedAt: NOW / 1000 }],
    git: { files: 1, added: 1, removed: 1, ahead: 0 },
    agents: [
      { id: '1', name: 'runner', isBackground: false, status: 'running', startedAt: NOW - M },
      { id: '2', name: 'doner', isBackground: false, status: 'ok', startedAt: NOW - 2 * M, endedAt: NOW - M },
    ],
    toolCounts: { Bash: 5 }, log: logOf(5),
    steward: { role: 'primary', initiative: 'widget-release', peers: [{ name: 'beta-sec', role: 'secondary', status: 'busy' }], logMtime: NOW - 12 * M },
  })
  const has = (Hh: number) => {
    const all = lines(v, 48, Hh)
    expect(all.length, `rows ${Hh}`).toBeLessThanOrEqual(Hh)
    return {
      log: all.some(l => /cmd \d/.test(l)), done: all.some(l => l.includes('doner')), cost: all.some(l => l.startsWith('cost')),
      acct: all.some(l => l.startsWith('acct')), git: all.some(l => l.startsWith('git')), trend: all.some(l => l.startsWith('trend')),
      runner: all.some(l => l.includes('runner')),
      tools: all.some(l => /^. tools/.test(l)),
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
    for (const k of ['log', 'done', 'tools', 'cost', 'acct', 'git', 'slog', 'speer', 'trend'] as const) if (prev[k] && !now[k]) seen.push(k)
    prev = now
  }
  expect(seen).toEqual(['log', 'done', 'tools', 'cost', 'acct', 'git', 'slog', 'speer', 'trend'])
})

test('the realistic full state fits 48 x 40', () => {
  const v = base({
    costUsd: 47.04, startedAt: NOW - (2 * 60 + 11) * M, turnCosts: [0.2, 0.4, 0.4, 1, 0.6, 0.2, 0.4, 1.4, 0.4, 0.2], turns: 14, lastTurnMs: 130_000,
    trend: [86_000, 88_000, 95_000, 99_000, 104_000, 108_000, 113_000, 119_000, 122_000, 131_000],
    quotas: [{ kind: 'seven_day', pct: 44, resetsAt: NOW + (3 * 24 + 4) * H + M }],
    accounts: [{ name: 'beta', d7: 12, d7At: NOW + (5 * 24 + 1) * H + M, updatedAt: NOW / 1000 }],
    git: { files: 3, added: 120, removed: 40, ahead: 2 },
    agents: [
      { id: '1', name: 'researcher', model: 'sonnet', isBackground: false, status: 'running', startedAt: NOW - M },
      { id: '2', name: 'coder', model: 'opus', isBackground: false, status: 'ok', startedAt: NOW - 8 * M, endedAt: NOW - 4 * M },
    ],
    toolCounts: { Bash: 3, SendMessage: 1 }, bashFails: 2, log: logOf(30),
  })
  const rows = layout(v, 48, 40)
  expect(rows.length).toBe(40)
  for (const r of rows) expect(Array.from(r.map(s => s.text).join('')).length).toBeLessThanOrEqual(48)
})

// ---------------------------------------------------------------- collection through the engine

test('turn ends record the context trend and the per-turn cost', async ($, on) => {
  world(on)
  let tokens = 100_000, usd = 1
  on('session.usage', () => ({ value: { startedAt: NOW - H, context: { tokens, window: 1_000_000, percent: 10 }, rateLimits: [], cost: { usd } } }))
  await start($)
  tokens = 110_000; usd = 1.5
  await $.turn.complete({ answer: '', durationMs: 65_000, isAborted: false, turnId: 't1', reason: 'answer' })
  tokens = 125_000; usd = 2.5
  await $.turn.complete({ answer: '', durationMs: 5_000, isAborted: false, turnId: 't2', reason: 'answer' })
  const f = await frame($)
  expect(f.lines[row(f, /^trend/)]!.trimEnd()).toMatch(/^trend\s+▁█\s+\+15k\/turn · ~53 turns left$|^trend\s+▁█\s+\+15k\/turn$/)
  expect(f.lines[row(f, /^cost/)]!.trimEnd()).toMatch(/turn 2 · 5\.0s · \+15k$/)
})

test('git is read at session start and turn end; no row outside a repo', async ($, on) => {
  world(on, { git: { changes: 2, ahead: 1, worktree: true } })
  millionSession(on)
  await start($)
  const f = await frame($)
  expect(f.lines[row(f, /^git/)]!.trimEnd()).toBe('git         2 files  +80 −20  ↑1  wt feat-x')
})

test('no git row outside a repo', async ($, on) => {
  world(on)
  millionSession(on)
  await start($)
  expect((await frame($)).lines.some(l => l.startsWith('git'))).toBe(false)
})

test('a background agent stays running until its own turn.complete; a sync one finishes on return', async ($, on) => {
  world(on)
  millionSession(on)
  on('tool.call', (_, e) => {
    const input = e as unknown as { run_in_background?: boolean; description?: string }
    if (input.run_in_background)
      return { result: { status: 'async_launched', agentId: 'ag-bg', description: input.description, prompt: 'p', outputFile: '/o' } as never, text: 'launched' }
    return { result: { status: 'completed', agentId: 'ag-sync', content: [], prompt: 'p' } as never, text: 'done' }
  })
  await start($)
  await $.tool.call({ tool: 'Agent', description: 'survey', prompt: 'p', run_in_background: true, model: 'haiku' } as never)
  await $.tool.call({ tool: 'Agent', description: 'coder', prompt: 'p', subagent_type: 'example.coder' } as never)
  let f = await frame($)
  let all = f.lines.map(l => l.trimEnd())
  expect(all.find(l => l.includes('survey'))).toMatch(/bg survey  haiku\s+0m$/)
  expect(all.find(l => l.includes('coder'))).toMatch(/✓ coder\s+0m$/)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer', agentId: 'ag-bg' } as never)
  f = await frame($)
  all = f.lines.map(l => l.trimEnd())
  expect(all.find(l => l.includes('survey'))).toMatch(/✓ survey  haiku\s+0m$/)
})

test('tool calls fill the log through the engine, newest first, with targets', async ($, on) => {
  world(on)
  millionSession(on)
  on('tool.call', () => ({ result: {}, text: '' }))
  await start($)
  await run($, 'tools')
  await $.tool.call({ tool: 'Bash', command: 'FOO=1 git status --short --branch' })
  await $.tool.call({ tool: 'Read', file_path: '/work/x/register.tsx' })
  await $.tool.call({ tool: 'Grep', pattern: 'readUsage' } as never)
  const f = await frame($)
  const t = row(f, /^▾ tools/)
  expect(f.lines.slice(t + 1, t + 4).map(l => l.slice(7).trimEnd().replace(/\s+\S+$/, ''))).toEqual([
    'Grep  readUsage', 'Read  register.tsx', 'Bash  git status --short --branch',
  ])
})

// ---------------------------------------------------------------- tools, collapsed and open

test('tools row: collapsed by default with the call count; open shows counts and the log (pure)', () => {
  const log = logOf(3)
  const closed = layout(base({ toolCounts: { Bash: 30, Read: 12 }, bashFails: 2, log, isToolsOpen: false }), 48, 200)
  const c = closed.find(r => txt(r).startsWith('▸'))!
  expect(txt(c)).toBe('▸ tools     42 calls'.padEnd(45) + '✕ 2')
  expect(colourOf(c, 'tools')).toBe(P.tools)
  expect(colourOf(c, 'calls')).toBe(P.dim)
  expect(colourOf(c, '✕')).toBe(P.warn)
  expect(closed.map(txt).some(l => /cmd \d/.test(l))).toBe(false)
  expect(txt(layout(base({ toolCounts: { Bash: 1 }, isToolsOpen: false }), 48).find(r => txt(r).startsWith('▸'))!)).toBe('▸ tools     1 call')
  const open = layout(base({ toolCounts: { Bash: 30, Read: 12 }, bashFails: 2, log, isToolsOpen: true }), 48, 200)
  const i = open.findIndex(r => txt(r).startsWith('▾'))
  expect(txt(open[i]!)).toBe('▾ tools     Bash 30  Read 12'.padEnd(45) + '✕ 2')
  expect(colourOf(open[i], 'Bash')).toBe(P.dim)
  expect(colourOf(open[i], '30')).toBe(P.tools)
  expect(open.slice(i + 1).map(txt).filter(l => /cmd \d/.test(l)).length).toBe(3)
})

test('the tools row is a Button: a click toggles it, and so does /stackwell tools', async ($, on) => {
  world(on)
  millionSession(on)
  on('tool.call', () => ({ result: {}, text: '' }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  let f = await frame($)
  expect(f.lines.some(l => l.startsWith('▸ tools'))).toBe(true)
  expect(f.lines.some(l => / {2}Bash {2}ls/.test(l))).toBe(false)
  // the click path: press the Button by its key
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: TOOLS_KEY })
  await ui.unmount()
  f = await frame($)
  expect(f.lines.some(l => l.startsWith('▾ tools'))).toBe(true)
  expect(f.lines.some(l => / {2}Bash {2}ls/.test(l))).toBe(true)
  // the command path
  const out = await run($, 'tools')
  expect(out.text).toContain('closed')
  f = await frame($)
  expect(f.lines.some(l => l.startsWith('▸ tools'))).toBe(true)
})

test('the open choice survives a reload', async ($, on) => {
  world(on)
  millionSession(on)
  on('tool.call', () => ({ result: {}, text: '' }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await run($, 'tools')
  await start($)
  expect((await frame($)).lines.some(l => l.startsWith('▾ tools'))).toBe(true)
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
    steward: { registry: REGISTRY, sessionId: ID_A, logMtime: NOW - 12 * 60_000, peers: [{ name: 'beta-sec', status: 'busy' }, { name: 'gamma-sec', status: 'offline' }] },
  })
  millionSession(on)
  await start($)
  const f = await frame($)
  expect(stewardRows(f)).toEqual([
    'steward     ★ widget-release',
    '  ├─ beta-sec'.padEnd(44) + 'busy',
    '  ├─ gamma-sec'.padEnd(41) + 'offline',
    '  └─ log 12m ago',
  ])
  const y = row(f, /^steward/)
  expect(f.fg(0, y)).toBe(P.steward)
  expect(f.fg(f.lines[y + 1]!.indexOf('busy'), y + 1)).toBe(P.text)
  expect(f.fg(f.lines[y + 2]!.indexOf('offline'), y + 2)).toBe(P.dim)
  // after the session group, before git and agents
  expect(y).toBeGreaterThan(row(f, /^session/))
})

test('steward: secondary view, matched by the session id inside a messy cell', async ($, on) => {
  world(on, { steward: { registry: REGISTRY, sessionId: ID_B } })
  millionSession(on)
  await start($)
  expect(stewardRows(await frame($))).toEqual([
    'steward     widget-release',
    '  ↑  alpha-main',
    '  └─ gamma-sec',
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
  ['bra', 'hma'], ['stack', 'house'], ['home', 'lab'], ['ut', 'ils/'], ['status', 'line.sh'], ['ghost', 'ty']].map(p => p.join(''))
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

test('no local names, paths or real ids in the shipped code', () => {
  const sources = [register, ...Object.values(drawModule), ...Object.values(stewardModule)]
    .filter(x => typeof x === 'function' || (typeof x === 'object' && x !== null))
    .map(x => (typeof x === 'function' ? String(x) : JSON.stringify(x)))
  sources.push(JSON.stringify(PRESETS), REGISTRY, JSON.stringify(drawModule.THEMES))
  const text = sources.join('\n').toLowerCase()
  for (const w of LOCAL) expect(text.includes(w), w).toBe(false)
  // test fixtures use patterned ids only
  for (const id of REGISTRY.match(UUID) ?? []) expect(/^(\d)\1{7}-/.test(id), id).toBe(true)
})

// ---------------------------------------------------------------- spacing and names

test('every group label has at least 2 spaces before its content, at widths 30 to 60', () => {
  const v = base({
    costUsd: 5, startedAt: NOW - H, turnCosts: [1, 2], turns: 2, lastTurnMs: 1000, trend: [100_000, 131_000],
    quotas: [{ kind: 'five_hour', pct: 10, resetsAt: NOW + H }, { kind: 'seven_day', pct: 20, resetsAt: NOW + 24 * H }],
    accounts: [{ name: 'work-account', d7: 12, d7At: NOW + H, updatedAt: NOW / 1000 }],
    git: { files: 1, added: 1, removed: 1, ahead: 0 },
    agents: [{ id: '1', name: 'runner', isBackground: false, status: 'running', startedAt: NOW - M }],
    toolCounts: { Bash: 5 }, log: logOf(2),
    steward: { role: 'primary', initiative: 'widget-release', peers: [{ name: 'beta-sec', role: 'secondary', status: 'busy' }] },
  })
  const LABEL = /^(context|ctx|trend|quota \w+|5h|7d|acct [\w…-]+|work[\w…-]*|session|sess|cost|steward|stw|git|agents|agt|[▸▾] tools)( *)(\S)/
  for (const isOpen of [false, true])
    for (let W = 30; W <= 60; W++) {
      const rows = layout({ ...v, isToolsOpen: isOpen }, W, 200).map(txt)
      let seen = 0
      for (const l of rows) {
        const m = LABEL.exec(l)
        if (!m) continue
        seen++
        expect(m[2]!.length, `width ${W}: "${l}"`).toBeGreaterThanOrEqual(2)
      }
      expect(seen, `width ${W}`).toBeGreaterThanOrEqual(10)
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

test('tool log: the name column fits the longest name shown (cap 16); MCP shows tool then server', () => {
  const log: StackwellView['log'] = [
    { id: 'a', at: NOW - 2 * M, tool: 'ListAgents', target: '', ms: 100, status: 'ok' },
    { id: 'b', at: NOW - M, tool: 'mcp__chrome-devtools__evaluate_script', target: 'chrome-devtools', ms: 300, status: 'ok' },
    { id: 'c', at: NOW, tool: 'Bash', target: 'ls -la', ms: 200, status: 'ok' },
  ]
  const v = base({ toolCounts: { Bash: 1, ListAgents: 1 }, log })
  const rows = layout(v, 48, 200)
  const t = rows.findIndex(r => txt(r).startsWith('▾ tools'))
  const lines = rows.slice(t + 1).map(txt)
  // evaluate_script is 15 long: the column fits it whole
  expect(lines[0]).toBe(`${hhmm(NOW)}  Bash` + ' '.repeat(13) + 'ls -la' + '0.2s'.padStart(48 - 5 - 2 - 15 - 2 - 6))
  expect(lines[1]).toBe(`${hhmm(NOW - M)}  evaluate_script  chrome-devtools` + '0.3s'.padStart(48 - 5 - 2 - 15 - 2 - 15))
  // a longer name: the column caps at 16
  const capped = layout(base({ toolCounts: { Bash: 1 }, log: [{ ...log[1]!, tool: 'mcp__x__a_very_long_tool_name_here' }] }), 48, 200).map(txt)
  expect(capped.find(l => l.includes('a_very'))).toMatch(/^\d\d:\d\d {2}a_very_long_too… {2}chrome-devtools/)
  expect(lines[2]).toBe(`${hhmm(NOW - 2 * M)}  ListAgents` + '0.1s'.padStart(48 - 5 - 2 - 10))
  expect(colourOf(rows[t + 2], 'chrome-devtools')).toBe(P.dim)
  expect(colourOf(rows[t + 1], 'ls -la')).toBe(P.text)
  // a shorter name list: the column shrinks to it
  const short = layout(base({ toolCounts: { Bash: 1 }, log: [log[2]!, { ...log[0]!, tool: 'Read', target: 'a.md' }] }), 48, 200).map(txt)
  expect(short.find(l => l.includes('ls -la'))).toMatch(/^\d\d:\d\d {2}Bash {2}ls -la/)
  // narrow: the target shrinks first, the MCP server goes when there is no room
  const narrow = layout(v, 30, 200).map(txt)
  const mcp = narrow.find(l => l.includes('evaluate'))!
  expect(mcp).toMatch(/^\d\d:\d\d {2}evaluate_script/)
  expect(Array.from(mcp).length).toBeLessThanOrEqual(30)
})

test('an MCP call logs its server as the target', async ($, on) => {
  world(on)
  millionSession(on)
  on('tool.call', () => ({ result: {}, text: '' }))
  await start($)
  await run($, 'tools')
  await $.tool.call({ tool: 'mcp__chrome-devtools__evaluate_script', function: '() => 1' } as never)
  const f = await frame($)
  const t = row(f, /^▾ tools/)
  expect(f.lines[t + 1]).toMatch(/^\d\d:\d\d {2}evaluate_script {2}chrome-devtools/)
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
  world(on, { branch: 'main' })
  millionSession(on)
  on('tool.call', () => ({ result: {}, text: '' }))
  await start($)
  for (let i = 0; i < 30; i++) await $.tool.call({ tool: 'Bash', command: `echo ${i}` })
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
    for (const k of ['context', 'quota', 'tools', 'session', 'agents', 'git', 'steward'] as const)
      expect(ratio(p[k], p.bg), `${name} ${k}`).toBeGreaterThanOrEqual(4.5)
    expect(p.steps.length, `${name} steps`).toBe(4)
    expect(p.steps[0], `${name} steps[0]`).toBe(p.context)
    expect(ratio(p.steps[3]!, p.bg), `${name} darkest step`).toBeGreaterThanOrEqual(3)
    expect(ratio(p.dim, p.bg), `${name} dim`).toBeGreaterThanOrEqual(3)
    expect(ratio(p.steps[1]!, p.bg), `${name} trend step`).toBeGreaterThanOrEqual(3)
    expect(ratio(p.sessionStep, p.bg), `${name} session step`).toBeGreaterThanOrEqual(3)
    expect(new Set([p.context, p.quota, p.tools, p.session, p.agents, p.git, p.steward]).size, `${name} distinct hues`).toBe(7)
  }
})
