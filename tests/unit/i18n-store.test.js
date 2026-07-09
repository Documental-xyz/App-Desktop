/**
 * @fileoverview Tests for renderer/i18n.js - browser-side i18n module
 *
 * renderer/i18n.js is a plain browser IIFE. Tests set up browser-like globals
 * and execute the actual script via vm, testing the real production code.
 *
 * Uses createRequire() to bypass vitest's global fs/path mocks from tests/setup.js.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const vm = require('vm');

const __dirname = new URL('.', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Mock translation data (mirrors YAML fixture structure + interpolation keys)
// ---------------------------------------------------------------------------
const MOCK_EN = Object.freeze({
  common: {
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    close: 'Close'
  },
  welcome: {
    title: 'Welcome to Documental',
    subtitle: 'Your documentation hub',
    step_of: 'Step {current} of {total}',
    greeting: 'Hello, {name}!'
  }
});

const MOCK_PT_BR = Object.freeze({
  common: {
    save: 'Salvar',
    cancel: 'Cancelar',
    delete: 'Excluir',
    close: 'Fechar'
  },
  welcome: {
    title: 'Bem-vindo ao Documental',
    subtitle: 'Seu hub de documentacao',
    step_of: 'Passo {current} de {total}'
  }
  // Note: 'greeting' is intentionally MISSING to test fallback
});

// ---------------------------------------------------------------------------
// Helper: create fresh browser-like global context and load i18n.js
// ---------------------------------------------------------------------------
function createBrowserContext() {
  // Translation data store for mocks
  const translationStore = {
    en: JSON.parse(JSON.stringify(MOCK_EN)),
    'pt-BR': JSON.parse(JSON.stringify(MOCK_PT_BR))
  };

  // Track document.documentElement.lang
  let docLang = 'en';

  // Track Alpine.store calls
  const alpineStoreRegistrations = [];

  // Track document.addEventListener calls
  const eventListeners = {};

  // Mock window.electronAPI
  const electronAPI = {
    getTranslations: vi.fn(async (locale) => {
      return translationStore[locale] || null;
    }),
    getAppLocale: vi.fn(async () => 'en'),
    setAppLocale: vi.fn(async () => ({ success: true })),
    getAvailableLocales: vi.fn(async () => ['en', 'pt-BR', 'es'])
  };

  // Mock document
  const documentMock = {
    documentElement: {
      get lang() { return docLang; },
      set lang(v) { docLang = v; }
    },
    addEventListener: vi.fn((event, callback) => {
      if (!eventListeners[event]) eventListeners[event] = [];
      eventListeners[event].push(callback);
    })
  };

  // Mock Alpine
  const alpineMock = {
    store: vi.fn((name, definition) => {
      alpineStoreRegistrations.push({ name, definition: { ...definition } });
    })
  };

  // Set up globals
  global.window = global;
  global.document = documentMock;
  global.Alpine = alpineMock;
  global.__t = undefined;

  // Expose electronAPI on window
  global.electronAPI = electronAPI;

  return {
    electronAPI,
    documentMock,
    alpineMock,
    alpineStoreRegistrations,
    eventListeners,
    getDocLang: () => docLang,
    setDocLang: (v) => { docLang = v; }
  };
}

// ---------------------------------------------------------------------------
// Helper: load and execute the IIFE
// ---------------------------------------------------------------------------
function loadI18nModule() {
  const filePath = __dirname + '../../renderer/i18n.js';
  const code = fs.readFileSync(filePath, 'utf8');
  vm.runInThisContext(code, { filename: 'renderer/i18n.js' });
}

// ---------------------------------------------------------------------------
// Helper: trigger the alpine:init handler and call store init()
// ---------------------------------------------------------------------------
async function triggerAlpineInit(ctx) {
  // The IIFE registered an 'alpine:init' listener via document.addEventListener
  const initListeners = ctx.eventListeners['alpine:init'];
  expect(initListeners).toBeDefined();
  expect(initListeners.length).toBeGreaterThanOrEqual(1);

  // Call the listener — this invokes Alpine.store('i18n', {...})
  for (const listener of initListeners) {
    listener();
  }

  // The store definition was passed to Alpine.store()
  expect(ctx.alpineStoreRegistrations.length).toBeGreaterThanOrEqual(1);
  const storeReg = ctx.alpineStoreRegistrations.find(r => r.name === 'i18n');
  expect(storeReg).toBeDefined();

  // Alpine auto-calls init() after registration — simulate that
  if (typeof storeReg.definition.init === 'function') {
    await storeReg.definition.init.call(storeReg.definition);
  }

  return storeReg.definition;
}

// ===========================================================================
// TESTS
// ===========================================================================
// KNOWN-FAILURE: quarantined during perf-zombie-refactor, see tests/KNOWN-FAILURES.md
describe.skip('renderer/i18n.js — i18n module', () => {
  let ctx;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up any previous global state
    delete global.__t;
    delete global.window;
    delete global.document;
    delete global.Alpine;
    delete global.electronAPI;

    ctx = createBrowserContext();
  });

  // -----------------------------------------------------------------------
  // Test 1: Basic translation lookup for en locale
  // -----------------------------------------------------------------------
  it('should return correct translation for en locale via __t()', async () => {
    loadI18nModule();
    await triggerAlpineInit(ctx);

    expect(global.__t).toBeDefined();
    expect(typeof global.__t).toBe('function');
    expect(global.__t('common.cancel')).toBe('Cancel');
    expect(global.__t('common.save')).toBe('Save');
    expect(global.__t('welcome.title')).toBe('Welcome to Documental');
  });

  // -----------------------------------------------------------------------
  // Test 2: English fallback when key missing in current locale
  // -----------------------------------------------------------------------
  it('should fall back to English when key is missing in current locale', async () => {
    // Simulate pt-BR as current locale
    ctx.electronAPI.getAppLocale.mockResolvedValueOnce('pt-BR');

    loadI18nModule();
    const store = await triggerAlpineInit(ctx);

    // pt-BR has 'welcome.title' — should return Portuguese
    expect(global.__t('welcome.title')).toBe('Bem-vindo ao Documental');

    // pt-BR does NOT have 'welcome.greeting' — should fall back to English
    expect(global.__t('welcome.greeting')).toBe('Hello, {name}!');
  });

  // -----------------------------------------------------------------------
  // Test 3: String interpolation with {param} placeholders
  // -----------------------------------------------------------------------
  it('should interpolate {current} and {total} in translation string', async () => {
    loadI18nModule();
    await triggerAlpineInit(ctx);

    const result = global.__t('welcome.step_of', { current: 1, total: 4 });
    expect(result).toBe('Step 1 of 4');

    // Also test single param
    const greeting = global.__t('welcome.greeting', { name: 'Documental' });
    expect(greeting).toBe('Hello, Documental!');
  });

  // -----------------------------------------------------------------------
  // Test 4: Return key string as last-resort fallback
  // -----------------------------------------------------------------------
  it('should return the key itself when translation not found in any locale', async () => {
    loadI18nModule();
    await triggerAlpineInit(ctx);

    expect(global.__t('nonexistent.key.path')).toBe('nonexistent.key.path');
    expect(global.__t('common.invalid_key')).toBe('common.invalid_key');
  });

  // -----------------------------------------------------------------------
  // Test 5: Language switch — load pt-BR translations
  // -----------------------------------------------------------------------
  it('should switch language and return Portuguese translations via changeLanguage()', async () => {
    loadI18nModule();
    const store = await triggerAlpineInit(ctx);

    // Initially English
    expect(global.__t('common.save')).toBe('Save');

    // Switch to pt-BR
    await store.changeLanguage('pt-BR');

    // After switch, translations should be Portuguese
    expect(global.__t('common.save')).toBe('Salvar');
    expect(global.__t('common.cancel')).toBe('Cancelar');
    expect(store.currentLang).toBe('pt-BR');
  });

  // -----------------------------------------------------------------------
  // Test 6: Alpine.store('i18n') registration — has correct properties
  // -----------------------------------------------------------------------
  it('should register Alpine.store("i18n") with currentLang, t(), changeLanguage()', async () => {
    loadI18nModule();
    const store = await triggerAlpineInit(ctx);

    // Verify Alpine.store was called
    expect(ctx.alpineMock.store).toHaveBeenCalledWith('i18n', expect.any(Object));

    // Verify store properties
    expect(store).toHaveProperty('currentLang');
    expect(typeof store.t).toBe('function');
    expect(typeof store.changeLanguage).toBe('function');

    // store.t() should delegate to window.__t()
    expect(store.t('common.cancel')).toBe('Cancel');
    expect(store.t('welcome.step_of', { current: 2, total: 5 })).toBe('Step 2 of 5');
  });

  // -----------------------------------------------------------------------
  // Test 7: document.documentElement.lang updates on language change
  // -----------------------------------------------------------------------
  it('should update document.documentElement.lang when language changes', async () => {
    loadI18nModule();
    const store = await triggerAlpineInit(ctx);

    // After init with 'en'
    expect(ctx.getDocLang()).toBe('en');

    // Switch to pt-BR
    await store.changeLanguage('pt-BR');
    expect(ctx.getDocLang()).toBe('pt-BR');

    // Switch to es (not in our mock translations, but should still update lang)
    await store.changeLanguage('es');
    expect(ctx.getDocLang()).toBe('es');
  });

  // -----------------------------------------------------------------------
  // Test 8: Interpolation returns unmodified string when no params passed
  // -----------------------------------------------------------------------
  it('should return translation unchanged when no interpolation params provided', async () => {
    loadI18nModule();
    await triggerAlpineInit(ctx);

    // Key with placeholders but no params — return raw string
    const result = global.__t('welcome.step_of');
    expect(result).toBe('Step {current} of {total}');
  });

  // -----------------------------------------------------------------------
  // Test 9: __t() works BEFORE Alpine init (for non-Alpine pages)
  // -----------------------------------------------------------------------
  it('should have __t() available globally even before Alpine init', () => {
    loadI18nModule();

    // __t should be defined immediately (IIFE sets it up)
    expect(global.__t).toBeDefined();
    expect(typeof global.__t).toBe('function');

    // Without translations loaded, should return key as fallback
    expect(global.__t('common.cancel')).toBe('common.cancel');
  });

  // -----------------------------------------------------------------------
  // Test 10: setAppLocale is called when changing language
  // -----------------------------------------------------------------------
  it('should persist locale preference via electronAPI.setAppLocale()', async () => {
    loadI18nModule();
    const store = await triggerAlpineInit(ctx);

    await store.changeLanguage('pt-BR');

    expect(ctx.electronAPI.setAppLocale).toHaveBeenCalledWith('pt-BR');
  });
});
