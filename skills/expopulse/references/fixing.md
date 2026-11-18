# Fixing safely

`expopulse fix` deletes assets, edits source and manifests, and re-encodes images. Treat it like a migration.

## Before

1. Get explicit approval for the specific rules you will apply.
2. Check that the git tree is clean (`git status`). If it isn't, ask the user to commit or stash first, so the diff of the fix stays reviewable.
3. Verify the findings (`rules.md`). For unused files, search for dynamic references first.
4. Preview:

   ```bash
   npx -y expopulse@0.2.0 fix --dry-run --no-cache
   npx -y expopulse@0.2.0 fix --dry-run --no-cache --rule assets/unused-asset
   ```

   Show the user the planned deletions and edits. Remove anything you could not verify from the plan. To keep a single file, ask the user whether to add an ignore glob to the config. Otherwise fix that one by hand.

## Apply

One rule at a time, with `--yes`. The agent's shell is not a TTY: without `--yes`, `fix` prints "Not an interactive terminal" and **exits 0 having changed nothing**.

```bash
npx -y expopulse@0.2.0 fix --no-cache --yes --rule code/unused-import
```

- Read the output. It reports files changed, bytes saved and a **backup id**. Write the backup id down.
- Never pass `--no-backup`.
- `--webp` converts PNG/JPEG to WebP and **does not update imports**. Avoid it unless the user wants to update every reference afterwards.
- `assets/duplicate-image`: only auto-fix when the copy being removed is itself unreferenced. Otherwise, re-point its `require`s at the kept copy by hand first. 0.2.0 does not update references.

## After

1. `git diff --stat`, then skim the diff. Deleted files should be exactly the ones you approved.
2. Re-run the analysis and compare:

   ```bash
   npx -y expopulse@0.2.0 compare --save "${TMPDIR:-/tmp}/expopulse-before.json"   # do this before fixing
   npx -y expopulse@0.2.0 compare --baseline "${TMPDIR:-/tmp}/expopulse-before.json" # after fixing
   ```

3. Run the project's own checks: `npx tsc --noEmit`, the tests, `npx expo export` or a dev build where possible. A deleted asset that was still referenced only fails at bundle time.
4. If anything broke:

   ```bash
   npx -y expopulse@0.2.0 fix --list-backups
   npx -y expopulse@0.2.0 fix --rollback <backup-id>
   ```

   Backups live in `.expopulse/backups/` inside the project. Suggest adding `.expopulse/` to `.gitignore` if it isn't there.

## Fixes the tool doesn't make

Apply these by hand, with approval, following the finding's `recommendation`:

- **Version mismatches:** `npx expo install --fix`. This changes `package.json` and the lockfile, so run the tests after.
- **Missing dependency:** `npx expo install <package>`.
- **Permissions, purpose strings, privacy manifest:**
  - CNG projects: in `app.json` / `app.config.*`
  - committed native folders: in `AndroidManifest.xml` / `Info.plist`
  - Draft purpose strings for the user to approve. They are user-facing copy.
- **Minify / R8:** `expo-build-properties` or `gradle.properties`, followed by a release-build test.
- **Image recompression of brand or splash assets:** confirm with the user and check visually afterwards.
