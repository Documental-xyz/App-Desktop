/**
 * @fileoverview Integration tests for configurePagesEnvironment wiring inside
 *   ProjectCreationHandler.startProjectCreation. Verifies that the new call is
 *   made right after enableGitHubPages succeeds, reuses the same owner/repo
 *   parsing, never blocks the main flow on warning/error, and is NOT invoked
 *   from openProjectOnlyPreviewAndServer (regression guard).
 * @author Documental Team
 * @since 1.1.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

// Use require() (NOT dynamic import()) so we instrument the EXACT module
// instance the handler's lazy `require('../services/githubForkService.js')`
// returns. ESM `await import()` produces a separate wrapper instance and
// spies placed on it would never fire (Wave 1 CJS/ESM divergence invariant).
const require = createRequire(import.meta.url);

// startProjectCreation uses `require('electron')` internally for BrowserWindow
// broadcasting. Wire the mock so broadcastToWindows is a no-op (no windows).
vi.mock('electron', () => {
  const BrowserWindow = vi.fn();
  BrowserWindow.getAllWindows = vi.fn(() => []);
  BrowserWindow.getFocusedWindow = vi.fn();
  BrowserWindow.fromWebContents = vi.fn();
  return {
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    BrowserWindow
  };
});

// Sentinel used to short-circuit startProjectCreation AFTER the enablePages
// block so the integration test does not have to drive the full clone flow
// (which depends on fs/execa/isomorphic-git and is exercised elsewhere).
const SHORT_CIRCUIT = 'SHORT_CIRCUIT_AFTER_PAGES';

describe('configurePagesEnvironment wiring (preview-branch-sync)', () => {
  let ProjectCreationHandler;
  let handler;
  let realGithubForkServiceModule;
  let enablePagesSpy;
  let configureEnvSpy;
  let mockLogger;

  beforeEach(async () => {
    vi.clearAllMocks();

    // vi.mock('electron') does not intercept lazy CJS require() inside the
    // handler (Wave 1 invariant). Seed require.cache at the real resolved
    // electron path so `require('electron').BrowserWindow.getAllWindows()`
    // resolves to an empty array instead of crashing.
    const electronPath = require.resolve('electron');
    require.cache[electronPath] = {
      id: electronPath,
      filename: electronPath,
      loaded: true,
      exports: {
        BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
        ipcMain: { handle() {}, on() {}, removeHandler() {} }
      }
    };

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };

    // Load the real module so we can spy on the exported singleton. Per
    // Wave 1 learnings, vi.mock() does not intercept CJS require(), so we
    // instrument the real module object instead.
    realGithubForkServiceModule = require('../../src/services/githubForkService.js');
    enablePagesSpy = vi
      .spyOn(realGithubForkServiceModule.githubForkService, 'enableGitHubPages')
      .mockResolvedValue({ success: true });
    configureEnvSpy = vi
      .spyOn(
        realGithubForkServiceModule.githubForkService,
        'configurePagesEnvironment'
      )
      .mockResolvedValue({ success: true });
    // Stub the heavier template helpers so the useTemplate branch can reach
    // the enablePages block without real Octokit calls.
    vi.spyOn(
      realGithubForkServiceModule.githubForkService,
      'createFromTemplate'
    ).mockResolvedValue({
      success: true,
      cloneUrl: 'https://github.com/acme/awesome-repo'
    });
    vi.spyOn(
      realGithubForkServiceModule.githubForkService,
      'waitForRepoReadiness'
    ).mockResolvedValue(true);

    ({ ProjectCreationHandler } = require('../../src/ipc/projectCreation.js'));

    handler = new ProjectCreationHandler({
      logger: mockLogger,
      databaseManager: { getDatabase: vi.fn().mockResolvedValue(null) },
      nodeDetectionService: { detect: vi.fn().mockResolvedValue(null) }
    });

    // Short-circuit the heavy tail of startProjectCreation. The enablePages
    // block runs BEFORE determineRepositoryTarget, so this lets us observe
    // the wiring without driving the clone/build/dev steps.
    handler.determineRepositoryTarget = vi
      .fn()
      .mockRejectedValue(new Error(SHORT_CIRCUIT));
    // The template branch runs a 3x3s readiness-probe loop; stub it so the
    // test does not hit the 5s vitest timeout.
    handler._probeRemoteRefs = vi.fn().mockResolvedValue(['refs/heads/main']);
    // openProjectOnlyPreviewAndServer also calls determineRepositoryTarget-
    // style helpers; stub the whole method on the prototype for the
    // regression-guard test by overriding the instance method below.
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[require.resolve('electron')];
  });

  /**
   * Helper: invoke startProjectCreation and swallow the SHORT_CIRCUIT sentinel
   * so the test can assert purely on spy interactions.
   */
  async function runStartProjectCreation(args) {
    const baseArgs = [
      /* projectId */ 1,
      /* projectPath */ '/tmp/fake-project',
      /* repoUrl */ 'https://github.com/acme/awesome-repo.git',
      /* isExistingGitRepo */ false,
      /* isEmptyFolder */ false,
      /* useTemplate */ true,
      /* projectName */ 'awesome-repo',
      /* enablePages */ true,
      /* organization */ null,
      /* isPrivateRepo */ false
    ];
    const finalArgs = [...baseArgs];
    for (let i = 0; i < args.length; i += 1) {
      finalArgs[i] = args[i];
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      await handler.startProjectCreation(...finalArgs);
    } catch (error) {
      if (error && error.message !== SHORT_CIRCUIT) {
        throw error;
      }
    }
  }

  it('startProjectCreation with useTemplate + enablePages calls configurePagesEnvironment with correct owner/repo', async () => {
    await runStartProjectCreation([]);

    expect(enablePagesSpy).toHaveBeenCalledWith('acme', 'awesome-repo');
    expect(configureEnvSpy).toHaveBeenCalledWith('acme', 'awesome-repo');
  });

  it('configurePagesEnvironment is not called when enablePages is false', async () => {
    // enablePages is arg index 7
    await runStartProjectCreation([
      1,
      '/tmp/fake-project',
      'https://github.com/acme/awesome-repo.git',
      false,
      false,
      true,
      'awesome-repo',
      /* enablePages */ false
    ]);

    expect(enablePagesSpy).not.toHaveBeenCalled();
    expect(configureEnvSpy).not.toHaveBeenCalled();
  });

  it('configurePagesEnvironment is not called in openProjectOnlyPreviewAndServer (regression guard)', async () => {
    // Stub every side-effecting helper that openProjectOnlyPreviewAndServer
    // may touch, so we can prove configurePagesEnvironment is never invoked
    // even when the method runs to completion.
    const original = handler.openProjectOnlyPreviewAndServer.bind(handler);

    // Replace internal collaborators with no-ops to let the method complete.
    handler.processManager = {
      delay: vi.fn().mockResolvedValue(undefined),
      runCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      spawnProcess: vi.fn().mockResolvedValue(undefined)
    };
    handler.gitOps = {
      ensurePreviewBranch: vi.fn().mockResolvedValue(undefined),
      configureGitForUser: vi.fn().mockResolvedValue(true),
      pushPreviewBranch: vi.fn().mockResolvedValue(undefined)
    };
    handler.updateRepoFolderName = vi.fn().mockResolvedValue(undefined);

    try {
      await original(1, '/tmp/fake-project', 'https://github.com/acme/awesome-repo.git', 'awesome-repo');
    } catch (error) {
      // Method may fail on unrelated mocked deps; we only care that the
      // configurePagesEnvironment spy was never touched.
    }

    expect(configureEnvSpy).not.toHaveBeenCalled();
  });

  it('configurePagesEnvironment with warning does not block the flow', async () => {
    configureEnvSpy.mockResolvedValue({
      success: true,
      warning: 'Environments unavailable (422). Branch policies skipped.'
    });

    // Must NOT throw — the SHORT_CIRCUIT sentinel is the only acceptable error.
    await runStartProjectCreation([]);

    expect(configureEnvSpy).toHaveBeenCalledWith('acme', 'awesome-repo');
    // Flow reached determineRepositoryTarget (SHORT_CIRCUIT sentinel) — proof
    // that configurePagesEnvironment's warning did not throw into the main flow.
    expect(handler.determineRepositoryTarget).toHaveBeenCalled();
  });

  it('configurePagesEnvironment with error does not block the flow', async () => {
    configureEnvSpy.mockResolvedValue({
      success: false,
      error: 'Boom from Octokit'
    });

    await runStartProjectCreation([]);

    expect(configureEnvSpy).toHaveBeenCalledWith('acme', 'awesome-repo');
    // Flow reached determineRepositoryTarget (SHORT_CIRCUIT sentinel) — proof
    // that configurePagesEnvironment's error result did not throw.
    expect(handler.determineRepositoryTarget).toHaveBeenCalled();
  });
});

// ─── Step 2 (preview branch) push-failure wiring ───────────────────────────
//
// Regression guard: when gitEnsurePreviewBranch reports { pushFailed: true },
// step 2 must surface a visible warning in its log AND must NOT mark itself
// with a terminal 'failure' status (which the renderer treats as flow-aborting
// and would hide the Finish button). The status must remain 'success' so the
// project can still open, while the warning is carried by the step log.
describe('step 2 push-failure wiring (preview-branch-sync)', () => {
  let ProjectCreationHandler;
  let handler;
  let mockLogger;
  let statusPayloads;
  let outputPayloads;
  let step2Sentinel;

  beforeEach(() => {
    vi.clearAllMocks();
    statusPayloads = [];
    outputPayloads = [];
    step2Sentinel = 'SHORT_CIRCUIT_AFTER_STEP_2';

    // Capture BrowserWindow broadcasts so we can assert on step statuses/output.
    const electronPath = require.resolve('electron');
    require.cache[electronPath] = {
      id: electronPath,
      filename: electronPath,
      loaded: true,
      exports: {
        BrowserWindow: {
          getAllWindows: () => [{
            isDestroyed: () => false,
            webContents: { send: (channel, payload) => {
              if (channel === 'command-status') statusPayloads.push(payload);
              if (channel === 'command-output') outputPayloads.push(payload);
            } }
          }],
          fromWebContents: () => null
        },
        ipcMain: { handle() {}, on() {}, removeHandler() {} }
      }
    };

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };

    // Stub the githubForkService so the enablePages path doesn't hit network.
    const githubForkServiceModule = require('../../src/services/githubForkService.js');
    vi.spyOn(githubForkServiceModule.githubForkService, 'enableGitHubPages').mockResolvedValue({ success: true });
    vi.spyOn(githubForkServiceModule.githubForkService, 'configurePagesEnvironment').mockResolvedValue({ success: true });
    vi.spyOn(githubForkServiceModule.githubForkService, 'createFromTemplate').mockResolvedValue({
      success: true, cloneUrl: 'https://github.com/acme/awesome-repo'
    });
    vi.spyOn(githubForkServiceModule.githubForkService, 'waitForRepoReadiness').mockResolvedValue(true);

    ({ ProjectCreationHandler } = require('../../src/ipc/projectCreation.js'));
    handler = new ProjectCreationHandler({
      logger: mockLogger,
      databaseManager: { getDatabase: vi.fn().mockResolvedValue(null) },
      nodeDetectionService: { detect: vi.fn().mockResolvedValue(null) }
    });

    // Drive past the early enablePages/determineRepositoryTarget phase so we
    // reach the step 2 block. determineRepositoryTarget resolves a fake
    // repoDirPath and signals that a fresh clone is required.
    handler.determineRepositoryTarget = vi.fn().mockResolvedValue({
      repoDirPath: '/tmp/fake-repo',
      repoFolderName: 'fake-repo',
      shouldClone: true
    });
    handler._probeRemoteRefs = vi.fn().mockResolvedValue(['refs/heads/main']);
    handler.updateRepoFolderName = vi.fn().mockResolvedValue(undefined);
    handler.gitClone = vi.fn().mockResolvedValue(undefined);
    // configureGitForUser runs after clone on the fresh-repo path.
    handler.gitOps = handler.gitOps || {};
    handler.gitOps.configureGitForUser = vi.fn().mockResolvedValue(true);
    // Short-circuit at step 3 (npm install): executeCommand throws a sentinel
    // we recognize, proving step 2 completed and the flow advanced past it.
    handler.processManager = {
      delay: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockRejectedValue(new Error(step2Sentinel))
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[require.resolve('electron')];
  });

  /** Run startProjectCreation with a stubbed gitEnsurePreviewBranch result. */
  async function runThroughStep2(previewResult) {
    handler.gitOps.gitEnsurePreviewBranch = vi.fn().mockResolvedValue(previewResult);
    try {
      await handler.startProjectCreation(
        1, '/tmp/fake-project', 'https://github.com/acme/awesome-repo.git',
        /* isExistingGitRepo */ false, /* isEmptyFolder */ false,
        /* useTemplate */ true, /* projectName */ 'awesome-repo',
        /* enablePages */ false, /* organization */ null,
        /* isPrivateRepo */ false
      );
    } catch (error) {
      if (error && error.message !== step2Sentinel) {
        throw error;
      }
    }
  }

  function step2Statuses() {
    return statusPayloads.filter(p => p && p.stepId === 2).map(p => p.status);
  }

  function step2OutputText() {
    return outputPayloads
      .filter(p => p && p.stepId === 2)
      .map(p => p.message || '')
      .join('');
  }

  it('marks step 2 as success (flow continues) but logs a warning when push fails', async () => {
    await runThroughStep2({ created: true, checkedOut: true, pushFailed: true, pushError: 'auth error 401' });

    // push failure must NOT abort the flow: status must be 'success' (the only
    // status the renderer treats as flow-advancing). 'failure' would hide the
    // Finish button and prevent the project from opening.
    expect(step2Statuses()).toContain('success');
    expect(step2Statuses()).not.toContain('failure');
    // The warning must be visibly logged on step 2.
    const text = step2OutputText();
    expect(text).toContain('não foi possível publicá-la'); // pt: "could not publish"
    expect(text).toContain('auth error 401');
    // Flow advanced past step 2 into step 3 (npm install sentinel fired).
    expect(handler.processManager.executeCommand).toHaveBeenCalled();
  });

  it('marks step 2 as success with a normal checkout message when push succeeds', async () => {
    await runThroughStep2({ created: true, checkedOut: true, pushFailed: false });

    expect(step2Statuses()).toContain('success');
    expect(step2Statuses()).not.toContain('failure');
    expect(step2OutputText()).toContain('Preview branch checked out');
    expect(handler.processManager.executeCommand).toHaveBeenCalled();
  });
});
