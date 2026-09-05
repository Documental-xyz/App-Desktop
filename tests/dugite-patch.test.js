/**
 * @fileoverview Guard test for the dugite windowsHide patch (Task 2 / D1b)
 *
 * dugite 3.2.3 does not expose `windowsHide` via its options API, so git.exe
 * child processes flash visible console windows on Windows. The committed
 * patch-package patch (patches/dugite+3.2.3.patch) plus the `postinstall`
 * hook make the fix survive fresh installs. This test fails loudly when:
 *   - the patch file is missing or no longer adds windowsHide to BOTH files
 *   - package.json loses the patch-package devDep or the postinstall script
 *   - the current node_modules copy is unpatched (postinstall did not run)
 *
 * Read-only: never modifies node_modules and never runs npm.
 *
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, vi } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const patchFile = join(root, 'patches', 'dugite+3.2.3.patch');

/**
 * Pure detector: given the textual content of a patch-package patch file,
 * report which of the given target files have a windowsHide addition (+ line).
 *
 * @param {string} patchContent - unified diff content of a patch file
 * @param {string[]} targets - file suffixes to check, e.g. ['exec.js', 'spawn.js']
 * @returns {{ file: string, hasWindowsHide: boolean }[]}
 */
function detectWindowsHideInPatch(patchContent, targets) {
  return targets.map((target) => {
    const prefix = `diff --git a/node_modules/dugite/build/lib/${target}`;
    const fileStart = patchContent.indexOf(prefix);
    if (fileStart === -1) {
      return { file: target, hasWindowsHide: false };
    }
    const nextDiff = patchContent.indexOf('diff --git', fileStart + 1);
    const section =
      nextDiff === -1
        ? patchContent.slice(fileStart)
        : patchContent.slice(fileStart, nextDiff);
    return { file: target, hasWindowsHide: /^\+.*windowsHide:\s*true/m.test(section) };
  });
}

describe('dugite windowsHide patch guard', () => {
  describe('patch file', () => {
    it('patches/dugite+3.2.3.patch exists', () => {
      expect(existsSync(patchFile)).toBe(true);
    });

    it('adds windowsHide to both exec.js and spawn.js', () => {
      const content = readFileSync(patchFile, 'utf8');
      const report = detectWindowsHideInPatch(content, ['exec.js', 'spawn.js']);
      for (const { file, hasWindowsHide } of report) {
        expect(hasWindowsHide, `patch must add windowsHide to ${file}`).toBe(true);
      }
    });
  });

  describe('package.json wiring', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

    it('declares patch-package in devDependencies', () => {
      expect(pkg.devDependencies['patch-package']).toBeDefined();
    });

    it('has a postinstall script that runs patch-package', () => {
      expect(pkg.scripts.postinstall).toContain('patch-package');
    });
  });

  describe('installed dugite is patched', () => {
    it.each(['exec.js', 'spawn.js'])(
      'node_modules/dugite/build/lib/%s contains windowsHide: true',
      (file) => {
        const content = readFileSync(
          join(root, 'node_modules', 'dugite', 'build', 'lib', file),
          'utf8'
        );
        expect(content).toMatch(/windowsHide:\s*true/);
      }
    );
  });

  describe('detector negative path (fixtures)', () => {
    it('scopes detection per file: unpatched exec.js stays missing even when spawn.js is patched', () => {
      const fixture = [
        'diff --git a/node_modules/dugite/build/lib/exec.js b/node_modules/dugite/build/lib/exec.js',
        '@@ -14,6 +14,7 @@',
        '+        unrelatedOption: true,',
        'diff --git a/node_modules/dugite/build/lib/spawn.js b/node_modules/dugite/build/lib/spawn.js',
        '@@ -13,7 +13,7 @@',
        '+    spawn(gitLocation, args, { env, cwd: path, windowsHide: true });',
        '',
      ].join('\n');

      const byFile = Object.fromEntries(
        detectWindowsHideInPatch(fixture, ['exec.js', 'spawn.js']).map((r) => [
          r.file,
          r.hasWindowsHide,
        ])
      );
      expect(byFile['exec.js']).toBe(false);
      expect(byFile['spawn.js']).toBe(true);
    });

    it('reports missing windowsHide for a patch lacking the addition', () => {
      const fixture = [
        'diff --git a/node_modules/dugite/build/lib/exec.js b/node_modules/dugite/build/lib/exec.js',
        '--- a/node_modules/dugite/build/lib/exec.js',
        '+++ b/node_modules/dugite/build/lib/exec.js',
        '@@ -14,6 +14,7 @@ function exec(args, path, options) {',
        '+        someOtherOption: true,',
        'diff --git a/node_modules/dugite/build/lib/spawn.js b/node_modules/dugite/build/lib/spawn.js',
        '--- a/node_modules/dugite/build/lib/spawn.js',
        '+++ b/node_modules/dugite/build/lib/spawn.js',
        '@@ -13,7 +13,7 @@',
        '-    const spawnedProcess = (0, child_process_1.spawn)(gitLocation, args, { env, cwd: path });',
        '+    const spawnedProcess = (0, child_process_1.spawn)(gitLocation, args, { env, cwd: path, windowsHide: false });',
        '',
      ].join('\n');

      const report = detectWindowsHideInPatch(fixture, ['exec.js', 'spawn.js']);
      const byFile = Object.fromEntries(report.map((r) => [r.file, r.hasWindowsHide]));
      // exec.js has no windowsHide addition → detector must flag it as missing
      expect(byFile['exec.js']).toBe(false);
      // spawn.js adds `windowsHide: false` — not the required `true`
      expect(byFile['spawn.js']).toBe(false);
    });

    it('reports present windowsHide for a well-formed fixture patch', () => {
      const fixture = [
        'diff --git a/node_modules/dugite/build/lib/exec.js b/node_modules/dugite/build/lib/exec.js',
        '@@ -14,6 +14,7 @@',
        '+        windowsHide: true,',
        'diff --git a/node_modules/dugite/build/lib/spawn.js b/node_modules/dugite/build/lib/spawn.js',
        '@@ -13,7 +13,7 @@',
        '+    spawn(gitLocation, args, { env, cwd: path, windowsHide: true });',
        '',
      ].join('\n');

      const report = detectWindowsHideInPatch(fixture, ['exec.js', 'spawn.js']);
      for (const { hasWindowsHide } of report) {
        expect(hasWindowsHide).toBe(true);
      }
    });
  });
});
