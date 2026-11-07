/**
 * The DSH `LlmAdapter` for the Antigravity route: catalog, exact-model
 * metadata (context window and the three efforts), and streaming through the
 * ACP runtime.
 * @module dsh-llm-antigravity-acp/adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ReasoningEffortId, ResolvedRetryPolicy, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { EFFORT_NAMES, nearestEffort } from './catalog.ts'
import type { AntigravityRuntime } from './runtime.ts'

// DSH 0.2.1 retries TRANSPORT by default. A proxy attempt may have reached the
// worker or executed tools before a disconnect becomes visible to this client.
const PROXY_RETRY_POLICY: ResolvedRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: Object.freeze(['TRANSPORT']),
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

/** Antigravity primary-model adapter. */
export class AntigravityAdapter extends LlmAdapter {
  /**
   * @param runtime - process and session owner.
   * @param displayName - provider group name.
   * @param imageInput - whether request images can be read.
   */
  constructor(
    private readonly runtime: AntigravityRuntime,
    private readonly displayName: string,
    private readonly imageInput: () => boolean,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.displayName }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.runtime.usesProxy ? PROXY_RETRY_POLICY : undefined
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.runtime.catalog.list().map(model => ({
      provider,
      id: model.id,
      name: model.name,
      description: 'Antigravity via the official ACP server',
      inputModalities: this.imageInput() ? ['text', 'image'] as const : ['text'] as const,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.runtime.catalog.find(model)
    const efforts = this.runtime.catalog.effortsFor(model)
    const defaultEffort = efforts.length > 0 ? nearestEffort(this.runtime.defaultEffort(), efforts) : undefined
    return Promise.resolve({
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: this.imageInput() ? ['text', 'image'] as const : ['text'] as const,
      context: { contextWindow: this.runtime.contextWindowFor(model) },
      // A fixed-effort family (gpt-oss-120b-medium) has no selector; its
      // effort already lives in the model id.
      ...efforts.length > 0 ? {
        reasoning: {
          efforts: efforts.map(id => ({ id: id as ReasoningEffortId, name: EFFORT_NAMES[id] })),
          ...defaultEffort !== undefined ? { defaultEffort: defaultEffort as ReasoningEffortId } : {},
        },
      } : {},
      systemPromptUpdate: 'in-history',
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.runtime.stream(options)
  }
}
