/**
 * @fileoverview Tests for the close-project IPC handler (Task 6,
 * ajustes-wizard-preview-servicos): conditional tree kill via the
 * window→project map, 1500ms response bound, globalDevServerUrl
 * recalculation+broadcast, and the system.js seams (navigate dissociation,
 * secondary-window 'closed' hook).
 *
 * Mock conventions follow tests/ipc/navigate-teardown.test.js (mutate the
 * shared global.mockElectron in place; dynamic imports + vi.resetModules
 * give each test a fresh windowProjectMap module state).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Module mocks (needed for the REAL ProcessManager used by the
// reopen- filter case; harmless for the rest) --------------------------
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

const path = require('path');

/** Double flush: lets navigate()'s loadFile promise chain fully settle. */
const flushAll = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

function makeMockWindow(id) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    addBrowserView: vi.fn(),
    removeBrowserView: vi.fn(),
    webContents: { send: vi.fn() },
    loadFile: vi.fn(() => Promise.resolve())
  };
}

describe('close-project IPC handler', () => {
  let logger;
  let processManager;
  let handlers;
  let CloseProjectHandlersClass;
  let CLOSE_PROJECT_KILL_TIMEOUT_MS;
  let ipcMainMock;
  let BrowserWindowCtor;
  let mapFns;

  beforeEach(async () => {
    vi.clearAllMocks();

    logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    ipcMainMock = { handle: vi.fn(), removeHandler: vi.fn() };
    BrowserWindowCtor = vi.fn();
    BrowserWindowCtor.fromWebContents = vi.fn(() => null);
    BrowserWindowCtor.getAllWindows = vi.fn(() => []);

    global.mockElectron.ipcMain = ipcMainMock;
    global.mockElectron.BrowserWindow = BrowserWindowCtor;
    global.mockElectron.app = { getPath: vi.fn(), getVersion: vi.fn(), quit: vi.fn(), isPackaged: false };

    const closeModule = await import('../../src/ipc/closeProject.js');
    CloseProjectHandlersClass = closeModule.CloseProjectHandlers;
    CLOSE_PROJECT_KILL_TIMEOUT_MS = closeModule.CLOSE_PROJECT_KILL_TIMEOUT_MS;
    mapFns = await import('../../src/ipc/processManager.js');

    // REAL ProcessManager: the window→project map semantics (instance
    // accessors delegate to the module map this test seeds) stay under
    // test; the mock-able collaborators are shadowed per instance.
    processManager = new mapFns.ProcessManager({ logger, nodeDetectionService: null });
    processManager.terminateProjectProcesses = vi.fn().mockResolvedValue(undefined);
    processManager.getGlobalDevServerUrl = vi.fn().mockReturnValue(null);
    processManager.setGlobalDevServerUrl = vi.fn();
    processManager.getActiveDocumentalProcesses = vi.fn().mockReturnValue({});

    handlers = new CloseProjectHandlersClass({ logger, processManager });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('última janela do projeto: mata a árvore (terminateProjectProcesses) e responde killed=true', async () => {
    mapFns.mapWindowToProject(11, 'p1');

    const result = await handlers.closeProject(11, 'p1');

    expect(result).toEqual({ killed: true });
    expect(processManager.terminateProjectProcesses).toHaveBeenCalledTimes(1);
    expect(processManager.terminateProjectProcesses).toHaveBeenCalledWith('p1');
    expect(mapFns.getWindowsUsingProject('p1')).toEqual([]);
  });

  it('duas janelas no MESMO projeto: fechar a 1ª NÃO mata (reason in-use), associação da 2ª preservada', async () => {
    mapFns.mapWindowToProject(11, 'p1');
    mapFns.mapWindowToProject(12, 'p1');

    const result = await handlers.closeProject(11, 'p1');

    expect(result).toEqual({ killed: false, reason: 'in-use' });
    expect(processManager.terminateProjectProcesses).not.toHaveBeenCalled();
    expect(mapFns.getWindowsUsingProject('p1')).toEqual([12]);
  });

  it('kill que nunca resolve: resposta chega em ≤500ms (default 1500ms) com killed=false/timeout e warn', async () => {
    expect(CLOSE_PROJECT_KILL_TIMEOUT_MS).toBe(1500);

    const slow = new CloseProjectHandlersClass({ logger, processManager, killTimeoutMs: 50 });
    processManager.terminateProjectProcesses.mockImplementation(() => new Promise(() => {}));
    mapFns.mapWindowToProject(11, 'p1');

    const startedAt = Date.now();
    const result = await slow.closeProject(11, 'p1');
    const elapsed = Date.now() - startedAt;

    expect(result).toEqual({ killed: false, reason: 'timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(500);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('continuing in background'));
  });

  it('server global morre: globalDevServerUrl recalculado para o server restante e broadcast dev-server-url', async () => {
    processManager.getGlobalDevServerUrl.mockReturnValue('http://localhost:4321/');
    processManager.getActiveDocumentalProcesses.mockReturnValue({
      101: { pid: 101, projectId: 'p1', url: 'http://localhost:4321/', port: 4321, startTime: 1000 },
      202: { pid: 202, projectId: 'p2', url: 'http://localhost:4322/', port: 4322, startTime: 2000 }
    });
    const remainingWindow = makeMockWindow(31);
    BrowserWindowCtor.getAllWindows.mockReturnValue([remainingWindow]);
    mapFns.mapWindowToProject(31, 'p2');
    mapFns.mapWindowToProject(11, 'p1');

    const result = await handlers.closeProject(11, 'p1');

    expect(result).toEqual({ killed: true });
    expect(processManager.setGlobalDevServerUrl).toHaveBeenCalledWith('http://localhost:4322/');
    expect(remainingWindow.webContents.send).toHaveBeenCalledWith('dev-server-url', 'http://localhost:4322/');
  });

  it('server global pertence a projeto sobrevivente: URL inalterada, sem broadcast', async () => {
    processManager.getGlobalDevServerUrl.mockReturnValue('http://localhost:4322/');
    processManager.getActiveDocumentalProcesses.mockReturnValue({
      101: { pid: 101, projectId: 'p1', url: 'http://localhost:4321/', port: 4321, startTime: 1000 },
      202: { pid: 202, projectId: 'p2', url: 'http://localhost:4322/', port: 4322, startTime: 2000 }
    });
    const otherWindow = makeMockWindow(31);
    BrowserWindowCtor.getAllWindows.mockReturnValue([otherWindow]);
    mapFns.mapWindowToProject(11, 'p1');

    await handlers.closeProject(11, 'p1');

    expect(processManager.setGlobalDevServerUrl).not.toHaveBeenCalled();
    expect(otherWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('sem projectId: responde no-project sem tocar em processos', async () => {
    const result = await handlers.closeProject(11, undefined);

    expect(result).toEqual({ killed: false, reason: 'no-project' });
    expect(processManager.terminateProjectProcesses).not.toHaveBeenCalled();
  });

  it('registro/teardown: ipcMain.handle("close-project") resolve a janela via fromWebContents', async () => {
    handlers.registerHandlers();
    expect(ipcMainMock.handle).toHaveBeenCalledWith('close-project', expect.any(Function));

    const registered = ipcMainMock.handle.mock.calls.find((call) => call[0] === 'close-project')[1];
    const senderWindow = makeMockWindow(41);
    BrowserWindowCtor.fromWebContents.mockReturnValue(senderWindow);
    mapFns.mapWindowToProject(41, 'p7');

    const result = await registered({ sender: { id: 'wc-41' } }, 'p7');

    expect(result).toEqual({ killed: true });
    expect(processManager.terminateProjectProcesses).toHaveBeenCalledWith('p7');

    handlers.unregisterHandlers();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith('close-project');
  });

  it('filtro de chaves cobre reopen- e dev- do projeto (terminate roteia killPidTree)', async () => {
    processManager.terminateProjectProcesses = mapFns.ProcessManager.prototype.terminateProjectProcesses;
    const killPidTreeMock = vi.fn().mockResolvedValue(undefined);
    processManager._killPidTree = killPidTreeMock;
    processManager.getActiveProcesses = () => ({
      'reopen-p9': { pid: 777, exitCode: null, killed: false },
      'dev-p9': { pid: 778, exitCode: null, killed: false },
      'dev-other': { pid: 779, exitCode: null, killed: false }
    });
    mapFns.mapWindowToProject(21, 'p9');

    const result = await handlers.closeProject(21, 'p9');

    expect(result).toEqual({ killed: true });
    expect(killPidTreeMock).toHaveBeenCalledWith(777, 300);
    expect(killPidTreeMock).toHaveBeenCalledWith(778, 300);
    expect(killPidTreeMock).not.toHaveBeenCalledWith(779, expect.anything());
  });
});

describe('system.js seams — mapa janela→projeto', () => {
  let logger;
  let SystemHandlersClass;
  let BrowserWindowCtor;

  beforeEach(async () => {
    vi.clearAllMocks();
    logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    BrowserWindowCtor = vi.fn();
    BrowserWindowCtor.fromWebContents = vi.fn(() => null);
    BrowserWindowCtor.getAllWindows = vi.fn(() => []);

    global.mockElectron.BrowserWindow = BrowserWindowCtor;
    global.mockElectron.ipcMain = { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() };
    global.mockElectron.app = { getPath: vi.fn(), getVersion: vi.fn(), quit: vi.fn(), isPackaged: false };
    global.mockElectron.nativeTheme = { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() };

    const systemModule = await import('../../src/ipc/system.js');
    SystemHandlersClass = systemModule.SystemHandlers;
  });

  afterEach(() => {
    vi.resetModules();
  });

  function makeSystemHandlers(overrides = {}) {
    return new SystemHandlersClass({
      logger,
      windowManager: { getMainWindow: vi.fn(() => null) },
      browserHandlers: { cleanupWindowBrowserViews: vi.fn() },
      ...overrides
    });
  }

  it('navigate para fora de main.html dissocia a janela do projeto', async () => {
    const window = makeMockWindow(42);
    BrowserWindowCtor.fromWebContents.mockReturnValue(window);
    const dissociateWindow = vi.fn();
    const systemHandlers = makeSystemHandlers({ processManager: { dissociateWindow } });

    systemHandlers.navigate({ sender: { send: vi.fn() } }, 'index.html');
    await flushAll();

    expect(dissociateWindow).toHaveBeenCalledWith(42);
  });

  it('navigate PARA main.html preserva a associação (troca de workspace não é fechamento)', async () => {
    const window = makeMockWindow(42);
    BrowserWindowCtor.fromWebContents.mockReturnValue(window);
    const dissociateWindow = vi.fn();
    const systemHandlers = makeSystemHandlers({ processManager: { dissociateWindow } });

    systemHandlers.navigate({ sender: { send: vi.fn() } }, 'main.html');
    await flushAll();

    expect(dissociateWindow).not.toHaveBeenCalled();
  });

  it('hook de janela secundária fechada: roda a rotina close-project da janela mapeada (fire-and-forget)', async () => {
    const closeProject = vi.fn().mockResolvedValue({ killed: true });
    const getWindowProject = vi.fn((windowId) => (windowId === 7 ? 'p2' : undefined));
    const systemHandlers = makeSystemHandlers({
      processManager: { getWindowProject },
      closeProjectHandlers: { closeProject }
    });

    systemHandlers._handleSecondaryWindowClosed(7);
    systemHandlers._handleSecondaryWindowClosed(999); // janela sem projeto → no-op
    await flushAll();

    expect(closeProject).toHaveBeenCalledTimes(1);
    expect(closeProject).toHaveBeenCalledWith(7, 'p2');
  });

  it('hook de janela secundária sem processManager/closeProjectHandlers não lança', () => {
    const systemHandlers = makeSystemHandlers();
    expect(() => systemHandlers._handleSecondaryWindowClosed(7)).not.toThrow();
  });
});
