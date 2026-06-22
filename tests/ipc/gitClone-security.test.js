/**
 * @vitest-environment node
 * @fileoverview Security guardrail tests for ProjectCreationHandler.gitClone
 * @author Documental Team
 * @since 1.0.0
 *
 * Verifies that the OAuth token is only injected for github.com URLs
 * and withheld for all other hosts (security guardrail).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const { mockGitClone, mockGitOps, mockElectron } = vi.hoisted(() => ({
  mockGitClone: vi.fn(),
  mockGitOps: { getGitHubToken: vi.fn() },
  mockElectron: {
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    app: { getPath: vi.fn(() => '/tmp/test') }
  }
}));

// ── Module._load monkey-patch for electron and isomorphic-git ──────────────
// vi.mock() does NOT intercept native require() in CJS source files.
// We patch Module._load to ensure mocks are returned for these dependencies.

const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'electron') {
    return mockElectron;
  }
  if (request === 'isomorphic-git') {
    return { clone: mockGitClone };
  }
  if (request === 'isomorphic-git/http/node') {
    return {};
  }
  return originalLoad.call(this, request, ...args);
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ProjectCreationHandler.gitClone security guardrail', () => {
  let handler;
  let mockLogger;
  let sendOutput;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };

    sendOutput = vi.fn();
    mockGitClone.mockResolvedValue(undefined);
    mockGitOps.getGitHubToken.mockResolvedValue('ghp_fake_token');

    // Use Object.create to bypass the constructor (avoids GitOperations /
    // ProcessManager side effects). We only need the prototype method gitClone
    // plus the two instance properties it references: logger and gitOps.
    // import() ensures vitest transforms the source so Module._load is active.
    const { ProjectCreationHandler } = await import('../../src/ipc/projectCreation.js');
    handler = Object.create(ProjectCreationHandler.prototype);
    handler.logger = mockLogger;
    handler.gitOps = mockGitOps;
  });

  // ── Non-GitHub URL: no token, no auth ──────────────────────────────────

  it("does NOT call getGitHubToken for non-GitHub URL and clones with auth: undefined", async () => {
    const url = 'https://evil.com/repo.git';

    await handler.gitClone(url, '/test/dir', sendOutput);

    expect(mockGitOps.getGitHubToken).not.toHaveBeenCalled();
    expect(mockGitClone).toHaveBeenCalledTimes(1);

    const callArg = mockGitClone.mock.calls[0][0];
    expect(callArg.url).toBe(url);
    expect(callArg.auth).toBeUndefined();
  });

  // ── GitHub URL: token retrieved, auth populated ────────────────────────

  it("calls getGitHubToken for github.com URL and clones with auth populated", async () => {
    const url = 'https://github.com/foo/bar.git';

    await handler.gitClone(url, '/test/dir', sendOutput);

    expect(mockGitOps.getGitHubToken).toHaveBeenCalledTimes(1);
    expect(mockGitClone).toHaveBeenCalledTimes(1);

    const callArg = mockGitClone.mock.calls[0][0];
    expect(callArg.url).toBe(url);
    expect(callArg.auth).toEqual({
      username: 'ghp_fake_token',
      password: 'x-oauth-basic'
    });
  });

  // ── Case-insensitive host match ────────────────────────────────────────

  it('uses auth for uppercase GITHUB.com URL (case-insensitive regex)', async () => {
    const url = 'https://GITHUB.com/foo/bar.git';

    await handler.gitClone(url, '/test/dir', sendOutput);

    expect(mockGitOps.getGitHubToken).toHaveBeenCalledTimes(1);
    expect(mockGitClone).toHaveBeenCalledTimes(1);

    const callArg = mockGitClone.mock.calls[0][0];
    expect(callArg.auth).toEqual({
      username: 'ghp_fake_token',
      password: 'x-oauth-basic'
    });
  });
});
