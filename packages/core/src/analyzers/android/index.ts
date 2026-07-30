import type { Analyzer, AnalyzerContext } from '../../shared/types.js'
import type { GradleFacts, ManifestFacts } from './parse.js'
import { parseGradle, parseManifest } from './parse.js'
import { androidRules } from './rules.js'

/**
 * The model the Android layer's rules run against.
 *
 * Both halves are nullable: a project can have an `android/` directory with a
 * manifest but no readable gradle files (or the reverse) and each rule should
 * still be able to say what it can. Rules must guard on the piece they need.
 */
export interface AndroidModel {
  manifest: ManifestFacts | null
  gradle: GradleFacts | null
  /**
   * Effective targetSdk, hoisted here because several rules key off it — most
   * importantly the storage-permission rules, whose verdict flips at API 33.
   */
  targetSdk: number | null
}

export const androidAnalyzer: Analyzer<AndroidModel> = {
  name: 'android',
  category: 'android',
  rules: androidRules,

  /**
   * Collect native Android facts, or skip the layer entirely.
   *
   * Continuous Native Generation is the default for Expo projects, so having no
   * `android/` directory is the COMMON case, not an error: the directory is
   * generated at build time by `expo prebuild`/EAS and is usually gitignored.
   * Returning null marks the layer not-applicable so it is excluded from scoring
   * rather than scored as a pass or a failure. This path must stay silent.
   */
  async collect(ctx: AnalyzerContext): Promise<AndroidModel | null> {
    const { project, logger, root } = ctx

    if (!project.hasAndroidDir) {
      logger.debug('no android/ directory; skipping android layer (CNG project)')
      return null
    }

    const [manifest, gradle] = await Promise.all([parseManifest(root), parseGradle(root)])

    // An `android/` directory that yields neither a manifest nor a gradle file
    // is not something we can analyse — treat it as not applicable too, rather
    // than reporting ten findings about absent configuration.
    if (!manifest && !gradle) {
      logger.debug('android/ present but no manifest or build.gradle was readable; skipping')
      return null
    }

    logger.debug(
      `android layer: ${manifest?.permissions.length ?? 0} permission(s), ` +
        `targetSdk ${gradle?.targetSdk?.value ?? 'unknown'}`,
    )

    return { manifest, gradle, targetSdk: gradle?.targetSdk?.value ?? null }
  },
}
