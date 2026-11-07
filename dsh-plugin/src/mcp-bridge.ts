/**
 * Loopback Streamable HTTP MCP server that exposes DSH tool schemas to the
 * official Antigravity agent and parks each `tools/call` until DSH has run the
 * tool through its own permission and execution pipeline.
 *
 * Calls answer with a server-sent-event stream so response headers leave
 * immediately; the agent's HTTP client otherwise abandons a request after 60
 * seconds without headers. Comment frames and MCP progress notifications keep
 * long DSH tool runs (approvals, subagents, builds) visibly alive.
 * @module dsh-llm-antigravity-acp/mcp-bridge
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One tool schema advertised over MCP. */
export interface BridgeTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** One MCP content item returned to the agent. */
export type BridgeContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** Result of one parked tool call. */
export interface BridgeToolResult {
  content: BridgeContent[]
  isError?: boolean
}

/** One `tools/call` request delivered to the owner. */
export interface BridgeCallRequest {
  /** Tenant key taken from the request path, when the session registered one. */
  tenantKey: string | undefined
  /** ACP session id the agent reported in `_meta`, when present. */
  conversationId: string | undefined
  /** MCP tool name without any agent-side prefix. */
  name: string
  /** Parsed tool arguments. */
  arguments: Record<string, unknown>
  /** Aborts when the agent disconnects or cancels the call. */
  signal: AbortSignal
}

/** Owner-side routing of tool listings and calls. */
export interface BridgeRouter {
  /**
   * List the tools one tenant may call.
   * @param tenantKey - tenant from the request path, or undefined for the shared endpoint.
   * @returns MCP tool descriptors.
   */
  listTools(tenantKey: string | undefined): BridgeTool[]
  /**
   * Run one tool call; the promise may stay pending for the full DSH execution.
   * @param request - the parsed call.
   * @returns the MCP tool result.
   */
  callTool(request: BridgeCallRequest): Promise<BridgeToolResult>
  /**
   * Verify the tenant-scoped bearer credential of one request.
   * @param tenantKey - tenant from the request path.
   * @param bearerToken - raw token after `Authorization: Bearer`.
   * @returns true only when the token is the tenant's current secret.
   */
  authorize(tenantKey: string | undefined, bearerToken: string | undefined): boolean
}

/** Bridge tuning. */
export interface McpBridgeOptions {
  /** Interval for SSE keepalive comments while a call is parked. */
  keepAliveMs: number
  /** Diagnostic sink. */
  log?: (message: string) => void
}

const MCP_PROTOCOL_VERSION = '2025-06-18'
const CONVERSATION_META_KEY = 'antigravity.google/conversation_id'

/** Loopback MCP endpoint shared by every ACP session of one adapter. */
export class McpBridge {
  private server: Server | undefined
  private port = 0
  private readonly openResponses = new Set<ServerResponse>()
  /** Tenant keys whose agent completed the MCP `initialize` handshake. */
  private readonly handshakes = new Set<string>()

  /**
   * @param router - owner routing for listings and calls.
   * @param options - keepalive and logging.
   */
  constructor(private readonly router: BridgeRouter, private readonly options: McpBridgeOptions) {}

  /** Whether the HTTP listener is bound. */
  get listening(): boolean {
    return this.server !== undefined
  }

  /** Local port opened by start(), for SSH reverse forwarding. */
  get localPort(): number { return this.port }

  /**
   * Base URL of the endpoint; append `/<tenant>` for a tenant-scoped endpoint.
   * @returns the loopback MCP URL.
   */
  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  /** Bind the loopback listener on an ephemeral port. */
  async start(): Promise<void> {
    if (this.server !== undefined) return
    const server = createServer((req, res) => { void this.handle(req, res) })
    server.keepAliveTimeout = 0
    server.requestTimeout = 0
    server.headersTimeout = 0
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    this.port = (server.address() as AddressInfo).port
    this.server = server
  }

  /** Close every open call stream and the listener. */
  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    for (const res of this.openResponses) res.destroy()
    this.openResponses.clear()
    this.handshakes.clear()
    if (server !== undefined) await new Promise<void>(resolve => server.close(() => resolve()))
  }

  /**
   * Whether the agent of one tenant completed the MCP `initialize` handshake,
   * proving it holds this session's bearer credential. This is the explicit
   * evidence a tool-less MCP loading probe must be bound to.
   */
  hasHandshake(tenantKey: string | undefined): boolean {
    return tenantKey !== undefined && this.handshakes.has(tenantKey)
  }

  /** Forget the handshake evidence of one tenant (tenant keys are per session open). */
  forgetTenant(tenantKey: string | undefined): void {
    if (tenantKey !== undefined) this.handshakes.delete(tenantKey)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0] !== 'mcp' || segments.length > 2) {
      res.writeHead(404).end()
      return
    }
    // The root path is tenant-less and never exposes tools/list or tools/call.
    const tenantKey = segments.length === 2 && segments[1] !== '' ? segments[1] : undefined
    if (tenantKey === undefined) {
      res.writeHead(401).end()
      return
    }
    const authorization = req.headers.authorization
    const bearerToken = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
    if (!this.router.authorize(tenantKey, bearerToken)) {
      res.writeHead(401).end()
      return
    }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST, DELETE' }).end(); return }
    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch (_invalidJson) {
      // An unparsable body cannot be answered with a request id.
      writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    const messages = Array.isArray(body) ? body : [body]
    const requests = messages.filter((m): m is RpcRequest => isRecord(m) && typeof m.method === 'string' && m.id !== undefined && m.id !== null)
    if (requests.length === 0) {
      // Notifications and client responses only.
      res.writeHead(202).end()
      return
    }
    const call = requests.find(r => r.method === 'tools/call')
    if (call !== undefined && requests.length === 1) {
      await this.handleCall(res, call, tenantKey)
      return
    }
    const replies = await Promise.all(requests.map(r => this.answer(r, tenantKey)))
    writeJson(res, 200, Array.isArray(body) ? replies : replies[0])
  }

  private async answer(request: RpcRequest, tenantKey: string | undefined): Promise<unknown> {
    const reply = (result: unknown): unknown => ({ jsonrpc: '2.0', id: request.id, result })
    switch (request.method) {
      case 'initialize': {
        const params = isRecord(request.params) ? request.params : {}
        const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION
        // The authorized handshake is the only accepted loading-probe evidence.
        if (tenantKey !== undefined) this.handshakes.add(tenantKey)
        return reply({
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dsh', version: '0.1.0' },
          instructions: 'Tools of the DeepSeek Harness session. Every call is executed by the harness under its own permission policy.',
        })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: this.router.listTools(tenantKey) })
      case 'resources/list':
        return reply({ resources: [] })
      case 'resources/templates/list':
        return reply({ resourceTemplates: [] })
      case 'prompts/list':
        return reply({ prompts: [] })
      case 'tools/call':
        return { jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'tools/call must be sent alone' } }
      default:
        return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } }
    }
  }

  private async handleCall(res: ServerResponse, request: RpcRequest, tenantKey: string | undefined): Promise<void> {
    const params = isRecord(request.params) ? request.params : {}
    const meta = isRecord(params._meta) ? params._meta : {}
    const name = typeof params.name === 'string' ? params.name : ''
    const args = isRecord(params.arguments) ? params.arguments : {}
    const progressToken = meta.progressToken
    const conversationId = typeof meta[CONVERSATION_META_KEY] === 'string' ? meta[CONVERSATION_META_KEY] as string : undefined

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    res.flushHeaders()
    this.openResponses.add(res)
    const controller = new AbortController()
    let settled = false
    const onClose = (): void => {
      this.openResponses.delete(res)
      if (!settled) controller.abort(new Error('MCP client closed the tool call'))
    }
    res.on('close', onClose)
    let ticks = 0
    const keepAlive = setInterval(() => {
      if (res.writableEnded) return
      ticks++
      res.write(': keepalive\n\n')
      if ((typeof progressToken === 'string' || typeof progressToken === 'number')) {
        writeEvent(res, { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: ticks, message: 'DeepSeek Harness is running the tool' } })
      }
    }, this.options.keepAliveMs)

    let result: BridgeToolResult
    try {
      result = await this.router.callTool({ tenantKey, conversationId, name, arguments: args, signal: controller.signal })
    } catch (error) {
      result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    } finally {
      settled = true
      clearInterval(keepAlive)
    }
    if (!res.writableEnded && !res.destroyed) {
      writeEvent(res, { jsonrpc: '2.0', id: request.id, result })
      res.end()
    }
    this.openResponses.delete(res)
    res.off('close', onClose)
    if (controller.signal.aborted) this.options.log?.(`mcp: call ${name} finished after the agent disconnected`)
  }
}

interface RpcRequest {
  jsonrpc?: string
  id: string | number
  method: string
  params?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function writeEvent(res: ServerResponse, value: unknown): void {
  res.write(`event: message\ndata: ${JSON.stringify(value)}\n\n`)
}
