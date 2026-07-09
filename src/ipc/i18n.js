/**
 * @fileoverview IPC handlers for i18n (internationalization) operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { app, ipcMain: electronIpcMain } = require('electron');

const fsp = fs.promises;

const AVAILABLE_LOCALES = ['en', 'pt-BR', 'es'];
const DEFAULT_LOCALE = 'en';
let _cachedLocale = DEFAULT_LOCALE;

function getLocalesPath(isPackaged, appPath) {
  if (isPackaged) {
    return path.join(appPath, 'src', 'locales');
  }
  return path.join(process.cwd(), 'src', 'locales');
}

async function readYamlTranslations(locale, localesPath) {
  const filePath = path.join(localesPath, `${locale}.yaml`);
  try {
    await fsp.access(filePath);
  } catch {
    return null;
  }
  const content = await fsp.readFile(filePath, 'utf8');
  return yaml.load(content);
}

async function getLocale(db) {
  const row = await db.get(
    'SELECT value FROM settings WHERE key = ?',
    ['locale']
  );
  return row ? row.value : DEFAULT_LOCALE;
}

async function setLocale(db, locale) {
  await db.run(
    'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
    ['locale', locale]
  );
}

async function getTranslations(locale, localesPath) {
  const translations = await readYamlTranslations(locale, localesPath);
  if (translations) {
    return translations;
  }
  return await readYamlTranslations(DEFAULT_LOCALE, localesPath);
}

function getAvailableLocales() {
  return [...AVAILABLE_LOCALES];
}

class I18nHandlers {
  constructor({ logger, databaseManager, ipcMain }) {
    this.logger = logger;
    this.databaseManager = databaseManager;

    // Cache initial locale for sync access — with error handling for first-run (DB not initialized)
    (async () => {
      try {
        const db = await this.databaseManager.getDatabase();
        const locale = await getLocale(db);
        _cachedLocale = locale;
      } catch (error) {
        this.logger.warn('Could not load locale from database, using default:', error.message);
      }
    })();

    this.ipcMain = ipcMain || electronIpcMain;
    this.localesPath = getLocalesPath(
      app ? app.isPackaged : false,
      app ? app.getAppPath() : process.cwd()
    );
  }

  registerHandlers() {
    this.logger.info('🌐 Registering i18n IPC handlers');

    this.ipcMain.handle('i18n:get-translations', async (_event, locale) => {
      const resolvedLocale = locale || await getLocale(await this.databaseManager.getDatabase());
      return await getTranslations(resolvedLocale, this.localesPath);
    });

    this.ipcMain.handle('i18n:get-translations-sync', async (_event, locale) => {
      try {
        return await readYamlTranslations(locale, this.localesPath);
      } catch (error) {
        this.logger.error('Error loading translations sync:', error);
        return null;
      }
    });

    this.ipcMain.handle('i18n:get-locale', async () => {
      return getLocale(await this.databaseManager.getDatabase());
    });

    // Sync version for initial page load (reads from memory cache)
    this.ipcMain.on('i18n:get-locale-sync', (event) => {
      event.returnValue = _cachedLocale;
    });

    this.ipcMain.handle('i18n:set-locale', async (_event, locale) => {
      const db = await this.databaseManager.getDatabase();
      await setLocale(db, locale);
      _cachedLocale = locale;  // Update cache immediately for sync reads
      return { success: true };
    });

    this.ipcMain.handle('i18n:get-available-locales', async () => {
      return getAvailableLocales();
    });

    this.logger.info('✅ i18n IPC handlers registered');
  }

  unregisterHandlers() {
    this.ipcMain.removeHandler('i18n:get-translations');
    this.ipcMain.removeHandler('i18n:get-translations-sync');
    this.ipcMain.removeHandler('i18n:get-locale');
    this.ipcMain.removeAllListeners('i18n:get-locale-sync');
    this.ipcMain.removeHandler('i18n:set-locale');
    this.ipcMain.removeHandler('i18n:get-available-locales');
    this.logger.info('🔌 i18n IPC handlers unregistered');
  }
}

module.exports = {
  I18nHandlers,
  readYamlTranslations,
  getLocale,
  setLocale,
  getTranslations,
  getAvailableLocales,
  getLocalesPath
};
