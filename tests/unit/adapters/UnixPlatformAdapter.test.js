/**
 * @vitest-environment node
 */

/**
 * Test suite for UnixPlatformAdapter
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import { UnixPlatformAdapter } from '../../../src/main/adapters/UnixPlatformAdapter.js';

describe('UnixPlatformAdapter', () => {
  let adapter;
  let originalProcess;
  let originalHomedir;

  beforeEach(() => {
    originalProcess = global.process;
    originalHomedir = os.homedir;
    global.process = {
      platform: 'linux',
      arch: 'x64',
      env: {
        PATH: '/usr/bin:/bin:/usr/local/bin',
        HOME: '/home/testuser',
        TMPDIR: '/tmp'
      }
    };
    // os.homedir() reads from getpwuid, not process.env — mock it so the
    // adapter's getHomeDirectory()/getAppDataDirectory() reflect the test env.
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    adapter = new UnixPlatformAdapter();
  });

  afterEach(() => {
    global.process = originalProcess;
    os.homedir = originalHomedir;
    vi.restoreAllMocks();
  });

  describe('platform detection', () => {
    it('should return correct platform', () => {
      expect(adapter.getPlatform()).toBe('linux');
    });

    it('should return correct architecture', () => {
      expect(adapter.getArchitecture()).toBe('x64');
    });

    it('should identify as Linux', () => {
      expect(adapter.isWindows()).toBe(false);
      expect(adapter.isMacOS()).toBe(false);
      expect(adapter.isLinux()).toBe(true);
    });

    it('should identify as macOS when platform is darwin', () => {
      global.process.platform = 'darwin';
      const macAdapter = new UnixPlatformAdapter();
      
      expect(macAdapter.isWindows()).toBe(false);
      expect(macAdapter.isMacOS()).toBe(true);
      expect(macAdapter.isLinux()).toBe(false);
    });
  });

  describe('executable handling', () => {
    it('should return known aliases unmapped', async () => {
      expect(await adapter.getExecutableName('node')).toBe('node');
      expect(await adapter.getExecutableName('npm')).toBe('npm');
      expect(await adapter.getExecutableName('python')).toBe('python3');
    });

    it('should return the base name unchanged when no alias exists', async () => {
      expect(await adapter.getExecutableName('custom-tool')).toBe('custom-tool');
    });
  });

  describe('path operations', () => {
    it('should return the Unix file separator', () => {
      expect(adapter.getFileSeparator()).toBe('/');
    });

    it('should return the Unix PATH separator', () => {
      expect(adapter.getPathSeparator()).toBe(':');
    });

    it('should return temp directory', () => {
      expect(adapter.getTempDirectory()).toBe('/tmp');
    });

    it('should return home directory', () => {
      expect(adapter.getHomeDirectory()).toBe('/home/testuser');
    });
  });

  describe('environment config', () => {
    it('should return environment configuration', async () => {
      const config = await adapter.getEnvironmentConfig();
      expect(config.PATH).toBe('/usr/bin:/bin:/usr/local/bin');
      expect(config.HOME).toBe('/home/testuser');
    });
  });

  describe('shell commands', () => {
    it('should return Unix-specific shell command equivalents', async () => {
      expect(await adapter.getShellCommand('where')).toBe('which');
      expect(await adapter.getShellCommand('dir')).toBe('ls');
      expect(await adapter.getShellCommand('cls')).toBe('clear');
      expect(await adapter.getShellCommand('tasklist')).toBe('ps');
      expect(await adapter.getShellCommand('taskkill')).toBe('kill');
    });

    it('should return the command unchanged when no mapping exists', async () => {
      expect(await adapter.getShellCommand('unknown')).toBe('unknown');
    });
  });
});