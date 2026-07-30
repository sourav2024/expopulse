import type { Logger } from './types.js'

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

/**
 * Minimal level-filtered logger.
 *
 * Diagnostics go to stderr so that stdout stays clean for machine-readable
 * report output (`--format json` piped into another tool).
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  const enabled = (want: LogLevel) => LEVEL_RANK[level] >= LEVEL_RANK[want]

  return {
    debug(msg, ...args) {
      if (enabled('debug')) console.error(`[debug] ${msg}`, ...args)
    },
    info(msg, ...args) {
      if (enabled('info')) console.error(msg, ...args)
    },
    warn(msg, ...args) {
      if (enabled('warn')) console.error(`warning: ${msg}`, ...args)
    },
    error(msg, ...args) {
      if (enabled('error')) console.error(`error: ${msg}`, ...args)
    },
  }
}

/** A logger that discards everything. Useful in tests. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
