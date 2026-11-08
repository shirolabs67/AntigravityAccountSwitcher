/**
 * DeepSeek Harness primary-model provider for Google Antigravity.
 *
 * The plugin drives the locally installed, signed-in official CLI through its
 * Agent Client Protocol server (`agy acp`), exposes DSH tools to the agent
 * through a loopback MCP bridge, and registers the `antigravity` route with
 * the LLM service so Gemini and Claude models appear in the model picker
 * beside every other provider.
 * @module dsh-llm-antigravity-acp
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { AntigravityAdapter } from './adapter.ts'
import type { AcpSpawner } from './acp-process.ts'
import { Config } from './config.ts'
import type { ImageResolver } from './history.ts'
import type { CommandRunner } from './preflight.ts'
import { AntigravityRemote, registerRemote } from './remote.ts'
import { AntigravityRuntime } from './runtime.ts'

export { Config } from './config.ts'
export type { AntigravityGenerateOptions } from './proxy.ts'
export const name = 'llm-antigravity-acp'
export const inject = ['llm', 'subprocess']

interface ImageStore {
  readImageRequest(ref: unknown, target: { width: number; height: number; maxBytes: number }, signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: string }>
}

const REQUEST_IMAGE_MAX_BYTES = 7 * 1024 * 1024

/**
 * Plugin entry.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const subprocess = ctx.get('subprocess') as SubprocessRuntime
  const attachments = (): ImageStore | undefined => ctx.get('attachments') as ImageStore | undefined
  const env = { HOME: homedir() }

  const spawnAcp: AcpSpawner = (argv, cwd) => {
    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
      graceMs: 5_000,
      env,
    })
    if (handle.stdin === undefined || handle.stdout === undefined) throw new Error('antigravity-acp: ACP process has no stdio pipes')
    return {
      stdin: handle.stdin,
      stdout: handle.stdout,
      exited: handle.done.then(
        outcome => ({ code: outcome.exitCode, signal: outcome.signal }),
        (error: unknown) => ({ code: null, signal: error instanceof Error ? error.message : String(error) }),
      ),
      terminate: () => handle.terminate(),
      stderrTail: () => handle.collected.stderr?.readFrom(0).text ?? '',
    }
  }

  const runCommand: CommandRunner = async (argv, timeoutMs) => {
    const handle = subprocess.spawn({
      argv,
      cwd: homedir(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
      graceMs: 3_000,
      signal: AbortSignal.timeout(timeoutMs),
      env: { ...env, PYTHONUTF8: '1' },
    })
    const outcome = await handle.done
    return {
      code: outcome.exitCode,
      stdout: handle.collected.stdout?.readFrom(0).text ?? '',
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    }
  }

  const readImage: ImageResolver = async (block) => {
    const store = attachments()
    if (store === undefined) return undefined
    const ref = block.attachment
    const image = await store.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: REQUEST_IMAGE_MAX_BYTES })
    return { data: Buffer.from(image.data).toString('base64'), mimeType: image.mediaType }
  }

  const runtime = new AntigravityRuntime({
    config,
    spawnAcp,
    runCommand,
    readImage,
    canReadImages: () => attachments() !== undefined,
    log: {
      info: message => ctx.logger.info(message),
      warn: message => ctx.logger.warn(message),
    },
    onModelsChanged: () => ctx.emit('llm/adapters-updated'),
  })

  const fiberEntry = (ctx.fiber as { entry?: { options?: { id?: string } } }).entry
  const settingsNs = fiberEntry?.options?.id ?? name
  const adapter = new AntigravityAdapter(runtime, config.displayName, () => attachments() !== undefined)
  ctx.llm.registerConfigurableProviders([
    {
      provider: config.provider,
      displayName: config.displayName,
      settingsNs,
      settingsPath: [],
      nativeAuth: { env: [], oauth: true },
    },
  ])
  ctx.llm.registerAdapter([config.provider], adapter)
  ctx.effect(() => () => { void runtime.dispose() }, 'antigravity-acp: runtime')

  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as { configure?: (opts: { auto: boolean }, fiber: unknown) => () => void } | undefined
    if (typeof settings?.configure === 'function') {
      settingsCtx.effect(() => settings.configure!({ auto: false }, ctx.fiber), 'antigravity-acp: custom settings card')
    }
  })

  registerRemote(ctx)
  ctx.plugin(AntigravityRemote, { runtime, settingsNs })

  if (config.warmup) {
    void runtime.warmup().catch((error: unknown) => {
      ctx.logger.warn(`antigravity-acp: warmup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
