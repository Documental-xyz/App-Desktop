/**
 * @fileoverview Tests for ProcessManager.killAll / killPidTree routing
 * (constructor takes nodeDetectionService since Task 6; killAll landed with
 * the embedded-node migration; Task 4 of ajustes-wizard-preview-servicos
 * routes kills through killPidTree(pid); the F3-fix startup-race describe
 * covers closeProject during startDevServer via CloseProjectHandlers DI).
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve as resolvePath } from 'path';

// --- Module mocks -----------------------------------------------------------

// execa is required at the top of processManager.js; stub it so module load is clean.
vi.mock('execa', () => ({
  execa: vi.fn()
}));

// rimraf is required by processManager (cancelProjectCreation); stub it.
vi.mock('rimraf', () => ({
  rimraf: vi.fn().mockResolvedValue(undefined)
}));

// electron is lazily required inside startDevServer's URL-capture path
// (BrowserWindow.getAllWindows 'dev-server-url' broadcast); stub it.
vi.mock('electron', () => {
  const send = vi.fn();
  return {
    BrowserWindow: {
      getAllWindows: vi.fn(() => [
        { isDestroyed: () => false, webContents: { send } }
      ])
    }
  };
});

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

describe('ProcessManager - startDevServer dedupe', () => {
  let mockLogger;
  let mockNodeDetectionService;
  let pm;
  let killPidTreeMock;

  const buildManager = async () => {
    const { ProcessManager } = await import('../../src/ipc/processManager.js');
    const instance = new ProcessManager({
      logger: mockLogger,
      nodeDetectionService: mockNodeDetectionService
    });
    instance._killPidTree = killPidTreeMock;
    instance.resolveRuntimeExecutable = vi.fn().mockResolvedValue({
      command: 'npm', args: [], env: {}, runtime: 'managed'
    });
    instance._trackSpawnedPid = vi.fn();
    instance._untrackSpawnedPid = vi.fn();
    instance.saveDocumentalProcesses = vi.fn().mockResolvedValue(undefined);
    return instance;
  };

  /** Push a stdout chunk through the listeners startDevServer attached. */
  const emitStdout = (fakeProcess, text) => {
    for (const call of fakeProcess.stdout.on.mock.calls) {
      if (call[0] === 'data') {
        call[1](Buffer.from(text));
      }
    }
  };

  /** 'dev-server-url' broadcasts seen by the mocked electron window. */
  const devServerUrlBroadcasts = async () => {
    const electron = await import('electron');
    const window = electron.BrowserWindow.getAllWindows()[0];
    return window.webContents.send.mock.calls.filter(([channel]) => channel === 'dev-server-url');
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const pmModule = await import('../../src/ipc/processManager.js');
    pmModule.releaseProcessManagerLock();

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

    pm = await buildManager();
  });

  afterEach(async () => {
    // Clear module-level maps so tests stay order-independent.
    await pm.killAll();
  });

  it('returns the SAME handle on a 2nd call with the same projectId, without a 2nd spawn', async () => {
    const spawnMock = vi.fn(() => createFakeSubprocess({ pid: 9101 }));
    pm.embeddedRuntimeService.spawnNodeChild = spawnMock;

    const first = await pm.startDevServer('/repos/alpha', 91, vi.fn(), vi.fn());
    expect(spawnMock).toHaveBeenCalledTimes(1);

    emitStdout(first.process, 'ready in 99 ms — http://localhost:4321/');

    const output2 = vi.fn();
    const status2 = vi.fn();
    const second = await pm.startDevServer('/repos/alpha', 91, output2, status2);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(second.process).toBe(first.process);
    expect(second.url).toBe('http://localhost:4321/');
    expect(second.reused).toBe(true);
    expect(status2).toHaveBeenCalledWith('success');
    expect(output2).toHaveBeenCalledWith(expect.stringContaining('reusing existing process'));
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('[devserver] reutilizando server existente para 91')
    );

    // URL broadcast stays idempotent: only the first capture broadcast.
    expect(await devServerUrlBroadcasts()).toHaveLength(1);
  });

  it('dedupes across projectIds when the resolved repoDirPath matches', async () => {
    const spawnMock = vi.fn(() => createFakeSubprocess({ pid: 9201 }));
    pm.embeddedRuntimeService.spawnNodeChild = spawnMock;

    const first = await pm.startDevServer('/repos/beta', 92, vi.fn(), vi.fn());
    emitStdout(first.process, 'ready — http://localhost:4322/');

    const second = await pm.startDevServer('/repos/beta', 93, vi.fn(), vi.fn());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(second.process).toBe(first.process);
    expect(second.url).toBe('http://localhost:4322/');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining(`reutilizando server existente para ${resolvePath('/repos/beta')}`)
    );
    expect(await devServerUrlBroadcasts()).toHaveLength(1);
  });

  it('spawns a new server for a distinct repo (no dedupe)', async () => {
    const pids = [9301, 9302];
    let nextPid = 0;
    const spawnMock = vi.fn(() => createFakeSubprocess({ pid: pids[nextPid++] }));
    pm.embeddedRuntimeService.spawnNodeChild = spawnMock;

    const first = await pm.startDevServer('/repos/gamma', 94, vi.fn(), vi.fn());
    const second = await pm.startDevServer('/repos/delta', 95, vi.fn(), vi.fn());

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(second.process).not.toBe(first.process);
    expect(second.url).toBeNull();
    expect(second.reused).toBeUndefined();
    expect(pm.getActiveProcesses()['dev-94']).toBe(first.process);
    expect(pm.getActiveProcesses()['dev-95']).toBe(second.process);
  });

  it('relays readiness to the re-caller when the reused server is still booting', async () => {
    const spawnMock = vi.fn(() => createFakeSubprocess({ pid: 9401 }));
    pm.embeddedRuntimeService.spawnNodeChild = spawnMock;

    const first = await pm.startDevServer('/repos/epsilon', 96, vi.fn(), vi.fn());

    const status2 = vi.fn();
    const second = await pm.startDevServer('/repos/epsilon', 96, vi.fn(), status2);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(second.process).toBe(first.process);
    expect(second.url).toBeNull();
    expect(status2).not.toHaveBeenCalledWith('success');

    emitStdout(first.process, 'ready — http://localhost:4323/');

    expect(status2).toHaveBeenCalledWith('success');
    expect(await devServerUrlBroadcasts()).toHaveLength(1);
  });
});

describe('ProcessManager - startup race (close during startDevServer)', () => {
  let mockLogger;
  let mockNodeDetectionService;
  let pm;
  let killPidTreeMock;
  let mapFns;
  let closeHandlers;

  /**
   * Fake execa subprocess whose 'spawn' never fires until the test releases
   * it (pid assigned + spawn callbacks invoked) — models the slow spawn of
   * the close-during-startup race. createFakeSubprocess covers the fast path.
   */
  function createPendingSubprocess() {
    const spawnCallbacks = [];
    const fake = createFakeSubprocess({ pid: undefined });
    fake.pid = undefined;
    fake.once = vi.fn((event, cb) => {
      if (event === 'spawn') {
        spawnCallbacks.push(cb);
      }
    });
    fake.emitSpawn = (pendingPid) => {
      fake.pid = pendingPid;
      spawnCallbacks.forEach((cb) => cb());
    };
    return fake;
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    const pmModule = await import('../../src/ipc/processManager.js');
    pmModule.releaseProcessManagerLock();
    mapFns = pmModule;

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

    pm = new mapFns.ProcessManager({
      logger: mockLogger,
      nodeDetectionService: mockNodeDetectionService
    });
    pm._killPidTree = killPidTreeMock;
    pm.resolveRuntimeExecutable = vi.fn().mockResolvedValue({
      command: 'npm', args: [], env: {}, runtime: 'managed'
    });
    pm._trackSpawnedPid = vi.fn();
    pm._untrackSpawnedPid = vi.fn();
    pm.saveDocumentalProcesses = vi.fn().mockResolvedValue(undefined);

    const { CloseProjectHandlers } = await import('../../src/ipc/closeProject.js');
    closeHandlers = new CloseProjectHandlers({ logger: mockLogger, processManager: pm });
  });

  afterEach(async () => {
    await pm.killAll();
  });

  it('close DURING startup terminates the newborn once the spawn lands (no leak)', async () => {
    const slow = createPendingSubprocess();
    pm.embeddedRuntimeService.spawnNodeChild = vi.fn(() => slow);

    const out = vi.fn();
    const status = vi.fn();
    const startPromise = pm.startDevServer('/repos/race', 41, out, status);
    // Do NOT await: closeProject lands while the spawn is still pending.

    mapFns.mapWindowToProject(9, '41');
    const response = await closeHandlers.closeProject(9, 41);

    expect(response).toEqual({ killed: true });
    expect(killPidTreeMock).not.toHaveBeenCalled(); // nothing was born yet

    slow.emitSpawn(5151);
    const result = await startPromise;

    expect(killPidTreeMock).toHaveBeenCalledTimes(1);
    expect(killPidTreeMock).toHaveBeenCalledWith(5151, 300);
    expect(pm.getActiveProcesses()['dev-41']).toBeUndefined();
    expect(status).toHaveBeenCalledWith('failure');
    expect(out).toHaveBeenCalledWith(expect.stringContaining('closed during startup'));
    expect(result.url).toBeNull();
    expect(result.process).toBe(slow);
    // Token registry drained: a later close of the same project is a plain no-op.
    await pm.terminateProjectProcesses(41);
    expect(killPidTreeMock).toHaveBeenCalledTimes(1);
  });

  it('close AFTER registration (normal order) still routes the slot kill', async () => {
    const fast = createFakeSubprocess({ pid: 5252 });
    pm.embeddedRuntimeService.spawnNodeChild = vi.fn(() => fast);

    await pm.startDevServer('/repos/race-2', 42, vi.fn(), vi.fn());
    expect(pm.getActiveProcesses()['dev-42']).toBe(fast);

    mapFns.mapWindowToProject(10, '42');
    const response = await closeHandlers.closeProject(10, 42);

    expect(response).toEqual({ killed: true });
    expect(killPidTreeMock).toHaveBeenCalledWith(5252, 300);
    expect(pm.getActiveProcesses()['dev-42']).toBeUndefined();
  });

  it('legitimate reopen AFTER the raced close survives, dedupes and closes cleanly', async () => {
    const slow = createPendingSubprocess();
    let nextProcess = slow;
    pm.embeddedRuntimeService.spawnNodeChild = vi.fn(() => nextProcess);
    const racedStart = pm.startDevServer('/repos/race', 41, vi.fn(), vi.fn());
    mapFns.mapWindowToProject(9, '41');
    await closeHandlers.closeProject(9, 41);
    slow.emitSpawn(5151);
    await racedStart;
    expect(killPidTreeMock).toHaveBeenCalledWith(5151, 300);

    // Fresh token: the legitimate reopen is never poisoned by the earlier close.
    const reopened = createFakeSubprocess({ pid: 5351 });
    nextProcess = reopened;
    const out = vi.fn();
    const status = vi.fn();
    const first = await pm.startDevServer('/repos/race', 41, out, status);

    expect(first.process).toBe(reopened);
    expect(first.url).toBeNull();
    expect(killPidTreeMock).not.toHaveBeenCalledWith(5351, expect.anything());
    expect(pm.getActiveProcesses()['dev-41']).toBe(reopened);

    // Dedupe intact: a second call with the same id+cwd reuses the survivor.
    const second = await pm.startDevServer('/repos/race', 41, vi.fn(), vi.fn());
    expect(second.process).toBe(reopened);
    expect(second.reused).toBe(true);
    expect(pm.embeddedRuntimeService.spawnNodeChild).toHaveBeenCalledTimes(2); // raced + reopened only
    expect(pm.getActiveProcesses()['dev-41']).toBe(reopened);

    // And the reopened server is terminable through the normal close path.
    mapFns.mapWindowToProject(11, '41');
    const response = await closeHandlers.closeProject(11, 41);
    expect(response).toEqual({ killed: true });
    expect(killPidTreeMock).toHaveBeenCalledWith(5351, 300);
    expect(pm.getActiveProcesses()['dev-41']).toBeUndefined();
  });
});
