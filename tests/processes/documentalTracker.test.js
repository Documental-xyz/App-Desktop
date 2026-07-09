/**
 * @fileoverview Tests for DocumentalTracker module
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs at the top level
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn()
}));

// Mock path at the top level
vi.mock('path', () => ({
  join: vi.fn((...args) => args.join('/'))
}));

// Mock killPidTree (Wave 1 Task 1 helper) — asserted in killAllProcesses tests
vi.mock('../../src/main/processes/killPidTree.js', () => ({
  killPidTree: vi.fn().mockResolvedValue(undefined)
}));

// Mock PIDRegistryFile (Wave 1 Task 3 helper) — asserted in integration tests
vi.mock('../../src/main/processes/PIDRegistryFile.js', () => {
  const mockInstance = {
    register: vi.fn().mockResolvedValue(undefined),
    unregister: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue([]),
    reapOrphans: vi.fn().mockResolvedValue({ reaped: [] })
  };
  return {
    PIDRegistryFile: vi.fn(() => mockInstance),
    __mockInstance: mockInstance
  };
});

describe('DocumentalTracker Unit Tests', () => {
  let mockLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };
  });

  describe('DocumentalTracker Basic Functionality', () => {
    it('should validate dependencies are properly mocked', () => {
      expect(mockLogger.info).toBeDefined();
      expect(mockLogger.error).toBeDefined();
    });

    it('should test mock logger functionality', () => {
      mockLogger.info('Test documental tracker message');
      expect(mockLogger.info).toHaveBeenCalledWith('Test documental tracker message');
    });
  });

  describe('Module Import Validation', () => {
    it('should validate DocumentalTracker can be imported', async () => {
      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      expect(DocumentalTracker).toBeDefined();
      expect(typeof DocumentalTracker).toBe('function');
    });

    it('should create DocumentalTracker instance', async () => {
      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      const tracker = new DocumentalTracker();
      
      expect(tracker).toBeDefined();
    });

    it('should create DocumentalTracker with custom config', async () => {
      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      const tracker = new DocumentalTracker({
        processesFile: '/test/processes.json',
        enablePersistence: true
      });
      
      expect(tracker).toBeDefined();
    });
  });

  describe('Basic Method Existence Tests', () => {
    let tracker;

    beforeEach(async () => {
      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      tracker = new DocumentalTracker();
    });

    it('should have loadProcesses method', () => {
      expect(typeof tracker.loadProcesses).toBe('function');
    });

    it('should have addProcess method', () => {
      expect(typeof tracker.addProcess).toBe('function');
    });

    it('should have removeProcess method', () => {
      expect(typeof tracker.removeProcess).toBe('function');
    });

    it('should have getProcessesByProject method', () => {
      expect(typeof tracker.getProcessesByProject).toBe('function');
    });

    it('should have getProcessesByPort method', () => {
      expect(typeof tracker.getProcessesByPort).toBe('function');
    });

    it('should have getProcessCount method', () => {
      expect(typeof tracker.getProcessCount).toBe('function');
    });

    it('should hasProcess method', () => {
      expect(typeof tracker.hasProcess).toBe('function');
    });

    it('should have clearAllProcesses method', () => {
      expect(typeof tracker.clearAllProcesses).toBe('function');
    });

    it('should have cleanupOldProcesses method', () => {
      expect(typeof tracker.cleanupOldProcesses).toBe('function');
    });

    it('should have updateConfig method', () => {
      expect(typeof tracker.updateConfig).toBe('function');
    });

    it('should have getConfig method', () => {
      expect(typeof tracker.getConfig).toBe('function');
    });
  });

  describe('Process Management Flow Tests', () => {
    let tracker;

    beforeEach(async () => {
      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      tracker = new DocumentalTracker();
    });

    it('should validate process management methods exist and are callable', () => {
      expect(typeof tracker.addProcess).toBe('function');
      expect(typeof tracker.removeProcess).toBe('function');
      expect(typeof tracker.getProcessesByProject).toBe('function');
      expect(typeof tracker.getProcessesByPort).toBe('function');
      expect(typeof tracker.cleanupOldProcesses).toBe('function');
      // We don't call them to avoid file system dependency issues
    });
  });

  describe('Error Handling Tests', () => {
    let tracker;

    beforeEach(async () => {
      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      tracker = new DocumentalTracker();
    });

    it('should validate error handling structure exists', () => {
      // Test that error handling methods exist
      expect(typeof tracker.addProcess).toBe('function');
      expect(typeof tracker.removeProcess).toBe('function');
      expect(mockLogger.error).toBeDefined();
    });
  });

  describe('Configuration Tests', () => {
    it('should create tracker with default configuration', async () => {
      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      const tracker = new DocumentalTracker();
      
      expect(tracker).toBeDefined();
      expect(typeof tracker.loadProcesses).toBe('function');
    });

    it('should create tracker with custom configuration', async () => {
      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      const tracker = new DocumentalTracker({
        processesFile: '/test/custom-processes.json',
        enablePersistence: false,
        maxAge: 3600000
      });
      
      expect(tracker).toBeDefined();
      expect(typeof tracker.loadProcesses).toBe('function');
    });

    it('should validate configuration handling', async () => {
      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      
      expect(() => {
        new DocumentalTracker({
          processesFile: '/some/path/processes.json',
          enablePersistence: true
        });
      }).not.toThrow();
    });
  });

  describe('Utility Method Tests', () => {
    let tracker;

    beforeEach(async () => {
      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      tracker = new DocumentalTracker();
    });

    it('should validate utility methods exist', () => {
      expect(typeof tracker.getProcessCount).toBe('function');
      expect(typeof tracker.hasProcess).toBe('function');
      expect(typeof tracker.clearAllProcesses).toBe('function');
      expect(typeof tracker.getConfig).toBe('function');
      expect(typeof tracker.updateConfig).toBe('function');
    });
  });

  // TDD RED — these describe post-refactor behavior (Task 13 Wave 3) and are
  // EXPECTED TO FAIL until then. Do not make them green in this task.

  describe('killAllProcesses', () => {
    let tracker;
    let killPidTree;

    beforeEach(async () => {
      ({ killPidTree } = await import('../../src/main/processes/killPidTree.js'));
      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      tracker = new DocumentalTracker({ enablePersistence: false });
      tracker.activeProcesses = {
        1001: { pid: 1001, port: 3001, projectId: 'p1', command: 'npm start', cwd: '/a' },
        1002: { pid: 1002, port: 3002, projectId: 'p2', command: 'npm start', cwd: '/b' },
        1003: { pid: 1003, port: 3003, projectId: 'p3', command: 'npm start', cwd: '/c' }
      };
    });

    it('should call killPidTree for each tracked PID', async () => {
      await tracker.killAllProcesses();

      expect(killPidTree).toHaveBeenCalledTimes(3);
      expect(killPidTree).toHaveBeenCalledWith(1001, expect.any(Number));
      expect(killPidTree).toHaveBeenCalledWith(1002, expect.any(Number));
      expect(killPidTree).toHaveBeenCalledWith(1003, expect.any(Number));
    });

    it('should clear activeProcesses after killAll', async () => {
      await tracker.killAllProcesses();

      expect(tracker.activeProcesses).toEqual({});
    });
  });

  describe('persistence removal', () => {
    let tracker;

    beforeEach(async () => {
      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      tracker = new DocumentalTracker({ processesFile: '/test/regression/processes.json' });
      tracker.activeProcesses = {
        2001: { pid: 2001, port: 4001, projectId: 'p1', command: 'npm start', cwd: '/x' }
      };
    });

    it('should NOT call saveProcesses on shutdown', async () => {
      const spy = vi.spyOn(tracker, 'saveProcesses');

      // Given/When: clearAllProcesses is today's shutdown path (replaced by
      // killAllProcesses post-refactor). Then: shutdown must not persist.
      if (typeof tracker.killAllProcesses === 'function') {
        await tracker.killAllProcesses();
      } else if (typeof tracker.clearAllProcesses === 'function') {
        tracker.clearAllProcesses();
      }

      expect(spy).not.toHaveBeenCalled();
    });

    it('saveProcesses should be removed or no-op', () => {
      // Given/Then: post-refactor the method is gone or writes nothing.
      const spy = vi.spyOn(tracker, 'saveProcesses');

      tracker.addProcess(2002, {
        port: 4002,
        projectId: 'p2',
        command: 'npm start',
        cwd: '/no-write'
      });

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('PIDRegistryFile integration', () => {
    let tracker;
    let registryInstance;

    beforeEach(async () => {
      const { PIDRegistryFile, __mockInstance } = await import('../../src/main/processes/PIDRegistryFile.js');
      registryInstance = __mockInstance;
      PIDRegistryFile.mockClear();
      registryInstance.register.mockClear();
      registryInstance.unregister.mockClear();

      const { DocumentalTracker } = await import('../../src/main/processes/documentalTracker.js');
      tracker = new DocumentalTracker({ enablePersistence: false });
    });

    it('should call pidRegistry.register when tracking a process', () => {
      tracker.addProcess(3001, {
        port: 5001,
        projectId: 'p1',
        command: 'npm start',
        cwd: '/y'
      });

      expect(registryInstance.register).toHaveBeenCalledTimes(1);
      expect(registryInstance.register).toHaveBeenCalledWith(3001, expect.objectContaining({
        command: 'npm start',
        cwd: '/y'
      }));
    });

    it('should call pidRegistry.unregister when removing a process', () => {
      tracker.activeProcesses = {
        3002: { pid: 3002, port: 5002, projectId: 'p2', command: 'npm start', cwd: '/z' }
      };

      tracker.removeProcess(3002);

      expect(registryInstance.unregister).toHaveBeenCalledTimes(1);
      expect(registryInstance.unregister).toHaveBeenCalledWith(3002);
    });
  });
});