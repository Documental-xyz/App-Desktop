/**
 * @fileoverview Tests for consolidated Node.js runtime detection/installation.
 * Legacy NVM/shell-probe logic was removed from system.js (Task 10); these
 * tests assert delegation to nodeDetectionService and guard against regression.
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const createMockLogger = () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() });

describe('Node.js Installation Tests (consolidated)', () => {
  let systemHandlers;
  let mockLogger;
  let mockWindowManager;
  let mockNodeDetectionService;

  const detectionPayload = {
    embedded: { available: true, version: '24.15.0' },
    runtime: { installed: false, isValid: false },
    systemNode: null,
    recommendation: 'embedded_ready'
  };

  beforeEach(async () => {
    mockLogger = createMockLogger();
    mockWindowManager = { getMainWindow: vi.fn() };
    mockNodeDetectionService = {
      detect: vi.fn().mockResolvedValue(detectionPayload),
      installManagedRuntime: vi.fn().mockResolvedValue({
        installed: true,
        isValid: true,
        version: '20.12.0',
        nodePath: '/userData/node-runtime/bin/node'
      })
    };

    const { SystemHandlers } = await import('../../src/ipc/system.js');
    systemHandlers = new SystemHandlers({
      logger: mockLogger,
      windowManager: mockWindowManager,
      nodeDetectionService: mockNodeDetectionService
    });
  });

  describe('Detection delegation', () => {
    it('checkNodeInstallation delegates to nodeDetectionService.detect', async () => {
      const result = await systemHandlers.checkNodeInstallation();
      expect(mockNodeDetectionService.detect).toHaveBeenCalledTimes(1);
      expect(result).toBe(detectionPayload);
    });

    it('returns error payload when nodeDetectionService is unavailable', async () => {
      const { SystemHandlers } = await import('../../src/ipc/system.js');
      const bare = new SystemHandlers({ logger: mockLogger, windowManager: mockWindowManager });
      const result = await bare.checkNodeInstallation();
      expect(result.recommendation).toBe('error');
      expect(result.error).toContain('nodeDetectionService');
    });

    it('returns error payload when detection throws', async () => {
      mockNodeDetectionService.detect.mockRejectedValue(new Error('boom'));
      const result = await systemHandlers.checkNodeInstallation();
      expect(result.recommendation).toBe('error');
      expect(result.error).toBe('boom');
    });
  });

  describe('Installation delegation', () => {
    it('installNodeDependencies delegates to installManagedRuntime', async () => {
      const result = await systemHandlers.installNodeDependencies({ force: false });
      expect(mockNodeDetectionService.installManagedRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ force: false })
      );
      expect(result.success).toBe(true);
      expect(result.nodeVersion).toBe('20.12.0');
      expect(result.nodePath).toContain('node-runtime');
    });

    it('forwards onProgress to installationProgress', async () => {
      mockNodeDetectionService.installManagedRuntime.mockImplementation(async ({ onProgress }) => {
        onProgress({ stage: 'downloading', percent: 42, message: 'Downloading...' });
        return { installed: true, isValid: true, version: '20.12.0', nodePath: null };
      });
      await systemHandlers.installNodeDependencies();
      expect(systemHandlers.installationProgress.stage).toBe('completed');
      expect(systemHandlers.installationProgress.progress).toBe(100);

      const progress = systemHandlers.getNodeInstallationProgress();
      expect(progress).toEqual({ stage: 'completed', progress: 100, message: 'Installation completed successfully!' });
    });

    it('reports failure and error progress when install throws', async () => {
      mockNodeDetectionService.installManagedRuntime.mockRejectedValue(new Error('download failed'));
      const result = await systemHandlers.installNodeDependencies();
      expect(result.success).toBe(false);
      expect(result.error).toBe('download failed');
      expect(systemHandlers.installationProgress.stage).toBe('error');
    });

    it('fails gracefully when nodeDetectionService is unavailable', async () => {
      const { SystemHandlers } = await import('../../src/ipc/system.js');
      const bare = new SystemHandlers({ logger: mockLogger, windowManager: mockWindowManager });
      const result = await bare.installNodeDependencies();
      expect(result.success).toBe(false);
      expect(result.error).toContain('nodeDetectionService');
    });
  });

  describe('Legacy detection removal (regression guard)', () => {
    it('system.js contains no node-detection logic', async () => {
      const { readFileSync } = require('node:fs');
      const source = readFileSync(require('node:path').join(__dirname, '../../src/ipc/system.js'), 'utf8');
      expect(source).not.toMatch(/detectNodeInstallation/);
      expect(source).not.toMatch(/nvm/i);
      expect(source).not.toMatch(/node --version/);
    });

    it('nodeDetectionService.js is the only definition of detectNodeInstallation in src/', async () => {
      const { readFileSync, readdirSync, statSync } = require('node:fs');
      const path = require('node:path');
      const srcRoot = path.join(__dirname, '../../src');
      const definers = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
          const full = path.join(dir, entry);
          if (statSync(full).isDirectory()) { walk(full); continue; }
          if (!entry.endsWith('.js')) continue;
          const content = readFileSync(full, 'utf8');
          if (/async detectNodeInstallation\(/.test(content)) definers.push(full);
        }
      };
      walk(srcRoot);
      expect(definers).toHaveLength(1);
      expect(definers[0]).toContain('nodeDetectionService.js');
    });

    it('SystemHandlers no longer exposes NVM-era methods', () => {
      for (const name of ['detectNVM', 'installNVM', 'installNodeVersion', 'configureNodeEnvironment', 'verifyNodeInstallation']) {
        expect(systemHandlers[name]).toBeUndefined();
      }
      expect(typeof systemHandlers.checkNodeInstallation).toBe('function');
      expect(typeof systemHandlers.installNodeDependencies).toBe('function');
    });
  });
});
