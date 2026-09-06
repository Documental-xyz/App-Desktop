/**
 * @fileoverview AC6 (TDD RED — Task 3, fix lands in Task 6): navigate()
 * teardown must be IDEMPOTENT and must run a SECOND pass after loadFile
 * settles (both .then and .catch), so BrowserViews re-attached DURING the
 * navigation race (the "Fechar Ambiente" ghost) are removed automatically.
 *
 * Unlike tests/ipc/navigate.test.js (which injects a browserHandlers mock),
 * these tests wire the REAL BrowserHandlers (src/ipc/browser.js) into
 * SystemHandlers so the real windowBrowserViews Map, real
 * cleanupWindowBrowserViews idempotency and real setAllBrowserViewVisibility
 * get-or-create semantics are exercised.
 *
 * Bug chain covered here (plan: fechar-ambiente-ghost-browserviews):
 *  1. navigate('index.html') tears the window's views down (map empties)
 *     and starts loadFile (async).
 *  2. DURING the flight, main.html's $watch('isAnyOverlayOpen') microtask
 *     used to fire set-all-browser-view-visibility(true), whose
 *     get-or-create semantics RE-CREATED views on the empty map and
 *     re-attached them (the ghost). Layer 2 made all readers pure
 *     lookups, closing that factory — so the race tests below seed the
 *     ghost DIRECTLY via getOrCreateBrowserViews mid-flight, proving
 *     that even a seeded ghost is harvested by the second pass.
 *  3. Task 6 added the second teardown pass in .then/.catch of
 *     system.js navigate(): nothing survives after loadFile settles.
 *
 * GREEN (post-fix): all 5 tests pass — Layer 1 kills the renderer
 * trigger, Layer 2 kills the main-process factory, Layer 3 harvests
 * whatever escapes.
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

/** Flusher: navigate() is sync but settles loadFile via a promise chain. */
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** Double flush: guarantees the loadFile .then/.catch chain fully ran. */
const flushAll = async () => { await flush(); await flush(); await flush(); };

/** Controllable loadFile — the test decides when (and how) it settles. */
function makeDeferredLoadFile() {
  let settle;
  const promise = new Promise((_resolve, reject) => { settle = reject; });
  return {
    loadFile: vi.fn(() => promise),
    reject: (err) => settle(err),
    resolve: undefined // reject-only helper; success tests use Promise.resolve
  };
}

function makeMockWindow(loadFileImpl) {
  return {
    id: 42,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    addBrowserView: vi.fn(),
    removeBrowserView: vi.fn(),
    getContentSize: vi.fn(() => [1280, 800]),
    setContentSize: vi.fn(),
    webContents: { send: vi.fn(), invalidate: vi.fn() },
    loadFile: vi.fn(loadFileImpl || (() => Promise.resolve()))
  };
}

/** Constructable BrowserView stub — vi.fn keeps instance tracking. */
function makeBrowserViewCtor() {
  return vi.fn(function BrowserViewStub(options) {
    this.options = options;
    this.setBounds = vi.fn();
    this.getBounds = vi.fn(() => ({ x: 0, y: 0, width: 0, height: 0 }));
    this.webContents = {
      isDestroyed: vi.fn(() => false),
      close: vi.fn(),
      invalidate: vi.fn()
    };
  });
}

describe('AC6 — navigate() teardown: double-pass idempotency + race recovery', () => {
  let mockWindow;
  let mockEvent;
  let BrowserWindowCtor;
  let BrowserViewCtor;
  let logger;
  let browserHandlers; // REAL BrowserHandlers instance (real Map inside)
  let systemHandlers;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEvent = { sender: { send: vi.fn() } };
    logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    BrowserWindowCtor = vi.fn(function BrowserWindowStub() {
      throw new Error('navigate() must not create a new BrowserWindow');
    });
    BrowserViewCtor = makeBrowserViewCtor();

    // Mutate the SHARED mock object in place (tests/__mocks__/electron.js
    // wraps global.mockElectron by reference — reassignment is invisible to
    // the CJS require('electron') inside src/ipc/*).
    global.mockElectron.app = {
      getPath: vi.fn(),
      getVersion: vi.fn(),
      quit: vi.fn(),
      isPackaged: false,
      getAppPath: vi.fn(() => ROOT)
    };
    global.mockElectron.BrowserWindow = BrowserWindowCtor;
    global.mockElectron.BrowserView = BrowserViewCtor;
    global.mockElectron.ipcMain = { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() };
    global.mockElectron.ipcRenderer = { invoke: vi.fn(), on: vi.fn(), send: vi.fn() };
    global.mockElectron.contextBridge = { exposeInMainWorld: vi.fn() };
    global.mockElectron.nativeTheme = { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() };

    // Real handler wiring: SystemHandlers delegates teardown to the REAL
    // BrowserHandlers.cleanupWindowBrowserViews (windowBrowserViews Map).
    const { SystemHandlers } = await import('../../src/ipc/system.js');
    const { BrowserHandlers } = await import('../../src/ipc/browser.js');
    browserHandlers = new BrowserHandlers({
      logger,
      windowManager: { getMainWindow: vi.fn(() => null) },
      processManager: null
    });
    systemHandlers = new SystemHandlers({
      logger,
      windowManager: { hasValidMainWindow: vi.fn().mockReturnValue(true), getMainWindow: vi.fn() },
      browserHandlers
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  /** Points BrowserWindow.fromWebContents at the given mock window. */
  function bindWindow(window) {
    mockWindow = window;
    BrowserWindowCtor.fromWebContents = vi.fn(() => mockWindow);
    BrowserWindowCtor.getAllWindows = vi.fn(() => []);
  }

  /** Seeds the map exactly like a real editor session: 2 views attached. */
  function seedRealViews(window) {
    const views = browserHandlers.getOrCreateBrowserViews(window);
    window.addBrowserView(views.editorView);
    window.addBrowserView(views.viewerView);
    return views;
  }

  it('[GREEN] manual double teardown is idempotent — second pass never throws, map stays empty', async () => {
    bindWindow(makeMockWindow());
    seedRealViews(mockWindow);
    expect(browserHandlers.windowBrowserViews.size).toBe(1);

    systemHandlers.navigate(mockEvent, 'index.html');
    await flushAll();

    // First pass (pre-loadFile) already emptied the map…
    expect(browserHandlers.windowBrowserViews.size).toBe(0);

    // …so a SECOND pass must be a silent no-op (never fatal).
    expect(() => browserHandlers.cleanupWindowBrowserViews(mockWindow)).not.toThrow();
    expect(browserHandlers.windowBrowserViews.size).toBe(0);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('BrowserView teardown'));
  });

  it('[GREEN] after loadFile rejects, navigate-failed reaches the sender (current .catch behavior)', async () => {
    const deferred = makeDeferredLoadFile();
    bindWindow(makeMockWindow(deferred.loadFile));
    seedRealViews(mockWindow);

    systemHandlers.navigate(mockEvent, 'index.html');
    deferred.reject(new Error('ENOENT: index.html missing'));
    await flushAll();

    expect(mockEvent.sender.send).toHaveBeenCalledWith(
      'navigate-failed', 'index.html', 'ENOENT: index.html missing'
    );
  });

  it('[GREEN] race: ghost seeded DURING the loadFile flight is cleaned automatically after reject', async () => {
    const deferred = makeDeferredLoadFile();
    bindWindow(makeMockWindow(deferred.loadFile));
    seedRealViews(mockWindow);

    systemHandlers.navigate(mockEvent, 'index.html');
    await flush(); // first teardown ran; loadFile pending

    // THE RACE (bug chain step 2, post-Layer 2 seeding): Layer 2 turned
    // set-all-visibility into a pure lookup, closing the ghost factory —
    // so the ghost is now seeded DIRECTLY the way the old factory did it
    // under the hood: a get-or-create call mid-flight re-creates the pair
    // on the freshly-emptied map and re-attaches it over the page. This
    // proves that EVEN a seeded ghost survives only until the second pass.
    const ghostPair = browserHandlers.getOrCreateBrowserViews(mockWindow);
    mockWindow.addBrowserView(ghostPair.editorView);
    mockWindow.addBrowserView(ghostPair.viewerView);
    expect(browserHandlers.windowBrowserViews.size).toBe(1); // ghost entry exists
    const ghostViews = [ghostPair.editorView, ghostPair.viewerView];

    // loadFile settles → .catch runs → navigate-failed is sent…
    deferred.reject(new Error('net::ERR_FILE_NOT_FOUND'));
    await flushAll();
    expect(mockEvent.sender.send).toHaveBeenCalledWith(
      'navigate-failed', 'index.html', expect.any(String)
    );

    // …[Task 6] and a SECOND teardown pass must remove the race's ghosts:
    // map empty, ghosts detached (bounds collapsed) and their webContents
    // closed — GREEN post-fix: the second pass in loadFile's .catch
    // harvests the ghost, nothing survives after settle.
    expect(browserHandlers.windowBrowserViews.size).toBe(0);
    for (const ghost of ghostViews) {
      expect(ghost.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 });
      expect(ghost.webContents.close).toHaveBeenCalled();
    }
    expect(mockWindow.removeBrowserView).toHaveBeenCalledWith(ghostViews[0]);
    expect(mockWindow.removeBrowserView).toHaveBeenCalledWith(ghostViews[1]);
  });

  it('[GREEN] race: ghost seeded during the flight is cleaned automatically after SUCCESS too', async () => {
    let settleLoad;
    bindWindow(makeMockWindow(() => new Promise((resolve) => { settleLoad = resolve; })));
    seedRealViews(mockWindow);

    systemHandlers.navigate(mockEvent, 'index.html');
    await flush();

    const ghostPair = browserHandlers.getOrCreateBrowserViews(mockWindow);
    mockWindow.addBrowserView(ghostPair.editorView);
    mockWindow.addBrowserView(ghostPair.viewerView);
    expect(browserHandlers.windowBrowserViews.size).toBe(1);

    settleLoad();
    await flushAll();
    expect(mockEvent.sender.send).toHaveBeenCalledWith('navigate-complete', 'index.html');

    // [Task 6] the second pass must ALSO live in .then — a successful
    // loadFile leaves the same ghost behind otherwise.
    expect(browserHandlers.windowBrowserViews.size).toBe(0);
  });

  it('[GREEN] after the race is cleaned, setAllBrowserViewVisibility(true) is a no-op — never re-creates views', async () => {
    const deferred = makeDeferredLoadFile();
    bindWindow(makeMockWindow(deferred.loadFile));
    seedRealViews(mockWindow);

    systemHandlers.navigate(mockEvent, 'index.html');
    await flush();
    const ghostPair = browserHandlers.getOrCreateBrowserViews(mockWindow);
    mockWindow.addBrowserView(ghostPair.editorView);
    mockWindow.addBrowserView(ghostPair.viewerView);
    deferred.reject(new Error('boom'));
    await flushAll();

    // Simulate the post-fix steady state: whatever cleaned the ghosts left
    // an empty map (Task 6 automates this; manual call emulates it so this
    // test isolates the pure-lookup expectation, plano-B assert).
    browserHandlers.cleanupWindowBrowserViews(mockWindow);
    expect(browserHandlers.windowBrowserViews.size).toBe(0);
    const createdSoFar = BrowserViewCtor.mock.instances.length;

    // Post-navigation visibility flips (overlays on index.html, teardown
    // echoes…) must NOT resurrect views on the empty map — Layer 2 pure
    // lookup: no BrowserView constructed, map stays empty, nothing
    // attached. addBrowserView is cleared first so the seed attachments
    // above don't pollute the pure-lookup assertion.
    mockWindow.addBrowserView.mockClear();
    expect(() => browserHandlers.setAllBrowserViewVisibility(mockEvent, true)).not.toThrow();
    expect(BrowserViewCtor.mock.instances.length).toBe(createdSoFar);
    expect(browserHandlers.windowBrowserViews.size).toBe(0);
    expect(mockWindow.addBrowserView).not.toHaveBeenCalled();
  });
});
