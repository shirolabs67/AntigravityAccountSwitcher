/**
 * Projection of DSH request history into Antigravity ACP prompts.
 *
 * ACP sessions own their history, so DSH replays its authoritative history
 * once when a session is (re)built and afterwards sends only new input. The
 * replay renders earlier turns as a delimited transcript in front of the
 * newest user input; tool calls keep the agent-visible `mcp_dsh_` names.
 * @module dsh-llm-antigravity-acp/history
 */

import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'

/** Server name under which DSH tools reach the agent; the agent prefixes tool names with `mcp_<server>_`. */
export const MCP_SERVER_NAME = 'dsh'
/** Agent-visible prefix of every DSH tool. */
export const AGENT_TOOL_PREFIX = `mcp_${MCP_SERVER_NAME}_`
/** Fallback MCP tool name for invoking any DSH tool omitted from direct declarations. */
export const CALL_TOOL_NAME = 'dsh_call_tool'

/**
 * Byte budget for the replayed history transcript while the context gates are
 * unlocked: about 730K tokens, inside the 1M window and the 983K checkpoint
 * budget, with room left for the system prompt, tool schemas, live input, and
 * multi-step tool output.
 */
export const UNLOCKED_REPLAY_BUDGET_BYTES = 2_200_000

/**
 * Byte budget under an unpatched `agy`, kept below its `64,000 * 3 = 192,000`
 * byte single-`USER_INPUT` truncation limit so the agent never tail-truncates
 * a replay prompt.
 */
export const LOCKED_REPLAY_BUDGET_BYTES = 160_000

const HISTORY_OPEN = '<dsh_history>\n'
const HISTORY_CLOSE = '\n</dsh_history>\n\n'
/** Upper bound of the omission notice, reserved before history is selected. */
const OMISSION_NOTICE_RESERVE_BYTES = 128

/**
 * Live input for a rebuild whose trailing messages are all tool results (for
 * example right after compaction in the middle of a tool loop), so the agent
 * receives a meaningful instruction instead of an empty prompt.
 */
export const EMPTY_INPUT_CONTINUATION = 'Continue the task from the latest tool results above.'

/** One ACP prompt content block. */
export type AcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** Image bytes resolved for one durable image reference. */
export interface ResolvedImage {
  data: string
  mimeType: string
}

/** Resolves image blocks to inline bytes; undefined sends a text placeholder. */
export type ImageResolver = (block: Extract<ContentBlock, { type: 'image' }>) => Promise<ResolvedImage | undefined>

/** System prompt and conversation messages split from one request. */
export interface SplitRequest {
  system: string
  messages: readonly RequestMessage[]
}

/**
 * Split leading system messages (and the one-shot `system` field) from history.
 * @param options - the model request.
 * @returns the combined system text and the remaining messages.
 */
export function splitSystem(options: GenerateOptions): SplitRequest {
  const parts: string[] = []
  if (options.system !== undefined && options.system.length > 0) parts.push(options.system)
  let index = 0
  for (const message of options.messages) {
    if (message.role !== 'system') break
    parts.push(textOf(message.content))
    index++
  }
  return { system: parts.filter(Boolean).join('\n\n'), messages: options.messages.slice(index) }
}

/**
 * Join the text blocks of one message.
 * @param content - message content blocks.
 * @returns concatenated text.
 */
export function textOf(content: readonly ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

/**
 * The bridge instructions appended to the agent's system prompt.
 * @param system - the DSH system prompt.
 * @returns the complete appended system text.
 */
export function bridgeSystemPrompt(system: string): string {
  const preamble = [
    'You are the primary model of a DeepSeek Harness (DSH) session. The harness owns the conversation, the tools, and their permissions.',
    `Every harness tool is available to you under the prefix \`${AGENT_TOOL_PREFIX}\`: a tool named \`X\` in the instructions below is the tool \`${AGENT_TOOL_PREFIX}X\`. If \`${AGENT_TOOL_PREFIX}X\` is absent from your direct tool declarations, invoke it via \`${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME}\` with \`{"name":"X","arguments":{...}}\`. Use only these tools; pass arguments exactly as their schemas define.`,
    'When the first user message contains a <dsh_history> block, it reproduces the earlier part of this conversation; continue from the newest input after it without repeating completed actions.',
  ].join('\n')
  return system.length > 0 ? `${preamble}\n\n${system}` : preamble
}

/**
 * Render a list of messages as transcript text.
 * @param messages - earlier conversation messages.
 * @returns transcript lines.
 */
export function renderTranscript(messages: readonly RequestMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        lines.push(`<user>\n${renderBlocks(message.content)}\n</user>`)
        break
      case 'assistant': {
        const text = renderBlocks(message.content.filter(b => b.type !== 'tool-call' && b.type !== 'reasoning'))
        if (text.length > 0) lines.push(`<assistant>\n${text}\n</assistant>`)
        for (const block of message.content) {
          if (block.type === 'tool-call') {
            lines.push(`<tool_call id="${block.id}" name="${AGENT_TOOL_PREFIX}${block.name}">\n${block.arguments}\n</tool_call>`)
          }
        }
        break
      }
      case 'tool':
        lines.push(`<tool_result id="${message.toolCallId}"${message.isError === true ? ' error="true"' : ''}>\n${renderBlocks(message.content)}\n</tool_result>`)
        break
      case 'developer': {
        const text = renderBlocks(message.content)
        if (text.length > 0) lines.push(`<harness_notice>\n${text}\n</harness_notice>`)
        break
      }
      case 'system':
        lines.push(`<system_update>\n${renderBlocks(message.content)}\n</system_update>`)
        break
      default:
        break
    }
  }
  return lines.join('\n\n')
}

function renderBlocks(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'image':
        parts.push(`[image ${block.attachment.attachmentId}${block.offloaded === true ? ' (offloaded)' : ''}]`)
        break
      case 'file':
        parts.push(`[file ${block.attachment.attachmentId}]`)
        break
      case 'tool-addition':
        parts.push(`[tool added: ${AGENT_TOOL_PREFIX}${block.toolName}]`)
        break
      case 'tool-removal':
        parts.push(`[tool removed: ${AGENT_TOOL_PREFIX}${block.toolName}]`)
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

/**
 * Convert one user-role message into ACP prompt blocks, inlining images.
 * @param content - user content blocks.
 * @param resolveImage - image byte resolver.
 * @returns prompt blocks in content order.
 */
export async function promptBlocks(content: readonly ContentBlock[], resolveImage: ImageResolver): Promise<AcpPromptBlock[]> {
  const blocks: AcpPromptBlock[] = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.length > 0) blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' && block.offloaded !== true) {
      const image = await resolveImage(block)
      if (image !== undefined) blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType })
      else blocks.push({ type: 'text', text: `[image ${block.attachment.attachmentId} unavailable]` })
    } else {
      const text = renderBlocks([block])
      if (text.length > 0) blocks.push({ type: 'text', text })
    }
  }
  return blocks
}

/**
 * Build the prompt that (re)creates a session: earlier history as transcript,
 * then the trailing input messages as live content.
 *
 * The trailing input is always complete. History renders newest-first into the
 * remaining byte budget, so the most recent turns survive and only the oldest
 * messages are omitted; an omitted prefix is announced inside the block. The
 * `<dsh_history>` block is always closed before the live input. When the plan
 * leaves no trailing input (the history ends with tool results), a short
 * continuation instruction is appended so the prompt is never empty.
 * @param history - messages before the trailing input.
 * @param input - trailing input messages sent as live content.
 * @param resolveImage - image byte resolver.
 * @param maxHistoryBytes - combined history and input byte ceiling; defaults to {@link UNLOCKED_REPLAY_BUDGET_BYTES}.
 * @returns prompt blocks.
 */
export async function replayPrompt(
  history: readonly RequestMessage[],
  input: readonly RequestMessage[],
  resolveImage: ImageResolver,
  maxHistoryBytes?: number,
): Promise<AcpPromptBlock[]> {
  const inputBlocks: AcpPromptBlock[] = input.length > 0
    ? await inputPrompt(input, resolveImage)
    : [{ type: 'text', text: EMPTY_INPUT_CONTINUATION }]
  const blocks: AcpPromptBlock[] = []
  if (history.length > 0) {
    const maxBytes = maxHistoryBytes ?? UNLOCKED_REPLAY_BUDGET_BYTES
    const inputBytes = inputBlocks.reduce((total, block) => total + (block.type === 'text' ? utf8Bytes(block.text) : 0), 0)
    const overhead = utf8Bytes(HISTORY_OPEN) + utf8Bytes(HISTORY_CLOSE) + OMISSION_NOTICE_RESERVE_BYTES
    const text = historyTranscript(history, Math.max(0, maxBytes - inputBytes - overhead))
    if (text.length > 0) blocks.push({ type: 'text', text })
  }
  blocks.push(...inputBlocks)
  return blocks
}

/**
 * Render the newest messages that fit `budget`, announcing any omitted prefix.
 * @param history - messages before the trailing input.
 * @param budget - byte budget for the transcript body.
 * @returns the complete `<dsh_history>` block, or an empty string without history.
 */
function historyTranscript(history: readonly RequestMessage[], budget: number): string {
  const parts: string[] = []
  let used = 0
  let dropped = 0
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index] as RequestMessage
    const rendered = renderTranscript([message])
    const separator = parts.length === 0 ? 0 : 2
    const bytes = utf8Bytes(rendered)
    if (used + separator + bytes > budget) {
      if (parts.length === 0 && message.role === 'tool' && budget > 1024) {
        const truncated = truncatedToolTranscript(message, budget)
        if (truncated !== undefined) {
          parts.unshift(truncated)
          dropped = index
        } else {
          dropped = index + 1
        }
      } else {
        dropped = index + 1
      }
      break
    }
    parts.unshift(rendered)
    used += separator + bytes
  }
  if (dropped > 0) parts.unshift(`[Earlier ${dropped} history messages omitted to fit the context replay budget]`)
  if (parts.length === 0) return ''
  return `${HISTORY_OPEN}${parts.join('\n\n')}${HISTORY_CLOSE}`
}

/**
 * Render one oversized tool result with its head kept inside `budget`.
 * @param message - the newest tool message.
 * @param budget - byte budget for its rendered transcript.
 * @returns the truncated transcript, or undefined when even the markup does not fit.
 */
function truncatedToolTranscript(message: Extract<RequestMessage, { role: 'tool' }>, budget: number): string | undefined {
  const marker = '\n[tool result truncated to fit the context replay budget]'
  let limit = budget - utf8Bytes(marker)
  for (let attempt = 0; attempt < 8 && limit > 0; attempt++) {
    const content: ContentBlock[] = [{ type: 'text', text: `${headWithinBytes(renderBlocks(message.content), limit)}${marker}` }]
    const rendered = renderTranscript([{ ...message, content }])
    const bytes = utf8Bytes(rendered)
    if (bytes <= budget) return rendered
    limit -= bytes - budget
  }
  return undefined
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function headWithinBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end--
  return bytes.subarray(0, end).toString('utf8')
}

/**
 * Convert new input messages (user, developer notices) into live prompt blocks.
 * @param input - messages that arrived after the session's known history.
 * @param resolveImage - image byte resolver.
 * @returns prompt blocks.
 */
export async function inputPrompt(input: readonly RequestMessage[], resolveImage: ImageResolver): Promise<AcpPromptBlock[]> {
  const blocks: AcpPromptBlock[] = []
  for (const message of input) {
    if (message.role === 'user') blocks.push(...await promptBlocks(message.content, resolveImage))
    else {
      const text = renderTranscript([message])
      if (text.length > 0) blocks.push({ type: 'text', text })
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: 'Continue.' })
  return blocks
}
