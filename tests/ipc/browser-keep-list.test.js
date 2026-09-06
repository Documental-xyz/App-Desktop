/**
 * @fileoverview Keep-list regression guards (plan: fechar-ambiente-ghost-browserviews, Task 2).
 *
 * These tests are a GREEN baseline protecting the "keep-list": the call sites
 * that LEGITIMATELY create BrowserViews lazily and MUST keep doing so after
 * the future pure-lookup fix (Task 4) migrates the other readers
 * (getBrowserViewsForEvent consumers) to pure lookup.
 *
 * Keep-list (src/ipc/browser.js):
 *   - loadBrowserViewUrl            (:206) → getBrowserViewsForEvent → get-or-create
 *   - ipcMain.on('cms:page-loaded') (:592) → getOrCreateBrowserViews(window)
 *   - ipcMain.on('cms:content-saved')(:630) / 'cms:slug-changed' (:671) — same shape
 *
 * AC3: lazy-create is preserved for cms:* handlers and loadBrowserViewUrl.
 * AC4: the normal attach/detach overlay cycle works with EXISTING views
 *      (remove/add) without re-creating them.
 *
 * Mock strategy (pattern from tests/ipc/navigate.test.js): mutate the SHARED
 * `global.mockElectron` object in place BEFORE importing src/ipc/browser.js —
 * browser.js destructures `{ ipcMain, BrowserView, BrowserWindow }` at CJS
 * require time, so mocks must exist first; `vi.resetModules()` between tests
 * forces a fresh capture.
 *
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** BrowserView instance shape used by src/ipc/browser.js (trackBrowserViewLoad etc). */
function makeViewWebContents() {
  return {
    loadURL: vi.fn(),
    getURL: vi.fn(() => 'about:blank'),
    once: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    capturePage: vi.fn(),
    goBack: vi.fn(),
    reload: vi.fn(),
    canGoBack: vi.fn(() => false)
  };
}

function makeMockWindow(id = 7) {
  return {
    id,
    on: vi.fn(),
    addBrowserView: vi.fn(),
    removeBrowserView: vi.fn(),
    getContentSize: vi.fn(() => [1400, 900]),
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() }
  };
}

/**
 * Configure the shared electron mock BEFORE browser.js is imported.
 * Records BrowserView constructions on the returned constructor mock.
 */
function setupElectronMocks(mockWindow) {
  const BrowserViewCtor = vi.fn(() => ({
    webContents: makeViewWebContents(),
    setBounds: vi.fn()
  }));

  const BrowserWindowCtor = vi.fn();
  BrowserWindowCtor.fromWebContents = vi.fn(() => mockWindow);
  BrowserWindowCtor.getAllWindows = vi.fn(() => []);

  // In-place mutation only — reassigning global.mockElectron itself is
  // invisible to the CJS require('electron') alias (tests/__mocks__/electron.js).
  global.mockElectron.BrowserView = BrowserViewCtor;
  global.mockElectron.BrowserWindow = BrowserWindowCtor;
  global.mockElectron.ipcMain = {
    handle: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  };

  return { BrowserViewCtor };
}

function makeDeps(overrides = {}) {
  return {
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    windowManager: { getMainWindow: vi.fn(), getAllWindows: vi.fn(() => []) },
    processManager: { getGlobalDevServerUrl: vi.fn(() => 'http://preview.local/') },
    ...overrides
  };
}

describe('AC3 — keep-list: cms:* handlers and loadBrowserViewUrl keep lazy-create', () => {
  let mockWindow;
  let mockEvent;
  let BrowserViewCtor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWindow = makeMockWindow();
    mockEvent = { sender: { id: 'sender-1' } };
    ({ BrowserViewCtor } = setupElectronMocks(mockWindow));
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function freshHandlers() {
    const { BrowserHandlers } = await import('../../src/ipc/browser.js');
    return new BrowserHandlers(makeDeps());
  }

  it("ipcMain.on('cms:page-loaded') creates views for a fresh window (getOrCreateBrowserViews at :592)", async () => {
    const handlers = await freshHandlers();
    handlers.registerHandlers();

    const cmsHandler = global.mockElectron.ipcMain.on.mock.calls
      .map(([channel, fn]) => ({ channel, fn }))
      .find(({ channel }) => channel === 'cms:page-loaded')?.fn;
    expect(cmsHandler).toBeTypeOf('function');

    // Fresh window: the per-window views map is EMPTY before the event.
    expect(handlers.windowBrowserViews.size).toBe(0);

    // Minimal valid payload: a slug that survives _validateAndSanitizeSlug.
    cmsHandler(mockEvent, 'my-test-page');

    // GUARD: the handler must have CREATED the views (lazy get-or-create).
    expect(handlers.windowBrowserViews.has(mockWindow)).toBe(true);
    expect(handlers.windowBrowserViews.size).toBe(1);
    expect(BrowserViewCtor).toHaveBeenCalledTimes(2); // editor + viewer

    // The created viewer view is actually used: preview URL loaded into it.
    const editorView = BrowserViewCtor.mock.results[0].value;
    const viewerView = BrowserViewCtor.mock.results[1].value;
    expect(viewerView.webContents.loadURL)
      .toHaveBeenCalledWith('http://preview.local/my-test-page/');
    expect(editorView.webContents.loadURL).not.toHaveBeenCalled();
    expect(handlers.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not determine window'),
      expect.anything()
    );
  });

  it('loadBrowserViewUrl creates views when absent and reuses them afterwards (get-or-create at :206)', async () => {
    const handlers = await freshHandlers();
    expect(handlers.windowBrowserViews.size).toBe(0);

    // Absent → create + load into the requested editor view.
    handlers.loadBrowserViewUrl(mockEvent, 'editor', 'https://example.com/editor');
    expect(BrowserViewCtor).toHaveBeenCalledTimes(2);
    expect(handlers.windowBrowserViews.has(mockWindow)).toBe(true);
    const editorView = BrowserViewCtor.mock.results[0].value;
    expect(editorView.webContents.loadURL).toHaveBeenCalledWith('https://example.com/editor');
    expect(handlers.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('BrowserView not found'),
      expect.anything()
    );

    // Present → reuse (no new constructions) for the viewer view.
    handlers.loadBrowserViewUrl(mockEvent, 'viewer', 'https://example.com/viewer');
    expect(BrowserViewCtor).toHaveBeenCalledTimes(2); // still exactly one pair
    const viewerView = BrowserViewCtor.mock.results[1].value;
    expect(viewerView.webContents.loadURL).toHaveBeenCalledWith('https://example.com/viewer');
    expect(handlers.windowBrowserViews.size).toBe(1);
  });
});

describe('AC4 — normal overlay cycle: attach/detach reuses existing views', () => {
  let mockWindow;
  let mockEvent;
  let BrowserViewCtor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWindow = makeMockWindow();
    mockEvent = { sender: { id: 'sender-1' } };
    ({ BrowserViewCtor } = setupElectronMocks(mockWindow));
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function freshHandlers() {
    const { BrowserHandlers } = await import('../../src/ipc/browser.js');
    return new BrowserHandlers(makeDeps());
  }

  it('setAllBrowserViewVisibility(false→true) removes/re-adds BOTH views without re-creating them', async () => {
    const handlers = await freshHandlers();

    // Pre-create the pair (explicit keep-list entry point).
    const views = handlers.getOrCreateBrowserViews(mockWindow);
    expect(BrowserViewCtor).toHaveBeenCalledTimes(2);
    expect(views.editorView).toBe(BrowserViewCtor.mock.results[0].value);
    expect(views.viewerView).toBe(BrowserViewCtor.mock.results[1].value);

    // Detach (overlay hidden): editor + viewer removed from the window.
    handlers.setAllBrowserViewVisibility(mockEvent, false);
    expect(mockWindow.removeBrowserView).toHaveBeenCalledTimes(2);
    expect(mockWindow.removeBrowserView).toHaveBeenCalledWith(views.editorView);
    expect(mockWindow.removeBrowserView).toHaveBeenCalledWith(views.viewerView);
    expect(mockWindow.addBrowserView).not.toHaveBeenCalled();

    // Attach (overlay shown): same two instances re-added.
    handlers.setAllBrowserViewVisibility(mockEvent, true);
    expect(mockWindow.addBrowserView).toHaveBeenCalledTimes(2);
    expect(mockWindow.addBrowserView).toHaveBeenCalledWith(views.editorView);
    expect(mockWindow.addBrowserView).toHaveBeenCalledWith(views.viewerView);

    // GUARD: map entry survives the cycle and NOTHING was constructed again.
    expect(handlers.windowBrowserViews.size).toBe(1);
    expect(handlers.windowBrowserViews.get(mockWindow)).toBe(views);
    expect(BrowserViewCtor).toHaveBeenCalledTimes(2);
  });
});
