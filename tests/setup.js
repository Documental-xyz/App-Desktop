// Test setup file for Vitest
// This file runs before each test file

import { vi } from 'vitest';

// Create mutable dialog mock that tests can control
global.dialogMockImpl = vi.fn();

const BrowserWindowMock = vi.fn(() => ({
  webContents: { send: vi.fn(), on: vi.fn(), insertCSS: vi.fn(), executeJavaScript: vi.fn() },
  isDestroyed: vi.fn(() => false),
  show: vi.fn(),
  maximize: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  getBounds: vi.fn(() => ({ width: 1400, height: 900, x: 0, y: 0 })),
  loadFile: vi.fn(async () => {})
}));
BrowserWindowMock.getAllWindows = vi.fn(() => []);
BrowserWindowMock.getFocusedWindow = vi.fn();
BrowserWindowMock.fromWebContents = vi.fn();

// Mock Electron APIs
global.mockElectron = {
  app: {
    getPath: vi.fn(),
    getVersion: vi.fn(),
    quit: vi.fn(),
    isPackaged: false,
    getAppPath: vi.fn()
  },
  BrowserWindow: BrowserWindowMock,
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn()
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    send: vi.fn()
  },
  contextBridge: {
    exposeInMainWorld: vi.fn()
  },
  safeStorage: {
    encryptString: vi.fn(() => Buffer.from('encrypted')),
    decryptString: vi.fn(() => ''),
    isEncryptionAvailable: vi.fn(() => true)
  },
  dialog: {
    showOpenDialog: vi.fn((...args) => global.dialogMockImpl(...args)),
    showSaveDialog: vi.fn()
  }
};

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn()
  }
}));

vi.mock('path', () => ({
  join: vi.fn((...args) => args.join('/')),
  resolve: vi.fn((...args) => args.join('/')),
  dirname: vi.fn(),
  basename: vi.fn()
}));

vi.mock('sqlite3', () => ({
  verbose: vi.fn(() => ({
    Database: vi.fn()
  }))
}));

// Global test utilities
global.createMockWindow = () => ({
  webContents: {
    send: vi.fn()
  },
  isDestroyed: vi.fn(() => false)
});

global.createMockProcess = () => ({
  kill: vi.fn(),
  on: vi.fn(),
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() }
});