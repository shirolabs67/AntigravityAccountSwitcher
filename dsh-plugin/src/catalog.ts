/**
 * Model catalog derived from the agent's session configuration options. The
 * ACP server advertises model families (`gemini-4-argon`, `claude-opus-5-5`)
 * and a separate `thought_level` option; DSH lists each family once with the
 * efforts that family actually offers. Fixed-effort families such as
 * `gpt-oss-120b-medium` carry their effort in the id and expose no selector.
 * @module dsh-llm-antigravity-acp/catalog
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { AcpConfigOption } from './acp-process.ts'
import { EFFORTS, type Effort } from './config.ts'

/** One advertised model family. */
export interface CatalogModel {
  id: string
  name: string
}

/** One entry of the ACP `models.availableModels` list. */
export interface AvailableModel {
  modelId: string
  name?: string
}

/** Families shown before the first ACP session reports the account's catalog. */
export const FALLBACK_MODELS: readonly CatalogModel[] = [
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
]

/**
 * Families kept out of the picker even when the account advertises them.
 * Their ids still resolve and stream, so a persisted selection keeps working;
 * delete an entry here to show the family again.
 */
const HIDDEN_MODEL = /^(?:claude-sonnet-5-5|gpt-oss-)/

/**
 * Whether a family is hidden from the picker.
 * @param id - family id.
 * @returns true when it should not be listed.
 */
export function isHiddenModel(id: string): boolean {
  return HIDDEN_MODEL.test(id)
}

/** Display names of the efforts. */
export const EFFORT_NAMES: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** An id that already names one fixed effort instead of a selectable family. */
const FIXED_EFFORT = /-(low|medium|high)$/

/**
 * Pick the offered effort closest to the requested one.
 * @param wanted - requested effort.
 * @param offered - efforts the model exposes.
 * @returns one of `offered`, or `wanted` when nothing is offered.
 */
export function nearestEffort(wanted: Effort, offered: readonly Effort[]): Effort {
  if (offered.includes(wanted)) return wanted
  const distance = (effort: Effort): number => Math.abs(EFFORTS.indexOf(effort) - EFFORTS.indexOf(wanted))
  let best: Effort | undefined
  for (const effort of offered) {
    if (best === undefined || distance(effort) < distance(best)) best = effort
  }
  return best ?? wanted
}

/** Observed catalog with a disk cache. */
export class ModelCatalog {
  private models: CatalogModel[]
  private efforts: Effort[] = [...EFFORTS]
  /** Efforts per model family; an empty array marks a fixed-effort model. */
  private byModel = new Map<string, Effort[]>()
  /** Latest `availableModels` snapshot, kept for later option updates. */
  private available: readonly AvailableModel[] | undefined
  /** Whether a live ACP session has reported the catalog. */
  observed = false

  /** @param cachePath - JSON cache file. */
  constructor(private readonly cachePath: string) {
    this.models = this.load() ?? [...FALLBACK_MODELS]
  }

  /** Current families. */
  list(): readonly CatalogModel[] {
    return this.models
  }

  /** Efforts the account offers globally, in escalation order. */
  effortList(): readonly Effort[] {
    return this.efforts
  }

  /**
   * Efforts one family actually offers. Empty means the family is a single
   * fixed variant (for example `gpt-oss-120b-medium`).
   * @param id - family id.
   * @returns offered efforts.
   */
  effortsFor(id: string): readonly Effort[] {
    const observed = this.byModel.get(id)
    if (observed !== undefined) return observed
    return this.fixedEffort(id) === undefined ? this.efforts : []
  }

  /**
   * Effort baked into a fixed-variant id.
   * @param id - family id.
   * @returns the effort, or undefined for a selectable family.
   */
  fixedEffort(id: string): Effort | undefined {
    const match = FIXED_EFFORT.exec(id)
    return match === null ? undefined : match[1] as Effort
  }

  /**
   * Find one family.
   * @param id - family id.
   * @returns the catalog entry.
   */
  find(id: string): CatalogModel | undefined {
    return this.models.find(model => model.id === id)
  }

  /**
   * Fold session configuration options and the session's model inventory into
   * the catalog.
   * @param options - options from `session/new` or `config_option_update`.
   * @param available - `models.availableModels` from `session/new`.
   * @returns whether the family list changed.
   */
  observe(options: readonly AcpConfigOption[] | undefined, available?: readonly AvailableModel[] | undefined): boolean {
    if (available !== undefined && available.length > 0) this.available = available
    if (options === undefined) return false
    const modelOption = options.find(o => o.id === 'model' || o.category === 'model')
    const levelOption = options.find(o => o.id === 'thought_level' || o.category === 'thought_level')
    const beforeEfforts = JSON.stringify(this.efforts)
    if (levelOption?.options !== undefined) {
      const offered = levelOption.options.map(o => o.value).filter((v): v is Effort => (EFFORTS as readonly string[]).includes(v))
      if (offered.length > 0) this.efforts = EFFORTS.filter(e => offered.includes(e))
    }
    if (modelOption?.options === undefined || modelOption.options.length === 0) return false
    const next = modelOption.options
      .filter(o => !isHiddenModel(o.value))
      .map(o => ({ id: o.value, name: o.name ?? o.value }))
    this.observed = true
    const changed = JSON.stringify(next) !== JSON.stringify(this.models)
    if (changed) this.models = next
    const effortsChanged = this.deriveEfforts() || beforeEfforts !== JSON.stringify(this.efforts)
    if (changed || effortsChanged) this.save()
    return changed
  }

  /** Recompute per-family efforts from the latest inventory. */
  private deriveEfforts(): boolean {
    if (this.available === undefined) return false
    let changed = false
    for (const model of this.models) {
      const offered = EFFORTS.filter(effort => this.available!.some(entry => entry.modelId === `${model.id}-${effort}`))
      if (offered.length > 0) {
        if (JSON.stringify(this.byModel.get(model.id)) !== JSON.stringify(offered)) {
          this.byModel.set(model.id, offered)
          changed = true
        }
        continue
      }
      const present = this.available.some(entry => entry.modelId === model.id || entry.modelId.startsWith(`${model.id}-`))
      if (!present) continue
      if ((this.byModel.get(model.id) ?? []).length !== 0) {
        this.byModel.set(model.id, [])
        changed = true
      }
    }
    return changed
  }

  private save(): void {
    try {
      writeFileSync(this.cachePath, `${JSON.stringify({
        models: this.models,
        efforts: this.efforts,
        byModel: Object.fromEntries(this.byModel),
      }, null, 2)}\n`)
    } catch (_cacheWrite) {
      // The cache only speeds up the next cold start.
    }
  }

  private load(): CatalogModel[] | undefined {
    if (!existsSync(this.cachePath)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as {
        models?: CatalogModel[]
        efforts?: string[]
        byModel?: Record<string, string[]>
      }
      if (Array.isArray(parsed.efforts)) {
        const efforts = parsed.efforts.filter((v): v is Effort => (EFFORTS as readonly string[]).includes(v))
        if (efforts.length > 0) this.efforts = efforts
      }
      if (parsed.byModel !== null && typeof parsed.byModel === 'object') {
        for (const [id, values] of Object.entries(parsed.byModel)) {
          if (!Array.isArray(values)) continue
          const efforts = values.filter((v): v is Effort => (EFFORTS as readonly string[]).includes(v))
          this.byModel.set(id, efforts)
        }
      }
      const models = Array.isArray(parsed.models)
        ? parsed.models.filter(m => typeof m?.id === 'string' && typeof m?.name === 'string' && !isHiddenModel(m.id))
        : []
      return models.length > 0 ? models : undefined
    } catch (_cacheRead) {
      // A corrupt cache falls back to the built-in families.
      return undefined
    }
  }
}
