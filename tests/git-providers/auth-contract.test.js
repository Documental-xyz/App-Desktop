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
import { spawnSync, execFileSync } from 'child_process';
import { exec as dugiteExec } from 'dugite';

import { DugiteProvider } from '../../src/git/providers/DugiteProvider.js';
import { resetGitProviderCache } from '../../src/git/GitProviderFactory.js';
import {
  makeTempDir,
  createHttpRemote,
  remoteBranches,
  providersUnderTest,
  providerFactory,
  httpBackendAvailable,
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
  // GATE (capability, never unconditional): both specs clone/push over
  // the loopback git-http-backend server; skipped only where the
  // bundled git lacks the CGI (harness.httpBackendAvailable probe) and
  // re-opened automatically when the runner ships it.
  describe.skipIf(!httpBackendAvailable)(`auth contract {token} — provider: ${name}`, () => {
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
    let helperMode = null;
    const helperCopy = path.join(base, 'helper-copy.sh');
    const realWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, ...rest) => {
      if (path.basename(String(file)).startsWith(`git-askpass-${process.pid}-`)) {
        helperPath = String(file);
        helperContent = String(data);
        helperMode = rest[0] && rest[0].mode;
        // 0755 — git execs GIT_ASKPASS directly; the copy must keep
        // the exec bit to be spawned the same way.
        realWrite(helperCopy, data, { mode: 0o755 });
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
    expect(helperContent.startsWith('#!/bin/sh')).toBe(true);
    expect(helperContent).not.toContain(FAKE_TOKEN);
    expect(helperMode).toBe(0o755);
    expect(fs.existsSync(helperPath)).toBe(false);

    // Helper answers prompts from SMC_GIT_ASKPASS_TOKEN env, spawned
    // DIRECTLY (execFile, no `sh` prefix) — replicates how git execs
    // the GIT_ASKPASS value (execvp) — proves the env plumbing
    // end-to-end (token reaches the git process env-only).
    //
    // GATE (platform, win32): Windows CreateProcess cannot exec a
    // `#!/bin/sh` script directly (EFTYPE). The production path stays
    // covered even on Windows: the bundled git of dugite runs
    // GIT_ASKPASS through its OWN sh (git.exe → sh.exe helper), which
    // is exactly what the `git credential fill` check below exercises
    // when a POSIX sh is on PATH. The direct execFileSync assertions
    // here are the shell-level replication of that mechanism and only
    // make sense where the OS execs shebang scripts.
    if (process.platform !== 'win32') {
      const promptEnv = { ...process.env, SMC_GIT_ASKPASS_TOKEN: FAKE_TOKEN };
      const answer = execFileSync(helperCopy, ['Username for "https://github.com":'], {
        env: promptEnv,
        encoding: 'utf8',
      });
      expect(answer).toBe(FAKE_TOKEN);
      const pw = execFileSync(helperCopy, ['Password for "https://x@github.com":'], {
        env: promptEnv,
        encoding: 'utf8',
      });
      expect(pw).toBe('x-oauth-basic');
    }

    // Real-git check (offline): `git credential fill` consults
    // GIT_ASKPASS, so running it with GIT_ASKPASS = the PLAIN helper
    // path proves real git execs the value DIRECTLY (execvp, no
    // shell). The old `sh "<path>"` wrapper failed exactly here
    // (`cannot exec 'sh "<path>"': No such file or directory` →
    // terminal prompt → disabled → auth failure). Task 8 regression.
    // GATE (platform, win32): requires a POSIX `git`+sh on PATH; on
    // Windows the dugite-bundled git (inside the provider above) still
    // exercises the GIT_ASKPASS exec path via its own sh.
    if (process.platform !== 'win32') {
      const fill = spawnSync(
        'git',
        ['-c', 'credential.helper=', 'credential', 'fill'],
        {
          input: 'protocol=https\nhost=github.com\n\n',
          env: {
            ...process.env,
            SMC_GIT_ASKPASS_TOKEN: FAKE_TOKEN,
            GIT_ASKPASS: helperCopy,
            GIT_TERMINAL_PROMPT: '0',
          },
          encoding: 'utf8',
        }
      );
      expect(fill.status).toBe(0);
      expect(fill.stdout).toContain(`username=${FAKE_TOKEN}`);
      expect(fill.stdout).toContain('password=x-oauth-basic');
    }

    // refs/heads/preview exists on the (local) bare remote.
    const branches = (await dugiteExec(
      ['for-each-ref', 'refs/heads', '--format=%(refname:short)'],
      bare,
      { env: {} }
    )).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    expect(branches).toContain('preview');
  });
});
