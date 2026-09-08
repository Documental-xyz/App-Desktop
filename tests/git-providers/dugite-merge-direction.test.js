/**
 * @fileoverview DugiteProvider merge direction tests (git-sync-strategy
 * Task 3; REWRITTEN in publish-update-resilience T16 — the shared
 * gitMergeDriver.js module was deleted in T15).
 *
 * The production path since T15 is `strategy: 'ours'|'theirs'` on
 * provider.merge → native `git merge -X ours|theirs` (what git.js flows
 * pass). The provider ALSO keeps the legacy mergeDriver-callback
 * translation (marker `.direction` / known export NAMES → -X favor;
 * unknown callbacks fail EXPLICITLY — no silent degradation) — that
 * surface is tested here with LOCALLY-DEFINED marker drivers, so no
 * dependency on the deleted module remains.
 *
 * Scenario mirrors tests/git/fixtures/harness.js makeConflict (Task 2
 * parity): base 100-line file, local edits line 5, remote edits line 5
 * differently AND appends a non-conflicting remote-only line 101.
 * Assert on the committed TREE (blob at merge HEAD).
 *
 * This suite also inherits the semantic load of the deleted
 * tests/git/merge-driver-{ours,full}.test.js (iso diff3 drivers):
 * direction + per-hunk arbitration + non-conflicting preservation are
 * pinned HERE at provider level, and at flow level by
 * tests/git/merge-semantics-regression.test.js,
 * tests/git/conflict-resolve.test.js and tests/git/parity-suite.test.js.
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
import { gitSetup, GIT_AUTHOR } from './harness.js';

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

// Locally-defined drivers exercising the provider's legacy
// mergeDriver-callback translation contract (the shared driver module
// was deleted in T15; detection is marker/name based, so local
// definitions cover it identically).

/** Driver with an explicit ours-intent marker (coordination contract). */
const oursMarkerDriver = () => ({ cleanMerge: true });
oursMarkerDriver.direction = 'ours';

const theirsMarkerDriver = () => ({ cleanMerge: true });
theirsMarkerDriver.direction = 'theirs';

const fullLocalMarkerDriver = () => ({ cleanMerge: true });
fullLocalMarkerDriver.direction = 'full-local';

const fullRemoteMarkerDriver = () => ({ cleanMerge: true });
fullRemoteMarkerDriver.direction = 'full-remote';

/** Driver detected by name (mirrors the historical oursMergeDriver export). */
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

  // The PRODUCTION path (git.js flows since T15): strategy directly.
  it("strategy 'ours' keeps the LOCAL hunk and the non-conflicting remote change", async () => {
    const { dir, provider } = await conflictRepo(base);
    const localHeadBefore = await provider.resolveRef(dir, 'HEAD');

    await provider.merge(dir, 'remote-side', {
      fastForward: false,
      strategy: 'ours',
    });

    const merged = await headBlob(provider, dir);
    // Conflicting hunk: LOCAL wins (this is the anti-inversion assert).
    expect(merged).toContain('line5-LOCAL\n');
    expect(merged).not.toContain('line5-REMOTE');
    // Non-conflicting remote change is preserved.
    expect(merged).toContain('line101-remote\n');
    // A real merge commit was created (2 parents ⇒ main moved).
    expect(await provider.resolveRef(dir, 'HEAD')).not.toBe(localHeadBefore);
  });

  it("strategy 'theirs' keeps the REMOTE hunk", async () => {
    const { dir, provider } = await conflictRepo(base);

    await provider.merge(dir, 'remote-side', {
      fastForward: false,
      strategy: 'theirs',
    });

    const merged = await headBlob(provider, dir);
    expect(merged).toContain('line5-REMOTE\n');
    expect(merged).not.toContain('line5-LOCAL');
  });

  it('mergeDriver with ours intent keeps the LOCAL hunk and the non-conflicting remote change', async () => {
    const { dir, provider } = await conflictRepo(base);
    const localHeadBefore = await provider.resolveRef(dir, 'HEAD');

    await provider.merge(dir, 'remote-side', {
      fastForward: false,
      mergeDriver: oursMarkerDriver,
    });

    const merged = await headBlob(provider, dir);
    expect(merged).toContain('line5-LOCAL\n');
    expect(merged).not.toContain('line5-REMOTE');
    expect(merged).toContain('line101-remote\n');
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

  it('mergeDriver with theirs intent keeps the REMOTE hunk', async () => {
    const { dir, provider } = await conflictRepo(base);

    await provider.merge(dir, 'remote-side', {
      fastForward: false,
      mergeDriver: theirsMarkerDriver,
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

describe('DugiteProvider mergeDriverFavor full-local/full-remote (conflict-strategy-modal Task 2)', () => {
  let base;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'dugite-full-driver-'));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  // Unit level: marker + name detection translate full-* intents to -X
  // ours/theirs (NEVER -s ours — it discards the entire remote side).
  it('maps full-local/full-remote markers to ours/theirs favors', () => {
    expect(DugiteProvider.mergeDriverFavor(fullLocalMarkerDriver)).toBe('ours');
    expect(DugiteProvider.mergeDriverFavor(fullRemoteMarkerDriver)).toBe('theirs');
  });

  it('full-local merge keeps the LOCAL conflicting hunk and the non-conflicting remote change', async () => {
    const { dir, provider } = await conflictRepo(base);

    await provider.merge(dir, 'remote-side', {
      fastForward: false,
      mergeDriver: fullLocalMarkerDriver,
    });

    const merged = await headBlob(provider, dir);
    // Conflicting hunk: LOCAL integral wins.
    expect(merged).toContain('line5-LOCAL\n');
    expect(merged).not.toContain('line5-REMOTE');
    // Non-conflicting remote change (appended line): preserved — full
    // does NOT behave like `-s ours` (whole-remote discard).
    expect(merged).toContain('line101-remote\n');
  });

  it('full-remote merge keeps the REMOTE conflicting hunk and the non-conflicting local change', async () => {
    // Local version gains its own non-conflicting append (line102-local)
    // on top of the conflicting line5 edit; it must survive full-remote.
    const dir = path.join(base, 'work-fr');
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
    fs.writeFileSync(path.join(dir, 'doc.txt'), baseFile().replace('line5\n', 'line5-REMOTE\n'));
    await provider.add(dir, 'doc.txt');
    await provider.commit(dir, 'remote: edit line5');

    await provider.checkout(dir, 'main');
    fs.writeFileSync(
      path.join(dir, 'doc.txt'),
      `${localVersion()}line102-local\n`
    );
    await provider.add(dir, 'doc.txt');
    await provider.commit(dir, 'local: edit line5 + append line102');

    await provider.merge(dir, 'remote-side', {
      fastForward: false,
      mergeDriver: fullRemoteMarkerDriver,
    });

    const merged = await headBlob(provider, dir);
    // Conflicting hunk: REMOTE integral wins.
    expect(merged).toContain('line5-REMOTE\n');
    expect(merged).not.toContain('line5-LOCAL');
    // Non-conflicting local change: preserved.
    expect(merged).toContain('line102-local\n');
  });
});
