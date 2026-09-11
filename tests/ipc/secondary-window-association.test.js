/**
 * @fileoverview Tests for Task 1 (fechar-ambiente-multi-janela): secondary
 * windows created via createNewWindowWithState adopt the project captured
 * in the window state (window→project map), and getWindowsUsingProject
 * filters destroyed windows (liveness) while cleaning stale entries.
 *
 * Mock conventions follow tests/ipc/closeProject.test.js (mutate the shared
 * global.mockElectron in place; dynamic imports + vi.resetModules give each
 * test a fresh windowProjectMap module state; REAL ProcessManager so the
 * instance accessors delegate to the module map this test seeds).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Module mocks (needed for the REAL ProcessManager used here;
// harmless for the rest) -----------------------------------------------
vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('rimraf', () => ({ rimraf: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/main/services/platform/PlatformService.js', () => ({
  PlatformService: class {
    constructor() {
      this.logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    }
    joinPath(...segments) { return segments.join('/'); }
    getHomeDirectory() { return '/home/testuser'; }
    getTerminationSignal() { return 'SIGTERM'; }
    getForceTerminationSignal() { return 'SIGKILL'; }
  }
}));

function makeMockWindow(id) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    webContents: { send: vi.fn() },
    show: vi.fn(),
    maximize: vi.fn(),
    loadFile: vi.fn(() => Promise.resolve())
  };
}

describe('secondary window association (createNewWindowWithState + mapa)', () => {
  let logger;
  let processManager;
  let systemHandlers;
  let SystemHandlersClass;
  let mapFns;
  let BrowserWindowCtor;
  let createdWindow;

  beforeEach(async () => {
    vi.clearAllMocks();

    logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    createdWindow = makeMockWindow(42);
    BrowserWindowCtor = vi.fn(() => createdWindow);
    BrowserWindowCtor.fromWebContents = vi.fn(() => null);
    BrowserWindowCtor.getAllWindows = vi.fn(() => []);
    BrowserWindowCtor.getFocusedWindow = vi.fn(() => null);
    BrowserWindowCtor.fromId = vi.fn((id) => makeMockWindow(id));

    global.mockElectron.BrowserWindow = BrowserWindowCtor;
    global.mockElectron.ipcMain = { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() };
    global.mockElectron.app = { getPath: vi.fn(), getVersion: vi.fn(), quit: vi.fn(), isPackaged: false, getAppPath: vi.fn(() => '/test-app') };

    const systemModule = await import('../../src/ipc/system.js');
    SystemHandlersClass = systemModule.SystemHandlers;
    mapFns = await import('../../src/ipc/processManager.js');

    processManager = new mapFns.ProcessManager({ logger, nodeDetectionService: null });

    systemHandlers = new SystemHandlersClass({
      logger,
      windowManager: { getMainWindow: vi.fn(() => null) },
      processManager
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('state com currentProjectId: nova janela fica mapeada no projeto (e só nele)', async () => {
    const result = await systemHandlers.createNewWindowWithState({
      currentProjectId: 'proj-x',
      devServerUrl: 'http://localhost:4321/',
      editorUrl: 'http://localhost:4321/admin/index.html'
    });

    expect(result).toEqual({ success: true });
    expect(mapFns.getWindowProject(42)).toBe('proj-x');
    expect(mapFns.getWindowsUsingProject('proj-x')).toEqual([42]);
    expect(mapFns.getWindowsUsingProject('proj-y')).toEqual([]);
  });

  it('state SEM currentProjectId: nenhuma associação é criada', async () => {
    const result = await systemHandlers.createNewWindowWithState({
      devServerUrl: 'http://localhost:4321/',
      editorUrl: 'http://localhost:4321/admin/index.html'
    });

    expect(result).toEqual({ success: true });
    expect(mapFns.getWindowProject(42)).toBeUndefined();
    expect(mapFns.getWindowsUsingProject('proj-x')).toEqual([]);
  });

  it('re-chamada com o MESMO state/window id não duplica a associação (G9)', async () => {
    const state = { currentProjectId: 'proj-x', devServerUrl: 'http://localhost:4321/' };

    await systemHandlers.createNewWindowWithState(state);
    await systemHandlers.createNewWindowWithState(state);

    expect(mapFns.getWindowsUsingProject('proj-x').length).toBe(1);
    expect(mapFns.getWindowsUsingProject('proj-x')).toEqual([42]);
  });

  it('liveness: janela destruída (fromId → null) não conta e é removida do mapa (AC8)', () => {
    mapFns.mapWindowToProject(1, 'proj-x');
    mapFns.mapWindowToProject(2, 'proj-x');
    BrowserWindowCtor.fromId = vi.fn((id) => (id === 2 ? null : makeMockWindow(id)));

    expect(mapFns.getWindowsUsingProject('proj-x')).toEqual([1]);

    // Entrada stale foi limpa no mesmo loop: a janela 2 não existe mais no mapa.
    expect(mapFns.getWindowProject(2)).toBeUndefined();
    expect(mapFns.getWindowsUsingProject('proj-x')).toEqual([1]);
  });
});
