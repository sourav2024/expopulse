import fs from 'node:fs/promises'
import path from 'node:path'
import type { Finding, FixAction, FixContext, FixPlan, FixResult, Fixer } from '../shared/types.js'
import { writeFileAtomic } from './atomic-write.js'

const MANIFEST_PATH = 'android/app/src/main/AndroidManifest.xml'

/**
 * Remove duplicate `<uses-permission>` declarations from AndroidManifest.xml.
 *
 * Line-based rather than XML-tree based: Expo-generated manifests put one
 * permission per line, and rewriting the file through a parser would reformat
 * unrelated markup and produce a noisy diff.
 */
export const removeDuplicatePermissionFixer: Fixer = {
  ruleId: 'android/duplicate-permission',
  safe: true,

  async plan(findings: Finding[], ctx: FixContext): Promise<FixPlan> {
    const actions: FixAction[] = []
    const abs = path.join(ctx.root, MANIFEST_PATH)

    try {
      const original = await fs.readFile(abs, 'utf8')
      const deduped = dedupePermissionLines(original)

      if (deduped.removed > 0) {
        actions.push({
          kind: 'modify',
          file: MANIFEST_PATH,
          description: `remove ${deduped.removed} duplicate permission declaration(s)`,
        })
      }
    } catch {
      // No manifest (managed workflow) or unreadable: nothing to fix.
    }

    return { ruleId: this.ruleId, findings, actions }
  },

  async apply(plan: FixPlan, ctx: FixContext): Promise<FixResult> {
    const result: FixResult = { ruleId: this.ruleId, applied: [], failed: [], bytesSaved: 0 }

    for (const action of plan.actions) {
      const abs = path.join(ctx.root, action.file)
      try {
        const original = await fs.readFile(abs, 'utf8')
        const { text, removed } = dedupePermissionLines(original)

        if (removed === 0) {
          result.failed.push({ action, error: 'no duplicates found at apply time' })
          continue
        }

        await writeFileAtomic(abs, text, 'utf8')
        result.applied.push(action)
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

const PERMISSION_NAME = /<uses-permission[^>]*android:name\s*=\s*"([^"]+)"/

/** Drop repeat `<uses-permission>` lines, keeping the first of each name. */
export function dedupePermissionLines(text: string): { text: string; removed: number } {
  const lines = text.split(/\r?\n/)
  const seen = new Set<string>()
  const kept: string[] = []
  let removed = 0

  for (const line of lines) {
    const match = PERMISSION_NAME.exec(line)

    if (!match?.[1]) {
      kept.push(line)
      continue
    }

    // Only collapse single-line, self-closing declarations. A multi-line
    // element would need real parsing, so leave it for a human.
    if (!line.includes('/>')) {
      kept.push(line)
      continue
    }

    if (seen.has(match[1])) {
      removed += 1
      continue
    }

    seen.add(match[1])
    kept.push(line)
  }

  return { text: kept.join('\n'), removed }
}

/**
 * Sort top-level keys of app.json's expo object alphabetically.
 *
 * Purely cosmetic and lossless — JSON object key order carries no meaning to
 * Expo — which is what makes it safe.
 */
export const sortExpoConfigFixer: Fixer = {
  ruleId: 'expo/config-unsorted',
  safe: true,

  async plan(findings: Finding[], ctx: FixContext): Promise<FixPlan> {
    const actions: FixAction[] = []
    const abs = path.join(ctx.root, 'app.json')

    try {
      const original = await fs.readFile(abs, 'utf8')
      const sorted = sortAppJson(original)
      if (sorted && sorted !== original) {
        actions.push({
          kind: 'modify',
          file: 'app.json',
          description: 'sort configuration keys alphabetically',
        })
      }
    } catch {
      // No app.json: nothing to sort.
    }

    return { ruleId: this.ruleId, findings, actions }
  },

  async apply(plan: FixPlan, ctx: FixContext): Promise<FixResult> {
    const result: FixResult = { ruleId: this.ruleId, applied: [], failed: [], bytesSaved: 0 }

    for (const action of plan.actions) {
      const abs = path.join(ctx.root, action.file)
      try {
        const original = await fs.readFile(abs, 'utf8')
        const sorted = sortAppJson(original)

        if (!sorted) {
          result.failed.push({ action, error: 'could not parse app.json' })
          continue
        }

        await writeFileAtomic(abs, sorted, 'utf8')
        result.applied.push(action)
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

/** Reserialise app.json with sorted keys. Returns null if unparseable. */
export function sortAppJson(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const root = parsed as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const key of Object.keys(root).sort()) {
    const value = root[key]
    // Sort one level inside `expo` too, since that's where everything lives.
    out[key] =
      key === 'expo' && typeof value === 'object' && value !== null && !Array.isArray(value)
        ? sortKeys(value as Record<string, unknown>)
        : value
  }

  // Preserve a trailing newline, which most editors and formatters expect.
  return `${JSON.stringify(out, null, 2)}\n`
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) out[key] = obj[key]
  return out
}
