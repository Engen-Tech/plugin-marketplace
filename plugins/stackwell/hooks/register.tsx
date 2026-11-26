import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StackwellAccount, StackwellAgent, StackwellBreakdown, StackwellGit, StackwellLogEntry, StackwellPalette, StackwellPeer, StackwellQuota, StackwellSteward, StackwellView } from '../types'
import { PRESETS, THEMES, clockSignature, drawParts, parsePalette, toBase64 } from './draw'
import type { Row } from './draw'
import { matchSession, parseRegistry } from './steward'
import type { Initiative } from './steward'

const PANE = 'stackwell'
const TOOLS_KEY = 'stackwell-tools'
const TITLE = 'Stackwell'
const MINUTE = 60_000
const MAX_TREND = 40
const MAX_LOG = 30
const MAX_AGENTS = 20
const AGENT_KEEP = 5 * MINUTE

const FALLBACK: StackwellPalette = PRESETS.vga!

const EMPTY: StackwellView = {
  profile: 'default',
  quotas: [],
  toolCounts: {},
  bashFails: 0,
  running: [],
  accounts: [],
  trend: [],
  turnCosts: [],
  turns: 0,
  agents: [],
  log: [],
  isToolsOpen: false,
  now: 0,
  theme: 'auto',
  palette: FALLBACK,
}

// Bump the tag when StackwellView changes shape: it declines what older code stored.
const view = atom({ plugin: 'stackwell', key: 'view' } as const, EMPTY, { shape: 'view-5' })

type $ = EngineInterface

/** Writes only when the value changes; `fn` must depend on its argument alone. */
async function change($: $, fn: (v: StackwellView) => StackwellView): Promise<void> {
  const cur = await read($, view)
  if (JSON.stringify(fn(cur)) === JSON.stringify(cur)) return
  await update($, view, fn)
}

async function attempt<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

/** A Raster cell takes one width-1 BMP character: anything outside printable ASCII becomes `?`. */
const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, '?')
const cleanOpt = (s: string | undefined | null) => (s ? clean(s) : undefined)

type Info = Pick<StackwellView, 'model' | 'branch' | 'profile'>

/** New title facts over the old: a read that failed keeps the value it had. */
const mergeInfo = (v: StackwellView, info: Info): StackwellView => ({
  ...v,
  model: info.model ?? v.model,
  branch: info.branch ?? v.branch,
  profile: info.profile,
})

async function nowMs($: $): Promise<number> {
  return (await attempt(() => $.clock.now())) ?? Date.now()
}
const toMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE

// ---------------------------------------------------------------- sources

/** The mod's options (userConfig), as register received them. */
type Config = { theme: string; quotaDir: string; paletteFile: string }
let config: Config = { theme: 'auto', quotaDir: '~/.claude/quota', paletteFile: '' }

const readConfig = (options: Readonly<Record<string, unknown>> | undefined): Config => {
  const str = (k: string, d: string) => (typeof options?.[k] === 'string' ? (options[k] as string) : d)
  return { theme: str('theme', 'auto'), quotaDir: str('quotaDir', '~/.claude/quota'), paletteFile: str('paletteFile', '') }
}

/** `~/x` with the home folder; other paths as given. */
async function expandPath($: $, path: string): Promise<string> {
  if (!path.startsWith('~/') && path !== '~') return path
  const home = (await attempt(() => $.env.get('HOME'))) ?? ''
  return home + path.slice(1)
}

/**
 * A named preset; `auto` is the palette file when one is set, else Claude Code's own
 * light or dark theme, else the neutral dark preset.
 */
async function readPalette($: $, theme: string): Promise<StackwellPalette> {
  if (theme !== 'auto') return PRESETS[theme] ?? FALLBACK
  if (config.paletteFile) {
    const text = await attempt(async () => $.fs.read(await expandPath($, config.paletteFile)))
    const parsed = typeof text === 'string' ? parsePalette(text) : undefined
    if (parsed) return parsed
  }
  const rows = await attempt(() => $.config.list())
  const app = rows?.find(r => r.key === 'theme')?.value
  return typeof app === 'string' && /light/i.test(app) ? PRESETS.latte! : FALLBACK
}

async function readInfo($: $): Promise<Info> {
  const model = await attempt(() => $.session.model())
  const cwd = await attempt(() => $.session.cwd())
  const copy = cwd ? await attempt(() => $.vcs.detect({ path: cwd })) : undefined
  const profileEnv = await attempt(() => $.env.get('CLAUDE_PROFILE'))
  const configDir = await attempt(() => $.env.get('CLAUDE_CONFIG_DIR'))
  return {
    model: cleanOpt(model),
    branch: cleanOpt(copy?.branch),
    profile: clean(profileEnv || (configDir ? basename(configDir) : 'default')),
  }
}

/** The session start and the used context as messages, tool definitions, system prompt and the rest. */
type Usage = { breakdown?: StackwellBreakdown; startedAt?: number; tokens?: number; usd?: number }

async function readUsage($: $): Promise<Usage> {
  const usage = await attempt(() => $.session.usage({ breakdown: 'summary' }))
  const base: Usage = { startedAt: usage?.startedAt, tokens: usage?.context.tokens ?? undefined, usd: usage?.cost?.usd }
  const b = usage?.context.breakdown
  if (!b) return base
  const out: StackwellBreakdown = { msgs: 0, tools: 0, sys: 0, other: 0, raw: b.rawMaxTokens }
  for (const c of b.categories) {
    if (c.kind !== 'used') continue
    const n = c.name.toLowerCase()
    if (n.startsWith('message')) out.msgs += c.tokens
    else if (/\btools?\b/.test(n)) out.tools += c.tokens
    else if (n.startsWith('system prompt')) out.sys += c.tokens
    else out.other += c.tokens
  }
  if (b.autoCompactThreshold !== undefined) out.autoCompact = b.autoCompactThreshold
  return { ...base, breakdown: out }
}

/** Uncommitted files and lines, commits ahead, the worktree; undefined outside a working copy. */
async function readGit($: $): Promise<StackwellGit | undefined> {
  const cwd = await attempt(() => $.session.cwd())
  if (!cwd) return undefined
  const copy = await attempt(() => $.vcs.detect({ path: cwd }))
  if (!copy) return undefined
  const status = await attempt(() => $.vcs.status({ path: cwd }))
  if (!status || status.unknown !== undefined) return undefined
  const diff = await attempt(() => $.vcs.diff({ path: cwd, vcs: copy.vcs, base: 'head', isStatOnly: true }))
  const files = diff && diff.unknown === undefined ? diff.files : []
  const git: StackwellGit = {
    files: status.changes.length,
    added: files.reduce((a, f) => a + f.added, 0),
    removed: files.reduce((a, f) => a + f.removed, 0),
    ahead: status.unpublished,
  }
  if (copy.mainRoot && copy.mainRoot !== copy.root) git.worktree = clean(basename(copy.root))
  return git
}

type QuotaWindow = { used_percentage?: unknown; resets_at?: unknown }
type QuotaFile = {
  profile?: unknown
  five_hour?: QuotaWindow
  seven_day?: QuotaWindow
  updated_at_epoch?: unknown
}
const pctOf = (w: QuotaWindow | undefined) => (typeof w?.used_percentage === 'number' ? w.used_percentage : undefined)
/** Epoch seconds in the file, milliseconds here. */
const resetOf = (w: QuotaWindow | undefined) => (typeof w?.resets_at === 'number' ? w.resets_at * 1000 : undefined)

let quotaReadAt = -Infinity

/** The quota files, at most once a minute unless forced; undefined when skipped. */
async function readAccounts($: $, now: number, isForced = false): Promise<StackwellAccount[] | undefined> {
  if (!isForced && now - quotaReadAt < MINUTE) return undefined
  quotaReadAt = now
  const dir = await expandPath($, config.quotaDir)
  if (!dir) return undefined
  const entries = await attempt(() => $.fs.list(dir))
  if (!entries) return []
  const out: StackwellAccount[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const text = await attempt(() => $.fs.read(`${dir}/${entry.name}`))
    if (typeof text !== 'string') continue
    let data: QuotaFile
    try {
      data = JSON.parse(text) as QuotaFile
    } catch {
      continue
    }
    const account: StackwellAccount = {
      name: clean(typeof data.profile === 'string' && data.profile ? data.profile : entry.name.replace(/\.json$/, '')),
    }
    const h5 = pctOf(data.five_hour), d7 = pctOf(data.seven_day)
    if (h5 !== undefined) account.h5 = h5
    if (d7 !== undefined) account.d7 = d7
    const h5At = resetOf(data.five_hour), d7At = resetOf(data.seven_day)
    if (h5 !== undefined && h5At !== undefined) account.h5At = h5At
    if (d7 !== undefined && d7At !== undefined) account.d7At = d7At
    if (typeof data.updated_at_epoch === 'number') account.updatedAt = data.updated_at_epoch
    out.push(account)
  }
  return out
}

/** The windows that report a number; a window without one is left out, never drawn as 0%. */
const toQuotas = (limits: readonly { kind: string; percentUsed: number | null; resetsAt?: string }[]): StackwellQuota[] =>
  limits.flatMap(l => {
    if (typeof l.percentUsed !== 'number' || !Number.isFinite(l.percentUsed)) return []
    const q: StackwellQuota = { kind: l.kind, pct: l.percentUsed }
    const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    if (!Number.isNaN(at)) q.resetsAt = at
    return [q]
  })

// ---------------------------------------------------------------- steward

/** The registry as last parsed, kept until its mtime changes. */
let registry: { path: string; mtime: number; rows: Initiative[] } | undefined

const expandHome = (path: string, home: string) => (path.startsWith('~/') ? home + path.slice(1) : path)

/** The peers' states as ListAgents lists them, by name; empty when it can't be asked. */
async function peerStates($: $): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const got = await attempt(() => $.tool.call({ tool: 'ListAgents' }))
  const sections = (got as { result?: { sections?: { rows?: { name?: string; status?: string }[] }[] } } | undefined)?.result?.sections ?? []
  for (const sec of sections)
    for (const r of sec.rows ?? []) if (r.name && r.status) out.set(r.name.replace(/\s*\[.*\]$/, ''), clean(r.status))
  return out
}

/** This session's place in the registry; undefined when absent or not named there. */
async function readSteward($: $): Promise<StackwellSteward | undefined> {
  const home = (await attempt(() => $.env.get('HOME'))) ?? ''
  const dir = (await attempt(() => $.env.get('STEWARD_ORCHESTRATION_DIR'))) || `${home}/.claude/orchestration`
  const path = `${dir}/initiatives.md`
  const stat = await attempt(() => $.fs.stat(path))
  if (!stat || stat.kind !== 'file') return undefined
  if (!registry || registry.path !== path || registry.mtime !== stat.mtimeMs) {
    const text = await attempt(() => $.fs.read(path))
    if (typeof text !== 'string') return undefined
    registry = { path, mtime: stat.mtimeMs, rows: parseRegistry(text) }
  }
  const id = await attempt(() => $.session.id())
  const m = id ? matchSession(registry.rows, id) : undefined
  if (!m) return undefined
  const states = await peerStates($)
  const peer = (name: string, role: StackwellPeer['role']): StackwellPeer => {
    const p: StackwellPeer = { name: clean(name), role }
    const st = states.get(name)
    if (st) p.status = st
    return p
  }
  const peers: StackwellPeer[] = []
  if (m.role === 'secondary' && m.initiative.primary) peers.push(peer(m.initiative.primary.name, 'primary'))
  for (const s of m.initiative.secondaries) if (s !== m.self) peers.push(peer(s.name, 'secondary'))
  const out: StackwellSteward = { role: m.role, initiative: clean(m.initiative.initiative), peers }
  if (m.initiative.log) {
    const raw = expandHome(m.initiative.log, home)
    const logPath = raw.startsWith('/') ? raw : `${dir}/${raw}`
    const ls = await attempt(() => $.fs.stat(logPath))
    if (ls) out.logMtime = ls.mtimeMs
  }
  return out
}

/** Puts the steward reading on the view, or takes it off. */
const withSteward = (v: StackwellView, st: StackwellSteward | undefined): StackwellView => {
  const out = { ...v }
  if (st) out.steward = st
  else delete out.steward
  return out
}

async function toggleTools($: $): Promise<boolean> {
  const cur = await read($, view)
  const isOpen = !cur.isToolsOpen
  await attempt(() => $.store.set('isToolsOpen', isOpen))
  await update($, view, v => ({ ...v, isToolsOpen: isOpen }))
  return isOpen
}

// ---------------------------------------------------------------- pane and timer

let timer: { cancel: () => void } | undefined

/** One minute chain at most, alive only while the pane is open. */
function arm($: $): void {
  if (timer) return
  timer = $.clock.after(MINUTE, () => {
    timer = undefined
    void tick($)
  })
}

async function tick($: $): Promise<void> {
  const panes = await attempt(() => $.ui.panes())
  if (!panes?.some(p => p.id === PANE)) return
  const now = toMinute(await nowMs($))
  const accounts = await readAccounts($, now)
  const steward = await readSteward($)
  await change($, v => {
    const next = withSteward({ ...v, accounts: accounts ?? v.accounts }, steward)
    const isSame =
      clockSignature(v, v.now) === clockSignature(next, now) &&
      JSON.stringify(next.accounts) === JSON.stringify(v.accounts) &&
      JSON.stringify(next.steward) === JSON.stringify(v.steward)
    return isSame ? v : { ...next, now }
  })
  arm($)
}

async function openPane($: $): Promise<void> {
  await attempt(() => $.ui.open({ id: PANE, title: TITLE, columns: 53 }))
  arm($)
}

/** The exit code a Bash result names (`Exit code 2`); the result type carries none. */
function parseExit(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined
  const m = /exit code[:\s]+(-?\d+)/i.exec(text)
  return m ? Number(m[1]) : undefined
}

/** A short target for the log: a command's first words, a file's name, a pattern, a task. */
function targetOf(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (tool === 'Bash') {
    const line = str('command').trim().split('\n')[0] ?? ''
    return clean(line.split(/\s+/).filter(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)).join(' ')).slice(0, 60)
  }
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool)) return clean(basename(str('file_path') || str('notebook_path')))
  if (tool === 'Grep' || tool === 'Glob') return clean(str('pattern')).slice(0, 60)
  if (tool === 'Agent') return clean(str('description') || str('subagent_type'))
  if (tool.startsWith('mcp__')) return clean(tool.split('__').pop() ?? '')
  return clean(str('description') || str('url') || str('query') || str('skill')).slice(0, 60)
}

/** `claude-sonnet-5-5` or `sonnet` -> `sonnet`; other ids as given. */
function shortModel(m: unknown): string | undefined {
  if (typeof m !== 'string' || !m) return undefined
  const f = /(opus|sonnet|haiku|fable)/i.exec(m)
  return f ? f[1]!.toLowerCase() : clean(m).slice(0, 12)
}

/** The agent short name: its description, else its type after the last `.` or `:`. */
function agentName(input: Record<string, unknown>): string {
  const d = typeof input.description === 'string' ? input.description : ''
  const t = typeof input.subagent_type === 'string' ? input.subagent_type.split(/[.:]/).pop() ?? '' : ''
  return clean(d || t || 'agent').slice(0, 30)
}

// ---------------------------------------------------------------- register

export const register: Register = (on, options) => {
  config = readConfig(options)
  on('session.start', async ($, e, next) => {
    await attempt(() =>
      $.command.register({
        name: 'stackwell',
        description: 'Stackwell pane: open it, or on | off | tools | theme <name>',
        argumentHint: 'on | off | tools | theme <auto|vga|mocha|tokyo-night|latte>',
      }),
    )
    // a /stackwell theme choice stands over the option
    const stored = await attempt(() => $.store.get('theme'))
    const isKnown = (t: unknown): t is string => typeof t === 'string' && (THEMES as readonly string[]).includes(t)
    const theme = isKnown(stored) ? stored : isKnown(config.theme) ? config.theme : 'auto'
    const palette = await readPalette($, theme)
    const info = await readInfo($)
    const { breakdown } = await readUsage($)
    const git = await readGit($)
    const steward = await readSteward($)
    const isToolsOpen = (await attempt(() => $.store.get('isToolsOpen'))) === true
    const usage = await attempt(() => $.session.usage())
    const now = toMinute(await nowMs($))
    const accounts = await readAccounts($, now, true)
    await attempt(() =>
      change($, v => ({
        ...withSteward(mergeInfo(v, info), steward),
        isToolsOpen,
        theme,
        palette,
        breakdown: breakdown ?? v.breakdown,
        tokens: usage?.context.tokens ?? v.tokens,
        window: usage?.context.window ?? v.window,
        percent: usage?.context.percent ?? v.percent,
        quotas: usage ? toQuotas(usage.rateLimits) : v.quotas,
        costUsd: usage?.cost?.usd ?? v.costUsd,
        startedAt: usage?.startedAt ?? v.startedAt,
        costAtTurn: usage?.cost?.usd ?? v.costAtTurn,
        git,
        accounts: accounts ?? v.accounts,
        now,
      })),
    )
    const isOff = (await attempt(() => $.store.get('isOff'))) === true
    if (!isOff && e.isInteractive) await openPane($)
    return next(e)
  })

  on('command.run', { command: 'stackwell' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === 'off') {
      await attempt(() => $.store.set('isOff', true))
      await attempt(() => $.ui.close({ id: PANE }))
      timer?.cancel()
      timer = undefined
      return { text: 'Stackwell is off; /stackwell on brings it back.' }
    }
    if (verb === '' || verb === 'on') {
      if (verb === 'on') await attempt(() => $.store.delete('isOff'))
      await openPane($)
      return { text: 'Stackwell is open.' }
    }
    if (verb === 'tools') {
      const isOpen = await toggleTools($)
      return { text: `Stackwell tools ${isOpen ? 'open' : 'closed'}.` }
    }
    if (verb === 'theme') {
      if (!(THEMES as readonly string[]).includes(arg)) return { text: `Themes: ${THEMES.join(', ')}.` }
      await attempt(() => $.store.set('theme', arg))
      const palette = await readPalette($, arg)
      await change($, v => ({ ...v, theme: arg, palette }))
      return { text: `Stackwell theme: ${arg}.` }
    }
    return { text: 'Usage: /stackwell [on | off | tools | theme <name>]' }
  })

  on('session.measure', async ($, e, next) => {
    try {
      const c = e.context
      const now = toMinute(await nowMs($))
      const quotas = toQuotas(e.rateLimits)
      const usd = e.cost?.usd
      await change($, v => ({
        ...v,
        tokens: c.tokens ?? v.tokens,
        window: c.window,
        percent: c.percent ?? v.percent,
        quotas: e.changed.includes('rateLimits') || v.quotas.length === 0 ? quotas : v.quotas,
        costUsd: usd ?? v.costUsd,
        now,
      }))
    } catch {
      // the drawing is best effort; the event goes on
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const tool = clean(String(e.tool)).slice(0, 60)
    const id = e.tool_use_id
    const input = e as unknown as Record<string, unknown>
    const at = isMain ? await nowMs($) : 0
    if (isMain) {
      try {
        const entry: StackwellLogEntry = { id, at, tool, target: targetOf(tool, input), status: 'running' }
        const agent: StackwellAgent | undefined =
          tool === 'Agent'
            ? { id, name: agentName(input), isBackground: input.run_in_background === true, status: 'running', startedAt: at }
            : undefined
        const model = shortModel(input.model)
        if (agent && model) agent.model = model
        await update($, view, v => ({
          ...v,
          toolCounts: { ...v.toolCounts, [tool]: (v.toolCounts[tool] ?? 0) + 1 },
          running: [...v.running, { id, tool }].slice(-16),
          log: [...v.log, entry].slice(-MAX_LOG),
          agents: agent ? [...v.agents, agent].slice(-MAX_AGENTS) : v.agents,
        }))
      } catch {
        // the drawing is best effort; the call goes on
      }
    }
    const ran = await next(e)
    if (isMain) {
      try {
        const isBash = tool === 'Bash'
        const exit = isBash ? parseExit(ran.text) : undefined
        const hasFailed = ran.deny !== undefined || ran.isError === true || (exit !== undefined && exit !== 0)
        const end = await nowMs($)
        const rec = (ran as { result?: unknown }).result as { status?: unknown; agentId?: unknown; resolvedModel?: unknown } | undefined
        const isAsync = rec?.status === 'async_launched' || rec?.status === 'remote_launched'
        await update($, view, v => ({
          ...v,
          running: v.running.filter(r => r.id !== id),
          bashFails: isBash && hasFailed ? v.bashFails + 1 : v.bashFails,
          log: v.log.map(l => (l.id === id ? { ...l, ms: Math.max(0, end - l.at), status: hasFailed ? ('failed' as const) : ('ok' as const) } : l)),
          agents: v.agents.map(a => {
            if (a.id !== id) return a
            const out: StackwellAgent = { ...a }
            if (typeof rec?.agentId === 'string') out.agentId = rec.agentId
            const m = shortModel(rec?.resolvedModel)
            if (m && !out.model) out.model = m
            // a background agent returns at once; its own turn.complete ends it
            if (isAsync && !hasFailed) out.isBackground = true
            else {
              out.status = hasFailed ? 'failed' : 'ok'
              out.endedAt = end
            }
            return out
          }),
        }))
      } catch {
        // the drawing is best effort; the result goes back unchanged
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.trigger === 'precompute' || e.agentId !== undefined || r.skip !== undefined) return r
    try {
      const before = r.tokensBefore
      const after = r.tokensAfter
      await update($, view, v => {
        const b = before ?? v.tokens
        const compact: StackwellView['compact'] = {}
        if (b !== undefined) compact.before = b
        if (after !== undefined) compact.after = after
        const win = v.window ?? v.breakdown?.raw
        return {
          ...v,
          compact,
          tokens: after ?? v.tokens,
          percent: after !== undefined && win ? Math.round((after / win) * 100) : v.percent,
        }
      })
    } catch {
      // the drawing is best effort; the compaction stands
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // a subagent's loop ended: the one a background Agent call started is done
      const agentId = e.agentId
      const end = await nowMs($)
      await attempt(() =>
        change($, v => ({
          ...v,
          agents: v.agents.map(a =>
            a.agentId === agentId && a.status === 'running' ? { ...a, status: e.isAborted ? ('failed' as const) : ('ok' as const), endedAt: end } : a,
          ),
        })),
      )
    } else {
      try {
        const info = await readInfo($)
        // startedAt here too: after a hot reload no session.start comes
        const usage = await readUsage($)
        const git = await readGit($)
        const steward = await readSteward($)
        const nowExact = await nowMs($)
        const now = toMinute(nowExact)
        const accounts = await readAccounts($, now)
        await change($, v => {
          const tokens = usage.tokens ?? v.tokens
          const usd = usage.usd ?? v.costUsd
          const out: StackwellView = {
            ...withSteward(mergeInfo(v, info), steward),
            // a call the turn left unanswered is no longer running
            running: [],
            breakdown: usage.breakdown ?? v.breakdown,
            startedAt: usage.startedAt ?? v.startedAt,
            accounts: accounts ?? v.accounts,
            trend: tokens === undefined ? v.trend : [...v.trend, tokens].slice(-MAX_TREND),
            turnCosts: usd === undefined ? v.turnCosts : [...v.turnCosts, Math.max(0, usd - (v.costAtTurn ?? usd))].slice(-MAX_TREND),
            turns: v.turns + 1,
            lastTurnMs: e.durationMs,
            agents: v.agents.filter(a => a.status === 'running' || (a.endedAt ?? 0) > nowExact - AGENT_KEEP),
            log: v.log.map(l => (l.status === 'running' ? { ...l, status: 'ok' as const } : l)),
            now,
          }
          if (tokens !== undefined) out.tokens = tokens
          if (usd !== undefined) {
            out.costUsd = usd
            out.costAtTurn = usd
          }
          if (git) out.git = git
          else delete out.git
          delete out.compact
          return out
        })
      } catch {
        // the drawing is best effort; the turn goes on
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await read($, view)
    // the narrower of the body and the measured viewport, less one column: the
    // live pane clips its last column, so leave it blank; draw adds 2-column margins
    const cols = Math.min(e.props.bodyColumns, e.viewport?.columns ?? e.props.bodyColumns) - 1
    // the room's rows: never draw past them
    const rows = Math.min(e.props.scroll?.bodyRows ?? Infinity, e.viewport?.rows ?? Infinity)
    const parts = drawParts(v, cols, Number.isFinite(rows) ? rows : 200)
    const { Box, Text, Button } = $.ui.resolve(e)
    const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
    // a Raster takes no clicks: the tools row is a Button between two Rasters
    const toolsButton = (row: Row) => (
      <Box paddingLeft={2}>
        <Button key={TOOLS_KEY} label="tools" plain onPress={() => toggleTools($)}>
          {row.map(s => (
            <Text color={hex(s.fg || v.palette.text)}>{s.text}</Text>
          ))}
        </Button>
      </Box>
    )
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Raster key="pane-top" columns={parts.top.w} rows={parts.top.h} cells={toBase64(parts.top.cells)} />
          {parts.tools ? toolsButton(parts.tools) : null}
          {parts.bottom ? <Raster key="pane-bottom" columns={parts.bottom.w} rows={parts.bottom.h} cells={toBase64(parts.bottom.cells)} /> : null}
        </Box>
      )
    }
    const text = (sc: { lines: () => string[] }) => sc.lines().map(line => <Text>{line === '' ? ' ' : line}</Text>)
    return (
      <Box flexDirection="column">
        {text(parts.top)}
        {parts.tools ? toolsButton(parts.tools) : null}
        {parts.bottom ? text(parts.bottom) : null}
      </Box>
    )
  })
}
