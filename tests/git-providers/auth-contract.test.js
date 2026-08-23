/**
 * @fileoverview Regression tests for dugite auth injection (plan task 6,
 * fix-preview-branch-push).
 *
 * Locks in the `auth: { token }` provider contract after the migration of
 * all src/ipc/ call sites away from `onAuth: () => ({username, password})`:
 *
 *   1. Push with `auth: {token}` works under BOTH providers against a
 *      loopback bare remote and creates refs/heads/preview (the regression
 *      that used to fail with "No anonymous write access" under dugite
 *      when the token was passed in the iso-git onAuth shape).
 *   2. Non-GitHub remote + token → NO askpass helper is created, no crash
 *      (GitHub-only credential guard, parity with security.test.js).
 *   3. DUGITE boundary: against a remote URL configured as github.com,
 *      a push with `auth: {token}` injects GIT_ASKPASS + the token via
 *      env (SMC_GIT_ASKPASS_TOKEN) only — never argv — and cleans up the
 *      helper afterwards. (Full github.com transport is not reachable
 *      offline, so the assertion runs at the dugite exec boundary.)
 *   4. 401 auth errors are non-retriable — covered in
 *      tests/ipc/gitOperations.test.js (`_isRetriablePushError`).
 *
 * No real tokens — FAKE_TOKEN is a deliberately fake string.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { exec as dugiteExec } from 'dugite';

import { DugiteProvider } from '../../src/git/providers/DugiteProvider.js';
import { resetGitProviderCache } from '../../src/git/GitProviderFactory.js';
import {
  makeTempDir,
  createHttpRemote,
  remoteBranches,
  providersUnderTest,
  providerFactory,
} from './harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** Fake token — deliberately NOT a real credential (18 alnum chars). */
const FAKE_TOKEN = 'faketoken123abc456';

/**
 * Askpass helpers created by THIS test process in os.tmpdir().
 * @returns {string[]}
 */
function listMyAskpassHelpers() {
  const prefix = `git-askpass-${process.pid}-`;
  return fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(os.tmpdir(), name));
}

// ─── 1 + 2: dual-provider parity over the loopback http remote ───────────────

/**
 * @param {string} name
 * @param {() => Object} factory
 */
function describeAuthContractProvider(name, factory) {
  describe(`auth contract {token} — provider: ${name}`, () => {
    /** @type {Object} */
    let provider;
    /** @type {string} */
    let base;
    const originalEnv = process.env.GIT_PROVIDER;

    beforeEach(() => {
      base = makeTempDir('auth-contract-');
      provider = factory();
    });

    afterEach(() => {
      resetGitProviderCache();
      if (originalEnv === undefined) {
        delete process.env.GIT_PROVIDER;
      } else {
        process.env.GIT_PROVIDER = originalEnv;
      }
      fs.rmSync(base, { recursive: true, force: true });
    });

    it('push with auth:{token} publishes refs/heads/preview to the remote (regression: no anonymous-write failure)', async () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      const remote = await createHttpRemote(base);
      try {
        const dir = path.join(base, 'work');
        await provider.clone(remote.url, dir);
        fs.writeFileSync(path.join(dir, 'auth.txt'), 'auth contract\n');
        await provider.add(dir, 'auth.txt');
        await provider.commit(dir, 'auth contract commit');

        // The migrated contract: token in `auth`, NEVER onAuth/username.
        await provider.push(dir, {
          branch: 'main',
          remoteRef: 'preview',
          auth: { token: FAKE_TOKEN },
        });

        // Push succeeded (no throw → no "No anonymous write access"
        // 401) and the preview ref exists on the bare remote.
        expect(await remoteBranches(remote.bare)).toContain('preview');
      } finally {
        writeSpy.mockRestore();
        await new Promise((r) => remote.server.close(r));
      }
    });

    it('non-GitHub remote + token: no askpass helper created, no crash', async () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      const remote = await createHttpRemote(base);
      try {
        const dir = path.join(base, 'work');
        await provider.clone(remote.url, dir);
        fs.writeFileSync(path.join(dir, 'ng.txt'), 'non-github\n');
        await provider.add(dir, 'ng.txt');
        await provider.commit(dir, 'non-github commit');

        const before = listMyAskpassHelpers();
        // Loopback URL is NOT github.com → the GitHub-only guard must
        // withhold the credential; push still succeeds anonymously.
        await provider.push(dir, {
          branch: 'main',
          remoteRef: 'preview',
          auth: { token: FAKE_TOKEN },
        });
        expect(await remoteBranches(remote.bare)).toContain('preview');
        expect(listMyAskpassHelpers()).toEqual(before);

        const askpassWrites = writeSpy.mock.calls.filter(([file]) =>
          path.basename(String(file)).startsWith(`git-askpass-${process.pid}-`)
        );
        expect(askpassWrites).toEqual([]);
      } finally {
        writeSpy.mockRestore();
        await new Promise((r) => remote.server.close(r));
      }
    });
  });
}

for (const name of providersUnderTest()) {
  describeAuthContractProvider(name, providerFactory(name));
}

// ─── 3: DUGITE boundary — GIT_ASKPASS injection for github.com remotes ───────
//
// github.com is not reachable offline, so the fake github.com remote URL
// is rewritten to a LOCAL bare repo via `url.<path>.insteadOf` (repo-local
// config). The provider reads `remote.origin.url` → sees github.com → the
// GitHub-only guard fires; the actual transport is the local bare repo.

describe('dugite boundary: auth:{token} push against a github.com remote', () => {
  /** @type {string} */
  let base;
  const originalEnv = process.env.GIT_PROVIDER;
  const originalTokenEnv = process.env.SMC_GIT_ASKPASS_TOKEN;

  beforeEach(() => {
    base = makeTempDir('auth-boundary-');
  });

  afterEach(() => {
    resetGitProviderCache();
    if (originalEnv === undefined) {
      delete process.env.GIT_PROVIDER;
    } else {
      process.env.GIT_PROVIDER = originalEnv;
    }
    if (originalTokenEnv === undefined) {
      delete process.env.SMC_GIT_ASKPASS_TOKEN;
    } else {
      process.env.SMC_GIT_ASKPASS_TOKEN = originalTokenEnv;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('creates the GIT_ASKPASS helper (token env-only, never argv/file), pushes, and cleans up', async () => {
    const provider = new DugiteProvider();

    // Fake github.com origin, rewritten to <base>/gh/fake-org/fake-repo.git
    const bare = path.join(base, 'gh', 'fake-org', 'fake-repo.git');
    fs.mkdirSync(bare, { recursive: true });
    expect((await dugiteExec(['init', '--bare', '-b', 'main', '.'], bare, { env: {} })).exitCode).toBe(0);

    const dir = path.join(base, 'work');
    fs.mkdirSync(dir, { recursive: true });
    await dugiteExec(['init', '-b', 'main', '.'], dir, { env: {} });
    await dugiteExec(['remote', 'add', 'origin', 'https://github.com/fake-org/fake-repo.git'], dir, { env: {} });
    await dugiteExec(['config', `url.${path.join(base, 'gh')}/.insteadOf`, 'https://github.com/'], dir, { env: {} });
    fs.writeFileSync(path.join(dir, 'boundary.txt'), 'github rewrite\n');
    expect((await dugiteExec(['add', '.'], dir, { env: {} })).exitCode).toBe(0);
    expect(
      (await dugiteExec(
        ['-c', 'user.email=dual@example.local', '-c', 'user.name=dual-suite', 'commit', '-m', 'boundary'],
        dir,
        { env: {} }
      )).exitCode
    ).toBe(0);

    let helperPath = null;
    let helperContent = null;
    const helperCopy = path.join(base, 'helper-copy.sh');
    const realWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, ...rest) => {
      if (path.basename(String(file)).startsWith(`git-askpass-${process.pid}-`)) {
        helperPath = String(file);
        helperContent = String(data);
        realWrite(helperCopy, data, { mode: 0o600 });
      }
      return realWrite(file, data, ...rest);
    });

    try {
      await provider.push(dir, {
        ref: 'main',
        remoteRef: 'preview',
        auth: { token: FAKE_TOKEN },
      });
    } finally {
      writeSpy.mockRestore();
    }

    // GitHub-only guard fired + env-only token contract + cleanup in finally.
    expect(helperPath).toMatch(/git-askpass-\d+-[0-9a-f]+\.sh$/);
    expect(helperContent).not.toContain(FAKE_TOKEN);
    expect(fs.existsSync(helperPath)).toBe(false);

    // Helper answers prompts from SMC_GIT_ASKPASS_TOKEN env — proves the
    // env plumbing end-to-end (token reaches the git process env-only).
    process.env.SMC_GIT_ASKPASS_TOKEN = FAKE_TOKEN;
    const answer = spawnSync('sh', [helperCopy, 'Username for "https://github.com":'], {
      env: process.env,
      encoding: 'utf8',
    });
    expect(answer.status).toBe(0);
    expect(answer.stdout).toBe(FAKE_TOKEN);
    const pw = spawnSync('sh', [helperCopy, 'Password for "https://x@github.com":'], {
      env: process.env,
      encoding: 'utf8',
    });
    expect(pw.stdout).toBe('x-oauth-basic');

    // refs/heads/preview exists on the (local) bare remote.
    const branches = (await dugiteExec(
      ['for-each-ref', 'refs/heads', '--format=%(refname:short)'],
      bare,
      { env: {} }
    )).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    expect(branches).toContain('preview');
  });
});
