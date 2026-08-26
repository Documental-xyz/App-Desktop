/**
 * @fileoverview Integration example validating the git fixtures harness
 * (git-sync-strategy plan, Task 1 — QA scenario "divergência local x
 * remota").
 *
 * Real repos, real origin, isomorphic-git end-to-end.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  createRepoPair,
  commitFile,
  makeDirty,
  makeDivergent,
} from './fixtures/harness.js';
import { httpBackendAvailable } from './fixtures/harness.js';

/** @type {Awaited<ReturnType<typeof createRepoPair>>} */
let pair;

afterAll(() => {
  if (pair) pair.dispose();
});

describe.skipIf(!httpBackendAvailable)('git fixtures harness', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  it('creates a reproducible local vs remote divergence', async () => {
    // 1. Repo pair with a common base commit pushed to origin.
    pair = await createRepoPair({ files: { 'a.txt': 'base\n' } });
    expect(await pair.local.readFile('a.txt')).toBe('base\n');
    expect(await pair.remote.readFile('a.txt')).toBe('base\n');

    // 2. Remote diverges (edits a.txt); local diverges (edits a.txt + adds b.txt).
    const { localHead, originHead } = await makeDivergent(pair, {
      remoteFiles: { 'a.txt': 'remote edit\n' },
      remoteMessage: 'remote: edit a.txt',
      localFiles: { 'a.txt': 'local edit\n', 'b.txt': 'local new\n' },
      localMessage: 'local: edit a.txt + add b.txt',
    });

    // 3. statusMatrix shows b.txt committed (present, clean) on local.
    await pair.local.fetch();
    const matrix = await pair.local.statusMatrix();
    const rowB = matrix.find(([f]) => f === 'b.txt');
    expect(rowB).toEqual(['b.txt', 1, 1, 1]);

    // 4. HEAD local != origin/main — true divergence.
    expect(await pair.local.head()).toBe(localHead);
    expect(await pair.local.resolveRef(`origin/${pair.branch}`)).toBe(originHead);
    expect(localHead).not.toBe(originHead);

    // 5. Local working tree untouched by the remote divergence.
    expect(await pair.local.readFile('a.txt')).toBe('local edit\n');
  });

  it('makeDirty leaves files uncommitted in the status matrix', async () => {
    const p = await createRepoPair({ files: { 'README.md': '# base\n' } });
    try {
      makeDirty(p.local, { 'README.md': '# base\ndirty\n', 'new.txt': 'untracked\n' });

      const matrix = await p.local.statusMatrix();
      // README: modified in workdir (w=2 relative to HEAD)
      expect(matrix.find(([f]) => f === 'README.md')).toEqual(['README.md', 1, 2, 1]);
      // new.txt: untracked (absent from HEAD)
      expect(matrix.find(([f]) => f === 'new.txt')).toEqual(['new.txt', 0, 2, 0]);
    } finally {
      p.dispose();
    }
  });

  it('commitFile pushes cleanly to the shared origin', async () => {
    const p = await createRepoPair({ files: { 'a.txt': 'base\n' } });
    try {
      await commitFile(p.local, 'c.txt', 'third file\n', 'local: add c.txt');
      await p.local.push(p.branch);

      await p.remote.fetch();
      expect(await p.remote.resolveRef(`origin/${p.branch}`)).toBe(
        await p.local.head()
      );
    } finally {
      p.dispose();
    }
  });
});
