/**
 * @fileoverview Embedded-runtime fallback integration tests for ProcessManager
 * (Task 8 wiring / Task 11). Uses REAL spawns of process.execPath (execa
 * cannot be vi.mock'ed for the manager's CJS require — see learnings).
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// PlatformService stub — keeps the constructor off the real platform adapter.
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
  }
}));

import { ProcessManager } from '../../src/ipc/processManager.js';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

function makeNodeDetectionService() {
  return {
    installManagedRuntime: vi.fn().mockResolvedValue({ installed: true, isValid: true, version: '20.12.0' }),
    getManagedRuntimeEnv: vi.fn((env) => ({ ...env, MANAGED: '1' })),
    runtimeManager: {
      getNodeExecutablePath: () => '/userData/node-runtime/bin/node',
      getNpmExecutablePath: () => '/userData/node-runtime/bin/npm',
      getNpxExecutablePath: () => '/userData/node-runtime/bin/npx'
    }
  };
}

describe('ProcessManager embedded runtime fallback', () => {
  let pm;
  let mockLogger;
  let mockNodeDetectionService;
  let savedDisableEmbedded;

  beforeEach(() => {
    mockLogger = logger();
    mockNodeDetectionService = makeNodeDetectionService();
    pm = new ProcessManager({ logger: mockLogger, nodeDetectionService: mockNodeDetectionService });
    // runTrackedCommand consumes spawnNodeChild's result via events, never
    // awaiting the promise — a failing child leaves it unhandled (pre-existing
    // upstream pattern). Attach a no-op catch so vitest sees zero errors.
    const realSpawn = pm.embeddedRuntimeService.spawnNodeChild.bind(pm.embeddedRuntimeService);
    pm.embeddedRuntimeService.spawnNodeChild = (...spawnArgs) => {
      const subprocess = realSpawn(...spawnArgs);
      Promise.resolve(subprocess).catch(() => {});
      return subprocess;
    };
    savedDisableEmbedded = process.env.DOCUMENTAL_DISABLE_EMBEDDED;
    delete process.env.DOCUMENTAL_DISABLE_EMBEDDED;
  });

  afterEach(() => {
    if (savedDisableEmbedded === undefined) {
      delete process.env.DOCUMENTAL_DISABLE_EMBEDDED;
    } else {
      process.env.DOCUMENTAL_DISABLE_EMBEDDED = savedDisableEmbedded;
    }
  });

  describe('resolveRuntimeExecutable precedence', () => {
    it('prefers the embedded runtime when available', async () => {
      const descriptor = await pm.resolveRuntimeExecutable('node', { PATH: '/usr/bin' }, 'p-embed');

      expect(descriptor.runtime).toBe('embedded');
      expect(descriptor.command).toBe(process.execPath);
      expect(mockNodeDetectionService.installManagedRuntime).not.toHaveBeenCalled();
    });

    it('DOCUMENTAL_DISABLE_EMBEDDED=1 forces the managed runtime and triggers install', async () => {
      process.env.DOCUMENTAL_DISABLE_EMBEDDED = '1';

      const descriptor = await pm.resolveRuntimeExecutable('node', { PATH: '/usr/bin' }, 'p-managed');

      expect(descriptor.runtime).toBe('managed');
      expect(descriptor.command).toBe('/userData/node-runtime/bin/node');
      expect(mockNodeDetectionService.installManagedRuntime).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeCommand fallback semantics', () => {
    it('a non-zero exit does NOT trigger the managed fallback install', async () => {
      // Real spawn via the embedded runtime: exits 3 on purpose.
      await expect(
        pm.executeCommand('node', ['-e', 'process.exit(3)'], '/tmp', 'p-exit3', () => {})
      ).rejects.toThrow(/code 3/);

      expect(mockNodeDetectionService.installManagedRuntime).not.toHaveBeenCalled();
    });

    it('a successful embedded spawn never consults the fallback service', async () => {
      await expect(
        pm.executeCommand('node', ['-p', '40+2'], '/tmp', 'p-ok', () => {})
      ).resolves.toBeUndefined();

      expect(mockNodeDetectionService.installManagedRuntime).not.toHaveBeenCalled();
    });

    it('a STARTUP failure of the embedded runtime retries once via the managed runtime', async () => {
      let call = 0;
      pm.runTrackedCommand = vi.fn(async (actualCommand, prefixArgs) => {
        call += 1;
        if (call === 1) {
          throw Object.assign(new Error('Command failed to spawn'), { isStartupError: true });
        }
      });

      await expect(
        pm.executeCommand('node', ['-p', '1'], '/tmp', 'p-startup', () => {})
      ).resolves.toBeUndefined();

      // First attempt: embedded descriptor; retry: managed descriptor
      expect(pm.runTrackedCommand).toHaveBeenCalledTimes(2);
      expect(pm.runTrackedCommand.mock.calls[0][0]).toBe(process.execPath);
      expect(pm.runTrackedCommand.mock.calls[1][0]).toBe('/userData/node-runtime/bin/node');
      expect(mockNodeDetectionService.installManagedRuntime).toHaveBeenCalledTimes(1);
    });
  });
});
