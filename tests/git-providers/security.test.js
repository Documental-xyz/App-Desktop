/**
 * @fileoverview Security tests for the git provider layer (plan checkbox 19).
 *
 * Covers:
 *  - Token-leak: a FAILING network operation WITH auth must never leak the
 *    token into GitError.message, GitError.stderr, or console output.
 *  - Askpass helper lifecycle: no `git-askpass-*` remnants in os.tmpdir()
 *    after an auth'd operation; helper file is created with mode 0600.
 *  - Non-GitHub guard: file:// (or local path) remotes never get an askpass
 *    helper and never receive credentials.
 *  - GIT_PROVIDER=banana → fatal factory error (no silent fallback).
 *  - Missing bundled runtime → fatal 'Bundled Git runtime not found'.
 *  - Canary: proves the console-spy leak-detection mechanism itself works.
 *
 * Token used is ALWAYS the fake `faketoken123abc456` — never a real
 * credential.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// tests/setup.js globally mocks fs/path — these tests need the REAL
// filesystem (dugite exec, temp repos, askpass lifecycle) and dugite's
// internal requires must also see the real modules.
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec as dugiteExec } from 'dugite';

import { DugiteProvider } from '../../src/git/providers/DugiteProvider.js';
import {
  createGitProvider,
  resetGitProviderCache,
} from '../../src/git/GitProviderFactory.js';
import * as GitRuntime from '../../src/git/GitRuntime.js';

/** Fake token — 18 alnum chars, deliberately NOT a real credential. */
const FAKE_TOKEN = 'faketoken123abc456';

/** AuthInfo shape used across the app (username x-oauth-basic + token). */
const AUTH = { username: 'x-oauth-basic', token: FAKE_TOKEN };

/** Nonexistent GitHub repo — the operation FAILS (404/auth/network). */
const GHOST_GITHUB_URL =
  'https://github.com/smc-leak-test-nonexistent-9x7q/ghost-repo.git';

/**
 * List askpass helpers created by THIS test process in os.tmpdir().
 * (Helper name: git-askpass-<pid>-<hex>.sh — filtering on pid avoids
 * false positives from unrelated processes.)
 *
 * @returns {string[]} absolute paths of this process's askpass helpers
 */
function listMyAskpassHelpers() {
  const prefix = `git-askpass-${process.pid}-`;
  return fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(os.tmpdir(), name));
}

/** @returns {string} a fresh temp working directory */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smc-sec-test-'));
}

/**
 * Run bundled git in a directory (setup helper, T15 evidence pattern).
 *
 * @param {string[]} args git argv
 * @param {string} [cwd] working directory
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
function git(args, cwd) {
  return dugiteExec(args, cwd || os.tmpdir(), { env: {} });
}

describe('git provider security', () => {
  let provider;
  const originalProvider = process.env.GIT_PROVIDER;

  beforeEach(() => {
    provider = new DugiteProvider();
  });

  afterEach(() => {
    // Never leak factory/env state between tests.
    resetGitProviderCache();
    if (originalProvider === undefined) {
      delete process.env.GIT_PROVIDER;
    } else {
      process.env.GIT_PROVIDER = originalProvider;
    }
    // Paranoia: no askpass helper may survive ANY test in this file.
    for (const helper of listMyAskpassHelpers()) {
      try {
        fs.unlinkSync(helper);
      } catch (_e) {
        /* best effort */
      }
    }
    vi.restoreAllMocks();
  });

  // ─── Token leak ────────────────────────────────────────────────────────────

  describe('token-leak (failing auth network op)', () => {
    it(
      'never leaks the token into GitError.message / GitError.stderr / console',
      async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

        let err = null;
        try {
          // ls-remote against a nonexistent GitHub repo WITH auth:
          // fails fast (GIT_TERMINAL_PROMPT=0) with 404/auth/network error.
          await provider.getRemoteInfo(GHOST_GITHUB_URL, { auth: AUTH });
        } catch (e) {
          err = e;
        }

        // The operation must fail (that is the premise of the test).
        // Constructor-name check (not instanceof): vitest transforms the
        // provider's CJS require, yielding a second GitError class instance.
        expect(err).toBeInstanceOf(Error);
        expect(err.constructor.name).toBe('GitError');

        // (a) message
        expect(err.message).not.toContain(FAKE_TOKEN);
        // (b) stderr
        expect(String(err.stderr || '')).not.toContain(FAKE_TOKEN);
        // (c) captured console output during the op
        const consoleOutput = [
          ...consoleError.mock.calls,
          ...consoleLog.mock.calls,
        ]
          .flat()
          .map((part) => String(part))
          .join('\n');
        expect(consoleOutput).not.toContain(FAKE_TOKEN);
      },
      60000
    );
  });

  // ─── Askpass helper lifecycle ──────────────────────────────────────────────

  describe('askpass helper lifecycle', () => {
    it(
      'leaves no git-askpass-* file in os.tmpdir() after a FAILED auth op',
      async () => {
        const before = listMyAskpassHelpers();
        await provider
          .getRemoteInfo(GHOST_GITHUB_URL, { auth: AUTH })
          .catch(() => {});
        const after = listMyAskpassHelpers();
        expect(after).toEqual(before);
        expect(
          after.filter((f) => path.basename(f).startsWith('git-askpass-'))
        ).toEqual(before);
      },
      60000
    );

    it(
      'creates the askpass helper with mode 0600 (captured via fs.writeFileSync spy)',
      async () => {
        const writeSpy = vi.spyOn(fs, 'writeFileSync');

        await provider
          .getRemoteInfo(GHOST_GITHUB_URL, { auth: AUTH })
          .catch(() => {});

        const askpassWrites = writeSpy.mock.calls.filter(([file]) =>
          path.basename(String(file)).startsWith(`git-askpass-${process.pid}-`)
        );
        // The op is a github.com https op with auth → helper must exist.
        expect(askpassWrites.length).toBeGreaterThanOrEqual(1);
        for (const [, , opts] of askpassWrites) {
          // 0600 = owner rw only; helper is data (run via `sh <file>`).
          expect(opts && opts.mode).toBe(0o600);
        }
      },
      60000
    );
  });

  // ─── Non-GitHub guard ──────────────────────────────────────────────────────

  describe('non-github guard (file:// remote + AuthInfo)', () => {
    it('creates NO askpass helper and offers no credentials', async () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      const root = makeTempDir();
      try {
        const bare = path.join(root, 'remote.git');
        const clone = path.join(root, 'clone');
        fs.mkdirSync(bare);
        fs.mkdirSync(clone);

        expect((await git(['init', '--bare'], bare)).exitCode).toBe(0);
        expect((await git(['init'], clone)).exitCode).toBe(0);
        expect(
          (
            await git(
              ['remote', 'add', 'origin', `file://${bare}`],
              clone
            )
          ).exitCode
        ).toBe(0);

        // Populate the bare remote so the later fetch has a ref to fetch.
        fs.writeFileSync(path.join(clone, 'README.md'), '# security test\n');
        expect((await git(['add', '.'], clone)).exitCode).toBe(0);
        expect(
          (await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], clone)).exitCode
        ).toBe(0);
        expect((await git(['push', '-u', 'origin', 'HEAD'], clone)).exitCode).toBe(0);

        const before = listMyAskpassHelpers();

        // fetch WITH auth — must succeed via local transport and must NOT
        // receive the credential.
        await provider.fetch(clone, { auth: AUTH, depth: 1 });

        const after = listMyAskpassHelpers();
        expect(after).toEqual(before);

        const askpassWrites = writeSpy.mock.calls.filter(([file]) =>
          path
            .basename(String(file))
            .startsWith(`git-askpass-${process.pid}-`)
        );
        expect(askpassWrites).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // ─── Factory: invalid GIT_PROVIDER is fatal ────────────────────────────────

  describe('GIT_PROVIDER validation', () => {
    it('throws exactly "Unsupported GIT_PROVIDER: banana" (no silent fallback)', () => {
      process.env.GIT_PROVIDER = 'banana';
      resetGitProviderCache();
      expect(() => createGitProvider()).toThrow(
        'Unsupported GIT_PROVIDER: banana'
      );
    });
  });

  // ─── Bundled runtime absence is fatal ──────────────────────────────────────

  describe('missing bundled git runtime', () => {
    it('getGitDir throws exactly "Bundled Git runtime not found"', () => {
      expect(() => GitRuntime.getGitDir(['/nonexistent'])).toThrow(
        'Bundled Git runtime not found'
      );
    });

    it('isBundledGitAvailable returns false for missing runtime', () => {
      expect(GitRuntime.isBundledGitAvailable(['/nonexistent'])).toBe(false);
    });
  });

  // ─── Canary: leak-detection mechanism self-check ───────────────────────────

  describe('canary: token-leak detection mechanism is valid', () => {
    it('DELIBERATELY logs the fake token and verifies the spy catches it', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Simulated leak — proves the same assertions used in the token-leak
      // test above would FAIL if a real leak existed.
      console.error(`push failed: auth token=${FAKE_TOKEN} rejected`);
      console.log(`retry with ${FAKE_TOKEN}`);

      const captured = [
        ...consoleError.mock.calls,
        ...consoleLog.mock.calls,
      ]
        .flat()
        .map((part) => String(part))
        .join('\n');
      expect(captured).toContain(FAKE_TOKEN);
    });
  });
});
