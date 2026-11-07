/**
 * Plugin configuration. Fields marked volatile are live settings: the Web
 * settings surface edits them through the profile patch and the next request
 * reads the new value without restarting the plugin.
 * @module dsh-llm-antigravity-acp/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ProxyConfig } from './proxy.ts'

/** Reasoning effort ids accepted by the Antigravity ACP `thought_level` option. */
export const EFFORTS = ['low', 'medium', 'high'] as const
/** One Antigravity reasoning effort. */
export type Effort = typeof EFFORTS[number]

/** Validated plugin configuration. */
export interface Config {
  /** Provider route id shown in the model picker. */
  provider: string
  /** Display name of the provider group. */
  displayName: string
  /** Absolute path of the `agy` executable; empty resolves `~/.local/bin/agy`, then `agy` on PATH. */
  command: string
  /** Optional remote Account Switcher transport. */
  proxy?: ProxyConfig | null
  /** Isolated Antigravity home for ACP sessions; empty uses `$DSH_HOME/cache/antigravity-acp`. */
  home: string
  /** Declared context window in tokens; 0 selects 1,048,576 for an unlocked binary and 256,000 otherwise. */
  contextWindow: Volatile<number>
  /** Effort applied when a request carries none. */
  defaultEffort: Volatile<Effort>
  /** Check the binary with the local context-unlock script before starting ACP, and apply it when needed. */
  autoPatch: boolean
  /** Context-unlock script; empty uses `~/.gemini/antigravity/tools/agy-patch.py`. */
  patchScript: string
  /** Maximum concurrent ACP sessions kept alive across conversations, subagents, and auxiliary calls. */
  maxLiveSessions: number
  /** Idle time after which an inactive ACP session is closed. */
  idleSessionTtlMs: number
  /** Window that groups parallel tool calls into one DSH step. */
  parkSettleMs: number
  /** SSE keepalive interval for parked tool calls. */
  keepAliveMs: number
  /** Delay in ms before a parked tool call returns a still-running relay notice to refresh cache TTL before agy's 180s MCP deadline. */
  relayAfterMs: number
  /** Automatic continuations after an output-length stop (long decode). */
  longDecodeContinuations: Volatile<number>
  /** Start the ACP process and read the model catalog at plugin load. */
  warmup: boolean
  /** Minimum interval between quota refreshes through `agy -p /usage`. */
  quotaTtlMs: number
}

function maybeVolatile<T>(schema: T): T {
  const candidate = schema as { volatile?: () => T }
  return typeof candidate.volatile === 'function' ? candidate.volatile() : schema
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  provider: z.string().default('antigravity'),
  displayName: z.string().default('Antigravity'),
  command: z.string().default(''),
  proxy: z.union([z.const(null), z.object({
    host: z.string().required(),
    user: z.string().required(),
    port: z.number().step(1).min(1).max(65535).default(22),
    executable: z.string().default('ssh'),
    remotePort: z.number().step(1).min(1).max(65535).required(),
    identityFile: z.string().required(),
    knownHostsFile: z.string().required(),
  })]),
  home: z.string().default(''),
  contextWindow: maybeVolatile(z.number().step(1).min(0).default(0)),
  defaultEffort: maybeVolatile(z.union(EFFORTS).default('high')),
  autoPatch: z.boolean().default(true),
  patchScript: z.string().default(''),
  maxLiveSessions: z.number().step(1).min(1).max(64).default(16),
  idleSessionTtlMs: z.number().step(1).min(10_000).default(30 * 60_000),
  parkSettleMs: z.number().step(1).min(0).max(5_000).default(250),
  keepAliveMs: z.number().step(1).min(1_000).default(15_000),
  relayAfterMs: z.number().step(1).min(5_000).max(165_000).default(85_000),
  longDecodeContinuations: maybeVolatile(z.number().step(1).min(0).max(16).default(3)),
  warmup: z.boolean().default(true),
  quotaTtlMs: z.number().step(1).min(5_000).default(120_000),
  // The published schemastery declarations type `.volatile()` fields as plain values.
}) as unknown as z<Config>

/**
 * Read the current value of one possibly-volatile field.
 * @param value - plain value or volatile reference.
 * @returns the current value.
 */
export function current<T>(value: T | Volatile<T>): T {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}

/**
 * Narrow an arbitrary effort id to an Antigravity effort.
 * @param value - requested effort id.
 * @returns the effort, or undefined when Antigravity does not offer it.
 */
export function asEffort(value: string | undefined): Effort | undefined {
  return (EFFORTS as readonly string[]).includes(value ?? '') ? value as Effort : undefined
}
