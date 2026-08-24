/**
 * @fileoverview Mock GitProvider (git-sync-strategy plan, Task 1).
 *
 * Implements the exact method surface of the provider contract consumed
 * by `src/git/GitService.js` (clone → setConfig) as vi.fn spies with
 * configurable implementations, plus mutation tracking so tests can
 * assert "backup failed → ZERO provider mutations" (Tasks 5-8).
 *
 * @vitest-environment node
 */

import { vi } from 'vitest';

/** Every method on the GitService/provider contract (src/git/GitService.js). */
export const PROVIDER_METHODS = [
  // network
  'clone',
  'fetch',
  'pull',
  'push',
  'getRemoteInfo',
  'listServerRefs',
  'canFastForward',
  // local mutations
  'add',
  'remove',
  'commit',
  'branch',
  'deleteBranch',
  'checkout',
  'merge',
  'fastForward',
  'writeRef',
  'setConfig',
  // reads
  'statusMatrix',
  'currentBranch',
  'listBranches',
  'listRefs',
  'resolveRef',
  'readCommit',
  'readBlob',
  'getConfig',
];

/** Methods that mutate repo state — the "never call these on failure" set. */
export const MUTATING_METHODS = [
  'clone',
  'pull',
  'push',
  'add',
  'remove',
  'commit',
  'branch',
  'deleteBranch',
  'checkout',
  'merge',
  'fastForward',
  'writeRef',
  'setConfig',
];

/** Sensible default return values per read method. */
const DEFAULTS = {
  statusMatrix: async () => [],
  currentBranch: async () => 'main',
  listBranches: async () => ['main'],
  listRefs: async () => ['refs/heads/main'],
  resolveRef: async () => '0000000000000000000000000000000000000001',
  getConfig: async () => undefined,
  canFastForward: async () => true,
};

/**
 * Create a mock GitProvider.
 *
 * @param {Object<string, Function>} [impl] - per-method implementations
 *   (overrides the defaults). Configure later via `mock.<method>.mock*`.
 * @returns {Object & {
 *   mutationCalls(): Array<{ method: string, args: unknown[] }>,
 *   assertNoMutations(): void,
 * }} the mock provider, augmented with mutation-tracking helpers.
 */
export function createMockGitProvider(impl = {}) {
  const provider = {};
  for (const method of PROVIDER_METHODS) {
    provider[method] = vi.fn(impl[method] || DEFAULTS[method] || (async () => undefined));
  }

  /** All mutating calls recorded so far, as { method, args }. */
  provider.mutationCalls = () =>
    MUTATING_METHODS.flatMap((method) =>
      provider[method].mock.calls.map((args) => ({ method, args }))
    );

  /** Throw if any mutating method was called (rich diff on failure). */
  provider.assertNoMutations = () => {
    const calls = provider.mutationCalls();
    if (calls.length > 0) {
      const summary = calls.map((c) => `${c.method}(${c.args.map(String).join(', ')})`);
      throw new Error(`Expected zero provider mutations, got ${calls.length}: ${summary.join('; ')}`);
    }
  };

  return provider;
}
