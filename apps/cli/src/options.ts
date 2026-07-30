import fs from 'node:fs/promises'
import path from 'node:path'

/** Options accepted by every command. */
export interface GlobalOptions {
  cwd?: string
  debug?: boolean
  silent?: boolean
  noCache?: boolean
}

/**
 * Resolve and validate the project root.
 *
 * Failing early with a clear message beats analysing a non-existent directory
 * and reporting a suspiciously perfect score.
 */
export async function resolveRoot(cwd?: string): Promise<string> {
  const root = path.resolve(cwd ?? process.cwd())

  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(root)
  } catch {
    throw new Error(`directory not found: ${root}`)
  }

  if (!stat.isDirectory()) {
    throw new Error(`not a directory: ${root}`)
  }

  return root
}

/** Warn when the target doesn't look like a JavaScript project at all. */
export async function looksLikeProject(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, 'package.json'))
    return true
  } catch {
    return false
  }
}
