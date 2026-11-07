/**
 * Client side of the Account Switcher ACP extension and SSH transport.
 * The remote SSH account supplies the forced command. This plugin invokes
 * OpenSSH directly and supplies no shell command to the remote host.
 */
import { isIP } from 'node:net'
import { basename, isAbsolute } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AcpProcess } from './acp-process.ts'
import { JsonRpcClosedError, JsonRpcRemoteError } from './jsonrpc.ts'

export interface ProxyConfig {
  host: string
  user: string
  port: number
  executable: string
  remotePort: number
  identityFile: string
  knownHostsFile: string
}

export interface ProxyLease {
  status: 'selected' | 'exhausted'
  leaseId: string
  accountId?: string
  generationId: string
}

const EXTENSION = 'antigravityAccountSwitcher'
const ACQUIRE_TIMEOUT_MS = 120_000
const RELEASE_TIMEOUT_MS = 10_000

function filePath(value: string, field: string): string {
  // OpenSSH can expand percent tokens and environment references in paths.
  if (!isAbsolute(value) || /["%\r\n]|\$\{/.test(value)) {
    throw new Error(`proxy.${field} must be a literal absolute file path`)
  }
  return value
}

/** Build argv for a dedicated SSH connection and the existing local MCP bridge. */
export function proxyArgv(config: ProxyConfig, localBridgePort: number): string[] {
  const { host, user, port, remotePort, executable } = config
  if (isIP(host) === 0 && !/^[a-z\d][a-z\d.-]*$/i.test(host)) throw new Error('proxy.host must be a host name or IP address')
  if (!/^[a-z\d_][a-z\d_.-]*$/i.test(user)) throw new Error('proxy.user must be a dedicated SSH user name')
  if (executable !== 'ssh' && (!isAbsolute(executable) || !/^ssh(?:\.exe)?$/i.test(basename(executable)))) {
    throw new Error('proxy.executable must be ssh or an absolute path to OpenSSH')
  }
  if (![port, remotePort, localBridgePort].every(n => Number.isInteger(n) && n >= 1 && n <= 65535)) {
    throw new Error('proxy SSH and MCP ports must be integers in 1..65535')
  }
  const identity = filePath(config.identityFile, 'identityFile')
  const knownHosts = filePath(config.knownHostsFile, 'knownHostsFile')
  const sshPath = (path: string): string => process.platform === 'win32'
    ? path.replaceAll('\\', '/')
    : path.replaceAll('\\', '\\\\')
  return [
    executable, '-F', 'none', '-T', '-p', String(port), '-l', user,
    '-o', `IdentityFile="${sshPath(identity)}"`,
    '-o', `UserKnownHostsFile="${sshPath(knownHosts)}"`,
    '-o', 'GlobalKnownHostsFile=none',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UpdateHostKeys=no',
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '-R', `127.0.0.1:${remotePort}:127.0.0.1:${localBridgePort}`,
    host,
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function extension(meta: unknown): Record<string, unknown> | undefined {
  if (!isRecord(meta)) return undefined
  const value = meta[EXTENSION]
  return isRecord(value) ? value : undefined
}

export function assertProxyCapability(result: Record<string, unknown> | undefined): void {
  if (result?.protocolVersion !== 1 || extension(result._meta)?.version !== 1) {
    throw new LlmError('The SSH endpoint did not advertise Account Switcher ACP v1 support', 'PROXY_PROTOCOL')
  }
}

export async function acquireProxyTurn(proc: AcpProcess, chatKey: string, model: string): Promise<ProxyLease> {
  const result = await proc.request<unknown>(`_${EXTENSION}/acquireTurn`, { chatKey, model }, ACQUIRE_TIMEOUT_MS)
  if (!isRecord(result) || (result.status !== 'selected' && result.status !== 'exhausted')
    || typeof result.leaseId !== 'string' || result.leaseId.length === 0
    || typeof result.generationId !== 'string' || result.generationId.length === 0) {
    throw new LlmError('The Account Switcher returned an invalid turn lease', 'PROXY_PROTOCOL')
  }
  return {
    status: result.status,
    leaseId: result.leaseId,
    generationId: result.generationId,
    ...(typeof result.accountId === 'string' ? { accountId: result.accountId } : {}),
  }
}

export async function releaseProxyTurn(proc: AcpProcess, lease: ProxyLease): Promise<void> {
  await proc.request(`_${EXTENSION}/releaseTurn`, { leaseId: lease.leaseId }, RELEASE_TIMEOUT_MS)
}

export function proxyMeta(lease: ProxyLease | undefined, meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  return lease === undefined ? meta : { ...meta, [EXTENSION]: { leaseId: lease.leaseId } }
}

export function proxyNativeSessionId(meta: unknown): string | undefined {
  const id = extension(meta)?.nativeSessionId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

export function proxyRouteKey(lease: ProxyLease): string {
  return JSON.stringify([lease.status, lease.accountId, lease.generationId])
}

export function submissionUnknown(cause: unknown): LlmError {
  return new LlmError('Antigravity proxy disconnected after submitting this turn. Its result is unknown.', 'SUBMISSION_UNKNOWN', { cause })
}

const QUOTA_FAILURES = {
  login_required: {
    code: 'PROXY_QUOTA_LOGIN_REQUIRED',
    message: 'Sign in to Antigravity as the account worker’s service user on the Account Switcher host.',
    label: 'sign-in required',
  },
  timeout: {
    code: 'PROXY_QUOTA_TIMEOUT',
    message: 'The Account Switcher timed out while checking account quota.',
    label: 'quota check timed out',
  },
  invalid_quota: {
    code: 'PROXY_QUOTA_INVALID',
    message: 'The Account Switcher received missing or invalid quota fields.',
    label: 'missing or invalid quota fields',
  },
} as const

function quotaFailure(data: unknown): LlmError {
  const reasons = new Set<keyof typeof QUOTA_FAILURES>()
  let other = false
  const collect = (reason: unknown) => {
    switch (reason) {
      case 'login_required':
      case 'timeout':
      case 'invalid_quota':
        reasons.add(reason)
        break
      default:
        other = true
    }
  }
  if (isRecord(data) && data.kind === 'quota_unknown') {
    if (data.reason !== undefined) collect(data.reason)
    if (Array.isArray(data.accounts)) {
      for (const account of data.accounts) collect(isRecord(account) ? account.reason : undefined)
    }
  }
  const failures = [...reasons].map(reason => QUOTA_FAILURES[reason])
  const single = !other && failures.length === 1 ? failures[0] : undefined
  if (single !== undefined) return new LlmError(single.message, single.code)

  const labels: string[] = failures.map(failure => failure.label)
  if (other && labels.length > 0) labels.push('another probe failure')
  const message = labels.length > 0
    ? `The Account Switcher could not determine account quota. Checks reported ${labels.join(', ')}.`
    : 'The Account Switcher could not determine account quota. Check the account workers and quota configuration.'
  return new LlmError(message, 'PROXY_QUOTA_UNAVAILABLE')
}

export function proxyError(error: unknown, submitted = false): LlmError | undefined {
  if (submitted && error instanceof JsonRpcClosedError) return submissionUnknown(error)
  if (!(error instanceof JsonRpcRemoteError)) return undefined
  switch (error.rpc.code) {
    case -32040:
      return quotaFailure(error.rpc.data)
    case -32041:
      return submissionUnknown(error)
    case -32042:
      return new LlmError('The Account Switcher lease or session is no longer available.', 'PROXY_STALE_ROUTE', { cause: error })
    default:
      return undefined
  }
}
