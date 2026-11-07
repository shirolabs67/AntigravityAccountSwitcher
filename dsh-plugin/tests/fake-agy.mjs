#!/usr/bin/env node
// Scripted stand-in for `agy acp` used by the tests. It speaks ACP v1 over
// stdio, connects to the session's HTTP MCP server like the official agent,
// and follows directives embedded in prompt text:
//   CALL <tool> <json>      report the tool call, ask permission, call one MCP tool
//   PCALL <tool> <json> ;; <tool> <json>   call several tools concurrently
//   SLEEP <ms>              wait before ending the turn
//   MAXTOK                  end the first segment with max_tokens
//   DENYCALL <tool> <json>  native tool whose rawInput merely embeds "mcp_dsh_<tool>"
//   SPOOFCALL <tool> <json> title fakes "mcp_dsh_<tool>" but no structured metadata
//   STALECALL <tool> <json> permission claims structured metadata never reported
//   CONFLICTCALL <a> <json> ;; <b>  reported tool a but permission claims b
//   CROSSCALL <session> <tool> <json>  permission request names another session
//   PROBECALL               MCP loading probe (no tool name, empty input)
//   PROBECALL_ALWAYSONLY    same probe, but the options only offer allow_always
//   STATUSUPDCALL <tool> <json>  report identity, then a status-only tool_call_update
//   CONFLICTUPDCALL <a> <json> ;; <b>  tool_call_update contradicts the reported identity
//   REPLAYCALL <tool> <json>  permission for the previous turn's already reported id
//   CALL_ALWAYSONLY <tool> <json>  reported call whose options only offer allow_always
// Setting FAKE_AGY_NO_HANDSHAKE skips the MCP initialize handshake at session/new.
// Every received prompt is appended to $FAKE_AGY_LOG as one JSON line.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = process.env.FAKE_AGY_LOG
const initLog = process.env.FAKE_AGY_INIT
const mcpLog = process.env.FAKE_AGY_MCP
const sessions = new Map()
let nextSession = 1
const rl = createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`)
const MODELS = [
  { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
]
// One entry per effort variant, exactly like a live JetBrains ACP session.
const availableModels = () => [
  ...['gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5'].flatMap(id =>
    ['low', 'medium', 'high'].map(level => ({ modelId: `${id}-${level}`, name: `${id} (${level})` }))),
  { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
]
const configOptions = (s) => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: MODELS },
  { id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: s.level, options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
]
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } })

async function mcp(server, body) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  for (const h of server.headers) headers[h.name.toLowerCase()] = h.value
  const res = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const events = text.split('\n\n').map(e => e.split('\n').find(l => l.startsWith('data: '))).filter(Boolean).map(l => JSON.parse(l.slice(6)))
    return events.find(e => e.id === body.id)
  }
  return text ? JSON.parse(text) : undefined
}

let rpcId = 100
let toolCallSeq = 0

/** Send `session/request_permission` and wait for the harness outcome. */
function askPermission(s, toolCall, sessionIdOverride, optionsMode) {
  return new Promise((resolve) => {
    const id = ++rpcId
    const handler = (line) => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (msg.id === id && msg.method === undefined) {
        rl.off('line', handler)
        resolve(msg.result?.outcome)
      }
    }
    rl.on('line', handler)
    const options = optionsMode === 'always-only'
      ? [{ optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' }]
      : [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ]
    send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: sessionIdOverride ?? s.id, toolCall, options } })
  })
}

/**
 * One agent tool call: report the `tool_call` update, ask for permission, then
 * hit the MCP bridge the way the official agent does. `opts` drives the hostile
 * variants used by the permission gate tests.
 */
async function runToolCall(s, name, args, opts = {}) {
  const toolCallId = opts.reuseId ?? `tc${++toolCallSeq}`
  s.lastToolCallId = toolCallId
  const toolCall = {
    toolCallId,
    title: opts.title ?? `mcp_dsh_${name}`,
    kind: opts.kind ?? 'other',
    rawInput: opts.rawInput ?? args,
  }
  const reportStructured = opts.structured === undefined ? { server: 'dsh', tool: name } : opts.structured
  if (!opts.noReport) {
    update(s.id, {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: toolCall.title,
      kind: toolCall.kind,
      rawInput: toolCall.rawInput,
      ...(reportStructured ? { mcpServerName: reportStructured.server, mcpToolName: reportStructured.tool } : {}),
    })
  }
  // Incremental updates sent after the identity report, before the permission ask.
  if (opts.statusOnlyUpdate) update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'pending' })
  if (opts.conflictUpdateWith !== undefined) {
    update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'pending', mcpServerName: 'dsh', mcpToolName: opts.conflictUpdateWith })
  }
  if (!opts.noPermission) {
    const outcome = await askPermission(s, {
      ...toolCall,
      ...(opts.claim ? { mcpServerName: opts.claim.server, mcpToolName: opts.claim.tool } : {}),
    }, opts.sessionIdOverride, opts.alwaysOnly ? 'always-only' : undefined)
    const selected = outcome?.outcome === 'selected' ? String(outcome.optionId) : 'cancelled'
    if (!selected.startsWith('allow')) {
      update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'refused' })
      return `PERMISSION_${selected.startsWith('reject') ? 'REJECTED' : 'CANCELLED'}`
    }
  }
  const res = await mcp(s.mcp, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args, _meta: { progressToken: `p${rpcId}`, 'antigravity.google/conversation_id': s.id } } })
  let text = res.result.content.map(c => c.text ?? `[${c.type}]`).join('')
  // Follow still-running notices the way the instructed agent does.
  for (let hop = 0; hop < 20; hop++) {
    const match = /dsh_await_result with \{"call_id":"([^"]+)"\}/.exec(text)
    if (match === null) break
    s.relays = (s.relays ?? 0) + 1
    const next = await runToolCall(s, 'dsh_await_result', { call_id: match[1] })
    text = next
  }
  return text
}

async function runPrompt(s, text) {
  update(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `thinking(${s.level})` } })
  if (text.includes('NOTICE')) update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n⚠ API error (attempt 1): request failed: EOF\n' } })
  if (text.includes('OUTLIMIT')) {
    update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n⚠ Your previous response was cut off because it exceeded the output token limit\n' } })
    update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Please continue from where you left off, keeping your response shorter\nRetries remaining: 3\n' } })
  }
  const lines = text.split('\n')
  let output = []
  for (const line of lines) {
    if (line.startsWith('CALL ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')))
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('DENYCALL ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { structured: null, title: name, rawInput: { cmd: `mcp_dsh_${name}` } })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('SPOOFCALL ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { structured: null })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('STALECALL ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { noReport: true, claim: { server: 'dsh', tool: name } })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('CONFLICTCALL ')) {
      const [head, other] = line.slice(13).split(' ;; ')
      const [name, ...rest] = head.trim().split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { claim: { server: 'dsh', tool: other.trim() } })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('CROSSCALL ')) {
      const [, target, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { sessionIdOverride: target })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('PROBECALL_ALWAYSONLY')) {
      const toolCallId = `tc${++toolCallSeq}`
      const outcome = await askPermission(s, { toolCallId, title: 'probe', kind: 'other', rawInput: {} }, undefined, 'always-only')
      const selected = outcome?.outcome === 'selected' ? String(outcome.optionId) : 'cancelled'
      output.push(selected.startsWith('allow') ? `PROBE_OK:${selected}` : `PROBE_DENIED:${selected}`)
    } else if (line.startsWith('PROBECALL')) {
      const toolCallId = `tc${++toolCallSeq}`
      const outcome = await askPermission(s, { toolCallId, title: 'probe', kind: 'other', rawInput: {} })
      const selected = outcome?.outcome === 'selected' ? String(outcome.optionId) : 'cancelled'
      output.push(selected.startsWith('allow') ? `PROBE_OK:${selected}` : `PROBE_DENIED:${selected}`)
    } else if (line.startsWith('STATUSUPDCALL ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { statusOnlyUpdate: true })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('CONFLICTUPDCALL ')) {
      const [head, other] = line.slice(15).split(' ;; ')
      const [name, ...rest] = head.trim().split(' ')
      const conflicting = other.trim()
      const args = JSON.parse(rest.join(' '))
      const result = await runToolCall(s, name, args, { conflictUpdateWith: conflicting })
      // A follow-up ask that claims the conflicting identity must be refused too.
      const outcome = await askPermission(s, { toolCallId: s.lastToolCallId, title: `mcp_dsh_${conflicting}`, kind: 'other', rawInput: args, mcpServerName: 'dsh', mcpToolName: conflicting })
      const selected = outcome?.outcome === 'selected' ? String(outcome.optionId) : 'cancelled'
      const second = selected.startsWith('allow') ? `CONFLICT_CLAIM_${conflicting}_ALLOWED:${selected}` : `CONFLICT_CLAIM_${conflicting}_DENIED`
      output.push(`RESULT(${name})=${result} ${second}`)
    } else if (line.startsWith('REPLAYCALL ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { noReport: true, reuseId: s.lastToolCallId, claim: { server: 'dsh', tool: name } })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('CALL_ALWAYSONLY ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { alwaysOnly: true })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('PCALL ')) {
      const calls = line.slice(6).split(' ;; ').map(part => { const [name, ...rest] = part.trim().split(' '); return [name, JSON.parse(rest.join(' '))] })
      const results = await Promise.all(calls.map(([name, args]) => runToolCall(s, name, args)))
      output.push(...results.map((r, i) => `RESULT(${calls[i][0]})=${r}`))
    } else if (line.startsWith('SLEEP ')) {
      await new Promise(r => setTimeout(r, Number(line.slice(6))))
    }
  }
  if (s.cancelled) return { stopReason: 'cancelled' }
  if (text.includes('MAXTOK') && !s.continued) {
    s.continued = true
    update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part-one ' } })
    return { stopReason: 'max_tokens', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
  }
  const reply = output.length > 0 ? output.join(' | ') : `echo:${s.model}:${s.level}:${text.slice(-40)}`
  update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } })
  return { stopReason: 'end_turn', usage: { inputTokens: 600, outputTokens: 50, cachedReadTokens: 400, cachedWriteTokens: 0, thoughtTokens: 20, totalTokens: 1050 } }
}

rl.on('line', async (line) => {
  const msg = JSON.parse(line)
  const { id, method, params } = msg
  if (method === undefined) return
  try {
    if (method === 'initialize') {
      if (initLog) appendFileSync(initLog, `${JSON.stringify({ clientInfo: params?.clientInfo })}\n`)
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, agentInfo: { name: 'fake-agy', version: '0.0.1' } } })
    }
    if (method === 'session/new') {
      const s = { id: `s${nextSession++}`, model: 'gemini-4-argon', level: 'medium', mcp: params.mcpServers?.[0], system: params._meta?.antigravity?.systemPrompt?.append ?? '', tools: [] }
      sessions.set(s.id, s)
      if (s.mcp && !process.env.FAKE_AGY_NO_HANDSHAKE) {
        await mcp(s.mcp, { jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } } })
        s.tools = (await mcp(s.mcp, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} })).result.tools.map(t => t.name)
      }
      if (mcpLog) {
        appendFileSync(mcpLog, `${JSON.stringify({ session: s.id, url: s.mcp?.url, authorization: s.mcp?.headers?.find(h => h.name.toLowerCase() === 'authorization')?.value })}\n`)
      }
      return send({ jsonrpc: '2.0', id, result: { sessionId: s.id, configOptions: configOptions(s), models: { availableModels: availableModels(), currentModelId: `${s.model}-${s.level}` } } })
    }
    const s = sessions.get(params?.sessionId)
    if (method === 'session/set_config_option') {
      if (params.configId === 'model') s.model = params.value
      if (params.configId === 'thought_level') {
        // Fixed-variant families do not expose a thinking-level selector.
        if (s.model.startsWith('gpt-oss')) {
          return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Thinking level "${params.value}" is not offered for model "${s.model}"` } })
        }
        s.level = params.value
      }
      return send({ jsonrpc: '2.0', id, result: { configOptions: configOptions(s) } })
    }
    if (method === 'session/prompt') {
      const text = params.prompt.filter(b => b.type === 'text').map(b => b.text).join('')
      if (log) appendFileSync(log, `${JSON.stringify({ session: s.id, text, images: params.prompt.filter(b => b.type === 'image').length, tools: s.tools, model: s.model, level: s.level, system: s.system.slice(0, 80) })}\n`)
      s.cancelled = false
      const result = await runPrompt(s, text)
      return send({ jsonrpc: '2.0', id, result })
    }
    if (method === 'session/close') { sessions.delete(params.sessionId); return send({ jsonrpc: '2.0', id, result: {} }) }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown ${method}` } })
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message ?? error) } })
  }
})
rl.on('close', () => process.exit(0))
process.stdin.on('end', () => process.exit(0))
// session/cancel notification
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'session/cancel') { const s = sessions.get(msg.params.sessionId); if (s) s.cancelled = true }
})
