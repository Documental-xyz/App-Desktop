/**
 * @fileoverview Task 10 (git-sync-strategy): EDGE CASES with dedicated
 * tests, run on BOTH providers (describe.each via providersUnderTest).
 *
 *   1. empty repo / first publish (origin has NO branches)
 *   2. missing upstream → hasUnpushed correct (true)
 *   3. WIP commit conflicting with the remote (committed local side)
 *   4. lock held during merge (timeout shape) → recovery via backup
 *   5. cancel mid-merge in the FULL flow → backup retained, state
 *      recoverable
 *   6. genuinely SHALLOW local clone (no merge-base after depth:1) →
 *      automatic deepen by the refresh flow
 *   7. shallow push errors classified as PUSH_REJECTED
 *
 * Divergent scenarios under dugite are conditionally gated on the
 * capability probes (bugs T10-D1/T10-D2 in
 * .omo/notepads/git-sync-strategy/issues.md) — see parity-suite.test.js
 * for the policy; the gates re-evaluate on every run.
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
} from './fixtures/providerHarness.js';

const git = gitModule.default || gitModule;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const A_BASE = 'line1\nline2\nline3\n';

async function backupBranches(handlers, dir) {
  const bs = await handlers.git.listBranches(dir);
  return bs.map((b) => (typeof b === 'string' ? b : b.name)).filter((n) => n.startsWith('backup/'));
}

describe.each(providersUnderTest())('edge cases [%s]', (providerName) => {
  let pair;
  let handlers;
  let divergentGateOpen;

  beforeEach(async () => {
    divergentGateOpen = await divergentFlowsWork(providerName);
  });

  // ── 1. Empty repo / first publish ────────────────────────────────────────

  describe('empty origin — first publish', () => {
    beforeEach(async () => {
      // Origin bare repo has NO branches at all; local has one commit.
      pair = await createRepoPair({ branch: 'preview' });
      pair.local.writeFiles({ 'a.md': 'first\n' });
      await pair.local.commit('local: initial', 'a.md');
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    it('publishes to the nonexistent origin/preview without throwing', async (ctx) => {
      gateOnCapability(ctx, await dugiteMissingRefFetchTolerated(providerName), 'T10-D2 (first publish)');
      const result = await handlers.gitPublishPreview(1, 'first publish');

      expect(result.success).toBe(true);
      // origin/preview now exists at exactly the published commit.
      const origin = await pair.local.resolveRef('refs/remotes/origin/preview');
      expect(origin).toBe(await pair.local.resolveRef('HEAD'));
      // Round-trip: the colleague fetches the brand-new branch.
      await pair.remote.fetch();
      const originTip = await git.resolveRef({ fs, dir: pair.remote.dir, ref: 'origin/preview' });
      expect(originTip).toBe(origin);
    });
  });

  // ── 2. Missing upstream → hasUnpushed ────────────────────────────────────

  describe('missing upstream → gitCheckUnpushed', () => {
    beforeEach(async () => {
      pair = await createRepoPair({ branch: 'preview' });
      pair.local.writeFiles({ 'a.md': 'local only\n' });
      await pair.local.commit('local: initial', 'a.md');
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    it('treats a missing origin/<branch> as hasUnpushed=true (never false-negative)', async () => {
      const result = await handlers.gitCheckUnpushed(pair.local.dir);
      expect(result.success).toBe(true);
      expect(result.hasUnpushed).toBe(true);
      expect(result.remoteSha).toBeNull();
    });

    it('in-sync repo (after push) reports hasUnpushed=false', async () => {
      await pair.local.push('preview');
      await pair.local.fetch();
      handlers._gitCache = {};
      const result = await handlers.gitCheckUnpushed(pair.local.dir);
      expect(result.success).toBe(true);
      expect(result.hasUnpushed).toBe(false);
    });
  });

  // ── 3. WIP commit conflicting with the remote (committed local side) ─────

  describe('committed local WIP conflicts with remote', () => {
    beforeEach(async () => {
      pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    it('refresh: pending, MERGE_LOCAL resume keeps the LOCAL (committed) version, remote in history', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (committed-WIP refresh)');
      // BOTH sides commit a conflicting edit of line2.
      await makeDivergent(pair, {
        localFiles: { 'a.md': 'line1\nline2-LOCAL\nline3\n' },
        localMessage: 'local: WIP commit edit line2',
        remoteFiles: { 'a.md': 'line1\nline2-REMOTE\nline3\n' },
        remoteMessage: 'remote: edit line2',
      });

      const result = await handlers.gitRefresh(1);

      expect(result.success).toBe(false);
      expect(result.code).toBe('CONFLICT_PENDING');

      const resumed = await handlers.gitResolveConflict(result.resumeToken, 'MERGE_LOCAL');
      expect(resumed.success).toBe(true);
      const aMd = await pair.local.readFile('a.md');
      expect(aMd).toContain('line2-LOCAL');
      expect(aMd).not.toContain('line2-REMOTE');
      const messages = (await pair.local.log(20)).map((c) => c.commit.message);
      expect(messages.some((m) => m.includes('remote: edit line2'))).toBe(true);
      expect(messages.some((m) => /merge/i.test(m))).toBe(true);
    });
  });

  // ── 4. Lock held during merge → recovery via backup ──────────────────────

  describe('lock held during merge → recovery via backup', () => {
    beforeEach(async () => {
      pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    it('second operation is refused; backup restores the tree; backup retained', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (lock-timeout recovery fixture)');
      // NON-conflicting divergence (remote adds a file): a conflicting one
      // would now pause as CONFLICT_PENDING before ever reaching the merge.
      await makeDivergent(pair, {
        remoteFiles: { 'c.md': 'remote content\n' },
        remoteMessage: 'remote: add c.md',
      });
      makeDirty(pair.local, { 'a.md': 'line1\nline2-LOCAL\nline3\n' });

      // Freeze the flow INSIDE the merge step (post-backup): the merge
      // promise never settles, exactly like a lock-timeout mid-merge.
      const mergeSpy = vi.spyOn(handlers.git, 'merge').mockImplementation(
        () => new Promise(() => {})
      );

      const inFlight = handlers.gitRefresh(1); // intentionally never awaited
      // Wait until the mandatory backup exists (created BEFORE merge).
      let backups = [];
      for (let i = 0; i < 200 && backups.length === 0; i++) {
        backups = await backupBranches(handlers, pair.local.dir);
        if (!backups.length) await new Promise((r) => setTimeout(r, 25));
      }
      expect(backups.length).toBeGreaterThan(0);
      const backup = backups[0];

      // While op A holds the lock, a second flow is REFUSED (no second
      // mutation path — the lock is the guard the timeout relies on).
      expect(handlers.gitOperationInProgress).toBe(true);
      const second = await handlers.gitRefresh(1);
      expect(second.success).toBe(false);

      // Timeout shape: the lock auto-aborts + releases (as the watchdog
      // would); recovery then restores the branch from the backup.
      handlers.releaseGitLock();
      mergeSpy.mockRestore();

      const backupOid = await git.resolveRef({
        fs, dir: pair.local.dir, ref: `refs/heads/${backup}`,
      });
      await handlers.git.writeRef(pair.local.dir, 'refs/heads/preview', backupOid, { force: true });
      await handlers.git.checkout(pair.local.dir, 'preview', { force: true });

      // Working tree restored to the backup snapshot: the dirty WIP edit
      // is preserved (commit-first made it part of the backup).
      expect(await pair.local.readFile('a.md')).toContain('line2-LOCAL');
      // The backup branch still exists (never deleted by recovery).
      expect((await backupBranches(handlers, pair.local.dir))).toContain(backup);
      void inFlight;
    });
  });

  // ── 5. Cancel mid-merge in the full flow ─────────────────────────────────

  describe('cancel mid-merge (full flow)', () => {
    beforeEach(async () => {
      pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    it('returns cancelled, retains the backup, leaves a recoverable state', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (cancel mid-merge fixture)');
      // NON-conflicting divergence so the flow reaches the merge (a real
      // conflict now pauses as CONFLICT_PENDING before the merge step).
      await makeDivergent(pair, {
        remoteFiles: { 'c.md': 'remote content\n' },
        remoteMessage: 'remote: add c.md',
      });
      makeDirty(pair.local, { 'a.md': 'line1\nline2-LOCAL\nline3\n' });

      // Request cancellation exactly when the merge step runs. The
      // publish flow checks cancel AFTER the merge/materialize and
      // BEFORE the push — the classic mid-merge cancel window.
      const originalMerge = handlers.git.merge.bind(handlers.git);
      const mergeSpy = vi.spyOn(handlers.git, 'merge').mockImplementation(
        async (...args) => {
          handlers.cancelRequested = true;
          return originalMerge(...args);
        }
      );

      const result = await handlers.gitPublishPreview(1, 'local: edit');
      mergeSpy.mockRestore();

      expect(result.cancelled).toBe(true);

      // Nothing was pushed (cancelled before push) and the backup is
      // retained (cancel NEVER deletes it).
      const backups = await backupBranches(handlers, pair.local.dir);
      expect(backups.length).toBeGreaterThan(0);
      expect(handlers.gitOperationInProgress).toBe(false);

      // Recovery contract: writeRef(backup) + checkout restores the WIP.
      const backupOid = await git.resolveRef({
        fs, dir: pair.local.dir, ref: `refs/heads/${backups[0]}`,
      });
      await handlers.git.writeRef(pair.local.dir, 'refs/heads/preview', backupOid, { force: true });
      await handlers.git.checkout(pair.local.dir, 'preview', { force: true });
      expect(await pair.local.readFile('a.md')).toContain('line2-LOCAL');
    });
  });

  // ── 6. Genuinely shallow clone → automatic deepen ─────────────────────────

  describe('shallow local clone without merge-base → automatic deepen', () => {
    it('refresh merges a depth:1 clone after the flow deepens the fetch', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1 (shallow deepen)');
      // A REAL user shape: shallow depth:1 clone, then the origin moves.
      const BASE = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
      const seedPair = await createRepoPair({ branch: 'preview', files: { 'b.md': BASE } });
      try {
        const userDir = path.join(seedPair.baseDir, 'user-shallow');
        await git.clone({
          fs, dir: userDir, http: (await import('isomorphic-git/http/node')).default,
          url: seedPair.url, ref: 'preview', singleBranch: true, depth: 1,
        });

        // Origin advances AFTER the shallow clone → no merge-base in the
        // user's shallow history.
        await makeDivergent(seedPair, {
          remoteFiles: { 'b.md': BASE.replace('line25', 'line25-REMOTE') },
          remoteMessage: 'remote: after shallow clone',
        });

        handlers = makeFlowHandlers(userDir, providerName);
        fs.writeFileSync(path.join(userDir, 'b.md'), BASE.replace('line5', 'line5-LOCAL'));

        const result = await handlers.gitRefresh(1);

        expect(result.success).toBe(true);
        const bMd = fs.readFileSync(path.join(userDir, 'b.md'), 'utf8');
        expect(bMd).toContain('line5-LOCAL');
        expect(bMd).toContain('line25-REMOTE');
        const messages = (await git.log({ fs, dir: userDir, depth: 20 })).map((c) => c.commit.message);
        expect(messages.some((m) => m.includes('remote: after shallow clone'))).toBe(true);
        expect(messages.some((m) => m.startsWith('WIP by testuser at'))).toBe(true);
      } finally {
        seedPair.dispose();
      }
    });
  });

  // ── 7. Shallow push errors classified as PUSH_REJECTED ───────────────────

  describe('shallow push error → PUSH_REJECTED', () => {
    beforeEach(async () => {
      pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });
    afterEach(() => pair.dispose());

    it('publish classifies a shallow-history push rejection as PUSH_REJECTED', async (ctx) => {
      // Local AHEAD of origin (no divergence → no merge) so the flow
      // reaches the push step, which we reject with git's classic
      // shallow-update error.
      pair.local.writeFiles({ 'a.md': 'line1\nline2-LOCAL\nline3\n' });
      await pair.local.commit('local: ahead commit', 'a.md');
      handlers._gitCache = {};

      vi.spyOn(handlers.git, 'push').mockRejectedValue(
        Object.assign(
          new Error('push failed: ! [remote rejected] preview -> preview (shallow update not allowed)'),
          { code: 'PushRejectedError' }
        )
      );

      const result = await handlers.gitPublishPreview(1, 'local: ahead');

      expect(result.success).toBe(false);
      expect(result.code).toBe('PUSH_REJECTED');
      expect(result.error).toMatch(/atualiz/i);
      // Zero local loss + lock released.
      expect(await pair.local.readFile('a.md')).toContain('line2-LOCAL');
      expect(handlers.gitOperationInProgress).toBe(false);
    });
  });
});
