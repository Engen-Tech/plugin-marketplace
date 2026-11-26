// Pure helpers for the folders section: which folders a tool use named, and how to show a path.

/** `/a/b/../c/./d` -> `/a/c/d`; a relative path is joined to `cwd` first. */
export function resolvePath(path: string, cwd: string, home: string): string {
  let p = path.trim().replace(/^['"]|['"]$/g, '')
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1)
  if (!p.startsWith('/')) p = `${cwd.replace(/\/+$/, '')}/${p}`
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

export const dirname = (p: string): string => {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export const basename = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

/** A path that names a file (a dot in its last part) stands for its folder: the guess without a stat. */
const folderOf = (p: string): string => (/\.[^/]+$/.test(basename(p)) ? dirname(p) : p)

/** Words of a shell command, quotes kept off; good enough for paths without spaces. */
const words = (s: string): string[] => (s.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(w => w.replace(/^['"]|['"]$/g, ''))

/** System and device trees: never a folder of the work, save the cwd itself under /tmp. */
const SYSTEM = ['/dev', '/proc', '/sys', '/usr', '/bin', '/sbin', '/etc', '/tmp']
const isSystem = (p: string) => SYSTEM.some(r => p === r || p.startsWith(r + '/'))

/** A path a tool use named, absolute; `kind` when the call says what it is, none when only a stat can tell. */
export type TouchedPath = { path: string; kind?: 'file' | 'dir' }

/**
 * The paths a tool use named, absolute: a file for Read, Edit, Write and NotebookEdit; a folder for
 * `cd <dir>` and `git -C <dir>`; Grep's and Glob's `path` and the absolute paths of a Bash command's
 * first segment unknown. Best effort.
 */
export function touchedPaths(tool: string, input: Record<string, unknown>, cwd: string, home: string): TouchedPath[] {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const out = new Map<string, TouchedPath>()
  const add = (p: string, kind?: 'file' | 'dir') => {
    if (!p || p === '-') return
    // a relative path needs an absolute cwd to mean anything
    const isAbs = p.startsWith('/') || p === '~' || p.startsWith('~/')
    if (!isAbs && !cwd.startsWith('/')) return
    const path = resolvePath(p, cwd, home)
    if (path === '/') return
    const kept = out.get(path)
    if (!kept) out.set(path, kind ? { path, kind } : { path })
    else if (!kept.kind && kind) kept.kind = kind
  }
  if (['Read', 'Edit', 'Write', 'MultiEdit'].includes(tool)) add(str('file_path'), 'file')
  else if (tool === 'NotebookEdit') add(str('notebook_path'), 'file')
  else if (tool === 'Grep' || tool === 'Glob') add(str('path'))
  else if (tool === 'Bash') {
    const cmd = str('command')
    const all = words(cmd)
    for (let i = 0; i < all.length - 1; i++) {
      if (all[i] === 'cd') add(all[i + 1]!, 'dir')
      if (all[i] === 'git' && all[i + 1] === '-C' && all[i + 2]) add(all[i + 2]!, 'dir')
    }
    const first = cmd.split(/&&|\|\||[;|\n]/)[0] ?? ''
    for (const w of words(first)) if (w.startsWith('/') || w.startsWith('~/')) add(w)
  }
  return [...out.values()]
}

/**
 * The folders a tool use named, absolute: a file stands for its folder. A path of unknown kind
 * is a folder only when `kinds` (a stat of it) says `dir`, else its folder; without `kinds`, a
 * dot in its last part makes it a file.
 */
export function touchedFolders(tool: string, input: Record<string, unknown>, cwd: string, home: string, kinds?: ReadonlyMap<string, 'file' | 'dir'>): string[] {
  const isCwdTmp = cwd === '/tmp' || cwd.startsWith('/tmp/')
  const out = new Set<string>()
  for (const t of touchedPaths(tool, input, cwd, home)) {
    const kind = t.kind ?? kinds?.get(t.path)
    const dir = kind === 'dir' ? t.path : kind === 'file' || kinds ? dirname(t.path) : folderOf(t.path)
    if (!dir.startsWith('/') || dir === '/') continue
    if (isSystem(dir) && !(isCwdTmp && (dir === cwd || dir.startsWith(cwd + '/')))) continue
    out.add(dir)
  }
  return [...out]
}

/** The path for the header: `~` for the home folder, the middle elided to fit `room`. */
export function shortPath(path: string, home: string, room: number): string {
  let p = path
  if (home && (p === home || p.startsWith(home + '/'))) p = '~' + p.slice(home.length)
  const chars = (s: string) => Array.from(s).length
  if (chars(p) <= room) return p
  const segs = p.split('/')
  const head = segs[0] === '' ? '' : segs[0]! // '' for an absolute path, '~' for home
  // keep as many trailing parts as fit after `head/…/`
  for (let keep = segs.length - 2; keep >= 1; keep--) {
    const s = `${head}/…/${segs.slice(-keep).join('/')}`
    if (chars(s) <= room) return s
  }
  const last = segs[segs.length - 1] ?? p
  if (room <= 1) return room === 1 ? '…' : ''
  return '…' + Array.from(last).slice(-(room - 1)).join('')
}

const chars = (s: string) => Array.from(s).length
export const homed = (p: string, home: string) => (home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p)

/**
 * How a folders row names `key`: its path from `cwd` when inside it (the folder's name for `cwd`
 * itself); with up to two `../` when near it, unless the `~` or `/` form is shorter; else that form.
 * Without `cwd`, the name.
 */
export function folderLabel(key: string, cwd: string, home: string): string {
  if (!cwd) return basename(key)
  const a = cwd.split('/').filter(Boolean), b = key.split('/').filter(Boolean)
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  const ups = a.length - common
  if (ups === 0) return common === b.length ? basename(key) : b.slice(common).join('/')
  const abs = homed(key, home)
  if (ups > 2 || common === 0) return abs
  const rel = [...Array<string>(ups).fill('..'), ...b.slice(common)].join('/')
  // the shorter form; `~/.config/x` beats `../../.config/x`
  return chars(abs) < chars(rel) ? abs : rel
}

/** `p` in `room` cells: the middle goes first (`~/…/a/b`), then the head (`…/b`); the last part stays whole while it fits. */
export function fitPath(p: string, room: number): string {
  if (chars(p) <= room) return p
  const segs = p.split('/')
  const last = segs[segs.length - 1]!
  const cutEnd = (s: string) => (room <= 0 ? '' : Array.from(s).slice(0, room - 1).join('') + '…')
  if (segs.length < 2 || chars(last) > room) return cutEnd(last)
  // room for the last part, not for `…/` too: the part alone
  if (chars(last) + 2 > room) return last
  const join = (h: number, t: number) => [...segs.slice(0, h), '…', ...segs.slice(segs.length - t)].join('/')
  // the most trailing parts that fit, with no head and with the first part as head
  const tail = (h: number) => {
    let t = 0
    while (h + t + 1 < segs.length && chars(join(h, t + 1)) <= room) t++
    return t
  }
  const bare = tail(0), headed = tail(1)
  if (headed === 0 || bare > headed) return join(0, bare)
  // with the head kept, more of the front joins it while it fits
  let h = 1
  while (h + headed + 1 < segs.length && chars(join(h + 1, headed)) <= room) h++
  return join(h, headed)
}
