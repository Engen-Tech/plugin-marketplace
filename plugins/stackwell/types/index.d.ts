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

/** Uncommitted work of the working copy, read at session start and turn end only. */
export type StackwellGit = {
  files: number
  added: number
  removed: number
  /** Commits not on the remote. */
  ahead: number
  /** Set in a linked worktree: its folder name. */
  worktree?: string
}

/** One subagent the main loop started through the Agent tool. */
export type StackwellAgent = {
  /** The Agent call's tool_use_id. */
  id: string
  /** The subagent's id, which its own turn.complete carries. */
  agentId?: string
  name: string
  model?: string
  isBackground: boolean
  status: 'running' | 'ok' | 'failed'
  /** Epoch milliseconds. */
  startedAt: number
  endedAt?: number
}

/** One peer of this session in its steward initiative. */
export type StackwellPeer = { name: string; role: 'primary' | 'secondary'; status?: string }

/** This session's place in the steward-orchestration registry. */
export type StackwellSteward = {
  role: 'primary' | 'secondary'
  initiative: string
  peers: StackwellPeer[]
  /** Epoch milliseconds the decision log last changed. */
  logMtime?: number
}

/** One main-loop tool call, for the log. */
export type StackwellLogEntry = {
  id: string
  /** Epoch milliseconds the call started. */
  at: number
  tool: string
  target: string
  ms?: number
  status: 'running' | 'ok' | 'failed'
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
  tools: number
  session: number
  agents: number
  git: number
  steward: number
  /** Context segment colours, lightest first: msgs, tools, sys, other. */
  steps: number[]
  /** One step dimmer than the session hue: the cost sparkline. */
  sessionStep: number
}

export type StackwellCompact = { before?: number; after?: number }

export type StackwellRunning = { id: string; tool: string }

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
  /** Main-loop tool calls by tool name. */
  toolCounts: Record<string, number>
  bashFails: number
  running: StackwellRunning[]
  /** Set by a compaction, cleared at the next turn end. */
  compact?: StackwellCompact
  accounts: StackwellAccount[]
  /** Context tokens at each main turn end, oldest first. */
  trend: number[]
  /** Cost added by each main turn, oldest first. */
  turnCosts: number[]
  /** Cost at the last main turn end. */
  costAtTurn?: number
  turns: number
  lastTurnMs?: number
  git?: StackwellGit
  agents: StackwellAgent[]
  /** Newest last. */
  log: StackwellLogEntry[]
  /** The tools group open (counts and log) or collapsed to one row. */
  isToolsOpen: boolean
  /** Set only while this session is a primary or secondary in the registry. */
  steward?: StackwellSteward
  /** Epoch milliseconds, rounded to the minute; drives countdowns, elapsed and stale. */
  now: number
  theme: string
  palette: StackwellPalette
}

declare module 'claude-code' {
  interface PluginState {
    stackwell: { view: Shaped<StackwellView> }
  }
}
