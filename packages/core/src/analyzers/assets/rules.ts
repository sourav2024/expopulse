import type { FindingDraft, Rule, RuleContext } from '../../shared/types.js'
import { formatBytes } from '../../shared/utils.js'
import type { AssetEntry, AssetModel } from './index.js'
import { EXCESSIVE_WIDTH_PX } from './index.js'

/** Raster formats that WebP reliably beats. */
const WEBP_CANDIDATE_EXTS = new Set(['.png', '.jpg', '.jpeg'])

/** Above this size the WebP win is large enough to be worth an extension change. */
const WEBP_MIN_BYTES = 100 * 1024

/**
 * Fraction of an oversized image's bytes we expect to recover by re-encoding
 * at quality ~80 without a visible difference. Conservative: real-world PNG
 * screenshots often compress far better, photos somewhat less.
 */
const COMPRESSION_RECOVERY = 0.6

/**
 * Shared caveat for every rule that decides "unused" from text search.
 *
 * Stated on each finding rather than only in `meta.rationale` because the
 * suggested action is deletion, and the user needs the caveat at the point of
 * decision.
 */
const REFERENCE_HEURISTIC =
  'References are detected by searching source text and app.json for the file name. ' +
  'Assets loaded through a computed path, a remote URL, or a native resource ' +
  'directory cannot be seen this way, so confirm before deleting.'

/**
 * Native resource locations whose contents are resolved by build-tool
 * convention, never by a string in source.
 *
 * Gradle compiles `res/mipmap-*`, `res/drawable-*` and friends into
 * `R.drawable.*`; Xcode reads `*.xcassets` from the asset catalog; both look up
 * launcher icons, splash art and notification icons by well-known name. Text
 * search therefore finds no reference to any of them, and reporting the whole
 * set as "unused" points the user at deleting their app icon — the one fix in
 * this rule that breaks a build rather than shrinking it.
 *
 * `ios/<App>/Images.xcassets/...` and `android/app/src/main/res/...` are the
 * paths Expo prebuild generates, so matching on the directory segment covers
 * bare-workflow projects without needing to know the app name.
 */
const NATIVE_RESOURCE_SEGMENTS = [
  /(^|\/)res\/(mipmap|drawable|values|xml|font|raw|anim|color)(-[a-z0-9-]+)?\//i,
  /\.xcassets\//i,
  /(^|\/)ios\/[^/]+\/(Base\.lproj|Supporting Files)\//i,
]

/**
 * Assets a native build consumes by convention, so absence from source text
 * says nothing about whether they are used.
 */
function isNativeConventionAsset(assetPath: string): boolean {
  return NATIVE_RESOURCE_SEGMENTS.some((pattern) => pattern.test(assetPath))
}

const duplicateImage: Rule<AssetModel> = {
  meta: {
    id: 'assets/duplicate-image',
    category: 'assets',
    severity: 'warning',
    description: 'Two or more assets have byte-identical contents',
    rationale:
      'Every copy is bundled separately, so identical files pay their size more than once. ' +
      'Duplicates usually come from copying an asset between feature folders.',
    recommendation: 'Keep one copy and update the other references to point at it.',
    fixable: true,
  },

  check(model: AssetModel): FindingDraft[] {
    const byHash = new Map<string, AssetEntry[]>()
    for (const entry of model.entries) {
      if (!entry.hash) continue
      // Native resources are consumed by name from XML and asset catalogs.
      // Identical launcher layers (foreground and monochrome are often the same
      // bitmap) are both required, and deleting either breaks the native build.
      if (isNativeConventionAsset(entry.asset.path)) continue
      const group = byHash.get(entry.hash)
      if (group) group.push(entry)
      else byHash.set(entry.hash, [entry])
    }

    const findings: FindingDraft[] = []
    for (const [hash, group] of byHash) {
      if (group.length < 2) continue

      // Keep a copy the code actually uses, so the fix never has to rewrite a
      // reference. Among equals prefer the largest, then the path, so the
      // choice is deterministic for the fixer.
      const sorted = [...group].sort(
        (a, b) =>
          Number(b.referenced) - Number(a.referenced) ||
          b.asset.size - a.asset.size ||
          a.asset.path.localeCompare(b.asset.path),
      )
      const keep = sorted[0]
      if (!keep) continue
      const redundant = sorted.slice(1)
      // Only unreferenced copies are safe to delete. Deleting a copy that is
      // still required leaves a dangling `require()` and breaks the bundle, so
      // referenced copies are listed for the user to re-point by hand.
      const removable = redundant.filter((entry) => !entry.referenced)
      const relink = redundant.filter((entry) => entry.referenced)
      const bytes = redundant.reduce((sum, entry) => sum + entry.asset.size, 0)

      const parts = [
        `Removing ${redundant.length} redundant ${
          redundant.length === 1 ? 'copy' : 'copies'
        } saves ${formatBytes(bytes)}.`,
      ]
      if (relink.length > 0) {
        parts.push(
          `${relink.length} of them ${relink.length === 1 ? 'is' : 'are'} still referenced: ` +
            `point those references at ${keep.asset.path} before deleting.`,
        )
      }

      findings.push({
        message:
          `${group.length} identical copies of ${keep.asset.path} ` +
          `(${formatBytes(keep.asset.size)} each)`,
        file: keep.asset.path,
        estimatedImpact: { bytes, note: parts.join(' ') },
        fixable: removable.length > 0,
        data: {
          hash,
          duplicates: group.map((entry) => entry.asset.path),
          keep: keep.asset.path,
          remove: removable.map((entry) => entry.asset.path),
          relink: relink.map((entry) => entry.asset.path),
        },
      })
    }

    return findings
  },
}

const unusedAsset: Rule<AssetModel> = {
  meta: {
    id: 'assets/unused-asset',
    category: 'assets',
    severity: 'warning',
    description: 'Asset file name never appears in source code or app.json',
    rationale:
      'Unreferenced assets still match `assetBundlePatterns` and ship inside the app, ' +
      'inflating download size for files nothing renders.',
    recommendation: 'Delete the asset, or reference it explicitly if it is loaded dynamically.',
    fixable: true,
  },

  check(model: AssetModel): FindingDraft[] {
    return (
      model.entries
        // Fonts get their own rule so the two can be configured separately.
        .filter((entry) => !entry.referenced && entry.asset.kind !== 'font')
        // Native build inputs are resolved by convention, not by name in source.
        .filter((entry) => !isNativeConventionAsset(entry.asset.path))
        .map((entry) => ({
          message: `${entry.asset.path} appears to be unused (${formatBytes(entry.asset.size)})`,
          rationale: REFERENCE_HEURISTIC,
          file: entry.asset.path,
          estimatedImpact: {
            bytes: entry.asset.size,
            note: 'Full file size, recovered only if the asset is genuinely unreachable.',
          },
          fixable: true,
          data: { kind: entry.asset.kind, size: entry.asset.size },
        }))
    )
  },
}

const oversizedImage: Rule<AssetModel> = {
  meta: {
    id: 'assets/oversized-image',
    category: 'assets',
    severity: 'warning',
    description: 'Image is larger than the configured image size threshold',
    rationale:
      'Large images dominate the app download and are decoded into memory at full size, ' +
      'which on low-end Android devices is a common source of jank and OOM kills.',
    recommendation: 'Re-encode at quality ~80, or downscale to the largest size actually rendered.',
    fixable: true,
  },

  check(model: AssetModel, ctx: RuleContext): FindingDraft[] {
    const limit = ctx.config.thresholds.maxImageBytes

    return model.entries
      .filter((entry) => entry.asset.kind === 'image' && entry.asset.size > limit)
      .map((entry) => {
        const recoverable = Math.round(entry.asset.size * COMPRESSION_RECOVERY)
        return {
          message:
            `${entry.asset.path} is ${formatBytes(entry.asset.size)}, ` +
            `over the ${formatBytes(limit)} image limit`,
          file: entry.asset.path,
          estimatedImpact: {
            bytes: recoverable,
            note:
              `Assumes ~${Math.round(COMPRESSION_RECOVERY * 100)}% of the bytes are recoverable ` +
              'by lossy re-encoding at visually equivalent quality. Actual savings depend on ' +
              'the image content.',
          },
          fixable: true,
          data: { size: entry.asset.size, limit, width: entry.width, height: entry.height },
        }
      })
  },
}

const oversizedAsset: Rule<AssetModel> = {
  meta: {
    id: 'assets/oversized-asset',
    category: 'assets',
    severity: 'warning',
    description: 'Non-image asset is larger than the configured asset size threshold',
    rationale:
      'Bundled video and audio are the single largest contributors to install size. ' +
      'They are also rarely needed on first launch.',
    recommendation:
      'Stream the file from a CDN, or download it on demand with expo-file-system instead of ' +
      'bundling it.',
  },

  check(model: AssetModel, ctx: RuleContext): FindingDraft[] {
    const limit = ctx.config.thresholds.maxAssetBytes

    return model.entries
      .filter((entry) => entry.asset.kind !== 'image' && entry.asset.size > limit)
      .map((entry) => ({
        message:
          `${entry.asset.path} is ${formatBytes(entry.asset.size)}, ` +
          `over the ${formatBytes(limit)} asset limit`,
        file: entry.asset.path,
        estimatedImpact: {
          bytes: entry.asset.size,
          note: 'Recovered in full only if the asset is moved off-bundle entirely.',
        },
        data: { kind: entry.asset.kind, size: entry.asset.size, limit },
      }))
  },
}

const unusedFont: Rule<AssetModel> = {
  meta: {
    id: 'assets/unused-font',
    category: 'assets',
    severity: 'warning',
    description: 'Font file name never appears in source code or app.json',
    rationale:
      'Font families are commonly added as a full weight set but only two or three weights are ' +
      'ever loaded. The rest ship unused, at a few hundred KB each.',
    recommendation: 'Remove weights the app never loads via useFonts or expo-font.',
    fixable: true,
  },

  check(model: AssetModel): FindingDraft[] {
    return (
      model.entries
        .filter((entry) => entry.asset.kind === 'font' && !entry.referenced)
        // A font in a native resource directory is loaded by the platform, not
        // by useFonts, so text search cannot see the reference.
        .filter((entry) => !isNativeConventionAsset(entry.asset.path))
        .map((entry) => ({
          message: `Font ${entry.asset.path} is never loaded (${formatBytes(entry.asset.size)})`,
          rationale: REFERENCE_HEURISTIC,
          file: entry.asset.path,
          estimatedImpact: { bytes: entry.asset.size },
          fixable: true,
          data: { size: entry.asset.size },
        }))
    )
  },
}

const imageDimensionsExcessive: Rule<AssetModel> = {
  meta: {
    id: 'assets/image-dimensions-excessive',
    category: 'assets',
    severity: 'info',
    description: 'Image pixel dimensions are larger than any screen density needs',
    rationale:
      'React Native decodes the full bitmap regardless of the rendered size, so an oversized ' +
      'image costs memory even when it looks fine. A 400pt element at @3x needs only 1200px.',
    recommendation: `Downscale to at most ${EXCESSIVE_WIDTH_PX}px wide, or to 3x the largest rendered size.`,
  },

  check(model: AssetModel): FindingDraft[] {
    // Skip silently rather than reporting nothing-is-wrong: without sharp we
    // have no dimensions at all. The engine warns about the missing dep.
    if (!model.sharpAvailable) return []

    return model.entries
      .filter((entry) => entry.width !== null && entry.width > EXCESSIVE_WIDTH_PX)
      .map((entry) => ({
        message:
          `${entry.asset.path} is ${entry.width}x${entry.height ?? '?'}px, ` +
          `wider than the ${EXCESSIVE_WIDTH_PX}px guideline`,
        rationale:
          'A 400pt element rendered at 3x density needs only 1200px; anything beyond that is ' +
          'decoded and then thrown away.',
        file: entry.asset.path,
        estimatedImpact: {
          note:
            'Bytes saved depend on the target size, so no estimate is given. Memory at decode ' +
            'time scales with width x height x 4.',
        },
        data: { width: entry.width, height: entry.height, size: entry.asset.size },
      }))
  },
}

const preferWebp: Rule<AssetModel> = {
  meta: {
    id: 'assets/prefer-webp',
    category: 'assets',
    severity: 'info',
    description: 'Large PNG or JPEG that would be substantially smaller as WebP',
    rationale:
      'WebP typically saves 25-35% over JPEG and more over PNG at equivalent quality, and is ' +
      'supported on every platform Expo targets.',
    recommendation: 'Convert to WebP and update the import path.',
    fixable: true,
  },

  check(model: AssetModel): FindingDraft[] {
    return model.entries
      .filter(
        (entry) => WEBP_CANDIDATE_EXTS.has(entry.asset.ext) && entry.asset.size >= WEBP_MIN_BYTES,
      )
      .map((entry) => {
        // 30% is the conservative end of the usual WebP win.
        const bytes = Math.round(entry.asset.size * 0.3)
        return {
          message: `${entry.asset.path} (${formatBytes(entry.asset.size)}) would be smaller as WebP`,
          file: entry.asset.path,
          estimatedImpact: {
            bytes,
            note: 'Assumes a conservative 30% reduction at equivalent visual quality.',
          },
          fixable: true,
          data: { ext: entry.asset.ext, size: entry.asset.size, optIn: true },
          // Changing the extension means rewriting every import of the file,
          // so the fixer is gated behind `fix.convertToWebp`.
          recommendation:
            'Opt in with `fix.convertToWebp` (off by default, because the file extension and ' +
            'every reference to it change).',
        }
      })
  },
}

export const assetsRules: Rule<AssetModel>[] = [
  duplicateImage,
  unusedAsset,
  oversizedImage,
  oversizedAsset,
  unusedFont,
  imageDimensionsExcessive,
  preferWebp,
]
