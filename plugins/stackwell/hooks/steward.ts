// Best-effort reading of the steward-orchestration registry: a markdown table whose cells agents write freely.

/** One named party in a cell: the word before `(` and what the parentheses hold. */
export type Party = { name: string; text: string }

export type Initiative = {
  initiative: string
  primary?: Party
  secondaries: Party[]
  /** The decision log cell, backticks removed. */
  log: string
  /** Secondaries `none (...)`: the initiative is closed. */
  isClosed: boolean
}

/** The parties of a cell: each top-level `(…)` and the last word before it. */
export function parties(cell: string): Party[] {
  const out: Party[] = []
  let depth = 0, start = 0, from = 0
  for (let i = 0; i < cell.length; i++) {
    const ch = cell[i]
    if (ch === '(') {
      if (depth === 0) start = i
      depth++
    } else if (ch === ')' && depth > 0) {
      depth--
      if (depth === 0) {
        const before = cell.slice(from, start).trim().split(/\s+/).pop() ?? ''
        const name = before.replace(/^[^\w-]+|[^\w.-]+$/g, '')
        if (name) out.push({ name, text: cell.slice(start + 1, i) })
        from = i + 1
      }
    }
  }
  return out
}

const isDivider = (cells: string[]) => cells.every(c => /^:?-*:?$/.test(c.trim()))

/** The rows of the registry table; header and divider rows left out. */
export function parseRegistry(text: string): Initiative[] {
  const out: Initiative[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    if (cells.length < 4 || isDivider(cells) || /^initiative$/i.test(cells[0]!)) continue
    const [initiative = '', primary = '', secondaries = '', log = ''] = cells
    out.push({
      initiative,
      primary: parties(primary)[0],
      secondaries: /^none\b/i.test(secondaries) ? [] : parties(secondaries).filter(p => p.name.toLowerCase() !== 'none'),
      log: log.replace(/`/g, '').trim(),
      isClosed: /^none\b/i.test(secondaries),
    })
  }
  return out
}

export type Match = { role: 'primary' | 'secondary'; initiative: Initiative; self: Party }

/** This session's row, by its session id inside a party's parentheses; closed rows never match. */
export function matchSession(rows: Initiative[], sessionId: string): Match | undefined {
  const id = sessionId.toLowerCase()
  if (!id) return undefined
  for (const r of rows) {
    if (r.isClosed) continue
    if (r.primary && r.primary.text.toLowerCase().includes(id)) return { role: 'primary', initiative: r, self: r.primary }
    const self = r.secondaries.find(p => p.text.toLowerCase().includes(id))
    if (self) return { role: 'secondary', initiative: r, self }
  }
  return undefined
}
