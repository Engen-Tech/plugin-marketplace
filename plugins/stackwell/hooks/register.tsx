import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, SessionMeasureInput, ToolUseSummary, UiPressArgument } from 'claude-code'

import type { StackwellAccount, StackwellAgent, StackwellBinder, StackwellBreakdown, StackwellFolder, StackwellPalette, StackwellPeer, StackwellQuota, StackwellSteward, StackwellView } from '../types'
import { DEFAULT_COLOR, ICON_COLS, PRESETS, SECTIONS, SECTION_COLS, THEMES, blend, clockSignature, drawParts, isDarkBg, settleView, parsePalette, printable, rowSlots, sortFolders, toBase64 } from './draw'
import { agentKind, effortText, pickModelEffort, profileOf, suffixEffort } from './agents'
import type { ModelEffort } from './agents'
import { basename as baseOf, touchedFolders, touchedPaths } from './folders'
import type { TouchedPath } from './folders'
import { binderState, isHatchItemBranch, parseBinder } from './hatch'
import type { Card, Row, Screen, Section, Slot } from './draw'
import { matchSession, parseRegistry } from './steward'
import type { Initiative } from './steward'

const PANE = 'stackwell'
/** The header icon's text where a terminal shows no images: one cell (East Asian Width N), within its columns. */
const ICON_ALT = '◫'
const FOLDERS_KEY = 'stackwell-folders'
const TITLE = 'Stackwell'
const MINUTE = 60_000
const MAX_TREND = 40
const MAX_AGENTS = 20
const AGENT_KEEP = 5 * MINUTE
const FAST = 15_000
const MAX_FOLDERS = 30
const REFRESH_ROWS = 4

const FALLBACK: StackwellPalette = PRESETS.vga!

const EMPTY: StackwellView = {
  profile: 'default',
  quotas: [],
  accounts: [],
  trend: [],
  turns: 0,
  agents: [],
  folders: [],
  binders: [],
  now: 0,
  theme: 'auto',
  palette: FALLBACK,
}

// Bump the tag when StackwellView changes shape: it declines what older code stored.
const view = atom({ plugin: 'stackwell', key: 'view' } as const, EMPTY, { shape: 'view-8' })

type $ = EngineInterface

type Pin = { at: number; until: number }
/** The card a click on its row pinned open: its pane row (-1 for none) and when it closes. */
const pin = atom({ plugin: 'stackwell', key: 'pin' } as const, { at: -1, until: 0 })
/** How long a pinned card stays open after its click. */
const PIN_MS = 20_000
/**
 * The pane row of the pinned card at `now`, -1 for none: the stored time closes it, so a pin
 * whose timer a hot reload ended still closes when its time is up.
 */
export const pinShown = (p: Pin, now: number): number =>
  p && typeof p === 'object' && typeof p.at === 'number' && typeof p.until === 'number' && now < p.until ? p.at : -1
let pinTimer: { cancel: () => void } | undefined

/** A click on the cut row at `at`: pins its card, or unpins it when it was pinned; 20 s later it closes. */
async function togglePin($: $, at: number): Promise<void> {
  const now = await $.clock.now()
  const next: Pin = pinShown(await read($, pin), now) === at ? { at: -1, until: 0 } : { at, until: now + PIN_MS }
  await update($, pin, () => next)
  pinTimer?.cancel()
  pinTimer = undefined
  if (next.at < 0) return
  // the redraw when its time is up; the stored time closes it even if this timer is lost
  const t = $.clock.after(PIN_MS, () => {
    if (pinTimer === t) pinTimer = undefined
    return attempt(() => update($, pin, p => (p.at === next.at && p.until === next.until ? { at: -1, until: 0 } : p)))
  })
  pinTimer = t
}

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

// ---------------------------------------------------------------- detached work

/**
 * Work a hook starts after its `next(e)` and does not wait for: no hook holds an event while
 * stackwell reads. `$` stays valid after the hook returns.
 */
function detach(work: () => Promise<unknown>): void {
  void attempt(work)
}

/** One run of a job at a time: a start while it runs asks for one more run after it, of the latest work. */
const jobs = new Map<string, { isRunning: boolean; again?: () => Promise<unknown> }>()

function runOnce(key: string, work: () => Promise<unknown>): void {
  const job = jobs.get(key) ?? { isRunning: false }
  jobs.set(key, job)
  if (job.isRunning) {
    job.again = work
    return
  }
  job.isRunning = true
  detach(async () => {
    try {
      let next: (() => Promise<unknown>) | undefined = work
      while (next) {
        job.again = undefined
        await attempt(next)
        next = job.again
      }
    } finally {
      job.isRunning = false
      jobs.delete(key)
    }
  })
}

/** Runs of a job one after another, none dropped: each event's own work, in order. */
const queues = new Map<string, Promise<unknown>>()

function serial(key: string, work: () => Promise<unknown>): void {
  const before = queues.get(key) ?? Promise.resolve()
  const p = before.then(() => attempt(work))
  queues.set(key, p)
  void p.finally(() => {
    if (queues.get(key) === p) queues.delete(key)
  })
}

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

/**
 * Outside text for the view: escape sequences and controls go whole (`printable`); then, as a
 * Raster cell takes one width-1 BMP character, anything outside printable ASCII becomes `?`.
 */
const clean = (s: string) => printable(s).replace(/[^\x20-\x7e]/g, '?')
const cleanOpt = (s: string | undefined | null) => (s ? clean(s) : undefined)

type Info = Pick<StackwellView, 'model' | 'profile'>

/** New title facts over the old: a read that failed keeps the value it had. */
const mergeInfo = (v: StackwellView, info: Info): StackwellView => ({
  ...v,
  model: info.model ?? v.model,
  profile: info.profile,
})

/** The JSON text's top-level object; undefined for broken JSON, null, an array or any other value. */
function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const d: unknown = JSON.parse(text)
    return typeof d === 'object' && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The settled value, or undefined when its read failed. */
function settled<T>(r: PromiseSettledResult<T>): T | undefined {
  return r.status === 'fulfilled' ? r.value : undefined
}

async function nowMs($: $): Promise<number> {
  return (await attempt(() => $.clock.now())) ?? Date.now()
}
const toMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE

// ---------------------------------------------------------------- sources

/** The mod's options (userConfig), as register received them. */
type Config = { theme: string; quotaDir: string; paletteFile: string; sessionDirs: string[]; showIcon: boolean }
let config: Config = { theme: 'auto', quotaDir: '~/.claude/quota', paletteFile: '', sessionDirs: [], showIcon: true }

const readConfig = (options: Readonly<Record<string, unknown>> | undefined): Config => {
  const str = (k: string, d: string) => (typeof options?.[k] === 'string' ? (options[k] as string) : d)
  const list = options?.sessionDirs
  const sessionDirs = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
  return { theme: str('theme', 'auto'), quotaDir: str('quotaDir', '~/.claude/quota'), paletteFile: str('paletteFile', ''), sessionDirs, showIcon: options?.showIcon !== false }
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
  const profileEnv = await attempt(() => $.env.get('CLAUDE_PROFILE'))
  const configDir = await attempt(() => $.env.get('CLAUDE_CONFIG_DIR'))
  return {
    model: cleanOpt(model),
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

// ---------------------------------------------------------------- folders

/**
 * The session folder and the home folder as the engine gave them: every path is resolved against
 * these, never against the view's cleaned copies (`/Users/José` would turn into `/Users/Jos?`).
 */
let rawCwd = ''
let rawHome = ''

/** The raw cwd and home, read when the module has none yet (after a reload). */
async function pathBase($: $): Promise<{ cwd: string; home: string }> {
  if (!rawCwd) rawCwd = (await attempt(() => $.session.cwd())) ?? ''
  if (!rawHome) rawHome = (await attempt(() => $.env.get('HOME'))) ?? ''
  return { cwd: rawCwd, home: rawHome }
}

type Copy = { root: string; mainRoot?: string; branch?: string; vcs: string }

/**
 * The working copy of each folder asked about: turn ends never detect a folder twice, save that
 * a failed detect is tried again once it is RETRY old. Pruned to the folders the view shows.
 */
const copies = new Map<string, { copy: Copy | null; at: number }>()
const RETRY = 5 * MINUTE
const MAX_COPIES = 200

/**
 * The working copy of a folder. Only the session folder goes to `$.vcs.detect`, which may run Git
 * there; every other folder is read from its git files alone, since a clone from anywhere may set
 * `core.fsmonitor`, hooks or diff drivers that any Git run in it would start.
 */
async function copyOf($: $, dir: string): Promise<Copy | undefined> {
  const kept = copies.get(dir)
  const now = await nowMs($)
  if (kept && (kept.copy || now - kept.at < RETRY)) return kept.copy ?? undefined
  let out: Copy | null = null
  if (dir === rawCwd) {
    const c = await attempt(() => $.vcs.detect({ path: dir }))
    if (c) {
      out = { root: c.root, vcs: c.vcs }
      if (c.mainRoot) out.mainRoot = c.mainRoot
      if (c.branch) out.branch = clean(c.branch)
    }
  } else out = await fileCopy($, dir)
  copies.delete(dir)
  copies.set(dir, { copy: out, at: now })
  // the oldest go first past the cap
  while (copies.size > MAX_COPIES) copies.delete(copies.keys().next().value!)
  return out ?? undefined
}

// ---------------------------------------------------------------- git files, read without git

/**
 * The roots of the session cwd's repository, where Git may run: the cwd's copy, its main
 * checkout, and the linked worktrees the main checkout's own `.git/worktrees/*\/gitdir` name.
 * Set at start, turn end and the minute tick; every other folder is outside.
 */
let trusted = new Set<string>()
const MAX_UP = 64
const MAX_WORKTREES = 64
const isAbs = (p: string) => p.startsWith('/')
/** `p` with `.` and `..` parts resolved and no doubled or trailing `/`. */
function normPath(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
const under = (dir: string, name: string) => (dir === '/' ? '' : dir) + '/' + name
const firstLine = (t: unknown) => (typeof t === 'string' ? (t.split('\n')[0] ?? '').trim() : '')
const readLine = async ($: $, path: string) => firstLine(await attempt(() => $.fs.read(path)))

async function trustedRoots($: $, copy: Copy): Promise<Set<string>> {
  const main = copy.mainRoot ?? copy.root
  const out = new Set([copy.root, main])
  const dir = `${main}/.git/worktrees`
  const entries = (await attempt(() => $.fs.list(dir))) ?? []
  for (const en of entries.slice(0, MAX_WORKTREES)) {
    if (en.kind !== 'dir') continue
    const gd = await readLine($, `${dir}/${en.name}/gitdir`)
    if (isAbs(gd) && gd.endsWith('/.git')) out.add(parentOf(normPath(gd)))
  }
  return out
}

/** The nearest `.git` at or above `dir`: its folder, the git dir it names, and the common dir. */
async function gitFiles($: $, dir: string): Promise<{ root: string; gitDir: string; commonDir: string } | null> {
  let p = normPath(dir)
  for (let i = 0; i < MAX_UP; i++) {
    const dotGit = under(p, '.git')
    const st = await attempt(() => $.fs.stat(dotGit))
    if (st?.kind === 'dir') return { root: p, gitDir: dotGit, commonDir: dotGit }
    if (st?.kind === 'file') {
      // a linked worktree or a submodule: `gitdir: <path>`, relative to the folder
      const m = /^gitdir:\s*(.+)$/.exec(await readLine($, dotGit))
      if (!m) return null
      const gitDir = normPath(isAbs(m[1]!) ? m[1]! : `${p}/${m[1]}`)
      const cd = await readLine($, `${gitDir}/commondir`)
      return { root: p, gitDir, commonDir: cd ? normPath(isAbs(cd) ? cd : `${gitDir}/${cd}`) : gitDir }
    }
    if (p === '/') return null
    p = parentOf(p)
  }
  return null
}

/** A folder's working copy from its git files: root, main checkout, and the branch HEAD names (none when detached). */
async function fileCopy($: $, dir: string): Promise<Copy | null> {
  const g = await gitFiles($, dir)
  if (!g) return null
  // the main checkout holds the common `.git`; a submodule's git dir has none other
  const out: Copy = { root: g.root, vcs: 'git', mainRoot: g.commonDir.endsWith('/.git') ? parentOf(g.commonDir) : g.root }
  const head = /^ref:\s*refs\/heads\/(.+)$/.exec(await readLine($, `${g.gitDir}/HEAD`))
  if (head) out.branch = clean(head[1]!)
  return out
}

const HATCH_REFS = ['refs/hatch/', 'refs/heads/hatch/', 'refs/tags/hatch/']
const MAX_REFS = 2000

/** The hatch ref names of a repo outside the cwd's, from `packed-refs` and the loose ref files: no git. */
async function fileRefs($: $, repo: string): Promise<string[]> {
  const g = await gitFiles($, repo)
  if (!g) return []
  const out = new Set<string>()
  const packed = await attempt(() => $.fs.read(`${g.commonDir}/packed-refs`))
  if (typeof packed === 'string')
    for (const line of packed.split('\n')) {
      const ref = /^[0-9a-f]{40,64} (refs\/\S+)$/.exec(line.trim())?.[1]
      if (ref && HATCH_REFS.some(h => ref.startsWith(h))) out.add(ref)
    }
  const walk = async (ref: string, depth: number): Promise<void> => {
    if (depth > 6 || out.size >= MAX_REFS) return
    const entries = (await attempt(() => $.fs.list(`${g.commonDir}/${ref}`))) ?? []
    for (const en of entries) {
      if (out.size >= MAX_REFS) return
      if (en.kind === 'dir') await walk(`${ref}/${en.name}`, depth + 1)
      else if (en.kind === 'file') out.add(`${ref}/${en.name}`)
    }
  }
  for (const h of HATCH_REFS) await walk(h.slice(0, -1), 0)
  return [...out]
}

/** Git config a repository could set to run a program, turned off for the one ref listing the mod runs. */
const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.pager=cat']
const SAFE_GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }

/** Drops the detects of folders the view no longer shows. */
function pruneCopies(list: StackwellFolder[], cwd: string | undefined): void {
  const keys = new Set(list.map(f => f.key))
  if (cwd) keys.add(cwd)
  for (const [dir, e] of copies) if (!keys.has(dir) && !(e.copy && keys.has(e.copy.root))) copies.delete(dir)
}

function folderFor(dir: string, copy: Copy | undefined, at: number, isCwd: boolean): StackwellFolder {
  const key = copy?.root ?? dir
  const f: StackwellFolder = {
    key,
    name: clean(baseOf(key)),
    isRepo: !!copy,
    isWorktree: !!(copy?.mainRoot && copy.mainRoot !== copy.root),
    isCwd,
    lastAt: at,
  }
  if (copy && !isCwd && !trusted.has(copy.root)) f.isOutside = true
  if (copy?.mainRoot) f.mainRoot = copy.mainRoot
  if (copy?.branch) f.branch = copy.branch
  if (isHatchItemBranch(copy?.branch)) f.tag = 'hatch'
  return f
}

/** Adds or refreshes folders by key; `isCwd` moves to the one given as the cwd. */
function touch(list: StackwellFolder[], add: StackwellFolder[]): StackwellFolder[] {
  let out = [...list]
  for (const f of add) {
    if (f.isCwd) out = out.map(x => (x.isCwd && x.key !== f.key ? { ...x, isCwd: false } : x))
    const i = out.findIndex(x => x.key === f.key)
    if (i < 0) out.push(f)
    else {
      const old = out[i]!
      // a folder first seen as plain that a later detect found to be a repo takes the repo facts
      const repo = f.isRepo && !old.isRepo ? { isRepo: true, isWorktree: f.isWorktree, branch: f.branch, mainRoot: f.mainRoot, tag: f.tag, isOutside: f.isOutside } : {}
      const next: StackwellFolder = { ...old, ...repo, lastAt: Math.max(old.lastAt, f.lastAt), isCwd: old.isCwd || f.isCwd }
      for (const k of ['branch', 'mainRoot', 'tag', 'isOutside'] as const) if (next[k] === undefined) delete next[k]
      out[i] = next
    }
  }
  return sortFolders(out).slice(0, MAX_FOLDERS)
}

/**
 * Branch and changes of the rows on show; only those, only at start, turn end and the minute tick.
 * Git runs only in the cwd's repository and its worktrees; a repo outside it gets its branch from
 * its HEAD file and no change counts.
 */
async function refreshFolders($: $, list: StackwellFolder[]): Promise<Map<string, Partial<StackwellFolder>>> {
  const out = new Map<string, Partial<StackwellFolder>>()
  for (const f of sortFolders(list).slice(0, REFRESH_ROWS)) {
    if (!f.isRepo) continue
    if (!f.isCwd && !trusted.has(f.key)) {
      const c = await fileCopy($, f.key)
      if (!c) continue
      out.set(f.key, { isOutside: true, branch: c.branch, tag: isHatchItemBranch(c.branch) ? 'hatch' : undefined, added: undefined, removed: undefined, untracked: undefined })
      continue
    }
    const c = await attempt(() => $.vcs.detect({ path: f.key }))
    if (!c) continue
    const patch: Partial<StackwellFolder> = { isOutside: undefined }
    if (c.branch) patch.branch = clean(c.branch)
    patch.tag = isHatchItemBranch(c.branch ?? undefined) ? 'hatch' : undefined
    const status = await attempt(() => $.vcs.status({ path: f.key }))
    if (status && status.unknown === undefined) {
      patch.untracked = status.changes.filter(x => x.state === 'untracked').length
      const diff = await attempt(() => $.vcs.diff({ path: f.key, vcs: c.vcs, base: 'head', isStatOnly: true }))
      const files = diff && diff.unknown === undefined ? diff.files : []
      patch.added = files.reduce((n, x) => n + x.added, 0)
      patch.removed = files.reduce((n, x) => n + x.removed, 0)
    }
    out.set(f.key, patch)
  }
  return out
}

const applyRefresh = (list: StackwellFolder[], patches: Map<string, Partial<StackwellFolder>>): StackwellFolder[] =>
  list.map(f => {
    const p = patches.get(f.key)
    if (!p) return f
    const out: StackwellFolder = { ...f, ...p }
    if (p.tag === undefined) delete out.tag
    for (const k of ['isOutside', 'branch', 'added', 'removed', 'untracked'] as const) if (k in p && p[k] === undefined) delete out[k]
    return out
  })

/** The session folder as a folder row: detected once, marked as the cwd. The raw paths are kept; the view gets them cleaned. */
async function cwdFolder($: $, at: number): Promise<{ folder?: StackwellFolder; cwd?: string; home?: string }> {
  const cwd = await attempt(() => $.session.cwd())
  const home = (await attempt(() => $.env.get('HOME'))) ?? ''
  if (home) rawHome = home
  if (!cwd) return (trusted = new Set()), { home: clean(home) }
  rawCwd = cwd
  const copy = await copyOf($, cwd)
  trusted = copy ? await trustedRoots($, copy) : new Set()
  // cleaned as draw cleans a folder's key, so its prefix tests match
  return { folder: folderFor(cwd, copy, at, true), cwd: clean(cwd), home: clean(home) }
}

// ---------------------------------------------------------------- hatch

/** Each repo's binders, kept until the binders folder's mtime changes. */
const binderFiles = new Map<string, { mtime: number; binders: { slug: string; items: { id: string; deps: string[] }[] }[] }>()

/** The binders of the folders' repos and their state from one ref listing per repo; never on render. */
async function readBinders($: $, list: StackwellFolder[]): Promise<StackwellBinder[]> {
  const repos = [...new Set(list.filter(f => f.isRepo).map(f => f.mainRoot ?? f.key))].slice(0, 8)
  const out: StackwellBinder[] = []
  for (const repo of repos) {
    const dir = `${repo}/.hatch/binders`
    const st = await attempt(() => $.fs.stat(dir))
    if (!st || st.kind !== 'dir') continue
    let cached = binderFiles.get(repo)
    if (!cached || cached.mtime !== st.mtimeMs) {
      const entries = (await attempt(() => $.fs.list(dir))) ?? []
      const binders: { slug: string; items: { id: string; deps: string[] }[] }[] = []
      for (const en of [...entries].sort((x, y) => x.name.localeCompare(y.name))) {
        if (en.kind !== 'file' || !en.name.endsWith('.json')) continue
        const text = await attempt(() => $.fs.read(`${dir}/${en.name}`))
        const b = typeof text === 'string' ? parseBinder(text) : undefined
        if (b) binders.push({ slug: clean(b.slug), items: b.items.map(i => ({ id: clean(i.id), deps: i.deps })) })
      }
      cached = { mtime: st.mtimeMs, binders }
      binderFiles.set(repo, cached)
    }
    if (cached.binders.length === 0) continue
    let refs: string[] = []
    if (trusted.has(repo)) {
      const run = await attempt(() =>
        $.process.run(['git', ...SAFE_GIT, 'for-each-ref', '--format=%(refname)', ...HATCH_REFS], { cwd: repo, env: SAFE_GIT_ENV, timeoutMs: 5000 }),
      )
      refs = run && run.exitCode === 0 ? run.stdout.split('\n') : []
    } else refs = await fileRefs($, repo)
    for (const b of cached.binders) out.push(binderState(b, refs))
  }
  return out
}

/**
 * Folders and hatch at once: what start, turn end and the minute tick read. It hands back the
 * cwd row and the git patches, not a folder list: withWorkspace lays them on the view as it is
 * when the update runs, so a folder an agent's end adds during these reads stays.
 */
async function readWorkspace($: $, list: StackwellFolder[], at: number) {
  const here = await cwdFolder($, at)
  const touched = here.folder ? touch(list, [here.folder]) : list
  const patches = await refreshFolders($, touched)
  const binders = await readBinders($, applyRefresh(touched, patches))
  return { here: here.folder, patches, binders, cwd: here.cwd, home: here.home }
}

const withWorkspace = (v: StackwellView, w: Awaited<ReturnType<typeof readWorkspace>>): StackwellView => {
  const folders = applyRefresh(w.here ? touch(v.folders, [w.here]) : v.folders, w.patches)
  const out: StackwellView = { ...v, folders, binders: w.binders }
  if (w.cwd) out.cwd = w.cwd
  if (w.home !== undefined) out.home = w.home
  return out
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
    const data = parseObject(text) as QuotaFile | undefined
    if (!data) continue
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

// ---------------------------------------------------------------- peer sessions

type SessionFile = { sessionId?: string; name?: string; status?: string; since?: number; mtime?: number; pid?: number; isDead?: boolean }

/** Each session file read, kept until its mtime changes. */
const sessionFiles = new Map<string, { mtime: number; info: SessionFile }>()

/** Reads a session file, or hands back the copy kept while its mtime is unchanged. */
async function sessionFile($: $, path: string): Promise<SessionFile | undefined> {
  const st = await attempt(() => $.fs.stat(path))
  if (!st || st.kind !== 'file') {
    sessionFiles.delete(path)
    return undefined
  }
  const kept = sessionFiles.get(path)
  if (kept && kept.mtime === st.mtimeMs) return kept.info
  const text = await attempt(() => $.fs.read(path))
  if (typeof text !== 'string') return undefined
  const d = parseObject(text)
  if (!d) return undefined
  const info: SessionFile = {}
  if (typeof d.sessionId === 'string') info.sessionId = d.sessionId
  if (typeof d.name === 'string') info.name = clean(d.name)
  if (typeof d.status === 'string') info.status = clean(d.status)
  const at = typeof d.statusUpdatedAt === 'number' ? d.statusUpdatedAt : typeof d.updatedAt === 'number' ? d.updatedAt : undefined
  if (at !== undefined) info.since = at
  info.mtime = st.mtimeMs
  if (typeof d.pid === 'number' && Number.isInteger(d.pid) && d.pid > 0) info.pid = d.pid
  sessionFiles.set(path, { mtime: st.mtimeMs, info })
  return info
}

/** The session folders: the option's list (a `*` part matches folders), else this session's own. */
async function sessionDirs($: $): Promise<string[]> {
  const home = (await attempt(() => $.env.get('HOME'))) ?? ''
  const own = (await attempt(() => $.env.get('CLAUDE_CONFIG_DIR'))) || `${home}/.claude`
  const patterns = config.sessionDirs.length ? config.sessionDirs : [`${own}/sessions`]
  const out: string[] = []
  for (const pat of patterns) {
    // `~/x` from home; a relative path under the config folder; `~user/` is not supported
    const tilde = expandHome(pat, home)
    const abs = tilde.startsWith('/') ? tilde : `${own}/${tilde.replace(/^\.\/+/, '')}`
    let bases = ['']
    for (const seg of abs.split('/').filter(Boolean)) {
      if (!seg.includes('*')) {
        bases = bases.map(b => `${b}/${seg}`)
        continue
      }
      const re = new RegExp('^' + seg.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
      const next: string[] = []
      for (const b of bases) {
        const entries = (await attempt(() => $.fs.list(b || '/'))) ?? []
        for (const en of entries) if (en.kind === 'dir' && re.test(en.name)) next.push(`${b}/${en.name}`)
      }
      bases = next
    }
    out.push(...bases)
  }
  return [...new Set(out)]
}

/** The session files that match the peers, and every file seen; read only when its mtime changed. */
async function scanSessions($: $): Promise<{ path: string; info: SessionFile }[]> {
  const out: { path: string; info: SessionFile }[] = []
  const seen = new Set<string>()
  for (const dir of await sessionDirs($)) {
    const entries = (await attempt(() => $.fs.list(dir))) ?? []
    for (const en of entries) {
      if (en.kind !== 'file' || !en.name.endsWith('.json')) continue
      const path = `${dir}/${en.name}`
      seen.add(path)
      const info = await sessionFile($, path)
      if (info) out.push({ path, info })
    }
  }
  // files gone from the folders leave the cache
  for (const path of sessionFiles.keys()) if (!seen.has(path)) sessionFiles.delete(path)
  return out
}

/** The files the shown peers were matched to: all the 15 s tick looks at. */
let peerPaths: string[] = []

const stamp = (i: SessionFile) => i.since ?? i.mtime ?? 0

/** Liveness of the pid a matched peer file names, by path, kept until that file's mtime changes. */
const pidChecks = new Map<string, { mtime: number; isDead: boolean }>()

/**
 * The peers' status with a dead pid read as offline: one `kill -0` per matched file that names a
 * pid, when the file changed since its last check or `isProbeAll` (the minute tick) asks; never on
 * render.
 */
async function withLiveStatus($: $, peers: StackwellPeer[], files: { path: string; info: SessionFile }[], isProbeAll = false): Promise<StackwellPeer[]> {
  // the matched paths first, from the liveness the files had
  withStatus(peers, files)
  for (const path of peerPaths) {
    const f = files.find(x => x.path === path)
    if (!f || f.info.pid === undefined) continue
    const mtime = f.info.mtime ?? 0
    let kept = pidChecks.get(path)
    if (isProbeAll || !kept || kept.mtime !== mtime) {
      const r = await attempt(() => $.process.run(['kill', '-0', String(f.info.pid)], { timeoutMs: 2000 }))
      kept = { mtime, isDead: !!r && r.exitCode !== 0 }
      pidChecks.set(path, kept)
    }
    f.info.isDead = kept.isDead
  }
  for (const path of pidChecks.keys()) if (!files.some(x => x.path === path)) pidChecks.delete(path)
  // again with what the probes found: a dead pid offline, a live one its status
  return withStatus(peers, files)
}

/** Each peer's status from its session file, by session id, else by name; `offline` when none. */
function withStatus(peers: StackwellPeer[], files: { path: string; info: SessionFile }[]): StackwellPeer[] {
  const paths: string[] = []
  const out = peers.map(p => {
    // by session id, the newest file of it (a resume leaves the old one); by name only without an id
    const byId = p.sessionId ? files.filter(f => f.info.sessionId === p.sessionId) : []
    const newest = (fs: typeof files) => fs.reduce<(typeof files)[number] | undefined>((m, f) => (!m || stamp(f.info) > stamp(m.info) ? f : m), undefined)
    const hit = p.sessionId ? newest(byId) : files.find(f => f.info.name === p.name)
    const q: StackwellPeer = { ...p }
    delete q.since
    if (hit?.info.isDead) {
      q.status = 'offline'
      paths.push(hit.path)
    } else if (hit?.info.status) {
      q.status = hit.info.status
      if (hit.info.since !== undefined) q.since = hit.info.since
      paths.push(hit.path)
    } else q.status = 'offline'
    return q
  })
  peerPaths = paths
  return out
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** This session's place in the registry; undefined when absent or not named there. `isProbeAll`: probe every peer's pid. */
async function readSteward($: $, isProbeAll = false): Promise<StackwellSteward | undefined> {
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
  const peer = (party: { name: string; text: string }, role: StackwellPeer['role']): StackwellPeer => {
    const p: StackwellPeer = { name: clean(party.name), role }
    const sid = UUID_RE.exec(party.text)?.[0]
    if (sid) p.sessionId = sid.toLowerCase()
    return p
  }
  const named: StackwellPeer[] = []
  if (m.role === 'secondary' && m.initiative.primary) named.push(peer(m.initiative.primary, 'primary'))
  for (const s of m.initiative.secondaries) if (s !== m.self) named.push(peer(s, 'secondary'))
  const peers = await withLiveStatus($, named, await scanSessions($), isProbeAll)
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

// ---------------------------------------------------------------- icon

/** The header's small copy of the mod's icon, base64 PNG, read once per session start (or first render after a load). */
let icon: string | undefined
let isIconTried = false

async function loadIcon($: $): Promise<void> {
  if (isIconTried || !config.showIcon) return
  isIconTried = true
  const got = await attempt(() => $.fs.read(`${$.plugin.root}/assets/header-icon.png`, { as: 'bytes' }))
  const b64 = (got as { base64?: unknown } | undefined)?.base64
  icon = typeof b64 === 'string' && b64 ? b64 : undefined
}

/** The section icons, base64 PNG by theme lightness, read once per session start (or first render after a load). */
let sections: Partial<Record<'dark' | 'light', Record<Section, string>>> = {}
let isSectionsTried = false

async function loadSections($: $): Promise<void> {
  if (isSectionsTried || !config.showIcon) return
  isSectionsTried = true
  sections = {}
  for (const set of ['dark', 'light'] as const) {
    const got: Partial<Record<Section, string>> = {}
    for (const name of SECTIONS) {
      const r = await attempt(() => $.fs.read(`${$.plugin.root}/assets/sections/${set}/${name}.png`, { as: 'bytes' }))
      const b64 = (r as { base64?: unknown } | undefined)?.base64
      if (typeof b64 === 'string' && b64) got[name] = b64
    }
    // a set with a picture missing is not used: the words stand instead
    if (SECTIONS.every(n => got[n])) sections[set] = got as Record<Section, string>
  }
}

async function toggleFolders($: $): Promise<boolean> {
  const cur = await read($, view)
  const isOpen = cur.isFoldersOpen !== true
  await attempt(() => $.store.set('isFoldersOpen', isOpen))
  await update($, view, v => ({ ...v, isFoldersOpen: isOpen }))
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

/** Both chains again, unless one is already armed; a failed read arms none. */
async function rearm($: $): Promise<void> {
  arm($)
  await attempt(async () => armFast($, await read($, view)))
}

async function tick($: $): Promise<void> {
  let isLive = false
  try {
    const panes = await attempt(() => $.ui.panes())
    // a closed pane ends the chain; a lookup that failed skips this minute only
    if (panes && !panes.some(p => p.id === PANE)) return
    isLive = true
    if (!panes) return
    const now = toMinute(await nowMs($))
    const accounts = await readAccounts($, now)
    // once a minute every matched peer's pid, changed file or not
    const steward = await readSteward($, true)
    const ws = await readWorkspace($, (await read($, view)).folders, await nowMs($))
    pruneCopies((await read($, view)).folders, rawCwd)
    await syncAgents($)
    await change($, v => {
      const next = withWorkspace(withSteward({ ...v, accounts: accounts ?? v.accounts }, steward), ws)
      const isSame =
        clockSignature(v, v.now) === clockSignature(next, now) &&
        JSON.stringify([next.accounts, next.steward, next.folders, next.binders]) === JSON.stringify([v.accounts, v.steward, v.folders, v.binders])
      return isSame ? v : { ...next, now }
    })
  } catch {
    // one failed read skips this minute, never the chain
  } finally {
    if (isLive) await rearm($)
  }
}

let fast: { cancel: () => void } | undefined

/** The 15 s chain: only while the steward section shows and the pane is open; stats the peers' files. */
function armFast($: $, v: StackwellView): void {
  if (fast || !v.steward || peerPaths.length === 0) return
  fast = $.clock.after(FAST, () => {
    fast = undefined
    void fastTick($)
  })
}

async function fastTick($: $): Promise<void> {
  let isLive = false
  try {
    const v = await read($, view)
    const panes = await attempt(() => $.ui.panes())
    // no steward section or a closed pane ends the chain
    if (!v.steward || !panes?.some(p => p.id === PANE)) return
    isLive = true
    const files: { path: string; info: SessionFile }[] = []
    for (const path of peerPaths) {
      const info = await sessionFile($, path)
      if (info) files.push({ path, info })
    }
    const peers = await withLiveStatus($, v.steward.peers, files)
    await change($, x => (x.steward ? { ...x, steward: { ...x.steward, peers } } : x))
    await syncAgents($)
  } catch {
    // one failed read skips these 15 seconds, never the chain
  } finally {
    if (isLive) await attempt(async () => armFast($, await read($, view)))
  }
}

async function openPane($: $): Promise<void> {
  await attempt(() => $.ui.open({ id: PANE, title: TITLE, columns: 53 }))
  arm($)
  armFast($, await read($, view))
}

/** A model id or alias fit to store, else undefined. */
const modelText = (m: unknown): string | undefined => (typeof m === 'string' && clean(m) ? clean(m).slice(0, 60) : undefined)

/** What the engine says an agent runs on: its last request's model and effort, else the ones set for it. */
function engineOf(a: AgentInfo | undefined): ModelEffort | undefined {
  if (!a) return undefined
  return {
    model: modelText(a.lastRequest?.model) ?? modelText(a.model),
    effort: effortText(a.lastRequest?.effort) ?? effortText(a.effort),
  }
}

/** Model and effort onto an agent, the engine's first, then what it already has (the profile name's). */
function withEngine(a: StackwellAgent, engine: ModelEffort | undefined): StackwellAgent {
  const out = { ...a }
  const me = pickModelEffort(engine, a)
  if (me.model) out.model = me.model
  if (me.effort) out.effort = me.effort
  return out
}

/** Each listed agent's working folder, raw: what its relative paths resolve against. */
const agentCwds = new Map<string, string>()
const MAX_KEPT = 64

/** Sets `k`, the oldest going first past MAX_KEPT. */
function keep<V>(m: Map<string, V>, k: string, v: V): void {
  m.delete(k)
  m.set(k, v)
  while (m.size > MAX_KEPT) m.delete(m.keys().next().value!)
}

/** One `$.agent.list()`, by id; undefined when it throws or answers no list. */
async function listAgents($: $): Promise<Map<string, AgentInfo> | undefined> {
  const list = await attempt(() => $.agent.list())
  if (!Array.isArray(list)) return undefined
  const out = new Map<string, AgentInfo>()
  for (const a of list) {
    if (!a || typeof a.id !== 'string') continue
    out.set(a.id, a)
    if (typeof a.cwd === 'string' && a.cwd) keep(agentCwds, a.id, a.cwd)
  }
  return out
}

/**
 * The agent's name (its description, else its kind), its kind and plugin from its type, and its
 * model and effort: the engine's, else the profile name's.
 */
function agentFields(description: unknown, type: unknown, engine?: ModelEffort): Pick<StackwellAgent, 'name' | 'kind' | 'plugin' | 'model' | 'effort'> {
  const d = typeof description === 'string' ? description : ''
  const t = typeof type === 'string' ? type : ''
  const k = agentKind(t)
  const out: Pick<StackwellAgent, 'name' | 'kind' | 'plugin' | 'model' | 'effort'> = { name: clean(d || k?.kind || t.split(/[.:]/).pop() || 'agent').slice(0, 160) }
  if (k) out.kind = clean(k.kind).slice(0, 60)
  if (k?.plugin) out.plugin = clean(k.plugin).slice(0, 40)
  const me = pickModelEffort(engine, profileOf(t))
  // a profile's effort only as the last word, read for the model it runs on
  if (!engine?.effort) me.effort = suffixEffort(t, me.model)
  if (me.model) out.model = me.model
  if (me.effort) out.effort = me.effort
  return out
}

const LIVE: ReadonlySet<string> = new Set(['running', 'pending', 'waiting'])

/** A listed agent as a row: running, from its start time (never later than `now`). */
function fromInfo(a: AgentInfo, now: number): StackwellAgent {
  const startedAt = typeof a.startTime === 'number' && a.startTime > 0 ? Math.min(a.startTime, now) : now
  return { id: `agent:${clean(a.id)}`, agentId: a.id, ...agentFields(a.description, a.type, engineOf(a)), isBackground: false, status: 'running', startedAt }
}

/**
 * A running agent against the list taken at `listAt`: the engine's model and effort while it is
 * live; ended when the list no longer has it live. One started after the list was taken, or
 * without an engine id, stays as it is; one already ended stays ended.
 */
function withList(a: StackwellAgent, list: Map<string, AgentInfo>, listAt: number): StackwellAgent {
  if (a.status !== 'running' || !a.agentId || a.startedAt > listAt) return a
  const info = list.get(a.agentId)
  const out = info ? withEngine(a, engineOf(info)) : a
  if (info && LIVE.has(info.status)) return out
  const hasFailed = info?.status === 'failed' || info?.status === 'killed'
  return { ...out, status: hasFailed ? 'failed' : 'ok', endedAt: listAt }
}

/**
 * The view's agents after a list read at `at`: those ended more than 5 minutes ago go, the
 * running ones take what the list says, and the live agents the view does not hold join it.
 */
export function mergeAgents(agents: StackwellAgent[], list: Map<string, AgentInfo>, at: number): StackwellAgent[] {
  const seen = new Set(agents.map(a => a.agentId).filter(Boolean))
  const kept = agents.filter(a => a.status === 'running' || (a.endedAt ?? 0) > at - AGENT_KEEP).map(a => withList(a, list, at))
  const added = [...list.values()].filter(a => LIVE.has(a.status) && !seen.has(a.id)).map(a => fromInfo(a, at))
  return [...kept, ...added].slice(-MAX_AGENTS)
}

/** One list read merged into the view; a read that fails changes nothing. */
async function syncAgents($: $): Promise<void> {
  const at = await nowMs($)
  const list = await listAgents($)
  if (!list) return
  await change($, v => ({ ...v, agents: mergeAgents(v.agents, list, at) }))
}

/**
 * An agent's own turn.complete: it ended, ok or failed, with its last request's model and effort.
 * One the view never held joins it as ended, when the list knows it.
 */
async function endAgent($: $, agentId: string, hasFailed: boolean): Promise<void> {
  const end = await nowMs($)
  const info = (await listAgents($))?.get(agentId)
  const engine = engineOf(info)
  await change($, v => {
    const has = v.agents.some(a => a.agentId === agentId)
    const agents = has || !info ? v.agents : [...v.agents, fromInfo(info, end)]
    return {
      ...v,
      agents: agents
        .map(a => (a.agentId === agentId && a.status === 'running' ? { ...withEngine(a, engine), status: hasFailed ? ('failed' as const) : ('ok' as const), endedAt: end } : a))
        .slice(-MAX_AGENTS),
    }
  })
}

// ---------------------------------------------------------------- folders from the history

/** Each conversation's last row read, by agent id; `''` the main one's. */
const cursors = new Map<string, string>()
/** Rows a conversation's first read takes: the newest. */
const FIRST_READ = 200
/** Paths of unknown kind stat-ed, and folders detected, per read. */
const MAX_STATS = 16
const MAX_DETECTS = 12

/**
 * The tool uses of the rows added since the last read of this conversation (main's without an
 * agent id): the newest FIRST_READ rows the first time, then those after the last row read. A
 * row a compaction or rewind left behind anchors no more (a deny): then the newest again. A read
 * that fails keeps its place and hands back nothing. `isSeed` when the newest were read: rows
 * read before (a reload lost the place, or a compaction kept them) may be among them.
 */
async function newToolUses($: $, agentId?: string): Promise<{ uses: ToolUseSummary[]; isSeed: boolean }> {
  const key = agentId ?? ''
  const who = agentId ? { agentId } : {}
  const after = cursors.get(key)
  const isDeny = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x) && 'deny' in x
  let got = await attempt(() => $.session.messages(after ? { ...who, after } : { ...who, last: FIRST_READ }))
  let isSeed = !after
  if (after && isDeny(got)) {
    cursors.delete(key)
    got = await attempt(() => $.session.messages({ ...who, last: FIRST_READ }))
    isSeed = true
  }
  if (!Array.isArray(got)) return { uses: [], isSeed }
  const uuid = got[got.length - 1]?.uuid
  if (typeof uuid === 'string' && uuid) keep(cursors, key, uuid)
  const uses = got.flatMap(m => (m && m.role === 'assistant' && Array.isArray(m.toolUses) ? m.toolUses.filter(u => u && typeof u.tool === 'string') : []))
  return { uses, isSeed }
}

const inputOf = (u: ToolUseSummary): Record<string, unknown> => (u.input && typeof u.input === 'object' ? u.input : {})

/**
 * The folders the tool uses named, the most recent use's last: a file stands for its folder (a
 * stat decides a path that does not say), system paths never; each detected once.
 */
async function foldersOf($: $, uses: ToolUseSummary[], cwd: string, home: string, at: number): Promise<StackwellFolder[]> {
  if (!cwd || uses.length === 0) return []
  const unknown = new Set<string>()
  for (const u of uses) for (const t of touchedPaths(u.tool, inputOf(u), cwd, home) as TouchedPath[]) if (!t.kind) unknown.add(t.path)
  const kinds = new Map<string, 'file' | 'dir'>()
  for (const path of [...unknown].slice(-MAX_STATS)) {
    const st = await attempt(() => $.fs.stat(path))
    if (st?.kind === 'file' || st?.kind === 'dir') kinds.set(path, st.kind)
  }
  // each folder at its latest use
  const last = new Map<string, number>()
  uses.forEach((u, i) => {
    for (const dir of touchedFolders(u.tool, inputOf(u), cwd, home, kinds)) last.set(dir, i)
  })
  const dirs = [...last.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DETECTS)
  const out: StackwellFolder[] = []
  for (const [dir, i] of dirs) out.push(folderFor(dir, await copyOf($, dir), at - (uses.length - 1 - i), false))
  return out
}

/** The agents the main conversation's Agent tool uses started in the background. */
const backgroundIds = (uses: ToolUseSummary[]): Set<string> =>
  new Set(uses.filter(u => u.tool === 'Agent' && typeof u.agentId === 'string' && inputOf(u).run_in_background === true).map(u => u.agentId!))

/** The folders one agent's tool uses named since its last read, against its own folder. */
async function agentFolders($: $, agentId: string): Promise<void> {
  const base = await pathBase($)
  const { uses } = await newToolUses($, agentId)
  const touched = await foldersOf($, uses, agentCwds.get(agentId) ?? base.cwd, base.home, await nowMs($))
  if (touched.length) await change($, v => ({ ...v, folders: touch(v.folders, touched) }))
}

/**
 * The main turn end, after the turn went on: the folders its tool uses named first, then the
 * reads side by side, merged into the view as it is then. A read that fails keeps what the view had.
 */
async function mainTurnEnd($: $): Promise<void> {
  const nowExact = await nowMs($)
  const now = toMinute(nowExact)
  const base = await pathBase($)
  const { uses, isSeed } = await newToolUses($)
  const touched = await foldersOf($, uses, base.cwd, base.home, nowExact)
  const bg = backgroundIds(uses)
  // a re-read of the newest rows adds the folders the view lacks, never ages the ones it holds
  const fresh = (v: StackwellView) => (isSeed ? touched.filter(f => !v.folders.some(x => x.key === f.key)) : touched)
  if (touched.length || bg.size)
    await change($, v => ({
      ...v,
      folders: fresh(v).length ? touch(v.folders, fresh(v)) : v.folders,
      agents: v.agents.map(a => (a.agentId && bg.has(a.agentId) && !a.isBackground ? { ...a, isBackground: true } : a)),
    }))
  const cur = await read($, view)
  const [info, usage, steward, ws, accounts, listed] = await Promise.allSettled([
    readInfo($),
    // startedAt here too, for a view that has none yet
    readUsage($),
    readSteward($),
    readWorkspace($, cur.folders, nowExact),
    readAccounts($, now),
    listAgents($),
  ])
  const u = settled(usage), list = settled(listed)
  await change($, v => {
    let out: StackwellView = v
    if (info.status === 'fulfilled') out = mergeInfo(out, info.value)
    if (steward.status === 'fulfilled') out = withSteward(out, steward.value)
    if (ws.status === 'fulfilled') out = withWorkspace(out, ws.value)
    const tokens = u?.tokens ?? v.tokens
    const usd = u?.usd ?? v.costUsd
    out = {
      ...out,
      breakdown: u?.breakdown ?? v.breakdown,
      startedAt: u?.startedAt ?? v.startedAt,
      accounts: settled(accounts) ?? v.accounts,
      trend: tokens === undefined ? v.trend : [...v.trend, tokens].slice(-MAX_TREND),
      agents: list ? mergeAgents(v.agents, list, nowExact) : v.agents.filter(a => a.status === 'running' || (a.endedAt ?? 0) > nowExact - AGENT_KEEP),
      now,
    }
    if (tokens !== undefined) out.tokens = tokens
    if (usd !== undefined) out.costUsd = usd
    return out
  })
  armFast($, await read($, view))
}

/** The view at session start: theme, title facts, usage, steward, folders, accounts, live agents. Never awaited by a hook. */
async function seed($: $): Promise<void> {
  isIconTried = false
  isSectionsTried = false
  await loadIcon($)
  await loadSections($)
  await attempt(() =>
    $.command.register({
      name: 'stackwell',
      description: 'Stackwell pane: open it, or on | off | theme <name>',
      argumentHint: 'on | off | theme <auto|vga|mocha|tokyo-night|latte>',
    }),
  )
  // a /stackwell theme choice stands over the option
  const stored = await attempt(() => $.store.get('theme'))
  const isKnown = (t: unknown): t is string => typeof t === 'string' && (THEMES as readonly string[]).includes(t)
  const theme = isKnown(stored) ? stored : isKnown(config.theme) ? config.theme : 'auto'
  const palette = await readPalette($, theme)
  const info = await readInfo($)
  const { breakdown } = await readUsage($)
  const steward = await readSteward($)
  const startView = await read($, view)
  const ws = await readWorkspace($, startView.folders, await nowMs($))
  const isFoldersOpen = (await attempt(() => $.store.get('isFoldersOpen'))) === true
  const usage = await attempt(() => $.session.usage())
  const now = toMinute(await nowMs($))
  const accounts = await readAccounts($, now, true)
  // a reload can reset the view (a new shape tag) while an agent runs on: the list brings it back
  const listAt = await nowMs($)
  const list = await listAgents($)
  await attempt(() =>
    change($, v => ({
      ...withWorkspace(withSteward(mergeInfo(v, info), steward), ws),
      agents: list ? mergeAgents(v.agents, list, listAt) : v.agents,
      isFoldersOpen,
      theme,
      palette,
      breakdown: breakdown ?? v.breakdown,
      tokens: usage?.context.tokens ?? v.tokens,
      window: usage?.context.window ?? v.window,
      percent: usage?.context.percent ?? v.percent,
      quotas: usage ? toQuotas(usage.rateLimits) : v.quotas,
      costUsd: usage?.cost?.usd ?? v.costUsd,
      startedAt: usage?.startedAt ?? v.startedAt,
      accounts: accounts ?? v.accounts,
      now,
    })),
  )
}

// ---------------------------------------------------------------- register

/**
 * Applies one session.measure: context, quotas and cost. The quotas change only when the event
 * says they moved (or none are shown yet).
 */
async function applyMeasure($: $, e: SessionMeasureInput): Promise<void> {
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
}

// ---------------------------------------------------------------- register

/**
 * Stackwell observes and never stands in a call's path: no tool, spawn, append or compact hook.
 * Each hook passes its event on first, returns what came back unchanged, and reads after it
 * returns (detached; one run of a job at a time).
 */
export const register: Register = (on, options) => {
  config = readConfig(options)
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    runOnce('seed', async () => {
      try {
        await seed($)
      } catch {
        // one failed read must not keep the pane shut
      }
      const isOff = (await attempt(() => $.store.get('isOff'))) === true
      if (!isOff && e.isInteractive) await attempt(() => openPane($))
    })
    return r
  })

  on('command.run', { command: 'stackwell' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === 'off') {
      await attempt(() => $.store.set('isOff', true))
      await attempt(() => $.ui.close({ id: PANE }))
      timer?.cancel()
      timer = undefined
      fast?.cancel()
      fast = undefined
      return { text: 'Stackwell is off; /stackwell on brings it back.' }
    }
    if (verb === '' || verb === 'on') {
      if (verb === 'on') await attempt(() => $.store.delete('isOff'))
      await openPane($)
      return { text: 'Stackwell is open.' }
    }
    if (verb === 'theme') {
      if (!(THEMES as readonly string[]).includes(arg)) return { text: `Themes: ${THEMES.join(', ')}.` }
      await attempt(() => $.store.set('theme', arg))
      const palette = await readPalette($, arg)
      await change($, v => ({ ...v, theme: arg, palette }))
      return { text: `Stackwell theme: ${arg}.` }
    }
    return { text: 'Usage: /stackwell [on | off | theme <name>]' }
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    // every measure in order: one that moved the quotas is never folded into one that did not
    serial('measure', () => applyMeasure($, e))
    return r
  })

  // a turn starts, main's or an agent's: an agent's own first turn is when the list first has it
  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    runOnce('agents', () => syncAgents($))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) {
      // an agent's loop ended: ok, or failed when aborted; then the folders its tool uses named
      const agentId = e.agentId
      const hasFailed = e.isAborted === true
      runOnce(`end:${agentId}`, async () => {
        await attempt(() => endAgent($, agentId, hasFailed))
        await attempt(() => agentFolders($, agentId))
      })
      return r
    }
    const ms = e.durationMs
    // the turn count outside the reads' guard: every turn counts, whatever runs
    detach(() => update($, view, v => ({ ...v, turns: v.turns + 1, lastTurnMs: ms })))
    runOnce('turnEnd', () => mainTurnEnd($))
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = settleView(await read($, view))
    // the narrower of the body and the measured viewport, less one column: the
    // live pane clips its last column, so leave it blank; draw adds 2-column margins
    const cols = Math.min(e.props.bodyColumns, e.viewport?.columns ?? e.props.bodyColumns) - 1
    // the room's rows: never draw past them
    const rows = Math.min(e.props.scroll?.bodyRows ?? Infinity, e.viewport?.rows ?? Infinity)
    await loadIcon($)
    await loadSections($)
    const resolved = $.ui.resolve(e)
    const { Box, Text, Button } = resolved
    // pictures only where the surface's table has an Image; elsewhere the words
    const Image = e.surface === 'terminal' && 'Image' in resolved ? resolved.Image : undefined
    const hasIcon = !!(config.showIcon && icon && Image)
    const set = Image && config.showIcon ? sections[isDarkBg(v.palette.bg) ? 'dark' : 'light'] : undefined
    const parts = drawParts(v, cols, Number.isFinite(rows) ? rows : 200, hasIcon, !!set)
    const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
    const picture = (sl: Slot, key: string) =>
      Image && set ? <Image key={key} source={{ png: set[sl.icon as Section] }} columns={SECTION_COLS} rows={1} alt={sl.alt} /> : null
    const imageKey = (sl: Slot, at: string) => `icon-${sl.isBadge ? 'badge' : sl.icon}-${at}-${sl.y}-${sl.x}`
    // a cut row's whole text: a card the surface shows while the pointer is on the row, no hook
    // run; draw chose which way it opens (clear of the Buttons and the pane's end). The row and
    // its card share one hover scope; the cards go last in the root Box, placed against it at
    // the row's pane row, so they paint over every row (a placed Box paints over those before it)
    const P = v.palette
    const HL = hex(blend(P.text, P.bg, 0.2))
    const scopeOf = (c: Card) => `stackwell-card-${c.at}`
    /** The cards to place, in order, each with its row in the root. */
    const placed: { c: Card; top: number }[] = []
    const pinnedAt = (await attempt(async () => pinShown(await read($, pin), await $.clock.now()))) ?? -1
    const cardBox = ({ c, top }: { c: Card; top: number }) => (
      <Box
        position="absolute"
        {...(c.at === pinnedAt ? { hover: { scope: scopeOf(c) } } : { display: 'none' as const, hover: { scope: scopeOf(c), display: 'flex' as const } })}
        top={top}
        left={0}
        width={c.width}
        flexDirection="column"
        borderStyle="round"
        borderColor={hex(P.dim)}
        backgroundColor={hex(blend(P.text, P.bg, 0.1))}
        paddingX={1}
      >
        {c.lines.map(l => (
          <Text color={hex(P.text)} wrap="wrap">{l === '' ? ' ' : l}</Text>
        ))}
      </Box>
    )
    /**
     * The row in a Box that joins its card's scope, the card queued for the root; the row alone
     * when nothing was cut. `top` is where the card goes, by default the pane row draw chose.
     */
    const withCard = (c: Card | undefined, el: JSX.Element, top?: number) => {
      if (!c) return el
      placed.push({ c, top: top ?? c.top })
      return (
        <Box key={scopeOf(c)} hover={{ scope: scopeOf(c) }} flexDirection="column">
          {el}
        </Box>
      )
    }
    /** A press on a cut row: its card's whole text to the clipboard, a toast saying whether it took. */
    const copyCard = (c: Card) => async (press: UiPressArgument) => {
      try {
        const r = await $.ui.copy({ text: c.text, surface: press.surface })
        $.ui.toast(r.isCopied ? 'copied' : `copy failed: ${r.reason}`)
      } catch (err) {
        try {
          $.ui.toast(`copy failed: ${err instanceof Error ? err.message : String(err)}`)
        } catch {}
      }
      // the same click pins the card open, so the pointer need not travel to it
      await attempt(() => togglePin($, c.at))
    }
    /**
     * Part of a cut row as a plain Button that copies its card: only Button takes a press (Box
     * and Text take hover alone) and it holds only Text, so icons stand between such Buttons.
     */
    const copyButton = (c: Card, part: string, texts: JSX.Element[]) => (
      <Button key={`stackwell-copy-${c.at}-${part}`} plain onPress={copyCard(c)}>
        {texts}
      </Button>
    )
    /** A cut row's cells from x0 to x1 as Text runs of one color each, every run in the scope. */
    const runs = (sc: Screen, y: number, x0: number, x1: number, scope: string) => {
      const out: JSX.Element[] = []
      let text = '', fg = -1
      const flushRun = () => {
        if (text === '') return
        const color = fg === DEFAULT_COLOR ? undefined : hex(fg)
        out.push(
          <Text {...(color ? { color } : {})} wrap="truncate-end" hover={{ scope, backgroundColor: HL }}>
            {text}
          </Text>,
        )
        text = ''
      }
      for (let x = x0; x < x1; x++) {
        const i = (y * sc.w + x) * 3
        const f = sc.cells[i + 1]!
        if (f !== fg) flushRun(), (fg = f)
        text += String.fromCodePoint(sc.cells[i] || 0x20)
      }
      flushRun()
      return out
    }
    // a Raster takes no clicks: the folders toggle is a Button between Rasters;
    // a Button holds only text, so an icon that leads the row stands before it
    const buttonRow = (row: Row, which: 'folders') => {
      const slots = set ? rowSlots(row) : []
      const lastEnd = slots.length ? slots[slots.length - 1]!.x + SECTION_COLS : 0
      const lead: Row = [], rest: Row = []
      let x = 0
      for (const sg of row) (x < lastEnd ? lead : rest).push(sg), (x += Array.from(sg.text).length)
      const key = FOLDERS_KEY
      const press = () => toggleFolders($)
      return (
        <Box flexDirection="row" paddingLeft={2}>
          {lead.map((sg, k) => (sg.icon ? picture({ x: 0, y: 0, icon: sg.icon, alt: sg.alt ?? sg.icon, isBadge: false }, `icon-${sg.icon}-${which}-${k}`) : <Text>{sg.text}</Text>))}
          <Button key={key} label={which} plain onPress={press}>
            {rest.map(sg => (
              <Text color={hex(sg.fg || v.palette.text)}>{sg.text}</Text>
            ))}
          </Button>
        </Box>
      )
    }
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const raster = (sc: Screen, key: string) => <Raster key={key} columns={sc.w} rows={sc.h} cells={toBase64(sc.cells)} />
      /** One Raster; where icons or cards go, Rasters around Images and scoped Text rows, row by row. */
      const screen = (sc: Screen, key: string) => {
        const slotsAt = (y: number) => (set ? sc.slots.filter(sl => sl.y === y).sort((a, b) => a.x - b.x) : [])
        if (sc.cards.length === 0 && (!set || sc.slots.length === 0)) return raster(sc, key)
        const out = []
        let y0 = 0
        const flush = (y1: number) => {
          if (y1 > y0) out.push(raster(sc.sub(0, y0, sc.w, y1 - y0), `${key}-r${y0}`))
        }
        for (let y = 0; y < sc.h; y++) {
          const slots = slotsAt(y)
          const card = sc.cards.find(c => c.y === y)
          if (slots.length === 0 && !card) continue
          flush(y)
          // a cut row is Text runs (a Raster takes no hover); a row with icons, Images between them
          const cells = (x0: number, x1: number) =>
            card ? [copyButton(card, `${x0}`, runs(sc, y, x0, x1, scopeOf(card)))] : [raster(sc.sub(x0, y, x1 - x0, 1), `${key}-c${y}-${x0}`)]
          const line: JSX.Element[] = []
          let x = 0
          for (const sl of slots) {
            if (sl.x > x) line.push(...cells(x, sl.x))
            const pic = picture(sl, imageKey(sl, key))
            if (pic) line.push(pic)
            x = sl.x + SECTION_COLS
          }
          if (x < sc.w) line.push(...cells(x, sc.w))
          out.push(withCard(card, <Box flexDirection="row">{line}</Box>))
          y0 = y + 1
        }
        flush(sc.h)
        return <Box flexDirection="column">{out}</Box>
      }
      const head = parts.head
      // the header's cards as one, opening below the header
      const headCard = head && head.cards.length ? { ...head.cards[0]!, width: cols, lines: head.cards.flatMap(c => c.lines), text: head.cards.map(c => c.text).join('\n'), isUp: false } : undefined
      const headCells = (sc: Screen) =>
        headCard ? (
          <Box flexDirection="column">
            {Array.from({ length: sc.h }, (_, y) => (
              <Box flexDirection="row">{copyButton(headCard, `h${y}`, runs(sc, y, 0, sc.w, scopeOf(headCard)))}</Box>
            ))}
          </Box>
        ) : (
          <Raster key="pane-head" columns={sc.w} rows={sc.h} cells={toBase64(sc.cells)} />
        )
      const body = [
        hasIcon && head && Image
          ? withCard(
              headCard,
              <Box flexDirection="row">
                <Box paddingLeft={2} paddingTop={1}>
                  <Image key="stackwell-icon" source={{ png: icon! }} columns={ICON_COLS} rows={2} alt={ICON_ALT} />
                </Box>
                <Box paddingLeft={1}>{headCells(head)}</Box>
              </Box>,
              head.h,
            )
          : null,
        ...parts.pieces.map((p, i) => ('screen' in p ? screen(p.screen, i === 0 ? 'pane-top' : `pane-part-${i}`) : buttonRow(p.row, p.button))),
      ]
      return (
        <Box flexDirection="column">
          {body}
          {placed.map(cardBox)}
        </Box>
      )
    }
    const text = (sc: Screen) =>
      sc.lines().map((line, y) => {
        const c = sc.cards.find(k => k.y === y)
        const t = line === '' ? ' ' : line
        return withCard(
          c,
          c ? (
            copyButton(c, 'row', [
              <Text wrap="truncate-end" hover={{ scope: scopeOf(c), backgroundColor: HL }}>
                {t}
              </Text>,
            ])
          ) : (
            <Text>{t}</Text>
          ),
        )
      })
    const rowsOut = parts.pieces.map(p => ('screen' in p ? text(p.screen) : buttonRow(p.row, p.button)))
    return (
      <Box flexDirection="column">
        {rowsOut}
        {placed.map(cardBox)}
      </Box>
    )
  })
}
