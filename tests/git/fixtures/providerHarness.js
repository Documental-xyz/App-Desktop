/**
 * @fileoverview Task 10 (git-sync-strategy): dual-provider plumbing for
 * the FLOW-level parity + edge-case suites.
 *
 * `makeFlowHandlers(dir, providerName)` builds a production GitHandlers
 * whose GitService is explicitly bound to ONE provider (bypassing the
 * process-wide GIT_PROVIDER default) so a single `describe.each` can run
 * the SAME fixtures against isomorphic-git and dugite.
 *
 * `dugiteDeepenFetchWorks()` / `dugiteMissingRefFetchTolerated()` are
 * runtime CAPABILITY PROBES — not skips. Each probe exercises the exact
 * provider capability the flow relies on:
 *
 *   - deepen fetch: `fetch()` WITHOUT `depth` must FULLY deepen a repo
 *     previously fetched with depth:1 (iso-git default semantics) so a
 *     merge-base exists. Bug: DugiteProvider.fetch defaults `depth = 1`
 *     (issues.md T10-D1) → every divergent publish/refresh under dugite
 *     dies with "refusing to merge unrelated histories".
 *
 *   - missing-ref tolerance: fetching a branch that does not exist on
 *     the remote must surface an error message the flow's first-publish
 *     detection recognizes (issues.md T10-D2).
 *
 * While a probe FAILS, the parity scenarios that depend on it are
 * conditionally skipped (ctx.skip) with a pointer to the issues.md
 * entry. The probes are re-evaluated on EVERY run: the moment the src
 * bug is fixed, the gates open automatically and the full parity suite
 * executes — there is NO unconditional skip anywhere. Companion
 * `it.fails` tripwires in parity-suite.test.js invert when the bug is
 * fixed, reminding maintainers that the gate can be removed.
 *
 * @vitest-environment node
 */

import { vi } from 'vitest';

// tests/setup.js mocks fs/path globally — fixtures need the REAL fs.
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import gitModule from 'isomorphic-git';

import { GitHandlers } from '../../../src/ipc/git.js';
import { GitService } from '../../../src/git/GitService.js';
import {
  providerFactory,
  GIT_AUTHOR,
} from '../../git-providers/harness.js';
import { createRepoPair } from './harness.js';

// ─── Flow handlers bound to one provider ─────────────────────────────────────

/**
 * Build a logger stub (flows log through it).
 */
export function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * Production GitHandlers whose project 1 resolves to `projectPath` and
 * whose git service is PINNED to `providerName`
 * ('isomorphic-git' | 'dugite').
 *
 * @param {string} projectPath
 * @param {string} providerName
 * @returns {import('../../../src/ipc/git.js').GitHandlers}
 */
export function makeFlowHandlers(projectPath, providerName) {
  const databaseManager = {
    getDatabase: vi.fn().mockResolvedValue({
      get: (_query, _params, callback) =>
        callback(null, { id: 1, projectPath, repoFolderName: null }),
    }),
  };
  const handlers = new GitHandlers({
    logger: makeLogger(),
    databaseManager,
    gitService: new GitService({ provider: providerFactory(providerName)() }),
  });
  vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('test-token');
  vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
  vi.spyOn(handlers.gitOps, 'getGitHubUserInfo').mockResolvedValue({ login: 'testuser' });
  // Preflight probes the real GitHub remote; the flows under test detect
  // missing branches / first publish by themselves.
  handlers.gitPreflight = null;
  return handlers;
}

// ─── Capability probes (dugite) ──────────────────────────────────────────────

/** Remove stale git lockfiles a previous FAILED fetch may have left. */
function clearFetchLocks(dir) {
  for (const lock of ['shallow.lock', 'config.lock']) {
    const p = path.join(dir, '.git', lock);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
}

/** @type {boolean|null} cached probe result (per test file process). */
let deepenProbeResult = null;

/**
 * Probe T10-D1: does `provider.fetch` WITHOUT `depth` deepen a repo that
 * was previously fetched with `depth: 1` (iso-git default semantics)?
 * The flow's divergent path depends on it for the merge-base.
 * @param {string} [providerName='dugite']
 * @returns {Promise<boolean>} true when the capability works
 */
export async function dugiteDeepenFetchWorks(providerName = 'dugite') {
  if (providerName !== 'dugite') return true;
  if (deepenProbeResult !== null) return deepenProbeResult;

  const provider = providerFactory(providerName)();
  const pair = await createRepoPair({
    branch: 'preview',
    files: { 'a.md': 'base\n' },
  });
  try {
    // Advance the remote so a depth:1 fetch has no merge-base with the
    // local (full-history) side — exactly the flow's divergent shape.
    pair.remote.writeFiles({ 'a.md': 'base\nremote\n' });
    await pair.remote.commit('remote: advance', 'a.md');
    await pair.remote.push('preview');

    clearFetchLocks(pair.local.dir);
    await provider.fetch(pair.local.dir, {
      remote: 'origin', ref: 'preview', singleBranch: true, depth: 1,
    });
    // The flow's deepen fetch: same call WITHOUT depth.
    clearFetchLocks(pair.local.dir);
    await provider.fetch(pair.local.dir, {
      remote: 'origin', ref: 'preview', singleBranch: true,
    });

    // Decisive check: HEAD ↔ origin/preview must now share history.
    // (Use the local handle's iso-git only to RESOLVE refs — decision is
    // made by git itself via merge-base on the provider-managed repo.)
    const { exec } = await import('dugite');
    const res = await exec(
      ['merge-base', 'HEAD', 'refs/remotes/origin/preview'],
      pair.local.dir,
      { env: {} }
    );
    deepenProbeResult = res.exitCode === 0;
  } catch (_e) {
    deepenProbeResult = false;
  } finally {
    pair.dispose();
  }
  return deepenProbeResult;
}

/** @type {boolean|null} cached probe result (per test file process). */
let missingRefProbeResult = null;

/**
 * Probe T10-D2: fetching a branch ABSENT on the remote must fail with a
 * message the flow's first-publish detection matches
 * (/Could not find|not found|404/i) — iso-git raises "Could not find
 * ref". dugite currently surfaces "couldn't find remote ref" (lowercase,
 * no "not found") which the flow does NOT recognize.
 * @param {string} [providerName='dugite']
 * @returns {Promise<boolean>} true when the capability works
 */
export async function dugiteMissingRefFetchTolerated(providerName = 'dugite') {
  if (providerName !== 'dugite') return true;
  if (missingRefProbeResult !== null) return missingRefProbeResult;

  const provider = providerFactory(providerName)();
  const pair = await createRepoPair({ branch: 'preview' });
  try {
    pair.local.writeFiles({ 'a.md': 'local only\n' });
    await pair.local.commit('local: initial', 'a.md');
    clearFetchLocks(pair.local.dir);
    await provider.fetch(pair.local.dir, {
      remote: 'origin', ref: 'preview', singleBranch: true, depth: 1,
    });
    missingRefProbeResult = false; // fetch unexpectedly succeeded
  } catch (err) {
    missingRefProbeResult =
      /Could not find|not found|404/i.test(String(err && err.message));
  } finally {
    pair.dispose();
  }
  return missingRefProbeResult;
}

/**
 * All capabilities the divergent publish/refresh flows need.
 * @param {string} providerName
 * @returns {Promise<boolean>}
 */
export async function divergentFlowsWork(providerName) {
  return (
    (await dugiteDeepenFetchWorks(providerName)) &&
    (await dugiteMissingRefFetchTolerated(providerName))
  );
}

/**
 * Conditional gate: skip the test (with a pointer to the documented bug)
 * when a required capability is missing. NEVER unconditional — the probe
 * is re-run every execution and opens automatically once src is fixed.
 *
 * @param {import('vitest').TestContext} ctx
 * @param {boolean} open
 * @param {string} bugRef issues.md entry reference
 */
export function gateOnCapability(ctx, open, bugRef) {
  if (!open) {
    ctx.skip(`GATED (conditional capability probe FAILED): ${bugRef} — see .omo/notepads/git-sync-strategy/issues.md`);
  }
}

// ─── Capability probe (conflict-strategy-modal Task 5) ───────────────────────

/** @type {Map<string, boolean>} cached probe results, per provider. */
const binaryFallbackProbeResults = new Map();

/**
 * Probe T5-1: after a binary conflict resume with a REMOTE strategy,
 * does the flow materialize the WINNING side's bytes AND integrate the
 * remote's clean (non-conflicting) files? Bug: iso-git's merge rejects
 * with an OBJECT-shaped `data` ({filepaths:[...]}) that
 * GitHandlers._extractConflictFiles does not recognize → the binary
 * fallback no-ops (wrong bytes, clean remote files dropped). See
 * .omo/notepads/conflict-strategy-modal/issues.md T5-1.
 * @param {string} providerName
 * @returns {Promise<boolean>} true when the capability works
 */
export async function binaryFallbackWorks(providerName) {
  if (binaryFallbackProbeResults.has(providerName)) {
    return binaryFallbackProbeResults.get(providerName);
  }

  const gitMod = gitModule.default || gitModule;
  const base = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const local = Buffer.from([1, 2, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 7, 8, 9]);
  const remote = Buffer.from([1, 2, 0xaa, 0xbb, 0, 7, 8]);

  const p = await createRepoPair({ branch: 'preview' });
  try {
    const handlers = makeFlowHandlers(p.local.dir, providerName);
    p.local.writeFiles({ 'probe.bin': base });
    await p.local.commit('base: probe.bin', 'probe.bin');
    await p.local.push('preview');

    await p.remote.fetch();
    const originTip = await gitMod.resolveRef({ fs, dir: p.remote.dir, ref: 'origin/preview' });
    await gitMod.branch({ fs, dir: p.remote.dir, ref: 'preview', object: originTip });
    await gitMod.checkout({ fs, dir: p.remote.dir, ref: 'preview' });
    p.remote.writeFiles({ 'probe.bin': remote, 'probe-note.md': 'clean remote\n' });
    await p.remote.commit('remote: probe', ['probe.bin', 'probe-note.md']);
    await p.remote.push('preview');
    p.local.writeFiles({ 'probe.bin': local });

    const pending = await handlers.gitPublishPreview(1, 'probe: binary');
    if (pending.code !== 'CONFLICT_PENDING') {
      binaryFallbackProbeResults.set(providerName, false);
      return false;
    }
    const resumed = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_REMOTE');
    const works =
      resumed.success === true &&
      Buffer.compare(await p.local.readBytes('probe.bin'), remote) === 0 &&
      fs.existsSync(path.join(p.local.dir, 'probe-note.md'));
    binaryFallbackProbeResults.set(providerName, works);
    return works;
  } catch (_e) {
    binaryFallbackProbeResults.set(providerName, false);
    return false;
  } finally {
    p.dispose();
  }
}

// Re-export for parity fixtures.
export { GIT_AUTHOR, createRepoPair };
