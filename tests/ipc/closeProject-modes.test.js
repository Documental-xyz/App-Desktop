/**
 * @fileoverview Tests for the close-project IPC handler modes (Task 2,
 * fechar-ambiente-multi-janela): legacy no-mode behavior snapshot (G1),
 * 'this-window' with the server-side last-window re-check (E4),
 * 'all-windows' with programmatic close of the other windows and
 * exit-prompt suppression via the 'app-exiting' channel (G3/E5/AC6),
 * the ≤1500ms response budget with slow closes (AC5), the
 * get-project-window-count IPC including the calling window (AC1) and
 * the concurrent-invoke single-decision guard (E3/AC7).
 *
 * Mock conventions follow tests/ipc/closeProject.test.js (mutate the
 * shared global.mockElectron in place; dynamic imports + vi.resetModules
 * give each test a fresh windowProjectMap module state). Seeded windows
 * must be resolvable ALIVE through BrowserWindow.fromId — Task 1's
 * liveness filter in getWindowsUsingProject drops dead windows — so the
 * suite keeps a per-test window registry behind fromId.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Module mocks (needed for the REAL ProcessManager; harmless for the
// rest) ---------------------------------------------------------------
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

/**
 * Order log shared by all fake windows of a test: every send/close lands
 * in one sequence so AC6 ordering asserts see the REAL relative order.
 */
function makeOrderWindow(id, orderLog) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    close: vi.fn(() => orderLog.push(`close:${id}`)),
    webContents: {
      send: vi.fn((channel) => orderLog.push(`send:${channel}:${id}`))
    }
  };
}

describe('close-project IPC handler modes', () => {
  let logger;
  let processManager;
  let handlers;
  let CloseProjectHandlersClass;
  let CLOSE_PROJECT_KILL_TIMEOUT_MS;
  let FORCE_CLOSE_FLUSH_MS;
  let ipcMainMock;
  let BrowserWindowCtor;
  let mapFns;
  let windowsById;

  beforeEach(async () => {
    vi.clearAllMocks();

    logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    ipcMainMock = { handle: vi.fn(), removeHandler: vi.fn() };
    windowsById = {};
    BrowserWindowCtor = vi.fn();
    BrowserWindowCtor.fromWebContents = vi.fn(() => null);
    BrowserWindowCtor.getAllWindows = vi.fn(() => []);
    BrowserWindowCtor.fromId = vi.fn((id) => windowsById[id] || null);

    global.mockElectron.ipcMain = ipcMainMock;
    global.mockElectron.BrowserWindow = BrowserWindowCtor;
    global.mockElectron.app = { getPath: vi.fn(), getVersion: vi.fn(), quit: vi.fn(), isPackaged: false };

    const closeModule = await import('../../src/ipc/closeProject.js');
    CloseProjectHandlersClass = closeModule.CloseProjectHandlers;
    CLOSE_PROJECT_KILL_TIMEOUT_MS = closeModule.CLOSE_PROJECT_KILL_TIMEOUT_MS;
    FORCE_CLOSE_FLUSH_MS = closeModule.FORCE_CLOSE_FLUSH_MS;
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
    vi.useRealTimers();
    vi.resetModules();
  });

  /**
   * Map a window to a project AND make it resolvable-alive through the
   * fromId registry (the liveness filter must not drop it).
   */
  function seedWindow(id, projectId) {
    windowsById[id] = windowsById[id] || { id, isDestroyed: vi.fn(() => false) };
    mapFns.mapWindowToProject(id, projectId);
    return windowsById[id];
  }

  it('legacy sem mode: comportamento atual preservado — in-use entre 2 janelas e kill exato {killed:true} na última (G1)', async () => {
    seedWindow(11, 'p1');
    seedWindow(12, 'p1');

    const inUse = await handlers.closeProject(11, 'p1');

    expect(inUse).toEqual({ killed: false, reason: 'in-use' });
    expect(mapFns.getWindowsUsingProject('p1')).toEqual([12]);

    const last = await handlers.closeProject(12, 'p1');

    expect(last).toEqual({ killed: true });
    expect(processManager.terminateProjectProcesses).toHaveBeenCalledTimes(1);
    expect(processManager.terminateProjectProcesses).toHaveBeenCalledWith('p1');
    expect(mapFns.getWindowsUsingProject('p1')).toEqual([]);
  });

  it('this-window com outra janela viva: in-use, sem kill, associação da restante preservada', async () => {
    seedWindow(11, 'p1');
    seedWindow(12, 'p1');

    const result = await handlers.closeProject(11, 'p1', 'this-window');

    expect(result).toEqual({ killed: false, reason: 'in-use' });
    expect(result.becameLast).toBeUndefined();
    expect(processManager.terminateProjectProcesses).not.toHaveBeenCalled();
    expect(mapFns.getWindowsUsingProject('p1')).toEqual([12]);
  });

  it('this-window sendo a última: kill + recalc + resposta {killed:true, becameLast:true}', async () => {
    seedWindow(11, 'p1');

    const result = await handlers.closeProject(11, 'p1', 'this-window');

    expect(result).toEqual({ killed: true, becameLast: true });
    expect(processManager.terminateProjectProcesses).toHaveBeenCalledWith('p1');
    expect(mapFns.getWindowsUsingProject('p1')).toEqual([]);
  });

  it('this-window com count que caiu entre modal e clique (E4): sender não mapeado, mas outra janela vive → in-use', async () => {
    seedWindow(12, 'p1');

    const result = await handlers.closeProject(11, 'p1', 'this-window');

    expect(result).toEqual({ killed: false, reason: 'in-use' });
    expect(processManager.terminateProjectProcesses).not.toHaveBeenCalled();
  });

  it('all-windows: mata o projeto, fecha OUTRAS janelas (não o sender), não toca janela de outro projeto (AC2/AC3)', async () => {
    vi.useFakeTimers();
    const orderLog = [];
    const sender = makeOrderWindow(10, orderLog);
    const otherA = makeOrderWindow(11, orderLog);
    const otherB = makeOrderWindow(12, orderLog);
    const foreign = makeOrderWindow(20, orderLog);
    windowsById[10] = sender;
    windowsById[11] = otherA;
    windowsById[12] = otherB;
    windowsById[20] = foreign;

    seedWindow(10, 'p1');
    seedWindow(11, 'p1');
    seedWindow(12, 'p1');
    seedWindow(20, 'p2');

    const result = await handlers.closeProject(10, 'p1', 'all-windows');

    expect(result).toEqual({ killed: true, closedOthers: 2 });
    expect(processManager.terminateProjectProcesses).toHaveBeenCalledTimes(1);
    expect(processManager.terminateProjectProcesses).toHaveBeenCalledWith('p1');
    expect(mapFns.getWindowsUsingProject('p1')).toEqual([]);
    expect(mapFns.getWindowsUsingProject('p2')).toEqual([20]);

    // closes are scheduled, not inline: fire the flush timers
    await vi.advanceTimersByTimeAsync(FORCE_CLOSE_FLUSH_MS + 10);

    expect(otherA.close).toHaveBeenCalledTimes(1);
    expect(otherB.close).toHaveBeenCalledTimes(1);
    expect(sender.close).not.toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('all-windows supressão: send app-exiting POR janela alvo ANTES do close; sender e janela de outro workspace NUNCA recebem (E5/AC6)', async () => {
    vi.useFakeTimers();
    const orderLog = [];
    const sender = makeOrderWindow(10, orderLog);
    const otherA = makeOrderWindow(11, orderLog);
    const otherB = makeOrderWindow(12, orderLog);
    const foreign = makeOrderWindow(99, orderLog);
    windowsById[10] = sender;
    windowsById[11] = otherA;
    windowsById[12] = otherB;
    windowsById[99] = foreign;

    seedWindow(10, 'p1');
    seedWindow(11, 'p1');
    seedWindow(12, 'p1');

    await handlers.closeProject(10, 'p1', 'all-windows');
    await vi.advanceTimersByTimeAsync(FORCE_CLOSE_FLUSH_MS + 10);

    expect(orderLog.filter((entry) => entry.startsWith('send:app-exiting:'))).toEqual([
      'send:app-exiting:11',
      'send:app-exiting:12'
    ]);
    for (const id of [11, 12]) {
      expect(orderLog.indexOf(`send:app-exiting:${id}`)).toBeLessThan(orderLog.indexOf(`close:${id}`));
    }
    expect(orderLog).not.toContain('send:app-exiting:10');
    expect(orderLog).not.toContain('send:app-exiting:99');
    expect(orderLog).not.toContain('close:10');
    expect(orderLog).not.toContain('close:99');
    expect(sender.webContents.send).not.toHaveBeenCalled();
    expect(foreign.webContents.send).not.toHaveBeenCalled();
  });

  it('all-windows budget: resposta chega ANTES dos closes mesmo com close bloqueante, em ≤1500ms (AC5)', async () => {
    const orderLog = [];
    const slowClose = makeOrderWindow(11, orderLog);
    slowClose.close = vi.fn(() => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 300) { /* blocking renderer close */ }
      orderLog.push('close:11');
    });
    windowsById[10] = makeOrderWindow(10, orderLog);
    windowsById[11] = slowClose;

    seedWindow(10, 'p1');
    seedWindow(11, 'p1');

    expect(CLOSE_PROJECT_KILL_TIMEOUT_MS).toBe(1500);
    const startedAt = Date.now();
    const result = await handlers.closeProject(10, 'p1', 'all-windows');
    const elapsed = Date.now() - startedAt;

    expect(result).toEqual({ killed: true, closedOthers: 1 });
    expect(elapsed).toBeLessThan(1500);
    expect(orderLog).toEqual(['send:app-exiting:11']); // close still pending in its 50ms flush

    // eventually the flush fires and the slow close runs — outside the response
    await new Promise((resolve) => setTimeout(resolve, FORCE_CLOSE_FLUSH_MS + 400));
    expect(orderLog).toContain('close:11');
  });

  it('get-project-window-count: inclui a janela chamadora (AC1); registro/teardown como o close-project', async () => {
    handlers.registerHandlers();

    expect(ipcMainMock.handle).toHaveBeenCalledWith('close-project', expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith('get-project-window-count', expect.any(Function));

    const countHandler = ipcMainMock.handle.mock.calls
      .find((call) => call[0] === 'get-project-window-count')[1];

    seedWindow(41, 'p7');
    expect(await countHandler({ sender: { id: 'wc-41' } }, 'p7')).toEqual({ count: 1 });

    seedWindow(42, 'p7');
    expect(await countHandler({ sender: { id: 'wc-41' } }, 'p7')).toEqual({ count: 2 });

    expect(await countHandler({ sender: { id: 'wc-41' } }, 'p-other')).toEqual({ count: 0 });
    expect(await countHandler({ sender: { id: 'wc-41' } }, undefined)).toEqual({ count: 0 });

    handlers.unregisterHandlers();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith('close-project');
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith('get-project-window-count');
  });

  it('registro close-project repassa o mode ao handler (3º parâmetro additive)', async () => {
    handlers.registerHandlers();
    const closeHandler = ipcMainMock.handle.mock.calls
      .find((call) => call[0] === 'close-project')[1];

    const senderWindow = { id: 41, isDestroyed: () => false };
    BrowserWindowCtor.fromWebContents.mockReturnValue(senderWindow);
    const spy = vi.spyOn(handlers, 'closeProject');

    await closeHandler({ sender: { id: 'wc-41' } }, 'p7', 'this-window');

    expect(spy).toHaveBeenCalledWith(41, 'p7', 'this-window');
  });

  it('concorrência dupla all-windows: decisão única, loser recebe already-closing, flag limpa ao fim (E3/AC7)', async () => {
    let resolveKill;
    processManager.terminateProjectProcesses.mockImplementation(
      () => new Promise((resolve) => { resolveKill = resolve; })
    );

    seedWindow(10, 'p1');
    seedWindow(11, 'p1');

    const first = handlers.closeProject(10, 'p1', 'all-windows');
    const second = handlers.closeProject(11, 'p1', 'all-windows');

    resolveKill();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual({ killed: true, closedOthers: 1 });
    expect(secondResult).toEqual({ killed: false, reason: 'already-closing' });
    expect(processManager.terminateProjectProcesses).toHaveBeenCalledTimes(1);

    // cleanup: a third invoke after the decision runs the normal path again
    processManager.terminateProjectProcesses.mockResolvedValue(undefined);
    seedWindow(10, 'p1');
    const third = await handlers.closeProject(10, 'p1', 'all-windows');
    expect(third).toEqual({ killed: true, closedOthers: 0 });
    expect(processManager.terminateProjectProcesses).toHaveBeenCalledTimes(2);
  });

  it('concorrência this-window que vira a última durante all-windows em andamento: already-closing', async () => {
    let resolveKill;
    processManager.terminateProjectProcesses.mockImplementation(
      () => new Promise((resolve) => { resolveKill = resolve; })
    );

    seedWindow(10, 'p1');
    seedWindow(11, 'p1');

    const allWindows = handlers.closeProject(10, 'p1', 'all-windows');
    const thisWindow = handlers.closeProject(11, 'p1', 'this-window');

    resolveKill();
    const [allResult, thisResult] = await Promise.all([allWindows, thisWindow]);

    expect(allResult).toEqual({ killed: true, closedOthers: 1 });
    expect(thisResult).toEqual({ killed: false, reason: 'already-closing' });
    expect(processManager.terminateProjectProcesses).toHaveBeenCalledTimes(1);
  });

  it('mode desconhecido: recusa com invalid-mode sem tocar no mapa nem nos processos', async () => {
    seedWindow(11, 'p1');

    const result = await handlers.closeProject(11, 'p1', 'nonsense');

    expect(result).toEqual({ killed: false, reason: 'invalid-mode' });
    expect(processManager.terminateProjectProcesses).not.toHaveBeenCalled();
    expect(mapFns.getWindowsUsingProject('p1')).toEqual([11]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown mode'));
  });

  it('mode null (serialização Electron de undefined): caminho legacy', async () => {
    seedWindow(11, 'p1');

    const result = await handlers.closeProject(11, 'p1', null);

    expect(result).toEqual({ killed: true });
    expect(processManager.terminateProjectProcesses).toHaveBeenCalledWith('p1');
  });
});
