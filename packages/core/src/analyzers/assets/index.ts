import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Analyzer, AnalyzerContext, AssetFile } from '../../shared/types.js'
import { assetsRules } from './rules.js'

/** Concurrency cap for filesystem fan-out. */
const READ_LIMIT = 16

/** Above this width an image is almost certainly larger than any @3x need. */
export const EXCESSIVE_WIDTH_PX = 2000

/** One collected asset, enriched with everything the rules need. */
export interface AssetEntry {
  asset: AssetFile
  /** sha256 of the file bytes. Null when the file could not be read. */
  hash: string | null
  /** Pixel dimensions, when `sharp` was available and could decode the file. */
  width: number | null
  height: number | null
  /** True when the asset's basename appears in source text or app.json. */
  referenced: boolean
}

export interface AssetModel {
  entries: AssetEntry[]
  /**
   * False when the optional `sharp` native dependency could not be loaded.
   * Dimension-dependent rules skip silently in that case; the engine surfaces
   * a warning so the user knows why.
   */
  sharpAvailable: boolean
  /**
   * Concatenated text of every source file plus app.json, cached here so each
   * reference-scanning rule does not re-read the tree.
   */
  searchText: string
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * A plain `Promise.all` over a few hundred assets opens a few hundred file
 * descriptors at once, which on macOS trips the default ulimit and on CI
 * simply thrashes. Results keep input order.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      const item = items[index]
      // `noUncheckedIndexedAccess` — the bound check above already guarantees
      // presence, but the compiler cannot see it through the counter.
      if (item === undefined) return
      out[index] = await fn(item, index)
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker)
  await Promise.all(workers)
  return out
}

async function hashFile(absolutePath: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(absolutePath)
    return crypto.createHash('sha256').update(bytes).digest('hex')
  } catch {
    // A file that vanished or is unreadable should not fail the whole layer.
    return null
  }
}

type SharpModule = (input: string) => {
  metadata(): Promise<{ width?: number; height?: number }>
}

/**
 * Load `sharp` lazily.
 *
 * `sharp` is a heavy native module: it can be absent (optional install), built
 * for the wrong platform, or fail to link. None of those are reasons to abort
 * an analysis run, so the failure degrades to "no dimensions".
 */
async function loadSharp(): Promise<SharpModule | null> {
  try {
    const mod = (await import('sharp')).default
    return mod as unknown as SharpModule
  } catch {
    return null
  }
}

async function readDimensions(
  sharp: SharpModule,
  absolutePath: string,
): Promise<{ width: number | null; height: number | null }> {
  try {
    const meta = await sharp(absolutePath).metadata()
    return { width: meta.width ?? null, height: meta.height ?? null }
  } catch {
    // SVGs without an intrinsic size, corrupt files, unsupported codecs.
    return { width: null, height: null }
  }
}

/**
 * Build the haystack used for reference detection.
 *
 * We deliberately search raw text rather than resolving imports: assets are
 * referenced through `require('./x.png')`, `Asset.fromModule`, app.json fields,
 * and string concatenation. Text search over-matches (a basename that happens
 * to be a common word) but rarely under-matches, which is the right bias for
 * rules whose fix is deletion.
 */
async function buildSearchText(ctx: AnalyzerContext): Promise<string> {
  const { project } = ctx

  const chunks = await mapLimit(project.sourceFiles, READ_LIMIT, async (file) => {
    try {
      return await fs.readFile(file.absolutePath, 'utf8')
    } catch {
      return ''
    }
  })

  if (project.appJson) chunks.push(JSON.stringify(project.appJson))

  return chunks.join('\n')
}

export const assetsAnalyzer: Analyzer<AssetModel> = {
  name: 'assets',
  category: 'assets',
  rules: assetsRules,

  async collect(ctx: AnalyzerContext): Promise<AssetModel | null> {
    const { project, logger } = ctx

    // Nothing to say about a project with no static assets.
    if (project.assets.length === 0) return null

    const [searchText, sharp] = await Promise.all([buildSearchText(ctx), loadSharp()])
    if (!sharp) {
      logger.debug('sharp unavailable; image dimension rules will be skipped')
    }

    const entries = await mapLimit(project.assets, READ_LIMIT, async (asset) => {
      const hash = await hashFile(asset.absolutePath)

      let width: number | null = null
      let height: number | null = null
      // SVG is vector: a pixel width is meaningless as a "too big" signal.
      if (sharp && asset.kind === 'image' && asset.ext !== '.svg') {
        const dims = await readDimensions(sharp, asset.absolutePath)
        width = dims.width
        height = dims.height
      }

      return {
        asset,
        hash,
        width,
        height,
        referenced: searchText.includes(path.basename(asset.path)),
      } satisfies AssetEntry
    })

    logger.debug(`assets layer collected ${entries.length} assets`)

    return { entries, sharpAvailable: sharp !== null, searchText }
  },
}
