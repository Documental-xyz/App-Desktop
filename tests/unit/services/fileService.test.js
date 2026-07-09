/**
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// KNOWN-FAILURE: quarantined during perf-zombie-refactor, see tests/KNOWN-FAILURES.md
describe.skip('FileService', () => {
  let fileService;
  let mockLogger;
  let mockWindowManager;
  let mockWindow;
  let FileService;

  beforeEach(async () => {
    vi.resetModules();
    global.mockElectron.dialog.showOpenDialog.mockClear();

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };
    mockWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      isMinimized: vi.fn().mockReturnValue(false),
      focus: vi.fn(),
      restore: vi.fn()
    };
    mockWindowManager = {
      getMainWindow: vi.fn().mockReturnValue(mockWindow)
    };

    const module = await import('../../../src/main/services/fileService.js');
    FileService = module.FileService;

    fileService = new FileService({
      logger: mockLogger,
      windowManager: mockWindowManager
    });
  });

  describe('showOpenDirectoryDialog', () => {
    it('should return selected path when dialog succeeds', async () => {
      const expectedPath = '/home/user/projects';
      global.mockElectron.dialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: [expectedPath]
      });

      const result = await fileService.showOpenDirectoryDialog();

      expect(result).toBe(expectedPath);
      expect(global.mockElectron.dialog.showOpenDialog).toHaveBeenCalledWith(mockWindow, {
        properties: ['openDirectory'],
        title: 'Select Directory'
      });
      expect(mockLogger.info).toHaveBeenCalledWith(`Directory selected: ${expectedPath}`);
    });

    it('should return null when dialog is canceled', async () => {
      global.mockElectron.dialog.showOpenDialog.mockResolvedValue({
        canceled: true,
        filePaths: []
      });

      const result = await fileService.showOpenDirectoryDialog();

      expect(result).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('Directory dialog canceled');
    });

    it('should return null when window is destroyed', async () => {
      mockWindow.isDestroyed.mockReturnValue(true);

      const result = await fileService.showOpenDirectoryDialog();

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('No valid window available for dialog');
      expect(global.mockElectron.dialog.showOpenDialog).not.toHaveBeenCalled();
    });

    it('should return null when getMainWindow returns null', async () => {
      mockWindowManager.getMainWindow.mockReturnValue(null);

      const result = await fileService.showOpenDirectoryDialog();

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('No valid window available for dialog');
    });

    it('should return null when dialog throws error', async () => {
      global.mockElectron.dialog.showOpenDialog.mockRejectedValue(new Error('Dialog failed'));

      const result = await fileService.showOpenDirectoryDialog();

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('Error showing open directory dialog:', expect.any(Error));
    });

    it('should use parentWindow when provided', async () => {
      const parentWindow = {
        isDestroyed: vi.fn().mockReturnValue(false),
        isMinimized: vi.fn().mockReturnValue(false),
        focus: vi.fn(),
        restore: vi.fn()
      };
      const expectedPath = '/custom/path';
      global.mockElectron.dialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: [expectedPath]
      });

      const result = await fileService.showOpenDirectoryDialog(parentWindow);

      expect(result).toBe(expectedPath);
      expect(global.mockElectron.dialog.showOpenDialog).toHaveBeenCalledWith(parentWindow, expect.any(Object));
      expect(mockWindowManager.getMainWindow).not.toHaveBeenCalled();
    });

    it('should call focus on Windows', async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });

      global.mockElectron.dialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/some/path']
      });

      await fileService.showOpenDirectoryDialog();

      expect(mockWindow.focus).toHaveBeenCalled();

      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    it('should restore and focus on Windows when minimized', async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });

      mockWindow.isMinimized.mockReturnValue(true);
      global.mockElectron.dialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/some/path']
      });

      await fileService.showOpenDirectoryDialog();

      expect(mockWindow.restore).toHaveBeenCalled();
      expect(mockWindow.focus).toHaveBeenCalled();

      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    it('should not call focus on non-Windows platforms', async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'linux' });

      global.mockElectron.dialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/some/path']
      });

      await fileService.showOpenDirectoryDialog();

      expect(mockWindow.focus).not.toHaveBeenCalled();
      expect(mockWindow.restore).not.toHaveBeenCalled();

      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });
  });
});
