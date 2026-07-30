import type { AnalysisResult } from '../shared/types.js'
import type { Reporter } from './index.js'

/**
 * Machine-readable dump of the full result.
 *
 * Deliberately the whole `AnalysisResult` with no projection: this is the
 * format `compare` reads back, so dropping fields here would silently break
 * diffing across versions. `version` on the result covers compatibility.
 */
export const jsonReporter: Reporter = {
  format: 'json',
  extension: 'json',
  render(result: AnalysisResult): string {
    return `${JSON.stringify(result, null, 2)}\n`
  },
}
