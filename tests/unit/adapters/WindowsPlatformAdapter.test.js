/**
 * @vitest-environment node
 */

/**
 * Test suite for WindowsPlatformAdapter
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import { WindowsPlatformAdapter } from '../../../src/main/adapters/WindowsPlatformAdapter.js';

describe('WindowsPlatformAdapter', () => {
  let adapter;
  let originalProcess;
  let originalHomedir;

  beforeEach(() => {
    originalProcess = global.process;
    originalHomedir = os.homedir;
    global.process = {
      platform: 'win32',
      arch: 'x64',
      env: {
        PATH: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
        USERPROFILE: 'C:\\Users\\testuser',
        APPDATA: 'C:\\Users\\testuser\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\testuser\\AppData\\Local',
        TEMP: 'C:\\Users\\testuser\\AppData\\Local\\Temp'
      }
    };
    // os.homedir() reads from getpwuid on Unix, not process.env; mock it so
    // getHomeDirectory() reflects the test env regardless of host platform.
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\testuser');
    adapter = new WindowsPlatformAdapter();
  });

  afterEach(() => {
    global.process = originalProcess;
    os.homedir = originalHomedir;
    vi.restoreAllMocks();
  });

  describe('platform detection', () => {
    it('should return correct platform', () => {
      expect(adapter.getPlatform()).toBe('win32');
    });

    it('should return correct architecture', () => {
      expect(adapter.getArchitecture()).toBe('x64');
    });

    it('should identify as Windows', () => {
      expect(adapter.isWindows()).toBe(true);
      expect(adapter.isMacOS()).toBe(false);
      expect(adapter.isLinux()).toBe(false);
    });
  });

  describe('executable handling', () => {
    it('should map known tools to their Windows executables', async () => {
      expect(await adapter.getExecutableName('node')).toBe('node.exe');
      expect(await adapter.getExecutableName('npm')).toBe('npm.cmd');
      expect(await adapter.getExecutableName('git')).toBe('git.exe');
    });

    it('should append .exe to unknown executables', async () => {
      expect(await adapter.getExecutableName('custom-tool')).toBe('custom-tool.exe');
    });
  });

  describe('path operations', () => {
    it('should return the Windows file separator', () => {
      expect(adapter.getFileSeparator()).toBe('\\');
    });

    it('should return the Windows PATH separator', () => {
      expect(adapter.getPathSeparator()).toBe(';');
    });

    it('should return temp directory from env', () => {
      expect(adapter.getTempDirectory()).toBe('C:\\Users\\testuser\\AppData\\Local\\Temp');
    });

    it('should return home directory', () => {
      expect(adapter.getHomeDirectory()).toBe('C:\\Users\\testuser');
    });
  });

  describe('environment config', () => {
    it('should return environment configuration', async () => {
      const config = await adapter.getEnvironmentConfig();
      expect(config.PATH).toBe('C:\\Windows\\system32;C:\\Program Files\\nodejs');
      expect(config.APPDATA).toBe('C:\\Users\\testuser\\AppData\\Roaming');
      expect(config.LOCALAPPDATA).toBe('C:\\Users\\testuser\\AppData\\Local');
    });
  });

  describe('shell commands', () => {
    it('should return Windows-specific shell command equivalents', async () => {
      expect(await adapter.getShellCommand('which')).toBe('where');
      expect(await adapter.getShellCommand('ls')).toBe('dir');
      expect(await adapter.getShellCommand('clear')).toBe('cls');
      expect(await adapter.getShellCommand('ps')).toBe('tasklist');
      expect(await adapter.getShellCommand('kill')).toBe('taskkill');
    });

    it('should return the command unchanged when no mapping exists', async () => {
      expect(await adapter.getShellCommand('unknown')).toBe('unknown');
    });
  });
});