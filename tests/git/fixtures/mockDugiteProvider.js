/**
 * @fileoverview Mocked DugiteProvider seam (publish-update-resilience
 * Task 16) — the dugite replacement for the old `vi.mock('isomorphic-git')`
 * backend seam.
 *
 * The legacy ipc suites (git.flows, git.pull-push, gitPreflight, ...)
 * mocked the isomorphic-git MODULE to drive GitHandlers with a scripted
 * backend and asserted on the call shapes reaching it. Since T15 removed
 * the iso provider (and git.js speaks only the GitService/provider
 * contract), the equivalent seam is the PROVIDER INSTANCE: a real
 * DugiteProvider whose methods are replaced with vitest spies carrying
 * sane defaults. The handler under test still runs its real flow logic —
 * only the backend boundary is scripted — and assertions read
 * `provider.merge.mock.calls` etc. in the provider-contract shapes:
 *
 *   fetch(path, { remote, ref, depth, singleBranch, auth, ... })
 *   merge(path, theirRef, { ours, fastForward, strategy, message, ... })
 *   push(path, { remote, branch, remoteRef, force, auth, ... })
 *   resolveRef(path, ref) · currentBranch(path) · statusMatrix(path) ...
 *
 * Every method keeps the REAL DugiteProvider signature, so a test can
 * call-through selectively (`spy.mockImplementationOnce` / restoring a
 * single spy) when it wants real git for one operation.
 *
 * @vitest-environment node
 */

import { vi } from 'vitest';

import { DugiteProvider } from '../../../src/git/providers/DugiteProvider.js';

/**
 * Sane default resolutions mirroring the old iso-mock beforeEach block
 * (clean tree on 'preview', generic SHAs, successful pushes).
 * @type {Object<string, Function>}
 */
const DEFAULTS = {
  clone: async () => {},
  fetch: async () => ({}),
  pull: async () => {},
  push: async () => {},
  getRemoteInfo: async () => ({ refs: {} }),
  listServerRefs: async () => [],
  canFastForward: async () => true,
  add: async () => {},
  remove: async () => {},
  commit: async () => 'commitsha00000000000000000000000000000000',
  branch: async () => {},
  deleteBranch: async () => {},
  checkout: async () => {},
  merge: async () => ({ oid: 'mergesha0000000000000000000000000000000' }),
  fastForward: async () => true,
  writeRef: async () => {},
  statusMatrix: async () => [],
  currentBranch: async () => 'preview',
  listBranches: async () => ['preview'],
  listRefs: async () => [],
  resolveRef: async () => 'abc1234567890abcdef1234567890abcdef1234',
  readCommit: async () => ({
    oid: 'abc1234567890abcdef1234567890abcdef1234',
    commit: {
      message: 'message\n',
      tree: 'treesha00000000000000000000000000000000000',
      parent: [],
      author: { name: 'tester', email: 't@example.local', timestamp: 0, timezoneOffset: 0 },
      committer: { name: 'tester', email: 't@example.local', timestamp: 0, timezoneOffset: 0 },
    },
    payload: '',
  }),
  readBlob: async () => ({ oid: 'blobsha00000000000000000000000000000000', blob: new Uint8Array([1, 2, 3]) }),
  getConfig: async () => null,
  setConfig: async () => {},
  // Well-formed-repo defaults: a real mergeBase OID (NOT []) — an empty
  // base means UNRELATED HISTORIES, which detectMergeConflicts reports as
  // a conflict (CONFLICT_PENDING) and would derail every divergent-flow
  // test. Tests that need unrelated histories override this.
  mergeBase: async () => ['basesha0000000000000000000000000000000'],
  mergeTree: async () => ({ clean: true, treeOid: 'treesha00000000000000000000000000000000000', files: [] }),
};

/**
 * Build a DugiteProvider with EVERY public method spied to a default
 * resolution (no real git runs unless a test restores a spy). Instance
 * methods are spied on the instance's prototype chain via `vi.spyOn`
 * against the instance — each call site keeps `this` bound correctly.
 *
 * @param {Object<string, Function>} [overrides] method name → impl that
 *   replaces the default (e.g. `{ currentBranch: async () => null }`)
 * @returns {import('../../../src/git/providers/DugiteProvider').DugiteProvider & Record<string, import('vitest').Mock>}
 */
export function mockDugiteProvider(overrides = {}) {
  const provider = new DugiteProvider();
  for (const [method, impl] of Object.entries(DEFAULTS)) {
    if (typeof provider[method] !== 'function') continue;
    vi.spyOn(provider, method).mockImplementation(overrides[method] || impl);
  }
  return provider;
}
