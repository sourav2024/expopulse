import type { FindingDraft, Rule } from '../../shared/types.js'
import type { AndroidModel } from './index.js'

/**
 * Google Play's current requirement for app updates. Below this, the Play
 * Console rejects new releases outright.
 *
 * MAINTENANCE: Google raises this every year, roughly one year behind the
 * newest platform release. Bump it deliberately, not automatically — the rule
 * is an `error`, so a premature bump breaks builds for compliant projects.
 */
const REQUIRED_TARGET_SDK = 34

/** Below this, projects carry ABI/permission baggage for devices few users run. */
const RECOMMENDED_MIN_SDK = 24

/** API level at which scoped storage made the legacy storage permissions inert. */
const SCOPED_STORAGE_SDK = 33

/**
 * High-scrutiny permissions, each with the CONCRETE reason it draws review.
 *
 * A generic "this permission is dangerous" message is not actionable; what a
 * developer needs is the specific Play policy consequence, because the fix is
 * usually either a declaration form or removing an unused permission that a
 * transitive library merged in.
 */
const DANGEROUS_PERMISSIONS: Readonly<Record<string, string>> = {
  ACCESS_BACKGROUND_LOCATION:
    'background location requires a separate Play Console declaration, a demo video, ' +
    'and a prominent-disclosure screen; it is one of the most common review rejections',
  READ_SMS:
    'SMS access is restricted to apps whose core function is SMS handling and requires ' +
    'a Permissions Declaration form; default dialers/messengers only',
  RECEIVE_SMS:
    'SMS access is restricted to apps whose core function is SMS handling and requires ' +
    'a Permissions Declaration form; commonly rejected when used only for OTP autofill',
  QUERY_ALL_PACKAGES:
    'full package visibility is treated as sensitive and needs a documented, approved ' +
    'use case; most apps should declare specific <queries> entries instead',
  MANAGE_EXTERNAL_STORAGE:
    'All Files Access is limited to file managers, backup and antivirus apps, and ' +
    'requires an approved declaration; the Storage Access Framework is the sanctioned path',
  REQUEST_INSTALL_PACKAGES:
    'installing other APKs is restricted to app stores and similar distributors and ' +
    'is frequently flagged as malware-adjacent behaviour',
}

/** Permissions the platform now ignores, or that were removed outright. */
const DEPRECATED_PERMISSIONS: Readonly<Record<string, string>> = {
  WRITE_EXTERNAL_STORAGE:
    `has no effect on API ${SCOPED_STORAGE_SDK}+ under scoped storage; writes go through ` +
    'MediaStore or the Storage Access Framework instead',
  GET_TASKS:
    'was deprecated in API 21 and returns only the caller’s own tasks; it has been ' +
    'non-functional for over a decade',
  READ_PHONE_STATE:
    'no longer yields device identifiers on API 29+; use an app-scoped identifier instead',
}

/** Rules point at the manifest line when known, and omit `location` otherwise. */
function at(line: number | null | undefined): { line: number } | undefined {
  return typeof line === 'number' ? { line } : undefined
}

const duplicatePermission: Rule<AndroidModel> = {
  meta: {
    id: 'android/duplicate-permission',
    category: 'android',
    severity: 'warning',
    description: 'The same permission is declared more than once in AndroidManifest.xml.',
    rationale:
      'Duplicate <uses-permission> entries are silently collapsed by the manifest merger, ' +
      'so they change nothing at build time. They usually mean a permission was added by ' +
      'hand next to one already contributed by a config plugin or library, which makes the ' +
      'real permission surface harder to audit before a Play review.',
    recommendation:
      'Delete the redundant declarations, keeping one entry per permission. If a plugin ' +
      'already contributes it, remove the hand-written copy so the plugin stays the source ' +
      'of truth.',
    fixable: true,
  },

  check(model): FindingDraft[] {
    const { manifest } = model
    if (!manifest) return []

    // Group by fully-qualified value: two spellings of the same permission are
    // still one permission to the merger.
    const seen = new Map<string, number[]>()
    for (const perm of manifest.permissions) {
      const lines = seen.get(perm.raw)
      if (lines) lines.push(perm.line)
      else seen.set(perm.raw, [perm.line])
    }

    const findings: FindingDraft[] = []
    for (const [raw, lines] of seen) {
      if (lines.length < 2) continue
      const [first, ...rest] = lines
      // Report on the redundant copies, not the first (legitimate) declaration,
      // so a fixer can delete exactly the lines named here.
      for (const line of rest) {
        findings.push({
          message: `Permission ${raw} is declared ${lines.length} times (first at line ${first}).`,
          file: manifest.file,
          location: { line },
          excerpt: `<uses-permission android:name="${raw}" />`,
          fixable: true,
          data: { permission: raw, duplicateLines: rest, firstLine: first },
        })
      }
    }
    return findings
  },
}

const dangerousPermission: Rule<AndroidModel> = {
  meta: {
    id: 'android/dangerous-permission',
    category: 'android',
    severity: 'warning',
    description: 'A permission that triggers heightened Google Play review is declared.',
    rationale:
      'Google Play gates a specific set of permissions behind declaration forms and ' +
      'approved-use-case policies. Declaring one that the app does not actually need — ' +
      'often merged in from a transitive library — delays or blocks the review with no ' +
      'benefit to the app.',
    recommendation:
      'Confirm each of these is genuinely required by a user-facing feature. If it arrived ' +
      'from a dependency, remove it with tools:node="remove" in AndroidManifest.xml. If it ' +
      'is required, prepare the corresponding Play Console declaration before submitting.',
  },

  check(model): FindingDraft[] {
    const { manifest, targetSdk } = model
    if (!manifest) return []

    const findings: FindingDraft[] = []
    // De-duplicate here: `android/duplicate-permission` owns that concern, and
    // repeating one policy warning per copy is pure noise.
    const reported = new Set<string>()

    for (const perm of manifest.permissions) {
      if (reported.has(perm.name)) continue

      const reason = DANGEROUS_PERMISSIONS[perm.name]
      if (reason) {
        reported.add(perm.name)
        findings.push({
          message: `${perm.name} draws heightened Play review: ${reason}.`,
          file: manifest.file,
          location: { line: perm.line },
          excerpt: perm.raw,
          data: { permission: perm.name },
        })
        continue
      }

      // READ_EXTERNAL_STORAGE is only a scrutiny problem on modern targets,
      // where the granular media permissions replaced it. On older targets it
      // is still the correct API, so flagging it there would be wrong.
      const modernTarget = targetSdk !== null && targetSdk >= SCOPED_STORAGE_SDK
      if (perm.name === 'READ_EXTERNAL_STORAGE' && modernTarget) {
        reported.add(perm.name)
        findings.push({
          message:
            `READ_EXTERNAL_STORAGE is superseded on targetSdk ${targetSdk}: API ` +
            `${SCOPED_STORAGE_SDK}+ replaced it with READ_MEDIA_IMAGES, READ_MEDIA_VIDEO and ` +
            'READ_MEDIA_AUDIO, and broad storage reads attract Play scrutiny.',
          file: manifest.file,
          location: { line: perm.line },
          excerpt: perm.raw,
          data: { permission: perm.name, targetSdk },
        })
      }
    }
    return findings
  },
}

const deprecatedPermission: Rule<AndroidModel> = {
  meta: {
    id: 'android/deprecated-permission',
    category: 'android',
    severity: 'info',
    description: 'A permission that the current platform ignores is declared.',
    rationale:
      'These permissions are inert on modern Android. They still appear in the store ' +
      'listing’s permission summary, so they cost user trust at install time while ' +
      'granting the app nothing.',
    recommendation:
      'Remove the declaration, or scope it with android:maxSdkVersion so it only applies to ' +
      'the API levels where it still does something.',
  },

  check(model): FindingDraft[] {
    const { manifest, targetSdk } = model
    if (!manifest) return []

    const findings: FindingDraft[] = []
    const reported = new Set<string>()

    for (const perm of manifest.permissions) {
      if (reported.has(perm.name)) continue
      const reason = DEPRECATED_PERMISSIONS[perm.name]
      if (!reason) continue

      // A maxSdkVersion bound is the documented, correct way to keep a legacy
      // storage permission for old devices — not something to flag.
      const legacyTarget = targetSdk !== null && targetSdk < SCOPED_STORAGE_SDK
      if (perm.name === 'WRITE_EXTERNAL_STORAGE' && legacyTarget) continue

      reported.add(perm.name)
      findings.push({
        message: `${perm.name} ${reason}.`,
        file: manifest.file,
        location: { line: perm.line },
        excerpt: perm.raw,
        data: { permission: perm.name },
      })
    }
    return findings
  },
}

const targetSdkOutdated: Rule<AndroidModel> = {
  meta: {
    id: 'android/target-sdk-outdated',
    category: 'android',
    severity: 'error',
    description: `targetSdkVersion is below ${REQUIRED_TARGET_SDK}, which Google Play requires.`,
    rationale:
      'Google Play enforces a minimum target API level for new apps and for updates to ' +
      'existing ones. An app below the threshold cannot ship an update at all — the Play ' +
      'Console rejects the upload — which turns this into a release blocker rather than a ' +
      'code-quality issue.',
    recommendation:
      'Raise targetSdkVersion in android/build.gradle (or let Expo manage it by upgrading ' +
      'the SDK and re-running prebuild), then retest permissions, background work and ' +
      'foreground services against the new behaviour changes.',
  },

  check(model): FindingDraft[] {
    const target = model.gradle?.targetSdk
    // Unknown targetSdk means the value is computed or the file was unreadable.
    // An `error`-severity rule must never fire on a guess.
    if (!target || target.value >= REQUIRED_TARGET_SDK) return []

    return [
      {
        message:
          `targetSdkVersion is ${target.value}; Google Play requires at least ` +
          `${REQUIRED_TARGET_SDK} to publish app updates.`,
        file: target.file,
        location: { line: target.line },
        excerpt: `targetSdkVersion ${target.value}`,
        data: { targetSdk: target.value, required: REQUIRED_TARGET_SDK },
      },
    ]
  },
}

const minSdkLow: Rule<AndroidModel> = {
  meta: {
    id: 'android/min-sdk-low',
    category: 'android',
    severity: 'info',
    description: `minSdkVersion is below ${RECOMMENDED_MIN_SDK}.`,
    rationale:
      'Supporting Android 6 and older keeps compatibility shims and legacy code paths in ' +
      'the build for a share of the install base that is now very small. Recent Expo and ' +
      'React Native versions also set a higher floor themselves.',
    recommendation:
      `Raise minSdkVersion to ${RECOMMENDED_MIN_SDK} or higher unless you have device ` +
      'analytics showing meaningful traffic from older releases.',
  },

  check(model): FindingDraft[] {
    const min = model.gradle?.minSdk
    if (!min || min.value >= RECOMMENDED_MIN_SDK) return []

    return [
      {
        message:
          `minSdkVersion is ${min.value}, below the recommended floor of ` +
          `${RECOMMENDED_MIN_SDK} (Android 7.0).`,
        file: min.file,
        location: { line: min.line },
        excerpt: `minSdkVersion ${min.value}`,
        data: { minSdk: min.value, recommended: RECOMMENDED_MIN_SDK },
      },
    ]
  },
}

const minifyDisabled: Rule<AndroidModel> = {
  meta: {
    id: 'android/minify-disabled',
    category: 'android',
    severity: 'warning',
    description: 'Release builds do not enable minifyEnabled.',
    rationale:
      'Without R8, the release APK/AAB keeps unused Java/Kotlin classes and full symbol ' +
      'names from the app and every native dependency. Shipping unminified code also makes ' +
      'the app trivially easy to decompile.',
    recommendation:
      'Set enableProguardInReleaseBuilds=true in android/gradle.properties (or minifyEnabled ' +
      'true in the release buildType), then test the release build — R8 can strip classes ' +
      'reached only by reflection, which usually needs a -keep rule.',
  },

  check(model): FindingDraft[] {
    const { gradle } = model
    if (!gradle?.appFile) return []
    // Only fire when we positively read `false`. Null means the flag was written
    // as an expression we do not evaluate, and guessing would be a false positive.
    if (gradle.minifyEnabled !== false) return []

    return [
      {
        message: 'Release builds run without R8: minifyEnabled is false.',
        file: gradle.appFile,
        excerpt: 'minifyEnabled false',
        estimatedImpact: {
          // Deliberately no `bytes`: the real saving depends entirely on the
          // dependency graph and keep rules, and a fabricated number here would
          // be quoted back to us as if measured.
          note:
            'Enabling R8 typically produces a meaningful reduction in the shipped ' +
            'Android binary, but the amount depends on the dependency graph and keep ' +
            'rules. Compare AAB sizes before and after to get a real figure.',
        },
        data: { proguardInRelease: gradle.proguardInRelease },
      },
    ]
  },
}

const shrinkResourcesDisabled: Rule<AndroidModel> = {
  meta: {
    id: 'android/shrink-resources-disabled',
    category: 'android',
    severity: 'info',
    description: 'minifyEnabled is on but shrinkResources is off.',
    rationale:
      'Resource shrinking depends on code shrinking, so with R8 already enabled it is ' +
      'nearly free to turn on. Left off, drawables, layouts and strings that no reachable ' +
      'code references stay in the package.',
    recommendation:
      'Add shrinkResources true to the release buildType alongside minifyEnabled true, then ' +
      'verify any resources loaded by name via getIdentifier() are kept.',
  },

  check(model): FindingDraft[] {
    const { gradle } = model
    if (!gradle?.appFile) return []
    // Only relevant once code shrinking is confirmed on.
    if (gradle.minifyEnabled !== true) return []
    if (gradle.shrinkResources === true) return []

    return [
      {
        message:
          'R8 is enabled but shrinkResources is not, so unused resources remain in the build.',
        file: gradle.appFile,
        excerpt: 'minifyEnabled true // shrinkResources not enabled',
        estimatedImpact: {
          note:
            'Resource shrinking removes unreferenced resources. Savings vary with how many ' +
            'unused drawables and layouts the dependency graph contributes.',
        },
      },
    ]
  },
}

const cleartextTrafficEnabled: Rule<AndroidModel> = {
  meta: {
    id: 'android/cleartext-traffic-enabled',
    category: 'android',
    severity: 'warning',
    description: 'android:usesCleartextTraffic="true" permits unencrypted HTTP traffic.',
    rationale:
      'This disables the platform’s network security default app-wide, so any request ' +
      'that falls back to HTTP is sent in plaintext and can be read or modified on a hostile ' +
      'network. It is also a recurring point of comment in app reviews and security audits.',
    recommendation:
      'Remove the attribute so the secure-by-default policy applies. If a specific host ' +
      'genuinely requires HTTP (a local dev server, legacy hardware), scope it with a ' +
      'network security config domain exception instead of enabling cleartext globally.',
  },

  check(model): FindingDraft[] {
    const { manifest } = model
    if (!manifest || manifest.usesCleartextTraffic !== true) return []

    return [
      {
        message: 'Cleartext HTTP traffic is enabled app-wide via android:usesCleartextTraffic.',
        file: manifest.file,
        location: at(manifest.applicationLine),
        excerpt: 'android:usesCleartextTraffic="true"',
      },
    ]
  },
}

const allowBackupEnabled: Rule<AndroidModel> = {
  meta: {
    id: 'android/allow-backup-enabled',
    category: 'android',
    severity: 'info',
    description: 'android:allowBackup is not explicitly disabled.',
    rationale:
      'allowBackup defaults to true, which lets anyone with USB debugging access pull the ' +
      'app’s private data directory via adb backup on devices that still support it, and ' +
      'includes that data in cloud backups. Tokens or caches written to app storage travel ' +
      'with it.',
    recommendation:
      'Set android:allowBackup="false" on <application>, or keep backups enabled and exclude ' +
      'sensitive files with a android:dataExtractionRules / fullBackupContent ruleset.',
  },

  check(model): FindingDraft[] {
    const { manifest } = model
    if (!manifest) return []
    // Only silent when explicitly false. `true` and absent both leave backups on.
    if (manifest.allowBackup === false) return []

    const explicit = manifest.allowBackup === true
    return [
      {
        message: explicit
          ? 'android:allowBackup="true" allows app data to be extracted via adb backup.'
          : 'android:allowBackup is not set, so it defaults to true and app data can be ' +
            'extracted via adb backup.',
        file: manifest.file,
        location: at(manifest.applicationLine),
        excerpt: explicit ? 'android:allowBackup="true"' : '<application ...>',
        data: { explicit },
      },
    ]
  },
}

const noAbiSplits: Rule<AndroidModel> = {
  meta: {
    id: 'android/no-abi-splits',
    category: 'android',
    severity: 'info',
    description: 'No per-ABI split or separate-CPU-architecture build is configured.',
    rationale:
      'A universal APK carries native libraries for every supported architecture, so each ' +
      'user downloads three or four copies of every .so file and installs the one they can ' +
      'run. This matters for APKs distributed outside Play.',
    recommendation:
      'Ship an Android App Bundle (the EAS Build default), which splits per-ABI at the store ' +
      'automatically. If you distribute APKs directly, set ' +
      'enableSeparateBuildPerCPUArchitecture=true in android/gradle.properties.',
  },

  check(model): FindingDraft[] {
    const { gradle } = model
    if (!gradle) return []
    if (gradle.abiSplitsEnabled) return []
    // Need a real file to attribute the finding to.
    const file = gradle.abiFlagLocation?.file ?? gradle.appFile
    if (!file) return []

    return [
      {
        message:
          'No ABI splits are configured, so a universal APK bundles native libraries for ' +
          'every architecture.',
        file,
        location: at(gradle.abiFlagLocation?.line),
        estimatedImpact: {
          note:
            'Only affects direct APK distribution. If you publish an Android App Bundle — ' +
            'the default for EAS Build — Google Play already performs this split and no ' +
            'change is needed.',
        },
      },
    ]
  },
}

/** Every rule the Android layer contributes, in report order. */
export const androidRules: Rule<AndroidModel>[] = [
  targetSdkOutdated,
  dangerousPermission,
  duplicatePermission,
  deprecatedPermission,
  cleartextTrafficEnabled,
  minifyDisabled,
  shrinkResourcesDisabled,
  allowBackupEnabled,
  noAbiSplits,
  minSdkLow,
]
