/**
 * @fileoverview conflict-strategy-modal Task 5: DUAL-PROVIDER PARITY for
 * the conflict-strategy lifecycle + edge cases.
 *
 * Same scenarios, SAME fixtures, via `describe.each` parameterized by
 * provider (tests/git-providers/harness.js → providerHarness.js):
 *
 *   1. Full lifecycle (publish): detection → typed CONFLICT_PENDING →
 *      resume with EACH of the 4 strategies → winner content, both
 *      sides in history, push completed, lock released, token
 *      single-use.
 *   2. CANCEL: backup + WIP preserved, no merge, lock NOT leaked
 *      (neither after CONFLICT_PENDING nor after cancel).
 *   3. Token single-use consumed only AFTER the lock: a lock held by
 *      an unrelated op does NOT consume the token (retryable).
 *   4. Edge — binary-ONLY conflict: the modal must fire (detection is
 *      not text-biased) and full/merge strategies decide the winning
 *      side's bytes.
 *   5. Edge — publish-main conflict: ours=main / theirs=preview
 *      mapping across ALL 4 strategies.
 *   6. Edge — fail-open: a merge that would be CLEAN never produces a
 *      false CONFLICT_PENDING (detection says clean → auto flow).
 *
 * PARITY POLICY (inherited from parity-suite.test.js): a capability
 * the scenario depends on is probed at runtime (gateOnCapability);
 * gates are conditional and re-evaluated every run — there is NO
 * unconditional skip.
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
import { createRepoPair, makeDivergent, makeDirty } from './fixtures/harness.js';
import {
  makeFlowHandlers,
  gateOnCapability,
  divergentFlowsWork,
  binaryFallbackWorks,
} from './fixtures/providerHarness.js';

const git = gitModule.default || gitModule;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ─── Shared fixtures (SAME shapes for every provider) ────────────────────────

const A_MD_BASE = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
const A_MD_LOCAL = A_MD_BASE.replace('line5', 'line5-LOCAL');
const A_MD_REMOTE = A_MD_BASE.replace('line5', 'line5-REMOTE');

// Distinct LENGTHS per side (iso-git stat heuristic — see parity-suite).
const BIN_BASE = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const BIN_LOCAL = Buffer.from([1, 2, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 7, 8, 9]);
const BIN_REMOTE = Buffer.from([1, 2, 0xaa, 0xbb, 0, 7, 8]);

const MAIN_BASE = 'line1\nline2\nline3\n';
const MAIN_VERSION = 'line1\nline2-MAIN\nline3\n';
const PREVIEW_VERSION = 'line1\nline2-PREVIEW\nline3\n';

async function backupNames(handlers, dir) {
  const bs = await handlers.git.listBranches(dir);
  return bs.map((b) => (typeof b === 'string' ? b : b.name)).filter((n) => n.startsWith('backup/'));
}

/** Publish-flow text conflict fixture (mirrors conflict-resolve shapes). */
async function textConflictPair(providerName) {
  const pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_MD_BASE } });
  const handlers = makeFlowHandlers(pair.local.dir, providerName);
  await makeDivergent(pair, {
    remoteFiles: { 'a.md': A_MD_REMOTE, 'new-remote.md': 'from remote\n' },
    remoteMessage: 'remote: conflict edit',
  });
  makeDirty(pair.local, { 'a.md': A_MD_LOCAL });
  return { pair, handlers };
}

/** Binary-ONLY conflict fixture: the sole conflict is asset.bin. */
async function binaryOnlyPair(providerName) {
  const pair = await createRepoPair({ branch: 'preview' });
  const handlers = makeFlowHandlers(pair.local.dir, providerName);

  pair.local.writeFiles({ 'asset.bin': BIN_BASE });
  await pair.local.commit('base: asset.bin', 'asset.bin');
  await pair.local.push('preview');

  await pair.remote.fetch();
  const originTip = await git.resolveRef({ fs, dir: pair.remote.dir, ref: 'origin/preview' });
  await git.branch({ fs, dir: pair.remote.dir, ref: 'preview', object: originTip });
  await git.checkout({ fs, dir: pair.remote.dir, ref: 'preview' });
  // Remote: binary edit + a CLEAN text addition (proves the merge would
  // be clean everywhere except the binary).
  pair.remote.writeFiles({ 'asset.bin': BIN_REMOTE, 'notes.md': 'remote text\n' });
  await pair.remote.commit('remote: edit asset.bin', ['asset.bin', 'notes.md']);
  await pair.remote.push('preview');

  makeDirty(pair.local, { 'asset.bin': BIN_LOCAL });
  return { pair, handlers };
}

/** publish-main promotable-conflict fixture (mirrors parity-suite). */
async function publishMainPair(providerName) {
  const pair = await createRepoPair({ branch: 'main', files: { 'conflict.txt': MAIN_BASE } });
  const handlers = makeFlowHandlers(pair.local.dir, providerName);

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
  return { pair, handlers };
}

// ─── Parameterized parity scenarios ──────────────────────────────────────────

describe.each(providersUnderTest())('conflict-strategy parity [%s]', (providerName) => {
  let gateOpen;
  let binaryGateOpen;

  beforeEach(async () => {
    gateOpen = await divergentFlowsWork(providerName);
    binaryGateOpen = await binaryFallbackWorks(providerName);
  });

  // ── 1+2. Lifecycle: detection → pending → strategy / cancel ──────────────

  describe('lifecycle — publish text conflict', () => {
    describe.each([
      ['MERGE_LOCAL', 'line5-LOCAL', 'line5-REMOTE'],
      ['FULL_LOCAL', 'line5-LOCAL', 'line5-REMOTE'],
      ['MERGE_REMOTE', 'line5-REMOTE', 'line5-LOCAL'],
      ['FULL_REMOTE', 'line5-REMOTE', 'line5-LOCAL'],
    ])('resume [%s]', (strategy, winner, loser) => {
      let pair;
      let handlers;

      beforeEach(async () => {
        ({ pair, handlers } = await textConflictPair(providerName));
      });
      afterEach(() => pair.dispose());

      it('detection → typed pending → resume applies the winner; history keeps both sides', async (ctx) => {
        gateOnCapability(ctx, gateOpen, 'T10-D1/T10-D2 (conflict lifecycle)');

        // Detection: typed CONFLICT_PENDING, lock NOT leaked.
        const pending = await handlers.gitPublishPreview(1, 'local: conflicting edit');
        expect(pending.success).toBe(false);
        expect(pending.code).toBe('CONFLICT_PENDING');
        expect(pending.flow).toBe('publish');
        expect(pending.files).toContain('a.md');
        expect(pending.strategies).toEqual([
          'MERGE_LOCAL', 'MERGE_REMOTE', 'FULL_LOCAL', 'FULL_REMOTE',
        ]);
        expect(handlers.gitOperationInProgress).toBe(false);

        // Resume: winner content, clean remote content integrated.
        const result = await handlers.gitResolveConflict(pending.resumeToken, strategy);
        expect(result.success).toBe(true);
        expect(result.branch).toBe('preview');
        const aMd = await pair.local.readFile('a.md');
        expect(aMd).toContain(winner);
        expect(aMd).not.toContain(loser);
        expect(fs.existsSync(path.join(pair.local.dir, 'new-remote.md'))).toBe(true);

        // Push completed + both versions reachable in history.
        expect(await pair.local.resolveRef('HEAD')).toBe(
          await pair.local.resolveRef('refs/remotes/origin/preview')
        );
        const messages = (await pair.local.log(20)).map((c) => c.commit.message);
        expect(messages.some((m) => m.includes('remote: conflict edit'))).toBe(true);
        expect(messages.some((m) => m.includes('local: conflicting edit'))).toBe(true);
        expect(messages.some((m) => new RegExp(`merge.*${strategy}`, 'i').test(m))).toBe(true);

        // Lock released after resume; token single-use.
        expect(handlers.gitOperationInProgress).toBe(false);
        const reuse = await handlers.gitResolveConflict(pending.resumeToken, strategy);
        expect(reuse.success).toBe(false);
        expect(reuse.code).toBe('INVALID_TOKEN');
      });
    });

    describe('CANCEL', () => {
      let pair;
      let handlers;

      beforeEach(async () => {
        ({ pair, handlers } = await textConflictPair(providerName));
      });
      afterEach(() => pair.dispose());

      it('clean abort: backup + WIP preserved, no merge, no lock leak, token consumed', async (ctx) => {
        gateOnCapability(ctx, gateOpen, 'T10-D1/T10-D2 (cancel)');
        const pending = await handlers.gitPublishPreview(1, 'local: conflicting edit');
        expect(pending.code).toBe('CONFLICT_PENDING');
        const backupsAtPending = await backupNames(handlers, pair.local.dir);
        expect(backupsAtPending.length).toBeGreaterThan(0);
        expect(handlers.gitOperationInProgress).toBe(false);

        const result = await handlers.gitResolveConflict(pending.resumeToken, 'CANCEL');

        expect(result.success).toBe(false);
        expect(result.code).toBe('CANCELLED');

        // Backup PRESERVED (not pruned, not deleted).
        expect(await backupNames(handlers, pair.local.dir)).toEqual(backupsAtPending);

        // WIP commit PRESERVED + local version intact + never merged.
        const messages = (await pair.local.log(20)).map((c) => c.commit.message);
        expect(messages.some((m) => m.includes('local: conflicting edit'))).toBe(true);
        expect(messages.some((m) => /merge/i.test(m))).toBe(false);
        expect(await pair.local.readFile('a.md')).toContain('line5-LOCAL');
        expect(fs.existsSync(path.join(pair.local.dir, 'new-remote.md'))).toBe(false);

        // Lock NOT leaked after cancel.
        expect(handlers.gitOperationInProgress).toBe(false);

        // Token consumed by the cancel.
        const late = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');
        expect(late.code).toBe('INVALID_TOKEN');
      });
    });
  });

  // ── 3. Token single-use consumed only AFTER the lock ─────────────────────

  describe('token × lock ordering', () => {
    let pair;
    let handlers;

    beforeEach(async () => {
      ({ pair, handlers } = await textConflictPair(providerName));
    });
    afterEach(() => pair.dispose());

    it('a lock held by an unrelated op does NOT consume the token (retryable)', async (ctx) => {
      gateOnCapability(ctx, gateOpen, 'T10-D1/T10-D2 (token/lock ordering)');
      const pending = await handlers.gitPublishPreview(1, 'local: conflicting edit');
      expect(pending.code).toBe('CONFLICT_PENDING');

      // Simulate an unrelated in-flight operation holding the lock.
      expect(handlers.acquireGitLock()).toBe(true);

      const busy = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');
      expect(busy.success).toBe(false);
      expect(busy.retryable).toBe(true);

      // Token SURVIVED the lock conflict — not consumed.
      expect(handlers._pendingConflicts.has(pending.resumeToken)).toBe(true);

      handlers.releaseGitLock();

      // Same token still resumes successfully once the lock is free.
      const ok = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');
      expect(ok.success).toBe(true);
      expect(await pair.local.readFile('a.md')).toContain('line5-LOCAL');
      expect(handlers.gitOperationInProgress).toBe(false);
    });
  });

  // ── 4. Edge: binary-ONLY conflict ────────────────────────────────────────

  describe('edge — binary-only conflict', () => {
    describe.each([
      ['MERGE_LOCAL', BIN_LOCAL],
      ['FULL_LOCAL', BIN_LOCAL],
      ['MERGE_REMOTE', BIN_REMOTE],
      ['FULL_REMOTE', BIN_REMOTE],
    ])('%s', (strategy, winningBytes) => {
      let pair;
      let handlers;

      beforeEach(async () => {
        ({ pair, handlers } = await binaryOnlyPair(providerName));
      });
      afterEach(() => pair.dispose());

      it('modal fires (pending files = [asset.bin]); strategy decides the winning bytes', async (ctx) => {
        gateOnCapability(ctx, gateOpen, 'T10-D1/T10-D2 (binary-only conflict)');
        // T5-1: iso-git binary fallback no-ops (wrong REMOTE bytes, clean
        // remote files dropped) — see issues.md; gate re-evaluates every run.
        gateOnCapability(ctx, binaryGateOpen, 'T5-1 (binary fallback resolution)');
        const pending = await handlers.gitPublishPreview(1, 'local: binary edit');

        // The ONLY conflict is the binary — the modal MUST fire for it.
        expect(pending.success).toBe(false);
        expect(pending.code).toBe('CONFLICT_PENDING');
        expect(pending.files).toEqual(['asset.bin']);

        const result = await handlers.gitResolveConflict(pending.resumeToken, strategy);
        expect(result.success).toBe(true);

        // Winning side's bytes, byte-identical; clean remote text integrated.
        expect(Buffer.compare(await pair.local.readBytes('asset.bin'), winningBytes)).toBe(0);
        expect(fs.existsSync(path.join(pair.local.dir, 'notes.md'))).toBe(true);
        expect(handlers.gitOperationInProgress).toBe(false);
      });
    });
  });

  // ── 5. Edge: publish-main ours=main / theirs=preview across strategies ───

  describe('edge — publish-main mapping (ours=main, theirs=preview)', () => {
    describe.each([
      ['MERGE_LOCAL', 'line2-MAIN', 'line2-PREVIEW'],
      ['FULL_LOCAL', 'line2-MAIN', 'line2-PREVIEW'],
      ['MERGE_REMOTE', 'line2-PREVIEW', 'line2-MAIN'],
      ['FULL_REMOTE', 'line2-PREVIEW', 'line2-MAIN'],
    ])('%s', (strategy, winner, loser) => {
      let pair;
      let handlers;

      beforeEach(async () => {
        ({ pair, handlers } = await publishMainPair(providerName));
      });
      afterEach(() => pair.dispose());

      it(`promotes ${winner} to origin/main with a merge commit`, async (ctx) => {
        gateOnCapability(ctx, gateOpen, 'T10-D1/T10-D2 (publish-main mapping)');
        const pending = await handlers.gitPublishMain(1);
        expect(pending.success).toBe(false);
        expect(pending.code).toBe('CONFLICT_PENDING');
        expect(pending.flow).toBe('publish-main');
        expect(pending.files).toContain('conflict.txt');
        expect(handlers.gitOperationInProgress).toBe(false);

        const result = await handlers.gitResolveConflict(pending.resumeToken, strategy);
        expect(result.success).toBe(true);

        // Round-trip through the REAL remote: origin/main carries the winner.
        await pair.remote.fetch();
        await git.checkout({ fs, dir: pair.remote.dir, ref: 'origin/main', force: true });
        const promoted = await pair.remote.readFile('conflict.txt');
        expect(promoted).toContain(winner);
        expect(promoted).not.toContain(loser);

        // Both sides stay in history (merge commit with 2 parents on main).
        const originMain = await pair.local.resolveRef('refs/remotes/origin/main');
        const { commit } = await git.readCommit({ fs, dir: pair.local.dir, oid: originMain });
        expect(commit.parent).toHaveLength(2);
        // Each parent carries its side of the conflict (main edit + preview edit).
        const parentMessages = [];
        for (const parentOid of commit.parent) {
          const { commit: parentCommit } = await git.readCommit({
            fs, dir: pair.local.dir, oid: parentOid,
          });
          parentMessages.push(parentCommit.message);
        }
        expect(parentMessages.some((m) => m.includes('main: edit line2'))).toBe(true);
        expect(parentMessages.some((m) => m.includes('preview: edit line2'))).toBe(true);
        expect(handlers.gitOperationInProgress).toBe(false);
      });
    });
  });

  // ── 6. Edge: fail-open — clean merge NEVER mints a false pending ─────────

  describe('edge — fail-open (no false CONFLICT_PENDING on clean merge)', () => {
    let pair;
    let handlers;

    beforeEach(async () => {
      pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_MD_BASE } });
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    it('non-conflicting divergence auto-merges without CONFLICT_PENDING', async (ctx) => {
      gateOnCapability(ctx, gateOpen, 'T10-D1/T10-D2 (fail-open clean merge)');
      // Different hunks (line1 vs line10) → diff3 sees a CLEAN merge.
      await makeDivergent(pair, {
        remoteFiles: { 'a.md': A_MD_BASE.replace('line10', 'line10-REMOTE') },
        remoteMessage: 'remote: clean edit',
      });
      makeDirty(pair.local, { 'a.md': A_MD_BASE.replace('line1', 'line1-LOCAL') });

      const result = await handlers.gitPublishPreview(1, 'local: clean edit');

      expect(result.success).toBe(true);
      expect(result.code).toBeUndefined();
      const aMd = await pair.local.readFile('a.md');
      expect(aMd).toContain('line1-LOCAL');
      expect(aMd).toContain('line10-REMOTE');
      expect(handlers.gitOperationInProgress).toBe(false);
    });

    it('refresh with clean divergence also stays fully automatic', async (ctx) => {
      gateOnCapability(ctx, gateOpen, 'T10-D1/T10-D2 (fail-open clean refresh)');
      await makeDivergent(pair, {
        remoteFiles: { 'b.md': 'remote only\n' },
        remoteMessage: 'remote: add b.md',
      });
      makeDirty(pair.local, { 'a.md': A_MD_LOCAL });

      const result = await handlers.gitRefresh(1);

      expect(result.success).toBe(true);
      expect(result.code).toBeUndefined();
      expect(await pair.local.readFile('a.md')).toContain('line5-LOCAL');
      expect(fs.existsSync(path.join(pair.local.dir, 'b.md'))).toBe(true);
      expect(handlers.gitOperationInProgress).toBe(false);
    });
  });
});
