/**
 * Read per-step model token usage written by `agy` into its local SQLite
 * conversation store (`$home/agy/conversations/<sessionId>.db`, table `steps`,
 * `step_type = 15`, `status = 3`, Protobuf `metadata` field `9`).
 * @module dsh-llm-antigravity-acp/usage-db
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { AcpPromptResult } from './acp-process.ts'

type DatabaseSync = new (
  path: string,
  options?: { readOnly?: boolean; timeout?: number },
) => {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined
    all(...params: unknown[]): Record<string, unknown>[]
  }
  close(): void
}

let cachedDatabaseSync: DatabaseSync | null | undefined

function loadDatabaseSync(): DatabaseSync | undefined {
  if (cachedDatabaseSync !== undefined) return cachedDatabaseSync ?? undefined
  try {
    const req = createRequire(import.meta.url)
    const sqlite = req('node:sqlite') as { DatabaseSync?: DatabaseSync }
    cachedDatabaseSync = typeof sqlite.DatabaseSync === 'function' ? sqlite.DatabaseSync : null
  } catch {
    cachedDatabaseSync = null
  }
  return cachedDatabaseSync ?? undefined
}

/** Decoded `ModelUsageStats` submessage from `steps.metadata` field `9`. */
export interface DecodedModelUsage {
  inputTokens: number
  outputTokens: number
  cachedWriteTokens: number
  cachedReadTokens: number
  thoughtTokens: number
}

/** Aggregated model-step usage read after a step cursor. */
export interface StepUsageBatch {
  maxIdx: number
  calls: number
  usage: NonNullable<AcpPromptResult['usage']>
}

/**
 * Resolve the SQLite conversation DB path for one ACP session.
 * @param home - isolated Antigravity home directory.
 * @param sessionId - ACP session id.
 * @returns absolute path to `<sessionId>.db`.
 */
export function sessionDbPath(home: string, sessionId: string): string {
  return join(home, 'agy', 'conversations', `${sessionId}.db`)
}

function readVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } | undefined {
  let value = 0n
  let shift = 0n
  for (let i = 0; i < 10; i++) {
    const byte = buf[offset + i]
    if (byte === undefined) return undefined
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, next: offset + i + 1 }
    shift += 7n
  }
  return undefined
}

function toNonNegativeCount(raw: bigint): number {
  const signed = BigInt.asIntN(64, raw)
  if (signed <= 0n) return 0
  if (signed > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  return Number(signed)
}

function parseModelUsageSubmessage(buf: Uint8Array, target: DecodedModelUsage): boolean {
  let pos = 0
  while (pos < buf.length) {
    const tag = readVarint(buf, pos)
    if (tag === undefined) return false
    pos = tag.next
    const field = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    if (field <= 0) return false
    switch (wire) {
      case 0: {
        const val = readVarint(buf, pos)
        if (val === undefined) return false
        pos = val.next
        const count = toNonNegativeCount(val.value)
        if (field === 2) target.inputTokens = count
        else if (field === 3) target.outputTokens = count
        else if (field === 4) target.cachedWriteTokens = count
        else if (field === 5) target.cachedReadTokens = count
        else if (field === 9) target.thoughtTokens = count
        break
      }
      case 1:
        if (pos + 8 > buf.length) return false
        pos += 8
        break
      case 2: {
        const len = readVarint(buf, pos)
        if (len === undefined) return false
        const byteLen = Number(len.value)
        if (len.value < 0n || !Number.isSafeInteger(byteLen) || len.next + byteLen > buf.length) return false
        pos = len.next + byteLen
        break
      }
      case 5:
        if (pos + 4 > buf.length) return false
        pos += 4
        break
      default:
        return false
    }
  }
  return true
}

/**
 * Decode `ModelUsageStats` (top-level field `9`, wire type `2`) from a `steps.metadata` blob.
 * @param metadata - raw Protobuf bytes from `steps.metadata`.
 * @returns decoded token counts, or `undefined` if field `9` is absent or malformed.
 */
export function decodeModelUsageStats(metadata: Uint8Array): DecodedModelUsage | undefined {
  let pos = 0
  let found = false
  const stats: DecodedModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedWriteTokens: 0,
    cachedReadTokens: 0,
    thoughtTokens: 0,
  }
  while (pos < metadata.length) {
    const tag = readVarint(metadata, pos)
    if (tag === undefined) return undefined
    pos = tag.next
    const field = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    if (field <= 0) return undefined
    switch (wire) {
      case 0: {
        const val = readVarint(metadata, pos)
        if (val === undefined) return undefined
        pos = val.next
        break
      }
      case 1:
        if (pos + 8 > metadata.length) return undefined
        pos += 8
        break
      case 2: {
        const len = readVarint(metadata, pos)
        if (len === undefined) return undefined
        const byteLen = Number(len.value)
        if (len.value < 0n || !Number.isSafeInteger(byteLen) || len.next + byteLen > metadata.length) return undefined
        if (field === 9) {
          const sub = metadata.subarray(len.next, len.next + byteLen)
          if (!parseModelUsageSubmessage(sub, stats)) return undefined
          found = true
        }
        pos = len.next + byteLen
        break
      }
      case 5:
        if (pos + 4 > metadata.length) return undefined
        pos += 4
        break
      default:
        return undefined
    }
  }
  return found ? stats : undefined
}

/**
 * Read the current maximum completed model-step index (`step_type = 15, status = 3`).
 * @param dbPath - path to `<sessionId>.db`.
 * @returns maximum step `idx`, or `-1` when absent or empty.
 */
export function peekMaxModelStepIdx(dbPath: string): number {
  if (!existsSync(dbPath)) return -1
  const Database = loadDatabaseSync()
  if (Database === undefined) return -1
  try {
    const db = new Database(dbPath, { readOnly: true, timeout: 100 })
    try {
      const row = db.prepare('SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM steps WHERE step_type = 15 AND status = 3').get()
      const raw = row?.['maxIdx']
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      if (typeof raw === 'bigint') return Number(raw)
      return -1
    } finally {
      db.close()
    }
  } catch {
    return -1
  }
}

/**
 * Read and sum all completed model steps (`step_type = 15, status = 3`) after `afterIdx`.
 * @param dbPath - path to `<sessionId>.db`.
 * @param afterIdx - exclusive lower-bound step `idx`.
 * @returns aggregated batch, or `undefined` when no valid model steps exist after `afterIdx`.
 */
export function readModelStepsAfter(dbPath: string, afterIdx: number): StepUsageBatch | undefined {
  if (!existsSync(dbPath)) return undefined
  const Database = loadDatabaseSync()
  if (Database === undefined) return undefined
  try {
    const db = new Database(dbPath, { readOnly: true, timeout: 100 })
    try {
      const rows = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3 AND idx > ? ORDER BY idx ASC').all(afterIdx)
      let maxIdx = afterIdx
      let calls = 0
      let inputTokens = 0
      let outputTokens = 0
      let cachedReadTokens = 0
      let cachedWriteTokens = 0
      let thoughtTokens = 0
      for (const row of rows) {
        const rawIdx = row['idx']
        const idx = typeof rawIdx === 'number' && Number.isFinite(rawIdx)
          ? rawIdx
          : typeof rawIdx === 'bigint'
            ? Number(rawIdx)
            : undefined
        const rawMeta = row['metadata']
        const bytes = rawMeta instanceof Uint8Array
          ? rawMeta
          : ArrayBuffer.isView(rawMeta)
            ? new Uint8Array(rawMeta.buffer, rawMeta.byteOffset, rawMeta.byteLength)
            : undefined
        if (idx === undefined || bytes === undefined) continue
        const decoded = decodeModelUsageStats(bytes)
        if (decoded === undefined) continue
        if (idx > maxIdx) maxIdx = idx
        calls++
        inputTokens += decoded.inputTokens
        outputTokens += decoded.outputTokens
        cachedReadTokens += decoded.cachedReadTokens
        cachedWriteTokens += decoded.cachedWriteTokens
        thoughtTokens += decoded.thoughtTokens
      }
      if (calls === 0) return undefined
      return {
        maxIdx,
        calls,
        usage: {
          inputTokens,
          outputTokens,
          cachedReadTokens,
          cachedWriteTokens,
          thoughtTokens,
          totalTokens: inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens,
        },
      }
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}
