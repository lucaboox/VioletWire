---
name: update-twitch
description: Cut and publish a VioletWire release - bump the version, write the CHANGELOG entry, validate, commit, push, and tag so the GitHub release workflow builds it. Use when asked to "update-twitch", cut/ship a release, or publish a new version. Accepts an optional version argument like "0.3.3-alpha.2".
---

# Release VioletWire

Publishes a new VioletWire release end to end. Invoking this skill **is** the
authorization to push and tag — the tag push starts a public GitHub release
build, so run the steps in order and stop on any failure.

## 1. Pick the version

- If the user passed a version (`update-twitch 0.3.3-alpha.2`), use it verbatim.
- Otherwise read `version` from `package.json` and increment the trailing
  pre-release number (`0.3.3-alpha.1` → `0.3.3-alpha.2`). State the version you
  chose before continuing.
- It must match `^\d+\.\d+\.\d+(-alpha\.\d+)?$`. A larger jump (new patch/minor
  line, e.g. `0.3.2-alpha.7` → `0.3.3-alpha.1`) is fine when the user asks.

## 2. Pre-flight

Stop and report instead of pushing if any of these fail:

- On `main`: `git branch --show-current`.
- No uncommitted **tracked** source changes: `git status --short`. The release
  commit should only introduce the version + changelog edits. If the user has
  unfinished work, say so and stop.
- The repo has untracked local files (e.g. `AGENTS.md`). **Never `git add -A`** —
  always stage the three release files explicitly.

## 3. Collect what shipped

```
git log --oneline v<current-version>..HEAD
```

`<current-version>` is the version still in `package.json` (the previous
release's tag). Read the commits to understand the actual user-facing changes.

## 4. Write the CHANGELOG entry

Edit `CHANGELOG.md`. Insert a new section **directly under `## [Unreleased]`**,
above the previous release:

```
## [<version>] - <YYYY-MM-DD>

### Additions

### Improvements

### Fixes
```

- Use today's date.
- Omit any of the three groups that would be empty.
- Write **user-facing outcomes**, not commit subjects — describe what changed
  for someone using the app and, for fixes, what was wrong.
- Do **not** repeat anything already listed under an earlier released version.
- Skip purely internal churn that a user would never notice.

## 5. Bump the version

- `package.json` → the `version` field.
- `package-lock.json` → **two** occurrences of the old version string.

Verify both: `grep '"version"' package.json` and
`grep -c '"version": "<version>"' package-lock.json` (expect `2`).

## 6. Validate — all must pass

```
npm run typecheck
npm run lint
npm test
npm run build
```

If anything fails, **stop and report**. Never push a failing build.

## 7. Commit, push, tag

Stage only the release files:

```
git add package.json package-lock.json CHANGELOG.md
```

Commit as `Release <version>: <short summary>` with a brief body listing the
headline changes, then:

```
git push origin main
git tag v<version>
git push origin v<version>
```

The `Release VioletWire` workflow triggers on pushed `v*` tags, so the tag push
is what starts the build.

## 8. Confirm

Run `gh run list --limit 2` and confirm a run for the new tag is `in_progress`.
Report the version, what went into it, and the run URL
(`https://github.com/lucaboox/VioletWire/actions/runs/<id>`). The Windows build
takes roughly 9 minutes.
