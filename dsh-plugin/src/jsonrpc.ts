/**
 * Newline-delimited JSON-RPC 2.0 peer over a pair of byte streams. ACP (Agent
 * Client Protocol) v1 frames one JSON message per line on stdio; this peer
 * multiplexes outgoing requests, dispatches incoming requests and
 * notifications, and fails every pending request when the transport closes.
 * @module dsh-llm-antigravity-acp/jsonrpc
 */

import type { Readable, Writable } from 'node:stream'

/** Structured JSON-RPC error object as carried on the wire. */
export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

/** A request the remote peer answered with a JSON-RPC error. */
export class JsonRpcRemoteError extends Error {
  override readonly name = 'JsonRpcRemoteError'
  /**
   * @param method - request method the remote rejected.
   * @param rpc - the remote error object.
   */
  constructor(readonly method: string, readonly rpc: JsonRpcErrorObject) {
    super(`${method}: ${rpc.message}`)
  }
}

/** The transport closed before a pending request settled. */
export class JsonRpcClosedError extends Error {
  override readonly name = 'JsonRpcClosedError'
}

/** Handlers for messages the remote peer initiates. */
export interface JsonRpcHandlers {
  /** Answer one incoming request; a thrown error becomes a JSON-RPC error response. */
  onRequest(method: string, params: unknown): Promise<unknown> | unknown
  /** Observe one incoming notification. */
  onNotification(method: string, params: unknown): void
  /** Observe transport closure with its cause. */
  onClose?(error: Error): void
  /** Observe a frame that could not be parsed or routed; the frame is dropped. */
  onProtocolError?(detail: string): void
}

interface PendingRequest {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
}

/** Options for one outgoing request. */
export interface JsonRpcRequestOptions {
  /** Abort waiting for the response; the request stays sent. */
  signal?: AbortSignal | undefined
  /** Reject after this many milliseconds without a response. */
  timeoutMs?: number | undefined
}

/** Bidirectional newline-delimited JSON-RPC 2.0 endpoint. */
export class JsonRpcPeer {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private buffer = ''
  private closed: Error | undefined

  /**
   * @param input - stream carrying frames from the remote peer.
   * @param output - stream carrying frames to the remote peer.
   * @param handlers - incoming message handlers.
   */
  constructor(input: Readable, private readonly output: Writable, private readonly handlers: JsonRpcHandlers) {
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => this.onData(chunk))
    input.on('end', () => this.close(new JsonRpcClosedError('ACP stream ended')))
    input.on('error', (error: Error) => this.close(error))
    output.on('error', (error: Error) => this.close(error))
  }

  /** Whether the transport has closed. */
  get isClosed(): boolean {
    return this.closed !== undefined
  }

  /**
   * Send one request and await its result.
   * @param method - JSON-RPC method.
   * @param params - request parameters.
   * @param options - cancellation and timeout of the wait.
   * @returns the remote result.
   */
  request<T = unknown>(method: string, params: unknown, options: JsonRpcRequestOptions = {}): Promise<T> {
    if (this.closed !== undefined) return Promise.reject(new JsonRpcClosedError(`${method}: transport closed (${this.closed.message})`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        this.pending.delete(id)
        cleanup()
        reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error(`${method}: aborted`))
      }
      this.pending.set(id, {
        method,
        resolve: (value) => { cleanup(); resolve(value as T) },
        reject: (error) => { cleanup(); reject(error) },
      })
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          cleanup()
          reject(new Error(`${method}: no response within ${options.timeoutMs}ms`))
        }, options.timeoutMs)
      }
      if (options.signal?.aborted === true) { onAbort(); return }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /**
   * Send one notification.
   * @param method - JSON-RPC method.
   * @param params - notification parameters.
   */
  notify(method: string, params: unknown): void {
    if (this.closed === undefined) this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Close the peer and fail every pending request.
   * @param error - closure cause reported to pending requests and the close handler.
   */
  close(error: Error): void {
    if (this.closed !== undefined) return
    this.closed = error
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(new JsonRpcClosedError(`${pending.method}: ${error.message}`))
    }
    this.handlers.onClose?.(error)
  }

  private write(message: unknown): void {
    try {
      this.output.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      message = parsed as Record<string, unknown>
    } catch (_malformedFrame) {
      // A malformed frame is dropped; the link and in-flight requests stay usable.
      this.handlers.onProtocolError?.(`unparsable frame: ${line.slice(0, 200)}`)
      return
    }
    const method = typeof message.method === 'string' ? message.method : undefined
    const id = message.id
    if (method === undefined) {
      if (typeof id !== 'number') {
        this.handlers.onProtocolError?.(`response without numeric id: ${line.slice(0, 200)}`)
        return
      }
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      if (message.error !== undefined) {
        const rpc = message.error as JsonRpcErrorObject
        pending.reject(new JsonRpcRemoteError(pending.method, {
          code: typeof rpc.code === 'number' ? rpc.code : -32603,
          message: typeof rpc.message === 'string' ? rpc.message : 'unknown error',
          ...rpc.data === undefined ? {} : { data: rpc.data },
        }))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (id === undefined || id === null) {
      try {
        this.handlers.onNotification(method, message.params)
      } catch (error) {
        this.handlers.onProtocolError?.(`notification handler for ${method} failed: ${String(error)}`)
      }
      return
    }
    void Promise.resolve()
      .then(() => this.handlers.onRequest(method, message.params))
      .then(
        (result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }),
        (error: unknown) => {
          const rpc = error instanceof JsonRpcRemoteError
            ? error.rpc
            : { code: -32603, message: error instanceof Error ? error.message : String(error) }
          this.write({ jsonrpc: '2.0', id, error: rpc })
        },
      )
  }
}
