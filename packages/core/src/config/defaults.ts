import type { CacheConfig, CiConfig, FixConfig, ReportConfig, Thresholds } from '../shared/types.js'

/**
 * Directories that are never worth analysing. Kept separate from user
 * `ignore` config so that users adding one pattern don't lose these.
 */
export const DEFAULT_IGNORE: string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.expo/**',
  '**/.expo-shared/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/ios/Pods/**',
  '**/android/build/**',
  '**/android/.gradle/**',
  '**/android/app/build/**',
  '**/*.d.ts',
  '**/.expopulse/**',
]

/** Source globs analysed by the code layer. */
export const DEFAULT_INCLUDE: string[] = ['**/*.{js,jsx,ts,tsx}']

export const DEFAULT_THRESHOLDS: Thresholds = {
  // 500 KB: above this a bundled image is nearly always worth compressing.
  maxImageBytes: 500 * 1024,
  maxAssetBytes: 2 * 1024 * 1024,
  // 25 MB installed. A React Native library ships its full native source —
  // android/, ios/, prebuilt binaries and fixtures — so 1 MB flagged 36 of a
  // healthy app's dependencies, including react-native itself. At 25 MB the
  // rule surfaces the handful of genuinely heavy packages instead of the
  // baseline cost of using Expo.
  maxDependencyBytes: 25 * 1024 * 1024,
  minScore: 80,
}

export const DEFAULT_REPORT: ReportConfig = {
  formats: ['cli'],
  outDir: '.expopulse/reports',
  verbose: false,
}

export const DEFAULT_FIX: FixConfig = {
  backup: true,
  yes: false,
  dryRun: false,
  // Off by default: changing extensions requires updating import paths,
  // which is beyond what a "safe" fix should do unattended.
  convertToWebp: false,
}

export const DEFAULT_CI: CiConfig = {
  failOn: 'error',
  enforceScore: false,
}

export const DEFAULT_CACHE: CacheConfig = {
  enabled: true,
  dir: '.expopulse/cache',
}

/** File extensions treated as each asset kind. */
export const ASSET_EXTENSIONS = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg'],
  font: ['.ttf', '.otf', '.woff', '.woff2', '.eot'],
  video: ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'],
  audio: ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac'],
} as const
