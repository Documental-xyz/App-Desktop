/**
 * @fileoverview Tests for the same-window workspace switch (D3):
 * navigate() BrowserView teardown + result feedback, and full deletion of
 * the old two-window closeAndReopenToIndex flow.
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// CJS require bypasses setup.js vi.mock('fs'/'path') (pattern:
// tests/ipc/version.test.js) — real modules needed for source assertions.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SRC = {
  system: path.join(ROOT, 'src/ipc/system.js'),
  index: path.join(ROOT, 'src/ipc/index.js'),
  preload: path.join(ROOT, 'preload.js'),
  mainHtml: path.join(ROOT, 'renderer/main.html')
};

/** Flusher: navigate() is sync but settles loadFile via a promise chain. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeMockWindow(loadFileImpl) {
  return {
    id: 42,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    removeBrowserView: vi.fn(),
    loadFile: vi.fn(loadFileImpl || (() => Promise.resolve()))
  };
}

function makeBrowserHandlers() {
  return { cleanupWindowBrowserViews: vi.fn() };
}

function makeDeps(overrides = {}) {
  return {
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    windowManager: { hasValidMainWindow: vi.fn().mockReturnValue(true), getMainWindow: vi.fn() },
    ...overrides
  };
}

describe('navigate() — same-window workspace switch (D3)', () => {
  let mockWindow;
  let browserHandlers;
  let mockEvent;
  let BrowserWindowCtor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWindow = makeMockWindow();
    browserHandlers = makeBrowserHandlers();
    mockEvent = { sender: { send: vi.fn() } };

    BrowserWindowCtor = vi.fn(() => {
      throw new Error('navigate() must not create a new BrowserWindow');
    });
    // Mutate the SHARED mock object in place (tests/__mocks__/electron.js
    // wraps global.mockElectron by reference — reassignment is invisible to
    // the CJS require('electron') inside src/ipc/system.js).
    global.mockElectron.app = {
      getPath: vi.fn(),
      getVersion: vi.fn(),
      quit: vi.fn(),
      isPackaged: false,
      getAppPath: vi.fn(() => ROOT)
    };
    global.mockElectron.BrowserWindow = BrowserWindowCtor;
    global.mockElectron.ipcMain = { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() };
    global.mockElectron.ipcRenderer = { invoke: vi.fn(), on: vi.fn(), send: vi.fn() };
    global.mockElectron.contextBridge = { exposeInMainWorld: vi.fn() };
    global.mockElectron.nativeTheme = { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() };
    global.mockElectron.BrowserWindow.fromWebContents = vi.fn(() => mockWindow);
    global.mockElectron.BrowserWindow.getAllWindows = vi.fn(() => []);
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function importHandlers(withBrowserHandlers = true) {
    const { SystemHandlers } = await import('../../src/ipc/system.js');
    const deps = makeDeps();
    if (withBrowserHandlers) deps.browserHandlers = browserHandlers;
    return new SystemHandlers(deps);
  }

  it('loads index.html on the SENDER window and never creates a second window', async () => {
    const handlers = await importHandlers();
    handlers.navigate(mockEvent, 'index.html');
    await flush();

    expect(BrowserWindowCtor).not.toHaveBeenCalled();
    expect(mockWindow.loadFile).toHaveBeenCalledTimes(1);
    const filePath = mockWindow.loadFile.mock.calls[0][0];
    expect(filePath).toContain(path.join('renderer', 'index.html'));
  });

  it('tears down the window BrowserViews BEFORE loadFile when leaving main.html', async () => {
    const handlers = await importHandlers();
    handlers.navigate(mockEvent, 'index.html');
    await flush();

    expect(browserHandlers.cleanupWindowBrowserViews).toHaveBeenCalledTimes(1);
    expect(browserHandlers.cleanupWindowBrowserViews).toHaveBeenCalledWith(mockWindow);
    expect(browserHandlers.cleanupWindowBrowserViews.mock.invocationCallOrder[0])
      .toBeLessThan(mockWindow.loadFile.mock.invocationCallOrder[0]);
  });

  it('does NOT tear down BrowserViews when navigating TO main.html', async () => {
    const handlers = await importHandlers();
    handlers.navigate(mockEvent, 'main.html');
    await flush();

    expect(browserHandlers.cleanupWindowBrowserViews).not.toHaveBeenCalled();
    expect(mockWindow.loadFile).toHaveBeenCalledTimes(1);
  });

  it('sends navigate-complete to the renderer after a successful load', async () => {
    const handlers = await importHandlers();
    handlers.navigate(mockEvent, 'index.html');
    await flush();

    expect(mockEvent.sender.send).toHaveBeenCalledWith('navigate-complete', 'index.html');
    expect(mockEvent.sender.send).not.toHaveBeenCalledWith(
      expect.stringContaining('navigate-failed'),
      expect.anything(),
      expect.anything()
    );
  });

  it('removes the temporary close-prevention handler after a successful load', async () => {
    const handlers = await importHandlers();
    handlers.navigate(mockEvent, 'index.html');
    await flush();

    expect(mockWindow.on).toHaveBeenCalledWith('close', expect.any(Function));
    expect(mockWindow.removeListener).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('registers the close-prevention handler BEFORE loadFile', async () => {
    const handlers = await importHandlers();
    handlers.navigate(mockEvent, 'index.html');
    await flush();

    expect(mockWindow.on.mock.invocationCallOrder[0])
      .toBeLessThan(mockWindow.loadFile.mock.invocationCallOrder[0]);
  });

  it('sends navigate-failed with the error message when loadFile rejects', async () => {
    mockWindow = makeMockWindow(() => Promise.reject(new Error('ENOENT: index.html missing')));
    global.mockElectron.BrowserWindow.fromWebContents = vi.fn(() => mockWindow);
    const handlers = await importHandlers();
    handlers.navigate(mockEvent, 'index.html');
    await flush();

    expect(mockEvent.sender.send).toHaveBeenCalledWith('navigate-failed', 'index.html', 'ENOENT: index.html missing');
    expect(mockEvent.sender.send).not.toHaveBeenCalledWith('navigate-complete', expect.anything());
    expect(mockWindow.removeListener).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('keeps navigating when BrowserView teardown throws (never fatal)', async () => {
    browserHandlers.cleanupWindowBrowserViews.mockImplementation(() => {
      throw new Error('view already destroyed');
    });
    const handlers = await importHandlers();
    handlers.navigate(mockEvent, 'index.html');
    await flush();

    expect(mockWindow.loadFile).toHaveBeenCalledTimes(1);
    expect(handlers.logger.warn).toHaveBeenCalledWith(expect.stringContaining('BrowserView teardown'));
  });

  it('still navigates when browserHandlers is not injected', async () => {
    const handlers = await importHandlers(false);
    expect(() => handlers.navigate(mockEvent, 'index.html')).not.toThrow();
    await flush();
    expect(mockWindow.loadFile).toHaveBeenCalledTimes(1);
  });
});

describe('deletion of the closeAndReopenToIndex two-window flow', () => {
  it('SystemHandlers no longer has a closeAndReopenToIndex method', async () => {
    const { SystemHandlers } = await import('../../src/ipc/system.js');
    const handlers = new SystemHandlers(makeDeps());
    expect(handlers.closeAndReopenToIndex).toBeUndefined();
  });

  it('registerHandlers registers no close-and-reopen-to-index channel', async () => {
    // Fresh module graph required: system.js caches the ipcMain reference at
    // require time, so the mocks below must be in place BEFORE the import
    // (the previous describe's afterEach reset does not cover this test).
    vi.resetModules();
    // Same mutate-in-place rule as above — never reassign global.mockElectron.
    global.mockElectron.app = { getPath: vi.fn(), getVersion: vi.fn(), quit: vi.fn(), isPackaged: false, getAppPath: vi.fn() };
    global.mockElectron.BrowserWindow = { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(), fromWebContents: vi.fn() };
    global.mockElectron.ipcMain = { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() };
    global.mockElectron.ipcRenderer = { invoke: vi.fn(), on: vi.fn(), send: vi.fn() };
    global.mockElectron.contextBridge = { exposeInMainWorld: vi.fn() };
    global.mockElectron.nativeTheme = { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() };
    const { SystemHandlers } = await import('../../src/ipc/system.js');
    const handlers = new SystemHandlers(makeDeps());
    handlers.registerHandlers();

    const channels = [
      ...global.mockElectron.ipcMain.handle.mock.calls.map(([channel]) => channel),
      ...global.mockElectron.ipcMain.on.mock.calls.map(([channel]) => channel)
    ];
    expect(channels).not.toContain('close-and-reopen-to-index');
    expect(channels).toContain('navigate');
    vi.resetModules();
  });

  it('has ZERO references to closeAndReopenToIndex across src/, renderer/ and preload.js', () => {
    const targets = [SRC.system, SRC.index, SRC.preload, SRC.mainHtml];
    for (const file of targets) {
      expect(fs.readFileSync(file, 'utf8')).not.toContain('closeAndReopenToIndex');
    }
    expect(fs.readFileSync(SRC.system, 'utf8')).not.toContain('close-and-reopen-to-index');
  });
});

describe('navigation feedback wiring', () => {
  it('preload exposes one-shot navigate-complete/navigate-failed listeners', () => {
    const preload = fs.readFileSync(SRC.preload, 'utf8');
    expect(preload).toContain("onceNavigateComplete: (callback) => ipcRenderer.once('navigate-complete'");
    expect(preload).toContain("onceNavigateFailed: (callback) => ipcRenderer.once('navigate-failed'");
    expect(preload).not.toContain('closeAndReopenToIndex');
  });

  it('IPC registry injects browserHandlers into SystemHandlers (constructor wiring)', () => {
    const indexSrc = fs.readFileSync(SRC.index, 'utf8');
    expect(indexSrc).toMatch(/browserHandlers:\s*this\.browserHandlers/);
    const systemSrc = fs.readFileSync(SRC.system, 'utf8');
    expect(systemSrc).toMatch(/constructor\(\{[^}]*browserHandlers/s);
    expect(systemSrc).toMatch(/this\.browserHandlers\s*=\s*browserHandlers\s*\|\|\s*null/);
  });
});
