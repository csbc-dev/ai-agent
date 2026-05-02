---
name: release
description: "Release procedure for @csbc-dev/ai-agent on npm. Always use this skill when the user asks to release, publish, run npm publish, bump the version, or cut a tag (in any language). CI/CD is not yet set up, so every step is performed manually."
---

# `@csbc-dev/ai-agent` release procedure

This skill defines the **manual operations** required to publish `@csbc-dev/ai-agent` to the npm registry. CI/CD is planned for the future; for now every step is performed and verified by hand.

> ⚠️ **`npm publish` must always be executed by a human (the maintainer) on their own machine.**
> The assistant must **not** run `npm publish` on the maintainer's behalf. 2FA / OTP entry, npm credentials, and the final decision on when to publish are the maintainer's responsibility, and a wrong publish can become unrecoverable due to the 72-hour limit on `npm unpublish`. The assistant covers everything up to and including the pre-push checks (build, test, version bump, tag creation), and **only presents** the `npm publish` commands.

## Prerequisites

- Release owner: maintainer (currently `mogera551`)
- Target registry: npm (`@csbc-dev/ai-agent`, scoped public)
- Shipped artifact: per the `files` field in [package.json](../../../package.json) — `dist/`, `src/auto/` (`.d.ts` / `.js` / `.min.js`), `LICENSE`, and `README.md`
- Versioning: follows [Semantic Versioning](https://semver.org/)
- Tag naming: `v<version>` (e.g. `v0.4.1`)

## Checklist

Walk through the steps in order and report concise progress to the user after each step. **Destructive operations (`npm publish`, `git push --tags`, GitHub Release creation) must be confirmed with the user before execution.**

### 1. Pre-flight checks

- [ ] `git status` is clean (no uncommitted changes)
- [ ] Current branch is `main` and is in sync with `origin/main`
- [ ] Review changes since the previous release with `git log <previous-tag>..HEAD --oneline`
- [ ] Verify [package.json](../../../package.json) `repository.url` points to `csbc-dev/ai-agent`
  - If it still points at the upstream `wc-bindable-protocol`, suggest fixing it as a separate task (the wrong link misleads consumers)

### 2. Decide the version

Read the diff via `git log` and pick a bump using the rules below. **Propose the bump to the user and get agreement before proceeding.**

| Type of change | Bump |
|---|---|
| Breaking change to public API (type signatures, element attributes, event names, public methods on `AiCore`, etc.) | major (treat as minor while in `0.x.y`) |
| Backwards-compatible feature addition, new provider, new option | minor |
| Internal fix, docs, tests only | patch |

> While in `0.x.y`, keep the convention of mapping breaking changes to minor and feature additions / fixes to patch.

### 3. Quality gate

```bash
npm ci                        # Reinstall dependencies exactly as in the lockfile
npm run build                 # tsc → dist/
npm test                      # vitest run __tests__
npm run test:integration      # build + playwright (browser integration)
```

Confirm all of the above pass. `npm run test:coverage` is optional (useful as a regression signal).

### 4. Artifact integrity check

- [ ] `dist/index.js` and `dist/index.d.ts` are present
- [ ] [src/auto/auto.min.js](../../../src/auto/auto.min.js) and [src/auto/auto.js](../../../src/auto/auto.js) are equivalent (same AST modulo whitespace)
- [ ] [src/auto/remoteEnv.min.js](../../../src/auto/remoteEnv.min.js) and [src/auto/remoteEnv.js](../../../src/auto/remoteEnv.js) are equivalent
- [ ] Run `npm pack --dry-run` and inspect the actual packaged file list

> `src/auto/*.min.js` are hand-written single-line variants. Whenever the corresponding `*.js` changes, **the `*.min.js` must be updated by hand** (no build script is wired up yet).

### 5. Bump the version and commit

`npm version` automatically creates the commit and tag. **Do not push at this point.**

```bash
npm version <patch|minor|major> -m "chore(release): v%s"
```

- The `version` field in `package.json` and `package-lock.json` is updated
- An annotated tag `vX.Y.Z` is created

### 6. Release notes

- Minimal: write the change list directly in the tag message (amend with `git tag -a vX.Y.Z` if needed)
- Recommended: draft a GitHub Release
  - Title: `vX.Y.Z`
  - Sections: `Added` / `Changed` / `Fixed` / `Removed` / `Breaking`
  - Paste output of `git log <previous-tag>..vX.Y.Z --oneline` and group by Conventional Commit prefix (`feat`, `fix`, `refactor`, …)

### 7. Push (requires user confirmation)

```bash
git push origin main          # Push the commit
git push origin vX.Y.Z        # Push the tag
```

Or send both at once with `git push origin main --follow-tags`.

### 8. npm publish (**must be run manually by the maintainer**)

> 🚫 **The assistant must not perform this step.** The commands below are presented as guidance only; the maintainer types them in their own terminal. Entering 2FA OTPs, protecting credentials, and choosing the publish moment are the maintainer's responsibility.

**Required assistant behavior:** once step 7 is complete, the assistant **must post the full `npm publish` command set to the chat in copy-pasteable form**, using the template below. Saying only "now go ahead and publish" without surfacing the commands is not acceptable.

```bash
# 1. Confirm the logged-in account
npm whoami

# 2. Publish (--access public is required for a scoped package)
npm publish --access public

# 3. Verify the release was registered
npm view @csbc-dev/ai-agent version
```

When presenting the commands, also include these notes:

- If `npm whoami` does not show the expected account (e.g. `mogera551`), run `npm logout` then `npm login` before invoking `npm publish`
- If `npm publish` prompts `Enter OTP:`, enter the 2FA token
- For a dry run that previews the tarball, suggest running `npm publish --dry-run --access public` first
- If a wrong version is published: `npm unpublish @csbc-dev/ai-agent@<version>` is allowed only within 72 hours; afterwards only `npm deprecate` remains

**Wait:** do not proceed to the next step (GitHub Release) until the maintainer reports "publish complete." When they do, ask them to share the `npm view ... version` output as confirmation.

### 9. Publish GitHub Release (requires user confirmation)

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <draft.md>
```

Or publish the draft via the GitHub web UI.

### 10. Post-release verification

- [ ] `npm view @csbc-dev/ai-agent` shows the new `version` / `dist.tarball`
- [ ] `npm pack @csbc-dev/ai-agent@<version>` in a scratch directory produces the expected file set
- [ ] Smoke test: import `index.js` and confirm `bootstrapAi` is callable

## Troubleshooting

| Symptom | Action |
|---|---|
| `npm publish` fails with `403 Forbidden` | Likely missing `--access public`, or no scope permission. Check with `npm access list packages` |
| `npm version` fails with "Git working directory not clean" | Resolve uncommitted changes via `git status`, then retry |
| Bug discovered after publish | **`npm unpublish` works only within 72 hours.** Default to a patch release that overwrites the bad version. `npm deprecate @csbc-dev/ai-agent@<version> "<reason>"` is the safer fallback to surface a warning |
| Pushed only the tag (commit missing) | Follow up with `git push origin main`. The reverse order (commit-first) is fine |
| About to publish with a stale `dist/` | Get into the habit of running `rm -rf dist && npm run build` immediately before `npm publish` |

## Notes for future CI/CD migration

When CI/CD is introduced (e.g. GitHub Actions), expect to port the following:

- Trigger on tag push (`v*`) to run `npm ci → build → test → publish`
- Store `NPM_TOKEN` as a repository secret (enable provenance: `npm publish --provenance`)
- Replace `npm version` with `release-please` or `changesets` to auto-generate release notes
- Wire the `*.min.js` build into `prepublishOnly` in `package.json` to eliminate the manual sync step
