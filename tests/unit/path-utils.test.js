/**
 * @fileoverview Unit tests for renderer/shared/path-utils.js — the shared
 * PathUtils helper (IPC-first join/normalize with hardened browser
 * fallbacks). The module is a classic-script + CommonJS hybrid (same pattern
 * as shared/i18n-apply.js), so it is require()d directly here; fallback
 * branches are exercised by injecting a fake `window` with or without
 * `electronAPI`.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PathUtils,
  createPathUtils,
  isWindowsDrivePath,
  fallbackJoinSync,
  fallbackNormalizeSync
} = require('../../renderer/shared/path-utils.js');

function fallbackOnly(warn) {
  return createPathUtils({ window: {}, warn });
}

describe('renderer/shared/path-utils.js', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('isWindowsDrivePath', () => {
    test('detects drive-absolute paths with either separator style', () => {
      expect(isWindowsDrivePath('C:\\Users\\Dev')).toBe(true);
      expect(isWindowsDrivePath('c:/users/dev')).toBe(true);
    });

    test('rejects POSIX paths, relative paths and non-strings', () => {
      expect(isWindowsDrivePath('/home/user')).toBe(false);
      expect(isWindowsDrivePath('home/user')).toBe(false);
      expect(isWindowsDrivePath('C:relative\\path')).toBe(false);
      expect(isWindowsDrivePath(undefined)).toBe(false);
    });
  });

  describe('fallback join (electronAPI absent)', () => {
    test('windows-drive segments join with backslashes', async () => {
      const pu = fallbackOnly();
      expect(await pu.join('C:\\Users\\Dev', 'repo')).toBe('C:\\Users\\Dev\\repo');
    });

    test('windows-drive join never emits the old forward-slash bug', async () => {
      const pu = fallbackOnly();
      expect(await pu.join('C:\\Users\\Dev', 'repo')).not.toBe('C:/Users/Dev/repo');
    });

    test('empty second segment normalizes instead of appending a separator', async () => {
      const pu = fallbackOnly();
      expect(await pu.join('C:\\Users\\Dev\\Workspaces', '')).toBe('C:\\Users\\Dev\\Workspaces');
      expect(await pu.join('/home/user/ws', '')).toBe('/home/user/ws');
    });

    test('POSIX segments join with forward slashes', async () => {
      const pu = fallbackOnly();
      expect(await pu.join('/home/user', 'ws')).toBe('/home/user/ws');
    });

    test('duplicate and trailing separators collapse', async () => {
      const pu = fallbackOnly();
      expect(await pu.join('/home/user/', 'ws')).toBe('/home/user/ws');
      expect(await pu.join('C:\\Users\\Dev\\', 'repo')).toBe('C:\\Users\\Dev\\repo');
    });

    test('mixed separators on a drive path unify to backslashes', async () => {
      const pu = fallbackOnly();
      expect(await pu.join('C:/Users/Dev', 'repo')).toBe('C:\\Users\\Dev\\repo');
    });
  });

  describe('fallback normalize (electronAPI absent)', () => {
    test('windows-drive paths keep backslashes (no POSIX-ization)', async () => {
      const pu = fallbackOnly();
      expect(await pu.normalize('C:\\Users\\Dev\\Workspaces\\')).toBe('C:\\Users\\Dev\\Workspaces');
    });

    test('windows-drive normalize never converts backslashes to slashes', async () => {
      const pu = fallbackOnly();
      const result = await pu.normalize('C:\\Users\\Dev\\Workspaces');
      expect(result).not.toContain('/');
      expect(result).toBe('C:\\Users\\Dev\\Workspaces');
    });

    test('POSIX paths stay forward-slash style with trailing slash trimmed', async () => {
      const pu = fallbackOnly();
      expect(await pu.normalize('/home/user/ws/')).toBe('/home/user/ws');
    });

    test('roots are preserved', async () => {
      const pu = fallbackOnly();
      expect(await pu.normalize('C:\\')).toBe('C:\\');
      expect(fallbackNormalizeSync('/')).toBe('/');
      expect(fallbackJoinSync('/', '')).toBe('/');
    });
  });

  describe('warn-once behavior', () => {
    test('console.warn fires exactly once across repeated fallback calls', async () => {
      const warn = vi.fn();
      const pu = fallbackOnly(warn);
      await pu.join('/a', 'b');
      await pu.join('/a', 'c');
      await pu.normalize('/a/b/');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/\[PathUtils\] electronAPI unavailable/);
    });

    test('no warning when electronAPI is present (IPC-first)', async () => {
      const warn = vi.fn();
      const joinPath = vi.fn(async (...segments) => segments.join('|'));
      const normalizePath = vi.fn(async (p) => `normalized:${p}`);
      const pu = createPathUtils({ window: { electronAPI: { joinPath, normalizePath } }, warn });
      await pu.join('/home/user', 'ws');
      await pu.normalize('/home/user/ws/');
      expect(joinPath).toHaveBeenCalledWith('/home/user', 'ws');
      expect(normalizePath).toHaveBeenCalledWith('/home/user/ws/');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('IPC-first delegation', () => {
    test('join and normalize delegate to electronAPI when available', async () => {
      const joinPath = vi.fn(async (...segments) => `ipc-join:${segments.filter(Boolean).join('/')}`);
      const normalizePath = vi.fn(async (p) => `ipc-normalize:${p}`);
      const pu = createPathUtils({ window: { electronAPI: { joinPath, normalizePath } } });
      expect(await pu.join('/home/user', 'ws')).toBe('ipc-join:/home/user/ws');
      expect(await pu.normalize('/home/user/ws/')).toBe('ipc-normalize:/home/user/ws/');
      expect(joinPath).toHaveBeenCalledTimes(1);
      expect(normalizePath).toHaveBeenCalledTimes(1);
    });

    test('falls back when electronAPI exists but lacks the path methods', async () => {
      const warn = vi.fn();
      const pu = createPathUtils({ window: { electronAPI: {} }, warn });
      expect(await pu.join('/home/user', 'ws')).toBe('/home/user/ws');
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('default instance', () => {
    test('works without any window (Node) using the hardened fallback', async () => {
      expect(await PathUtils.join('/home/user', 'ws')).toBe('/home/user/ws');
      expect(await PathUtils.normalize('C:\\Users\\Dev\\Workspaces\\')).toBe('C:\\Users\\Dev\\Workspaces');
    });
  });
});
