import fs from 'node:fs/promises'
import path from 'node:path'
import type { Finding, FixAction, FixContext, FixPlan, FixResult, Fixer } from '../shared/types.js'
import { writeFileAtomic } from './atomic-write.js'

/**
 * Remove unused import specifiers.
 *
 * Line-oriented on purpose. Reprinting the file through Babel would reformat
 * everything the user's formatter owns — quote style, trailing commas, line
 * breaks — turning a one-line fix into an unreviewable diff. So we edit only
 * the import lines the rule flagged and leave the rest of the file byte-identical.
 *
 * Anything we cannot rewrite with confidence is skipped rather than guessed at.
 */
export const removeUnusedImportFixer: Fixer = {
  ruleId: 'code/unused-import',
  safe: true,

  async plan(findings: Finding[], ctx: FixContext): Promise<FixPlan> {
    const actions: FixAction[] = []

    for (const [file, group] of groupByFile(findings)) {
      try {
        const original = await fs.readFile(path.join(ctx.root, file), 'utf8')
        const edited = rewrite(original, group)

        if (edited && edited !== original) {
          const removed = group.filter((f) => typeof f.data?.local === 'string').length
          actions.push({
            kind: 'modify',
            file,
            description: `remove ${removed} unused import specifier(s)`,
          })
        }
      } catch {
        // Unreadable file: nothing to plan.
      }
    }

    return { ruleId: this.ruleId, findings, actions }
  },

  async apply(plan: FixPlan, ctx: FixContext): Promise<FixResult> {
    const result: FixResult = { ruleId: this.ruleId, applied: [], failed: [], bytesSaved: 0 }
    const byFile = groupByFile(plan.findings)

    for (const action of plan.actions) {
      const group = byFile.get(action.file)
      if (!group) continue

      const abs = path.join(ctx.root, action.file)
      try {
        const original = await fs.readFile(abs, 'utf8')
        const edited = rewrite(original, group)

        if (!edited || edited === original) {
          result.failed.push({ action, error: 'import line changed since planning' })
          continue
        }

        await writeFileAtomic(abs, edited, 'utf8')
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

function groupByFile(findings: Finding[]): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>()
  for (const finding of findings) {
    if (!finding.file) continue
    const list = out.get(finding.file)
    if (list) list.push(finding)
    else out.set(finding.file, [finding])
  }
  return out
}

/**
 * Apply every removal for one file.
 *
 * Returns null when nothing could be changed safely.
 */
function rewrite(source: string, findings: Finding[]): string | null {
  // Preserve the file's existing line endings. Splitting on '\n' alone leaves a
  // trailing '\r' on every line of a CRLF file, which makes each edit compare
  // unequal and the whole fixer a silent no-op on Windows checkouts.
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)

  // Collect the specifier names to drop, keyed by the line they live on.
  const perLine = new Map<number, Set<string>>()
  for (const finding of findings) {
    const line = finding.location?.line
    const local = finding.data?.local
    if (typeof line !== 'number' || typeof local !== 'string') continue

    const set = perLine.get(line)
    if (set) set.add(local)
    else perLine.set(line, new Set([local]))
  }

  if (perLine.size === 0) return null

  // Track lines to delete outright, so indices stay valid while editing.
  const deletions = new Set<number>()
  let changed = false

  for (const [line, names] of perLine) {
    const index = line - 1
    const text = lines[index]
    if (text === undefined) continue

    // A multi-line import statement needs real parsing to edit correctly.
    if (!/^\s*import\b/.test(text) || !/\bfrom\b/.test(text)) continue

    const edited = removeSpecifiers(text, names)
    if (edited === null) continue

    if (edited === '') {
      deletions.add(index)
    } else {
      lines[index] = edited
    }
    changed = true
  }

  if (!changed) return null

  const kept = lines.filter((_, index) => !deletions.has(index))
  return kept.join(eol)
}

/**
 * Remove named specifiers from a single-line import statement.
 *
 * Returns the rewritten line, `''` when the whole statement should go, or
 * null when the line is too complex to edit safely.
 */
export function removeSpecifiers(line: string, remove: Set<string>): string | null {
  // Only ever edit a line holding exactly one import statement. A second
  // statement on the same line (`import a from './x'; const z = 1`, or two
  // imports) was previously swallowed by the greedy suffix and deleted with the
  // import, destroying unrelated code. Detect that and refuse to touch the line.
  if (/\bimport\b/.test(line.replace(/^\s*import\b/, ''))) return null
  const match = /^(\s*import\s+)(.*?)(\s+from\s+\s*['"][^'"]*['"]\s*;?\s*)$/.exec(line)
  if (!match) return null

  let [, prefix, clause, suffix] = match
  if (!prefix || !clause || !suffix) return null

  // Anything after the module specifier means another statement shares the line.
  if (/;\s*\S/.test(suffix)) return null

  // `import type { A } from './x'` — the modifier belongs to the statement, not
  // to a default binding. Lift it into the prefix so it is never mistaken for
  // an importable name (which produced the invalid `import type from './x'`).
  const typeOnly = /^type\s+/.test(clause)
  if (typeOnly) {
    clause = clause.replace(/^type\s+/, '')
    prefix = `${prefix}type `
  }

  // Split the clause into a default part and a braced named part.
  const braceStart = clause.indexOf('{')
  const braceEnd = clause.lastIndexOf('}')

  let defaultPart = ''
  let namedPart: string | null = null

  if (braceStart === -1) {
    defaultPart = clause.trim()
  } else {
    if (braceEnd < braceStart) return null
    defaultPart = clause.slice(0, braceStart).replace(/,\s*$/, '').trim()
    namedPart = clause.slice(braceStart + 1, braceEnd)
  }

  // A namespace import (`* as ns`) is all-or-nothing.
  if (defaultPart.startsWith('*')) {
    const alias = /\*\s+as\s+(\w+)/.exec(defaultPart)?.[1]
    if (alias && remove.has(alias) && namedPart === null) return ''
    return null
  }

  const keptDefault = defaultPart && !remove.has(stripTypeKeyword(defaultPart)) ? defaultPart : ''

  let keptNamed: string[] = []
  if (namedPart !== null) {
    keptNamed = namedPart
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .filter((part) => {
        // Match on the local binding, which is the alias when one exists.
        const local = /\s+as\s+(\w+)$/.exec(part)?.[1] ?? stripTypeKeyword(part)
        return !remove.has(local)
      })
  }

  // Nothing left to import: drop the statement. Note this deliberately does
  // not preserve a side-effect import, because a statement with specifiers
  // was never a side-effect import to begin with.
  if (!keptDefault && keptNamed.length === 0) return ''

  const parts: string[] = []
  if (keptDefault) parts.push(keptDefault)
  if (keptNamed.length > 0) parts.push(`{ ${keptNamed.join(', ')} }`)

  return `${prefix}${parts.join(', ')}${suffix}`
}

/** Strip a leading inline `type` keyword, e.g. `type Foo` -> `Foo`. */
function stripTypeKeyword(part: string): string {
  return part.replace(/^type\s+/, '').trim()
}
