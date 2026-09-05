/**
 * @fileoverview Tests for the app:get-version IPC (dynamic app version, D4)
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// CJS require bypasses setup.js vi.mock('fs'/'path') (pattern:
// tests/static-assertions.test.js) — we need the REAL modules to read files.
const fs = require('fs');
const path = require('path');

/** Repository package.json — the single version source of truth. */
const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
);

/** Path of the preload bridge (wiring assertions read the real source). */
const PRELOAD_PATH = path.resolve(__dirname, '../../preload.js');

describe('app:get-version IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!global.mockElectron) {
      global.mockElectron = {
        app: {
          getPath: vi.fn(),
          getVersion: vi.fn(),
          quit: vi.fn(),
          isPackaged: false,
          getAppPath: vi.fn()
        },
        BrowserWindow: {
          getAllWindows: vi.fn(() => []),
          getFocusedWindow: vi.fn(),
          fromWebContents: vi.fn()
        },
        ipcMain: { handle: vi.fn(), on: vi.fn() },
        ipcRenderer: { invoke: vi.fn(), on: vi.fn(), send: vi.fn() },
        contextBridge: { exposeInMainWorld: vi.fn() }
      };
    }
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function registerAndGetHandler() {
    const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const mockWindowManager = {
      hasValidMainWindow: vi.fn().mockReturnValue(false),
      getMainWindow: vi.fn()
    };
    const { SystemHandlers } = await import('../../src/ipc/system.js');
    const handlers = new SystemHandlers({ logger: mockLogger, windowManager: mockWindowManager });
    handlers.registerHandlers();

    const registration = global.mockElectron.ipcMain.handle.mock.calls.find(
      ([channel]) => channel === 'app:get-version'
    );
    expect(registration).toBeDefined();
    return registration[1];
  }

  it('registers the app:get-version handler via ipcMain.handle', async () => {
    await registerAndGetHandler();
    // Assertion happens inside registerAndGetHandler (registration found)
  });

  it('returns exactly app.getVersion() (delegates, no hardcoding)', async () => {
    global.mockElectron.app.getVersion.mockReturnValue('9.9.9-test');
    const handler = await registerAndGetHandler();
    expect(handler()).toBe('9.9.9-test');
    expect(global.mockElectron.app.getVersion).toHaveBeenCalled();
  });

  it('returns the package.json version when Electron reads it (dev behavior)', async () => {
    // Electron's app.getVersion() resolves to package.json "version" in dev
    // and to the packaged app metadata in production — mirror that here.
    global.mockElectron.app.getVersion.mockReturnValue(pkg.version);
    const handler = await registerAndGetHandler();
    expect(handler()).toBe(pkg.version);
    expect(handler()).not.toMatch(/^[a-z]/); // sanity: semver-like, not a placeholder
  });

  it('preload.js exposes getAppVersion wired to the app:get-version channel', () => {
    const source = fs.readFileSync(PRELOAD_PATH, 'utf8');
    expect(source).toMatch(
      /getAppVersion:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app:get-version'\)/
    );
  });
});
