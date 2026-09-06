/**
 * @fileoverview Task 5 (publish-update-resilience): classifyError v2 —
 * large_file class, refined timeout/network/auth patterns, exit codes as
 * AUXILIARY signal, and the friendly i18n mapping
 * (src/ipc/gitErrorMessages.js).
 *
 * Sections:
 *   1. Tabular literal-stderr classification (18 cases ≥ the 12 minimum:
 *      large_file×5, timeout×3, network×4, auth×3, unknown×2, conflict×1 —
 *      the precedence pairs large_file>conflict and timeout>network are
 *      encoded in the table itself).
 *   2. extractOffendingFiles (GitHub GH001 "File <path> is <size>" lines).
 *   3. gitErrorMessages map — key names, EN inline fallbacks, severity.
 *   4. enrichFailureResult unit (additive fields, typed codes preserved).
 *   5. Flow integration (dugite, loopback http-backend harness):
 *      (a) REAL 150 MB file (dd) + publish flow → GH001 stderr injected at
 *          the provider push point → result keeps code PUSH_REJECTED
 *          (display priority) AND gains errorClass 'large_file' +
 *          offendingFiles. Decision (notepad): the local git-http-backend
 *          has NO 100 MB receive limit (receive.maxInputSize unset), so a
 *          faithful GitHub pre-receive rejection can only be produced by
 *          injecting the literal GH stderr at the classification point.
 *      (b) timeout stderr → errorClass 'timeout' with no typed code.
 *
 * @vitest-environment node
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import {
  GitError,
  classifyError,
  extractOffendingFiles,
} from '../../src/git/GitError.js';
import {
  GIT_ERROR_MESSAGES,
  getGitErrorMessage,
  enrichFailureResult,
} from '../../src/ipc/gitErrorMessages.js';
import { createRepoPair, httpBackendAvailable } from './fixtures/harness.js';
import { makeFlowHandlers } from './fixtures/providerHarness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const A_BASE = 'line1\nline2\nline3\n';

// ─── 1. Tabular classification ───────────────────────────────────────────────

/**
 * @type {Array<{name: string, input: object|string, expected: string}>}
 * Literal stderrs (verbatim GitHub/git wording) → expected ErrorType.
 */
const STDERR_TABLE = [
  // large_file ×5 (all four task-listed patterns + conflict-precedence pair)
  {
    name: 'large_file: GH001 — File … is 150.28 MB; exceeds GitHub file size limit (beats conflict)',
    input: {
      message: 'git push failed on github',
      exitCode: 1,
      stderr: [
        "remote: error: File assets/videos/demo.mp4 is 150.28 MB; this exceeds GitHub's file size limit of 100.00 MB",
        'remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.',
        'To github.com:acme/site.git',
        ' ! [remote rejected] preview -> preview (pre-receive hook declined)',
        "error: failed to push some refs to 'github.com:acme/site.git'",
      ].join('\n'),
    },
    expected: 'large_file',
  },
  {
    name: 'large_file: GH002 — oversized pack',
    input: {
      exitCode: 1,
      stderr: [
        'remote: error: GH002: Push contains a pack larger than 2 GiB. Split the push or use Git LFS.',
        ' ! [remote rejected] main -> main (pre-receive hook declined)',
      ].join('\n'),
    },
    expected: 'large_file',
  },
  {
    name: 'large_file: remote-rejected + "too large" on the same line (beats conflict)',
    input: {
      exitCode: 1,
      stderr: [
        'To github.com:acme/site.git',
        ' ! [remote rejected] preview -> preview (pack too large)',
        "error: failed to push some refs to 'github.com:acme/site.git'",
      ].join('\n'),
    },
    expected: 'large_file',
  },
  {
    name: 'large_file: "exceeds the maximum allowed size"',
    input: {
      exitCode: 1,
      stderr: 'remote: error: File public/data.zip exceeds the maximum allowed size (100 MB)',
    },
    expected: 'large_file',
  },
  {
    name: 'large_file: "this file is larger than"',
    input: {
      exitCode: 1,
      stderr: 'remote: error: Sorry, this file is larger than the maximum allowed size of 100 MB.',
    },
    expected: 'large_file',
  },

  // timeout ×3 (each also carries a NETWORK pattern — timeout precedence)
  {
    name: 'timeout: Failed to connect … Connection timed out (beats network "failed to connect"/"unable to access")',
    input: {
      exitCode: 128,
      stderr: "fatal: unable to access 'https://github.com/acme/site.git/': Failed to connect to github.com port 443: Connection timed out",
    },
    expected: 'timeout',
  },
  {
    name: 'timeout: RPC failed; curl 28 Operation timed out (beats network "RPC failed")',
    input: {
      exitCode: 128,
      stderr: 'error: RPC failed; curl 28 Operation timed out\nfatal: the remote end hung up unexpectedly',
    },
    expected: 'timeout',
  },
  {
    name: 'timeout: Node syscall code ETIMEDOUT',
    input: { message: 'spawn git ETIMEDOUT', code: 'ETIMEDOUT' },
    expected: 'timeout',
  },

  // network ×4
  {
    name: 'network: ssh Could not resolve hostname',
    input: {
      exitCode: 255,
      stderr: 'ssh: Could not resolve hostname github.com: Name or service not known',
    },
    expected: 'network',
  },
  {
    name: 'network: getaddrinfo EAI_AGAIN',
    input: { message: 'getaddrinfo EAI_AGAIN github.com', code: 'EAI_AGAIN' },
    expected: 'network',
  },
  {
    name: 'network: early EOF / index-pack failed',
    input: { exitCode: 128, stderr: 'fatal: early EOF\nfatal: index-pack failed' },
    expected: 'network',
  },
  {
    name: 'network: RPC failed; curl 56 Connection reset by peer',
    input: {
      exitCode: 128,
      stderr: 'error: RPC failed; curl 56 Recv failure: Connection reset by peer',
    },
    expected: 'network',
  },

  // auth ×3
  {
    name: 'auth: Invalid username or token + Authentication failed',
    input: {
      exitCode: 128,
      stderr: "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/acme/site.git/'",
    },
    expected: 'auth',
  },
  {
    name: 'auth: could not read Username + terminal prompts disabled',
    input: {
      exitCode: 128,
      stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    },
    expected: 'auth',
  },
  {
    name: 'auth: HTTP 403 (existing \\b403\\b rule preserved)',
    input: { exitCode: 128, stderr: "error: The requested URL returned error: 403" },
    expected: 'auth',
  },

  // conflict ×1 (existing taxonomy regression guard)
  {
    name: 'conflict: non-fast-forward rejection (existing taxonomy preserved)',
    input: {
      exitCode: 1,
      stderr: "To github.com:acme/site.git\n ! [rejected] preview -> preview (non-fast-forward)\nerror: failed to push some refs to 'github.com:acme/site.git'",
    },
    expected: 'conflict',
  },

  // unknown ×2 — exit codes are AUXILIARY only (128 fatal / 129 usage never
  // invent a class; granularity comes from stderr)
  {
    name: 'unknown: exit 128 with unclassifiable fatal — exit code stays auxiliary',
    input: {
      exitCode: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    },
    expected: 'unknown',
  },
  {
    name: 'unknown: exit 129 usage error — auxiliary, not decisive',
    input: {
      exitCode: 129,
      stderr: 'usage: git push [<options>] [<repository> [<refspec>...]]',
    },
    expected: 'unknown',
  },
];

describe.each(STDERR_TABLE)('classifyError table: %s', ({ input, expected }) => {
  it(`classifies as ${expected}`, () => {
    expect(classifyError(input)).toBe(expected);
    expect(GitError.classifyError(input)).toBe(expected); // static export parity
  });
});

// ─── 2. extractOffendingFiles ────────────────────────────────────────────────

describe('extractOffendingFiles', () => {
  const GH001_STDERR = [
    "remote: error: File assets/videos/demo.mp4 is 150.28 MB; this exceeds GitHub's file size limit of 100.00 MB",
    "remote: error: File assets/pdfs/manual.pdf is 104.85 MB; this exceeds GitHub's file size limit of 100.00 MB",
    'remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.',
    ' ! [remote rejected] preview -> preview (pre-receive hook declined)',
  ].join('\n');

  it('extracts every offending path from GH001 "File <path> is <size>" lines', () => {
    expect(extractOffendingFiles(GH001_STDERR)).toEqual([
      'assets/videos/demo.mp4',
      'assets/pdfs/manual.pdf',
    ]);
  });

  it('dedupes repeated paths and returns [] when nothing is extractable', () => {
    expect(extractOffendingFiles(`${GH001_STDERR}\nremote: error: File assets/videos/demo.mp4 is 150.28 MB; again`)).toHaveLength(2);
    expect(extractOffendingFiles('error: failed to push some refs')).toEqual([]);
    expect(extractOffendingFiles(undefined)).toEqual([]);
  });

  it('sanitizes tokens before paths are returned (defense-in-depth)', () => {
    const dirty = "remote: error: File assets/big.bin is 150.28 MB; pushed via https://user:ghp_0123456789abcdefghijklmnopqrstu@github.com/acme/site.git";
    const files = extractOffendingFiles(dirty);
    expect(files).toEqual(['assets/big.bin']);
  });
});

// ─── 3. Friendly i18n mapping ────────────────────────────────────────────────

describe('gitErrorMessages map', () => {
  it('covers every supported errorClass with titleKey/hintKey/severity', () => {
    for (const errorClass of ['large_file', 'timeout', 'auth', 'network', 'conflict', 'unknown']) {
      const entry = getGitErrorMessage(errorClass);
      expect(entry.titleKey, `${errorClass} titleKey`).toMatch(/^main\.git_exec_error_/);
      expect(entry.hintKey, `${errorClass} hintKey`).toMatch(/^main\.git_exec_error_/);
      expect(['error', 'warning']).toContain(entry.severity);
      expect(entry.fallbackTitle).toBeTruthy();
      expect(entry.fallbackHint).toBeTruthy();
    }
  });

  it('falls back to the unknown entry for bogus classes', () => {
    expect(getGitErrorMessage('nonsense').titleKey).toBe(GIT_ERROR_MESSAGES.unknown.titleKey);
  });

  it('large_file hint mentions the 100 MB limit and Git LFS; timeout hint says nothing was lost', () => {
    const largeFile = getGitErrorMessage('large_file');
    expect(largeFile.fallbackHint).toMatch(/100\s*MB/);
    expect(largeFile.fallbackHint).toMatch(/Git LFS/i);
    expect(getGitErrorMessage('timeout').fallbackHint).toMatch(/nothing was lost/i);
  });

  it('uses the exact key names T12 will add to the three locales', () => {
    expect(GIT_ERROR_MESSAGES.large_file).toMatchObject({
      titleKey: 'main.git_exec_error_large_file_title',
      hintKey: 'main.git_exec_error_large_file_hint',
    });
    expect(GIT_ERROR_MESSAGES.timeout).toMatchObject({
      titleKey: 'main.git_exec_error_timeout_title',
      hintKey: 'main.git_exec_error_timeout_hint',
    });
  });
});

// ─── 4. enrichFailureResult (unit) ───────────────────────────────────────────

describe('enrichFailureResult', () => {
  const ghStderr = [
    "remote: error: File assets/big.bin is 150.28 MB; this exceeds GitHub's file size limit of 100.00 MB",
    ' ! [remote rejected] preview -> preview (pre-receive hook declined)',
  ].join('\n');

  it('adds additive fields and PRESERVES the typed code (display priority)', () => {
    const err = new GitError({ operation: 'push', provider: 'github', exitCode: 1, stderr: ghStderr });
    const result = enrichFailureResult({ success: false, code: 'PUSH_REJECTED', error: 'O repositório remoto tem novidades.' }, err);
    expect(result).toMatchObject({
      success: false,
      code: 'PUSH_REJECTED',
      error: 'O repositório remoto tem novidades.',
      errorClass: 'large_file',
      errorTitleKey: 'main.git_exec_error_large_file_title',
      errorHintKey: 'main.git_exec_error_large_file_hint',
      offendingFiles: ['assets/big.bin'],
    });
  });

  it('walks the cause chain (GitFlowError wraps the provider GitError)', () => {
    const cause = new GitError({ operation: 'push', provider: 'github', exitCode: 1, stderr: ghStderr });
    const flowErr = Object.assign(new Error('wrapped'), { name: 'GitFlowError', code: 'PUSH_REJECTED', cause });
    const result = enrichFailureResult({ success: false, code: 'PUSH_REJECTED', error: 'wrapped' }, flowErr);
    expect(result.errorClass).toBe('large_file');
    expect(result.offendingFiles).toEqual(['assets/big.bin']);
  });

  it('omits offendingFiles when nothing is extractable and leaves non-failures untouched', () => {
    const result = enrichFailureResult(
      { success: false, error: 'x' },
      new Error('error: RPC failed; curl 28 Operation timed out'),
    );
    expect(result.errorClass).toBe('timeout');
    expect(result.offendingFiles).toBeUndefined();
    const ok = { success: true, data: 1 };
    expect(enrichFailureResult(ok, new Error('timed out'))).toBe(ok);
  });

  it('never breaks the failure result when classification blows up', () => {
    const cyc = new Error('boom'); cyc.cause = cyc; // pathological self-cause
    const result = enrichFailureResult({ success: false, error: 'x' }, cyc);
    expect(result.success).toBe(false);
    expect(result.errorClass).toBeTruthy();
  });
});

// ─── 5. Flow integration (dugite + loopback origin) ──────────────────────────

describe.skipIf(!httpBackendAvailable)('flow integration: publish failure classification [dugite]', () => {
  let pair;
  let handlers;

  beforeEach(() => {
    handlers = null;
    pair = null;
  });
  afterEach(async () => {
    if (handlers && handlers.gitOperationInProgress) handlers.releaseGitLock();
    if (pair) await pair.dispose();
  });

  it('(a) 150 MB file (dd) publish → code PUSH_REJECTED preserved + errorClass large_file + offendingFiles', async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
    handlers = makeFlowHandlers(pair.local.dir, 'dugite');

    // REAL oversized file (same shape a user hits), committed for real.
    const bigRel = 'assets/big-video.bin';
    const bigAbs = path.join(pair.local.dir, bigRel);
    fs.mkdirSync(path.dirname(bigAbs), { recursive: true });
    execFileSync('dd', ['if=/dev/zero', `of=${bigAbs}`, 'bs=1M', 'count=150']);
    expect(fs.statSync(bigAbs).size).toBeGreaterThan(100 * 1024 * 1024);
    await pair.local.commit('local: add 150 MB asset', bigRel);
    handlers._gitCache = {};

    // Local ahead only → flow reaches the push step. The loopback
    // git-http-backend has NO 100 MB receive limit, so the GitHub
    // pre-receive rejection is injected verbatim at the provider push
    // (decision documented in the task-5 notepad entry).
    const ghStderr = [
      `remote: error: File ${bigRel} is 150.28 MB; this exceeds GitHub's file size limit of 100.00 MB`,
      'remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.',
      'To github.com:acme/site.git',
      ' ! [remote rejected] preview -> preview (pre-receive hook declined)',
      "error: failed to push some refs to 'github.com:acme/site.git'",
    ].join('\n');
    vi.spyOn(handlers.git, 'push').mockRejectedValue(
      new GitError({ operation: 'push', provider: 'github', exitCode: 1, stderr: ghStderr }),
    );

    const result = await handlers.gitPublishPreview(1, 'local: add 150 MB asset');

    // Typed code PRESERVED and displayed first (existing renderer contract).
    expect(result.success).toBe(false);
    expect(result.code).toBe('PUSH_REJECTED');
    // NEW additive classification fields.
    expect(result.errorClass).toBe('large_file');
    expect(result.errorTitleKey).toBe('main.git_exec_error_large_file_title');
    expect(result.errorHintKey).toBe('main.git_exec_error_large_file_hint');
    expect(result.offendingFiles).toEqual([bigRel]);
    // Zero local loss + lock released (flow contract).
    expect(fs.statSync(bigAbs).size).toBeGreaterThan(100 * 1024 * 1024);
    expect(handlers.gitOperationInProgress).toBe(false);

    // Evidence: full failure result of the 150 MB push.
    const evidenceDir = path.resolve(process.cwd(), '.omo', 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, 'task-5-largefile-result.json'),
      `${JSON.stringify({
        scenario: '150 MB dd file committed; GH001 stderr injected at provider push (loopback http-backend has no 100 MB limit)',
        fileSizeBytes: fs.statSync(bigAbs).size,
        result,
      }, null, 2)}\n`,
    );
  });

  it('(b) timeout stderr → errorClass timeout, no typed code, generic error path', async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
    handlers = makeFlowHandlers(pair.local.dir, 'dugite');

    pair.local.writeFiles({ 'a.md': 'line1\nline2-LOCAL\nline3\n' });
    await pair.local.commit('local: ahead commit', 'a.md');
    handlers._gitCache = {};

    vi.spyOn(handlers.git, 'push').mockRejectedValue(
      new GitError({
        operation: 'push',
        provider: 'github',
        exitCode: 128,
        stderr: 'error: RPC failed; curl 28 Operation timed out\nfatal: the remote end hung up unexpectedly',
      }),
    );

    const result = await handlers.gitPublishPreview(1, 'local: edit');

    expect(result.success).toBe(false);
    expect(result.code).toBeUndefined(); // no typed code — class is the signal
    expect(result.errorClass).toBe('timeout');
    expect(result.errorTitleKey).toBe('main.git_exec_error_timeout_title');
    expect(result.errorHintKey).toBe('main.git_exec_error_timeout_hint');
    expect(result.offendingFiles).toBeUndefined();
    expect(handlers.gitOperationInProgress).toBe(false);
  });
});
