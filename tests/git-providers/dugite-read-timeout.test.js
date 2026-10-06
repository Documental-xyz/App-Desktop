/**
 * @fileoverview Local-read timeout decision in DugiteProvider
 * (_execTimeoutMs — publish/update dead-buttons fix).
 *
 * A stalled git child (AV scan, index.lock contention) must reject
 * instead of hanging the IPC invoke forever: local reads (no url, no
 * abort signal) get a hard 30s execFile timeout; network/signal ops keep
 * the existing signal/step-timeout regime. Pure decision unit — dugite's
 * exec itself is exercised by the sibling suites with the real binary.
 *
 * Why not vi.mock('dugite'): src/ CJS `require('dugite')` bypasses the
 * vitest mock registry (same reason the config ALIASES electron — see
 * vitest.config.mjs), so the decision is extracted into a pure method.
 * @author Documental Team
 * @since 1.0.0
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
const { DugiteProvider } = require('../../src/git/providers/DugiteProvider.js');

describe('DugiteProvider._execTimeoutMs (local-read timeout)', () => {
  const provider = new DugiteProvider();

  it('caps local reads (no url, no signal) at 30s', () => {
    expect(provider._execTimeoutMs({ repoPath: '/repo' })).toBe(30000);
  });

  it('does NOT timeout network operations (ctx.url present)', () => {
    expect(provider._execTimeoutMs({ repoPath: '/repo', url: 'https://127.0.0.1/remote.git' })).toBeUndefined();
  });

  it('does NOT timeout flow operations carrying an abort signal', () => {
    const controller = new AbortController();
    expect(provider._execTimeoutMs({ repoPath: '/repo', signal: controller.signal })).toBeUndefined();
  });

  it('does NOT timeout network ops that also carry a signal', () => {
    const controller = new AbortController();
    expect(
      provider._execTimeoutMs({ url: 'https://x/repo.git', signal: controller.signal })
    ).toBeUndefined();
  });

  it('explicit runOpts.timeoutMs always wins', () => {
    expect(provider._execTimeoutMs({ repoPath: '/repo' }, { timeoutMs: 1234 })).toBe(1234);
    expect(
      provider._execTimeoutMs({ url: 'https://x/repo.git' }, { timeoutMs: 999 })
    ).toBe(999);
  });

  it('tolerates missing ctx', () => {
    expect(provider._execTimeoutMs(undefined)).toBe(30000);
  });
});
