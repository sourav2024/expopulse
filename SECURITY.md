# Security Policy

## Supported versions

ExpoPulse is at 0.1.0. Only the latest 0.x release receives fixes; there are no
maintained release branches and no backports to earlier 0.x versions.

| Version | Supported |
| --- | --- |
| 0.1.x (latest) | Yes |
| Anything older | No — upgrade |

Both published packages (`expopulse` and `@expopulse/core`) are covered by this
policy and are versioned together.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting:

**https://github.com/sourav2024/expopulse/security/advisories/new**

Do not open a public issue, and do not post details in Discussions, until a fix
is released.

Useful things to include: the affected version, what an attacker controls (a
config file, a plugin, a manifest, a crafted asset), what they achieve, and a
reproduction against a throwaway project. Proof-of-concept files are welcome.

This is a single-maintainer project, so response times are best effort. Expect an
acknowledgement within a week. If a report is valid, the fix and an advisory go
out together; you will be credited in the advisory unless you ask otherwise.

## Threat model

Being specific about what the tool does is more useful than a generic policy.

ExpoPulse is a local developer tool. It runs on a developer's machine or in CI,
under that user's privileges, against a project directory. It has **no network
access** — it does not fetch registry metadata, phone home, or upload reports. It
makes no attempt to sandbox itself from the user who invoked it.

What it does do:

- **`analyze`, `doctor`, `compare` and `report` read.** They glob the project
  tree, read source files and assets, and parse `package.json`, `app.json`,
  `eas.json`, `AndroidManifest.xml`, Gradle files and `Info.plist`. They write
  only report files, to the configured output directory.
- **`fix` writes.** It modifies source files in place, overwrites images with
  recompressed bytes, deletes asset files, and creates new files. It also reads
  and acts on a manifest stored on disk when rolling back.

That makes `fix` the part worth scrutinising.

### What is defended against

**Paths escaping the project root.** Every write and delete in a fixer resolves
through `resolveWithinRoot` (`packages/core/src/fixers/safe-path.ts`), which
rejects both `../` traversal and absolute paths that land outside the root, and
returns `null` — which callers must treat as "skip this action". This matters
because paths reach fixers from places the user does not fully control: rule
`data`, which a third-party plugin can populate, and the backup manifest.

**The backup manifest is treated as untrusted input.** The manifest lives inside
the project at `.expopulse/backups/<id>/manifest.json`. It may be committed,
edited by hand, or arrive from someone else's branch. Rollback therefore resolves
both the restore target and the stored-copy source through `resolveWithinRoot`
and refuses any entry that escapes the root, logging the refusal and continuing
with the rest. Without that, a crafted manifest could make `--rollback` overwrite
or delete files anywhere the process can reach.

**Symlinks are not followed.** The scanner globs with
`followSymbolicLinks: false` (`packages/core/src/core/scanner.ts`). This is
load-bearing, not a performance tweak: a symlinked directory would otherwise
yield paths that physically live outside the project — which fixers would then
edit or delete — and a self-referential link would produce the same file many
times over.

**Backups precede every edit.** The fix engine copies each file in a plan into a
timestamped backup session before the fixer runs. A backup that fails is fatal
for that plan, not a warning: applying the fix anyway would make the edit
unrecoverable while the summary still advertised `--rollback`. If a fixer throws
outright, the whole session is rolled back rather than leaving a half-modified
tree.

**Planning is separate from applying.** `plan` is side-effect free, so
`--dry-run` and the interactive preview show exactly what `--yes` would do.
Fixers also re-check their assumptions in `apply` rather than trusting a plan
built from possibly-stale state.

### What is not defended against, by design

- **Anyone who can run the CLI can already write to the project.** `fix` is not a
  privilege boundary. Its safety measures protect against mistakes and malformed
  data, not against a user who wants to delete their own files.
- **Config files and plugins are executed code.** `expopulse.config.ts` /
  `.js` / `.mjs` are loaded and run, and `plugins` entries are imported and run,
  in the CLI's process with full Node privileges. Running ExpoPulse in a
  repository means trusting that repository's config and plugins exactly as much
  as you trust its `postinstall` scripts. Do not run it on untrusted code you
  would not otherwise build.
- **Parsers are not hardened against hostile input.** Sources go through Babel;
  images go through `sharp`; native manifests go through targeted extractors.
  A malformed or malicious file may crash the run. Crashes are handled per file
  or per layer where practical, but ExpoPulse is not a malware scanner and does
  not claim resistance to deliberately crafted parser input.
- **Reports contain project data.** JSON, HTML, Markdown and SARIF reports embed
  file paths, dependency names, config values and source excerpts. Treat report
  files as you would the source they describe before attaching them to a public
  issue.

## Before you run `fix`

`fix` modifies real files in your working tree. Commit or stash first. The
preview, the backups and `--rollback` exist because that is not always enough,
but version control is the recovery path that always works.

- `expopulse fix --dry-run` writes nothing at all.
- `expopulse fix` previews and prompts before writing.
- `expopulse fix --list-backups` and `--rollback <id>` restore a previous run.
- `--no-backup` disables the safety net. Do not use it on a dirty tree.

Two of the tool's own documented limitations bear directly on this: reference
detection is textual, so an asset referenced only through a computed path can be
reported as unused and then deleted; and dynamic `app.config.ts` files are not
evaluated. Read the preview before agreeing to it.
