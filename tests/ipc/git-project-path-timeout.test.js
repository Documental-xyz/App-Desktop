/**
 * @fileoverview getProjectPath sqlite-callback timeout: a lost db.get
 * callback must not hang every dependent git IPC forever (publish/update
 * dead buttons fix — 5s race).
 * @author Documental Team
 * @since 1.0.0
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock('../../src/ipc/gitOperations.js', () => ({
  GitOperations: vi.fn().mockImplementation(() => ({
    getGitHubToken: vi.fn(),
    configureGitForUser: vi.fn(),
    getCachedUserInfo: vi.fn(),
  })),
}));

const { GitHandlers } = await import('../../src/ipc/git.js');

function makeHandlers(dbGet) {
  return new GitHandlers({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    databaseManager: {
      getDatabase: vi.fn().mockResolvedValue({ get: dbGet }),
    },
  });
}

describe('GitHandlers.getProjectPath timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with a timeout when the sqlite callback never fires', async () => {
    vi.useFakeTimers();
    const handlers = makeHandlers((_sql, _params, cb) => {
      // callback deliberately never invoked (lost callback)
      void cb;
    });
    const promise = handlers.getProjectPath(1);
    const assertion = expect(promise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('resolves the joined repo path on the happy path', async () => {
    const handlers = makeHandlers((_sql, _params, cb) => {
      cb(null, { id: 1, projectPath: '/tmp/base', repoFolderName: 'repo' });
    });
    await expect(handlers.getProjectPath(1)).resolves.toBe('/tmp/base/repo');
  });

  it('keeps pre-existing rejections (missing row)', async () => {
    const handlers = makeHandlers((_sql, _params, cb) => {
      cb(null, undefined);
    });
    await expect(handlers.getProjectPath(1)).rejects.toThrow('Project not found');
  });

  it('keeps pre-existing rejections (db error)', async () => {
    const handlers = makeHandlers((_sql, _params, cb) => {
      cb(new Error('SQLITE_BUSY'));
    });
    await expect(handlers.getProjectPath(1)).rejects.toThrow('SQLITE_BUSY');
  });
});
