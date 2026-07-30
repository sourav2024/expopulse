/**
 * Expo SDK compatibility knowledge table.
 *
 * MAINTENANCE: this table must be updated with every Expo SDK release. It is a
 * static snapshot of published pairings, not something we can derive at runtime
 * without a network call.
 *
 * Unknown (newer) SDK majors are "unknown, not an error". A project on an SDK
 * released after this table was written is almost certainly *more* current than
 * we are, so rules must skip rather than flag. The same holds for majors older
 * than the table's floor: we simply have nothing recorded, and silence beats a
 * guess.
 *
 * Where a specific pairing is not something we are confident about, the field is
 * `null` rather than an approximation — a wrong "expected React Native version"
 * produces a confident false error, which is worse than no finding at all.
 */

export interface SdkInfo {
  major: number
  /** React Native version Expo ships for this SDK, e.g. `0.76`. Null if unsure. */
  reactNative: string | null
  /** React version this SDK expects, e.g. `18.3.1`. Null if unsure. */
  react: string | null
  /** True when Hermes is the default JS engine for this SDK. */
  hermesDefault: boolean
  /**
   * True when the New Architecture (Fabric/TurboModules) is enabled by default
   * for newly created projects on this SDK.
   */
  newArchDefault: boolean
  /**
   * True when Expo no longer supports this SDK. Expo's stated policy is roughly
   * the latest three SDKs, so this tracks that window rather than any formal
   * end-of-life announcement.
   */
  eol: boolean
}

/**
 * Highest SDK major this table knows about. Rules compare against this to
 * decide whether an unrecognised SDK is "too new to judge" (skip) versus
 * "too old to be in our window" (also skip — see `getSdkInfo`).
 */
export const LATEST_KNOWN_SDK = 54

/** Lowest SDK major recorded here. Anything below is simply unknown to us. */
export const OLDEST_KNOWN_SDK = 49

/**
 * Confidence note surfaced by rules that quote this table, so a report reader
 * can weigh a version-mismatch finding appropriately.
 */
export const confidence =
  'SDK pairings are from a static table snapshot and may lag the latest Expo ' +
  'release. Fields we are not confident about are recorded as unknown and are ' +
  'never used to produce findings. Verify against the official Expo SDK ' +
  'changelog before acting on a version-mismatch finding.'

/**
 * Known SDK majors, keyed by major version.
 *
 * `newArchDefault` is the subtle one: New Architecture became opt-in and
 * generally usable around SDK 51-52, but only became the default for new
 * projects in SDK 52+. `eol` reflects the ~3-SDK support window measured from
 * `LATEST_KNOWN_SDK`.
 */
const SDK_TABLE: Readonly<Record<number, SdkInfo>> = {
  49: {
    major: 49,
    reactNative: '0.72',
    react: '18.2.0',
    hermesDefault: true,
    newArchDefault: false,
    eol: true,
  },
  50: {
    major: 50,
    reactNative: '0.73',
    react: '18.2.0',
    hermesDefault: true,
    newArchDefault: false,
    eol: true,
  },
  51: {
    major: 51,
    reactNative: '0.74',
    react: '18.2.0',
    hermesDefault: true,
    // Available behind `newArchEnabled`, but not on by default.
    newArchDefault: false,
    eol: true,
  },
  52: {
    major: 52,
    reactNative: '0.76',
    react: '18.3.1',
    hermesDefault: true,
    newArchDefault: true,
    eol: true,
  },
  53: {
    major: 53,
    reactNative: '0.79',
    react: '19.0.0',
    hermesDefault: true,
    newArchDefault: true,
    eol: false,
  },
  54: {
    major: 54,
    reactNative: '0.81',
    // React 19.1 shipped with this SDK; the exact patch is not something we
    // pin down here, so the minor is what we record.
    react: '19.1.0',
    hermesDefault: true,
    newArchDefault: true,
    eol: false,
  },
}

/**
 * Look up what we know about an SDK major.
 *
 * Returns `null` for any major outside the table — including majors newer than
 * `LATEST_KNOWN_SDK`. Callers must treat `null` as "no opinion", never as a
 * problem with the project.
 */
export function getSdkInfo(major: number): SdkInfo | null {
  if (!Number.isInteger(major)) return null
  return SDK_TABLE[major] ?? null
}

/** True when `major` is past the top of our table, i.e. newer than we know. */
export function isNewerThanKnown(major: number): boolean {
  return Number.isInteger(major) && major > LATEST_KNOWN_SDK
}

/** Every SDK major recorded here, ascending. Useful for diagnostics. */
export function knownSdkMajors(): number[] {
  return Object.keys(SDK_TABLE)
    .map((key) => Number.parseInt(key, 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b)
}
