/**
 * Typert Remote service `antigravityAcp`: provider status, quota, warmup, and
 * live configuration for the Web client's settings card and quota pill.
 * @module dsh-llm-antigravity-acp/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor, TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import { asEffort } from './config.ts'
import type { QuotaSnapshot } from './quota.ts'
import type { AntigravityRuntime, LiveOverrides, RuntimeStatus } from './runtime.ts'

/** Package name used for Typert descriptor identities. */
export const PACKAGE_NAME = 'dsh-llm-antigravity-acp'
/** Cordis service key and wire namespace. */
export const SERVICE_NAME = 'antigravityAcp'

declare module '@deepseek-ai/cordis' {
  interface Context {
    antigravityAcp: AntigravityRemote
  }
}

/** Optional request of `quota`. */
export interface QuotaRequest {
  force?: boolean
}

function parseQuotaRequest(value: unknown): QuotaRequest | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid antigravity quota request')
  const force = (value as Record<string, unknown>).force
  if (force !== undefined && typeof force !== 'boolean') throw new TypeError('Invalid antigravity quota request.force')
  return force === undefined ? {} : { force }
}

function parseConfigureRequest(value: unknown): LiveOverrides {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid antigravity configure request')
  const record = value as Record<string, unknown>
  const out: LiveOverrides = {}
  if (record.contextWindow !== undefined) {
    if (typeof record.contextWindow !== 'number' || !Number.isInteger(record.contextWindow) || record.contextWindow < 0 || record.contextWindow > 1_048_576) {
      throw new TypeError('Invalid antigravity contextWindow')
    }
    out.contextWindow = record.contextWindow
  }
  if (record.defaultEffort !== undefined) {
    const effort = typeof record.defaultEffort === 'string' ? asEffort(record.defaultEffort) : undefined
    if (effort === undefined) throw new TypeError('Invalid antigravity defaultEffort')
    out.defaultEffort = effort
  }
  if (record.longDecodeContinuations !== undefined) {
    if (typeof record.longDecodeContinuations !== 'number' || !Number.isInteger(record.longDecodeContinuations) || record.longDecodeContinuations < 0 || record.longDecodeContinuations > 16) {
      throw new TypeError('Invalid antigravity longDecodeContinuations')
    }
    out.longDecodeContinuations = record.longDecodeContinuations
  }
  return out
}

function parseObject(label: string) {
  return (value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label}`)
    return value
  }
}

function codec(typeSymbol: string, parse: (value: unknown) => unknown): TypertCodec {
  return { mode: 'strict', typeSymbol, create: () => ({ parse }) } as TypertCodec
}

const statusCodec = codec(`${PACKAGE_NAME}#Status`, parseObject('antigravity status'))
const quotaCodec = codec(`${PACKAGE_NAME}#Quota`, parseObject('antigravity quota'))
const requestCodec = codec(`${PACKAGE_NAME}#QuotaRequest`, parseQuotaRequest)
const configureCodec = codec(`${PACKAGE_NAME}#ConfigureRequest`, parseConfigureRequest)

/** Invocation descriptors registered with the Host Gateway. */
export const INVOCATIONS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/status`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: 'status',
    invocation: { kind: 'direct' },
    parameters: [],
    result: statusCodec,
  },
  {
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/quota`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: 'quota',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: requestCodec }],
    result: quotaCodec,
  },
  {
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/warmup`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: 'warmup',
    invocation: { kind: 'direct' },
    parameters: [],
    result: statusCodec,
  },
  {
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/configure`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: 'configure',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: configureCodec }],
    result: statusCodec,
  },
] as InvocationDescriptor[]

interface SettingsWriter {
  writable?: boolean
  update?(ns: string, values: Record<string, unknown>): Promise<void>
}

/** Remote facade over the runtime. */
export class AntigravityRemote extends TypertRemoteService {
  /**
   * @param ctx - owning context.
   * @param options - runtime and settings namespace.
   */
  constructor(
    ctx: Context,
    private readonly options: { runtime: AntigravityRuntime; settingsNs: string },
  ) {
    super(ctx, SERVICE_NAME)
  }

  /**
   * Provider status.
   * @returns the status snapshot.
   */
  status(): RuntimeStatus {
    return this.options.runtime.status()
  }

  /**
   * Plan quota for every model group.
   * @param request - optional cache bypass.
   * @returns the quota snapshot.
   */
  quota(request?: QuotaRequest): Promise<QuotaSnapshot> {
    return this.options.runtime.readQuota(request?.force === true)
  }

  /**
   * Start the ACP process and refresh the catalog without sending a prompt.
   * @returns the status after warmup.
   */
  async warmup(): Promise<RuntimeStatus> {
    try {
      await this.options.runtime.warmup()
    } catch (_warmupFailure) {
      // The failure is reported through the returned status.
    }
    return this.options.runtime.status()
  }

  /**
   * Apply live settings and persist them into the profile settings when writable.
   * @param request - updated configuration fields.
   * @returns updated status.
   */
  async configure(request: LiveOverrides): Promise<RuntimeStatus> {
    const patch = parseConfigureRequest(request)
    const status = this.options.runtime.configure(patch)
    const settings = this.ctx.get('settings') as SettingsWriter | undefined
    if (settings?.writable === true && typeof settings.update === 'function') {
      try {
        await settings.update(this.options.settingsNs, { ...patch })
      } catch (_persistSkipped) {
        // Ephemeral or overlay-mounted entries may not exist in the profile patch; in-memory override still applies.
      }
    }
    return status
  }
}

interface TypertRegistrar {
  register(contribution: unknown): () => void | Promise<void>
}

/**
 * Register the invocation descriptors with the Host Gateway when present.
 * @param ctx - plugin context.
 */
export function registerRemote(ctx: Context): void {
  ctx.inject(['typert'], (scope) => {
    scope.effect(() => {
      const registrar = scope.get('typert') as unknown as TypertRegistrar | undefined
      if (registrar === undefined || typeof registrar.register !== 'function') return () => undefined
      return registrar.register({
        package: PACKAGE_NAME,
        face: 'host',
        schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: INVOCATIONS,
      })
    }, 'antigravity-acp: remote descriptors')
  })
}
