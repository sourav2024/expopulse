import type {
  AnalysisResult,
  Finding,
  FixContext,
  FixPlan,
  FixResult,
  Fixer,
  Logger,
  ProjectModel,
  ResolvedConfig,
} from '../shared/types.js'
import {
  compressImageFixer,
  convertToWebpFixer,
  removeDuplicateAssetFixer,
  removeUnusedAssetFixer,
  removeUnusedFontFixer,
} from './asset-fixers.js'
import { createBackupSession } from './backup.js'
import { removeUnusedImportFixer } from './code-fixers.js'
import { removeDuplicatePermissionFixer, sortExpoConfigFixer } from './config-fixers.js'

/** Every fixer shipped with ExpoPulse. */
export const builtinFixers: Fixer[] = [
  compressImageFixer,
  removeUnusedAssetFixer,
  removeUnusedFontFixer,
  removeDuplicateAssetFixer,
  removeUnusedImportFixer,
  removeDuplicatePermissionFixer,
  sortExpoConfigFixer,
  convertToWebpFixer,
]

export interface FixRunOptions {
  result: AnalysisResult
  project: ProjectModel
  config: ResolvedConfig
  logger: Logger
  fixers?: Fixer[]
  /** Only fix findings from these rule ids. Empty means all fixable. */
  onlyRules?: string[]
}

export interface FixRunSummary {
  plans: FixPlan[]
  results: FixResult[]
  totalBytesSaved: number
  filesChanged: number
  /** Backup session id, or null when nothing was backed up. */
  backupId: string | null
  /** True when no writes were performed. */
  dryRun: boolean
  /** Fixable findings that had no registered fixer. */
  unhandledRules: string[]
}

/**
 * Build fix plans without touching the filesystem.
 *
 * Planning is always separate from applying so that `--dry-run` and the
 * interactive preview show exactly what `--yes` would do.
 */
export async function planFixes(options: FixRunOptions): Promise<{
  plans: FixPlan[]
  unhandledRules: string[]
}> {
  const { result, project, config, logger } = options
  const fixers = options.fixers ?? builtinFixers

  const byRule = new Map<string, Fixer>()
  for (const fixer of fixers) {
    // Unsafe fixers are opt-in only. WebP conversion rewrites file extensions,
    // so it stays out unless the user asked for it explicitly.
    if (!fixer.safe && !(fixer.ruleId === 'assets/prefer-webp' && config.fix.convertToWebp)) {
      continue
    }
    byRule.set(fixer.ruleId, fixer)
  }

  const wanted = new Set(options.onlyRules ?? [])
  const grouped = new Map<string, Finding[]>()
  const unhandled = new Set<string>()

  for (const finding of result.findings) {
    if (!finding.fixable) continue
    if (wanted.size > 0 && !wanted.has(finding.ruleId)) continue

    if (!byRule.has(finding.ruleId)) {
      unhandled.add(finding.ruleId)
      continue
    }

    const list = grouped.get(finding.ruleId)
    if (list) list.push(finding)
    else grouped.set(finding.ruleId, [finding])
  }

  const ctx: FixContext = { root: config.root, project, config, logger }
  const plans: FixPlan[] = []

  for (const [ruleId, findings] of grouped) {
    const fixer = byRule.get(ruleId)
    if (!fixer) continue

    try {
      const plan = await fixer.plan(findings, ctx)
      if (plan.actions.length > 0) plans.push(plan)
    } catch (err) {
      logger.warn(
        `could not plan fixes for ${ruleId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return { plans: reconcilePlans(plans, logger), unhandledRules: [...unhandled] }
}

/**
 * Resolve conflicts between independently-planned fixes.
 *
 * Fixers plan in isolation, so two of them can target the same file: an unused
 * duplicate image is both "a redundant copy" and "an unused asset". Applying
 * both is at best redundant and at worst destructive — the pair of rules would
 * between them delete every copy of an asset.
 *
 * Rules:
 *  - A file deleted by one plan is dropped from every other plan.
 *  - A file both modified and deleted keeps only the deletion, since
 *    compressing a file we are about to remove is wasted work.
 */
function reconcilePlans(plans: FixPlan[], logger: Logger): FixPlan[] {
  const deletions = new Set<string>()
  for (const plan of plans) {
    for (const action of plan.actions) {
      if (action.kind === 'delete') deletions.add(action.file)
    }
  }

  const claimed = new Set<string>()
  const out: FixPlan[] = []

  for (const plan of plans) {
    const kept = plan.actions.filter((action) => {
      // Only the first plan to claim a deletion performs it.
      if (action.kind === 'delete') {
        if (claimed.has(action.file)) {
          logger.debug(`${plan.ruleId}: skipping duplicate deletion of ${action.file}`)
          return false
        }
        claimed.add(action.file)
        return true
      }

      // Never modify a file another plan is deleting.
      if (deletions.has(action.file)) {
        logger.debug(`${plan.ruleId}: skipping ${action.file}, already scheduled for deletion`)
        return false
      }

      return true
    })

    if (kept.length > 0) out.push({ ...plan, actions: kept })
  }

  return out
}

/**
 * Plan and, unless dry-running, apply fixes.
 *
 * Every file a fix touches is backed up first; if any fixer throws outright the
 * whole session is rolled back, so the project is never left half-modified by a
 * crash.
 */
export async function runFixes(options: FixRunOptions): Promise<FixRunSummary> {
  const { config, logger, project } = options
  const fixers = options.fixers ?? builtinFixers
  const { plans, unhandledRules } = await planFixes(options)

  const summary: FixRunSummary = {
    plans,
    results: [],
    totalBytesSaved: 0,
    filesChanged: 0,
    backupId: null,
    dryRun: config.fix.dryRun,
    unhandledRules,
  }

  if (config.fix.dryRun || plans.length === 0) return summary

  const byRule = new Map(fixers.map((fixer) => [fixer.ruleId, fixer]))
  const ctx: FixContext = { root: config.root, project, config, logger }
  const session = config.fix.backup ? await createBackupSession(config.root, logger) : null

  try {
    for (const plan of plans) {
      const fixer = byRule.get(plan.ruleId)
      if (!fixer) continue

      // Back up before the fixer runs, so a mid-fixer failure is recoverable.
      //
      // A backup that fails is fatal for the plan, not a warning: applying the
      // fix anyway would make the edit unrecoverable while the summary still
      // advertises `--rollback`. Skip the plan and tell the user why.
      if (session) {
        let backedUp = true
        for (const action of plan.actions) {
          try {
            if (action.kind === 'create') await session.recordCreated(action.file)
            else await session.save(action.file)
          } catch (err) {
            backedUp = false
            const reason = err instanceof Error ? err.message : String(err)
            logger.warn(
              `${plan.ruleId}: skipped ${action.file} — could not create a backup (${reason}).`,
            )
            summary.results.push({
              ruleId: plan.ruleId,
              applied: [],
              failed: [{ action, error: `backup failed: ${reason}` }],
              bytesSaved: 0,
            })
            break
          }
        }
        if (!backedUp) continue
      }

      const outcome = await fixer.apply(plan, ctx)
      summary.results.push(outcome)
      summary.totalBytesSaved += outcome.bytesSaved
      summary.filesChanged += outcome.applied.length

      for (const failure of outcome.failed) {
        logger.warn(`${plan.ruleId}: could not fix ${failure.action.file}: ${failure.error}`)
      }
    }

    if (session) {
      await session.commit()
      summary.backupId = session.id
    }
  } catch (err) {
    // An exception escaping a fixer means we don't know what state the tree is
    // in. Restore everything rather than leaving a partial edit behind.
    if (session) {
      logger.error('a fix failed unexpectedly; rolling back')
      await session.rollback()
    }
    throw err
  }

  return summary
}
