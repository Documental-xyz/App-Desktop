/**
 * @fileoverview Unit tests for renderer/shared/modalGuards.js —
 * invokeWithTimeout must bound hung IPC invokes so a stalled git
 * subprocess can never freeze modal opening (publish/update dead
 * buttons fix).
 * @author Documental Team
 * @since 1.0.0
 * @vitest-environment node
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
const { invokeWithTimeout } = require('../../renderer/shared/modalGuards.js');

describe('invokeWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the value when the promise settles before the deadline', async () => {
    await expect(invokeWithTimeout(Promise.resolve('ok'), 5000)).resolves.toBe('ok');
  });

  it('rejects with an IPC timeout when the promise never settles', async () => {
    vi.useFakeTimers();
    const pending = invokeWithTimeout(new Promise(() => {}), 1000);
    const assertion = expect(pending).rejects.toThrow(/IPC timeout after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('clears the deadline timer once settled (no stray late rejection)', async () => {
    vi.useFakeTimers();
    const result = invokeWithTimeout(Promise.resolve(42), 1000);
    await expect(result).resolves.toBe(42);
    // Advancing past the deadline must not produce an unhandled rejection
    // (the race already settled; timer was cleared in .finally).
    await vi.advanceTimersByTimeAsync(2000);
  });
});
