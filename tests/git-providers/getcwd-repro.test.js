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
      fs.rmSync(dead, { recursive: true, force: true });
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

  test('variant A: bare `sh` with dead inherited cwd DOES emit getcwd() failed', async () => {
    const res = await withDeadCwd(spawnShNoCwd);
    // Mechanism confirmation: dash cannot getcwd() at startup when its
    // inherited cwd is gone. This is the exact string from the bug log.
    expect(res.stderr).toMatch(/getcwd\(\) failed/);
  });

  test('variant B: dugite exec (explicit cwd) succeeds with dead process cwd', async () => {
    const repo = makeTempDir('getcwd-repo-');
    try {
      await initLocalRepo(repo);
      const res = await withDeadCwd(() =>
        dugiteExec(['rev-parse', '--git-dir'], repo, { env: {} })
      );
      expect(res.exitCode).toBe(0);
      expect(res.stderr).not.toMatch(/getcwd\(\) failed/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('variant C: DugiteProvider op succeeds with dead process cwd', async () => {
    const repo = makeTempDir('getcwd-provider-');
    fs.mkdirSync(repo, { recursive: true });
    await gitSetup(['init', '-b', 'main', '.'], repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    await gitSetup(['add', '.'], repo);
    await gitSetup(
      ['-c', 'user.email=t7@example.local', '-c', 'user.name=t7', 'commit', '-m', 'c1'],
      repo
    );

    const provider = providerFactory('dugite')();
    try {
      const matrix = await withDeadCwd(() => provider.statusMatrix(repo));
      expect(matrix).toEqual([['a.txt', 1, 1, 1]]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// Keep os referenced for readers: dugite default cwd is os.tmpdir()
// when `_run` gets no cwd (clone/ls-remote) — always absolute+valid.
void os;
