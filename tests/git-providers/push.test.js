/**
 * @fileoverview Dual-provider PUSH scenarios (plan checkbox 18 / PRD §29).
 *
 * Same transport for BOTH providers: local bare repo served over loopback
 * http (git http-backend CGI) — see harness.js. No external network, no
 * credentials. Fixture expectations derive from the incumbent
 * (isomorphic-git) behavior.
 *
 * Scenarios (PRD §29):
 *   1. small push                         6. push to an existing branch (ff)
 *   2. push with many files (100)         7. rejected non-fast-forward → conflict
 *   3. push with a large file (50MB*)     8. unreachable remote (localhost:1) → network
 *   4. push with nothing new (no-op)      9. timeout via AbortSignal (blackhole remote)
 *   5. push a new branch                 10. retry parity: gitOperations._pushWithRetry
 *                                           over the dugite provider
 *
 * (*) Large file defaults to 50MB per the PRD. If the 50MB payload blows
 * the vitest timeout on slower machines/CI, set PROVIDER_PUSH_BIG_MB=10 —
 * the scenario is identical, only the payload shrinks (fallback sanctioned
 * by the task brief).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';

import { GitOperations } from '../../src/ipc/gitOperations.js';
import { DugiteProvider } from '../../src/git/providers/DugiteProvider.js';
import { resetGitProviderCache } from '../../src/git/GitProviderFactory.js';
import {
  makeTempDir,
  createHttpRemote,
  createBlackholeServer,
  advanceRemoteHead,
  remoteHead,
  remoteBranches,
  gitSetup,
  initLocalRepo,
  providersUnderTest,
  providerFactory,
  isGitError,
  randomBytes,
  httpBackendAvailable,
  removeTempDir,
} from './harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const BIG_MB = Number(process.env.PROVIDER_PUSH_BIG_MB || 50);
const MANY_FILES = 100;

/**
 * The parametrized push battery for one provider.
 * @param {string} name
 * @param {() => Object} factory
 */
function describePushProvider(name, factory) {
  // GATE (capability, never unconditional): every scenario in this
  // battery clones/pushes over the loopback git-http-backend server.
  // Where the bundled git lacks the http-backend CGI (mac/win runners),
  // the battery skips — it re-opens automatically once the runner's git
  // ships the binary (harness.httpBackendAvailable probe).
  describe.skipIf(!httpBackendAvailable)(`push scenarios — provider: ${name}`, () => {
    /** @type {Object} */
    let provider;
    /** @type {string} */
    let base;
    const originalEnv = process.env.GIT_PROVIDER;

    beforeEach(() => {
      base = makeTempDir('dual-push-');
      provider = factory();
    });

    afterEach(async () => {
      resetGitProviderCache();
      if (originalEnv === undefined) {
        delete process.env.GIT_PROVIDER;
      } else {
        process.env.GIT_PROVIDER = originalEnv;
      }
      // Tolerant removal (Windows EBUSY: aborted-push children can hold
      // the work dir cwd briefly) — same helper as provider-suite.
      await removeTempDir(base);
    });

    /** Fresh provider-cloned working repo against its own loopback remote. */
    async function clonedWorkspace() {
      const remote = await createHttpRemote(base);
      const dir = path.join(base, 'work');
      await provider.clone(remote.url, dir);
      return { ...remote, dir };
    }

    it('small push: one file commit reaches the remote', async () => {
      const { server, bare, dir } = await clonedWorkspace();
      try {
        fs.writeFileSync(path.join(dir, 'small.txt'), 'small payload\n');
        await provider.add(dir, 'small.txt');
        const oid = await provider.commit(dir, 'small push');
        await provider.push(dir, { branch: 'main' });
        expect(await remoteHead(bare)).toBe(oid);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it(`many files: push ${MANY_FILES} files in one commit`, async () => {
      const { server, bare, dir } = await clonedWorkspace();
      try {
        const names = [];
        for (let i = 0; i < MANY_FILES; i++) {
          const name = `many/file-${String(i).padStart(3, '0')}.txt`;
          fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
          fs.writeFileSync(path.join(dir, name), randomBytes(1024));
          names.push(name);
        }
        await provider.add(dir, names);
        const oid = await provider.commit(dir, `push ${MANY_FILES} files`);
        await provider.push(dir, { branch: 'main' });
        expect(await remoteHead(bare)).toBe(oid);
      } finally {
        await new Promise((r) => server.close(r));
      }
    }, 180_000);

    it(`large file: push a single ${BIG_MB}MB incompressible file`, async () => {
      const { server, bare, dir } = await clonedWorkspace();
      try {
        // Random bytes: git's zlib cannot shrink it, so the transport
        // really carries the full payload (a zero-filled "sparse" file
        // would compress to almost nothing and hollow out the scenario).
        fs.writeFileSync(path.join(dir, 'big.bin'), randomBytes(BIG_MB * 1024 * 1024));
        await provider.add(dir, 'big.bin');
        const oid = await provider.commit(dir, `big ${BIG_MB}MB push`);
        await provider.push(dir, { branch: 'main' });
        expect(await remoteHead(bare)).toBe(oid);
      } finally {
        await new Promise((r) => server.close(r));
      }
    }, 300_000);

    it('push with nothing new to push resolves (no-op)', async () => {
      const { server, bare, dir } = await clonedWorkspace();
      try {
        const before = await remoteHead(bare);
        await provider.push(dir, { branch: 'main' });
        expect(await remoteHead(bare)).toBe(before);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it('push a NEW branch creates refs/heads/<branch> on the remote', async () => {
      const { server, bare, dir } = await clonedWorkspace();
      try {
        await provider.branch(dir, 'feature-x');
        await provider.checkout(dir, 'feature-x');
        fs.writeFileSync(path.join(dir, 'fx.txt'), 'feature work\n');
        await provider.add(dir, 'fx.txt');
        const oid = await provider.commit(dir, 'feature commit');
        await provider.push(dir, { branch: 'feature-x' });
        expect(await remoteBranches(bare)).toContain('feature-x');
        expect(oid).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it('push to an EXISTING branch fast-forwards the remote', async () => {
      const { server, bare, dir } = await clonedWorkspace();
      try {
        fs.writeFileSync(path.join(dir, 'first.txt'), 'first\n');
        await provider.add(dir, 'first.txt');
        await provider.commit(dir, 'first');
        await provider.push(dir, { branch: 'main' });

        fs.writeFileSync(path.join(dir, 'second.txt'), 'second\n');
        await provider.add(dir, 'second.txt');
        const oid = await provider.commit(dir, 'second');
        await provider.push(dir, { branch: 'main' });

        expect(await remoteHead(bare)).toBe(oid);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it('rejected push (non-fast-forward) throws GitError with errorType conflict', async () => {
      const { server, bare, dir } = await clonedWorkspace();
      try {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
        await provider.add(dir, 'a.txt');
        await provider.commit(dir, 'a');
        await provider.push(dir, { branch: 'main' });

        // Diverge: remote advances (commit-tree, no worktree needed) AND
        // the local side commits too.
        await advanceRemoteHead(bare, 'remote-side change');
        fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
        await provider.add(dir, 'b.txt');
        await provider.commit(dir, 'local-side change');

        let err = null;
        try {
          await provider.push(dir, { branch: 'main' });
        } catch (e) {
          err = e;
        }
        // iso: PushRejectedError('not-fast-forward') → 'conflict';
        // dugite: '! [rejected] ... non-fast-forward' → 'conflict'.
        expect(isGitError(err)).toBe(true);
        expect(err.errorType).toBe('conflict');
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it('unreachable remote (localhost:1) throws GitError with errorType network', async () => {
      const { server, dir } = await clonedWorkspace();
      try {
        fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
        await provider.add(dir, 'x.txt');
        await provider.commit(dir, 'x');

        await provider.setConfig(dir, 'remote.origin.url', 'http://127.0.0.1:1/remote.git');

        let err = null;
        try {
          await provider.push(dir, { branch: 'main' });
        } catch (e) {
          err = e;
        }
        // iso: ECONNREFUSED → network; dugite: 'Connection refused' /
        // 'Failed to connect' → network. Loopback port 1 is a guaranteed
        // refusal — no external network involved.
        expect(isGitError(err)).toBe(true);
        expect(err.errorType).toBe('network');
      } finally {
        await new Promise((r) => server.close(r));
      }
    }, 60_000);

    it('timeout via signal: aborted push against a blackhole remote throws GitError', async () => {
      const remote = await createHttpRemote(base);
      const { close: closeHole, url } = await createBlackholeServer();
      try {
        const dir = path.join(base, 'work');
        await provider.clone(remote.url, dir);

        fs.writeFileSync(path.join(dir, 'slow.txt'), 'never arrives in time\n');
        await provider.add(dir, 'slow.txt');
        await provider.commit(dir, 'slow push');

        // Point origin at the blackhole, then abort mid-flight.
        await provider.setConfig(dir, 'remote.origin.url', url);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 250);

        let err = null;
        try {
          await provider.push(dir, { branch: 'main', signal: controller.signal });
        } catch (e) {
          err = e;
        }
        // CONTRACT: aborted push surfaces as GitError. Timing is
        // provider-specific (dugite: process kill; iso: internal ~5s
        // request timeout — documented divergence, T9) and NOT asserted.
        expect(isGitError(err)).toBe(true);
      } finally {
        await new Promise((r) => remote.server.close(r));
        await closeHole();
      }
    }, 60_000);

    // ─── Regression specs: post 7afc290 (dugite remoteRef semantics) ─────────

    /** oid of a named branch on the bare remote */
    async function remoteBranchOid(bare, ref) {
      return (await gitSetup(['rev-parse', `refs/heads/${ref}`], bare)).stdout.trim();
    }

    it('regression 7afc290: push {remoteRef, ref} creates the alias branch WITHOUT deleting the source', async () => {
      const { server, bare, dir } = await clonedWorkspace();
      try {
        fs.writeFileSync(path.join(dir, 'alias.txt'), 'alias\n');
        await provider.add(dir, 'alias.txt');
        const oid = await provider.commit(dir, 'alias source commit');
        await provider.push(dir, { branch: 'main' });

        // Publish flow: main → preview. The source branch must survive.
        await provider.push(dir, { remoteRef: 'preview', ref: 'main' });

        const branches = await remoteBranches(bare);
        expect(branches).toContain('preview');
        expect(branches).toContain('main');
        expect(await remoteBranchOid(bare, 'preview')).toBe(oid);
        expect(await remoteBranchOid(bare, 'main')).toBe(oid);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it('regression 7afc290: push {remoteRef} alone pushes the CURRENT branch to the target ref', async () => {
      const { server, bare, dir } = await clonedWorkspace();
      try {
        fs.writeFileSync(path.join(dir, 'pub.txt'), 'publish\n');
        await provider.add(dir, 'pub.txt');
        const oid = await provider.commit(dir, 'publish current branch');

        // No explicit ref/branch: the push source falls back to the
        // checked-out branch (main).
        await provider.push(dir, { remoteRef: 'publish-tmp' });

        expect(await remoteBranches(bare)).toContain('publish-tmp');
        expect(await remoteBranchOid(bare, 'publish-tmp')).toBe(oid);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it('regression 7afc290: plain {branch} push against an existing remote main fast-forwards and does NOT delete it', async () => {
      const { server, bare, dir } = await clonedWorkspace();
      try {
        fs.writeFileSync(path.join(dir, 'p.txt'), 'p\n');
        await provider.add(dir, 'p.txt');
        await provider.commit(dir, 'p');
        await provider.push(dir, { branch: 'main' });

        // Remote already has main: a second plain branch push must
        // fast-forward it, never delete the ref.
        fs.writeFileSync(path.join(dir, 'q.txt'), 'q\n');
        await provider.add(dir, 'q.txt');
        const oid = await provider.commit(dir, 'q');
        await provider.push(dir, { branch: 'main' });

        expect(await remoteBranches(bare)).toContain('main');
        expect(await remoteBranchOid(bare, 'main')).toBe(oid);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });
}

for (const name of providersUnderTest()) {
  describePushProvider(name, providerFactory(name));
}

// ─── Retry parity: _pushWithRetry (gitOperations.js) over DUGITE ─────────────
//
// The wrapper lives ABOVE the provider interface (plan guardrail — never
// moved into providers). These specs prove it keeps working when the
// provider underneath is dugite: non-retriable errors abort immediately,
// retriable errors back off and retry, and real dugite GitErrors are
// classified as non-retriable when appropriate.
describe('retry parity — gitOperations._pushWithRetry over dugite', () => {
  let base;

  beforeEach(() => {
    base = makeTempDir('dual-retry-');
  });

  afterEach(async () => {
    await removeTempDir(base);
  });

  // GATE (capability): needs the loopback http-backend remote.
  it.skipIf(!httpBackendAvailable)('non-fast-forward through the REAL dugite provider throws immediately (no retry)', async () => {
    const ops = new GitOperations({ logger: null, databaseManager: null });
    const dugite = new DugiteProvider();
    const remote = await createHttpRemote(base);
    try {
      const dir = path.join(base, 'work');
      await dugite.clone(remote.url, dir);
      fs.writeFileSync(path.join(dir, 'w.txt'), 'w\n');
      await dugite.add(dir, 'w.txt');
      await dugite.commit(dir, 'w');

      // Wrapper publishes current branch → remoteRef ('preview' flow);
      // `ref` is a native alias of `branch` in DugiteProvider.push
      // (post 7afc290) — no adapter needed anymore.
      await ops._pushWithRetry(dir, remote.url, null, 'main', 'preview', () => {});
      expect(await remoteBranches(remote.bare)).toContain('preview');

      // Diverge both sides → non-ff. Conflict errors are NOT retriable:
      // the wrapper must throw on attempt 1 (no 'Retentando' output).
      await advanceRemoteHead(remote.bare, 'remote diverge', 'preview');
      fs.writeFileSync(path.join(dir, 'w.txt'), 'w2\n');
      await dugite.add(dir, 'w.txt');
      await dugite.commit(dir, 'w2');

      const sendOutput = vi.fn();
      let err = null;
      try {
        await ops._pushWithRetry(dir, remote.url, null, 'main', 'preview', sendOutput);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(sendOutput).not.toHaveBeenCalled(); // no retry happened
    } finally {
      await new Promise((r) => remote.server.close(r));
    }
  }, 120_000);

  it('retriable error (ECONNRESET) backs off and retries until success', async () => {
    const ops = new GitOperations({ logger: null, databaseManager: null });
    const calls = [];
    // Scripted facade: fail once with a retriable socket error, then
    // succeed — exercises the wrapper's backoff/classification branch
    // (1s delay for attempt 1 → 2^0 * 1000ms).
    ops.git = {
      push: async (_dir, opts) => {
        calls.push(opts);
        if (calls.length === 1) {
          throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        }
      },
    };

    const sendOutput = vi.fn();
    const t0 = Date.now();
    await ops._pushWithRetry('/irrelevant', 'http://127.0.0.1:9/x.git', null,
      'main', 'preview', sendOutput, 2);
    const elapsed = Date.now() - t0;

    expect(calls).toHaveLength(2);
    // The wrapper forwards its legacy opts shape to the provider layer.
    expect(calls[0]).toMatchObject({ url: 'http://127.0.0.1:9/x.git', ref: 'main', remoteRef: 'preview', force: false });
    expect(sendOutput).toHaveBeenCalledWith(expect.stringContaining('Retentando em 1s'));
    expect(elapsed).toBeGreaterThanOrEqual(900); // backoff actually waited
  }, 30_000);

  it('classification: a REAL dugite GitError (connection refused) is non-retriable; socket errors and push rejections classify correctly', async () => {
    const ops = new GitOperations({ logger: null, databaseManager: null });

    // Real dugite error: push to a refused loopback port.
    const dir = path.join(base, 'work');
    const dugite = new DugiteProvider();
    await initLocalRepo(dir);
    fs.writeFileSync(path.join(dir, 'r.txt'), 'r\n');
    await dugite.add(dir, 'r.txt');
    await dugite.commit(dir, 'r');
    await dugite.setConfig(dir, 'remote.origin.url', 'http://127.0.0.1:1/remote.git');

    let real = null;
    try {
      await dugite.push(dir, { branch: 'main' });
    } catch (e) {
      real = e;
    }
    expect(isGitError(real)).toBe(true);
    // No .code / no HTTP response on a dugite GitError → wrapper must NOT
    // hammer an unreachable remote with retries.
    expect(ops._isRetriablePushError(real)).toBe(false);

    // Classification table parity.
    expect(ops._isRetriablePushError(
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    )).toBe(true);
    expect(ops._isRetriablePushError(
      Object.assign(new Error('rejected'), { code: 'PushRejectedError' })
    )).toBe(false);
    expect(ops._isRetriablePushError(
      Object.assign(new Error('boom'), { response: { status: 502 } })
    )).toBe(true);
    expect(ops._isRetriablePushError(
      Object.assign(new Error('forbidden'), { response: { status: 403 } })
    )).toBe(false);
  }, 60_000);
});
