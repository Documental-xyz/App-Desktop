/**
 * @fileoverview Unit example validating the GitProvider mock
 * (git-sync-strategy plan, Task 1).
 *
 * Verifies: GitService delegation, configurable implementations, and
 * the mutation-tracking helpers that Tasks 5-8 rely on for
 * "no mutation on failure" assertions.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { GitService } from '../../src/git/GitService.js';
import {
  createMockGitProvider,
  MUTATING_METHODS,
  PROVIDER_METHODS,
} from './fixtures/mockProvider.js';

describe('mock GitProvider', () => {
  it('covers the full GitService contract surface', () => {
    const mock = createMockGitProvider();
    const service = new GitService({ provider: mock });

    for (const method of PROVIDER_METHODS) {
      expect(typeof mock[method]).toBe('function');
      expect(typeof service[method]).toBe('function');
    }
  });

  it('GitService delegates transparently to the injected mock', async () => {
    const mock = createMockGitProvider({
      statusMatrix: async () => [['a.txt', 1, 2, 1]],
    });
    const service = new GitService({ provider: mock });

    const matrix = await service.statusMatrix('/repo');
    expect(matrix).toEqual([['a.txt', 1, 2, 1]]);
    expect(mock.statusMatrix).toHaveBeenCalledWith('/repo', undefined);
  });

  it('tracks mutations and asserts none happened', async () => {
    const mock = createMockGitProvider();
    const service = new GitService({ provider: mock });

    // Read-only usage through the real facade:
    await service.statusMatrix('/repo');
    await service.currentBranch('/repo');
    mock.assertNoMutations();
    expect(mock.mutationCalls()).toEqual([]);

    // Now a single mutation is recorded...
    await service.commit('/repo', 'msg', {});
    expect(mock.mutationCalls()).toEqual([
      { method: 'commit', args: ['/repo', 'msg', {}] },
    ]);

    // ...and assertNoMutations throws naming the offender.
    expect(() => mock.assertNoMutations()).toThrow(/commit/);
  });

  it('supports the "backup fails → nothing mutated" pattern (Task 5 shape)', async () => {
    const mock = createMockGitProvider();
    mock.branch.mockRejectedValueOnce(new Error('backup branch failed'));

    // Flow sketch: try backup-then-mutate; on backup failure, abort.
    let aborted = false;
    try {
      await mock.branch('/repo', 'backup/main-1');
      for (const method of MUTATING_METHODS) {
        await mock[method]('/repo');
      }
    } catch {
      aborted = true;
    }

    expect(aborted).toBe(true);
    // The only recorded "mutation" is the failed backup attempt itself.
    const mutations = mock.mutationCalls();
    expect(mutations).toHaveLength(1);
    expect(mutations[0].method).toBe('branch');
  });
});
