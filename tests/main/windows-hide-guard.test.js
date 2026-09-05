/**
 * @fileoverview Tests for the global Windows windowsHide guard.
 * Uses fake child_process objects (no real modules needed).
 * The implementation lives in `src/main/processes/windows-hide-guard.js`.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const nodeRequire = createRequire(import.meta.url);
const implPath = fileURLToPath(
  new URL('../../src/main/processes/windows-hide-guard.js', import.meta.url)
);
const { installWindowsHideGuard } = nodeRequire(implPath);

/** Build a fake child_process with vi.fn() stubs capturing args. */
function makeFakeCp() {
  const cp = {};
  for (const name of ['spawn', 'exec', 'execFile', 'execSync', 'spawnSync', 'fork']) {
    cp[name] = vi.fn((...args) => ({ name, args }));
  }
  return cp;
}

describe('installWindowsHideGuard', () => {
  it('installs on win32 and forces windowsHide on spawn(cmd, args)', () => {
    const cp = makeFakeCp();
    const originalSpawn = cp.spawn;
    expect(installWindowsHideGuard(cp, 'win32')).toBe(true);

    cp.spawn('node', ['-v']);
    expect(originalSpawn).toHaveBeenCalledTimes(1);
    const args = originalSpawn.mock.calls[0];
    const last = args[args.length - 1];
    expect(last).toMatchObject({ windowsHide: true });
  });

  it('patches spawn(cmd, args, opts) merging into existing options', () => {
    const cp = makeFakeCp();
    const originalSpawn = cp.spawn;
    installWindowsHideGuard(cp, 'win32');

    cp.spawn('node', ['-v'], { stdio: 'ignore' });
    const args = originalSpawn.mock.calls[0];
    expect(args[2]).toEqual({ stdio: 'ignore', windowsHide: true });
  });

  it('patches spawn(cmd, opts) single-object form', () => {
    const cp = makeFakeCp();
    const originalSpawn = cp.spawn;
    installWindowsHideGuard(cp, 'win32');

    cp.spawn('node', { cwd: '/tmp' });
    const args = originalSpawn.mock.calls[0];
    expect(args[1]).toEqual({ cwd: '/tmp', windowsHide: true });
  });

  it('inserts options before callback for execFile(cmd, args, cb)', () => {
    const cp = makeFakeCp();
    const originalExecFile = cp.execFile;
    installWindowsHideGuard(cp, 'win32');

    const cb = vi.fn();
    cp.execFile('cmd', ['a'], cb);
    const args = originalExecFile.mock.calls[0];
    // Callback stays last, options precede it with windowsHide:true.
    expect(args[args.length - 1]).toBe(cb);
    expect(args[args.length - 2]).toEqual({ windowsHide: true });
  });

  it('patches execFile(cmd, args, opts, cb) opts in place', () => {
    const cp = makeFakeCp();
    const originalExecFile = cp.execFile;
    installWindowsHideGuard(cp, 'win32');

    const cb = vi.fn();
    cp.execFile('cmd', ['a'], { timeout: 5 }, cb);
    const args = originalExecFile.mock.calls[0];
    expect(args[args.length - 1]).toBe(cb);
    expect(args[args.length - 2]).toEqual({ timeout: 5, windowsHide: true });
  });

  it('is idempotent: second install returns false and does not double-wrap', () => {
    const cp = makeFakeCp();
    const originalSpawn = cp.spawn;
    expect(installWindowsHideGuard(cp, 'win32')).toBe(true);
    const wrappedSpawn = cp.spawn;
    expect(installWindowsHideGuard(cp, 'win32')).toBe(false);
    expect(cp.spawn).toBe(wrappedSpawn);

    cp.spawn('node', ['-v']);
    cp.spawn('node', ['-v']);
    // Underlying impl called once per spawn (2 total), not doubled.
    expect(originalSpawn).toHaveBeenCalledTimes(2);
  });

  it('is a no-op on linux: returns false and leaves spawn untouched', () => {
    const cp = makeFakeCp();
    const originalSpawn = cp.spawn;
    expect(installWindowsHideGuard(cp, 'linux')).toBe(false);
    expect(cp.spawn).toBe(originalSpawn);

    const ret = cp.spawn('node', ['-v']);
    const args = originalSpawn.mock.calls[0];
    // No windowsHide injected.
    expect(args).toEqual(['node', ['-v']]);
    expect(ret).toEqual({ name: 'spawn', args: ['node', ['-v']] });
  });

  it('passes through the original return value', () => {
    const sentinel = { pid: 1234 };
    const cp = { spawn: vi.fn(() => sentinel) };
    installWindowsHideGuard(cp, 'win32');
    expect(cp.spawn('node', ['-v'])).toBe(sentinel);
  });
});
