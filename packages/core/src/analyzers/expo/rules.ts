import type { FindingDraft, Rule } from '../../shared/types.js'
import { truncate } from '../../shared/utils.js'
import { type ExpoModel, assetExists, get, getObject, getString, pluginNames } from './index.js'
import { LATEST_KNOWN_SDK, confidence, isNewerThanKnown } from './sdk.js'

/** Findings about app config point here; findings about builds point at eas.json. */
const APP_CONFIG_FILE = 'app.json'
const EAS_FILE = 'eas.json'

/**
 * Config plugins that ship inside the `expo` package itself and therefore have
 * no standalone entry in package.json.
 *
 * This list is the safety valve for `expo/orphaned-config-plugin`: a plugin name
 * we cannot resolve to a dependency is only reported when it is *also* not one
 * of these. Being conservative matters because the false positive here tells a
 * user to install a package they must not install.
 */
const BUILTIN_PLUGINS = new Set([
  'expo-router',
  'expo-asset',
  'expo-constants',
  'expo-file-system',
  'expo-font',
  'expo-keep-awake',
  'expo-splash-screen',
])

/**
 * True for plugin entries that name a file rather than a package.
 *
 * A local plugin (`./plugins/withFoo`) has no package.json entry by design, so
 * comparing it against the dependency list would always produce a false hit.
 */
function isLocalPluginPath(name: string): boolean {
  return name.startsWith('.') || name.startsWith('/')
}

/**
 * Map a plugin entry to the package.json key that would provide it.
 *
 * Plugins are often referenced by a deep path (`expo-notifications/plugin`) or
 * by a scoped package (`@sentry/react-native`), but the dependency key is the
 * package root in both cases.
 */
function pluginPackageName(name: string): string {
  const parts = name.split('/')
  const first = parts[0]
  if (first === undefined) return name

  if (first.startsWith('@')) {
    const second = parts[1]
    return second === undefined ? name : `${first}/${second}`
  }
  return first
}

/** `major.minor` of a semver-ish range, ignoring `~`/`^`/`>=` noise. */
function majorMinor(range: string | null): string | null {
  if (!range) return null
  const match = /(\d+)\.(\d+)/.exec(range)
  if (!match?.[1] || !match[2]) return null
  return `${match[1]}.${match[2]}`
}

/** True when `updates.url` is configured, i.e. the project actually uses OTA. */
function hasUpdatesUrl(model: ExpoModel): boolean {
  return getString(model.config, 'updates.url') !== null
}

// ---------------------------------------------------------------------------
// SDK / version rules
// ---------------------------------------------------------------------------

const sdkEol: Rule<ExpoModel> = {
  meta: {
    id: 'expo/sdk-eol',
    category: 'expo',
    severity: 'error',
    description: 'Project targets an Expo SDK that is no longer supported',
    rationale:
      'Expo supports roughly the latest three SDKs. Once an SDK falls out of ' +
      'that window it stops receiving security patches, EAS Build images are ' +
      'eventually retired, and the app store toolchains it pins drift out of ' +
      'compliance with Apple and Google submission requirements.',
    recommendation:
      'Upgrade to a supported SDK with `npx expo install expo@latest` followed ' +
      'by `npx expo install --fix`, then work through the release notes for ' +
      'each intervening SDK.',
  },

  check(model) {
    const { sdkMajor, sdk } = model
    // Unknown major: nothing to say. Newer than our table: the project is ahead
    // of this tool, which is never the project's fault.
    if (sdkMajor === null) return []
    if (isNewerThanKnown(sdkMajor)) return []
    if (!sdk || !sdk.eol) return []

    return [
      {
        message: `Expo SDK ${sdkMajor} is no longer supported`,
        file: APP_CONFIG_FILE,
        excerpt: `sdkVersion: ${sdkMajor}`,
        data: { sdkMajor, latestKnownSdk: LATEST_KNOWN_SDK, confidence },
      },
    ]
  },
}

const reactNativeVersionMismatch: Rule<ExpoModel> = {
  meta: {
    id: 'expo/react-native-version-mismatch',
    category: 'expo',
    severity: 'error',
    description: 'react-native version does not match the one the Expo SDK expects',
    rationale:
      'Each Expo SDK is built and tested against exactly one React Native ' +
      'minor. A mismatch produces failures that look unrelated to versioning: ' +
      'native modules that fail to link, red-screen bridge errors at runtime, ' +
      'and prebuild output that does not compile.',
    recommendation:
      'Run `npx expo install --fix` to realign every Expo-managed dependency ' +
      'with the SDK you are on.',
  },

  check(model) {
    const expected = majorMinor(model.sdk?.reactNative ?? null)
    const actual = majorMinor(model.reactNativeRange)
    // Either side unknown means we have no basis for a claim.
    if (!expected || !actual || expected === actual) return []

    return [
      {
        message: `react-native ${actual} does not match Expo SDK ${model.sdkMajor}'s expected ${expected}`,
        file: 'package.json',
        excerpt: truncate(`"react-native": "${model.reactNativeRange ?? ''}"`),
        data: { expected, actual, sdkMajor: model.sdkMajor, confidence },
      },
    ]
  },
}

const reactVersionMismatch: Rule<ExpoModel> = {
  meta: {
    id: 'expo/react-version-mismatch',
    category: 'expo',
    severity: 'error',
    description: 'react version does not match the one the Expo SDK expects',
    rationale:
      'React and React Native renderers are versioned together. Pairing a ' +
      'React major the SDK was not built against breaks hooks dispatch and ' +
      'reconciliation in ways that surface as invalid-hook-call errors far ' +
      'from the actual cause.',
    recommendation:
      'Run `npx expo install --fix` rather than pinning react by hand; the ' +
      'SDK decides this version.',
  },

  check(model) {
    const expected = majorMinor(model.sdk?.react ?? null)
    const actual = majorMinor(model.reactRange)
    if (!expected || !actual || expected === actual) return []

    return [
      {
        message: `react ${actual} does not match Expo SDK ${model.sdkMajor}'s expected ${expected}`,
        file: 'package.json',
        excerpt: truncate(`"react": "${model.reactRange ?? ''}"`),
        data: { expected, actual, sdkMajor: model.sdkMajor, confidence },
      },
    ]
  },
}

const hermesNotEnabled: Rule<ExpoModel> = {
  meta: {
    id: 'expo/hermes-not-enabled',
    category: 'expo',
    severity: 'warning',
    description: 'jsEngine is set to jsc on an SDK where Hermes is the default',
    rationale:
      'Hermes precompiles JavaScript to bytecode at build time, so the engine ' +
      'skips parsing and compiling the bundle on every cold start. That ' +
      'typically cuts startup time noticeably and lowers peak memory versus ' +
      'JSC, and it is what Expo tests against by default. Opting back into JSC ' +
      'gives up those wins and puts the app on the less-exercised path.',
    recommendation:
      'Remove the `jsEngine: "jsc"` override so the SDK default (Hermes) ' +
      'applies, unless a specific dependency documents a JSC requirement.',
  },

  check(model) {
    if (!model.sdk?.hermesDefault) return []

    const isJsc = (value: string | null): boolean => value?.toLowerCase() === 'jsc'

    // A platform block can opt out on its own, so check each site rather than
    // only the top-level key. Only an explicit "jsc" counts — an absent value
    // means the SDK default (Hermes) applies and there is nothing to report.
    const sites = ['jsEngine', 'ios.jsEngine', 'android.jsEngine']
    const offending = sites.filter((site) => isJsc(getString(model.config, site)))
    if (offending.length === 0) return []

    return offending.map((site) => ({
      message: `${site} is set to "jsc"; Hermes is the default for this SDK`,
      file: APP_CONFIG_FILE,
      excerpt: `${site}: "jsc"`,
      data: { sdkMajor: model.sdkMajor, field: site },
    }))
  },
}

const newArchNotEnabled: Rule<ExpoModel> = {
  meta: {
    id: 'expo/new-arch-not-enabled',
    category: 'expo',
    severity: 'info',
    description: 'New Architecture is available on this SDK but not enabled',
    rationale:
      'The New Architecture (Fabric renderer and TurboModules) is the default ' +
      'for new projects on this SDK and is where React Native development is ' +
      'heading. Migrating an existing app is real work: third-party native ' +
      'modules need New-Architecture-compatible releases, and some patterns ' +
      'behave differently. This is informational context for planning, not a ' +
      'defect.',
    recommendation:
      'When your native dependencies support it, set `newArchEnabled: true` ' +
      'and test on both platforms. There is no urgency if your dependencies ' +
      'are not ready.',
  },

  check(model) {
    if (!model.sdk?.newArchDefault) return []

    const value = get(model.config, 'newArchEnabled')
    if (value === true) return []

    return [
      {
        message: `New Architecture is not enabled (default on Expo SDK ${model.sdkMajor})`,
        file: APP_CONFIG_FILE,
        excerpt:
          value === undefined ? 'newArchEnabled: (unset)' : `newArchEnabled: ${String(value)}`,
        data: { sdkMajor: model.sdkMajor, current: value ?? null },
      },
    ]
  },
}

// ---------------------------------------------------------------------------
// Updates / OTA rules
// ---------------------------------------------------------------------------

const missingRuntimeVersion: Rule<ExpoModel> = {
  meta: {
    id: 'expo/missing-runtime-version',
    category: 'expo',
    severity: 'warning',
    description: 'expo-updates is configured but no runtimeVersion is set',
    rationale:
      'runtimeVersion is the compatibility contract between a JS update and ' +
      'the native binary that runs it. Without it, an update built after you ' +
      'add a native module, bump the SDK, or change a config plugin can still ' +
      'be handed to an older installed binary that lacks that native code — ' +
      'the JS calls into a module that is not there and the app crashes on ' +
      'launch for users who already updated. Because the crash happens before ' +
      'your code can recover, the only remedy is shipping a new store build.',
    recommendation:
      'Set `runtimeVersion: { "policy": "appVersion" }` (or "fingerprint" for ' +
      'the strictest native-change detection) so updates are only delivered to ' +
      'binaries they are compatible with.',
  },

  check(model) {
    if (!hasUpdatesUrl(model)) return []

    const runtime = get(model.config, 'runtimeVersion')
    if (runtime !== undefined && runtime !== null && runtime !== '') return []

    return [
      {
        message: 'updates.url is configured but runtimeVersion is not set',
        file: APP_CONFIG_FILE,
        excerpt: truncate(`updates.url: ${getString(model.config, 'updates.url') ?? ''}`),
      },
    ]
  },
}

const updatesWithoutFallback: Rule<ExpoModel> = {
  meta: {
    id: 'expo/updates-without-fallback',
    category: 'expo',
    severity: 'info',
    description: 'expo-updates is configured without an explicit fallbackToCacheTimeout',
    rationale:
      'fallbackToCacheTimeout bounds how long launch blocks while fetching an ' +
      'update before falling back to the cached bundle. Leaving it implicit ' +
      'means startup behaviour on a slow or captive network is decided by the ' +
      'default rather than by you.',
    recommendation:
      'Set `updates.fallbackToCacheTimeout` deliberately — a small value (or 0 ' +
      'with `checkAutomatically: "ON_ERROR_RECOVERY"`) keeps cold starts fast.',
  },

  check(model) {
    if (!hasUpdatesUrl(model)) return []

    const updates = getObject(model.config, 'updates')
    if (!updates) return []
    if (updates.fallbackToCacheTimeout !== undefined) return []

    return [
      {
        message: 'updates is configured without fallbackToCacheTimeout',
        file: APP_CONFIG_FILE,
        excerpt: 'updates.fallbackToCacheTimeout: (unset)',
      },
    ]
  },
}

// ---------------------------------------------------------------------------
// Branding / asset rules
// ---------------------------------------------------------------------------

const missingIcon: Rule<ExpoModel> = {
  meta: {
    id: 'expo/missing-icon',
    category: 'expo',
    severity: 'warning',
    description: 'No app icon is configured',
    rationale:
      'Without an `icon` the build falls back to a generic placeholder, which ' +
      'both app stores reject at review and which users see on their home ' +
      'screen in the meantime.',
    recommendation:
      'Add `icon: "./assets/icon.png"` pointing at a square 1024x1024 PNG with ' +
      'no transparency and no rounded corners.',
  },

  check(model) {
    // No app config at all (eas.json-only project) means nothing to assert.
    if (!model.config) return []
    if (getString(model.config, 'icon')) return []

    return [{ message: 'No app icon configured', file: APP_CONFIG_FILE }]
  },
}

const missingSplash: Rule<ExpoModel> = {
  meta: {
    id: 'expo/missing-splash',
    category: 'expo',
    severity: 'info',
    description: 'No splash screen is configured',
    rationale:
      'The window between process start and first render shows a blank screen ' +
      'without a splash configuration. A splash image makes that gap read as ' +
      'loading rather than as a hang.',
    recommendation:
      'Add a `splash` block, or configure the `expo-splash-screen` config ' +
      'plugin, which is the supported path on recent SDKs.',
  },

  check(model) {
    if (!model.config) return []

    if (getObject(model.config, 'splash')) return []
    // The expo-splash-screen plugin configures this instead of the legacy key.
    if (pluginNames(model.config).some((name) => name.includes('expo-splash-screen'))) return []

    return [{ message: 'No splash screen configured', file: APP_CONFIG_FILE }]
  },
}

const missingAndroidAdaptiveIcon: Rule<ExpoModel> = {
  meta: {
    id: 'expo/missing-android-adaptive-icon',
    category: 'expo',
    severity: 'warning',
    description: 'No android.adaptiveIcon.foregroundImage is configured',
    rationale:
      'Android has required adaptive icons since API 26. Without a foreground ' +
      'layer the launcher scales and masks the legacy square icon, producing a ' +
      'letterboxed or cropped result that looks broken next to every other app ' +
      'and undermines the Play Store listing.',
    recommendation:
      'Add `android.adaptiveIcon.foregroundImage` (a 1024x1024 PNG with the ' +
      'artwork inside the safe zone) plus a `backgroundColor` or ' +
      '`backgroundImage`.',
  },

  check(model) {
    if (!model.config) return []
    if (getString(model.config, 'android.adaptiveIcon.foregroundImage')) return []

    return [
      {
        message: 'No Android adaptive icon foreground image configured',
        file: APP_CONFIG_FILE,
      },
    ]
  },
}

const referencedAssetMissing: Rule<ExpoModel> = {
  meta: {
    id: 'expo/referenced-asset-missing',
    category: 'expo',
    severity: 'error',
    description: 'A file referenced by the Expo config does not exist on disk',
    rationale:
      'Expo resolves these paths relative to the project root at build time. A ' +
      'path that does not exist fails prebuild or the EAS build rather than ' +
      'degrading gracefully, so a typo here costs a full build cycle to find.',
    recommendation:
      'Correct the path or add the missing file. Paths are relative to the ' +
      'directory containing app.json.',
  },

  check(model) {
    if (!model.config) return []

    // Covers adaptiveIcon and the other single-file image fields; `icon` has its
    // own rule so it can carry a build-blocking message of its own.
    const fields = [
      'android.adaptiveIcon.foregroundImage',
      'android.adaptiveIcon.backgroundImage',
      'android.icon',
      'ios.icon',
      'splash.image',
      'android.splash.image',
      'ios.splash.image',
      'notification.icon',
      'web.favicon',
    ]

    const findings: FindingDraft[] = []
    for (const field of fields) {
      const value = getString(model.config, field)
      if (!value) continue
      if (assetExists(model.root, value)) continue

      findings.push({
        message: `${field} points at "${value}", which does not exist`,
        file: APP_CONFIG_FILE,
        excerpt: truncate(`${field}: ${value}`),
        data: { field, assetPath: value },
      })
    }
    return findings
  },
}

const iconFileMissing: Rule<ExpoModel> = {
  meta: {
    id: 'expo/icon-file-missing',
    category: 'expo',
    severity: 'error',
    description: 'The file referenced by `icon` does not exist on disk',
    rationale:
      'A missing icon path is not ignored — prebuild and EAS Build fail when ' +
      'they cannot read it. This is one of the most common causes of a build ' +
      'that worked locally failing in CI, because the asset was never ' +
      'committed.',
    recommendation:
      'Fix the `icon` path or commit the referenced file. Confirm the asset is ' +
      'not covered by .gitignore or .easignore.',
  },

  check(model) {
    if (!model.config) return []

    const icon = getString(model.config, 'icon')
    if (!icon) return []
    if (assetExists(model.root, icon)) return []

    return [
      {
        message: `icon points at "${icon}", which does not exist`,
        file: APP_CONFIG_FILE,
        excerpt: truncate(`icon: ${icon}`),
        data: { assetPath: icon },
      },
    ]
  },
}

// ---------------------------------------------------------------------------
// Native identity rules
// ---------------------------------------------------------------------------

const missingBundleIdentifier: Rule<ExpoModel> = {
  meta: {
    id: 'expo/missing-bundle-identifier',
    category: 'expo',
    severity: 'error',
    description: 'No ios.bundleIdentifier is configured',
    rationale:
      'The bundle identifier is the immutable identity of the iOS app: ' +
      'provisioning profiles, push certificates, App Store records and ' +
      'keychain access are all keyed to it. Without one, iOS builds cannot be ' +
      'produced at all.',
    recommendation:
      'Set `ios.bundleIdentifier` to a reverse-DNS string you control, e.g. ' +
      '"com.yourcompany.yourapp". Choose it carefully: changing it later means ' +
      'a new App Store listing.',
  },

  check(model) {
    if (!model.config) return []
    if (getString(model.config, 'ios.bundleIdentifier')) return []

    return [
      {
        message: 'No ios.bundleIdentifier configured; iOS builds will fail',
        file: APP_CONFIG_FILE,
      },
    ]
  },
}

const missingAndroidPackage: Rule<ExpoModel> = {
  meta: {
    id: 'expo/missing-android-package',
    category: 'expo',
    severity: 'error',
    description: 'No android.package is configured',
    rationale:
      "The Android package name is the app's permanent identity on Google " +
      'Play and cannot be changed after the first release. Builds cannot be ' +
      'produced without it.',
    recommendation:
      'Set `android.package` to a reverse-DNS string you control, e.g. ' +
      '"com.yourcompany.yourapp".',
  },

  check(model) {
    if (!model.config) return []
    if (getString(model.config, 'android.package')) return []

    return [
      { message: 'No android.package configured; Android builds will fail', file: APP_CONFIG_FILE },
    ]
  },
}

const missingSchemeWithRouter: Rule<ExpoModel> = {
  meta: {
    id: 'expo/missing-scheme-with-router',
    category: 'expo',
    severity: 'warning',
    description: 'expo-router is installed but no URL scheme is configured',
    rationale:
      "expo-router builds deep links on top of the app's custom URL scheme. " +
      'Without a `scheme`, links into the app do not resolve in standalone ' +
      'builds, which breaks OAuth redirects, password-reset emails, push ' +
      'notification tap targets and share sheets — all of which work in Expo ' +
      'Go, so the failure only appears after a real build.',
    recommendation:
      'Set `scheme: "yourapp"` in the Expo config, then rebuild — the scheme is ' +
      'baked into the native project.',
  },

  check(model) {
    if (!model.config) return []
    if (!model.dependencies.has('expo-router')) return []

    const scheme = get(model.config, 'scheme')
    // `scheme` accepts a string or an array of strings; either is sufficient.
    if (typeof scheme === 'string' && scheme.trim().length > 0) return []
    if (Array.isArray(scheme) && scheme.some((s) => typeof s === 'string' && s.trim().length > 0)) {
      return []
    }

    return [
      {
        message: 'expo-router is a dependency but no scheme is set; deep links will not resolve',
        file: APP_CONFIG_FILE,
      },
    ]
  },
}

// ---------------------------------------------------------------------------
// Bundling / plugins
// ---------------------------------------------------------------------------

const assetBundlePatternsBroad: Rule<ExpoModel> = {
  meta: {
    id: 'expo/asset-bundle-patterns-broad',
    category: 'expo',
    severity: 'info',
    description: 'assetBundlePatterns matches every file in the project',
    rationale:
      'A pattern of `**/*` embeds every asset in the binary, including ones no ' +
      'screen ever loads and ones that could be fetched on demand. That is the ' +
      'safe default Expo ships, but on an app with a large media directory it ' +
      'is often the single largest contributor to download size.',
    recommendation:
      'Narrow to the assets needed offline at first launch, e.g. ' +
      '`["assets/images/**/*", "assets/fonts/**/*"]`, and load the rest over ' +
      'the network.',
  },

  check(model) {
    const patterns = model.config?.assetBundlePatterns
    if (!Array.isArray(patterns)) return []
    // Only the exact catch-all form is worth an note; anything narrower is a
    // deliberate choice we cannot second-guess without size data.
    if (patterns.length !== 1 || patterns[0] !== '**/*') return []

    return [
      {
        message: 'assetBundlePatterns is ["**/*"], bundling every asset into the binary',
        file: APP_CONFIG_FILE,
        excerpt: 'assetBundlePatterns: ["**/*"]',
      },
    ]
  },
}

const orphanedConfigPlugin: Rule<ExpoModel> = {
  meta: {
    id: 'expo/orphaned-config-plugin',
    category: 'expo',
    severity: 'warning',
    description: 'A config plugin is listed that has no matching dependency',
    rationale:
      'Config plugins are resolved from node_modules by name at prebuild time. ' +
      'A plugin whose package is not a dependency fails resolution, and the ' +
      'error surfaces during the native build rather than at config-read time — ' +
      'usually on CI, where the lockfile is the only source of truth.',
    recommendation:
      'Install the missing package with `npx expo install <package>`, or remove ' +
      'the stale entry from `plugins`.',
  },

  check(model) {
    if (!model.config) return []
    // No package.json means no dependency list to compare against; asserting
    // anything here would flag every plugin in the project.
    if (!model.packageJson) return []

    const findings: FindingDraft[] = []
    for (const name of pluginNames(model.config)) {
      if (isLocalPluginPath(name)) continue

      const pkg = pluginPackageName(name)
      if (model.dependencies.has(pkg)) continue
      // Plugins bundled inside `expo` itself have no standalone dependency.
      if (BUILTIN_PLUGINS.has(pkg)) continue

      findings.push({
        message: `Config plugin "${name}" is not a dependency in package.json`,
        file: APP_CONFIG_FILE,
        excerpt: truncate(`plugins: ["${name}"]`),
        data: { plugin: name, expectedPackage: pkg },
      })
    }
    return findings
  },
}

// ---------------------------------------------------------------------------
// EAS rules
// ---------------------------------------------------------------------------

const missingEasProjectId: Rule<ExpoModel> = {
  meta: {
    id: 'expo/missing-eas-project-id',
    category: 'expo',
    severity: 'warning',
    description: 'eas.json exists but extra.eas.projectId is not set in the app config',
    rationale:
      'The EAS project ID links the local project to its cloud counterpart. ' +
      'Without it, `expo-updates` cannot determine which project to fetch ' +
      'updates from, and non-interactive CI builds fail because they cannot ' +
      'prompt to link the project.',
    recommendation:
      'Run `eas init` (or `eas build:configure`) to write ' +
      '`extra.eas.projectId` into the app config, and commit the result.',
  },

  check(model) {
    if (!model.easJson) return []
    // With no readable app config we cannot tell whether the ID is set — a
    // dynamic app.config.ts commonly injects it.
    if (!model.config) return []
    if (getString(model.config, 'extra.eas.projectId')) return []

    return [
      {
        message: 'eas.json is present but extra.eas.projectId is missing from the app config',
        file: APP_CONFIG_FILE,
      },
    ]
  },
}

const easMissingBuildProfile: Rule<ExpoModel> = {
  meta: {
    id: 'expo/eas-missing-build-profile',
    category: 'expo',
    severity: 'warning',
    description: 'eas.json has no build.production profile',
    rationale:
      'EAS builds are always run against a named profile, and `production` is ' +
      'the one every Expo document, CI template and store-submission guide ' +
      'assumes. Without it, release builds either fail on an unknown profile or ' +
      'silently ship development settings.',
    recommendation:
      'Add a `build.production` profile to eas.json (`eas build:configure` ' +
      'scaffolds one) with the release channel, distribution and env your ' +
      'store builds need.',
  },

  check(model) {
    if (!model.easJson) return []

    const build = getObject(model.easJson, 'build')
    // An eas.json with no build section at all is a different problem (it may
    // be submit-only), so require the section before judging its profiles.
    if (!build) return []
    if (getObject(build, 'production')) return []

    return [
      {
        message: 'eas.json defines no build.production profile',
        file: EAS_FILE,
        excerpt: truncate(`build profiles: ${Object.keys(build).join(', ') || '(none)'}`),
        data: { profiles: Object.keys(build) },
      },
    ]
  },
}

/**
 * Every Expo-layer rule, in roughly the order a developer would care about:
 * version correctness first, then things that block builds, then polish.
 */
export const expoRules: Rule<ExpoModel>[] = [
  sdkEol,
  reactNativeVersionMismatch,
  reactVersionMismatch,
  missingBundleIdentifier,
  missingAndroidPackage,
  iconFileMissing,
  referencedAssetMissing,
  missingRuntimeVersion,
  hermesNotEnabled,
  missingIcon,
  missingAndroidAdaptiveIcon,
  missingSchemeWithRouter,
  orphanedConfigPlugin,
  missingEasProjectId,
  easMissingBuildProfile,
  updatesWithoutFallback,
  missingSplash,
  newArchNotEnabled,
  assetBundlePatternsBroad,
]
