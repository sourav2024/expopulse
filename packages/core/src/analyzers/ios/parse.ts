/**
 * Shallow parsers for the iOS native project.
 *
 * DELIBERATELY SHALLOW. There is no plist library in the dependency tree and we
 * will not add one. An Expo-generated `Info.plist` is an XML plist written by a
 * template: a flat `<dict>` of `<key>` / value sibling pairs, with a couple of
 * nested dicts and arrays we handle explicitly. Scanning that structure with
 * regexes is reliable enough to drive findings, and cheap.
 *
 * What we do NOT handle, stated plainly so callers can weigh confidence:
 *   - Binary plists. A prebuilt Expo project's Info.plist is XML; if a binary
 *     one appears, parsing yields nothing and the layer reports nothing.
 *   - Arbitrary nesting. Only the specific nested keys named below are read.
 *   - `$(VARIABLE)` build-setting substitution. Values like
 *     `$(MARKETING_VERSION)` are returned verbatim, and rules that care must
 *     recognise them rather than treating them as literal strings.
 *
 * Every function here returns empty/null on anything unexpected and never
 * throws: a malformed native file must not fail an analysis run.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import fg from 'fast-glob'

/** One `NS*UsageDescription` entry found in Info.plist. */
export interface UsageDescription {
  /** The plist key, e.g. `NSCameraUsageDescription`. */
  key: string
  /** The declared purpose string, exactly as written (may be empty). */
  value: string
  /** 1-based line of the `<key>` element. */
  line: number
}

/** Facts extracted from Info.plist. */
export interface InfoPlistFacts {
  /** Project-relative path, POSIX separators. */
  file: string
  /** Every `NS*UsageDescription` key present, including empty ones. */
  usageDescriptions: UsageDescription[]
  /** Entries of the `UIBackgroundModes` array, with the array's line. */
  backgroundModes: { mode: string; line: number }[]
  /** `NSAppTransportSecurity` -> `NSAllowsArbitraryLoads`, null when absent. */
  allowsArbitraryLoads: boolean | null
  /** Line of the NSAppTransportSecurity dict, for pointing findings at it. */
  appTransportSecurityLine: number | null
  shortVersion: string | null
  bundleIdentifier: string | null
  /** True when `ITSAppUsesNonExemptEncryption` is declared at all. */
  hasEncryptionDeclaration: boolean
}

/** Facts extracted from the Podfile. */
export interface PodfileFacts {
  file: string
  /** Deployment target as written, e.g. `15.1`. Null when not a literal. */
  platformVersion: string | null
  line: number | null
}

/** Everything the iOS layer reads off disk. */
export interface IosNativeFacts {
  plist: InfoPlistFacts | null
  podfile: PodfileFacts | null
  /** True when ios/PrivacyInfo.xcprivacy exists. */
  hasPrivacyManifest: boolean
}

export const PRIVACY_MANIFEST_RELATIVE = 'ios/PrivacyInfo.xcprivacy'
export const PODFILE_RELATIVE = 'ios/Podfile'

async function readTextOrNull(absolutePath: string): Promise<string | null> {
  try {
    return await fs.readFile(absolutePath, 'utf8')
  } catch {
    return null
  }
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath)
    return true
  } catch {
    return false
  }
}

/** Blank out XML comments, preserving offsets so line numbers stay correct. */
function blankXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ' '))
}

/** 1-based line number of a character offset. */
function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++
  }
  return line
}

/**
 * Decode the five XML entities a plist can contain.
 *
 * Purpose strings routinely contain apostrophes and ampersands, and comparing
 * an un-decoded `&amp;` against a length threshold or a vagueness pattern gives
 * the wrong answer.
 */
function decodeEntities(text: string): string {
  return (
    text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // Ampersand last, so `&amp;lt;` does not become `<`.
      .replace(/&amp;/g, '&')
  )
}

/**
 * Locate a top-level `<key>NAME</key>` and return the offset just past it.
 *
 * A plist pairs a key with the sibling element that FOLLOWS it, which is why
 * every reader below works from this offset rather than matching a key and
 * value in one pattern.
 */
function findKeyEnd(xml: string, key: string): number | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<key>\\s*${escaped}\\s*</key>`).exec(xml)
  if (!match) return null
  return match.index + match[0].length
}

/** Offset of the `<key>` element itself, for line attribution. */
function findKeyStart(xml: string, key: string): number | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<key>\\s*${escaped}\\s*</key>`).exec(xml)
  return match ? match.index : null
}

/** Read the `<string>` value that follows a key. Null when it is another type. */
function readStringValue(xml: string, key: string): string | null {
  const start = findKeyEnd(xml, key)
  if (start === null) return null
  // Anchored at the key's end so we cannot skip past an intervening element and
  // pick up an unrelated string. Self-closing `<string/>` is a valid empty value.
  const match = /^\s*(?:<string>([\s\S]*?)<\/string>|<string\s*\/>)/.exec(xml.slice(start))
  if (!match) return null
  return decodeEntities(match[1] ?? '')
}

/** Read the `<true/>` / `<false/>` value following a key. */
function readBoolValue(xml: string, key: string): boolean | null {
  const start = findKeyEnd(xml, key)
  if (start === null) return null
  const match = /^\s*<(true|false)\s*\/>/.exec(xml.slice(start))
  if (!match) return null
  return match[1] === 'true'
}

/**
 * Extract every `NS*UsageDescription` key and its string value.
 *
 * Scanning for the key pattern rather than looking up a fixed list matters:
 * third-party config plugins add their own usage-description keys, and the
 * empty/vague checks should apply to those too.
 */
function readUsageDescriptions(xml: string): UsageDescription[] {
  const out: UsageDescription[] = []
  const seen = new Set<string>()
  // Apple's own keys are all NS*UsageDescription; this also catches the
  // NSLocation* family and NSUserTrackingUsageDescription.
  const pattern = /<key>\s*(NS\w*UsageDescription)\s*<\/key>/g

  for (let m = pattern.exec(xml); m !== null; m = pattern.exec(xml)) {
    const key = m[1]
    if (key === undefined || seen.has(key)) continue
    seen.add(key)

    const after = xml.slice(m.index + m[0].length)
    const valueMatch = /^\s*(?:<string>([\s\S]*?)<\/string>|<string\s*\/>)/.exec(after)
    out.push({
      key,
      // A key whose value is not a string at all is reported as empty, which is
      // the same user-visible failure: Apple sees no purpose string.
      value: valueMatch ? decodeEntities(valueMatch[1] ?? '') : '',
      line: lineAt(xml, m.index),
    })
  }
  return out
}

/** Extract the `UIBackgroundModes` array entries. */
function readBackgroundModes(xml: string): { mode: string; line: number }[] {
  const start = findKeyEnd(xml, 'UIBackgroundModes')
  if (start === null) return []

  // Bounded to the array's own extent so we cannot run on into later keys.
  const array = extractElementBody(xml, start, 'array')
  if (!array) return []

  const out: { mode: string; line: number }[] = []
  const entry = /<string>([\s\S]*?)<\/string>/g
  for (let m = entry.exec(array.body); m !== null; m = entry.exec(array.body)) {
    const mode = m[1]?.trim()
    if (!mode) continue
    out.push({ mode: decodeEntities(mode), line: lineAt(xml, array.bodyStart + m.index) })
  }
  return out
}

/**
 * Extract the body of a `<dict>`/`<array>` that begins at `offset`, respecting
 * nesting.
 *
 * A non-greedy `<dict>([\s\S]*?)</dict>` stops at the FIRST closing tag, which
 * truncates the body of any dict containing a nested one — so a depth counter is
 * required rather than a nicety. Returns null when the element is unbalanced.
 */
function extractElementBody(
  xml: string,
  offset: number,
  tag: 'dict' | 'array',
): { body: string; bodyStart: number } | null {
  const open = new RegExp(`^\\s*<${tag}>`).exec(xml.slice(offset))
  if (!open) return null

  const bodyStart = offset + open[0].length
  const scanner = new RegExp(`<(/?)${tag}(?:\\s*/)?>`, 'g')
  scanner.lastIndex = bodyStart

  let depth = 1
  for (let m = scanner.exec(xml); m !== null; m = scanner.exec(xml)) {
    // A self-closing `<dict/>` opens and closes at once; ignore it entirely.
    if (m[0].endsWith('/>')) continue
    depth += m[1] === '/' ? -1 : 1
    if (depth === 0) return { body: xml.slice(bodyStart, m.index), bodyStart }
  }
  return null
}

/**
 * Remove every nested `<dict>` and `<array>` from a dict body, leaving only the
 * key/value pairs that belong to that dict itself.
 *
 * This is what makes the ATS check correct: `NSAllowsArbitraryLoads` appears
 * both as the global switch AND inside each `NSExceptionDomains` entry, where it
 * means "for this one host". A localhost exception for the Expo dev server is
 * extremely common and legitimate, so mistaking it for the global switch would
 * fire a false security warning on a large share of real projects.
 */
function stripNestedContainers(body: string): string {
  let out = ''
  let depth = 0
  const scanner = /<(\/?)(dict|array)(?:\s*\/)?>/g
  let cursor = 0

  for (let m = scanner.exec(body); m !== null; m = scanner.exec(body)) {
    if (m[0].endsWith('/>')) continue
    if (m[1] === '/') {
      depth -= 1
      // Resume copying after the tag that returned us to the top level.
      if (depth === 0) cursor = m.index + m[0].length
    } else {
      if (depth === 0) out += body.slice(cursor, m.index)
      depth += 1
    }
  }
  if (depth === 0) out += body.slice(cursor)
  return out
}

/**
 * Read the GLOBAL `NSAppTransportSecurity` -> `NSAllowsArbitraryLoads` switch.
 *
 * Scoped to the ATS dict's own nesting level so per-domain exceptions are not
 * read as an app-wide ATS bypass.
 */
function readArbitraryLoads(xml: string): { value: boolean | null; line: number | null } {
  const keyStart = findKeyStart(xml, 'NSAppTransportSecurity')
  const start = findKeyEnd(xml, 'NSAppTransportSecurity')
  if (start === null || keyStart === null) return { value: null, line: null }

  const dict = extractElementBody(xml, start, 'dict')
  if (!dict) return { value: null, line: lineAt(xml, keyStart) }

  const topLevel = stripNestedContainers(dict.body)
  return { value: readBoolValue(topLevel, 'NSAllowsArbitraryLoads'), line: lineAt(xml, keyStart) }
}

/**
 * Find and parse `ios/<AppName>/Info.plist`.
 *
 * The app directory name is derived from the project name, so it must be
 * globbed. `ios/Pods/**` is excluded because vendored pods ship their own
 * Info.plist files and matching one of those would analyse the wrong app.
 * Depth is capped at the standard layout to avoid walking build output.
 */
export async function parseInfoPlist(root: string): Promise<InfoPlistFacts | null> {
  let matches: string[]
  try {
    matches = await fg('ios/*/Info.plist', {
      cwd: root,
      ignore: ['**/Pods/**', '**/build/**', '**/*.xcworkspace/**', '**/*.xcodeproj/**'],
      onlyFiles: true,
      dot: false,
      absolute: false,
    })
  } catch {
    return null
  }
  if (matches.length === 0) return null

  // Prefer the shortest path, then alphabetical: with a test target present
  // (`ios/AppTests/Info.plist`) this deterministically picks the app target.
  const chosen = [...matches].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
  if (chosen === undefined) return null

  const raw = await readTextOrNull(path.join(root, chosen))
  if (raw === null) return null

  // A binary plist starts with `bplist`; there is nothing regex-shaped to read.
  if (raw.startsWith('bplist')) return null

  const xml = blankXmlComments(raw)
  const ats = readArbitraryLoads(xml)

  return {
    file: chosen.split(path.sep).join('/'),
    usageDescriptions: readUsageDescriptions(xml),
    backgroundModes: readBackgroundModes(xml),
    allowsArbitraryLoads: ats.value,
    appTransportSecurityLine: ats.line,
    shortVersion: readStringValue(xml, 'CFBundleShortVersionString'),
    bundleIdentifier: readStringValue(xml, 'CFBundleIdentifier'),
    hasEncryptionDeclaration: findKeyStart(xml, 'ITSAppUsesNonExemptEncryption') !== null,
  }
}

/**
 * Parse the deployment target out of the Podfile.
 *
 * Matches `platform :ios, '15.1'` and the `podfile_properties`/variable-free
 * literal forms. Expo templates sometimes write
 * `platform :ios, podfile_properties['ios.deploymentTarget'] || '15.1'`, where
 * the trailing literal is the effective default — taking the last quoted version
 * on the line handles both shapes.
 */
export async function parsePodfile(root: string): Promise<PodfileFacts | null> {
  const raw = await readTextOrNull(path.join(root, PODFILE_RELATIVE))
  if (raw === null) return null

  // Drop `#` comments so a commented-out platform line is not read.
  const source = raw.replace(/#[^\n]*/g, (m) => ' '.repeat(m.length))
  const match = /^[ \t]*platform\s+:ios\s*,\s*([^\n]*)$/m.exec(source)
  if (!match?.[1]) return { file: PODFILE_RELATIVE, platformVersion: null, line: null }

  const tail = match[1]
  // Last quoted version wins — see the `||` fallback form above.
  const versions = [...tail.matchAll(/['"](\d+(?:\.\d+)*)['"]/g)]
  const last = versions.at(-1)?.[1] ?? null

  return {
    file: PODFILE_RELATIVE,
    platformVersion: last,
    line: lineAt(source, match.index),
  }
}

/** Collect every iOS native fact in one pass. */
export async function parseIosNative(root: string): Promise<IosNativeFacts> {
  const [plist, podfile, hasPrivacyManifest] = await Promise.all([
    parseInfoPlist(root),
    parsePodfile(root),
    exists(path.join(root, PRIVACY_MANIFEST_RELATIVE)),
  ])
  return { plist, podfile, hasPrivacyManifest }
}

/**
 * Compare two dotted version strings. Returns <0, 0 or >0.
 *
 * Written here rather than pulled from semver because iOS deployment targets are
 * frequently two-component (`15.1`), which is not valid semver.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10))
  const pb = b.split('.').map((n) => Number.parseInt(n, 10))
  const length = Math.max(pa.length, pb.length)
  for (let i = 0; i < length; i++) {
    const left = pa[i] ?? 0
    const right = pb[i] ?? 0
    if (!Number.isFinite(left) || !Number.isFinite(right)) return 0
    if (left !== right) return left - right
  }
  return 0
}
