/**
 * @fileoverview Task 7 (plan fix-preview-branch-push): reproduction-gated
 * investigation of `sh: 0: getcwd() failed: No such file or directory`
 * observed in the original anonymous-push failure log.
 *
 * Hypothesis under test: the message comes from a shell (dash) spawned
 * with a deleted inherited cwd. Variants:
 *   A. bare `sh` spawn with dead process cwd      -> expect the message
 *      (mechanism confirmation at the shell level)
 *   B. dugite `exec` (git subprocess) with an explicit cwd while the
 *      process cwd is dead                          -> expect clean success
 *   C. full provider op (DugiteProvider.statusMatrix) while the process
 *      cwd is dead                                  -> expect clean success
 *      (because `_run` always passes `cwd || os.tmpdir()` to dugite)
 *
 * If B/C ever fail with getcwd noise, `_run`'s explicit-cwd contract
 * regressed — fix DugiteProvider, not this file.
 *
 * @vitest-environment node
 */
import { vi } from 'vitest';

// tests/setup.js mocks fs/path globally — these tests need the REAL fs.
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { exec as dugiteExec } from 'dugite';

import {
  makeTempDir,
  gitSetup,
  initLocalRepo,
  providerFactory,
  rmSyncWithRetry,
} from './harness.js';

const safeCwd = process.cwd();

/** Run `sh -c 'echo ok'` with inherited (dead) cwd; collect stderr. */
function spawnShNoCwd() {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', 'echo ok']);
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ stderr, error: err }));
    child.on('close', (code) => resolve({ stderr, code }));
  });
}

describe('task-7 getcwd() failed repro (dead process cwd)', () => {
  /** Remove process cwd, run `fn`, restore — even on throw. */
  async function withDeadCwd(fn) {
    const dead = makeTempDir('getcwd-dead-');
    process.chdir(dead);
    try {
      // Windows: rm of the process's OWN cwd can hit EBUSY while
      // handles drain — tolerant retry, never a crash (CI portability).
      rmSyncWithRetry(dead, 'dead cwd dir');
      return await fn();
    } finally {
      process.chdir(safeCwd);
    }
  }

  afterEach(() => {
    // Belt-and-braces: never leave the worker in a deleted dir.
    try {
      process.chdir(safeCwd);
    } catch (_e) { /* ignore */ }
  });

  // GATE (platform, win32): there is no bare `sh` on PATH on Windows
  // (spawn → ENOENT) and Windows shells do not emit a getcwd diagnostic —
  // the shell-level mechanism confirmation only exists on POSIX. The
  // dugite-level variants B/C below still run everywhere.
  (process.platform === 'win32' ? it.skip : it)(
    'variant A: bare `sh` with dead inherited cwd DOES emit getcwd() failed',
    async () => {
      const res = await withDeadCwd(spawnShNoCwd);
      // Mechanism confirmation: the shell cannot getcwd() at startup when
      // its inherited cwd is gone. dash says "getcwd() failed: ...", BSD
      // sh (macOS runners) says "shell-init: error retrieving current
      // directory: getcwd: cannot access parent directories" — match the
      // MECHANISM (getcwd failure), not one shell's wording.
      expect(res.stderr).toMatch(/getcwd|cannot access parent directories/);
    }
  );

  it('variant B: dugite exec (explicit cwd) succeeds with dead process cwd', async () => {
    const repo = makeTempDir('getcwd-repo-');
    try {
      await initLocalRepo(repo);
      const res = await withDeadCwd(() =>
        dugiteExec(['rev-parse', '--git-dir'], repo, { env: {} })
      );
      expect(res.exitCode).toBe(0);
      expect(res.stderr).not.toMatch(/getcwd|cannot access parent directories/);
    } finally {
      rmSyncWithRetry(repo, 'variant B repo');
    }
  });

  it('variant C: DugiteProvider op succeeds with dead process cwd', async () => {
    const repo = makeTempDir('getcwd-provider-');
    fs.mkdirSync(repo, { recursive: true });
    await gitSetup(['init', '-b', 'main', '.'], repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    await gitSetup(['add', '.'], repo);
    await gitSetup(['commit', '-m', 'c1'], repo);

    const provider = providerFactory('dugite')();
    try {
      const matrix = await withDeadCwd(() => provider.statusMatrix(repo));
      expect(matrix).toEqual([['a.txt', 1, 1, 1]]);
    } finally {
      rmSyncWithRetry(repo, 'variant C repo');
    }
  });
});

// Keep os referenced for readers: dugite default cwd is os.tmpdir()
// when `_run` gets no cwd (clone/ls-remote) — always absolute+valid.
void os;
