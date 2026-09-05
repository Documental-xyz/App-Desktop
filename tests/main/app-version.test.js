/**
 * @fileoverview Tests for resolveAppVersion (version resolver — D4 fix).
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real modules required: setup.js globally mocks fs/path with bare stubs
// (pattern: tests/ipc/workspace-paths.test.js) — these tests exercise real
// temp-dir package.json reads, so unmock first.
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import os from 'os';

import { resolveAppVersion } from '../../src/main/app-version.js';

describe('resolveAppVersion', () => {
  /** @type {string[]} Temp dirs to clean up after each test */
  let tmpDirs = [];

  beforeEach(() => {
    tmpDirs = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  /**
   * Create a temp dir, optionally writing a package.json with given content.
   * @param {string|undefined} pkgContent - Raw package.json content to write
   * @returns {string} Temp dir path
   */
  function makeTmpDir(pkgContent) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-version-'));
    tmpDirs.push(dir);
    if (pkgContent !== undefined) {
      fs.writeFileSync(path.join(dir, 'package.json'), pkgContent, 'utf8');
    }
    return dir;
  }

  /** Build a mock Electron app pointed at a temp dir. */
  function mockApp(dir) {
    return { getAppPath: () => dir, getVersion: () => '42.3.3' };
  }

  it('resolves from a temp-dir package.json', () => {
    const dir = makeTmpDir(JSON.stringify({ version: '0.91.0' }));
    expect(resolveAppVersion(mockApp(dir))).toBe('0.91.0');
  });

  it('falls back to app.getVersion() when package.json is missing', () => {
    const dir = makeTmpDir();
    expect(resolveAppVersion(mockApp(dir))).toBe('42.3.3');
  });

  it('falls back when version is not semver-shaped', () => {
    const dir = makeTmpDir(JSON.stringify({ version: 'banana' }));
    expect(resolveAppVersion(mockApp(dir))).toBe('42.3.3');
  });

  it('falls back when package.json is invalid JSON', () => {
    const dir = makeTmpDir('{ not valid json');
    expect(resolveAppVersion(mockApp(dir))).toBe('42.3.3');
  });

  it('trims whitespace around the version', () => {
    const dir = makeTmpDir(JSON.stringify({ version: '  2.3.4  ' }));
    expect(resolveAppVersion(mockApp(dir))).toBe('2.3.4');
  });
});
