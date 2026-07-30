import type { FindingDraft, Rule } from '../../shared/types.js'
import type { IosModel } from './index.js'
import { compareVersions } from './parse.js'

/**
 * Minimum iOS version worth targeting.
 *
 * MAINTENANCE: tracks the floor recent Expo SDKs set for new projects. Because
 * this rule is only `info`, lagging behind reality is harmless.
 */
const MIN_DEPLOYMENT_TARGET = '15.1'

/** Purpose strings shorter than this cannot describe a specific use. */
const MIN_PURPOSE_LENGTH = 15

/**
 * Vague openers Apple's reviewers reject. Matching the START of the string is
 * deliberate: "We need access to your camera" is boilerplate, whereas "Photos
 * you attach to a report need camera access" happens to contain "need" but does
 * explain the purpose.
 */
const VAGUE_PURPOSE = /^(we need|this app needs|required|for app|permission)/i

/** A permission a dependency implies, and the plist keys Apple requires for it. */
interface CapabilityRequirement {
  /** Info.plist keys that must be present and non-empty. */
  keys: string[]
  /** What the dependency does, quoted in the finding message. */
  reason: string
}

/**
 * Dependency -> required Info.plist purpose strings.
 *
 * CURATED, not exhaustive. Only mappings where the dependency's presence very
 * strongly implies the permission are listed, because this rule is an `error`
 * and a false positive here sends someone chasing a non-problem before a
 * release. Packages whose permission use is genuinely optional are omitted.
 *
 * Note `expo-notifications` is intentionally absent: push permission is
 * requested at runtime through UNUserNotificationCenter and needs no plist
 * purpose string, so requiring one would be wrong.
 */
const CAPABILITY_MAP: Readonly<Record<string, CapabilityRequirement>> = {
  'expo-camera': { keys: ['NSCameraUsageDescription'], reason: 'captures photo or video' },
  'react-native-vision-camera': {
    keys: ['NSCameraUsageDescription'],
    reason: 'captures photo or video',
  },
  'expo-location': {
    keys: ['NSLocationWhenInUseUsageDescription'],
    reason: 'reads the device location',
  },
  'expo-image-picker': {
    // The picker can reach both the library and the camera, and Apple requires
    // the string for whichever path the user takes.
    keys: ['NSPhotoLibraryUsageDescription', 'NSCameraUsageDescription'],
    reason: 'opens the photo library and camera',
  },
  'expo-media-library': {
    keys: ['NSPhotoLibraryUsageDescription'],
    reason: 'reads or writes the photo library',
  },
  'expo-av': { keys: ['NSMicrophoneUsageDescription'], reason: 'records audio' },
  'expo-audio': { keys: ['NSMicrophoneUsageDescription'], reason: 'records audio' },
  'expo-contacts': { keys: ['NSContactsUsageDescription'], reason: 'reads the contact list' },
  'expo-calendar': { keys: ['NSCalendarsUsageDescription'], reason: 'reads or writes calendars' },
  'expo-tracking-transparency': {
    keys: ['NSUserTrackingUsageDescription'],
    reason: 'requests App Tracking Transparency authorisation',
  },
}

/**
 * Background modes mapped to the dependencies that would justify them.
 *
 * Used only by an `info`-level heuristic rule: a mode can legitimately be driven
 * by hand-written native code or a package not listed here.
 */
const BACKGROUND_MODE_JUSTIFICATIONS: Readonly<Record<string, string[]>> = {
  location: ['expo-location', 'expo-task-manager', 'react-native-background-geolocation'],
  fetch: ['expo-background-fetch', 'expo-task-manager', 'expo-updates'],
  audio: ['expo-av', 'expo-audio', 'expo-video', 'react-native-track-player'],
  'remote-notification': ['expo-notifications', '@react-native-firebase/messaging'],
  processing: ['expo-task-manager', 'expo-background-task'],
  voip: ['react-native-callkeep'],
  'bluetooth-central': ['react-native-ble-plx', 'expo-bluetooth'],
}

/** Modes worth commenting on. Others are too specialised to guess about. */
const REVIEWED_BACKGROUND_MODES = new Set(['location', 'fetch', 'audio', 'processing'])

const missingUsageDescription: Rule<IosModel> = {
  meta: {
    id: 'ios/missing-usage-description',
    category: 'ios',
    severity: 'error',
    description: 'A dependency requires an Info.plist usage description that is not declared.',
    rationale:
      'iOS terminates the app the moment it requests a permission whose purpose string is ' +
      'missing from Info.plist, and App Review checks for this before the app ever runs. ' +
      'This is a hard App Store rejection, and because it only manifests on the code path ' +
      'that asks for the permission, it commonly ships undetected.',
    recommendation:
      'Add the missing key to ios/<App>/Info.plist with a specific sentence naming the ' +
      'feature that needs it. For a managed workflow, set it via the config plugin’s ios ' +
      'infoPlist section in app.json so prebuild regenerates it.',
  },

  check(model): FindingDraft[] {
    const { plist, dependencies } = model
    if (!plist) return []

    // Keys already declared with a usable value. An empty string counts as
    // present here — `ios/empty-usage-description` owns that failure, and
    // reporting both for one key would double-count it.
    const declared = new Set(plist.usageDescriptions.map((entry) => entry.key))

    const findings: FindingDraft[] = []
    // A key can be required by several deps (camera via expo-camera AND
    // expo-image-picker); report each missing key once, naming every requester.
    const missing = new Map<string, { deps: string[]; reasons: string[] }>()

    for (const [dep, requirement] of Object.entries(CAPABILITY_MAP)) {
      if (!dependencies.has(dep)) continue
      for (const key of requirement.keys) {
        if (declared.has(key)) continue
        const entry = missing.get(key)
        if (entry) {
          entry.deps.push(dep)
          entry.reasons.push(requirement.reason)
        } else {
          missing.set(key, { deps: [dep], reasons: [requirement.reason] })
        }
      }
    }

    for (const [key, { deps, reasons }] of missing) {
      const who = deps.join(', ')
      // Any one requester's reason explains the key; the first is as good as any.
      const why = reasons[0] ?? 'uses the corresponding device capability'
      findings.push({
        message:
          `${key} is missing from Info.plist but ${who} ${deps.length > 1 ? 'are' : 'is'} ` +
          `installed and ${why}. iOS will crash the app when the permission is ` +
          'requested, and App Review rejects the build.',
        file: plist.file,
        data: { key, dependencies: deps },
      })
    }
    return findings
  },
}

const emptyUsageDescription: Rule<IosModel> = {
  meta: {
    id: 'ios/empty-usage-description',
    category: 'ios',
    severity: 'error',
    description: 'An Info.plist usage description key is present but its value is empty.',
    rationale:
      'An empty purpose string is treated the same as a missing one: iOS shows the user a ' +
      'permission prompt with no explanation, and App Review rejects the submission. This ' +
      'is a frequent artefact of a config plugin writing a key with no value supplied.',
    recommendation:
      'Give the key a specific sentence naming the feature that needs the permission and ' +
      'what the user gets from granting it.',
  },

  check(model): FindingDraft[] {
    const { plist } = model
    if (!plist) return []

    return plist.usageDescriptions
      .filter((entry) => entry.value.trim().length === 0)
      .map((entry) => ({
        message: `${entry.key} is declared with an empty value; Apple rejects blank purpose strings.`,
        file: plist.file,
        location: { line: entry.line },
        excerpt: `<key>${entry.key}</key><string></string>`,
        data: { key: entry.key },
      }))
  },
}

const genericUsageDescription: Rule<IosModel> = {
  meta: {
    id: 'ios/generic-usage-description',
    category: 'ios',
    severity: 'warning',
    description: 'An Info.plist usage description is too vague to satisfy App Review.',
    rationale:
      'Apple’s guidelines require the purpose string to explain what the app does with the ' +
      'data, not merely restate that it wants access. Boilerplate like "We need camera ' +
      'access" is a documented and common rejection reason, and the string is also the only ' +
      'context the user gets when deciding whether to allow the prompt.',
    recommendation:
      'Rewrite the string to name the feature and the benefit, e.g. "Photos you attach to a ' +
      'maintenance report are uploaded with the ticket."',
  },

  check(model): FindingDraft[] {
    const { plist } = model
    if (!plist) return []

    const findings: FindingDraft[] = []
    for (const entry of plist.usageDescriptions) {
      const value = entry.value.trim()
      // Empty is a different, more severe rule's business.
      if (value.length === 0) continue

      const tooShort = value.length < MIN_PURPOSE_LENGTH
      const boilerplate = VAGUE_PURPOSE.test(value)
      if (!tooShort && !boilerplate) continue

      const why = tooShort
        ? `it is only ${value.length} characters, too short to describe a specific use`
        : 'it opens with boilerplate that restates the request instead of explaining the use'

      findings.push({
        message: `${entry.key} is too vague for App Review: ${why}.`,
        file: plist.file,
        location: { line: entry.line },
        excerpt: value,
        data: { key: entry.key, value, tooShort, boilerplate },
      })
    }
    return findings
  },
}

const missingPrivacyManifest: Rule<IosModel> = {
  meta: {
    id: 'ios/missing-privacy-manifest',
    category: 'ios',
    severity: 'warning',
    description: 'ios/PrivacyInfo.xcprivacy is absent.',
    rationale:
      'Apple requires a privacy manifest declaring an approved reason for every ' +
      '"required reason API" the app or its SDKs call — file timestamps, disk space, ' +
      'UserDefaults and more. React Native and common Expo modules use several of these, ' +
      'so submissions without the manifest draw an automated email from App Store Connect ' +
      'and can be rejected.',
    recommendation:
      'Add ios/PrivacyInfo.xcprivacy declaring your required-reason API usage and any data ' +
      'collected. Recent Expo SDKs generate one during prebuild — upgrading and re-running ' +
      'prebuild is usually the least effort.',
  },

  check(model): FindingDraft[] {
    if (model.hasPrivacyManifest) return []

    return [
      {
        message:
          'No PrivacyInfo.xcprivacy privacy manifest was found in ios/; Apple requires one ' +
          'for apps using required-reason APIs.',
        file: 'ios/',
      },
    ]
  },
}

const arbitraryLoadsEnabled: Rule<IosModel> = {
  meta: {
    id: 'ios/arbitrary-loads-enabled',
    category: 'ios',
    severity: 'warning',
    description: 'NSAllowsArbitraryLoads is true, disabling App Transport Security.',
    rationale:
      'This switches off ATS for the entire app, so any request that falls back to HTTP is ' +
      'sent in plaintext. Apple also asks for a justification for a global ATS exemption ' +
      'during review, and a weak one is a rejection risk.',
    recommendation:
      'Remove NSAllowsArbitraryLoads and, where a specific host genuinely cannot do HTTPS, ' +
      'add a narrow NSExceptionDomains entry for just that host. Expo dev builds only need ' +
      'the exemption in debug, not in the release configuration.',
  },

  check(model): FindingDraft[] {
    const { plist } = model
    if (!plist || plist.allowsArbitraryLoads !== true) return []

    return [
      {
        message: 'App Transport Security is disabled app-wide via NSAllowsArbitraryLoads.',
        file: plist.file,
        location:
          plist.appTransportSecurityLine !== null
            ? { line: plist.appTransportSecurityLine }
            : undefined,
        excerpt: '<key>NSAllowsArbitraryLoads</key><true/>',
      },
    ]
  },
}

const backgroundModeUnjustified: Rule<IosModel> = {
  meta: {
    id: 'ios/background-mode-unjustified',
    category: 'ios',
    severity: 'info',
    description: 'A UIBackgroundModes entry has no obviously corresponding dependency.',
    rationale:
      'App Review scrutinises background modes closely and rejects apps that declare one ' +
      'without demonstrable background functionality; unused modes also let iOS wake the ' +
      'app and spend battery for nothing. This check is a HEURISTIC: it compares the ' +
      'declared modes against a curated list of packages that typically justify them, so a ' +
      'mode implemented in hand-written native code or via an unlisted package will be ' +
      'flagged even though it is legitimate.',
    recommendation:
      'Remove any background mode the app does not actually use. If the mode is implemented ' +
      'by custom native code or a package this check does not know about, treat the finding ' +
      'as a false positive and disable the rule for the project.',
  },

  check(model): FindingDraft[] {
    const { plist, dependencies } = model
    if (!plist) return []

    const findings: FindingDraft[] = []
    for (const { mode, line } of plist.backgroundModes) {
      if (!REVIEWED_BACKGROUND_MODES.has(mode)) continue

      const candidates = BACKGROUND_MODE_JUSTIFICATIONS[mode] ?? []
      // No known justifier at all means we have no basis for an opinion.
      if (candidates.length === 0) continue
      if (candidates.some((dep) => dependencies.has(dep))) continue

      findings.push({
        message:
          `UIBackgroundModes declares '${mode}' but no dependency that typically requires ` +
          `it is installed (looked for ${candidates.join(', ')}).`,
        file: plist.file,
        location: { line },
        excerpt: `<string>${mode}</string>`,
        data: { mode, expectedAnyOf: candidates },
      })
    }
    return findings
  },
}

const missingEncryptionDeclaration: Rule<IosModel> = {
  meta: {
    id: 'ios/missing-encryption-declaration',
    category: 'ios',
    severity: 'info',
    description: 'ITSAppUsesNonExemptEncryption is not declared in Info.plist.',
    rationale:
      'Without this key, App Store Connect asks about export compliance on every single ' +
      'build, which blocks TestFlight distribution until someone answers the form by hand. ' +
      'Declaring it in Info.plist answers the question once, at build time.',
    recommendation:
      'Add ITSAppUsesNonExemptEncryption to Info.plist — false for the common case of an app ' +
      'that only uses HTTPS and standard platform crypto, true if you ship your own ' +
      'non-exempt encryption and have the required documentation.',
  },

  check(model): FindingDraft[] {
    const { plist } = model
    if (!plist || plist.hasEncryptionDeclaration) return []

    return [
      {
        message:
          'ITSAppUsesNonExemptEncryption is missing, so every TestFlight upload requires ' +
          'answering the export-compliance question manually.',
        file: plist.file,
      },
    ]
  },
}

const deploymentTargetLow: Rule<IosModel> = {
  meta: {
    id: 'ios/deployment-target-low',
    category: 'ios',
    severity: 'info',
    description: `The Podfile iOS deployment target is below ${MIN_DEPLOYMENT_TARGET}.`,
    rationale:
      'Recent Expo SDK and React Native releases set a higher floor, and current versions of ' +
      'many pods refuse to build below it. A stale target usually means the Podfile was not ' +
      'regenerated after an SDK upgrade.',
    recommendation:
      `Raise the platform line in ios/Podfile to ${MIN_DEPLOYMENT_TARGET} or higher, or set ` +
      'ios.deploymentTarget via expo-build-properties so prebuild manages it.',
  },

  check(model): FindingDraft[] {
    const { podfile } = model
    // Null version means the value is an unresolved expression, not a low target.
    if (!podfile?.platformVersion) return []
    if (compareVersions(podfile.platformVersion, MIN_DEPLOYMENT_TARGET) >= 0) return []

    return [
      {
        message:
          `ios/Podfile targets iOS ${podfile.platformVersion}, below the recommended ` +
          `minimum of ${MIN_DEPLOYMENT_TARGET}.`,
        file: podfile.file,
        location: podfile.line !== null ? { line: podfile.line } : undefined,
        excerpt: `platform :ios, '${podfile.platformVersion}'`,
        data: { platformVersion: podfile.platformVersion, recommended: MIN_DEPLOYMENT_TARGET },
      },
    ]
  },
}

/** Every rule the iOS layer contributes, in report order. */
export const iosRules: Rule<IosModel>[] = [
  missingUsageDescription,
  emptyUsageDescription,
  genericUsageDescription,
  arbitraryLoadsEnabled,
  missingPrivacyManifest,
  missingEncryptionDeclaration,
  backgroundModeUnjustified,
  deploymentTargetLow,
]
