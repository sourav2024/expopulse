import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Cache } from '../shared/types.js'

/** A cache that stores nothing. Used when caching is disabled. */
export function createNullCache(): Cache {
  return {
    async get() {
      return undefined
    },
    async set() {},
    async clear() {},
  }
}

/**
 * A JSON file-backed cache under the project's cache directory.
 *
 * Entries are namespaced by a version token so that upgrading ExpoPulse
 * invalidates everything rather than reading results produced by older,
 * differently-behaving rules.
 */
export function createFileCache(dir: string, version: string): Cache {
  const namespace = hash(version).slice(0, 8)
  const base = path.join(dir, namespace)

  const fileFor = (key: string) => path.join(base, `${hash(key)}.json`)

  return {
    async get<T>(key: string): Promise<T | undefined> {
      try {
        const raw = await fs.readFile(fileFor(key), 'utf8')
        return JSON.parse(raw) as T
      } catch {
        // A miss and a corrupt entry are handled identically: recompute.
        return undefined
      }
    },

    async set<T>(key: string, value: T): Promise<void> {
      try {
        await fs.mkdir(base, { recursive: true })
        await fs.writeFile(fileFor(key), JSON.stringify(value), 'utf8')
      } catch {
        // Caching is an optimisation; never fail analysis because of it.
      }
    },

    async clear(): Promise<void> {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

export function hash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

/** Build a cache key from a file path plus its size and mtime. */
export function fileStamp(relPath: string, size: number, mtimeMs: number): string {
  return `${relPath}:${size}:${Math.round(mtimeMs)}`
}
