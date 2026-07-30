import fs from 'node:fs/promises'
import path from 'node:path'
import type { Finding, FixAction, FixContext, FixPlan, FixResult, Fixer } from '../shared/types.js'
import { formatBytes } from '../shared/utils.js'
import { writeFileAtomic } from './atomic-write.js'
import { resolveWithinRoot } from './safe-path.js'

/**
 * Load sharp on demand.
 *
 * sharp is a heavy native dependency and may fail to load on unusual
 * platforms. Image fixes degrade to a clear error rather than crashing.
 */
async function loadSharp() {
  try {
    const mod = await import('sharp')
    return mod.default
  } catch {
    return null
  }
}

const emptyResult = (ruleId: string): FixResult => ({
  ruleId,
  applied: [],
  failed: [],
  bytesSaved: 0,
})

/** Delete files flagged as unused or duplicated. */
function createDeletionFixer(ruleId: string, verb: string): Fixer {
  return {
    ruleId,
    safe: true,

    async plan(findings: Finding[], ctx: FixContext): Promise<FixPlan> {
      const actions: FixAction[] = []
      const seen = new Set<string>()

      for (const finding of findings) {
        // `data.remove` lists only the redundant copies. Never fall back to
        // `data.duplicates`: that includes the copy being kept, and deleting
        // every copy of an asset is data loss, not a fix.
        const targets = Array.isArray(finding.data?.remove)
          ? (finding.data.remove as string[]).filter((p) => typeof p === 'string')
          : finding.data?.remove === undefined && finding.file
            ? [finding.file]
            : []

        for (const target of targets) {
          if (seen.has(target)) continue
          seen.add(target)

          let size = 0
          try {
            size = (await fs.stat(path.join(ctx.root, target))).size
          } catch {
            // Already gone; nothing to do.
            continue
          }

          actions.push({
            kind: 'delete',
            file: target,
            description: `${verb} (${formatBytes(size)})`,
            bytesSaved: size,
          })
        }
      }

      return { ruleId, findings, actions }
    },

    async apply(plan: FixPlan, ctx: FixContext): Promise<FixResult> {
      const result = emptyResult(ruleId)

      for (const action of plan.actions) {
        try {
          // Deletion is irreversible for anything outside the backup session,
          // so refuse any target that resolves outside the project root.
          const abs = resolveWithinRoot(ctx.root, action.file)
          if (abs === null) {
            result.failed.push({ action, error: 'refusing to delete outside the project root' })
            continue
          }
          await fs.rm(abs, { force: true })
          result.applied.push(action)
          result.bytesSaved += action.bytesSaved ?? 0
        } catch (err) {
          result.failed.push({
            action,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      return result
    },
  }
}

export const removeUnusedAssetFixer = createDeletionFixer(
  'assets/unused-asset',
  'remove unused asset',
)

export const removeUnusedFontFixer = createDeletionFixer('assets/unused-font', 'remove unused font')

export const removeDuplicateAssetFixer = createDeletionFixer(
  'assets/duplicate-image',
  'remove duplicate copy',
)

/**
 * Recompress oversized images in place, preserving format and dimensions.
 *
 * The fix is only applied when the result is actually smaller — recompression
 * can inflate an already-optimised file, and silently making things worse is
 * the one outcome a "safe fix" must never produce.
 */
export const compressImageFixer: Fixer = {
  ruleId: 'assets/oversized-image',
  safe: true,

  async plan(findings: Finding[], ctx: FixContext): Promise<FixPlan> {
    const sharp = await loadSharp()
    const actions: FixAction[] = []

    if (!sharp) {
      return { ruleId: this.ruleId, findings, actions }
    }

    for (const finding of findings) {
      if (!finding.file) continue
      const abs = path.join(ctx.root, finding.file)

      try {
        const original = await fs.stat(abs)
        const compressed = await recompress(sharp, abs)

        if (!compressed || compressed.length >= original.size) continue

        const saved = original.size - compressed.length
        actions.push({
          kind: 'modify',
          file: finding.file,
          description: `compress ${formatBytes(original.size)} → ${formatBytes(compressed.length)}`,
          bytesSaved: saved,
        })
      } catch {
        // Unreadable or unsupported image: leave it alone.
      }
    }

    return { ruleId: this.ruleId, findings, actions }
  },

  async apply(plan: FixPlan, ctx: FixContext): Promise<FixResult> {
    const result = emptyResult(this.ruleId)
    const sharp = await loadSharp()

    if (!sharp) {
      for (const action of plan.actions) {
        result.failed.push({ action, error: 'sharp is not available' })
      }
      return result
    }

    for (const action of plan.actions) {
      const abs = path.join(ctx.root, action.file)
      try {
        const before = (await fs.stat(abs)).size
        const output = await recompress(sharp, abs)

        // Re-check rather than trusting the plan: the file may have changed
        // between plan and apply.
        if (!output || output.length >= before) {
          result.failed.push({ action, error: 'recompression produced no saving' })
          continue
        }

        await writeFileAtomic(abs, output)
        result.applied.push(action)
        result.bytesSaved += before - output.length
      } catch (err) {
        result.failed.push({
          action,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return result
  },
}

type SharpFactory = Awaited<ReturnType<typeof loadSharp>>

/** Recompress an image to a buffer, keeping its original format. */
async function recompress(sharp: NonNullable<SharpFactory>, abs: string): Promise<Buffer | null> {
  const ext = path.extname(abs).toLowerCase()
  const pipeline = sharp(abs)

  switch (ext) {
    case '.png':
      // effort 7 trades CPU for size; still well under a second for app icons.
      return pipeline.png({ compressionLevel: 9, effort: 7, palette: true }).toBuffer()
    case '.jpg':
    case '.jpeg':
      return pipeline.jpeg({ quality: 82, mozjpeg: true, progressive: true }).toBuffer()
    case '.webp':
      return pipeline.webp({ quality: 82, effort: 5 }).toBuffer()
    default:
      // Vector and animated formats are out of scope for a safe byte-level fix.
      return null
  }
}

/**
 * Convert PNG/JPEG to WebP alongside the original.
 *
 * Marked unsafe: it changes the file extension, so every import referencing
 * the old path must be updated. The engine will not run this without explicit
 * opt-in via `fix.convertToWebp`.
 */
export const convertToWebpFixer: Fixer = {
  ruleId: 'assets/prefer-webp',
  safe: false,

  async plan(findings: Finding[], ctx: FixContext): Promise<FixPlan> {
    const sharp = await loadSharp()
    const actions: FixAction[] = []
    if (!sharp) return { ruleId: this.ruleId, findings, actions }

    for (const finding of findings) {
      if (!finding.file) continue
      const abs = path.join(ctx.root, finding.file)
      try {
        const original = await fs.stat(abs)
        const webp = await sharp(abs).webp({ quality: 82, effort: 5 }).toBuffer()
        if (webp.length >= original.size) continue

        actions.push({
          kind: 'create',
          file: finding.file.replace(/\.(png|jpe?g)$/i, '.webp'),
          description:
            `create WebP from ${path.basename(finding.file)} ` +
            `(${formatBytes(original.size)} → ${formatBytes(webp.length)}); ` +
            'imports must be updated manually',
          bytesSaved: original.size - webp.length,
        })
      } catch {
        // Skip unreadable images.
      }
    }

    return { ruleId: this.ruleId, findings, actions }
  },

  async apply(plan: FixPlan, ctx: FixContext): Promise<FixResult> {
    const result = emptyResult(this.ruleId)
    const sharp = await loadSharp()
    if (!sharp) {
      for (const action of plan.actions) {
        result.failed.push({ action, error: 'sharp is not available' })
      }
      return result
    }

    for (const action of plan.actions) {
      // Recover the source path from the planned .webp output.
      const source = findSourceFor(ctx, action.file)
      if (!source) {
        result.failed.push({ action, error: 'source image not found' })
        continue
      }

      try {
        const buffer = await sharp(path.join(ctx.root, source)).webp({ quality: 82 }).toBuffer()
        await writeFileAtomic(path.join(ctx.root, action.file), buffer)
        result.applied.push(action)
        result.bytesSaved += action.bytesSaved ?? 0
      } catch (err) {
        result.failed.push({
          action,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return result
  },
}

/** Find the original raster file that a planned .webp path was derived from. */
function findSourceFor(ctx: FixContext, webpPath: string): string | null {
  const base = webpPath.replace(/\.webp$/i, '')
  for (const candidate of [`${base}.png`, `${base}.jpg`, `${base}.jpeg`]) {
    if (ctx.project.assets.some((asset) => asset.path === candidate)) return candidate
  }
  return null
}
