/**
 * @fileoverview DugiteProvider merge direction tests (git-sync-strategy
 * plan, Task 3 — TDD).
 *
 * Bug being fixed: any `mergeDriver` callback used to degrade to
 * `-X theirs`, inverting the semantics whenever the flow asked for
 * "ours". The provider must map the driver's INTENTION to the native
 * `git merge -X ours | -X theirs` flag and fail EXPLICITLY on custom
 * drivers it cannot translate (no silent degradation).
 *
 * Driver-intent detection contract (documented in DugiteProvider.merge):
 *   1. `driver.direction === 'ours' | 'theirs'` marker property, OR
 *   2. named exports `oursMergeDriver` / `theirsMergeDriver` detected
 *      by the function's `name`.
 * Anything else → explicit error, merge does NOT execute.
 *
 * Scenario mirrors tests/git/fixtures/harness.js makeConflict (Task 2
 * parity): base 100-line file, local edits line 5, remote edits line 5
 * differently AND appends a non-conflicting remote-only line 101.
 * Assert on the committed TREE (blob at merge HEAD) — the documented
 * iso-git/dugite worktree divergence does not apply here (T16 note in
 * provider-suite.test.js).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import os from 'os';

import { DugiteProvider } from '../../src/git/providers/DugiteProvider.js';
import { theirsMergeDriver } from '../../src/ipc/gitMergeDriver.js';
import { gitSetup, isGitError, GIT_AUTHOR } from './harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** Base fixture: 100 lines, the conflict target is line 5. */
function baseFile() {
  const lines = [];
  for (let i = 1; i <= 100; i++) lines.push(`line${i}`);
  return `${lines.join('\n')}\n`;
}

function localVersion() {
  return baseFile().replace('line5\n', 'line5-LOCAL\n');
}

/** Remote: conflicting edit on line 5 + non-conflicting appended line. */
function remoteVersion() {
  return `${baseFile().replace('line5\n', 'line5-REMOTE\n')}line101-remote\n`;
}

/** Driver with an explicit ours-intent marker (coordination contract). */
const oursMarkerDriver = () => ({ cleanMerge: true });
oursMarkerDriver.direction = 'ours';

/** Driver detected by name (mirrors the future oursMergeDriver export). */
function oursMergeDriver() {
  return { cleanMerge: true };
}

/** Custom driver with no recognizable intent. */
function myCustomDriver() {
  return { cleanMerge: true };
}

/**
 * Build the two-branch conflict fixture (single local repo, dugite
 * provider drives every mutation). Returns the repo dir.
 */
async function conflictRepo(base) {
  const dir = path.join(base, 'work');
  fs.mkdirSync(dir, { recursive: true });
  await gitSetup(['init', '-b', 'main', '.'], dir);
  const provider = new DugiteProvider();
  await provider.setConfig(dir, 'user.name', GIT_AUTHOR.name);
  await provider.setConfig(dir, 'user.email', GIT_AUTHOR.email);

  fs.writeFileSync(path.join(dir, 'doc.txt'), baseFile());
  await provider.add(dir, 'doc.txt');
  await provider.commit(dir, 'base: common ancestor');

  await provider.branch(dir, 'remote-side');
  await provider.checkout(dir, 'remote-side');
  fs.writeFileSync(path.join(dir, 'doc.txt'), remoteVersion());
  await provider.add(dir, 'doc.txt');
  await provider.commit(dir, 'remote: edit line5 + append line101');

  await provider.checkout(dir, 'main');
  fs.writeFileSync(path.join(dir, 'doc.txt'), localVersion());
  await provider.add(dir, 'doc.txt');
  await provider.commit(dir, 'local: edit line5');

  return { dir, provider };
}

/** Read `doc.txt` blob from HEAD's committed tree. */
async function headBlob(provider, dir) {
  const head = await provider.resolveRef(dir, 'HEAD');
  const { blob } = await provider.readBlob(dir, head, { filepath: 'doc.txt' });
  return Buffer.from(blob).toString('utf8');
}

describe('DugiteProvider merge ours/theirs direction (Task 3)', () => {
  let base;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'dugite-merge-direction-'));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('mergeDriver with ours intent keeps the LOCAL hunk and the non-conflicting remote change', async () => {
    const { dir, provider } = await conflictRepo(base);
    const localHeadBefore = await provider.resolveRef(dir, 'HEAD');

    await provider.merge(dir, 'remote-side', {
      fastForward: false,
      mergeDriver: oursMarkerDriver,
    });

    const merged = await headBlob(provider, dir);
    // Conflicting hunk: LOCAL wins (this is the anti-inversion assert).
    expect(merged).toContain('line5-LOCAL\n');
    expect(merged).not.toContain('line5-REMOTE');
    // Non-conflicting remote change is preserved (same semantics as the
    // iso-git oursMergeDriver, Task 2 parity).
    expect(merged).toContain('line101-remote\n');
    // A real merge commit was created (2 parents ⇒ main moved).
    expect(await provider.resolveRef(dir, 'HEAD')).not.toBe(localHeadBefore);
  });

  it('mergeDriver named oursMergeDriver (reference-export pattern) maps to -X ours', async () => {
    const { dir, provider } = await conflictRepo(base);

    await provider.merge(dir, 'remote-side', {
      fastForward: false,
      mergeDriver: oursMergeDriver,
    });

    const merged = await headBlob(provider, dir);
    expect(merged).toContain('line5-LOCAL\n');
    expect(merged).not.toContain('line5-REMOTE');
    expect(merged).toContain('line101-remote\n');
  });

  it('mergeDriver with theirs intent keeps the REMOTE hunk (regression: theirsMergeDriver)', async () => {
    const { dir, provider } = await conflictRepo(base);

    await provider.merge(dir, 'remote-side', {
      fastForward: false,
      mergeDriver: theirsMergeDriver,
    });

    const merged = await headBlob(provider, dir);
    expect(merged).toContain('line5-REMOTE\n');
    expect(merged).not.toContain('line5-LOCAL');
  });

  it('unknown custom mergeDriver → explicit error and merge does NOT execute', async () => {
    const { dir, provider } = await conflictRepo(base);
    const headBefore = await provider.resolveRef(dir, 'HEAD');

    await expect(
      provider.merge(dir, 'remote-side', {
        fastForward: false,
        mergeDriver: myCustomDriver,
      })
    ).rejects.toThrow(/unsupported mergeDriver callback "myCustomDriver"/);

    // Nothing ran: HEAD untouched, tree still the local version.
    expect(await provider.resolveRef(dir, 'HEAD')).toBe(headBefore);
    expect(await headBlob(provider, dir)).toBe(localVersion());
    // And no merge is left in progress.
    const status = fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))
      ? 'merging'
      : 'clean';
    expect(status).toBe('clean');
  });
});
