# Third-Party Notices

This file covers third-party software bundled with or redistributed by **App-Desktop** when the
`dugite` Git provider is enabled (`GIT_PROVIDER=dugite`).

## Bundled version

Per `node_modules/dugite/script/embedded-git.json`, the bundled Git comes from
**dugite-native v2.53.0-4** (release
<https://github.com/desktop/dugite-native/releases/tag/v2.53.0-4>), which embeds
**Git 2.53.0** (`git version 2.53.0`, verified in Task 2 evidence).

## 1. Git — GNU General Public License v2.0

- **Copyright:** © 2005–2026 Linus Torvalds and the Git contributors.
- **License:** GNU GPL v2.0 only (with exception for linking with OpenSSL).
- Canonical license text: <https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt>
- The dugite-native **linux-x64 tarball installed here does not ship a `COPYING` file**
  (contents are only `bin/ etc/ libexec/ share/ ssl/`), so the canonical link above is the
  authoritative reference. The Git source of record is
  <https://github.com/git/git/blob/v2.53.0/COPYING>.

## 2. Git LFS — MIT License

- **Copyright:** © 2015-2026 GitHub, Inc. and Git LFS contributors.
- **License:** MIT — canonical text: <https://github.com/git-lfs/git-lfs/blob/main/LICENSE.md>
- **Platform note:** Git LFS is **NOT included in the linux-x64 tarball** installed in this
  workspace (`git lfs version` fails). It **IS bundled in the win32 and darwin tarballs** of the
  same dugite-native release. If LFS support is required on Linux, it must be provisioned
  separately (see learnings, Task 2).

## 3. Git Credential Manager — MIT-style License

- **Copyright:** © GitHub, Inc. and contributors.
- **License:** MIT-style ("MIT" per the GCM repository) — canonical text:
  <https://github.com/git-ecosystem/git-credential-manager/blob/main/LICENSE>
- **Platform note:** like Git LFS, GCM is **NOT included in the linux-x64 tarball** and **IS
  bundled in the win32/darwin tarballs** of dugite-native v2.53.0-4.

## 4. dugite — MIT License

- **Copyright:** © 2018-2026 GitHub, Inc.
- **License:** MIT — canonical text: <https://github.com/desktop/dugite/blob/main/LICENSE>
- dugite is the npm package (`dugite@^3.2.3`) that wraps the dugite-native Git distribution and
  exposes it via a Node API. dugite itself is MIT-licensed; the Git it embeds is GPL v2 (§1).

## 5. dugite-native — build toolchain & GPLv2 implications

- **Repository:** <https://github.com/desktop/dugite-native> (release v2.53.0-4, Git 2.53.0).
- dugite-native is the build toolchain that compiles/packages Git (GPLv2) plus Git LFS (MIT) and
  Git Credential Manager (MIT) for win32/darwin/linux.
- **Implication:** redistributing the dugite-native tarballs means redistributing GPLv2 Git
  binaries. The App-Desktop application code is **not** a derivative work of Git (Git is invoked
  as a separate process via dugite), but the bundled binaries themselves remain under GPLv2 and
  this notice plus access to the corresponding Git source satisfies the attribution requirements.
  Corresponding source: <https://github.com/git/git/tree/v2.53.0>.

## Compliance note (PRD §39)

> **Legal review is required before the first release that bundles Git.** This notice is a
> best-effort engineering artifact; a legal/compliance pass must confirm GPL v2 redistribution
> obligations (source-offer, license text inclusion in installers/DMG/NSIS) prior to shipping
  any build with the dugite provider enabled.
