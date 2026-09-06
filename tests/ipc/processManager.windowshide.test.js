/**
 * @fileoverview Locks the forced-windowsHide semantics on ProcessManager's
 * execa spawn paths (T3/T4, windows-console-elimination).
 *
 * runTrackedCommand must always hand windowsHide: true to the spawn layer:
 * via the spawnOptions literal for the embedded branch (asserted here via
 * an instance-method spy on spawnNodeChild — vi.mock('execa') cannot
 * intercept the manager's CJS require, see embedded-runtime.test.js) and
 * via the same merged options for the direct-execa branch (exercised with
 * a REAL spawn; its literal is covered by tests/static-assertions.test.js).
 *
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Real fs/path for the native temp cwd (setup.js mocks both for the module
// graph; a REAL platform-native directory is needed to spawn into).
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

// PlatformService stub — keeps the constructor off the real platform adapter.
vi.mock('../../src/main/services/platform/PlatformService.js', () => ({
  PlatformService: class {
    constructor() {}
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

function makeNativeCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pm-windowshide-'));
}

/**
 * Minimal execa-subprocess stub: EventEmitter core + stdout/stderr
 * emitters + kill(). Emits 'spawn' then 'exit'(0) on the macrotask queue,
 * after runTrackedCommand has attached its listeners synchronously.
 * @returns {EventEmitter} stub subprocess
 */
function makeStubSubprocess() {
  const subprocess = new EventEmitter();
  subprocess.stdout = new EventEmitter();
  subprocess.stderr = new EventEmitter();
  subprocess.kill = vi.fn();
  setImmediate(() => {
    subprocess.emit('spawn');
    subprocess.emit('exit', 0);
  });
  return subprocess;
}

describe('ProcessManager forced windowsHide (T3/T4)', () => {
  let pm;
  let mockLogger;
  let nativeCwd;

  beforeEach(() => {
    mockLogger = logger();
    pm = new ProcessManager({
      logger: mockLogger,
      nodeDetectionService: {
        installManagedRuntime: vi.fn(),
        getManagedRuntimeEnv: vi.fn((env) => env),
        runtimeManager: {
          getNodeExecutablePath: () => '/userData/node-runtime/bin/node',
          getNpmExecutablePath: () => '/userData/node-runtime/bin/npm',
          getNpxExecutablePath: () => '/userData/node-runtime/bin/npx'
        }
      }
    });
    nativeCwd = makeNativeCwd();
  });

  describe('runTrackedCommand viaEmbeddedRuntime=true', () => {
    it('Given a spy on spawnNodeChild, When runTrackedCommand runs, Then the options carry windowsHide: true', async () => {
      const spawnSpy = vi
        .spyOn(pm.embeddedRuntimeService, 'spawnNodeChild')
        .mockImplementation(() => makeStubSubprocess());

      const sendOutput = vi.fn();
      await pm.runTrackedCommand(
        process.execPath,
        [],
        ['-e', 'process.exit(0)'],
        { ...process.env },
        nativeCwd,
        'windowshide-probe-1',
        sendOutput,
        true
      );

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const [spyCmd, spyArgs, spyOpts] = spawnSpy.mock.calls[0];
      expect(spyCmd).toBe(process.execPath);
      expect(spyArgs).toContain('-e');
      expect(spyOpts.windowsHide).toBe(true);
    });
  });

  describe('runTrackedCommand viaEmbeddedRuntime=false (real execa)', () => {
    it('Given a real spawn target, When runTrackedCommand runs with the merged windowsHide options, Then the spawn completes', async () => {
      // PATH-resolved 'node' (not process.execPath): keeps the win32
      // shell-host path (PRE-EXISTING spaced-execPath quoting bug, out of
      // scope) out of the smoke while still exercising the merged options.
      const sendOutput = vi.fn();
      await pm.runTrackedCommand(
        'node',
        [],
        ['--version'],
        { ...process.env },
        nativeCwd,
        'windowshide-probe-2',
        sendOutput,
        false
      );

      expect(sendOutput).toHaveBeenCalled();
    });
  });
});
