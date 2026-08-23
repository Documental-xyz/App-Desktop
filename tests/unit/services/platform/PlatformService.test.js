/**
 * @vitest-environment node
 */

/**
 * Test suite for PlatformService
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlatformService } from '../../../../src/main/services/platform/PlatformService.js';

describe('PlatformService', () => {
  let mockLogger;
  let mockAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    mockAdapter = {
      getPlatform: vi.fn(),
      getArchitecture: vi.fn(),
      getTempDirectory: vi.fn(),
      getHomeDirectory: vi.fn(),
      getAppDataDirectory: vi.fn(),
      getEnvironmentVariable: vi.fn(),
      setEnvironmentVariable: vi.fn(),
      isWindows: vi.fn(),
      isMacOS: vi.fn(),
      isLinux: vi.fn()
    };
  });

  describe('constructor', () => {
    it('should create PlatformService with default adapter when none provided', () => {
      const platformService = new PlatformService({ logger: mockLogger });
      expect(platformService.adapter).toBeDefined();
      expect(platformService.logger).toBe(mockLogger);
    });

    it('should create PlatformService with custom adapter', () => {
      const platformService = new PlatformService({ logger: mockLogger, adapter: mockAdapter });
      expect(platformService.adapter).toBe(mockAdapter);
    });

    it('should expose the adapter via getAdapter', () => {
      const platformService = new PlatformService({ logger: mockLogger, adapter: mockAdapter });
      expect(platformService.getAdapter()).toBe(mockAdapter);
    });
  });

  describe('path methods', () => {
    let platformService;

    beforeEach(() => {
      platformService = new PlatformService({ logger: mockLogger, adapter: mockAdapter });
    });

    it('should join path segments with path.join semantics', () => {
      const result = platformService.joinPath('usr', 'local', 'bin');
      expect(result).toBe(require('node:path').join('usr', 'local', 'bin'));
    });

    it('should normalize paths with path.normalize semantics', () => {
      const result = platformService.normalizePath('usr/./local/../bin');
      expect(result).toBe(require('node:path').normalize('usr/./local/../bin'));
    });

    it('should resolve paths to absolute with path.resolve semantics', () => {
      const result = platformService.resolvePath('relative', 'file.txt');
      expect(result).toBe(require('node:path').resolve('relative', 'file.txt'));
    });
  });

  describe('directory methods', () => {
    let platformService;

    beforeEach(() => {
      platformService = new PlatformService({ logger: mockLogger, adapter: mockAdapter });
    });

    it('should delegate getTempDirectory to adapter', () => {
      mockAdapter.getTempDirectory.mockReturnValue('/tmp');
      const result = platformService.getTempDirectory();
      expect(result).toBe('/tmp');
      expect(mockAdapter.getTempDirectory).toHaveBeenCalledTimes(1);
    });

    it('should delegate getHomeDirectory to adapter', () => {
      mockAdapter.getHomeDirectory.mockReturnValue('/home/user');
      const result = platformService.getHomeDirectory();
      expect(result).toBe('/home/user');
      expect(mockAdapter.getHomeDirectory).toHaveBeenCalledTimes(1);
    });

    it('should delegate getAppDataDirectory to adapter', () => {
      mockAdapter.getAppDataDirectory.mockReturnValue('/home/user/.config');
      const result = platformService.getAppDataDirectory();
      expect(result).toBe('/home/user/.config');
      expect(mockAdapter.getAppDataDirectory).toHaveBeenCalledTimes(1);
    });
  });

  describe('environment methods', () => {
    let platformService;

    beforeEach(() => {
      platformService = new PlatformService({ logger: mockLogger, adapter: mockAdapter });
    });

    it('should delegate getEnvironmentVariable to adapter', () => {
      mockAdapter.getEnvironmentVariable.mockReturnValue('/usr/bin:/bin');
      const result = platformService.getEnvironmentVariable('PATH');
      expect(result).toBe('/usr/bin:/bin');
      expect(mockAdapter.getEnvironmentVariable).toHaveBeenCalledWith('PATH');
    });

    it('should return defaultValue when adapter returns falsy', () => {
      mockAdapter.getEnvironmentVariable.mockReturnValue(undefined);
      const result = platformService.getEnvironmentVariable('MISSING', 'fallback');
      expect(result).toBe('fallback');
    });

    it('should delegate setEnvironmentVariable to adapter', () => {
      mockAdapter.setEnvironmentVariable.mockReturnValue(true);
      const result = platformService.setEnvironmentVariable('VAR', 'value');
      expect(result).toBe(true);
      expect(mockAdapter.setEnvironmentVariable).toHaveBeenCalledWith('VAR', 'value');
    });
  });

});
