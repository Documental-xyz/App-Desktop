/**
 * @fileoverview F3 fix (plan: ajustes-wizard-preview-servicos) — main-world
 * postSave registrar for the editor BrowserView.
 *
 * The editor view runs with contextIsolation: true, so the preload's
 * isolated world never sees the page's window.CMS. The fix injects
 * buildPostSaveRegistrarScript() via webContents.executeJavaScript (MAIN
 * world); the registrar relays new-page saves through window.sveltiaEvents
 * (contextBridge exposed by the preload) → cms:content-saved.
 *
 * Part 1 executes the EXACT script source against a fake window (Map fake
 * for the Immutable entry, controllable setTimeout for the retry loop).
 * Part 2 asserts the injection wiring on did-finish-load / in-page
 * navigation of the editor view (never the viewer).
 *
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { buildPostSaveRegistrarScript } = await import('../../src/ipc/browser.js');

/** Run the registrar source against a fake main world. */
function runRegistrar(window) {
  new Function('window', buildPostSaveRegistrarScript())(window);
}

function makeFakeWindow({ cms = null, bridge = null } = {}) {
  const registrations = [];
  const fake = {
    __sveltiaPostSaveRegistered: undefined,
    CMS: cms === null ? undefined : cms,
    sveltiaEvents: bridge,
    registrations
  };
  if (cms) {
    fake.CMS = {
      registerEventListener: (config) => registrations.push(config)
    };
  }
  return fake;
}

describe('buildPostSaveRegistrarScript — handler logic (main world)', () => {
  let bridge;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Immutable Map entry with newRecord: true relays slug via sveltiaEvents', () => {
    const window = makeFakeWindow({ cms: {}, bridge: { contentSaved: bridge } });
    runRegistrar(window);

    expect(window.__sveltiaPostSaveRegistered).toBe(true);
    expect(window.registrations).toHaveLength(1);
    expect(window.registrations[0].name).toBe('postSave');

    window.registrations[0].handler({
      entry: new Map([['slug', 'pagina-nova'], ['newRecord', true]])
    });

    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledWith('pagina-nova', true);
  });

  it('isNew key (Decap alias) and plain-object entries are also accepted', () => {
    const window = makeFakeWindow({ cms: {}, bridge: { contentSaved: bridge } });
    runRegistrar(window);
    const handler = window.registrations[0].handler;

    handler({ entry: new Map([['slug', 'via-isnew'], ['isNew', true]]) });
    handler({ entry: { slug: 'via-objeto', isNew: true } });
    handler({ entry: { slug: 'via-objeto-newrecord', newRecord: true } });

    expect(bridge).toHaveBeenCalledTimes(3);
    expect(bridge).toHaveBeenNthCalledWith(1, 'via-isnew', true);
    expect(bridge).toHaveBeenNthCalledWith(2, 'via-objeto', true);
    expect(bridge).toHaveBeenNthCalledWith(3, 'via-objeto-newrecord', true);
  });

  it('slug is trimmed before relaying', () => {
    const window = makeFakeWindow({ cms: {}, bridge: { contentSaved: bridge } });
    runRegistrar(window);

    window.registrations[0].handler({
      entry: new Map([['slug', '  com-espacos  '], ['newRecord', true]])
    });

    expect(bridge).toHaveBeenCalledWith('com-espacos', true);
  });

  it('existing page (newRecord false) and missing slug never call the bridge', () => {
    const window = makeFakeWindow({ cms: {}, bridge: { contentSaved: bridge } });
    runRegistrar(window);
    const handler = window.registrations[0].handler;

    handler({ entry: new Map([['slug', 'existente'], ['newRecord', false]]) });
    handler({ entry: new Map([['newRecord', true]]) });

    expect(bridge).not.toHaveBeenCalled();
  });

  it('missing sveltiaEvents bridge (page without our preload) is a no-op, no throw', () => {
    const window = makeFakeWindow({ cms: {}, bridge: null });
    runRegistrar(window);

    expect(() =>
      window.registrations[0].handler({
        entry: new Map([['slug', 'sem-bridge'], ['newRecord', true]])
      })
    ).not.toThrow();
  });

  it('idempotent: running the script twice registers exactly once', () => {
    const window = makeFakeWindow({ cms: {}, bridge: { contentSaved: bridge } });
    runRegistrar(window);
    runRegistrar(window);

    expect(window.registrations).toHaveLength(1);
  });

  it('retries until window.CMS appears, then gives up after 20 attempts', () => {
    const lateWindow = makeFakeWindow({ bridge: { contentSaved: bridge } });
    runRegistrar(lateWindow);
    expect(lateWindow.registrations).toHaveLength(0);

    // Sveltia boots on the 3rd attempt.
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(500);
    lateWindow.CMS = { registerEventListener: (config) => lateWindow.registrations.push(config) };
    vi.advanceTimersByTime(500);
    expect(lateWindow.registrations).toHaveLength(1);
    expect(lateWindow.__sveltiaPostSaveRegistered).toBe(true);

    // No CMS ever shows up: exactly 20 attempts, no infinite loop.
    const absentWindow = makeFakeWindow({ bridge: { contentSaved: bridge } });
    runRegistrar(absentWindow);
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(500);
    }
    expect(absentWindow.registrations).toHaveLength(0);
    expect(absentWindow.__sveltiaPostSaveRegistered).toBeUndefined();
  });
});

describe('editor view injection wiring (executeJavaScript)', () => {
  let mockWindow;
  let BrowserViewCtor;
  let handlers;

  function makeViewWebContents() {
    return {
      loadURL: vi.fn(),
      getURL: vi.fn(() => 'http://dev.local/admin/'),
      once: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      executeJavaScript: vi.fn(() => Promise.resolve(true)),
      isDestroyed: vi.fn(() => false)
    };
  }

  function fireOnce(webContents, eventName, ...args) {
    const call = webContents.once.mock.calls.find(([ev]) => ev === eventName);
    expect(call).toBeDefined();
    call[1](...args);
  }

  function fireOn(webContents, eventName, ...args) {
    const call = webContents.on.mock.calls.find(([ev]) => ev === eventName);
    expect(call).toBeDefined();
    call[1](...args);
  }

  beforeEach(async () => {
    // browser.js destructures electron at require time; the top-level import
    // above captured the default mocks, so re-import after a module reset.
    vi.clearAllMocks();
    vi.resetModules();
    mockWindow = {
      id: 7,
      on: vi.fn(),
      addBrowserView: vi.fn(),
      removeBrowserView: vi.fn(),
      getContentSize: vi.fn(() => [1400, 900]),
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() }
    };

    BrowserViewCtor = vi.fn(() => ({
      webContents: makeViewWebContents(),
      setBounds: vi.fn()
    }));
    const BrowserWindowCtor = vi.fn();
    BrowserWindowCtor.fromWebContents = vi.fn(() => mockWindow);
    BrowserWindowCtor.getAllWindows = vi.fn(() => []);

    global.mockElectron.BrowserView = BrowserViewCtor;
    global.mockElectron.BrowserWindow = BrowserWindowCtor;
    global.mockElectron.ipcMain = {
      handle: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn()
    };
    global.mockElectron.net = { fetch: vi.fn() };

    const { BrowserHandlers } = await import('../../src/ipc/browser.js');
    handlers = new BrowserHandlers({
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      windowManager: { getMainWindow: vi.fn(), getAllWindows: vi.fn(() => []) },
      processManager: { getGlobalDevServerUrl: vi.fn(() => 'http://dev.local/') }
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  function viewsOf() {
    const views = handlers.windowBrowserViews.get(mockWindow);
    expect(views).toBeTypeOf('object');
    return views;
  }

  it('did-finish-load of the EDITOR injects the registrar script exactly as built', () => {
    const event = { sender: { id: 'sender-1' } };
    handlers.loadBrowserViewUrl(event, 'editor', 'http://dev.local/admin/');

    fireOnce(viewsOf().editorView.webContents, 'did-finish-load');

    expect(viewsOf().editorView.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(viewsOf().editorView.webContents.executeJavaScript).toHaveBeenCalledWith(
      buildPostSaveRegistrarScript()
    );
  });

  it('main-frame in-page navigation re-injects (flag makes it idempotent); sub-frames do not', () => {
    const event = { sender: { id: 'sender-1' } };
    handlers.loadBrowserViewUrl(event, 'editor', 'http://dev.local/admin/');
    const editor = viewsOf().editorView.webContents;

    fireOn(editor, 'did-navigate-in-page', { sender: null }, 'http://dev.local/admin/#/x', true);
    expect(editor.executeJavaScript).toHaveBeenCalledTimes(1);

    fireOn(editor, 'did-navigate-in-page', { sender: null }, 'http://dev.local/admin/#/y', false);
    expect(editor.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it('the VIEWER view is never injected', () => {
    const event = { sender: { id: 'sender-1' } };
    handlers.loadBrowserViewUrl(event, 'viewer', 'http://dev.local/preview/');

    fireOnce(viewsOf().viewerView.webContents, 'did-finish-load');

    expect(viewsOf().viewerView.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('executeJavaScript rejection is swallowed (page without preload/tearing down)', async () => {
    const event = { sender: { id: 'sender-1' } };
    handlers.loadBrowserViewUrl(event, 'editor', 'http://dev.local/admin/');
    const editor = viewsOf().editorView.webContents;
    editor.executeJavaScript = vi.fn(() => Promise.reject(new Error('webContents gone')));

    fireOnce(editor, 'did-finish-load');
    await new Promise((resolve) => setImmediate(resolve));

    expect(handlers.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('postSave registrar injection skipped')
    );
  });

  it('destroyed editor webContents: no injection, no throw', () => {
    const event = { sender: { id: 'sender-1' } };
    handlers.loadBrowserViewUrl(event, 'editor', 'http://dev.local/admin/');
    const editor = viewsOf().editorView.webContents;
    editor.isDestroyed = vi.fn(() => true);

    expect(() => fireOnce(editor, 'did-finish-load')).not.toThrow();
    expect(editor.executeJavaScript).not.toHaveBeenCalled();
  });
});
