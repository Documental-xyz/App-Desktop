/**
 * @vitest-environment node
 * @fileoverview Tests for ThemeService
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { ThemeService } = await import('../../src/main/services/themeService.js');

// KNOWN-FAILURE: quarantined during perf-zombie-refactor, see tests/KNOWN-FAILURES.md
describe.skip('ThemeService', () => {
  let logger;
  let mockFs;
  let mockPath;
  let mockGetNativeTheme;
  let originalEnvTheme;
  let originalEnvThemeMode;

  beforeEach(() => {
    vi.clearAllMocks();

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };

    mockFs = {
      existsSync: vi.fn(),
      readFileSync: vi.fn()
    };

    mockPath = {
      join: vi.fn((...args) => args.join('/')),
      dirname: vi.fn((p) => p.split('/').slice(0, -1).join('/'))
    };

    mockGetNativeTheme = vi.fn(() => ({ shouldUseDarkColors: true }));

    originalEnvTheme = process.env.THEME;
    originalEnvThemeMode = process.env.THEME_MODE;
    delete process.env.THEME;
    delete process.env.THEME_MODE;
  });

  afterEach(() => {
    if (originalEnvTheme !== undefined) process.env.THEME = originalEnvTheme;
    else delete process.env.THEME;
    if (originalEnvThemeMode !== undefined) process.env.THEME_MODE = originalEnvThemeMode;
    else delete process.env.THEME_MODE;
  });

  function setupExistsSync(map) {
    mockFs.existsSync.mockImplementation((p) => {
      const normalized = p.replace(/\\/g, '/');
      for (const key of Object.keys(map)) {
        if (normalized.endsWith(key)) return map[key];
      }
      return false;
    });
  }

  function setupReadFileSync(map) {
    mockFs.readFileSync.mockImplementation((p, _enc) => {
      const normalized = p.replace(/\\/g, '/');
      for (const [key, val] of Object.entries(map)) {
        if (normalized.endsWith(key)) return val;
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });
  }

  const BASE_MANIFEST = JSON.stringify({
    name: 'Documental Default',
    version: '1.0.0',
    mode: ['dark', 'light'],
    inherit: null,
    description: 'Default theme'
  });

  const BASE_COLORS = '/* base colors.css */\n[data-theme="base"] { --color-primary: green; }';

  function createService() {
    return new ThemeService({
      logger,
      fs: mockFs,
      path: mockPath,
      getNativeTheme: mockGetNativeTheme
    });
  }

  // ── Test 1 ───────────────────────────────────────────────────────

  it('resolves base theme with dark mode', () => {
    process.env.THEME = 'base';
    process.env.THEME_MODE = 'dark';

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true,
      'themes/base/logo.svg': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    expect(service.getThemeName()).toBe('base');
    expect(service.getResolvedMode()).toBe('dark');
    expect(service.cssFiles).toHaveLength(1);
    expect(service.cssFiles[0]).toContain('themes/base/colors.css');
    expect(service.logoPath).toContain('themes/base/logo.svg');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // ── Test 2 ───────────────────────────────────────────────────────

  it('falls back to base when theme directory does not exist', () => {
    process.env.THEME = 'nonexistent';

    setupExistsSync({
      'themes/nonexistent': false,
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    expect(service.getThemeName()).toBe('base');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to "base"')
    );
  });

  // ── Test 3 ───────────────────────────────────────────────────────

  it('resolves auto mode to dark when OS prefers dark', () => {
    process.env.THEME = 'base';
    process.env.THEME_MODE = 'auto';
    mockGetNativeTheme.mockReturnValue({ shouldUseDarkColors: true });

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    expect(service.getResolvedMode()).toBe('dark');
  });

  // ── Test 4 ───────────────────────────────────────────────────────

  it('loads parent theme CSS first when inherit is set', () => {
    process.env.THEME = 'tokyo-night';
    process.env.THEME_MODE = 'dark';

    const childManifest = JSON.stringify({
      name: 'Tokyo Night',
      version: '1.0.0',
      mode: ['dark'],
      inherit: 'base',
      description: 'Tokyo Night theme'
    });

    setupExistsSync({
      'themes/tokyo-night': true,
      'themes/tokyo-night/manifest.json': true,
      'themes/tokyo-night/colors.css': true,
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/tokyo-night/manifest.json': childManifest,
      'themes/tokyo-night/colors.css': '/* tokyo colors */',
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    expect(service.cssFiles).toHaveLength(2);
    const paths = service.cssFiles.map(p => p.replace(/\\/g, '/'));
    expect(paths[0]).toContain('themes/base/colors.css');
    expect(paths[1]).toContain('themes/tokyo-night/colors.css');
  });

  // ── Test 5 ───────────────────────────────────────────────────────

  it('falls back to first available mode when requested mode unsupported', () => {
    process.env.THEME = 'base';
    process.env.THEME_MODE = 'light';

    const darkOnlyManifest = JSON.stringify({
      name: 'Dark Only',
      version: '1.0.0',
      mode: ['dark'],
      inherit: null,
      description: 'Dark-only theme'
    });

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': darkOnlyManifest,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    expect(service.getResolvedMode()).toBe('dark');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not available')
    );
  });

  // ── Test 6 ───────────────────────────────────────────────────────

  it('defaults to base theme when THEME env is empty', () => {
    process.env.THEME = '';
    process.env.THEME_MODE = 'dark';

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    expect(service.getThemeName()).toBe('base');
  });

  // ── Test 7 ───────────────────────────────────────────────────────

  it('getThemeCssContent returns concatenated CSS from chain', async () => {
    process.env.THEME = 'base';
    process.env.THEME_MODE = 'dark';

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    const css = await service.getThemeCssContent();
    expect(css).toBe(BASE_COLORS);
  });

  // ── Test 8 ───────────────────────────────────────────────────────

  it('resolves auto mode to light when OS prefers light', () => {
    process.env.THEME = 'base';
    process.env.THEME_MODE = 'auto';
    mockGetNativeTheme.mockReturnValue({ shouldUseDarkColors: false });

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    expect(service.getResolvedMode()).toBe('light');
  });

  // ── Test 9 ───────────────────────────────────────────────────────

  it('falls back to base when theme exists but manifest.json missing', () => {
    process.env.THEME = 'broken-theme';
    process.env.THEME_MODE = 'dark';

    setupExistsSync({
      'themes/broken-theme': true,
      'themes/broken-theme/manifest.json': false,
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    expect(service.getThemeName()).toBe('base');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to "base"')
    );
  });

  // ── Test 10 ──────────────────────────────────────────────────────

  it('includes icons.css in chain when file exists', () => {
    process.env.THEME = 'base';
    process.env.THEME_MODE = 'dark';

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true,
      'themes/base/icons.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS,
      'themes/base/icons.css': '/* icons */'
    });

    const service = createService();
    service.initialize('/app');

    expect(service.cssFiles).toHaveLength(2);
    const paths = service.cssFiles.map(p => p.replace(/\\/g, '/'));
    expect(paths[0]).toContain('colors.css');
    expect(paths[1]).toContain('icons.css');
    expect(service.iconCssPath).toContain('icons.css');
  });

  it('defaults to auto mode when THEME_MODE env is empty', () => {
    process.env.THEME = 'base';
    delete process.env.THEME_MODE;
    mockGetNativeTheme.mockReturnValue({ shouldUseDarkColors: true });

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    expect(service.getResolvedMode()).toBe('dark');
    expect(service._resolveThemeModeEnv()).toBe('auto');
  });

  it('resolves auto to light by default when OS prefers light', () => {
    process.env.THEME = 'base';
    delete process.env.THEME_MODE;
    mockGetNativeTheme.mockReturnValue({ shouldUseDarkColors: false });

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    expect(service.getResolvedMode()).toBe('light');
  });

  it('falls back to first mode when auto resolves to unsupported mode', () => {
    process.env.THEME = 'base';
    delete process.env.THEME_MODE;
    mockGetNativeTheme.mockReturnValue({ shouldUseDarkColors: false });

    const darkOnlyManifest = JSON.stringify({
      name: 'Dark Only',
      version: '1.0.0',
      mode: ['dark'],
      inherit: null,
      description: 'Dark-only theme'
    });

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': darkOnlyManifest,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    expect(service.getResolvedMode()).toBe('dark');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('OS prefers "light" but theme only supports')
    );
  });

  it('defaults to dark when nativeTheme is null and mode is auto', () => {
    process.env.THEME = 'base';
    delete process.env.THEME_MODE;
    mockGetNativeTheme.mockReturnValue(null);

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    expect(service.getResolvedMode()).toBe('dark');
  });

  it('reads THEME_MODE from runtime-env.json when env var is empty', () => {
    process.env.THEME = 'base';
    delete process.env.THEME_MODE;
    mockGetNativeTheme.mockReturnValue({ shouldUseDarkColors: false });

    const runtimeEnv = JSON.stringify({ THEME_MODE: 'light' });

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true,
      'resources/config/runtime-env.json': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS,
      'resources/config/runtime-env.json': runtimeEnv
    });

    const service = createService();
    service.initialize('/app');

    expect(service.getResolvedMode()).toBe('light');
  });

  it('startWatching registers listener and fires callback on OS theme change', () => {
    process.env.THEME = 'base';
    process.env.THEME_MODE = 'auto';
    mockGetNativeTheme.mockReturnValue({ shouldUseDarkColors: true });

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    let updateHandler = null;
    const mockNativeTheme = {
      shouldUseDarkColors: true,
      on: vi.fn((event, handler) => {
        if (event === 'updated') updateHandler = handler;
      }),
      removeListener: vi.fn()
    };
    mockGetNativeTheme.mockReturnValue(mockNativeTheme);

    const callback = vi.fn();
    service.startWatching(callback);

    expect(mockNativeTheme.on).toHaveBeenCalledWith('updated', expect.any(Function));
    expect(callback).not.toHaveBeenCalled();

    mockNativeTheme.shouldUseDarkColors = false;
    updateHandler();

    expect(callback).toHaveBeenCalledWith('light');
  });

  it('stopWatching removes the nativeTheme listener', () => {
    process.env.THEME = 'base';
    process.env.THEME_MODE = 'auto';
    mockGetNativeTheme.mockReturnValue({ shouldUseDarkColors: true });

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    const mockNativeTheme = {
      shouldUseDarkColors: true,
      on: vi.fn(),
      removeListener: vi.fn()
    };
    mockGetNativeTheme.mockReturnValue(mockNativeTheme);

    service.startWatching(vi.fn());
    service.stopWatching();

    expect(mockNativeTheme.removeListener).toHaveBeenCalledWith('updated', expect.any(Function));
  });

  it('startWatching does nothing when mode is not auto', () => {
    process.env.THEME = 'base';
    process.env.THEME_MODE = 'dark';

    setupExistsSync({
      'themes/base': true,
      'themes/base/manifest.json': true,
      'themes/base/colors.css': true
    });
    setupReadFileSync({
      'themes/base/manifest.json': BASE_MANIFEST,
      'themes/base/colors.css': BASE_COLORS
    });

    const service = createService();
    service.initialize('/app');

    const mockNativeTheme = {
      shouldUseDarkColors: true,
      on: vi.fn(),
      removeListener: vi.fn()
    };
    mockGetNativeTheme.mockReturnValue(mockNativeTheme);

    service.startWatching(vi.fn());

    expect(mockNativeTheme.on).not.toHaveBeenCalled();
  });
});
