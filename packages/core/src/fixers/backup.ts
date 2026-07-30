import fs from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../shared/types.js'
import { resolveWithinRoot } from './safe-path.js'

/** Where backups live, relative to the project root. */
const BACKUP_ROOT = '.expopulse/backups'

export interface BackupManifestEntry {
  /** Project-relative path of the original file. */
  file: string
  /** Path of the stored copy, relative to the backup directory. */
  stored: string
  /** True when the file did not exist before the fix (so undo = delete). */
  created: boolean
}

export interface BackupSession {
  id: string
  dir: string
  /** Copy a file into the backup before it is modified or deleted. */
  save(relPath: string): Promise<void>
  /** Record that a fix created this file, so rollback removes it. */
  recordCreated(relPath: string): Promise<void>
  /** Persist the manifest. Call once all saves are done. */
  commit(): Promise<void>
  /** Restore every file in this session to its pre-fix state. */
  rollback(): Promise<void>
}

/**
 * Create a backup session for one `fix` invocation.
 *
 * Sessions are timestamped directories so consecutive runs don't clobber each
 * other and a user can roll back to any prior run.
 */
export async function createBackupSession(
  root: string,
  logger: Logger,
  id = timestampId(),
): Promise<BackupSession> {
  const dir = path.join(root, BACKUP_ROOT, id)
  const entries: BackupManifestEntry[] = []
  const seen = new Set<string>()

  return {
    id,
    dir,

    async save(relPath) {
      // Only back up the first version we see; later saves in the same run
      // would otherwise overwrite the pristine original with a half-fixed one.
      if (seen.has(relPath)) return
      seen.add(relPath)

      const source = path.join(root, relPath)
      const stored = relPath
      const target = path.join(dir, stored)

      try {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(source, target)
        entries.push({ file: relPath, stored, created: false })
      } catch (err) {
        // Failing to back up is fatal for that file: proceeding would mean an
        // unrecoverable edit. Surface it so the caller can skip the action.
        throw new Error(
          `could not back up ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },

    async recordCreated(relPath) {
      if (seen.has(relPath)) return
      seen.add(relPath)
      entries.push({ file: relPath, stored: '', created: true })
    },

    async commit() {
      if (entries.length === 0) return
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        path.join(dir, 'manifest.json'),
        JSON.stringify({ id, createdAt: new Date().toISOString(), entries }, null, 2),
        'utf8',
      )
      logger.debug(`backup written to ${BACKUP_ROOT}/${id}`)
    },

    async rollback() {
      await restoreEntries(root, dir, entries, logger)
    },
  }
}

/** Restore a previously committed backup session by id. */
export async function rollbackSession(root: string, id: string, logger: Logger): Promise<number> {
  const dir = path.join(root, BACKUP_ROOT, id)
  const manifestPath = path.join(dir, 'manifest.json')

  let manifest: { entries: BackupManifestEntry[] }
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      entries: BackupManifestEntry[]
    }
  } catch {
    throw new Error(`no usable backup found at ${BACKUP_ROOT}/${id}`)
  }

  await restoreEntries(root, dir, manifest.entries, logger)
  return manifest.entries.length
}

async function restoreEntries(
  root: string,
  dir: string,
  entries: BackupManifestEntry[],
  logger: Logger,
): Promise<void> {
  for (const entry of entries) {
    // The manifest is on-disk data: it lives inside the project, may be
    // committed, and could be edited or supplied by someone else. Treat both
    // paths as untrusted — a `../` segment would otherwise let a rollback
    // overwrite or delete files anywhere the process can reach.
    const target = resolveWithinRoot(root, entry.file)
    const source = resolveWithinRoot(dir, entry.stored)
    if (target === null || (!entry.created && source === null)) {
      logger.error(`refusing to restore ${entry.file}: path escapes the project root`)
      continue
    }
    try {
      if (entry.created) {
        // The fix created this file, so undoing means removing it.
        await fs.rm(target, { force: true })
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(source as string, target)
      }
    } catch (err) {
      // Keep restoring the rest; a partial rollback beats aborting halfway.
      logger.error(
        `failed to restore ${entry.file}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

/** List available backup sessions, newest first. */
export async function listBackups(root: string): Promise<string[]> {
  try {
    const dirents = await fs.readdir(path.join(root, BACKUP_ROOT), { withFileTypes: true })
    return dirents
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** Filesystem-safe sortable id, e.g. `2026-07-29T10-13-52-441Z`. */
function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
