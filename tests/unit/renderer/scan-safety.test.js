/**
 * @fileoverview Unit tests for renderer/shared/scan-safety.js — the
 * ScanSafety plain-browser-global helper (safety timeout + epoch guard).
 *
 * The renderer file is NOT a module (no require/import/module.exports), so
 * it is loaded via node:vm with a stubbed `window`. Main-realm timers are
 * seeded into the vm context so vi.useFakeTimers() / vi.advanceTimersByTime
 * drive the setTimeout/clearTimeout calls the script makes.
 *
 * Verified empirically (see RED-phase notes): bare vm.createContext() has no
 * setTimeout, and unhandled rejections raised inside a vm context DO surface
 * on process 'unhandledRejection' in the host realm — so the spy assertions
 * in the late-rejection test are meaningful.
 * @author Documental Team
 * @since 1.0.0
 */

import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';

// tests/setup.js mocks 'fs'/'path'; pull the REAL fs so the renderer source
// can be read from disk (same pattern as tests/build-scripts.test.js).
const realFs = await vi.importActual('fs');

const code = realFs.readFileSync(
  fileURLToPath(new URL('../../../renderer/shared/scan-safety.js', import.meta.url)),
  'utf8'
);

let createEpoch;
let runWithSafetyTimeout;

beforeEach(() => {
  vi.useFakeTimers();
  // Seed the faked main-realm timers into the vm context so the browser
  // script's setTimeout/clearTimeout calls are under fake-timer control.
  const ctx = { window: {}, setTimeout, clearTimeout };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  ({ createEpoch, runWithSafetyTimeout } = ctx.window.ScanSafety);
});

afterEach(() => {
  vi.useRealTimers();
});

test('resolves { status: "ok", value } when fn settles before the timeout, and clears the timer', async () => {
  const outcome = await runWithSafetyTimeout(() => Promise.resolve(42), 1000);

  expect(outcome).toEqual({ status: 'ok', value: 42 });
  // Timer must have been cleared on settlement — nothing pending.
  expect(vi.getTimerCount()).toBe(0);

  // Advancing far past timeoutMs must not fire anything (timer was cleared):
  // no state change, still { status: 'ok', value: 42 }.
  vi.advanceTimersByTime(5000);
  expect(vi.getTimerCount()).toBe(0);
  expect(outcome).toEqual({ status: 'ok', value: 42 });
});

test('resolves { status: "timeout" } when fn never settles before timeoutMs', async () => {
  const outcome = runWithSafetyTimeout(() => new Promise(() => {}), 1000);

  expect(vi.getTimerCount()).toBe(1);

  vi.advanceTimersByTime(1000);
  expect(await outcome).toEqual({ status: 'timeout' });
  expect(vi.getTimerCount()).toBe(0);
});

test('propagates fn rejection to the caller and clears the timer', async () => {
  const err = new Error('scan failed');

  await expect(runWithSafetyTimeout(() => Promise.reject(err), 1000)).rejects.toBe(err);
  expect(vi.getTimerCount()).toBe(0);
});

test('ignores a late settlement after timeout with no unhandled rejection', async () => {
  let rejectLate;
  const never = new Promise((_, reject) => {
    rejectLate = reject;
  });
  const outcome = runWithSafetyTimeout(() => never, 1000);

  vi.advanceTimersByTime(1000);
  expect(await outcome).toEqual({ status: 'timeout' });

  const onUnhandledRejection = vi.fn();
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    // A late rejection of the work promise must be consumed by the helper's
    // no-op catch — never surfaced as an unhandled rejection.
    rejectLate(new Error('late rejection'));
    // Flush the microtask queue so any unhandled rejection would be reported
    // by the time the assertion runs.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(onUnhandledRejection).not.toHaveBeenCalled();
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }

  // Late resolution after timeout is ignored — outcome stays {status:'timeout'}.
  expect(await outcome).toEqual({ status: 'timeout' });
});

test('epoch: isCurrent() distinguishes fresh vs stale tokens across advance()', () => {
  const epoch = createEpoch();
  const tokenA = epoch.current();
  expect(epoch.isCurrent(tokenA)).toBe(true);

  const tokenB = epoch.advance();
  expect(epoch.current()).not.toBe(tokenA);
  expect(epoch.current()).toBe(tokenB);
  expect(epoch.isCurrent(tokenA)).toBe(false);
  expect(epoch.isCurrent(tokenB)).toBe(true);
});
