/**
 * @fileoverview Tests for ProcessManager.killAll / killPidTree routing
 * (constructor takes nodeDetectionService since Task 6; killAll landed with
 * the embedded-node migration; Task 4 of ajustes-wizard-preview-servicos
 * routes kills through killPidTree(pid)).
 *
 * Lock-guard contract under test (matches GitHandlers pattern in src/ipc/git.js):
 *   1. acquire lock before iterating activeProcesses
 *   2. call killPidTree(pid, gracePeriod) for each tracked PID (deduped)
 *   3. release lock in a `finally` block (even on error)
 *   4. swallow ESRCH (process already dead) so killAll is idempotent
 *
 * @see src/ipc/processManager.js (activeProcesses, acquireProcessManagerLock)
 * @see src/main/processes/killPidTree.js (tree kill helper)
 * @see tests/ipc/git.cancellation.test.js (lock-guard lifecycle test pattern)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Module mocks -----------------------------------------------------------

// execa is required at the top of processManager.js; stub it so module load is clean.
vi.mock('execa', () => ({
  execa: vi.fn()
}));

// rimraf is required by processManager (cancelProjectCreation); stub it.
vi.mock('rimraf', () => ({
  rimraf: vi.fn().mockResolvedValue(undefined)
}));

// PlatformService is constructed in the ProcessManager constructor. Provide a
// minimal stub so `new ProcessManager(...)` does not touch the real adapter
// factory (which would read process.platform / os.homedir).
vi.mock('../../src/main/services/platform/PlatformService.js', () => ({
  PlatformService: class {
    constructor() {
      this.logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    }
    joinPath(...segments) {
      return segments.join('/');
    }
    getHomeDirectory() {
      return '/home/testuser';
    }
    getTerminationSignal() {
      return 'SIGTERM';
    }
    getForceTerminationSignal() {
      return 'SIGKILL';
    }
  }
}));

// --- Helpers ----------------------------------------------------------------

/**
 * Build a fake execa subprocess shaped for PID-routed killing:
 *   - killed: false
 *   - exitCode: null
 *   - pid: number
 *   - kill(signal): returns true AND triggers 'exit' event
 */
function createFakeSubprocess(overrides = {}) {
  const exitCallbacks = [];
  const defaults = {
    killed: false,
    exitCode: null,
    pid: Math.floor(1000 + Math.random() * 9000),
    kill: vi.fn(() => {
      exitCallbacks.forEach((fn) => fn(null, 'SIGTERM'));
      return true;
    }),
    once: vi.fn((event, cb) => {
      if (event === 'exit' || event === 'error') {
        exitCallbacks.push(cb);
      }
    }),
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() }
  };
  return { ...defaults, ...overrides };
}

// --- Test suite -------------------------------------------------------------

describe('ProcessManager - killAll', () => {
  let mockLogger;
  let mockNodeDetectionService;
  let pm;
  let killPidTreeMock;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset the module-level lock in case a previous test leaked it.
    const pmModule = await import('../../src/ipc/processManager.js');
    pmModule.releaseProcessManagerLock();

    // Standalone mock — injected per-test where needed via pm._killPidTree.
    killPidTreeMock = vi.fn().mockResolvedValue(undefined);

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };

    mockNodeDetectionService = {
      getPreferredNpmExecutable: vi.fn().mockResolvedValue('npm'),
      getPreferredNpxExecutable: vi.fn().mockResolvedValue('npx'),
      getPreferredNodeExecutable: vi.fn().mockResolvedValue('node'),
      detectNodeInstallation: vi.fn().mockResolvedValue({ runtime: { installed: false } }),
      getManagedRuntimeEnv: vi.fn((env) => env)
    };

    const { ProcessManager } = await import('../../src/ipc/processManager.js');
    pm = new ProcessManager({
      logger: mockLogger,
      nodeDetectionService: mockNodeDetectionService
    });
  });

  describe('killAll', () => {
    it('should route every tracked PID through killPidTree', async () => {
      const procs = {
        'build-1': createFakeSubprocess({ pid: 1001 }),
        'dev-2': createFakeSubprocess({ pid: 1002 }),
        'misc-3': createFakeSubprocess({ pid: 1003 })
      };
      pm.getActiveProcesses = () => procs;
      pm._killPidTree = killPidTreeMock;

      await expect(pm.killAll()).resolves.not.toThrow();

      expect(killPidTreeMock).toHaveBeenCalledTimes(3);
      expect(killPidTreeMock).toHaveBeenCalledWith(1001, expect.any(Number));
      expect(killPidTreeMock).toHaveBeenCalledWith(1002, expect.any(Number));
      expect(killPidTreeMock).toHaveBeenCalledWith(1003, expect.any(Number));

      // Module-level activeProcesses was cleared. Verify via a fresh
      // instance's getter.
      const { ProcessManager: PM2 } = await import('../../src/ipc/processManager.js');
      const freshPM = new PM2({
        logger: mockLogger,
        nodeDetectionService: mockNodeDetectionService
      });
      expect(freshPM.getActiveProcesses()).toEqual({});
    });

    it('should dedupe PIDs tracked both as subprocess and documental record', async () => {
      pm.getActiveProcesses = () => ({
        'dev-2': createFakeSubprocess({ pid: 2002 })
      });
      pm.getActiveDocumentalProcesses = () => ({
        2002: { pid: 2002, port: 4321, projectId: '2', command: 'npm run dev', cwd: '/p' }
      });
      pm._killPidTree = killPidTreeMock;

      await pm.killAll();

      // The same tree must only be signalled once.
      expect(killPidTreeMock).toHaveBeenCalledTimes(1);
      expect(killPidTreeMock).toHaveBeenCalledWith(2002, expect.any(Number));
    });

    it('should hold the lock while killing (concurrent killAll rejects busy)', async () => {
      pm.getActiveProcesses = () => ({
        'p-1': createFakeSubprocess({ pid: 2001 })
      });
      pm._killPidTree = killPidTreeMock;

      // Gate the in-flight kill so we can probe the lock mid-iteration.
      let releaseKill;
      const gate = new Promise((resolve) => { releaseKill = resolve; });
      killPidTreeMock.mockImplementation(() => new Promise((resolve) => gate.then(resolve)));

      const first = pm.killAll();
      await vi.waitFor(() => expect(killPidTreeMock).toHaveBeenCalled());

      // While the first killAll is iterating, a second one must be rejected.
      await expect(pm.killAll()).rejects.toThrow('Process manager busy');

      releaseKill();
      await first;

      // After completion the lock is released — a new killAll succeeds.
      pm.getActiveProcesses = () => ({});
      await expect(pm.killAll()).resolves.toBeUndefined();
    });

    it('should release processManagerLock in finally even on error', async () => {
      pm.getActiveProcesses = () => ({
        'bad-1': createFakeSubprocess({ pid: 3001 })
      });
      pm._killPidTree = killPidTreeMock;

      // killAll must not propagate the lock — release happens in finally.
      let reachedKill = false;
      killPidTreeMock.mockImplementation(() => {
        reachedKill = true;
        return Promise.reject(new Error('boom'));
      });

      await pm.killAll();

      // killAll MUST have been invoked (reached the iteration step).
      expect(reachedKill).toBe(true);

      // Re-acquire should succeed (proves lock was released). If the lock was
      // NOT released, this throws "Process manager busy".
      expect(() => {
        const { acquireProcessManagerLock } = require('../../src/ipc/processManager.js');
        acquireProcessManagerLock('test-after-killAll');
        require('../../src/ipc/processManager.js').releaseProcessManagerLock();
      }).not.toThrow();
    });

    it('should be idempotent (call killAll 3x in sequence without throwing)', async () => {
      pm.getActiveProcesses = () => ({
        'p-1': createFakeSubprocess({ pid: 4001 })
      });
      pm._killPidTree = killPidTreeMock;

      await pm.killAll();
      pm.getActiveProcesses = () => ({});
      await pm.killAll();
      await pm.killAll();

      expect(true).toBe(true);
    });

    it('should handle ESRCH gracefully (killPidTree rejects with ESRCH)', async () => {
      const esrch = new Error('kill ESRCH');
      esrch.code = 'ESRCH';

      pm.getActiveProcesses = () => ({
        'esrch-1': createFakeSubprocess({ pid: 5001 })
      });
      pm._killPidTree = killPidTreeMock;
      killPidTreeMock.mockRejectedValue(esrch);

      // killAll must swallow ESRCH, not propagate.
      await expect(pm.killAll()).resolves.not.toThrow();
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('error killing process'),
        expect.anything()
      );
    });
  });

  describe('killPidTree integration', () => {
    it('should forward a finite gracePeriod to killPidTree (two-phase budget)', async () => {
      const proc = createFakeSubprocess({ pid: 6001 });
      pm.getActiveProcesses = () => ({ 'tp-1': proc });
      pm._killPidTree = killPidTreeMock;

      killPidTreeMock.mockImplementationOnce(async (pid, gracePeriod) => {
        expect(pid).toBe(6001);
        expect(gracePeriod).toEqual(expect.any(Number));
        expect(gracePeriod).toBeGreaterThan(0);
      });

      await pm.killAll();

      expect(killPidTreeMock).toHaveBeenCalledWith(6001, expect.any(Number));
    });
  });

  describe('terminateProcessesForProject key filter', () => {
    it('should terminate dev-, build-, build-* and reopen- keys for the project', async () => {
      const procs = {
        'dev-5': createFakeSubprocess({ pid: 7101 }),
        'build-5': createFakeSubprocess({ pid: 7102 }),
        'build-5-install': createFakeSubprocess({ pid: 7103 }),
        'reopen-5': createFakeSubprocess({ pid: 7104 }),
        'dev-6': createFakeSubprocess({ pid: 7105 }),
        'misc': createFakeSubprocess({ pid: 7106 })
      };
      pm.getActiveProcesses = () => procs;
      pm._killPidTree = killPidTreeMock;

      await pm.terminateProcessesForProject(5);

      const killedPids = killPidTreeMock.mock.calls.map(([pid]) => pid);
      expect(killedPids).toEqual(expect.arrayContaining([7101, 7102, 7103, 7104]));
      expect(killedPids).not.toContain(7105);
      expect(killedPids).not.toContain(7106);
    });

    it('should route terminateProcessByKey through killPidTree with a short grace', async () => {
      pm.getActiveProcesses = () => ({
        'dev-9': createFakeSubprocess({ pid: 7201 })
      });
      pm._killPidTree = killPidTreeMock;
      killPidTreeMock.mockResolvedValue(undefined);

      await pm.terminateProcessByKey('dev-9');

      expect(killPidTreeMock).toHaveBeenCalledWith(7201, expect.any(Number));
      expect(killPidTreeMock.mock.calls[0][1]).toBeLessThanOrEqual(1000);
    });

    it('should finalize without killing an already-exited process', async () => {
      pm.getActiveProcesses = () => ({
        'dev-10': createFakeSubprocess({ pid: 7301, exitCode: 0 })
      });
      pm._killPidTree = killPidTreeMock;

      await pm.terminateProcessByKey('dev-10');

      expect(killPidTreeMock).not.toHaveBeenCalled();
    });
  });
});
