import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { JsonObject } from './router-types.js'
import { Lines, object } from './wire.js'

const QUOTA_OUTPUT_LIMIT = 1024 * 1024
const CLOSE_GRACE_MS = 2_000

export interface AccountWorkerOptions {
  agyPath: string
  cwd: string
  geminiDir?: string
  probeTimeoutMs?: number
}

interface Quota {
  weekly: number
  fiveHour: number
}

type WorkerErrorCode =
  | 'agent-missing'
  | 'quota-auth'
  | 'quota-timeout'
  | 'quota-invalid'
  | 'quota-unavailable'
  | 'stream-invalid'
  | 'stream-unavailable'

const ERROR_MESSAGES: Record<WorkerErrorCode, string> = {
  'agent-missing': 'The account worker needs a readable dsh-bridge agent in its workspace.',
  'quota-auth': 'The account worker needs Antigravity authentication.',
  'quota-timeout': 'The account worker quota probe timed out.',
  'quota-invalid': 'The account worker returned unrecognized quota data.',
  'quota-unavailable': 'The account worker quota probe failed.',
  'stream-invalid': 'The account worker received an invalid ACP frame.',
  'stream-unavailable': 'The account worker ACP stream is unavailable.',
}

export class WorkerError extends Error {
  constructor(readonly code: WorkerErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'WorkerError'
  }
}

/** Blocks startup when the dedicated ACP agent has not been provisioned. */
export async function validateWorkerWorkspace(cwd: string): Promise<void> {
  try {
    const file = await open(join(cwd, '.agents', 'agents', 'dsh-bridge.md'), 'r')
    try {
      const info = await file.stat()
      if (info.isFile() && info.size > 0) return
    } finally {
      await file.close()
    }
  } catch {
    // File errors may include local paths and need not leave this process.
  }
  throw new WorkerError('agent-missing')
}

type WorkerSpawner = (
  path: string,
  args: readonly string[],
  options: { cwd: string; windowsHide: true; shell: false; stdio: 'pipe' },
) => ChildProcessWithoutNullStreams

function needsLogin(value: unknown): boolean {
  return typeof value === 'string'
    && /\b(?:authentication required|not (?:logged|signed) in|(?:sign[- ]in|log[- ]?in) required|invalid_grant|unauthenticated|401\s+unauthorized)\b/i.test(value)
}

function parseQuota(output: string, groupId: string): Quota {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    throw new WorkerError('quota-invalid')
  }
  const envelope = object(value)
  if (envelope === undefined) throw new WorkerError('quota-invalid')
  if (envelope.status !== undefined && envelope.status !== 'SUCCESS') {
    throw new WorkerError(needsLogin(envelope.error) ? 'quota-auth' : 'quota-unavailable')
  }
  const groups = object(object(envelope.command)?.data)?.groups
  if (!Array.isArray(groups)) throw new WorkerError('quota-invalid')
  const matching = groups.map(object).filter(group => group?.name === groupId)
  if (matching.length !== 1) throw new WorkerError('quota-invalid')
  const buckets = matching[0]?.buckets
  if (!Array.isArray(buckets)) throw new WorkerError('quota-invalid')

  const windows = new Map<'weekly' | '5h', number>()
  for (const item of buckets) {
    const bucket = object(item)
    if (bucket === undefined) throw new WorkerError('quota-invalid')
    const window = bucket.window
    if (window !== 'weekly' && window !== '5h') continue
    const fraction = bucket.remaining_fraction
    if (windows.has(window) || bucket.disabled === true || bucket.enabled === false
      || typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
      throw new WorkerError('quota-invalid')
    }
    windows.set(window, fraction)
  }

  const weekly = windows.get('weekly')
  const fiveHour = windows.get('5h')
  if (weekly === undefined || fiveHour === undefined) throw new WorkerError('quota-invalid')
  return { weekly, fiveHour }
}

function stop(child: ChildProcessWithoutNullStreams): void {
  // EOF lets agy finish cleaning up its per-session children. Bound the wait
  // if it fails to stop. Node owns only the process it spawned.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.stdin.end()
  child.stdout.resume()
  const timer = setTimeout(() => child.kill(), CLOSE_GRACE_MS)
  timer.unref()
  child.once('close', () => clearTimeout(timer))
}

/** Runs only within the Windows user/profile that started this worker. */
export class AccountWorker {
  private readonly streams = new Map<string, Lines>()
  private readonly probes = new Set<() => void>()
  private readonly profileArgs: string[]
  private readonly probeTimeoutMs: number
  private readonly agyPath: string
  private readonly cwd: string

  constructor(
    options: AccountWorkerOptions,
    private readonly spawnChild: WorkerSpawner = spawn,
  ) {
    if (!isAbsolute(options.agyPath) || !isAbsolute(options.cwd)
      || (options.geminiDir !== undefined && !isAbsolute(options.geminiDir))) {
      throw new TypeError('Account worker paths must be absolute.')
    }
    this.agyPath = options.agyPath
    this.cwd = options.cwd
    this.profileArgs = options.geminiDir === undefined ? [] : ['--gemini-dir', options.geminiDir]
    this.probeTimeoutMs = options.probeTimeoutMs ?? 45_000
    if (!Number.isSafeInteger(this.probeTimeoutMs) || this.probeTimeoutMs < 1 || this.probeTimeoutMs > 120_000) {
      throw new TypeError('Account worker probe timeout must be 1–120000 ms.')
    }
  }

  async probe(groupId: string): Promise<Quota> {
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.start(['-p', '/usage', '--output-format', 'json'])
    } catch {
      throw new WorkerError('quota-unavailable')
    }

    return await new Promise<Quota>((resolve, reject) => {
      const output: Buffer[] = []
      const diagnostics: Buffer[] = []
      let bytes = 0
      let done = false
      const finish = (error?: WorkerError): boolean => {
        if (done) return false
        done = true
        clearTimeout(timer)
        this.probes.delete(abort)
        if (error !== undefined) {
          child.kill()
          child.stdout.destroy()
          child.stderr.destroy()
          reject(error)
        }
        return true
      }
      const abort = () => { finish(new WorkerError('quota-unavailable')) }
      const timer = setTimeout(() => finish(new WorkerError('quota-timeout')), this.probeTimeoutMs)
      this.probes.add(abort)

      const read = (into: Buffer[]) => (chunk: Buffer) => {
        if (done) return
        bytes += chunk.length
        if (bytes > QUOTA_OUTPUT_LIMIT) finish(new WorkerError('quota-invalid'))
        else into.push(chunk)
      }
      child.stdout.on('data', read(output))
      child.stderr.on('data', read(diagnostics))
      child.on('error', abort)
      child.stdin.on('error', abort)
      child.stdout.on('error', abort)
      child.stderr.on('error', abort)
      child.once('close', (code) => {
        if (!finish()) return
        const stdout = Buffer.concat(output).toString('utf8')
        const stderr = Buffer.concat(diagnostics).toString('utf8')
        if (code !== 0 || (stdout.trim() === '' && needsLogin(stderr))) {
          reject(new WorkerError(needsLogin(stderr) || needsLogin(stdout) ? 'quota-auth' : 'quota-unavailable'))
          return
        }
        try {
          resolve(parseQuota(stdout, groupId))
        } catch (error) {
          reject(error)
        }
      })
      child.stdin.end()
    })
  }

  open(streamId: string, onFrame: (frame: JsonObject) => void, onClose: () => void): void {
    if (this.streams.has(streamId)) throw new WorkerError('stream-invalid')

    let child: ChildProcessWithoutNullStreams
    try {
      child = this.start(['acp', '--process-per-session', '--disable-telemetry', '--agent', 'dsh-bridge'])
    } catch {
      throw new WorkerError('stream-unavailable')
    }

    const lines = new Lines(child.stdout, child.stdin, frame => {
      if (frame.jsonrpc !== '2.0') throw new WorkerError('stream-invalid')
      onFrame(frame)
    }, () => {
      this.streams.delete(streamId)
      onClose()
    }, () => stop(child))
    this.streams.set(streamId, lines)
    child.on('error', lines.close)
    child.stderr.on('error', lines.close)
    child.once('close', lines.close)
    // Drain diagnostics without forwarding local paths or account data.
    child.stderr.resume()
  }

  send(streamId: string, frame: JsonObject): void {
    const active = this.streams.get(streamId)
    if (active === undefined) throw new WorkerError('stream-unavailable')
    if (frame.jsonrpc !== '2.0') throw new WorkerError('stream-invalid')

    if (frame.method === 'session/new' || frame.method === 'session/load' || frame.method === 'session/resume') {
      const params = object(frame.params)
      if (params === undefined) throw new WorkerError('stream-invalid')
      const localParams: JsonObject = { ...params, cwd: this.cwd }
      delete localParams.additionalDirectories
      frame = { ...frame, params: localParams }
    }
    try {
      active.send(frame)
    } catch {
      throw new WorkerError('stream-invalid')
    }
  }

  close(streamId: string): void {
    this.streams.get(streamId)?.close()
  }

  closeAll(): void {
    for (const close of this.probes) close()
    for (const active of this.streams.values()) active.close()
  }

  private start(args: readonly string[]): ChildProcessWithoutNullStreams {
    return this.spawnChild(this.agyPath, [...args, ...this.profileArgs], {
      cwd: this.cwd,
      windowsHide: true,
      shell: false,
      stdio: 'pipe',
    })
  }
}
