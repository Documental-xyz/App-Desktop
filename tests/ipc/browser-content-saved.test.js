/**
 * @fileoverview Task 3 (plan: ajustes-wizard-preview-servicos) — revived
 * cms:content-saved main handler: poll-then-navigate for NEW pages.
 *
 * URL contract (validated against Template/public/admin/config.yml:1870-1887
 * pages collection, Core/src/routes/[slug].astro and Core/src/content.config.ts
 * generateId): route is `/<slug>/`; frontmatter `slug` may contain non-ASCII
 * characters and spaces, so the slug is percent-encoded per segment while
 * `/` separators stay structural.
 *
 * Mock strategy copied from tests/ipc/browser-keep-list.test.js:116-140
 * (shared global.mockElectron mutated in place BEFORE importing
 * src/ipc/browser.js; vi.resetModules() between tests). The poll's fetch is
 * injected via the constructor (previewFetch) and the interval collapsed to
 * 0ms so 20-attempt exhaustion stays fast — production defaults remain
 * 20 × 500ms (~10s hard bound).
 *
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function makeViewWebContents({ destroyed = false } = {}) {
  return {
    loadURL: vi.fn(),
    getURL: vi.fn(() => 'about:blank'),
    once: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    capturePage: vi.fn(),
    goBack: vi.fn(),
    reload: vi.fn(),
    canGoBack: vi.fn(() => false),
    isDestroyed: vi.fn(() => destroyed)
  };
}

function makeMockWindow(id = 7) {
  return {
    id,
    on: vi.fn(),
    addBrowserView: vi.fn(),
    removeBrowserView: vi.fn(),
    getContentSize: vi.fn(() => [1400, 900]),
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() }
  };
}

function setupElectronMocks(mockWindow) {
  const BrowserViewCtor = vi.fn(() => ({
    webContents: makeViewWebContents(),
    setBounds: vi.fn()
  }));

  const BrowserWindowCtor = vi.fn();
  BrowserWindowCtor.fromWebContents = vi.fn(() => mockWindow);
  BrowserWindowCtor.getAllWindows = vi.fn(() => []);

  global.mockElectron.BrowserView = BrowserViewCtor;
  global.mockElectron.BrowserWindow = BrowserWindowCtor;
  global.mockElectron.ipcMain = {
    handle: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  };

  return { BrowserViewCtor };
}

function makeDeps(overrides = {}) {
  return {
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    windowManager: { getMainWindow: vi.fn(), getAllWindows: vi.fn(() => []) },
    processManager: { getGlobalDevServerUrl: vi.fn(() => 'http://preview.local/') },
    previewPollIntervalMs: 0,
    ...overrides
  };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('cms:content-saved → poll preview route then navigate viewer', () => {
  let mockWindow;
  let mockEvent;
  let BrowserViewCtor;
  let fetchMock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWindow = makeMockWindow();
    mockEvent = { sender: { id: 'sender-1' } };
    ({ BrowserViewCtor } = setupElectronMocks(mockWindow));
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function freshHandlers(depsOverrides = {}) {
    const { BrowserHandlers } = await import('../../src/ipc/browser.js');
    const handlers = new BrowserHandlers(makeDeps({ previewFetch: fetchMock, ...depsOverrides }));
    handlers.registerHandlers();
    return handlers;
  }

  async function getContentSavedHandler(handlers) {
    const handler = global.mockElectron.ipcMain.on.mock.calls
      .map(([channel, fn]) => ({ channel, fn }))
      .find(({ channel }) => channel === 'cms:content-saved')?.fn;
    expect(handler).toBeTypeOf('function');
    return handler;
  }

  function viewerViewOf(handlers) {
    const views = handlers.windowBrowserViews.get(mockWindow);
    expect(views).toBeTypeOf('object');
    return views.viewerView;
  }

  it('404→404→200: navigates exactly once with the right URL after 3 fetches', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 200 });
    const handlers = await freshHandlers();
    const handler = await getContentSavedHandler(handlers);

    handler(mockEvent, { slug: 'nova-pagina-teste', isNew: true });
    await vi.waitFor(() => {
      expect(viewerViewOf(handlers).webContents.loadURL).toHaveBeenCalledTimes(1);
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://preview.local/nova-pagina-teste/',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(viewerViewOf(handlers).webContents.loadURL).toHaveBeenCalledWith(
      'http://preview.local/nova-pagina-teste/'
    );
    // Bookkeeping: the loaded slug becomes the window's last slug.
    expect(handlers.windowSlugMap.get(mockWindow.id)).toBe('nova-pagina-teste');
  });

  it('route never answers: 20 attempts, no navigation, warn logged, viewer keeps content', async () => {
    fetchMock.mockResolvedValue({ status: 404 });
    const handlers = await freshHandlers();
    const handler = await getContentSavedHandler(handlers);

    handler(mockEvent, { slug: 'nunca-Compila', isNew: true });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(20);
    });
    await settle();

    expect(viewerViewOf(handlers).webContents.loadURL).not.toHaveBeenCalled();
    expect(handlers.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[preview] rota não respondeu após 20 tentativas: http://preview.local/nunca-Compila/')
    );
    expect(handlers.windowSlugMap.get(mockWindow.id)).toBeUndefined();
  });

  it('empty devServerUrl: warns and never creates views nor fetches', async () => {
    const handlers = await freshHandlers({
      processManager: { getGlobalDevServerUrl: vi.fn(() => '') }
    });
    const handler = await getContentSavedHandler(handlers);

    handler(mockEvent, { slug: 'qualquer-slug', isNew: true });

    expect(handlers.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('dev server URL unknown')
    );
    expect(BrowserViewCtor).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handlers.windowBrowserViews.size).toBe(0);
  });

  it('destroyed viewer webContents: silent no-op (no fetch, no loadURL)', async () => {
    const handlers = await freshHandlers();
    const { viewerView } = handlers.getOrCreateBrowserViews(mockWindow);
    viewerView.webContents.isDestroyed = vi.fn(() => true);
    const handler = await getContentSavedHandler(handlers);

    handler(mockEvent, { slug: 'viewer-morto', isNew: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(viewerView.webContents.loadURL).not.toHaveBeenCalled();
  });

  it('two rapid saves: last-wins — only the second URL is loaded (loadURL 1×)', async () => {
    fetchMock.mockImplementation((url) =>
      Promise.resolve({ status: url.includes('segunda-pagina') ? 200 : 404 })
    );
    const handlers = await freshHandlers();
    const handler = await getContentSavedHandler(handlers);

    handler(mockEvent, { slug: 'primeira-pagina', isNew: true });
    handler(mockEvent, { slug: 'segunda-pagina', isNew: true });
    await vi.waitFor(() => {
      expect(viewerViewOf(handlers).webContents.loadURL).toHaveBeenCalledTimes(1);
    });
    await settle(10);

    expect(viewerViewOf(handlers).webContents.loadURL).toHaveBeenCalledWith(
      'http://preview.local/segunda-pagina/'
    );
    expect(handlers.windowSlugMap.get(mockWindow.id)).toBe('segunda-pagina');
  });

  it('existing page with unchanged slug (isNew !== true && slug === lastSlug): skips entirely', async () => {
    const handlers = await freshHandlers();
    handlers.windowSlugMap.set(mockWindow.id, 'pagina-existente');
    const handler = await getContentSavedHandler(handlers);

    handler(mockEvent, { slug: 'pagina-existente', isNew: false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(handlers.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('slug unchanged "pagina-existente"')
    );
    expect(handlers.windowBrowserViews.size).toBe(0);
  });

  it('empty slug: warns and returns before any side effect', async () => {
    const handlers = await freshHandlers();
    const handler = await getContentSavedHandler(handlers);

    handler(mockEvent, { slug: '   ', isNew: true });

    expect(handlers.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('empty slug')
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handlers.windowBrowserViews.size).toBe(0);
  });

  it('non-ASCII slug with spaces is percent-encoded per segment, / preserved', async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const handlers = await freshHandlers();
    const handler = await getContentSavedHandler(handlers);

    handler(mockEvent, { slug: 'Página com Acento e Espaço', isNew: true });
    await vi.waitFor(() => {
      expect(viewerViewOf(handlers).webContents.loadURL).toHaveBeenCalled();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://preview.local/P%C3%A1gina%20com%20Acento%20e%20Espa%C3%A7o/',
      expect.anything()
    );
    expect(viewerViewOf(handlers).webContents.loadURL).toHaveBeenCalledWith(
      'http://preview.local/P%C3%A1gina%20com%20Acento%20e%20Espa%C3%A7o/'
    );
  });

  it('devServerUrl without trailing slash is normalized before joining', async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const handlers = await freshHandlers({
      processManager: { getGlobalDevServerUrl: vi.fn(() => 'http://preview.local') }
    });
    const handler = await getContentSavedHandler(handlers);

    handler(mockEvent, { slug: 'sub/dir-page', isNew: true });
    await vi.waitFor(() => {
      expect(viewerViewOf(handlers).webContents.loadURL).toHaveBeenCalled();
    });

    expect(viewerViewOf(handlers).webContents.loadURL).toHaveBeenCalledWith(
      'http://preview.local/sub/dir-page/'
    );
  });
});
