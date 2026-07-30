import type { Analyzer, AnalyzerContext } from '../../shared/types.js'
import type { CodeModel } from './parse.js'
import { buildCodeModel } from './parse.js'
import { codeRules } from './rules.js'

/**
 * Layer 1: static analysis of the project's JS/TS sources.
 *
 * All parsing happens in `collect` so that the nine rules share one AST per
 * file. Re-parsing per rule was the single largest cost in early profiling.
 */
export const codeAnalyzer: Analyzer<CodeModel> = {
  name: 'code',
  category: 'code',
  rules: codeRules,

  async collect(ctx: AnalyzerContext): Promise<CodeModel | null> {
    const { sourceFiles } = ctx.project
    // Nothing to parse: skip the layer entirely so it scores as N/A rather
    // than as a perfect 100.
    if (sourceFiles.length === 0) return null

    return buildCodeModel(sourceFiles, ctx.logger)
  },
}

export type { CodeModel, FileFacts, ImportedBinding, ParseError, ParsedFile } from './parse.js'
export { codeRules } from './rules.js'
