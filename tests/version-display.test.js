/**
 * @fileoverview Static assertions for dynamic app version display (D4):
 * no hardcoded version literals in locales; window titles versioned at every
 * creation site and on every page via the shared i18n mechanism.
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect } from 'vitest';

// CJS require bypasses setup.js vi.mock('fs'/'path') (pattern:
// tests/static-assertions.test.js) — we need the REAL modules to read files.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LOCALES = ['en', 'pt-BR', 'es'];

/** Extract a `key: "value"` entry from a YAML section (indentation-agnostic). */
function yamlEntry(source, key) {
  const match = source.match(new RegExp(`^\\s+${key}:\\s*"(.*)"\\s*$`, 'm'));
  return match ? match[1] : undefined;
}

describe('Locales carry no hardcoded version (D4)', () => {
  for (const locale of LOCALES) {
    it(`src/locales/${locale}.yaml about_version uses {version} interpolation`, () => {
      const source = read(`src/locales/${locale}.yaml`);
      const value = yamlEntry(source, 'about_version');
      expect(value).toBe('Documental {version}');
      expect(value).not.toMatch(/\d+\.\d+\.\d+/);
    });

    it(`src/locales/${locale}.yaml has no "Documental 1" literal anywhere`, () => {
      const source = read(`src/locales/${locale}.yaml`);
      expect(source).not.toContain('Documental 1');
    });
  }

  it('src/locales_original/ about_version still pristine (untouched guard)', () => {
    // Guardrail: the pristine originals must keep their historical content —
    // proves no accidental write leaked into locales_original/.
    for (const locale of LOCALES) {
      const source = read(`src/locales_original/${locale}.yaml`);
      expect(yamlEntry(source, 'about_version')).toBe('Documental 1.0.0');
    }
  });
});

describe('Window titles are versioned at creation (D4)', () => {
  it('windowManager.js has no hardcoded title: \'Documental\' literal', () => {
    const source = read('src/main/window/windowManager.js');
    expect(source).not.toMatch(/title:\s*'Documental'/);
  });

  it('windowManager.js imports app and uses getVersionedTitle at all creation sites', () => {
    const source = read('src/main/window/windowManager.js');
    expect(source).toMatch(/const \{ BrowserWindow, Menu, app \} = require\('electron'\)/);
    expect(source).toMatch(/function getVersionedTitle\(base = 'Documental'\)/);
    expect(source).toMatch(/app\.getVersion\(\)/);
    const uses = source.match(/title: getVersionedTitle\(\)/g) || [];
    expect(uses.length).toBe(3);
  });

  it('system.js registers app:get-version returning app.getVersion()', () => {
    const source = read('src/ipc/system.js');
    expect(source).toMatch(
      /ipcMain\.handle\('app:get-version',\s*\(\)\s*=>\s*app\.getVersion\(\)\)/
    );
  });
});

describe('Per-page document.title carries the version (D4)', () => {
  it('i18n-apply.js appends version via withVersion and exports it', () => {
    const source = read('renderer/shared/i18n-apply.js');
    expect(source).toMatch(/async function withVersion\(title\)/);
    expect(source).toMatch(/document\.title = await withVersion\(window\.__t\(docTitleKey\)\)/);
    expect(source).toMatch(/module\.exports = \{ applyTranslations, withVersion, getAppVersion \}/);
    expect(source).toMatch(/window\.Documental\.withVersion = withVersion/);
  });

  it('main.html has data-i18n-document-title="main.page_title" and includes i18n-apply.js', () => {
    const source = read('renderer/main.html');
    expect(source).toMatch(
      /<html[^>]*data-i18n-document-title="main\.page_title"/
    );
    expect(source).toMatch(/<script src="\.\/shared\/i18n-apply\.js"><\/script>/);
    expect(source).toMatch(/window\.Documental\.applyTranslations\(\)/);
  });

  it('main.html About modal interpolates {version} from Alpine appVersion state', () => {
    const source = read('renderer/main.html');
    expect(source).toMatch(/appVersion: '',/);
    expect(source).toMatch(/getAppVersion\?\.\(\)/);
    expect(source).toMatch(
      /__t\('main\.about_version', \{ version: appVersion \}\)/
    );
  });

  it('welcome.html and repo-select.html version their direct document.title writes', () => {
    const welcome = read('renderer/welcome.html');
    expect(welcome).toMatch(/withVersion\(baseTitle\)/);
    expect(welcome).not.toMatch(/document\.title = __t\('welcome\.page_title'\);/);

    const repoSelect = read('renderer/repo-select.html');
    expect(repoSelect).toMatch(
      /await window\.Documental\.withVersion\(window\.__t\('repo_select\.page_title'\)\)/
    );
  });

  it('index.html and all-projects.html opt into the central document.title mechanism', () => {
    const index = read('renderer/index.html');
    expect(index).toMatch(/data-i18n-document-title="index\.page_title"/);
    expect(index).toMatch(/shared\/i18n-apply\.js/);

    const allProjects = read('renderer/all-projects.html');
    expect(allProjects).toMatch(/data-i18n-document-title="all_projects\.page_title"/);
    expect(allProjects).toMatch(/shared\/i18n-apply\.js/);
  });

  it('language.html (first-run, pre-locale) is left without the version mechanism', () => {
    const source = read('renderer/language.html');
    expect(source).not.toMatch(/data-i18n-document-title/);
    expect(source).not.toMatch(/getAppVersion/);
  });
});
