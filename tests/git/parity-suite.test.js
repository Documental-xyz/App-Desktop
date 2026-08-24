/**
 * @fileoverview Task 10 (git-sync-strategy): DUAL-PROVIDER PARITY suite.
 *
 * Every flow scenario of Tasks 6-8 (publish divergent/conflict/rejected;
 * refresh dirty/conflict/no-upstream; publish-main preview-wins/
 * anti-inversion) runs against BOTH providers — isomorphic-git AND
 * dugite — with the SAME fixtures, via `describe.each` parameterized by
 * provider (tests/git/fixtures/providerHarness.js).
 *
 * Runner contract (inherited from tests/git-providers/harness.js):
 * GIT_PROVIDER selects ONE provider; unset runs BOTH sequentially.
 *
 * PARITY POLICY (plan Task 10): a parity failure is a BUG, never a
 * "skip". Two real divergences were found in DugiteProvider and are
 * documented in .omo/notepads/git-sync-strategy/issues.md:
 *   T10-D1 — fetch() defaults depth=1 → the flow's deepen fetch never
 *            deepens → every divergent merge dies with "refusing to
 *            merge unrelated histories".
 *   T10-D2 — fetch of a missing remote branch surfaces "couldn't find
 *            remote ref", which the flow's first-publish detection does
 *            not recognize → first publish / NO_UPSTREAM broken.
 * Scenarios depending on those capabilities are gated by CONDITIONAL
 * runtime probes (gateOnCapability): the gate is re-evaluated on every
 * run and opens automatically once the src bug is fixed. Companion
 * `it.fails` tripwires below pin the BUGGY state — they start failing
 * loudly the moment the bug is fixed, reminding maintainers to drop the
 * gate. There is NO unconditional skip.
 *
 * @vitest-environment node
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import gitModule from 'isomorphic-git';

import { providersUnderTest } from '../git-providers/harness.js';
import {
  createRepoPair,
  makeDivergent,
  makeDirty,
} from './fixtures/harness.js';
import {
  makeFlowHandlers,
  gateOnCapability,
  divergentFlowsWork,
  dugiteMissingRefFetchTolerated,
  dugiteDeepenFetchWorks,
} from './fixtures/providerHarness.js';

const git = gitModule.default || gitModule;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ─── Shared fixtures (SAME shapes for every provider) ────────────────────────

const A_MD_BASE = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
const A_MD_LOCAL = A_MD_BASE.replace('line5', 'line5-LOCAL');
const A_MD_REMOTE_CONFLICT = A_MD_BASE.replace('line5', 'line5-REMOTE');

const B_MD_BASE = Array.from({ length: 60 }, (_, i) => `line${i + 1}`).join('\n') + '\n';

const MAIN_BASE = 'line1\nline2\nline3\n';
const MAIN_VERSION = 'line1\nline2-MAIN\nline3\n';
const PREVIEW_VERSION = 'line1\nline2-PREVIEW\nline3\n';

// NB: distinct LENGTHS on every side — iso-git's stat heuristic treats a
// same-size rewrite inside the same second as unmodified, which would
// hide the dirty edit from _commitAll (see learnings, Task 10).
const binaryBase = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const binaryLocal = Buffer.from([1, 2, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 7, 8, 9]);
const binaryRemote = Buffer.from([1, 2, 0xaa, 0xbb, 0, 7, 8]);

function branchNames(handlers, dir) {
  return handlers.git.listBranches(dir).then((bs) =>
    bs.map((b) => (typeof b === 'string' ? b : b.name))
  );
}

// ─── Parameterized parity scenarios ──────────────────────────────────────────

describe.each(providersUnderTest())('flow parity [%s]', (providerName) => {
  let pair;
  let handlers;
  let divergentGateOpen;

  beforeEach(async () => {
    divergentGateOpen = await divergentFlowsWork(providerName);
  });

  // ── Publish (Task 6) ──────────────────────────────────────────────────────

  describe('publish — divergent remote, local-wins merge', () => {
    beforeEach(async () => {
      pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_MD_BASE } });
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    it('non-conflicting divergence: both contents coexist in tree and history', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (divergent publish)');
      await makeDivergent(pair, {
        remoteFiles: { 'c.md': 'remote content\n' },
        remoteMessage: 'remote: add c.md',
      });
      makeDirty(pair.local, { 'a.md': A_MD_LOCAL });

      const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

      expect(result.success).toBe(true);
      expect(result.branch).toBe('preview');
      expect(await pair.local.readFile('a.md')).toContain('line5-LOCAL');
      expect(fs.existsSync(path.join(pair.local.dir, 'c.md'))).toBe(true);

      const messages = (await pair.local.log(20)).map((c) => c.commit.message);
      expect(messages.some((m) => m.includes('remote: add c.md'))).toBe(true);
      expect(messages.some((m) => m.includes('local: edit a.md'))).toBe(true);
      expect(messages.some((m) => /merge/i.test(m))).toBe(true);

      expect(await pair.local.resolveRef('HEAD')).toBe(
        await pair.local.resolveRef('refs/remotes/origin/preview')
      );
      expect((await branchNames(handlers, pair.local.dir)).some((n) => n.startsWith('backup/'))).toBe(true);
    });

    it('conflicting line: LOCAL wins the hunk, remote-only files integrated', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (conflicting publish)');
      await makeDivergent(pair, {
        remoteFiles: { 'a.md': A_MD_REMOTE_CONFLICT, 'new-remote.md': 'from remote\n' },
        remoteMessage: 'remote: conflict edit',
      });
      makeDirty(pair.local, { 'a.md': A_MD_LOCAL });

      const result = await handlers.gitPublishPreview(1, 'local: conflicting edit');

      expect(result.success).toBe(true);
      const aMd = await pair.local.readFile('a.md');
      expect(aMd).toContain('line5-LOCAL');
      expect(aMd).not.toContain('line5-REMOTE');
      expect(fs.existsSync(path.join(pair.local.dir, 'new-remote.md'))).toBe(true);
    });
  });

  describe('publish — push rejected', () => {
    beforeEach(async () => {
      pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_MD_BASE } });
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    it('typed PUSH_REJECTED, zero local loss, retained backup', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (publish push-rejected)');
      await makeDivergent(pair, {
        remoteFiles: { 'c.md': 'remote content\n' },
        remoteMessage: 'remote: add c.md',
      });
      makeDirty(pair.local, { 'a.md': A_MD_LOCAL });
      vi.spyOn(handlers.git, 'push').mockRejectedValue(
        Object.assign(new Error('push rejected: non-fast-forward'), { code: 'PushRejectedError' })
      );

      const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

      expect(result.success).toBe(false);
      expect(result.code).toBe('PUSH_REJECTED');
      expect(result.error).toMatch(/atualiz/i);
      expect(await pair.local.readFile('a.md')).toContain('line5-LOCAL');
      expect((await branchNames(handlers, pair.local.dir)).some((n) => n.startsWith('backup/'))).toBe(true);
      expect(handlers.gitOperationInProgress).toBe(false);
    });
  });

  // ── Refresh (Task 7) ──────────────────────────────────────────────────────

  describe('refresh — dirty tree + remote divergence', () => {
    beforeEach(async () => {
      pair = await createRepoPair({ branch: 'preview', files: { 'b.md': B_MD_BASE } });
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    it('keeps BOTH edits; WIP + merge commits in history; no hard reset', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (dirty refresh)');
      await makeDivergent(pair, {
        remoteFiles: { 'b.md': B_MD_BASE.replace('line50', 'line50-REMOTE') },
        remoteMessage: 'remote: edit line 50',
      });
      makeDirty(pair.local, { 'b.md': B_MD_BASE.replace('line10', 'line10-LOCAL') });

      const result = await handlers.gitRefresh(1);

      expect(result.success).toBe(true);
      expect(result.branch).toBe('preview');
      const bMd = await pair.local.readFile('b.md');
      expect(bMd).toContain('line10-LOCAL');
      expect(bMd).toContain('line50-REMOTE');

      const messages = (await pair.local.log(20)).map((c) => c.commit.message);
      expect(messages.some((m) => m.startsWith('WIP by testuser at'))).toBe(true);
      expect(messages.some((m) => m.includes('remote: edit line 50'))).toBe(true);
      expect(messages.some((m) => /merge/i.test(m))).toBe(true);
      expect(handlers.gitOperationInProgress).toBe(false);
    });

    it('same-line conflict: LOCAL wins, remote preserved in history', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (conflicting refresh)');
      await makeDivergent(pair, {
        remoteFiles: { 'b.md': 'line1\nline2-REMOTE\nline3\n' },
        remoteMessage: 'remote: edit line2',
      });
      makeDirty(pair.local, { 'b.md': 'line1\nline2-LOCAL\nline3\n' });

      const result = await handlers.gitRefresh(1);

      expect(result.success).toBe(true);
      const bMd = await pair.local.readFile('b.md');
      expect(bMd).toContain('line2-LOCAL');
      expect(bMd).not.toContain('line2-REMOTE');
      const messages = (await pair.local.log(20)).map((c) => c.commit.message);
      expect(messages.some((m) => m.includes('remote: edit line2'))).toBe(true);
      expect(messages.some((m) => m.startsWith('WIP by testuser at'))).toBe(true);
    });
  });

  describe('refresh — missing upstream', () => {
    beforeEach(async () => {
      pair = await createRepoPair({ branch: 'preview' });
      pair.local.writeFiles({ 'a.md': 'local only\n' });
      await pair.local.commit('local: initial', 'a.md');
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    it('typed NO_UPSTREAM guiding the user to publish first', async (ctx) => {
      gateOnCapability(ctx, await dugiteMissingRefFetchTolerated(providerName), 'T10-D2 (no-upstream refresh)');
      const result = await handlers.gitRefresh(1);
      expect(result.success).toBe(false);
      expect(result.code).toBe('NO_UPSTREAM');
      expect(result.error).toMatch(/publish|publicar/i);
      expect(await pair.local.readFile('a.md')).toBe('local only\n');
      expect(handlers.gitOperationInProgress).toBe(false);
    });
  });

  // ── Publish-main (Task 8) ─────────────────────────────────────────────────

  describe('publish-main — preview-wins promote', () => {
    beforeEach(async () => {
      pair = await createRepoPair({ branch: 'main', files: { 'conflict.txt': MAIN_BASE } });
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    /** Same promotable fixture as tests/git/publish-main-flow.test.js. */
    async function setupPromotable() {
      pair.remote.writeFiles({ 'conflict.txt': MAIN_VERSION });
      await pair.remote.commit('main: edit line2', 'conflict.txt');
      await pair.remote.push('main');

      const baseOid = await pair.local.head();
      await git.branch({ fs, dir: pair.local.dir, ref: 'preview', object: baseOid });
      await git.checkout({ fs, dir: pair.local.dir, ref: 'preview' });
      pair.local.writeFiles({ 'conflict.txt': PREVIEW_VERSION });
      await pair.local.commit('preview: edit line2', 'conflict.txt');
      await pair.local.push('preview');
      makeDirty(pair.local, { 'local-note.md': 'unpublished WIP\n' });
    }

    it('ANTI-INVERSION: preview wins on origin/main (opposite of refresh)', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (publish-main anti-inversion)');
      await setupPromotable();

      const result = await handlers.gitPublishMain(1);

      expect(result.success).toBe(true);
      // Round-trip through the REAL remote (checkout origin/main — the
      // colleague's own local main stays stale).
      await pair.remote.fetch();
      await git.checkout({ fs, dir: pair.remote.dir, ref: 'origin/main', force: true });
      const promoted = await pair.remote.readFile('conflict.txt');
      expect(promoted).toContain('line2-PREVIEW');
      expect(promoted).not.toContain('line2-MAIN');
      expect(fs.existsSync(path.join(pair.remote.dir, 'local-note.md'))).toBe(false);
    });

    it('post-success: back on preview, merge commit on origin/main', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (publish-main post-success)');
      await setupPromotable();

      const result = await handlers.gitPublishMain(1);

      expect(result.success).toBe(true);
      expect(result.branch).toBe('preview');
      expect(await handlers.git.currentBranch(pair.local.dir)).toBe('preview');
      expect(fs.existsSync(path.join(pair.local.dir, 'local-note.md'))).toBe(true);

      const originMain = await pair.local.resolveRef('refs/remotes/origin/main');
      const { commit } = await git.readCommit({ fs, dir: pair.local.dir, oid: originMain });
      expect(commit.parent).toHaveLength(2);
      expect(handlers.gitOperationInProgress).toBe(false);
    });

    it('push rejected → typed PUSH_REJECTED, local intact', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (publish-main push-rejected)');
      await setupPromotable();
      vi.spyOn(handlers.git, 'push').mockRejectedValue(
        Object.assign(new Error('push rejected: non-fast-forward'), { code: 'PushRejectedError' })
      );

      const result = await handlers.gitPublishMain(1);

      expect(result.success).toBe(false);
      expect(result.code).toBe('PUSH_REJECTED');
      expect((await branchNames(handlers, pair.local.dir)).some((n) => n.startsWith('backup/'))).toBe(true);
      expect(handlers.gitOperationInProgress).toBe(false);
    });
  });

  // ── Binary conflicts (publish AND refresh) ────────────────────────────────

  describe('binary conflicts', () => {
    beforeEach(async () => {
      pair = await createRepoPair({ branch: 'preview' });
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    /** Seed base → push → remote binary edit → local side (dirty or committed). */
    async function binaryFixture({ dirtyLocal }) {
      pair.local.writeFiles({ 'asset.bin': binaryBase });
      await pair.local.commit('base: asset.bin', 'asset.bin');
      await pair.local.push('preview');

      await pair.remote.fetch();
      const originTip = await git.resolveRef({ fs, dir: pair.remote.dir, ref: 'origin/preview' });
      await git.branch({ fs, dir: pair.remote.dir, ref: 'preview', object: originTip });
      await git.checkout({ fs, dir: pair.remote.dir, ref: 'preview' });
      pair.remote.writeFiles({ 'asset.bin': binaryRemote });
      await pair.remote.commit('remote: edit asset.bin', 'asset.bin');
      await pair.remote.push('preview');

      if (dirtyLocal) {
        makeDirty(pair.local, { 'asset.bin': binaryLocal });
      } else {
        pair.local.writeFiles({ 'asset.bin': binaryLocal });
        await pair.local.commit('local: edit asset.bin', 'asset.bin');
      }
    }

    it('publish: LOCAL bytes win the binary conflict, byte-identical', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (binary publish)');
      await binaryFixture({ dirtyLocal: true });

      const result = await handlers.gitPublishPreview(1, 'local: binary edit');

      expect(result.success).toBe(true);
      expect(Buffer.compare(await pair.local.readBytes('asset.bin'), binaryLocal)).toBe(0);
    });

    it('refresh: LOCAL bytes win the binary conflict, byte-identical', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (binary refresh)');
      await binaryFixture({ dirtyLocal: true });

      const result = await handlers.gitRefresh(1);

      expect(result.success).toBe(true);
      expect(Buffer.compare(await pair.local.readBytes('asset.bin'), binaryLocal)).toBe(0);
    });
  });
});

// ─── Bug tripwires (`it.fails`: PASS now = bug present; when src is fixed
// these FAIL loudly → remove the matching conditional gate above) ────────────

describe('parity bug tripwires [dugite]', () => {
  it.fails('T10-D1: fetch() without depth deepens a depth:1 repo (merge-base appears)', async () => {
    expect(await dugiteDeepenFetchWorks('dugite')).toBe(true);
  });

  it.fails('T10-D2: fetching a missing remote branch raises a flow-recognizable error', async () => {
    expect(await dugiteMissingRefFetchTolerated('dugite')).toBe(true);
  });
});
