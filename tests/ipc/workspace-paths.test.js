/**
 * @fileoverview Tests for workspace path canonicalization, platform-aware
 * existence comparison, and the one-time projectPath DB migration (D2a).
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real modules required: setup.js globally mocks fs/path/sqlite3 with bare
// stubs (no win32/posix variants, no mkdtempSync, no sqlite3.Database
// implementation). These tests exercise canonicalization with the real path
// modules, real temp dirs and a real SQLite database.
vi.unmock('fs');
vi.unmock('path');
vi.unmock('sqlite3');

import path from 'path';
import fs from 'fs';
import os from 'os';

import {
  ProjectHandlers,
  canonicalizeWorkspacePath,
  workspacePathsEqual,
  migrateProjectPaths
} from '../../src/ipc/projects.js';

function enoent() {
  const error = new Error("ENOENT: no such file or directory, realpathSync");
  error.code = 'ENOENT';
  throw error;
}

function fakeFs(nativeImpl) {
  return { realpathSync: { native: vi.fn(nativeImpl) } };
}

describe('canonicalizeWorkspacePath', () => {
  it('normalizes mixed separators and trailing slash on win32', () => {
    const result = canonicalizeWorkspacePath('C:/Users/dev\\Workspaces/', {
      platform: 'win32',
      pathModule: path.win32,
      fs: fakeFs(enoent)
    });

    expect(result).toBe('C:\\Users\\dev\\Workspaces');
  });

  it('uses on-disk casing from realpathSync.native on win32', () => {
    const native = vi.fn(() => 'C:\\Users\\Dev\\Workspaces');
    const result = canonicalizeWorkspacePath('c:\\users\\dev\\workspaces', {
      platform: 'win32',
      pathModule: path.win32,
      fs: { realpathSync: { native } }
    });

    expect(result).toBe('C:\\Users\\Dev\\Workspaces');
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith('c:\\users\\dev\\workspaces');
  });

  it('falls back to path.resolve result when realpath throws ENOENT (folder not created yet)', () => {
    const input = 'C:\\Users\\dev\\NewFolder';
    const result = canonicalizeWorkspacePath(input, {
      platform: 'win32',
      pathModule: path.win32,
      fs: fakeFs(enoent)
    });

    expect(result).toBe(path.win32.resolve(input));
    expect(result).toBe('C:\\Users\\dev\\NewFolder');
  });

  it('never calls realpath on POSIX and keeps symlinked paths unresolved', () => {
    const native = vi.fn();
    const result = canonicalizeWorkspacePath('/home/user/ws/../ws/', {
      platform: 'linux',
      pathModule: path.posix,
      fs: { realpathSync: { native } }
    });

    expect(native).not.toHaveBeenCalled();
    expect(result).toBe('/home/user/ws');
  });

  it('resolve-only on POSIX with default dependencies (realpath untouched)', () => {
    const result = canonicalizeWorkspacePath('/home/user/ws/', {
      platform: 'linux'
    });

    expect(result).toBe('/home/user/ws');
  });
});

describe('workspacePathsEqual (checkProjectExists comparator)', () => {
  it('matches case-insensitively on win32', () => {
    expect(workspacePathsEqual('C:\\Users\\DEV\\ws', 'c:\\users\\dev\\WS', 'win32')).toBe(true);
  });

  it('is case-sensitive on POSIX', () => {
    expect(workspacePathsEqual('C:\\Users\\DEV\\ws', 'c:\\users\\dev\\WS', 'linux')).toBe(false);
    expect(workspacePathsEqual('/home/user/ws', '/home/user/ws', 'linux')).toBe(true);
    expect(workspacePathsEqual('/home/user/WS', '/home/user/ws', 'linux')).toBe(false);
  });

  it('matches identical win32 paths exactly', () => {
    expect(workspacePathsEqual('C:\\Users\\Dev\\ws', 'C:\\Users\\Dev\\ws', 'win32')).toBe(true);
  });
});

describe('saveProject canonicalizes before INSERT', () => {
  let handlers;
  let insertParams;

  beforeEach(() => {
    insertParams = null;
    const db = {
      run: vi.fn((query, params, callback) => {
        insertParams = params;
        callback.call({ lastID: 1 }, null);
      })
    };
    handlers = new ProjectHandlers({
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      databaseManager: { getDatabase: vi.fn().mockResolvedValue(db) },
      projectService: {}
    });
  });

  it('stores the canonical (resolved) path, not the raw input', async () => {
    await handlers.saveProject({ projectName: 'P', repoUrl: null, projectPath: '/home/user/ws/' });

    expect(insertParams).not.toBeNull();
    expect(insertParams[3]).toBe('/home/user/ws');
  });
});

describe('migrateProjectPaths (one-time DB migration)', () => {
  async function seedTempDatabase() {
    const { DatabaseManager } = await import('../../src/main/database/database.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-paths-'));
    const dbManager = new DatabaseManager({ userDataPath: tmpDir, dbName: 'test.db' });
    await dbManager.initialize();

    const seeded = ['C:/Users/dev/Workspaces', '/home/user/ws', 'C:\\Users\\Dev\\WS'];
    for (let i = 0; i < seeded.length; i += 1) {
      await dbManager.run(
        'INSERT INTO projects (projectName, projectPath) VALUES (?, ?)',
        [`project-${i}`, seeded[i]]
      );
    }
    return { dbManager, seeded, tmpDir };
  }

  it('first run rewrites changed rows per host-platform rules and sets the guard flag', async () => {
    const { dbManager, seeded } = await seedTempDatabase();

    const first = await migrateProjectPaths(dbManager);
    const expectedChanges = seeded.filter((p) => path.resolve(p) !== p).length;
    expect(first.skipped).toBe(false);
    expect(first.migrated).toBe(expectedChanges);

    const rows = await dbManager.all('SELECT projectPath FROM projects ORDER BY id');
    seeded.forEach((original, index) => {
      expect(rows[index].projectPath).toBe(path.resolve(original));
    });

    const flag = await dbManager.getSetting('pathCanonicalization:v1');
    expect(flag).not.toBeNull();

    await dbManager.close();
  });

  it('second run is a no-op (guard flag respected)', async () => {
    const { dbManager } = await seedTempDatabase();

    await migrateProjectPaths(dbManager);
    const afterFirst = await dbManager.all('SELECT projectPath FROM projects ORDER BY id');

    const second = await migrateProjectPaths(dbManager);
    expect(second.skipped).toBe(true);
    expect(second.migrated).toBe(0);

    const afterSecond = await dbManager.all('SELECT projectPath FROM projects ORDER BY id');
    expect(afterSecond).toEqual(afterFirst);

    await dbManager.close();
  });
});
