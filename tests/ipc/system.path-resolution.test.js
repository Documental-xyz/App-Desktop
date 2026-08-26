/**
 * @fileoverview Tests for path resolution in SystemHandlers (Windows packaged app fix)
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// src/ipc/system.js resolves paths with the NATIVE path module via CJS
// require (vi.mock in setup.js cannot intercept it — same pattern as the
// i18n/git suites): expectations must be built with the native path too.
vi.unmock('path');

import path from 'path';

/** Normalize to POSIX separators for substring checks on mixed literals. */
const toPosix = (p) => p.split(path.sep).join('/');

/** Platform-native stand-in for the packaged app root mock. */
const MOCK_APP_PATH = path.join(path.sep, 'mock', 'app', 'path');

/** Platform-native stand-in for the dev-mode cwd. */
const DEV_CWD = path.join(path.sep, 'dev', 'project');

// Store original cwd
let originalCwd;

describe('SystemHandlers Path Resolution Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    originalCwd = process.cwd;
    
    // Ensure global.mockElectron exists (set by setup.js)
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
        }
      };
    }
  });

  afterEach(() => {
    process.cwd = originalCwd;
    vi.resetModules();
  });

  describe('createNewWindowWithState path resolution', () => {
    it('should use app.getAppPath() when app is packaged', async () => {
      // Setup mocks for packaged environment
      const mockLoadFile = vi.fn().mockResolvedValue(undefined);
      const mockShow = vi.fn();
      const mockMaximize = vi.fn();
      const mockWindow = {
        id: 123,
        loadFile: mockLoadFile,
        show: mockShow,
        maximize: mockMaximize,
        on: vi.fn()
      };
      
      global.mockElectron.app.isPackaged = true;
      global.mockElectron.app.getAppPath.mockReturnValue(MOCK_APP_PATH);
      global.mockElectron.BrowserWindow = vi.fn(() => mockWindow);
      global.mockElectron.BrowserWindow.getFocusedWindow = vi.fn(() => ({
        getBounds: vi.fn(() => ({ width: 1400, height: 900 }))
      }));
      
      const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const mockWindowManager = { hasValidMainWindow: vi.fn().mockReturnValue(true), getMainWindow: vi.fn() };
      
      // Re-import to get fresh module with new mocks
      const { SystemHandlers } = await import('../../src/ipc/system.js');
      const handlers = new SystemHandlers({ logger: mockLogger, windowManager: mockWindowManager });
      
      await handlers.createNewWindowWithState({ projectId: '123' });
      
      expect(global.mockElectron.app.getAppPath).toHaveBeenCalled();
      expect(mockLoadFile).toHaveBeenCalled();
      
      const filePath = mockLoadFile.mock.calls[0][0];
      expect(toPosix(filePath)).toContain('mock/app/path');
      expect(filePath).toContain('renderer');
      expect(filePath).toContain('main.html');
    });

    it('should use process.cwd() when app is in development mode', async () => {
      // Setup mocks for development environment
      const mockLoadFile = vi.fn().mockResolvedValue(undefined);
      const mockWindow = {
        id: 123,
        loadFile: mockLoadFile,
        show: vi.fn(),
        maximize: vi.fn(),
        on: vi.fn()
      };
      
      global.mockElectron.app.isPackaged = false;
      process.cwd = vi.fn(() => DEV_CWD);
      global.mockElectron.BrowserWindow = vi.fn(() => mockWindow);
      global.mockElectron.BrowserWindow.getFocusedWindow = vi.fn(() => ({
        getBounds: vi.fn(() => ({ width: 1400, height: 900 }))
      }));
      
      const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const mockWindowManager = { hasValidMainWindow: vi.fn().mockReturnValue(true), getMainWindow: vi.fn() };
      
      const { SystemHandlers } = await import('../../src/ipc/system.js');
      const handlers = new SystemHandlers({ logger: mockLogger, windowManager: mockWindowManager });
      
      await handlers.createNewWindowWithState({ projectId: '123' });
      
      expect(global.mockElectron.app.getAppPath).not.toHaveBeenCalled();
      expect(mockLoadFile).toHaveBeenCalled();
      
      const filePath = mockLoadFile.mock.calls[0][0];
      expect(toPosix(filePath)).toContain('dev/project');
      expect(filePath).toContain('renderer');
      expect(filePath).toContain('main.html');
    });

    it('should preserve query parameters in packaged mode', async () => {
      const mockLoadFile = vi.fn().mockResolvedValue(undefined);
      const mockWindow = {
        id: 123,
        loadFile: mockLoadFile,
        show: vi.fn(),
        maximize: vi.fn(),
        on: vi.fn()
      };
      
      global.mockElectron.app.isPackaged = true;
      global.mockElectron.app.getAppPath.mockReturnValue(MOCK_APP_PATH);
      global.mockElectron.BrowserWindow = vi.fn(() => mockWindow);
      global.mockElectron.BrowserWindow.getFocusedWindow = vi.fn(() => ({
        getBounds: vi.fn(() => ({ width: 1400, height: 900 }))
      }));
      
      const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const mockWindowManager = { hasValidMainWindow: vi.fn().mockReturnValue(true), getMainWindow: vi.fn() };
      
      const { SystemHandlers } = await import('../../src/ipc/system.js');
      const handlers = new SystemHandlers({ logger: mockLogger, windowManager: mockWindowManager });
      
      const windowState = { projectId: '123', someData: 'test' };
      await handlers.createNewWindowWithState(windowState);
      
      const options = mockLoadFile.mock.calls[0][1];
      expect(options.query.isSecondary).toBe('true');
      expect(options.query.state).toBeDefined();
      
      const decodedState = JSON.parse(Buffer.from(options.query.state, 'base64').toString());
      expect(decodedState.projectId).toBe('123');
      expect(decodedState.someData).toBe('test');
    });
  });

  describe('closeAndReopenToIndex path resolution', () => {
    it('should use app.getAppPath() when app is packaged', async () => {
      const mockLoadFile = vi.fn().mockResolvedValue(undefined);
      const mockClose = vi.fn();
      const mockWindow = {
        id: 123,
        isDestroyed: vi.fn(() => false),
        getBounds: vi.fn(() => ({ width: 1400, height: 900, x: 100, y: 100 })),
        close: mockClose
      };
      const newMockWindow = {
        id: 456,
        loadFile: mockLoadFile,
        show: vi.fn()
      };
      
      global.mockElectron.app.isPackaged = true;
      global.mockElectron.app.getAppPath.mockReturnValue(MOCK_APP_PATH);
      global.mockElectron.BrowserWindow = vi.fn(() => newMockWindow);
      global.mockElectron.BrowserWindow.fromWebContents = vi.fn(() => mockWindow);
      global.mockElectron.BrowserWindow.getAllWindows = vi.fn(() => []);
      
      const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const mockWindowManager = { hasValidMainWindow: vi.fn().mockReturnValue(true), getMainWindow: vi.fn() };
      
      const { SystemHandlers } = await import('../../src/ipc/system.js');
      const handlers = new SystemHandlers({ logger: mockLogger, windowManager: mockWindowManager });
      
      const mockEvent = { sender: { send: vi.fn() } };
      await handlers.closeAndReopenToIndex(mockEvent);
      
      expect(global.mockElectron.app.getAppPath).toHaveBeenCalled();
      expect(mockLoadFile).toHaveBeenCalled();
      
      const filePath = mockLoadFile.mock.calls[0][0];
      expect(toPosix(filePath)).toContain('mock/app/path');
      expect(filePath).toContain('renderer');
      expect(filePath).toContain('index.html');
    });

    it('should use process.cwd() when app is in development mode', async () => {
      const mockLoadFile = vi.fn().mockResolvedValue(undefined);
      const mockWindow = {
        id: 123,
        isDestroyed: vi.fn(() => false),
        getBounds: vi.fn(() => ({ width: 1400, height: 900, x: 100, y: 100 })),
        close: vi.fn()
      };
      const newMockWindow = {
        id: 456,
        loadFile: mockLoadFile,
        show: vi.fn()
      };
      
      global.mockElectron.app.isPackaged = false;
      process.cwd = vi.fn(() => DEV_CWD);
      global.mockElectron.BrowserWindow = vi.fn(() => newMockWindow);
      global.mockElectron.BrowserWindow.fromWebContents = vi.fn(() => mockWindow);
      
      const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const mockWindowManager = { hasValidMainWindow: vi.fn().mockReturnValue(true), getMainWindow: vi.fn() };
      
      const { SystemHandlers } = await import('../../src/ipc/system.js');
      const handlers = new SystemHandlers({ logger: mockLogger, windowManager: mockWindowManager });
      
      const mockEvent = { sender: { send: vi.fn() } };
      await handlers.closeAndReopenToIndex(mockEvent);
      
      expect(global.mockElectron.app.getAppPath).not.toHaveBeenCalled();
      expect(mockLoadFile).toHaveBeenCalled();
      
      const filePath = mockLoadFile.mock.calls[0][0];
      expect(toPosix(filePath)).toContain('dev/project');
      expect(filePath).toContain('renderer');
      expect(filePath).toContain('index.html');
    });
  });
});
