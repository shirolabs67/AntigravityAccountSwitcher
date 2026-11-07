/**
 * Per-conversation ACP session state and the turn pump that maps one ACP
 * prompt turn onto DSH model steps.
 *
 * An ACP prompt turn can span many model calls: the agent calls a DSH tool
 * through the MCP bridge, the call parks, and the pump ends the current DSH
 * step with `finish(tool-calls)`. DSH runs the tool through its own pipeline
 * and opens the next step with the result, which resolves the parked call and
 * resumes the same ACP turn. Parked calls that outlive the agent's MCP
 * deadline are relayed through the `dsh_await_result` tool.
 * @module dsh-llm-antigravity-acp/conversation
 */

import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AcpPromptResult, AcpSessionUpdate } from './acp-process.ts'
import type { BridgeTool, BridgeToolResult } from './mcp-bridge.ts'
import { AGENT_TOOL_PREFIX, CALL_TOOL_NAME } from './history.ts'
import type { StepUsageBatch } from './usage-db.ts'
import { AsyncQueue, deferred, type Deferred } from './util.ts'

export { CALL_TOOL_NAME }

/** Agent-side transport retry notice streamed as message text, e.g. `⚠ API error (attempt 1): …`. */
const AGENT_RETRY_NOTICE = /^\s*⚠\s*API error \(attempt \d+\)/
/** First sentence of the notice agy inserts when one generation hits its own output cap. */
const OUTPUT_LIMIT_HEAD = 'your previous response was cut off because it exceeded the output token limit'
/** Second sentence of that same notice. */
const OUTPUT_LIMIT_TAIL = 'please continue from where you left off, keeping your response shorter'

/** Collapse agy's warning mark and line breaks so the notice can be recognized across chunks. */
function noticeText(raw: string): string {
  return raw.replace(/⚠/g, ' ').replace(/\bError:/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Classify text against agy's output-cap continuation notice.
 * `drop` is only that notice, `hold` is still a prefix of it, `emit` is model text.
 */
export function classifyOutputLimitNotice(raw: string): 'drop' | 'hold' | 'emit' {
  const text = noticeText(raw)
  if (text.length === 0) return 'emit'
  const stripped = text.replace(/\s*retries remaining:\s*\d*\s*$/i, '').trim()
  const retry = text.slice(stripped.length).trim()
  if (retry.length > 0 && !/^retries remaining:\s*\d*$/i.test(retry)) return 'emit'
  if (stripped.length === 0) return /^retries remaining:\s*\d+$/i.test(text) ? 'drop' : 'emit'
  const full = `${OUTPUT_LIMIT_HEAD} ${OUTPUT_LIMIT_TAIL}`
  if (stripped === full || stripped === OUTPUT_LIMIT_HEAD || stripped === OUTPUT_LIMIT_TAIL) return 'drop'
  if (full.startsWith(stripped) && stripped.startsWith('your previous')) return 'hold'
  if (OUTPUT_LIMIT_TAIL.startsWith(stripped) && stripped.startsWith('please continue from where you left off')) return 'hold'
  if ('retries remaining:'.startsWith(text) && text.startsWith('retries')) return 'hold'
  return 'emit'
}

/** Tool the agent calls to keep waiting on a relayed DSH tool result. */
export const AWAIT_TOOL_NAME = 'dsh_await_result'

/** MCP descriptor of {@link AWAIT_TOOL_NAME}. */
export const AWAIT_TOOL: BridgeTool = {
  name: AWAIT_TOOL_NAME,
  description: 'Wait for the result of a harness tool call that reported it is still running. Call this only when a tool result tells you to, passing the call_id it gave.',
  inputSchema: {
    type: 'object',
    properties: { call_id: { type: 'string', description: 'The call id from the still-running notice.' } },
    required: ['call_id'],
  },
}

/** MCP descriptor of {@link CALL_TOOL_NAME} (~340B, stays below agy's lazy cutoff). */
export const CALL_TOOL: BridgeTool = {
  name: CALL_TOOL_NAME,
  description: 'Invoke any harness tool by exact name when mcp_dsh_<name> is absent from your direct tool declarations.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact DSH tool name without mcp_dsh_ prefix.' },
      arguments: { type: 'object', description: 'Arguments object matching that tool schema.' },
    },
    required: ['name'],
  },
}

/** One tool call the agent issued and DSH has to run. */
export interface ParkedCall {
  readonly id: ToolCallId
  readonly name: string
  readonly argumentsJson: string
  readonly result: Deferred<BridgeToolResult>
}

/** Event observed during one ACP turn. */
export type TurnEvent =
  | { kind: 'thought'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'park'; call: ParkedCall }
  | { kind: 'done'; result: AcpPromptResult }
  | { kind: 'error'; error: Error }

/** One running ACP prompt turn. */
export class AcpTurn {
  readonly events = new AsyncQueue<TurnEvent>()
  /** Calls handed to DSH whose results have not arrived yet. */
  readonly pendingCalls = new Map<string, ParkedCall>()
  /** Calls the agent issued during this turn. */
  readonly calls = new Map<string, ParkedCall>()
  /** DSH steps this turn has ended with `tool-calls`. */
  toolSteps = 0
  /** Long-decode continuations sent in this turn. */
  continuations = 0
  /** Outstanding ACP prompt, if any, for bounded cancellation cleanup. */
  pendingPrompt: Promise<AcpPromptResult> | undefined
  /** The agent ended the prompt. */
  finished = false
  /** A parked call was answered with a still-running notice and the agent has not resumed waiting yet. */
  relaying = false
  /** The turn produced visible text or a tool call. */
  produced = false
  /** Agent-side transport retry notices dropped from the output. */
  retryNotices = 0
  /** Message text that may still be the start of agy's output-cap notice. */
  private noticeHold = ''
  /** Model calls inside this turn whose usage was already emitted per-step from SQLite. */
  emittedCalls = 0
  /** Cumulative raw token counts already emitted per-step from SQLite during this turn. */
  readonly emittedRaw = {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    thoughtTokens: 0,
  }
  private nextCall = 0

  /** @param turnTag - unique per-turn hex tag used in synthesized call ids (`agy_<turnTag>_<n>`). */
  constructor(private readonly turnTag: string) {}

  /**
   * Record one batch of per-step model usage read from the local session DB.
   * @param batch - per-step usage batch consumed since the previous cursor.
   */
  recordStepBatch(batch: Pick<StepUsageBatch, 'calls' | 'usage'>): void {
    this.emittedCalls += batch.calls
    this.emittedRaw.inputTokens += batch.usage.inputTokens ?? 0
    this.emittedRaw.outputTokens += batch.usage.outputTokens ?? 0
    this.emittedRaw.cachedReadTokens += batch.usage.cachedReadTokens ?? 0
    this.emittedRaw.cachedWriteTokens += batch.usage.cachedWriteTokens ?? 0
    this.emittedRaw.thoughtTokens += batch.usage.thoughtTokens ?? 0
  }

  /**
   * Register one agent tool call.
   * @param name - DSH tool name.
   * @param args - parsed arguments.
   * @returns the parked call.
   */
  park(name: string, args: Record<string, unknown>): ParkedCall {
    const call: ParkedCall = {
      id: ToolCallId(`agy_${this.turnTag}_${++this.nextCall}`),
      name,
      argumentsJson: JSON.stringify(args),
      result: deferred<BridgeToolResult>(),
    }
    this.calls.set(call.id, call)
    this.events.push({ kind: 'park', call })
    return call
  }

  /**
   * Route one ACP session update into the event queue.
   * @param update - the agent notification.
   */
  onUpdate(update: AcpSessionUpdate): void {
    const text = update.content?.type === 'text' ? update.content.text ?? '' : ''
    if (update.sessionUpdate === 'agent_message_chunk' && text.length > 0) {
      this.consumeMessage(text)
      return
    }
    if (update.sessionUpdate === 'agent_thought_chunk') {
      const held = this.recoverNoticeHold()
      if (held.length > 0 && !this.relaying) this.events.push({ kind: 'text', text: held })
      if (text.length > 0 && !this.relaying) this.events.push({ kind: 'thought', text })
    }
  }

  /**
   * Keep a message chunk out of the chat while it is only agy's output-cap notice.
   * @param text - one streamed message chunk.
   */
  private consumeMessage(text: string): void {
    const combined = this.noticeHold + text
    const kind = classifyOutputLimitNotice(combined)
    if (kind === 'hold') {
      this.noticeHold = combined
      return
    }
    this.noticeHold = ''
    if (kind === 'drop' || AGENT_RETRY_NOTICE.test(combined)) {
      this.retryNotices++
      return
    }
    if (!this.relaying) this.events.push({ kind: 'text', text: combined })
  }

  /**
   * Release a held prefix once the message stream moves on.
   * A finished output-cap notice is counted and discarded; anything else is returned for emission.
   * @returns model text to show, or an empty string.
   */
  recoverNoticeHold(): string {
    if (this.noticeHold.length === 0) return ''
    const held = this.noticeHold
    this.noticeHold = ''
    if (classifyOutputLimitNotice(held) === 'drop') {
      this.retryNotices++
      return ''
    }
    return this.relaying ? '' : held
  }

  /**
   * Abandon every parked call with an error result.
   * @param reason - message delivered to the agent.
   */
  abandon(reason: string): void {
    for (const call of this.calls.values()) {
      call.result.resolve({ content: [{ type: 'text', text: reason }], isError: true })
    }
    this.pendingCalls.clear()
  }
}

/** Effects the pump needs from its owner. */
export interface PumpHost {
  /** Window that groups parallel tool calls. */
  parkSettleMs: number
  /** Allowed long-decode continuations. */
  maxContinuations: number
  /** Send one continuation prompt in the same session; resolves with its result. */
  continuePrompt(): Promise<AcpPromptResult>
  /** Request cancellation of the running turn. */
  cancel(): void
  /** Observe the final usage of a prompt turn. */
  recordUsage(usage: AcpPromptResult['usage'], steps: number): void
  /** Read per-step model usage committed to the local session DB since the previous step. */
  consumeStepUsage?(): Promise<{ usage: NonNullable<AcpPromptResult['usage']>; calls: number } | undefined>
}

/**
 * Map one completed prompt or step sample to DSH token usage. When a single
 * sample spanned `calls` internal model steps (tool rounds or continuations),
 * prompt buckets are normalized by `calls` so DSH's native ContextMeter reflects
 * single-request context occupancy rather than the multi-step sum.
 *
 * `agy acp` reports `inputTokens` as uncached input only, disjoint from
 * `cachedReadTokens` and `cachedWriteTokens`, so every bucket is kept as
 * reported and the total is their sum.
 * @param usage - the agent's step or turn usage.
 * @param calls - model calls executed inside this sample (>= 1).
 * @returns DSH usage.
 */
export function toTokenUsage(usage: AcpPromptResult['usage'], calls = 1): TokenUsage | undefined {
  if (usage === undefined) return undefined
  const scale = Math.max(1, calls)
  const input = Math.max(0, Math.round((usage.inputTokens ?? 0) / scale))
  const cacheRead = Math.max(0, Math.round((usage.cachedReadTokens ?? 0) / scale))
  const cacheWrite = Math.max(0, Math.round((usage.cachedWriteTokens ?? 0) / scale))
  const output = Math.max(0, usage.outputTokens ?? 0)
  const reasoning = usage.thoughtTokens !== undefined && usage.thoughtTokens > 0
    ? Math.min(output, usage.thoughtTokens)
    : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    ...usage.cachedReadTokens !== undefined || cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
    ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
    ...reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {},
    totalTokens: input + cacheRead + cacheWrite + output,
  }
}

/**
 * Stream one DSH step out of the running turn.
 * @param turn - the running ACP turn.
 * @param host - owner effects.
 * @param signal - DSH cancellation.
 * @yields DSH stream chunks ending with one finish chunk.
 */
export async function * pumpStep(turn: AcpTurn, host: PumpHost, signal: AbortSignal | undefined): AsyncGenerator<StreamChunk> {
  let index = 0
  let open: { index: number; type: 'text' | 'reasoning'; text: string } | undefined
  const close = function * (): Generator<StreamChunk> {
    if (open === undefined) return
    const block: ContentBlock = open.type === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text }
    yield { type: 'block-end', index: open.index, block }
    open = undefined
  }
  const append = function * (type: 'text' | 'reasoning', text: string): Generator<StreamChunk> {
    if (open?.type !== type) {
      yield * close()
      open = { index: index++, type, text: '' }
      yield { type: 'block-start', index: open.index, blockType: type }
    }
    open.text += text
    yield type === 'text' ? { type: 'text-delta', index: open.index, text } : { type: 'reasoning-delta', index: open.index, text }
  }

  for (;;) {
    const ready = await turn.events.wait(signal)
    if (!ready) {
      host.cancel()
      turn.abandon('The harness cancelled this request.')
      yield * close()
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } }
      return
    }
    if (turn.events.peek()?.kind !== 'text') {
      const held = turn.recoverNoticeHold()
      if (held.length > 0) {
        turn.produced = true
        yield * append('text', held)
      }
    }
    const event = turn.events.shift() as TurnEvent
    switch (event.kind) {
      case 'thought':
        yield * append('reasoning', event.text)
        break
      case 'text':
        turn.produced = true
        yield * append('text', event.text)
        break
      case 'park': {
        turn.produced = true
        yield * close()
        const batch: ParkedCall[] = [event.call]
        // Parallel calls of one model response arrive within a short window.
        while (await turn.events.wait(signal, host.parkSettleMs)) {
          const next = turn.events.peek()
          if (next?.kind !== 'park') break
          turn.events.shift()
          batch.push(next.call)
        }
        for (const call of batch) {
          const blockIndex = index++
          turn.pendingCalls.set(call.id, call)
          yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: blockIndex, id: call.id, name: call.name, argumentsDelta: call.argumentsJson }
          yield { type: 'block-end', index: blockIndex, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.argumentsJson } }
        }
        const stepSample = await host.consumeStepUsage?.()
        if (stepSample !== undefined) {
          const usage = toTokenUsage(stepSample.usage, stepSample.calls)
          if (usage !== undefined) yield { type: 'usage', usage }
        }
        turn.toolSteps++
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      case 'done': {
        const stop = event.result.stopReason
        if (stop === 'max_tokens' && turn.continuations < host.maxContinuations) {
          turn.continuations++
          void host.continuePrompt().then(
            result => turn.events.push({ kind: 'done', result }),
            (error: unknown) => turn.events.push({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) }),
          )
          break
        }
        turn.finished = true
        yield * close()
        const calls = turn.toolSteps + turn.continuations + 1
        host.recordUsage(event.result.usage, calls)
        const finalSample = await host.consumeStepUsage?.()
        let usage: TokenUsage | undefined
        if (finalSample !== undefined) {
          usage = toTokenUsage(finalSample.usage, finalSample.calls)
        } else if (turn.emittedCalls > 0 && event.result.usage !== undefined) {
          const total = event.result.usage
          const remInput = Math.max(0, (total.inputTokens ?? 0) - turn.emittedRaw.inputTokens)
          const remOutput = Math.max(0, (total.outputTokens ?? 0) - turn.emittedRaw.outputTokens)
          const remCacheRead = Math.max(0, (total.cachedReadTokens ?? 0) - turn.emittedRaw.cachedReadTokens)
          const remCacheWrite = Math.max(0, (total.cachedWriteTokens ?? 0) - turn.emittedRaw.cachedWriteTokens)
          const remThought = Math.max(0, (total.thoughtTokens ?? 0) - turn.emittedRaw.thoughtTokens)
          const rem: NonNullable<AcpPromptResult['usage']> = {
            inputTokens: remInput,
            outputTokens: remOutput,
            ...total.cachedReadTokens !== undefined ? { cachedReadTokens: remCacheRead } : {},
            cachedWriteTokens: remCacheWrite,
            thoughtTokens: remThought,
            totalTokens: remInput + remCacheRead + remCacheWrite + remOutput,
          }
          const remCalls = Math.max(1, calls - turn.emittedCalls)
          usage = toTokenUsage(rem, remCalls)
        } else {
          usage = toTokenUsage(event.result.usage, calls)
        }
        if (usage !== undefined) yield { type: 'usage', usage }
        if (stop === 'end_turn' && !turn.produced) {
          throw new LlmError('Antigravity ended the turn without visible output', 'EMPTY_RESPONSE')
        }
        switch (stop) {
          case 'end_turn':
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          case 'max_tokens':
            yield { type: 'finish', reason: { kind: 'max-tokens' } }
            return
          case 'cancelled':
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Antigravity cancelled the turn', code: 'ABORTED' } } }
            return
          case 'refusal':
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Antigravity refused the request', code: 'REFUSAL' } } }
            return
          default:
            yield { type: 'finish', reason: { kind: 'error', failure: { message: `Antigravity stopped: ${stop}`, code: 'PROVIDER_ERROR' } } }
            return
        }
      }
      case 'error':
        turn.finished = true
        yield * close()
        throw event.error
    }
  }
}

/**
 * Notice returned to the agent when a DSH tool outlives the MCP call deadline.
 * @param call - the still-running call.
 * @returns MCP result instructing the agent to keep waiting.
 */
export function relayNotice(call: ParkedCall): BridgeToolResult {
  return {
    content: [{
      type: 'text',
      text: `The harness is still running tool call ${call.id} (${call.name}). Call ${AGENT_TOOL_PREFIX}${AWAIT_TOOL_NAME} with {"call_id":"${call.id}"} now to receive its result. Do not repeat the original call and do not answer the user before the result arrives.`,
    }],
  }
}
