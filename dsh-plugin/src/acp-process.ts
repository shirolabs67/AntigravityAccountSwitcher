/**
 * One long-lived `agy acp` front process. With `--process-per-session` the
 * front serves every ACP session from an isolated worker, so the main
 * conversation, each subagent, and auxiliary calls run concurrently on one
 * stdio link. This module owns the link, routes per-session notifications,
 * and refuses every agent-to-client capability DSH does not provide.
 * @module dsh-llm-antigravity-acp/acp-process
 */

import type { Readable, Writable } from 'node:stream'
import { JsonRpcPeer, JsonRpcRemoteError } from './jsonrpc.ts'

/** Minimal handle of a spawned ACP process. */
export interface AcpChild {
  stdin: Writable
  stdout: Readable
  /** Resolves when the process exits. */
  exited: Promise<{ code: number | null; signal: string | null }>
  /** Request termination. */
  terminate(): void
  /** Recent stderr text for diagnostics. */
  stderrTail(): string
}

/** Launches one ACP process. */
export type AcpSpawner = (argv: readonly string[], cwd: string) => AcpChild

/** Per-session observer of agent notifications and requests. */
export interface AcpSessionListener {
  onUpdate(update: AcpSessionUpdate): void
  onPermission?(request: AcpPermissionRequest): AcpPermissionOutcome | undefined
}

/** One `session/update` payload. */
export interface AcpSessionUpdate {
  sessionUpdate: string
  content?: { type: string; text?: string }
  toolCallId?: string
  title?: string
  status?: string
  kind?: string
  mcpServerName?: string
  mcpToolName?: string
  _meta?: AcpToolCallMeta
  configOptions?: AcpConfigOption[]
  used?: number
  size?: number
  [key: string]: unknown
}

/** Structured MCP metadata the agent reports for one tool call. */
export interface AcpToolCallMeta {
  mcpServerName?: string
  serverName?: string
  server?: string
  mcpToolName?: string
  toolName?: string
  tool?: string
  [key: string]: unknown
}

/** One select-type session configuration option. */
export interface AcpConfigOption {
  id: string
  name?: string
  category?: string
  type?: string
  currentValue?: string
  options?: { value: string; name?: string; description?: string }[]
}

/** `session/request_permission` parameters. */
export interface AcpPermissionRequest {
  sessionId: string
  toolCall?: {
    toolCallId?: string
    title?: string
    kind?: string
    rawInput?: unknown
    mcpServerName?: string
    mcpToolName?: string
    _meta?: AcpToolCallMeta
  }
  options: { optionId: string; name?: string; kind: string }[]
}

/** `session/request_permission` outcome. */
export type AcpPermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }

/** `session/new` result. */
export interface AcpNewSessionResult {
  sessionId: string
  configOptions?: AcpConfigOption[]
  /** Full model inventory, including one entry per effort variant. */
  models?: {
    availableModels?: { modelId: string; name?: string }[]
    currentModelId?: string
  }
  _meta?: Record<string, unknown>
}

/** `session/prompt` result. */
export interface AcpPromptResult {
  stopReason: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cachedReadTokens?: number
    cachedWriteTokens?: number
    thoughtTokens?: number
    totalTokens?: number
  }
}

/** One HTTP MCP server descriptor passed on session setup. */
export interface AcpHttpMcpServer {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

/** Launch parameters of the front process. */
export interface AcpProcessOptions {
  argv: readonly string[]
  cwd: string
  spawn: AcpSpawner
  clientName: string
  clientVersion: string
  log?: (message: string) => void
}

/** One running `agy acp` front with its initialized link. */
export class AcpProcess {
  private readonly listeners = new Map<string, AcpSessionListener>()
  private child: AcpChild | undefined
  private peer: JsonRpcPeer | undefined
  private exitError: Error | undefined
  /** Agent `initialize` result. */
  initializeResult: Record<string, unknown> | undefined
  private readonly exitListeners = new Set<(error: Error) => void>()

  /** @param options - launch parameters. */
  constructor(private readonly options: AcpProcessOptions) {}

  /** Whether the process is running with an initialized link. */
  get alive(): boolean {
    return this.peer !== undefined && !this.peer.isClosed && this.exitError === undefined
  }

  /**
   * Observe process exit or link closure.
   * @param listener - receives the cause.
   * @returns a disposer.
   */
  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /**
   * Spawn the process and complete the ACP `initialize` handshake.
   * @param timeoutMs - handshake deadline.
   */
  async start(timeoutMs: number): Promise<void> {
    const child = this.options.spawn(this.options.argv, this.options.cwd)
    this.child = child
    const peer = new JsonRpcPeer(child.stdout, child.stdin, {
      onRequest: (method, params) => this.onRequest(method, params),
      onNotification: (method, params) => this.onNotification(method, params),
      onClose: (error) => this.fail(error),
      onProtocolError: (detail) => this.options.log?.(`acp: dropped frame: ${detail}`),
    })
    this.peer = peer
    void child.exited.then(({ code, signal }) => {
      const tail = child.stderrTail().trim().split('\n').slice(-5).join(' | ')
      const error = new Error(`agy acp exited (code=${code ?? 'null'} signal=${signal ?? 'null'})${tail ? `: ${tail}` : ''}`)
      peer.close(error)
      this.fail(error)
    })
    this.initializeResult = await peer.request<Record<string, unknown>>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
    }, { timeoutMs })
  }

  /** Terminate the process. */
  stop(): void {
    this.fail(new Error('ACP process stopped'))
    this.child?.terminate()
  }

  /**
   * Create one ACP session.
   * @param params - `session/new` parameters.
   * @param listener - observer bound to the new session id.
   * @param timeoutMs - setup deadline.
   * @returns the session result.
   */
  async newSession(params: Record<string, unknown>, listener: AcpSessionListener, timeoutMs: number): Promise<AcpNewSessionResult> {
    const result = await this.link().request<AcpNewSessionResult>('session/new', params, { timeoutMs })
    this.listeners.set(result.sessionId, listener)
    return result
  }

  /**
   * Select one configuration option value.
   * @param sessionId - ACP session.
   * @param configId - option id (`model`, `thought_level`).
   * @param value - option value.
   * @returns the complete resulting option list.
   */
  async setConfigOption(sessionId: string, configId: string, value: string, meta?: Record<string, unknown>): Promise<AcpConfigOption[]> {
    const result = await this.link().request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option', { sessionId, configId, value, ...(meta === undefined ? {} : { _meta: meta }) }, { timeoutMs: 60_000 })
    return result?.configOptions ?? []
  }

  /**
   * Send one prompt; resolves when the agent ends the turn.
   * @param sessionId - ACP session.
   * @param prompt - prompt content blocks.
   * @returns the prompt result.
   */
  prompt(sessionId: string, prompt: readonly unknown[], meta?: Record<string, unknown>): Promise<AcpPromptResult> {
    return this.link().request<AcpPromptResult>('session/prompt', { sessionId, prompt, ...(meta === undefined ? {} : { _meta: meta }) })
  }

  /**
   * Request cancellation of the running turn.
   * @param sessionId - ACP session.
   */
  cancel(sessionId: string, meta?: Record<string, unknown>): void {
    this.peer?.notify('session/cancel', { sessionId, ...(meta === undefined ? {} : { _meta: meta }) })
  }

  /**
   * Close one session and detach its listener.
   * @param sessionId - ACP session.
   */
  async closeSession(sessionId: string): Promise<void> {
    this.listeners.delete(sessionId)
    if (!this.alive) return
    try {
      await this.link().request('session/close', { sessionId }, { timeoutMs: 15_000 })
    } catch (_closeFailure) {
      // A session that cannot close cleanly is released with its worker on process exit.
    }
  }

  /**
   * Arbitrary request on the link (diagnostics and discovery).
   * @param method - JSON-RPC method.
   * @param params - parameters.
   * @param timeoutMs - deadline.
   * @returns the result.
   */
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    return this.link().request<T>(method, params, { timeoutMs })
  }

  private link(): JsonRpcPeer {
    if (this.peer === undefined || this.peer.isClosed || this.exitError !== undefined) {
      throw new Error(`ACP link unavailable${this.exitError ? `: ${this.exitError.message}` : ''}`)
    }
    return this.peer
  }

  private fail(error: Error): void {
    if (this.exitError !== undefined) return
    this.exitError = error
    for (const listener of this.exitListeners) listener(error)
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return
    const record = params as { sessionId?: string; update?: AcpSessionUpdate }
    if (record.sessionId === undefined || record.update === undefined) return
    this.listeners.get(record.sessionId)?.onUpdate(record.update)
  }

  private onRequest(method: string, params: unknown): unknown {
    if (method === 'session/request_permission') {
      const request = params as AcpPermissionRequest
      const outcome = this.listeners.get(request.sessionId)?.onPermission?.(request)
      return { outcome: outcome ?? { outcome: 'cancelled' } }
    }
    // File-system, terminal, and elicitation capabilities are not advertised.
    this.options.log?.(`acp: refused agent request ${method}`)
    throw new JsonRpcRemoteError(method, { code: -32601, message: `${method} is not supported by DeepSeek Harness` })
  }
}
