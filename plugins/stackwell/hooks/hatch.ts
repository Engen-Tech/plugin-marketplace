// Pure reading of a hatch binder's state from its JSON and the repo's hatch refs.

import type { StackwellBinder } from '../types'

export type BinderFile = { slug?: unknown; work_items?: unknown }
type Item = { id: string; deps: string[] }

/** The binder's slug and items; undefined when the JSON is not a binder. */
export function parseBinder(text: string): { slug: string; items: Item[] } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  // null, an array, a number: no binder
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const data = parsed as BinderFile
  if (typeof data.slug !== 'string' || !Array.isArray(data.work_items)) return undefined
  const items: Item[] = []
  for (const w of data.work_items as { id?: unknown; depends_on?: unknown }[]) {
    if (typeof w?.id !== 'string') continue
    const deps = Array.isArray(w.depends_on) ? w.depends_on.filter((d): d is string => typeof d === 'string') : []
    items.push({ id: w.id, deps })
  }
  return { slug: data.slug, items }
}

/** Dependency depth, 1 for an item with none: its wave. */
function depths(items: Item[]): Map<string, number> {
  const byId = new Map(items.map(i => [i.id, i]))
  const memo = new Map<string, number>()
  const depth = (id: string, seen: Set<string>): number => {
    const m = memo.get(id)
    if (m !== undefined) return m
    if (seen.has(id)) return 1 // a cycle: stop
    seen.add(id)
    const deps = byId.get(id)?.deps.filter(d => byId.has(d)) ?? []
    const d = 1 + Math.max(0, ...deps.map(x => depth(x, seen)))
    memo.set(id, d)
    return d
  }
  for (const i of items) depth(i.id, new Set())
  return memo
}

/**
 * The binder's state from `git for-each-ref` names: running while `refs/heads/hatch/<slug>/integration`
 * exists; per item, first match wins: accepted or done (merged), failed (halted), built, an item
 * branch (building), else ready or blocked. Waves are dependency depth; `hatch/<slug>/wave-<N>` tags
 * mark finished waves.
 */
export function binderState(binder: { slug: string; items: Item[] }, refs: readonly string[]): StackwellBinder {
  const { slug, items } = binder
  const set = new Set(refs.map(r => r.trim()).filter(Boolean))
  const has = (r: string) => set.has(r)
  const itemRef = (id: string, kind: string) => has(`refs/hatch/${slug}/item-${id}/${kind}`)
  const state = new Map<string, 'merged' | 'halted' | 'built' | 'building' | 'other'>()
  for (const i of items) {
    const st =
      itemRef(i.id, 'accepted') || itemRef(i.id, 'done') ? 'merged'
      : itemRef(i.id, 'failed') ? 'halted'
      : itemRef(i.id, 'built') ? 'built'
      : has(`refs/heads/hatch/${slug}/item-${i.id}`) ? 'building'
      : 'other'
    state.set(i.id, st)
  }
  const depth = depths(items)
  const waves = Math.max(1, ...[...depth.values()])
  const tagged = refs
    .map(r => new RegExp(`^refs/tags/hatch/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/wave-(\\d+)$`).exec(r.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map(m => Number(m[1]))
  const open = items.filter(i => state.get(i.id) !== 'merged').map(i => depth.get(i.id) ?? 1)
  const wave = tagged.length ? Math.min(waves, Math.max(...tagged) + 1) : open.length ? Math.min(...open) : waves
  return {
    slug,
    total: items.length,
    isRunning: has(`refs/heads/hatch/${slug}/integration`),
    merged: items.filter(i => state.get(i.id) === 'merged').length,
    wave,
    waves,
    building: items.filter(i => state.get(i.id) === 'building').map(i => i.id),
    halted: items.filter(i => state.get(i.id) === 'halted').map(i => i.id),
  }
}

/** `hatch/<slug>/item-<id>`: the branch of a hatch item worktree. */
export const isHatchItemBranch = (branch: string | undefined): boolean => !!branch && /^hatch\/[^/]+\/item-/.test(branch)
