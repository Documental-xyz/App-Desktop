/**
 * @fileoverview Tests for i18n IPC handlers
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const FIXTURES_PATH = new URL('../fixtures/locales', import.meta.url).pathname;

function createMockDb(initialLocale = null) {
  let storedLocale = initialLocale;
  return {
    get: vi.fn(async (sql, params) => {
      if (sql.includes('settings') && params[0] === 'locale') {
        return storedLocale ? { value: storedLocale } : null;
      }
      return null;
    }),
    run: vi.fn(async (sql, params) => {
      if (sql.includes('settings') && params[0] === 'locale') {
        storedLocale = params[1];
      }
      return { id: 1, changes: 1 };
    })
  };
}

describe('I18n IPC Handlers', () => {
  let mockLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  });

  describe('readYamlTranslations', () => {
    it('should parse en.yaml and return object with expected keys', async () => {
      const { readYamlTranslations } = await import('../../src/ipc/i18n.js');
      const result = await readYamlTranslations('en', FIXTURES_PATH);

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('common');
      expect(result).toHaveProperty('welcome');
      expect(result.common.save).toBe('Save');
      expect(result.common.cancel).toBe('Cancel');
      expect(result.welcome.title).toBe('Welcome to Documental');
    });

    it('should parse pt-BR.yaml and return Portuguese translations', async () => {
      const { readYamlTranslations } = await import('../../src/ipc/i18n.js');
      const result = await readYamlTranslations('pt-BR', FIXTURES_PATH);

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
      expect(result.common.save).toBe('Salvar');
      expect(result.welcome.title).toBe('Bem-vindo ao Documental');
    });

    it('should parse es.yaml and return Spanish translations', async () => {
      const { readYamlTranslations } = await import('../../src/ipc/i18n.js');
      const result = await readYamlTranslations('es', FIXTURES_PATH);

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
      expect(result.common.save).toBe('Guardar');
      expect(result.welcome.title).toBe('Bienvenido a Documental');
    });

    it('should return null when locale file does not exist', async () => {
      const { readYamlTranslations } = await import('../../src/ipc/i18n.js');
      const result = await readYamlTranslations('xx', FIXTURES_PATH);

      expect(result).toBeNull();
    });
  });

  describe('getTranslations', () => {
    it('should fallback to en when locale file does not exist', async () => {
      const { getTranslations } = await import('../../src/ipc/i18n.js');
      const result = await getTranslations('xx', FIXTURES_PATH);

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
      expect(result.common.save).toBe('Save');
      expect(result.welcome.title).toBe('Welcome to Documental');
    });

    it('should return requested locale when it exists', async () => {
      const { getTranslations } = await import('../../src/ipc/i18n.js');
      const result = await getTranslations('es', FIXTURES_PATH);

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
      expect(result.common.save).toBe('Guardar');
    });
  });

  describe('getLocale', () => {
    it('should return default en when no locale is saved in database', async () => {
      const { getLocale } = await import('../../src/ipc/i18n.js');
      const db = createMockDb(null);

      const locale = await getLocale(db);

      expect(locale).toBe('en');
      expect(db.get).toHaveBeenCalledWith(
        expect.stringContaining('settings'),
        ['locale']
      );
    });

    it('should return saved locale from database', async () => {
      const { getLocale } = await import('../../src/ipc/i18n.js');
      const db = createMockDb('es');

      const locale = await getLocale(db);

      expect(locale).toBe('es');
    });
  });

  describe('setLocale', () => {
    it('should save locale to database and be retrievable via getLocale', async () => {
      const { setLocale, getLocale } = await import('../../src/ipc/i18n.js');
      const db = createMockDb(null);

      await setLocale(db, 'es');
      const locale = await getLocale(db);

      expect(locale).toBe('es');
      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining('settings'),
        ['locale', 'es']
      );
    });
  });

  describe('getAvailableLocales', () => {
    it('should return array with en, pt-BR, es', async () => {
      const { getAvailableLocales } = await import('../../src/ipc/i18n.js');
      const locales = getAvailableLocales();

      expect(locales).toEqual(['en', 'pt-BR', 'es']);
      expect(locales).toHaveLength(3);
    });
  });

  describe('getLocalesPath', () => {
    it('should resolve different paths for dev vs production', async () => {
      const { getLocalesPath } = await import('../../src/ipc/i18n.js');
      const devPath = getLocalesPath(false, '/app/path');
      const prodPath = getLocalesPath(true, '/app/path');

      expect(devPath).toBeDefined();
      expect(prodPath).toBeDefined();
      expect(typeof devPath).toBe('string');
      expect(typeof prodPath).toBe('string');
    });
  });

  describe('I18nHandlers class', () => {
    it('should create instance and expose handler methods', async () => {
      const { I18nHandlers } = await import('../../src/ipc/i18n.js');
      const databaseManager = { getDatabase: vi.fn().mockResolvedValue(createMockDb()) };
      const handlers = new I18nHandlers({ logger: mockLogger, databaseManager });

      expect(handlers).toBeDefined();
      expect(typeof handlers.registerHandlers).toBe('function');
      expect(typeof handlers.unregisterHandlers).toBe('function');
    });

    it('should register IPC handlers via injectable ipcMain', async () => {
      const { I18nHandlers } = await import('../../src/ipc/i18n.js');
      const ipcMain = { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
      const databaseManager = { getDatabase: vi.fn().mockResolvedValue(createMockDb()) };
      const handlers = new I18nHandlers({ logger: mockLogger, databaseManager, ipcMain });

      handlers.registerHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith('i18n:get-translations', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('i18n:get-locale', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('i18n:set-locale', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('i18n:get-available-locales', expect.any(Function));
    });
  });
});
