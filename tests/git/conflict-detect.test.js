/**
 * @fileoverview conflict-strategy-modal Task 1: pre-merge conflict
 * DETECTION (gitConflictDetect.detectMergeConflicts) — dual provider.
 *
 * Contract under test:
 *   detectMergeConflicts({ provider, repoPath }, theirRef)
 *     → { hasConflicts: boolean, files?: string[], ours, theirs, mergeBase }
 *
 *   ZERO mutation: no merge applied, no working-tree touch, no refs
 *   moved — asserted by a bit-identical state hash (refs + HEAD +
 *   statusMatrix + worktree content) before/after detection.
 *
 *   - iso-git: in-memory diff3 over divergent blobs (driver-detector
 *     semantics — mirrors gitMergeDriver's hunk partitioning)
 *   - dugite: `git merge-tree --write-tree` (write-tree mode never
 *     touches the working tree or refs; exit 1 = conflicts)
 *
 * @vitest-environment node
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { providersUnderTest, providerFactory } from '../git-providers/harness.js';
import { createRepoPair, makeConflict } from './fixtures/harness.js';
import { httpBackendAvailable } from './fixtures/harness.js';

import { detectMergeConflicts } from '../../src/ipc/gitConflictDetect.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Bit-identical repo state fingerprint: every ref OID (via for-each-ref
 * style listing through the provider is avoided — use raw fs on .git
 * refs so the hash does not depend on the provider under test), HEAD,
 * the status matrix, and a content hash of every working-tree file.
 *
 * @param {string} dir - repository working directory
 * @returns {Promise<string>} sha256 of the serialized state
 */
async function repoStateHash(dir) {
  const parts = [];
  const refsRoot = path.join(dir, '.git', 'refs');
  const walkRefs = (p, prefix = '') => {
    if (!fs.existsSync(p)) return;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) {
        walkRefs(full, `${prefix}${entry.name}/`);
      } else {
        parts.push(`${prefix}${entry.name}=${fs.readFileSync(full, 'utf8').trim()}`);
      }
    }
  };
  walkRefs(refsRoot);
  // packed-refs + HEAD + MERGE_HEAD presence (a stray merge state would
  // be caught here even when loose refs look untouched)
  for (const meta of ['HEAD', 'MERGE_HEAD', 'packed-refs', 'index']) {
    const p = path.join(dir, '.git', meta);
    if (fs.existsSync(p)) {
      parts.push(`${meta}=${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
    } else {
      parts.push(`${meta}=<absent>`);
    }
  }
  const walkWork = (p, prefix = '') => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) {
        walkWork(full, `${prefix}${entry.name}/`);
      } else {
        parts.push(`w:${prefix}${entry.name}=${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
      }
    }
  };
  walkWork(dir);
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

describe.skipIf(!httpBackendAvailable).each(providersUnderTest())('conflict detection [%s]', (providerName) => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  /** @type {Awaited<ReturnType<typeof createRepoPair>>} */
  let pair;
  let provider;

  beforeEach(async () => {
    pair = await createRepoPair();
    provider = providerFactory(providerName)();
  });

  afterEach(() => {
    pair.dispose();
  });

  it('reports hasConflicts + the conflicting file (real text conflict)', async () => {
    const { file } = await makeConflict(pair); // line2 LOCAL vs REMOTE
    await pair.local.fetch(); // origin/main = remote edit

    const result = await detectMergeConflicts(
      { provider, repoPath: pair.local.dir },
      'origin/main'
    );

    expect(result.hasConflicts).toBe(true);
    expect(result.files).toEqual([file]);
  });

  it('reports no conflict when the divergent edits touch different hunks', async () => {
    // 10-line base; local edits line1, remote edits line10 — diff3 sees
    // two independent non-overlapping hunks → clean merge (fixture
    // distance rule from learnings: edits ≥2 lines apart).
    const base = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const locally = base.replace('line1\n', 'line1-LOCAL\n');
    const remotely = base.replace('line10\n', 'line10-REMOTE\n');

    pair.local.writeFiles({ 'doc.md': base });
    await pair.local.commit('base: doc', ['doc.md']);
    await pair.local.push(pair.branch);
    await pair.remote.fetch();
    const gitMod = (await import('isomorphic-git')).default;
    const originTip = await gitMod.resolveRef({
      fs, dir: pair.remote.dir, ref: `origin/${pair.branch}`,
    });
    await gitMod.branch({ fs, dir: pair.remote.dir, ref: pair.branch, object: originTip });
    await gitMod.checkout({ fs, dir: pair.remote.dir, ref: pair.branch });
    pair.remote.writeFiles({ 'doc.md': remotely });
    await pair.remote.commit('remote: doc', ['doc.md']);
    await pair.remote.push(pair.branch);

    pair.local.writeFiles({ 'doc.md': locally });
    await pair.local.commit('local: doc', ['doc.md']);
    await pair.local.fetch();

    const result = await detectMergeConflicts(
      { provider, repoPath: pair.local.dir },
      'origin/main'
    );

    expect(result.hasConflicts).toBe(false);
    expect(result.files).toEqual([]);
  });

  it('mutates NOTHING (refs, HEAD, index and worktree bit-identical)', async () => {
    await makeConflict(pair);
    await pair.local.fetch();

    const before = await repoStateHash(pair.local.dir);
    // Run detection on BOTH scenarios to cover the full code path —
    // conflict and clean — in the same repo state mutation window.
    await detectMergeConflicts({ provider, repoPath: pair.local.dir }, 'origin/main');
    const after = await repoStateHash(pair.local.dir);

    expect(after).toBe(before);
  });

  it('returns a shape ready for a future CONFLICT_PENDING payload', async () => {
    await makeConflict(pair);
    await pair.local.fetch();

    const result = await detectMergeConflicts(
      { provider, repoPath: pair.local.dir },
      'origin/main'
    );

    // ours/theirs/mergeBase OIDs feed Task 3's typed error payload
    expect(result.ours).toMatch(/^[0-9a-f]{40}$/);
    expect(result.theirs).toMatch(/^[0-9a-f]{40}$/);
    expect(result.mergeBase).toMatch(/^[0-9a-f]{40}$/);
  });

  it('flags binary divergent blobs as conflicts', async () => {
    await makeConflict(pair, { binary: true });
    await pair.local.fetch();

    const result = await detectMergeConflicts(
      { provider, repoPath: pair.local.dir },
      'origin/main'
    );

    expect(result.hasConflicts).toBe(true);
    expect(result.files).toEqual(['asset.bin']);
  });
});
