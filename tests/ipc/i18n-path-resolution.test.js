/**
 * @fileoverview Regression tests for i18n path resolution (Bug 1 fix)
 * Verifies getLocalesPath resolves correctly for dev vs packaged mode,
 * and specifically that packaged mode uses appPath directly (not path.dirname).
 *
 * Platform-agnostic: the implementation joins with the NATIVE path module
 * (src uses require('path'), which vi.mock in setup.js cannot intercept),
 * so inputs and expectations are built with the real path module too —
 * never POSIX literals, which fail on win32 backslash joins.
 *
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.unmock('path');

import path from 'path';

/** Normalize to POSIX separators for substring checks on mixed literals. */
const toPosix = (p) => p.split(path.sep).join('/');

describe('i18n path resolution (Bug 1 regression)', () => {
  let getLocalesPath;

  beforeEach(async () => {
    vi.clearAllMocks();
    const i18n = await import('../../src/ipc/i18n.js');
    getLocalesPath = i18n.getLocalesPath;
  });

  describe('getLocalesPath', () => {
    it('should use process.cwd() in dev mode (isPackaged=false)', () => {
      const result = getLocalesPath(false, '/irrelevant/app/path');

      expect(toPosix(result)).toContain('src/locales');
      // In dev mode, should be based on process.cwd(), not appPath
      expect(result).toBe(path.join(process.cwd(), 'src', 'locales'));
    });

    it('should use appPath directly in packaged mode (isPackaged=true)', () => {
      const appPath = path.join('/', 'app', 'path');
      const result = getLocalesPath(true, appPath);

      expect(result).toBe(path.join(appPath, 'src', 'locales'));
    });

    it('should NOT use path.dirname on appPath (critical regression)', () => {
      const appPath = path.join(path.sep, 'tmp', 'build', 'resources', 'app.asar');
      const result = getLocalesPath(true, appPath);

      // CORRECT: path inside the asar
      expect(result).toBe(path.join(appPath, 'src', 'locales'));
      // WRONG (what path.dirname would produce)
      expect(result).not.toBe(
        path.join(path.dirname(appPath), 'src', 'locales')
      );
    });

    it('should handle asar path with nested directories', () => {
      const appPath = path.join(path.sep, 'opt', 'documental', 'resources', 'app.asar');
      const result = getLocalesPath(true, appPath);

      expect(result).toBe(path.join(appPath, 'src', 'locales'));
      expect(toPosix(result)).toContain('app.asar/src/locales');
    });

    it('should return different paths for dev vs packaged with same appPath', () => {
      const appPath = path.join('/', 'my', 'app', 'path');
      const devResult = getLocalesPath(false, appPath);
      const packagedResult = getLocalesPath(true, appPath);

      expect(devResult).not.toBe(packagedResult);
      expect(toPosix(packagedResult)).toContain('my/app/path');
      expect(devResult).toContain(process.cwd());
    });

    it('should always end with src/locales', () => {
      const cases = [
        { isPackaged: false, appPath: path.join('/', 'any', 'path') },
        { isPackaged: true, appPath: path.join('/', 'foo', 'bar', 'app.asar') },
        { isPackaged: true, appPath: path.join('/', 'app') },
      ];

      for (const { isPackaged, appPath } of cases) {
        const result = getLocalesPath(isPackaged, appPath);
        expect(result.endsWith(path.join('src', 'locales'))).toBe(true);
      }
    });
  });
});
