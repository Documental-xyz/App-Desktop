/**
 * @fileoverview TDD RED phase — reproduces the "ghost BrowserViews" race of
 * the "Fechar Ambiente" flow (bug: views fantasma que engolem cliques).
 *
 * IPC ordering in the real app (verified in the planning session):
 *   1. User confirms "Fechar Ambiente"; the renderer sends `navigate`
 *      (sync IPC) and, in a LATER microtask, `set-all-browser-view-visibility(true)`.
 *   2. Main process `navigate` [system.js:408] tears the window views down
 *      (detach + webContents.close + `windowBrowserViews.delete(window)`
 *      [browser.js:441]) and calls `loadFile` (async, still pending).
 *   3. The late `setAllBrowserViewVisibility` [browser.js:246] arrives;
 *      `getBrowserViewsForEvent` [browser.js:88] → `getOrCreateBrowserViews`
 *      [browser.js:48] finds an EMPTY map and CREATES 2 brand-new
 *      BrowserViews, re-attaching them to the window (addBrowserView
 *      :252/:260) — ghost views stacked over index.html that swallow input.
 *
 * GREEN post-fix: these contracts lock the race dead. They document the
 * RED proof from the TDD phase — pre-fix, each assertion below failed
 * against the then-current production code; the Layer 2 fix (Task 4)
 * turned them GREEN without edits here.
 *
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Flusher: navigate() is sync but chains loadFile through a promise chain. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Every BrowserView instance created by the constructor spy in this test. */
let allViewInstances;
/** Index into allViewInstances marking the post-teardown boundary: anything
 *  created at or after this index is a GHOST (resurrected after cleanup). */
let ghostStartIndex;
let BrowserViewCtor;
let mockWindow;
let mockEvent;
let mockLogger;
let mockWindowManager;

/** Views created AFTER the teardown — i.e. ghosts. */
const ghostViews = () => allViewInstances.slice(ghostStartIndex);

/**
 * Spyable BrowserView constructor. Installed on the SHARED
 * global.mockElectron object (tests/__mocks__/electron.js wraps it by
 * reference) BEFORE importing src/ipc/browser.js, so its top-level
 * `const { BrowserView } = require('electron')` captures this spy.
 * `asConstructable` (electron-constructor.cjs) keeps `new` working while
 * recording calls on the vi.fn, so `expect(BrowserViewCtor)...` asserts work.
 */
function makeBrowserViewCtor() {
  return vi.fn(function BrowserViewMock(options) {
    this.options = options;
    this.setBounds = vi.fn();
    this.webContents = {
      loadURL: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => 'about:blank'),
      close: vi.fn(),
      goBack: vi.fn(),
      canGoBack: vi.fn(() => false),
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      clearHistory: vi.fn(),
      capturePage: vi.fn(async () => ({ toDataURL: () => '' })),
      session: { clearCache: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}) }
    };
    allViewInstances.push(this);
  });
}

function makeMockWindow() {
  return {
    id: 42,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    addBrowserView: vi.fn(),
    removeBrowserView: vi.fn(),
    getContentSize: vi.fn(() => [1400, 900]),
    setContentSize: vi.fn(),
    webContents: { send: vi.fn(), invalidate: vi.fn() },
    // The race window: loadFile never settles while the late visibility IPC
    // lands — navigate's .then() must not have run yet.
    loadFile: vi.fn(() => new Promise(() => {}))
  };
}

/**
 * Wire the shared electron mock IN PLACE (never reassign global.mockElectron —
 * tests/__mocks__/electron.js captured the object reference at require time).
 * Pattern: tests/ipc/navigate.test.js.
 */
function wireElectronMocks() {
  global.mockElectron.app = {
    getPath: vi.fn(),
    getVersion: vi.fn(),
    quit: vi.fn(),
    isPackaged: false,
    getAppPath: vi.fn(() => process.cwd())
  };
  const BrowserWindowCtor = vi.fn(() => {
    throw new Error('ghost-race tests must not create a new BrowserWindow');
  });
  BrowserWindowCtor.fromWebContents = vi.fn(() => mockWindow);
  BrowserWindowCtor.getAllWindows = vi.fn(() => [mockWindow]);
  global.mockElectron.BrowserWindow = BrowserWindowCtor;
  global.mockElectron.BrowserView = BrowserViewCtor;
  global.mockElectron.ipcMain = { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() };
}

/**
 * Reproduces the exact "Fechar Ambiente" IPC ordering through the REAL
 * SystemHandlers.navigate + BrowserHandlers teardown path:
 *
 *   (1) main.html alive: editor+viewer BrowserViews registered for the window
 *   (2) navigate('index.html') IPC (sync) — teardown runs synchronously
 *       inside navigate [system.js:436 → browser.js:393]; loadFile pending
 *   (3) returns the handlers so the test can fire the LATE microtask IPC
 *       (set-all-browser-view-visibility / bounds) against the dead views.
 */
async function runRaceThroughNavigate() {
  const { BrowserHandlers } = await import('../../src/ipc/browser.js');
  const { SystemHandlers } = await import('../../src/ipc/system.js');

  const browserHandlers = new BrowserHandlers({
    logger: mockLogger,
    windowManager: mockWindowManager
  });
  const systemHandlers = new SystemHandlers({
    logger: mockLogger,
    windowManager: mockWindowManager,
    browserHandlers
  });

  // (1) main.html is live: exactly one {editorView, viewerView} pair exists.
  const initial = browserHandlers.getOrCreateBrowserViews(mockWindow);
  expect(initial.editorView).toBeDefined();
  expect(initial.viewerView).toBeDefined();
  expect(BrowserViewCtor).toHaveBeenCalledTimes(2);
  expect(browserHandlers.windowBrowserViews.size).toBe(1);

  // (2) First IPC of the race: navigate. Teardown is synchronous; loadFile
  //     stays pending (never-resolving promise) exactly like the real bug.
  systemHandlers.navigate(mockEvent, 'index.html');
  expect(mockWindow.loadFile).toHaveBeenCalledTimes(1);
  expect(browserHandlers.windowBrowserViews.size).toBe(0); // map entry deleted
  expect(mockWindow.addBrowserView).not.toHaveBeenCalled(); // nothing attached yet

  // (3) Everything created/attached from here on is a GHOST.
  BrowserViewCtor.mockClear();
  mockWindow.addBrowserView.mockClear();
  ghostStartIndex = allViewInstances.length;

  return { browserHandlers, systemHandlers };
}

beforeEach(() => {
  vi.clearAllMocks();
  allViewInstances = [];
  ghostStartIndex = 0;
  BrowserViewCtor = makeBrowserViewCtor();
  mockWindow = makeMockWindow();
  mockEvent = { sender: { send: vi.fn() } };
  mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  mockWindowManager = {
    getMainWindow: vi.fn(() => mockWindow),
    getAllWindows: vi.fn(() => [mockWindow]),
    hasValidMainWindow: vi.fn(() => true)
  };
  wireElectronMocks();
});

afterEach(() => {
  // src/ipc/browser.js destructures BrowserView/BrowserWindow from
  // require('electron') at module load — force a fresh module graph per test
  // so each one captures the freshly wired mocks.
  vi.resetModules();
});

describe('AC1 — ghost race: set-all-browser-view-visibility(true) after navigate teardown', () => {
  it('must NOT recreate BrowserViews nor re-attach them to the window', async () => {
    const { browserHandlers } = await runRaceThroughNavigate();
    await flush(); // drain microtasks — the late IPC lands after navigate's scheduling

    // The late IPC from the dying renderer ("Fechar Ambiente" microtask #2):
    browserHandlers.setAllBrowserViewVisibility(mockEvent, true);

    // Guard: the late visibility IPC must stay a pure lookup — never
    // resurrect views via getBrowserViewsForEvent → getOrCreateBrowserViews
    // [browser.js:48] (pre-fix it created 2 ghosts here):
    expect(BrowserViewCtor).not.toHaveBeenCalled(); // guard: no BrowserView constructed after teardown
    expect(browserHandlers.windowBrowserViews.size).toBe(0); // guard: map stays empty
    expect(mockWindow.addBrowserView).not.toHaveBeenCalled(); // guard: nothing re-attached
  });
});

describe('AC2 — ghost race: setBrowserViewBounds/setBrowserViewVisibility on dead views', () => {
  it('must be a no-op: no view creation, no setBounds, no re-attachment', async () => {
    const { browserHandlers } = await runRaceThroughNavigate();
    await flush();

    // Late per-view IPCs. viewName 'view' maps to viewerView
    // (`viewName === 'editor' ? editorView : viewerView` [browser.js:183/:228]).
    browserHandlers.setBrowserViewBounds(mockEvent, 'view', { x: 0, y: 64, width: 800, height: 600 });
    browserHandlers.setBrowserViewVisibility(mockEvent, 'view', true);

    const ghosts = ghostViews();
    // Guard: dead views are never recreated nor mutated (pre-fix the
    // pair came back and the ghosts got mutated):
    expect(ghosts).toHaveLength(0); // guard: no views created after teardown
    for (const ghost of ghosts) {
      expect(ghost.setBounds).not.toHaveBeenCalled(); // guard: no bounds on ghosts (vacuous while empty — locks the fix)
    }
    expect(mockWindow.addBrowserView).not.toHaveBeenCalled(); // guard: nothing re-attached
    expect(browserHandlers.windowBrowserViews.size).toBe(0); // guard: map stays empty
  });
});

describe('AC5 — ghost race: main-window fallback (fromWebContents → null) must not resurrect views', () => {
  it('setAllBrowserViewVisibility with a dead sender must not create views via getMainWindow fallback', async () => {
    const { BrowserHandlers } = await import('../../src/ipc/browser.js');
    const browserHandlers = new BrowserHandlers({
      logger: mockLogger,
      windowManager: mockWindowManager
    });

    // Same starting state as the race: live editor views, then the navigate
    // teardown. cleanupWindowBrowserViews() is invoked DIRECTLY here because
    // it is exactly what SystemHandlers.navigate() runs synchronously
    // (system.js:436 → _teardownWindowBrowserViews → browser.js:393); with a
    // dead sender the navigate IPC itself would bail before teardown.
    browserHandlers.getOrCreateBrowserViews(mockWindow);
    browserHandlers.cleanupWindowBrowserViews(mockWindow);
    expect(browserHandlers.windowBrowserViews.size).toBe(0);

    // Sender's webContents is gone (window tearing down): fromWebContents →
    // null, but windowManager still reports the main window as alive.
    global.mockElectron.BrowserWindow.fromWebContents = vi.fn(() => null);
    mockWindowManager.getMainWindow.mockReturnValue(mockWindow);

    BrowserViewCtor.mockClear();
    mockWindow.addBrowserView.mockClear();
    ghostStartIndex = allViewInstances.length;

    browserHandlers.setAllBrowserViewVisibility(mockEvent, true);

    // Guard: the fallback path [browser.js:90-96] must stay a pure
    // lookup — never re-enter getOrCreateBrowserViews for a fresh ghost
    // pair (pre-fix it did):
    expect(BrowserViewCtor).not.toHaveBeenCalled(); // guard: no BrowserView constructed via fallback
    expect(browserHandlers.windowBrowserViews.size).toBe(0); // guard: map stays empty
    expect(mockWindow.addBrowserView).not.toHaveBeenCalled(); // guard: nothing attached via the fallback
  });
});
