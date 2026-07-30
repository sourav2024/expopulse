import type { Analyzer, Category, Rule } from '../shared/types.js'
import { androidAnalyzer } from './android/index.js'
import { assetsAnalyzer } from './assets/index.js'
import { codeAnalyzer } from './code/index.js'
import { depsAnalyzer } from './deps/index.js'
import { expoAnalyzer } from './expo/index.js'
import { iosAnalyzer } from './ios/index.js'

/**
 * Every analyzer shipped with ExpoPulse.
 *
 * Order is irrelevant to correctness — the engine runs these concurrently —
 * but it is kept in analysis-layer order to match the documentation.
 */
export const allAnalyzers: Analyzer<never>[] = [
  codeAnalyzer as unknown as Analyzer<never>,
  assetsAnalyzer as unknown as Analyzer<never>,
  depsAnalyzer as unknown as Analyzer<never>,
  expoAnalyzer as unknown as Analyzer<never>,
  androidAnalyzer as unknown as Analyzer<never>,
  iosAnalyzer as unknown as Analyzer<never>,
]

export { androidAnalyzer, assetsAnalyzer, codeAnalyzer, depsAnalyzer, expoAnalyzer, iosAnalyzer }

/** Look up the analyzers responsible for a category. */
export function analyzerByCategory(category: Category): Analyzer<never>[] {
  return allAnalyzers.filter((analyzer) => analyzer.category === category)
}

/**
 * Every rule from every built-in analyzer.
 *
 * Used by `expopulse doctor` to list available rules and by documentation
 * generation, neither of which needs to run an analysis to enumerate them.
 */
export function allRules(): Rule<never>[] {
  return allAnalyzers.flatMap((analyzer) => analyzer.rules)
}

/** Total number of built-in rules. */
export function ruleCount(): number {
  return allRules().length
}
