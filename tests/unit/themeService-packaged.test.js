/**
 * @vitest-environment node
 * @fileoverview Regression tests for packaged-app theme resolution.
 *
 * Guards three bridges broken in packaged builds (see
 * .omo/evidence/theme-packaged-bug.md):
 *  1. Directory detection must use stat(), not access() — Electron's asar
 *     fs shim fails access() with ENOENT for asar DIRECTORY entries, which
 *     forced the "base" fallback for every theme in the package.
 *  2. _resolveThemeModeEnv must await loadRuntimeEnv — the async conversion
 *     (862f6ca) left it un-awaited, so THEME_MODE from runtime-env.json was
 *     never read in packaged builds (no process.env fallback there).
 *  3. loadRuntimeEnv must MERGE candidates with the packaged config winning
 *     over a stale userData/runtime-env.json — first-read-wins let a
 *     persisted "base" fallback poison every subsequent launch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/mock/user-data'
  },
  nativeTheme: { shouldUseDarkColors: false }
}));

const { ThemeService } = await import('../../src/main/services/themeService.js');

/**
 * In-memory fs that emulates Electron's asar quirk: access() fails with
 * ENOENT for directories while stat() succeeds. Any code path that regresses
 * to access()-based directory detection fails these tests.
 */
function makeMockFs({ dirs = [], files = {} } = {}) {
  const dirSet = new Set(dirs);
  const fileMap = new Map(Object.entries(files));
  const enoent = (p) => {
    const err = new Error(`ENOENT, ${p} not found in mock`);
    err.code = 'ENOENT';
    return err;
  };
  return {
    promises: {
      access: async (p) => {
        if (dirSet.has(p)) throw enoent(p);
        if (fileMap.has(p)) return;
        throw enoent(p);
      },
      stat: async (p) => {
        if (dirSet.has(p)) return { isDirectory: () => true };
        if (fileMap.has(p)) return { isDirectory: () => false };
        throw enoent(p);
      },
      readFile: async (p) => {
        if (fileMap.has(p)) return fileMap.get(p);
        throw enoent(p);
      },
      writeFile: async (p, content) => {
        fileMap.set(p, content);
      }
    }
  };
}

const mockPath = {
  join: (...args) => args.join('/'),
  dirname: (p) => p.split('/').slice(0, -1).join('/')
};

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const BASE_MANIFEST = JSON.stringify({ name: 'Base', mode: ['dark', 'light'], inherit: null });
const BASE_COLORS = ':root { --gray-100: #f3f4f6; }';
const DOCUMENTAL_MANIFEST = JSON.stringify({ name: 'Documental', mode: ['dark', 'light'], inherit: 'base' });
const DOCUMENTAL_COLORS = [
  '[data-theme="documental"][data-mode="dark"] { --color-accent: #eb592d; }',
  '[data-theme="documental"][data-mode="light"] { --color-accent: #eb592d; }'
].join('\n');

const PACKAGE_RUNTIME_ENV = JSON.stringify({
  THEME: 'documental',
  THEME_MODE: 'light',
  GITHUB_CLIENT_ID: 'pkg-id'
});

function packagedFixture() {
  return {
    dirs: [
      '/app/themes/base',
      '/app/themes/documental',
      '/mock/user-data'
    ],
    files: {
      '/app/themes/base/manifest.json': BASE_MANIFEST,
      '/app/themes/base/colors.css': BASE_COLORS,
      '/app/themes/documental/manifest.json': DOCUMENTAL_MANIFEST,
      '/app/themes/documental/colors.css': DOCUMENTAL_COLORS,
      '/app/renderer/assets/css/variables.css': ':root { --gray-100: #f3f4f6; }',
      // Packaged build config (extraResources resources/config -> config)
      '/mock/resources/config/runtime-env.json': PACKAGE_RUNTIME_ENV
    }
  };
}

function makeService(fsMock, databaseManager = null) {
  return new ThemeService({
    logger: noopLogger,
    fs: fsMock,
    path: mockPath,
    getNativeTheme: () => ({ shouldUseDarkColors: false }),
    databaseManager
  });
}

describe('ThemeService packaged resolution', () => {
  let originalResourcesPath;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.THEME;
    delete process.env.THEME_MODE;
    originalResourcesPath = process.resourcesPath;
    process.resourcesPath = '/mock/resources';
  });

  afterEach(() => {
    if (originalResourcesPath === undefined) {
      delete process.resourcesPath;
    } else {
      process.resourcesPath = originalResourcesPath;
    }
  });

  it('awaits loadRuntimeEnv: THEME_MODE is read from runtime-env.json when env is empty', async () => {
    const fsMock = makeMockFs(packagedFixture());
    const service = makeService(fsMock);
    service._appRoot = '/app';

    const mode = await service._resolveThemeModeEnv();
    expect(mode).toBe('light');
    expect(service._rawMode).toBe('light');
  });

  it('prefers process.env.THEME_MODE over runtime-env.json (documented priority)', async () => {
    const fsMock = makeMockFs(packagedFixture());
    const service = makeService(fsMock);
    service._appRoot = '/app';
    process.env.THEME_MODE = 'dark';

    expect(await service._resolveThemeModeEnv()).toBe('dark');
    delete process.env.THEME_MODE;
  });

  it('packaged config beats a poisoned userData/runtime-env.json (merge, not first-read-wins)', async () => {
    const fixture = packagedFixture();
    // Legacy file written by an older build after a "base" fallback
    fixture.files['/mock/user-data/runtime-env.json'] = JSON.stringify({
      THEME: 'base',
      THEME_MODE: 'dark'
    });
    const fsMock = makeMockFs(fixture);
    const service = makeService(fsMock);

    expect(await service._resolveThemeName('/app')).toBe('documental');

    service._appRoot = '/app';
    expect(await service._resolveThemeModeEnv()).toBe('light');
  });

  it('detects theme directories via stat() so asar dirs validate (no base fallback)', async () => {
    const fsMock = makeMockFs(packagedFixture());
    const service = makeService(fsMock);

    const validated = await service._validateThemeDir('/app/themes/documental', 'documental');
    expect(validated.themeName).toBe('documental');
    expect(validated.themeDir).toBe('/app/themes/documental');
    expect(noopLogger.warn).not.toHaveBeenCalled();
  });

  it('still falls back to base for a genuinely missing theme directory', async () => {
    const fsMock = makeMockFs(packagedFixture());
    const service = makeService(fsMock);

    const validated = await service._validateThemeDir('/app/themes/missing', 'missing');
    expect(validated.themeName).toBe('base');
    expect(noopLogger.warn).toHaveBeenCalled();
  });

  it('initialize resolves packaged theme and mode end-to-end (no DB)', async () => {
    const fsMock = makeMockFs(packagedFixture());
    const db = { getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => {}) };
    const service = makeService(fsMock, db);

    await service.initialize('/app');

    expect(service.themeName).toBe('documental');
    expect(service._rawMode).toBe('light');
    expect(service.themeMode).toBe('light');
    // Inheritance chain: base colors.css first, then documental
    expect(service.cssFiles).toEqual([
      '/app/themes/base/colors.css',
      '/app/themes/documental/colors.css'
    ]);
  });

  it('saveThemeMode (mode toggle) keeps the resolved theme NAME and theme colors', async () => {
    const fsMock = makeMockFs(packagedFixture());
    const db = { getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => {}) };
    const service = makeService(fsMock, db);
    await service.initialize('/app');
    expect(service.themeName).toBe('documental');

    await service.saveThemeMode('dark');

    expect(db.setSetting).toHaveBeenCalledWith('theme_mode', 'dark');
    expect(service.themeName).toBe('documental');
    expect(service._rawMode).toBe('dark');

    const css = await service.getResolvedCssForMode('dark');
    expect(css).toContain('#eb592d');
    expect(css).not.toMatch(/var\(--orange-500\)/);
  });

  it('database theme_mode still overrides env/file at initialize (persisted-mode design)', async () => {
    const fsMock = makeMockFs(packagedFixture());
    const db = { getSetting: vi.fn(async () => 'dark'), setSetting: vi.fn(async () => {}) };
    const service = makeService(fsMock, db);

    await service.initialize('/app');

    expect(service._rawMode).toBe('dark');
    expect(service.themeMode).toBe('dark');
    expect(service.themeName).toBe('documental');
  });
});
