// The $.state contract of stackwell: one view model the pane draws from.

/** One rate-limit window the session reported. */
export type StackwellQuota = {
  kind: string
  pct: number
  /** Epoch milliseconds. */
  resetsAt?: number
}

/** One line of ~/.claude/quota/*.json. */
export type StackwellAccount = {
  name: string
  h5?: number
  d7?: number
  /** Epoch milliseconds the window resets. */
  h5At?: number
  d7At?: number
  /** Epoch seconds (updated_at_epoch). */
  updatedAt?: number
}

/** One folder the session touched: a repo's root, or a plain folder. */
export type StackwellFolder = {
  /** The repo root, or the folder itself outside a repo. */
  key: string
  name: string
  isRepo: boolean
  /** A linked worktree: its root is not the main checkout. */
  isWorktree: boolean
  isCwd: boolean
  branch?: string
  added?: number
  removed?: number
  untracked?: number
  /** Epoch milliseconds a turn end last found it among the tool uses. */
  lastAt: number
  /** The main checkout's root, for a worktree. */
  mainRoot?: string
  /** A short dim tag at the far right (`hatch` for a hatch item worktree). */
  tag?: string
  /** A repo outside the session cwd's repo and its worktrees: read from its files, no git, no change counts. */
  isOutside?: boolean
}

/** One hatch binder of a repo in the folders list. */
export type StackwellBinder = {
  slug: string
  total: number
  /** False while no integration branch exists: declared, not started. */
  isRunning: boolean
  merged: number
  wave: number
  waves: number
  building: string[]
  halted: string[]
}

/** One agent loop of this session, as `$.agent.list()` reported it. */
export type StackwellAgent = {
  /** `agent:<agentId>`: the row's key. */
  id: string
  /** The engine's id of the agent, which its own turn.complete carries. */
  agentId?: string
  /** The agent's description as the list gives it; the kind when it has none. */
  name: string
  /** The kind of agent, from its subagent type (`reviewer`, `Explore`); absent on views stored before it. */
  kind?: string
  /** The plugin part of the subagent type (`steward-delegation`), when it names one. */
  plugin?: string
  /** The model: the engine's id (`claude-opus-5-5`) when known, else the profile name's alias (`opus`). */
  model?: string
  /** The reasoning effort (`low` … `max`, or a budget as digits): the engine's, else the profile name's. */
  effort?: string
  /** True once the main conversation shows the Agent call that started it ran in the background. */
  isBackground: boolean
  status: 'running' | 'ok' | 'failed'
  /** Epoch milliseconds. */
  startedAt: number
  endedAt?: number
}

/** One peer of this session in its steward initiative. */
export type StackwellPeer = {
  name: string
  role: 'primary' | 'secondary'
  /** From the registry cell, when it names one. */
  sessionId?: string
  /** busy, idle, shell, …; offline when no session file matches. */
  status?: string
  /** Epoch milliseconds the status last changed. */
  since?: number
}

/** This session's place in the steward-orchestration registry. */
export type StackwellSteward = {
  role: 'primary' | 'secondary'
  initiative: string
  peers: StackwellPeer[]
  /** Epoch milliseconds the decision log last changed. */
  logMtime?: number
}

/** The context breakdown in four groups, read at session start and turn end only. */
export type StackwellBreakdown = {
  msgs: number
  /** Built-in and MCP tool definitions. */
  tools: number
  sys: number
  /** Memory, skills, agents and the rest. */
  other: number
  autoCompact?: number
  raw: number
}

/** Resolved colours, 0xRRGGBB. */
export type StackwellPalette = {
  bg: number
  text: number
  /** Labels, track and secondary figures: at least 3:1 against bg. */
  dim: number
  warn: number
  crit: number
  /** Muted group hues (OKLCH), at least 4.5:1 against bg. */
  context: number
  quota: number
  session: number
  agents: number
  git: number
  hatch: number
  steward: number
  /** Context segment colours, lightest first: msgs, tools, sys, other. */
  steps: number[]
  /** One step dimmer than the session hue: the cost sparkline. */
  sessionStep: number
}

export type StackwellView = {
  model?: string
  branch?: string
  profile: string
  tokens?: number
  window?: number
  percent?: number
  quotas: StackwellQuota[]
  costUsd?: number
  /** Epoch milliseconds the session started. */
  startedAt?: number
  breakdown?: StackwellBreakdown
  accounts: StackwellAccount[]
  /** Context tokens at each main turn end, oldest first. */
  trend: number[]
  turns: number
  lastTurnMs?: number
  /** Folders the session's tool uses named, most recent first after the session's own. */
  folders: StackwellFolder[]
  /** The session folder and the home folder, cleaned for the cells: for display only. */
  cwd?: string
  home?: string
  /** Hatch binders of the folders' repos, while any exist. */
  binders: StackwellBinder[]
  agents: StackwellAgent[]
  /** Every folder shown, not the first 4 and `+N more`; absent on views stored before it. */
  isFoldersOpen?: boolean
  /** Set only while this session is a primary or secondary in the registry. */
  steward?: StackwellSteward
  /** Epoch milliseconds, rounded to the minute; drives countdowns, elapsed and stale. */
  now: number
  theme: string
  palette: StackwellPalette
}

declare module 'claude-code' {
  interface PluginState {
    /** `pin`: the pane row (`at`, -1 for none) of the card a click pinned open, until epoch ms `until`. */
    stackwell: { view: Shaped<StackwellView>; pin: { at: number; until: number } }
  }
}
