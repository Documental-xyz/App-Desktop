/**
 * @fileoverview Tests for killPidTree helper.
 * Covers Unix two-phase (SIGTERM -> grace -> SIGKILL), Windows taskkill /T /F,
 * ESRCH (already dead), EPERM (no permission), gracePeriod timing, and PID validation.
 * The implementation lives in `src/main/processes/killPidTree.js` (Wave 1 Task 1).
 * @author Thiago Paixao
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// vitest does not reliably intercept CJS require('child_process') of a Node
// builtin under --experimental-require-module. Mutate the real CJS module's
// execFile BEFORE requiring the impl via createRequire, so both share the same
// Node CJS cache and the impl picks up the stubbed execFile.
const nodeRequire = createRequire(import.meta.url);
const childProcess = nodeRequire('child_process');

const execFileCalls = [];
let latestExecFileCallback = null;
childProcess.execFile = function stubExecFile(cmd, args, cb) {
  execFileCalls.push({ cmd, args });
  latestExecFileCallback = cb;
};

vi.mock('tree-kill', () => vi.fn());

const implPath = fileURLToPath(
  new URL('../../src/main/processes/killPidTree.js', import.meta.url)
);
const { killPidTree } = nodeRequire(implPath);

/**
 * Build a Node.js syscall-style error object.
 * @param {string} code - Error code (ESRCH, EPERM, etc.)
 * @param {string} [syscall='kill']
 * @returns {Error & { code: string, syscall: string }}
 */
function syscallError(code, syscall = 'kill') {
  const err = new Error(`${syscall} ${code}`);
  err.code = code;
  err.syscall = syscall;
  return err;
}

describe('killPidTree', () => {
  let killSpy;
  let warnSpy;
  let originalPlatform;

  beforeEach(() => {
    vi.clearAllMocks();
    execFileCalls.length = 0;
    latestExecFileCallback = null;
    originalPlatform = process.platform;
    killSpy = vi.spyOn(process, 'kill');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    killSpy.mockRestore();
    warnSpy.mockRestore();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true
    });
    vi.useRealTimers();
  });

  /** Helper to force a platform value. */
  function setPlatform(platform) {
    Object.defineProperty(process, 'platform', {
      value: platform,
      writable: true,
      configurable: true
    });
  }

  describe('Unix two-phase kill', () => {
    beforeEach(() => {
      setPlatform('linux');
    });

    it('should send SIGTERM then SIGKILL on Unix when process survives grace period', async () => {
      // SIGTERM succeeds, existence check (pid, 0) succeeds (alive), SIGKILL succeeds.
      killSpy.mockImplementation(() => {});

      await killPidTree(12345, 100);

      // Three calls: (-pid, 'SIGTERM'), (pid, 0), (-pid, 'SIGKILL')
      expect(killSpy).toHaveBeenCalledTimes(3);
      expect(killSpy).toHaveBeenNthCalledWith(1, -12345, 'SIGTERM');
      expect(killSpy).toHaveBeenNthCalledWith(2, 12345, 0);
      expect(killSpy).toHaveBeenNthCalledWith(3, -12345, 'SIGKILL');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should kill process group via negative -pid on Unix', async () => {
      // After SIGTERM, existence check throws ESRCH (process died) → no SIGKILL.
      killSpy
        .mockImplementationOnce(() => {}) // (-pid, SIGTERM) ok
        .mockImplementationOnce(() => {
          throw syscallError('ESRCH');
        }); // (pid, 0) → dead

      await killPidTree(999, 50);

      // Verify negative pid was used for the group signal.
      expect(killSpy).toHaveBeenCalledWith(-999, 'SIGTERM');
      // Only two calls: SIGTERM then existence check; no SIGKILL needed.
      expect(killSpy).toHaveBeenCalledTimes(2);
    });

    it('should send SIGTERM then SIGKILL when process dies during grace (ESRCH on check after survival)', async () => {
      // SIGTERM ok → check says alive (kill(pid,0) ok) → SIGKILL throws ESRCH (died between).
      killSpy
        .mockImplementationOnce(() => {}) // SIGTERM ok
        .mockImplementationOnce(() => {}) // (pid, 0) → alive
        .mockImplementationOnce(() => {
          throw syscallError('ESRCH');
        }); // SIGKILL finds it dead — fine

      await expect(killPidTree(777, 10)).resolves.toBeUndefined();
      expect(killSpy).toHaveBeenNthCalledWith(3, -777, 'SIGKILL');
    });

    it('should respect gracePeriod — SIGKILL not sent before grace elapses', async () => {
      vi.useFakeTimers();
      killSpy.mockImplementation(() => {}); // all calls succeed

      // Start the kill; it awaits a setTimeout(gracePeriod).
      const promise = killPidTree(4242, 5000);

      // Allow microtasks (SIGTERM) to flush.
      await Promise.resolve();
      await Promise.resolve();

      // At this point only SIGTERM should have fired.
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenNthCalledWith(1, -4242, 'SIGTERM');

      // Advance past grace period.
      vi.advanceTimersByTime(5000);
      await promise;

      // Now existence check + SIGKILL should have fired.
      expect(killSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('ESRCH handling (already dead)', () => {
    beforeEach(() => {
      setPlatform('linux');
    });

    it('should swallow ESRCH on initial SIGTERM (process group already dead)', async () => {
      killSpy.mockImplementation(() => {
        throw syscallError('ESRCH');
      });

      await expect(killPidTree(555, 10)).resolves.toBeUndefined();
      // Only the first SIGTERM attempt; returns early.
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('EPERM handling (no permission)', () => {
    beforeEach(() => {
      setPlatform('linux');
    });

    it('should log warning on EPERM sending SIGTERM but continue to SIGKILL', async () => {
      // SIGTERM EPERM → warn → fall through. Existence check ok (alive). SIGKILL ok.
      killSpy
        .mockImplementationOnce(() => {
          throw syscallError('EPERM');
        }) // SIGTERM EPERM
        .mockImplementationOnce(() => {}) // (pid, 0) alive
        .mockImplementationOnce(() => {}); // SIGKILL ok

      await killPidTree(31337, 10);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('EPERM sending SIGTERM to process group -31337')
      );
      expect(killSpy).toHaveBeenNthCalledWith(3, -31337, 'SIGKILL');
    });

    it('should log warning on EPERM sending SIGKILL and not throw', async () => {
      // SIGTERM ok → alive → SIGKILL throws EPERM → warn, return.
      killSpy
        .mockImplementationOnce(() => {}) // SIGTERM ok
        .mockImplementationOnce(() => {}) // alive
        .mockImplementationOnce(() => {
          throw syscallError('EPERM');
        }); // SIGKILL EPERM

      await expect(killPidTree(8888, 10)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('EPERM sending SIGKILL to process group -8888')
      );
    });
  });

  describe('unexpected syscall errors (defensive warn paths)', () => {
    beforeEach(() => {
      setPlatform('linux');
    });

    it('should warn on unexpected error sending SIGTERM and still continue', async () => {
      killSpy
        .mockImplementationOnce(() => {
          const e = new Error('boom');
          e.code = 'EUNKNOWN';
          throw e;
        }) // SIGTERM unexpected
        .mockImplementationOnce(() => {}) // (pid, 0) alive
        .mockImplementationOnce(() => {}); // SIGKILL ok

      await killPidTree(4321, 10);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/unexpected error sending SIGTERM to -4321/)
      );
    });

    it('should treat EPERM on existence check as alive and proceed to SIGKILL', async () => {
      killSpy
        .mockImplementationOnce(() => {}) // SIGTERM ok
        .mockImplementationOnce(() => {
          throw syscallError('EPERM');
        }) // (pid, 0) EPERM → alive
        .mockImplementationOnce(() => {}); // SIGKILL ok

      await killPidTree(5544, 10);

      expect(killSpy).toHaveBeenNthCalledWith(3, -5544, 'SIGKILL');
    });

    it('should warn on unexpected error sending SIGKILL (non-ESRCH, non-EPERM)', async () => {
      killSpy
        .mockImplementationOnce(() => {}) // SIGTERM ok
        .mockImplementationOnce(() => {}) // alive
        .mockImplementationOnce(() => {
          const e = new Error('kaboom');
          e.code = 'EAGAIN';
          throw e;
        }); // SIGKILL unexpected

      await expect(killPidTree(6677, 10)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/error sending SIGKILL to -6677: kaboom/)
      );
    });
  });

  describe('Windows path', () => {
    beforeEach(() => {
      setPlatform('win32');
    });

    it('should use taskkill /T /F on Windows with correct args', async () => {
      const promise = killPidTree(5050);
      expect(execFileCalls).toHaveLength(1);
      expect(execFileCalls[0]).toEqual({
        cmd: 'taskkill',
        args: ['/pid', '5050', '/T', '/F']
      });

      latestExecFileCallback(null, 'success', '');
      await expect(promise).resolves.toBeUndefined();
    });

    it('should resolve when taskkill reports process not found (already dead)', async () => {
      const promise = killPidTree(6060);
      const err = new Error('process not found');
      latestExecFileCallback(err, '', 'ERROR: The process not found.');
      await expect(promise).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should warn and resolve on other taskkill errors (no throw)', async () => {
      const promise = killPidTree(7070);
      const err = new Error('access denied');
      latestExecFileCallback(err, '', 'Access is denied.');
      await expect(promise).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('taskkill failed for PID 7070')
      );
    });
  });

  describe('PID validation', () => {
    it('should throw on pid=0', async () => {
      await expect(killPidTree(0)).rejects.toThrow(/invalid PID 0/);
    });

    it('should throw on negative pid', async () => {
      await expect(killPidTree(-1)).rejects.toThrow(/invalid PID -1/);
    });

    it('should throw on non-numeric pid', async () => {
      await expect(killPidTree('abc')).rejects.toThrow(/invalid PID abc/);
    });

    it('should throw on non-integer pid', async () => {
      await expect(killPidTree(12.5)).rejects.toThrow(/invalid PID 12\.5/);
    });
  });
});
