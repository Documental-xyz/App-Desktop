/**
 * @fileoverview Guard test for the npm-internal windowsHide patches (T1/T2)
 *
 * npm's bundled spawn layer (@npmcli/promise-spawn, @npmcli/run-script) never
 * sets `windowsHide`, so every npm-internal child (install, run-script,
 * lifecycle scripts) flashes a visible console window on Windows. The
 * committed nested patch-package patches force `windowsHide: true` at the
 * two spawn choke points inside the bundled npm tree. This test fails
 * loudly when:
 *   - a patch file is missing or no longer adds windowsHide
 *   - the current node_modules copy is unpatched (postinstall did not run,
 *     or patch-package failed SILENTLY — outside CI it exits 0 even when a
 *     patch fails to apply, so the installed-file assertions are the local
 *     tripwire)
 *   - a patch file contains CR bytes (CRLF-corrupted patches fail to apply
 *     cross-platform)
 *
 * Read-only: never modifies node_modules and never runs npm.
 *
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, vi } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const patchesDir = join(root, 'patches');

/**
 * Find the patch file for a nested package under patches/.
 *
 * @param {string} patchNameRegex - regex the filename must match, e.g. /^npm\+\+@npmcli\+promise-spawn\+.+\.patch$/
 * @returns {string|null} absolute path of the first matching patch file, or null
 */
function findPatchFile(patchNameRegex) {
  const entries = readdirSync(patchesDir).filter((f) => f.endsWith('.patch'));
  const match = entries.find((f) => patchNameRegex.test(f));
  return match ? join(patchesDir, match) : null;
}

describe('npmcli windowsHide patch guard', () => {
  describe('@npmcli/promise-spawn patch file', () => {
    it('patches/ has a patch for npm/@npmcli/promise-spawn', () => {
      expect(findPatchFile(/^npm\+\+@npmcli\+promise-spawn\+.+\.patch$/)).not.toBeNull();
    });

    it('patch adds windowsHide: true as an added (+) line', () => {
      const file = findPatchFile(/^npm\+\+@npmcli\+promise-spawn\+.+\.patch$/);
      expect(file, 'patch file must exist before content check').not.toBeNull();
      const content = readFileSync(file, 'utf8');
      expect(content).toMatch(/^\+.*windowsHide:\s*true/m);
    });
  });

  describe('@npmcli/run-script patch file', () => {
    // Intentional defense-in-depth alongside the promise-spawn patch:
    // promise-spawn is the single choke point for ALL npm-internal spawns;
    // run-script pins the lifecycle path explicitly in case a future npm
    // refactor reroutes it.
    it('patches/ has a patch for npm/@npmcli/run-script', () => {
      expect(findPatchFile(/^npm\+\+@npmcli\+run-script\+.+\.patch$/)).not.toBeNull();
    });

    it('patch adds windowsHide: true as an added (+) line', () => {
      const file = findPatchFile(/^npm\+\+@npmcli\+run-script\+.+\.patch$/);
      expect(file, 'patch file must exist before content check').not.toBeNull();
      const content = readFileSync(file, 'utf8');
      expect(content).toMatch(/^\+.*windowsHide:\s*true/m);
    });
  });

  describe('installed @npmcli/promise-spawn is patched', () => {
    it('node_modules/npm/node_modules/@npmcli/promise-spawn/lib/index.js contains windowsHide: true', () => {
      const target = join(
        root,
        'node_modules', 'npm', 'node_modules', '@npmcli', 'promise-spawn', 'lib', 'index.js'
      );
      expect(existsSync(target), 'bundled package must be installed').toBe(true);
      const content = readFileSync(target, 'utf8');
      expect(content).toMatch(/windowsHide:\s*true/);
    });
  });

  describe('installed @npmcli/run-script is patched', () => {
    it('node_modules/npm/node_modules/@npmcli/run-script/lib/make-spawn-args.js contains windowsHide: true', () => {
      const target = join(
        root,
        'node_modules', 'npm', 'node_modules', '@npmcli', 'run-script', 'lib', 'make-spawn-args.js'
      );
      expect(existsSync(target), 'bundled package must be installed').toBe(true);
      const content = readFileSync(target, 'utf8');
      expect(content).toMatch(/windowsHide:\s*true/);
    });
  });

  describe('patch files are LF-only (no CR bytes)', () => {
    it('no patch under patches/ contains a CR byte', () => {
      const entries = readdirSync(patchesDir).filter((f) => f.endsWith('.patch'));
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        const raw = readFileSync(join(patchesDir, entry));
        expect(
          raw.includes(13),
          `${entry} contains CR bytes — CRLF-corrupted patches fail to apply cross-platform`
        ).toBe(false);
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
});
