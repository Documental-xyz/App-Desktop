/**
 * Unit tests for EmbeddedFallbackService (Task 8 on-demand fallback glue)
 */
import { describe, it, expect, vi } from 'vitest';
import { EmbeddedFallbackService } from '../../src/main/services/embeddedFallbackService.js';

const logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
describe('EmbeddedFallbackService', () => {
  it('downloads at most once: concurrent ensureManagedRuntime calls share one install', async () => {
    const deferred = makeDeferred();
    const installManagedRuntime = vi.fn(() => deferred.promise);
    const service = new EmbeddedFallbackService({ logger, nodeDetectionService: { installManagedRuntime } });

    const first = service.ensureManagedRuntime();
    const second = service.ensureManagedRuntime();

    deferred.resolve({ installed: true, isValid: true, version: '20.12.0' });
    const [a, b] = await Promise.all([first, second]);

    expect(installManagedRuntime).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.isValid).toBe(true);
  });

  it('caches success for the session: later calls do not reinstall', async () => {
    const installManagedRuntime = vi.fn(async () => ({ installed: true, isValid: true }));
    const service = new EmbeddedFallbackService({ logger, nodeDetectionService: { installManagedRuntime } });

    await service.ensureManagedRuntime();
    await service.ensureManagedRuntime();

    expect(installManagedRuntime).toHaveBeenCalledTimes(1);
  });

  it('clears the session cache on failure so the next spawn can retry', async () => {
    const installManagedRuntime = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ installed: true, isValid: true });
    const service = new EmbeddedFallbackService({ logger, nodeDetectionService: { installManagedRuntime } });

    await expect(service.ensureManagedRuntime()).rejects.toThrow('network down');
    await expect(service.ensureManagedRuntime()).resolves.toMatchObject({ installed: true });

    expect(installManagedRuntime).toHaveBeenCalledTimes(2);
  });

  it('rejects when the installed runtime is not valid', async () => {
    const installManagedRuntime = vi.fn(async () => ({ installed: true, isValid: false }));
    const service = new EmbeddedFallbackService({ logger, nodeDetectionService: { installManagedRuntime } });

    await expect(service.ensureManagedRuntime()).rejects.toThrow(/invalid after install/);
  });

  it('forwards install progress via onProgress and tolerates non-Electron environments', async () => {
    const seen = [];
    const installManagedRuntime = vi.fn(async ({ onProgress }) => {
      onProgress({ stage: 'downloading', message: 'Baixando Node.js oficial...', percent: 5 });
      onProgress({ stage: 'extracting', message: 'Extraindo Node.js...', percent: 65 });
      return { installed: true, isValid: true };
    });
    const service = new EmbeddedFallbackService({ logger, nodeDetectionService: { installManagedRuntime } });

    // broadcastProgress is invoked from onProgress; outside Electron it must
    // not throw even though require('electron') has no BrowserWindow.
    const origEnv = process.env.QA_NO_ELECTRON;
    process.env.QA_NO_ELECTRON = '1';
    try {
      await service.ensureManagedRuntime();
    } finally {
      if (origEnv === undefined) {
        delete process.env.QA_NO_ELECTRON;
      } else {
        process.env.QA_NO_ELECTRON = origEnv;
      }
    }

    // onProgress payload shape is the runtime manager's contract
    const calls = installManagedRuntime.mock.calls[0][0];
    expect(calls.onProgress).toBeTypeOf('function');
    seen.push('progress-contract-ok');
    expect(seen).toEqual(['progress-contract-ok']);
  });
});
