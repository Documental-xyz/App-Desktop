/**
 * Shared CJS electron stub aliased in via `resolve.alias` in vitest.config.mjs.
 *
 * Why: `vi.mock('electron')` does not intercept the synchronous CJS
 * `require('electron')` used inside src/ modules under vitest 4. The alias
 * (for vite-processed imports) plus the native-require bridge setup file
 * (tests/__mocks__/electron-native-resolve.cjs) make those requires resolve
 * here.
 *
 * Design:
 *  1. vi.mock('electron', factory) in a test file still takes precedence —
 *     the native-require bridge resolves vitest's registered factory first.
 *  2. For files WITHOUT a vi.mock factory, we pass through to
 *     `global.mockElectron` (created in tests/setup.js and mutated per-test,
 *     e.g. tests/ipc/system.path-resolution.test.js) so their assertions on
 *     the shared mock object keep working.
 *  3. A Proxy fills in any keys missing from global.mockElectron (e.g.
 *     nativeTheme, shell) with safe no-op defaults, so destructuring at
 *     module top-level never crashes, and wraps non-constructable vi.fn
 *     mocks so `new BrowserWindow(...)` works (see electron-constructor.cjs).
 */

'use strict';

const os = require('os');
const path = require('path');
const { asConstructable } = require('./electron-constructor.cjs');

function noop() {
  return undefined;
}

class BrowserWindowStub {
  constructor() {
    this.id = 0;
    this.webContents = {
      send: noop,
      on: noop,
      insertCSS: noop,
      executeJavaScript: noop
    };
    this.loadFile = noop;
    this.loadURL = noop;
    this.on = noop;
    this.once = noop;
    this.show = noop;
    this.maximize = noop;
    this.close = noop;
    this.destroy = noop;
    this.isDestroyed = () => false;
    this.getBounds = () => ({ width: 1400, height: 900, x: 0, y: 0 });
  }
}
BrowserWindowStub.getAllWindows = () => [];
BrowserWindowStub.getFocusedWindow = () => undefined;
BrowserWindowStub.fromWebContents = () => undefined;

const fallback = {
  app: {
    getPath: (name) => path.join(os.tmpdir(), 'electron-stub', String(name || 'userData')),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    quit: noop,
    on: noop,
    setName: noop,
    setAppUserModelId: noop,
    setAsDefaultProtocolClient: noop,
    removeAsDefaultProtocolClient: noop
  },
  BrowserWindow: BrowserWindowStub,
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from('encrypted-stub'),
    decryptString: () => Buffer.from('')
  },
  ipcMain: {
    handle: noop,
    on: noop,
    once: noop,
    removeHandler: noop,
    removeAllListeners: noop
  },
  ipcRenderer: {
    invoke: () => Promise.resolve(undefined),
    on: noop,
    once: noop,
    send: noop,
    removeAllListeners: noop
  },
  contextBridge: { exposeInMainWorld: noop },
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: true, filePath: undefined }),
    showErrorBox: noop,
    showMessageBox: () => Promise.resolve({ response: 0 })
  },
  shell: {
    openExternal: () => Promise.resolve(),
    openPath: () => Promise.resolve(''),
    showItemInFolder: noop,
    trashItem: () => Promise.resolve()
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    on: noop,
    themeSource: 'system'
  },
  nativeImage: { createFromPath: () => ({ toDataURL: () => '' }), createEmpty: () => ({}) },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  },
  Menu: { buildFromTemplate: () => ({ popup: noop }), setApplicationMenu: noop },
  clipboard: { readText: () => '', writeText: noop },
  net: { online: true },
  session: { defaultSession: {} }
};

// Mirrors the historical Electron dev behavior the path-resolution tests
// exercise: in a packaged app `app.getAppPath()` points into the asar, while
// in development the app root is the working directory. When the test marks
// the app as NOT packaged, `getAppPath` must not touch the test's mock
// (dev-mode assertions require it to stay uncalled) and return the (possibly
// monkey-patched) `process.cwd()` instead.
const appShimCache = new WeakMap();

function makeAppShim(app) {
  let shim = appShimCache.get(app);
  if (shim) return shim;
  shim = new Proxy(app, {
    get(t, prop, receiver) {
      if (prop === 'getAppPath') {
        return function getAppPath() {
          if (t.isPackaged === true) return t.getAppPath();
          return process.cwd();
        };
      }
      const value = t[prop];
      return typeof value === 'function' ? value.bind(t) : value;
    },
    has(t, prop) {
      return prop in t;
    }
  });
  appShimCache.set(app, shim);
  return shim;
}

function makeExport(target) {
  if (!target) return fallback;
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'app' && t.app) return makeAppShim(t.app);
      if (prop in t) return asConstructable(t[prop]);
      if (prop in fallback) return fallback[prop];
      return undefined;
    },
    has(t, prop) {
      return prop in t || prop in fallback;
    }
  });
}

module.exports = makeExport(global.mockElectron);
