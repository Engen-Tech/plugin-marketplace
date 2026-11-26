// The kind of agent an Agent call started, from its subagent type.

/** A steward profile's model and effort, as its name ends: `-opus-max`, `-sonnet-low`. */
const PROFILE = /-(opus|sonnet|haiku|fable)-(low|medium|high|xhigh|max)$/

/**
 * `steward-delegation:reviewer-opus-max` -> `reviewer` of `steward-delegation`;
 * `hatch:hatch-safety-auditor` -> `safety-auditor` of `hatch`; `Explore` -> `Explore`.
 */
export function agentKind(type: string | undefined | null): { kind: string; plugin?: string } | undefined {
  const t = (type ?? '').trim()
  if (!t) return undefined
  const i = t.lastIndexOf(':')
  const plugin = i >= 0 ? t.slice(0, i) : undefined
  let kind = (i >= 0 ? t.slice(i + 1) : t).replace(PROFILE, '')
  // the plugin's name said again at the front of the kind
  const name = plugin?.split(':').pop()
  if (name && kind.startsWith(name + '-') && kind.length > name.length + 1) kind = kind.slice(name.length + 1)
  if (!kind) return undefined
  return plugin ? { kind, plugin } : { kind }
}

/** steward-delegation, steward-orchestration and the other steward plugins. */
export const isStewardPlugin = (plugin: string | undefined): boolean => !!plugin && plugin.startsWith('steward')

/** A model and a reasoning effort, either unknown. */
export type ModelEffort = { model?: string; effort?: string }

const LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** An effort level as given, or a positive budget as digits; anything else undefined. */
export function effortText(e: unknown): string | undefined {
  if (typeof e === 'string') return LEVELS.has(e) ? e : undefined
  if (typeof e === 'number' && Number.isFinite(e) && e > 0) return String(Math.round(e))
  return undefined
}

/**
 * What a steward profile's name says it runs on: `steward-delegation:coder-opus-medium` ->
 * opus, medium. Only a fallback: `reviewer-opus-max` really runs Opus at xhigh.
 */
export function profileOf(type: string | undefined | null): Required<ModelEffort> | undefined {
  const t = (type ?? '').trim()
  const m = PROFILE.exec(t.slice(t.lastIndexOf(':') + 1))
  return m ? { model: m[1]!, effort: m[2]! } : undefined
}

/** Model and effort each from the first layer that has it, in precedence order (engine, call, profile name). */
export function pickModelEffort(...layers: (ModelEffort | undefined)[]): ModelEffort {
  const out: ModelEffort = {}
  for (const l of layers) {
    if (!out.model && typeof l?.model === 'string' && l.model) out.model = l.model
    if (!out.effort && typeof l?.effort === 'string' && l.effort) out.effort = l.effort
  }
  return out
}

/**
 * The effort a profile name gives, for the model the agent runs on: Claude Opus never runs at
 * max (a `max` profile runs it at xhigh), so `max` on Opus is `xhigh`; undefined without a suffix.
 */
export function suffixEffort(type: string | undefined | null, model: string | undefined): string | undefined {
  const e = profileOf(type)?.effort
  return e === 'max' && /opus/i.test(model ?? '') ? 'xhigh' : e
}
