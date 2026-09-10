/**
 * @fileoverview Task 3 (plan: ajustes-wizard-preview-servicos) — preload
 * postSave → cms:content-saved contract.
 *
 * The Sveltia postSave payload carries `entry` as an Immutable Map whose
 * new-page flag is serialized as `newRecord` (Decap CMS compat — see
 * sveltia-cms/src/lib/services/contents/api/entries.js createEntryMap),
 * NOT `isNew`. The preload reads both keys defensively.
 *
 * Live channels cms:page-loaded / cms:slug-changed must stay untouched by
 * the new send: they are asserted to NOT fire from the postSave path in
 * these scenarios (no slug input in the DOM).
 *
 * @author Documental Team
 * @since 1.0.0
 */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ipcSendMock = vi.fn();
const registerEventListenerMock = vi.fn();

function immutableLike(values) {
  return { get: (key) => values[key] };
}

async function loadPreloadAndGetPostSaveHandler() {
  await import('../../src/preload/sveltia-cms-preload.js');

  const registration = registerEventListenerMock.mock.calls
    .map(([config]) => config)
    .find((config) => config?.name === 'postSave');
  expect(registration).toBeTypeOf('object');
  expect(registration.handler).toBeTypeOf('function');
  return registration.handler;
}

function installDomSlug(value) {
  document.body.innerHTML = '';
  if (value === null) return;
  const section = document.createElement('section');
  section.setAttribute('data-key-path', 'slug');
  const input = document.createElement('input');
  input.value = value;
  section.appendChild(input);
  document.body.appendChild(section);
}

describe('preload postSave handler → cms:content-saved', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    ipcSendMock.mockClear();

    // In-place mutation of the shared electron mock (see tests/__mocks__/electron.js):
    // reassigning global.mockElectron itself is invisible to the CJS require alias.
    global.mockElectron.ipcRenderer = {
      send: ipcSendMock,
      on: vi.fn(),
      once: vi.fn(),
      invoke: vi.fn(),
      removeAllListeners: vi.fn()
    };
    global.mockElectron.contextBridge = { exposeInMainWorld: vi.fn() };

    window.CMS = { registerEventListener: registerEventListenerMock };
    installDomSlug(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.CMS;
  });

  it('new page (newRecord: true) sends cms:content-saved with the slug', async () => {
    const handler = await loadPreloadAndGetPostSaveHandler();

    handler({
      entry: immutableLike({ slug: 'nova-pagina-teste', newRecord: true })
    });

    expect(ipcSendMock).toHaveBeenCalledTimes(1);
    expect(ipcSendMock).toHaveBeenCalledWith('cms:content-saved', {
      slug: 'nova-pagina-teste',
      isNew: true
    });
  });

  it('existing page (newRecord: false) does NOT send cms:content-saved', async () => {
    const handler = await loadPreloadAndGetPostSaveHandler();

    handler({
      entry: immutableLike({ slug: 'pagina-existente', newRecord: false })
    });

    expect(ipcSendMock).not.toHaveBeenCalled();
  });

  it('entry without slug does NOT send cms:content-saved', async () => {
    const handler = await loadPreloadAndGetPostSaveHandler();

    handler({
      entry: immutableLike({ newRecord: true, slug: undefined })
    });

    expect(ipcSendMock).not.toHaveBeenCalled();
  });

  it('payload divergence fallback: no newRecord flag + initialSlug null + DOM slug present → sends DOM slug', async () => {
    installDomSlug('pagina-via-dom');
    const handler = await loadPreloadAndGetPostSaveHandler();

    handler({ entry: immutableLike({ slug: undefined, newRecord: undefined }) });

    expect(ipcSendMock).toHaveBeenCalledTimes(1);
    expect(ipcSendMock).toHaveBeenCalledWith('cms:content-saved', {
      slug: 'pagina-via-dom',
      isNew: true
    });
  });

  it('non-Map entry (defensive) does not throw and does not send without DOM slug', async () => {
    const handler = await loadPreloadAndGetPostSaveHandler();

    expect(() => handler({ entry: null })).not.toThrow();
    expect(() => handler({})).not.toThrow();
    expect(ipcSendMock).not.toHaveBeenCalled();
  });
});
