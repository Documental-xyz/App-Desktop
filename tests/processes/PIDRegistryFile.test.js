/**
 * @fileoverview Unit tests for PIDRegistryFile — async on-disk PID registry
 *   with orphan reaping. Task 11 of perf-zombie-refactor.
 *   GREEN phase: the class is already implemented (Wave 1 Task 3); these
 *   tests lock its documented behavior.
 * @author Documental Team
 * @since 1.1.0
 */

'use strict';

import fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// killPidTree is lazy-required by PIDRegistryFile at reap time. Rather than
// vi.mock (which is unreliable for CJS lazy require), we spy on the *real*
// killPidTree module's export. Because Node caches the module, the spy on
// the required instance is the same object the SUT will receive — so the
// spy observes the call without mocking the implementation away.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PIDRegistryFile } = require('../../src/main/processes/PIDRegistryFile.js');
const killPidTreeModule = require('../../src/main/processes/killPidTree.js');

/**
 * Build a mock process inspector for reapOrphans tests. `map` is a
 * pid -> alive? lookup; the returned processExists resolves accordingly.
 * @param {Record<number, boolean>} map
 */
function makeInspector(map = {}) {
  return {
    processExists: vi.fn(async (pid) => !!map[pid])
  };
}

describe('PIDRegistryFile', () => {
  let tmpDir;
  let registryPath;
  let killPidTreeSpy;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidreg-'));
    registryPath = path.join(tmpDir, 'documental-pids.json');
    // Spy replaces the export on the cached module; getKillPidTree()
    // re-destructures from the same cache at reap time, so the spy is
    // observed. mockImplementation prevents actually signalling processes.
    killPidTreeSpy = vi
      .spyOn(killPidTreeModule, 'killPidTree')
      .mockResolvedValue(undefined);
    // Mock process.kill so the sync probe in reapOrphans succeeds for
    // test PIDs (they don't exist on this machine — no ESRCH from probe).
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });

  afterEach(async () => {
    killPidTreeSpy.mockRestore();
    vi.mocked(process.kill).mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- load
  it('load returns empty array if file missing', async () => {
    const reg = new PIDRegistryFile(registryPath);
    const entries = await reg.load();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(0);
  });

  it('load returns empty array if file corrupt (invalid JSON)', async () => {
    await fs.writeFile(registryPath, '{ this is :: not valid JSON ///', 'utf8');
    const reg = new PIDRegistryFile(registryPath);
    const entries = await reg.load();
    expect(entries).toEqual([]);
  });

  it('load returns empty array if JSON is not an array (e.g. object)', async () => {
    await fs.writeFile(registryPath, JSON.stringify({ pid: 1 }), 'utf8');
    const reg = new PIDRegistryFile(registryPath);
    const entries = await reg.load();
    expect(entries).toEqual([]);
  });

  // ------------------------------------------------------------- register
  it('register adds an entry', async () => {
    const reg = new PIDRegistryFile(registryPath);
    await reg.register(12345, { command: 'npm start', cwd: '/proj', startedAt: 1000 });

    const entries = await reg.load();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      pid: 12345,
      command: 'npm start',
      cwd: '/proj',
      startedAt: 1000
    });
    // parentPid defaults to current process pid when omitted.
    expect(entries[0].parentPid).toBe(process.pid);
  });

  it('register overwrites an existing entry (same pid)', async () => {
    const reg = new PIDRegistryFile(registryPath);
    await reg.register(12345, { command: 'first', cwd: '/a' });
    await reg.register(12345, { command: 'second', cwd: '/b', startedAt: 2222 });

    const entries = await reg.load();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      pid: 12345,
      command: 'second',
      cwd: '/b',
      startedAt: 2222
    });
  });

  // ------------------------------------------------------------ unregister
  it('unregister removes an existing entry', async () => {
    const reg = new PIDRegistryFile(registryPath);
    await reg.register(12345, { command: 'npm start', cwd: '/proj' });
    await reg.unregister(12345);

    const entries = await reg.load();
    expect(entries).toHaveLength(0);
  });

  it('unregister is silent when the pid is not registered', async () => {
    const reg = new PIDRegistryFile(registryPath);
    await expect(reg.unregister(99999)).resolves.toBeUndefined();

    const entries = await reg.load();
    expect(entries).toHaveLength(0);
  });

  // ---------------------------------------------------------- reapOrphans
  it('reapOrphans kills PIDs whose registered parent is dead (orphan)', async () => {
    const reg = new PIDRegistryFile(registryPath);
    // pid 12345 is alive, but its registered parentPid 1000 is dead.
    await reg.register(12345, { command: 'npm start', cwd: '/p', parentPid: 1000 });

    const inspector = makeInspector({ 12345: true, 1000: false });
    const result = await reg.reapOrphans(inspector);

    expect(killPidTreeSpy).toHaveBeenCalledTimes(1);
    expect(killPidTreeSpy).toHaveBeenCalledWith(12345);
    expect(result.reaped).toEqual([12345]);

    // entry dropped from registry after successful reap
    const entries = await reg.load();
    expect(entries).toHaveLength(0);
  });

  it('reapOrphans skips PIDs whose parent is still alive', async () => {
    const reg = new PIDRegistryFile(registryPath);
    await reg.register(22222, { command: 'node', cwd: '/x', parentPid: 1000 });

    const inspector = makeInspector({ 22222: true, 1000: true });
    const result = await reg.reapOrphans(inspector);

    expect(killPidTreeSpy).not.toHaveBeenCalled();
    expect(result.reaped).toEqual([]);

    const entries = await reg.load();
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBe(22222);
  });

  it('reapOrphans removes entries whose PID is already dead (housekeeping)', async () => {
    const reg = new PIDRegistryFile(registryPath);
    // pid 33333 is gone — entry should be dropped without calling killPidTree.
    await reg.register(33333, { command: 'gone', cwd: '/g', parentPid: 1000 });

    const inspector = makeInspector({ 33333: false, 1000: true });
    const result = await reg.reapOrphans(inspector);

    expect(killPidTreeSpy).not.toHaveBeenCalled();
    expect(result.reaped).toEqual([]);

    const entries = await reg.load();
    expect(entries).toHaveLength(0);
  });

  it('reapOrphans throws if inspector is missing processExists', async () => {
    const reg = new PIDRegistryFile(registryPath);
    await expect(reg.reapOrphans({})).rejects.toThrow(/inspector/);
  });

  it('reapOrphans returns empty reaped list for empty registry', async () => {
    const reg = new PIDRegistryFile(registryPath);
    const result = await reg.reapOrphans(makeInspector());
    expect(result).toEqual({ reaped: [] });
  });

  // ----------------------------------------------- implementation contract
  it('uses fs.promises, not fs.*Sync (forbidden in main process)', () => {
    const sutPath = require.resolve('../../src/main/processes/PIDRegistryFile.js');
    const src = require('fs').readFileSync(sutPath, 'utf8');
    expect(src).not.toMatch(/\b\w*Sync\s*\(/);
  });

  it('persists atomically via tmp + rename (no truncated file on crash)', async () => {
    const reg = new PIDRegistryFile(registryPath);
    await reg.register(1, { command: 'a', cwd: '/' });

    // After a successful register, no leftover .tmp file should remain.
    const files = await fs.readdir(tmpDir);
    expect(files).toContain('documental-pids.json');
    expect(files).not.toContain('documental-pids.json.tmp');
  });
});
