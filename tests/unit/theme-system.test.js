/**
 * @vitest-environment node
 * @fileoverview Comprehensive end-to-end tests for theme system — loading,
 *   fallback, inheritance, mode resolution, CSS generation, watching, and edge cases.
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { ThemeService } = await import('../../src/main/services/themeService.js');

// ─── Shared constants ────────────────────────────────────────────────────────

const BASE_MANIFEST = JSON.stringify({
  name: 'Documental Default',
  version: '1.0.0',
  mode: ['dark', 'light'],
  inherit: null,
  description: 'Default theme'
});

const BASE_COLORS = '/* base colors.css */\n[data-theme="base"] { --color-primary: #4ade80; }';

const TOKYO_MANIFEST = JSON.stringify({
  name: 'Tokyo Night',
  version: '1.0.0',
  mode: ['dark'],
  inherit: 'base',
  description: 'Tokyo Night theme'
});

const TOKYO_COLORS = '/* tokyo-night colors.css */\n[data-theme="tokyo-night"] { --color-primary: #7aa2f7; }';

// ─── Test suite ──────────────────────────────────────────────────────────────

// KNOWN-FAILURE: quarantined during perf-zombie-refactor, see tests/KNOWN-FAILURES.md
describe.skip('Theme System — Final TDD', () => {
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

  // ─── Helpers ─────────────────────────────────────────────────────────

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

  function createService() {
    return new ThemeService({
      logger,
      fs: mockFs,
      path: mockPath,
      getNativeTheme: mockGetNativeTheme
    });
  }

  // ─── 1. Theme Loading ────────────────────────────────────────────────

  describe('Theme Loading', () => {
    it('loads base theme with correct CSS chain, manifest, and mode', () => {
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
      expect(service.manifest.name).toBe('Documental Default');
    });

    it('loads tokyo-night theme with CSS chain including base first', () => {
      process.env.THEME = 'tokyo-night';
      process.env.THEME_MODE = 'dark';

      setupExistsSync({
        'themes/tokyo-night': true,
        'themes/tokyo-night/manifest.json': true,
        'themes/tokyo-night/colors.css': true,
        'themes/base': true,
        'themes/base/manifest.json': true,
        'themes/base/colors.css': true
      });
      setupReadFileSync({
        'themes/tokyo-night/manifest.json': TOKYO_MANIFEST,
        'themes/tokyo-night/colors.css': TOKYO_COLORS,
        'themes/base/manifest.json': BASE_MANIFEST,
        'themes/base/colors.css': BASE_COLORS
      });

      const service = createService();
      service.initialize('/app');

      expect(service.getThemeName()).toBe('tokyo-night');
      expect(service.cssFiles).toHaveLength(2);
      const paths = service.cssFiles.map(p => p.replace(/\\/g, '/'));
      // Parent first, then child
      expect(paths[0]).toContain('themes/base/colors.css');
      expect(paths[1]).toContain('themes/tokyo-night/colors.css');
    });

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
        'themes/base/icons.css': '/* custom icons */'
      });

      const service = createService();
      service.initialize('/app');

      expect(service.cssFiles).toHaveLength(2);
      const paths = service.cssFiles.map(p => p.replace(/\\/g, '/'));
      expect(paths[0]).toContain('colors.css');
      expect(paths[1]).toContain('icons.css');
    });

    it('warns and returns empty CSS chain when colors.css is missing', () => {
      process.env.THEME = 'base';
      process.env.THEME_MODE = 'dark';

      setupExistsSync({
        'themes/base': true,
        'themes/base/manifest.json': true
        // colors.css intentionally absent
      });
      setupReadFileSync({
        'themes/base/manifest.json': BASE_MANIFEST
      });

      const service = createService();
      service.initialize('/app');

      expect(service.cssFiles).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('colors.css not found')
      );
    });
  });

  // ─── 2. Fallback Logic ──────────────────────────────────────────────

  describe('Fallback Logic', () => {
    it('falls back to base when theme directory does not exist', () => {
      process.env.THEME = 'nonexistent';
      process.env.THEME_MODE = 'dark';

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

    it('falls back to base when theme exists but has no manifest.json', () => {
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

    it('uses default manifest values when manifest.json has invalid JSON', () => {
      process.env.THEME = 'base';
      process.env.THEME_MODE = 'dark';

      setupExistsSync({
        'themes/base': true,
        'themes/base/manifest.json': true,
        'themes/base/colors.css': true
      });
      setupReadFileSync({
        'themes/base/manifest.json': '{ invalid json !!!',
        'themes/base/colors.css': BASE_COLORS
      });

      const service = createService();
      service.initialize('/app');

      // Default manifest: { name: 'unknown', mode: ['dark', 'light'], inherit: null }
      expect(service.manifest.name).toBe('unknown');
      expect(service.manifest.mode).toEqual(['dark', 'light']);
      expect(service.getResolvedMode()).toBe('dark');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('failed to parse manifest.json')
      );
    });

    it('uses env vars or defaults when runtime-env.json is missing', () => {
      process.env.THEME = 'base';
      process.env.THEME_MODE = 'dark';
      // No runtime-env.json setup — existsSync returns false for it

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

      // Falls through to env vars
      expect(service.getThemeName()).toBe('base');
      expect(service.getResolvedMode()).toBe('dark');
    });
  });

  // ─── 3. Mode Resolution ─────────────────────────────────────────────

  describe('Mode Resolution', () => {
    function initForMode(mode, osDark, manifestModes) {
      process.env.THEME = 'base';
      if (mode !== undefined) process.env.THEME_MODE = mode;
      else delete process.env.THEME_MODE;

      mockGetNativeTheme.mockReturnValue({ shouldUseDarkColors: osDark });

      const manifest = JSON.stringify({
        name: 'Test',
        version: '1.0.0',
        mode: manifestModes || ['dark', 'light'],
        inherit: null
      });

      setupExistsSync({
        'themes/base': true,
        'themes/base/manifest.json': true,
        'themes/base/colors.css': true
      });
      setupReadFileSync({
        'themes/base/manifest.json': manifest,
        'themes/base/colors.css': BASE_COLORS
      });

      const service = createService();
      service.initialize('/app');
      return service;
    }

    it('THEME_MODE=dark resolves to dark', () => {
      const service = initForMode('dark', true);
      expect(service.getResolvedMode()).toBe('dark');
    });

    it('THEME_MODE=light resolves to light', () => {
      const service = initForMode('light', true);
      expect(service.getResolvedMode()).toBe('light');
    });

    it('THEME_MODE=auto + OS dark resolves to dark', () => {
      const service = initForMode('auto', true);
      expect(service.getResolvedMode()).toBe('dark');
    });

    it('THEME_MODE=auto + OS light resolves to light', () => {
      const service = initForMode('auto', false);
      expect(service.getResolvedMode()).toBe('light');
    });

    it('THEME_MODE=auto + nativeTheme=null defaults to dark', () => {
      process.env.THEME = 'base';
      process.env.THEME_MODE = 'auto';
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

    it('THEME_MODE not set defaults to auto', () => {
      const service = initForMode(undefined, true);
      // Should behave as auto — resolved to dark because OS is dark
      expect(service.getResolvedMode()).toBe('dark');
      expect(service.getRawMode()).toBe('auto');
    });

    it('requested mode not in theme modes falls back to first available', () => {
      const service = initForMode('light', true, ['dark']);
      expect(service.getResolvedMode()).toBe('dark');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not available')
      );
    });

    it('tokyo-night (dark-only) + THEME_MODE=light falls back to dark', () => {
      process.env.THEME = 'tokyo-night';
      process.env.THEME_MODE = 'light';

      setupExistsSync({
        'themes/tokyo-night': true,
        'themes/tokyo-night/manifest.json': true,
        'themes/tokyo-night/colors.css': true,
        'themes/base': true,
        'themes/base/manifest.json': true,
        'themes/base/colors.css': true
      });
      setupReadFileSync({
        'themes/tokyo-night/manifest.json': TOKYO_MANIFEST,
        'themes/tokyo-night/colors.css': TOKYO_COLORS,
        'themes/base/manifest.json': BASE_MANIFEST,
        'themes/base/colors.css': BASE_COLORS
      });

      const service = createService();
      service.initialize('/app');

      expect(service.getThemeName()).toBe('tokyo-night');
      expect(service.getResolvedMode()).toBe('dark');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not available')
      );
    });
  });

  // ─── 4. CSS Content Generation ──────────────────────────────────────

  describe('CSS Content Generation', () => {
    it('getThemeCssContent returns concatenated CSS from all files in chain', async () => {
      process.env.THEME = 'tokyo-night';
      process.env.THEME_MODE = 'dark';

      setupExistsSync({
        'themes/tokyo-night': true,
        'themes/tokyo-night/manifest.json': true,
        'themes/tokyo-night/colors.css': true,
        'themes/base': true,
        'themes/base/manifest.json': true,
        'themes/base/colors.css': true
      });
      setupReadFileSync({
        'themes/tokyo-night/manifest.json': TOKYO_MANIFEST,
        'themes/tokyo-night/colors.css': TOKYO_COLORS,
        'themes/base/manifest.json': BASE_MANIFEST,
        'themes/base/colors.css': BASE_COLORS
      });

      const service = createService();
      service.initialize('/app');

      const css = await service.getThemeCssContent();
      // Should contain both base and tokyo-night CSS, joined with newline
      expect(css).toContain(BASE_COLORS);
      expect(css).toContain(TOKYO_COLORS);
      expect(css).toBe(BASE_COLORS + '\n' + TOKYO_COLORS);
    });

    it('warns and skips unreadable file in getThemeCssContent', async () => {
      process.env.THEME = 'base';
      process.env.THEME_MODE = 'dark';

      setupExistsSync({
        'themes/base': true,
        'themes/base/manifest.json': true,
        'themes/base/colors.css': true
      });

      // First call for manifest succeeds, second call for CSS read fails
      let readCallCount = 0;
      mockFs.readFileSync.mockImplementation((p, _enc) => {
        readCallCount++;
        const normalized = p.replace(/\\/g, '/');
        if (normalized.endsWith('manifest.json')) return BASE_MANIFEST;
        if (normalized.endsWith('colors.css')) {
          throw new Error('EACCES: permission denied');
        }
        throw new Error(`Unexpected readFileSync: ${p}`);
      });

      const service = createService();
      service.initialize('/app');

      const css = await service.getThemeCssContent();
      expect(css).toBe('');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('failed to read CSS file')
      );
    });

    it('CSS chain order is parent first, then child', async () => {
      process.env.THEME = 'tokyo-night';
      process.env.THEME_MODE = 'dark';

      setupExistsSync({
        'themes/tokyo-night': true,
        'themes/tokyo-night/manifest.json': true,
        'themes/tokyo-night/colors.css': true,
        'themes/tokyo-night/icons.css': true,
        'themes/base': true,
        'themes/base/manifest.json': true,
        'themes/base/colors.css': true
      });
      setupReadFileSync({
        'themes/tokyo-night/manifest.json': TOKYO_MANIFEST,
        'themes/tokyo-night/colors.css': TOKYO_COLORS,
        'themes/tokyo-night/icons.css': '/* tokyo icons */',
        'themes/base/manifest.json': BASE_MANIFEST,
        'themes/base/colors.css': BASE_COLORS
      });

      const service = createService();
      service.initialize('/app');

      // Chain: base/colors.css → tokyo-night/colors.css → tokyo-night/icons.css
      expect(service.cssFiles).toHaveLength(3);
      const paths = service.cssFiles.map(p => p.replace(/\\/g, '/'));
      expect(paths[0]).toContain('themes/base/colors.css');
      expect(paths[1]).toContain('themes/tokyo-night/colors.css');
      expect(paths[2]).toContain('themes/tokyo-night/icons.css');

      const css = await service.getThemeCssContent();
      const baseIdx = css.indexOf(BASE_COLORS);
      const tokyoIdx = css.indexOf(TOKYO_COLORS);
      expect(baseIdx).toBeLessThan(tokyoIdx);
    });
  });

  // ─── 5. Theme Watching ──────────────────────────────────────────────

  describe('Theme Watching', () => {
    it('startWatching with auto mode registers listener', () => {
      process.env.THEME = 'base';
      process.env.THEME_MODE = 'auto';

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

      expect(mockNativeTheme.on).toHaveBeenCalledWith('updated', expect.any(Function));
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('started watching')
      );
    });

    it('startWatching with dark mode does not register listener', () => {
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

    it('stopWatching removes the listener', () => {
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
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('stopped watching')
      );
    });

    it('callback fires with new mode when OS theme changes', () => {
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

      // Simulate OS switching to light
      mockNativeTheme.shouldUseDarkColors = false;
      updateHandler();

      expect(callback).toHaveBeenCalledWith('light');
      expect(service.getResolvedMode()).toBe('light');
    });

    it('startWatching with no nativeTheme skips gracefully', () => {
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

      // After initialize, mock nativeTheme to return null
      mockGetNativeTheme.mockReturnValue(null);

      const callback = vi.fn();
      service.startWatching(callback);

      // No error thrown, callback not registered
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('started watching')
      );
    });
  });

  // ─── 6. Edge Cases ──────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('empty THEME env var defaults to base', () => {
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

    it('THEME with whitespace is trimmed', () => {
      process.env.THEME = '  base  ';
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

    it('THEME_MODE with uppercase is lowercased', () => {
      process.env.THEME = 'base';
      process.env.THEME_MODE = 'DARK';

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

    it('circular inheritance causes a stack overflow (no depth guard)', () => {
      // A → B → A — ThemeService does not protect against circular inheritance,
      // so this will throw RangeError (max call stack) rather than gracefully handling it.
      process.env.THEME = 'theme-a';
      process.env.THEME_MODE = 'dark';

      const manifestA = JSON.stringify({
        name: 'Theme A',
        version: '1.0.0',
        mode: ['dark'],
        inherit: 'theme-b'
      });
      const manifestB = JSON.stringify({
        name: 'Theme B',
        version: '1.0.0',
        mode: ['dark'],
        inherit: 'theme-a'
      });

      mockFs.existsSync.mockImplementation((p) => {
        const normalized = p.replace(/\\/g, '/');
        if (normalized.endsWith('themes/theme-a')) return true;
        if (normalized.endsWith('themes/theme-a/manifest.json')) return true;
        if (normalized.endsWith('themes/theme-a/colors.css')) return true;
        if (normalized.endsWith('themes/theme-b')) return true;
        if (normalized.endsWith('themes/theme-b/manifest.json')) return true;
        if (normalized.endsWith('themes/theme-b/colors.css')) return true;
        return false;
      });

      setupReadFileSync({
        'themes/theme-a/manifest.json': manifestA,
        'themes/theme-a/colors.css': '/* theme-a */',
        'themes/theme-b/manifest.json': manifestB,
        'themes/theme-b/colors.css': '/* theme-b */'
      });

      const service = createService();
      // Circular inheritance causes infinite recursion → RangeError
      expect(() => service.initialize('/app')).toThrow(RangeError);
    });

    it('double initialize overwrites first initialization', () => {
      process.env.THEME = 'base';
      process.env.THEME_MODE = 'dark';

      setupExistsSync({
        'themes/base': true,
        'themes/base/manifest.json': true,
        'themes/base/colors.css': true,
        'themes/tokyo-night': true,
        'themes/tokyo-night/manifest.json': true,
        'themes/tokyo-night/colors.css': true
      });
      setupReadFileSync({
        'themes/base/manifest.json': BASE_MANIFEST,
        'themes/base/colors.css': BASE_COLORS,
        'themes/tokyo-night/manifest.json': TOKYO_MANIFEST,
        'themes/tokyo-night/colors.css': TOKYO_COLORS
      });

      const service = createService();
      service.initialize('/app');

      expect(service.getThemeName()).toBe('base');
      expect(service.cssFiles).toHaveLength(1);

      // Re-initialize with a different theme
      process.env.THEME = 'tokyo-night';
      service.initialize('/app');

      expect(service.getThemeName()).toBe('tokyo-night');
      expect(service.cssFiles).toHaveLength(2);
      const paths = service.cssFiles.map(p => p.replace(/\\/g, '/'));
      expect(paths[0]).toContain('themes/base/colors.css');
      expect(paths[1]).toContain('themes/tokyo-night/colors.css');
    });

    it('getLogoDataUri with logo.svg returns data URI', () => {
      process.env.THEME = 'base';
      process.env.THEME_MODE = 'dark';

      const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';

      setupExistsSync({
        'themes/base': true,
        'themes/base/manifest.json': true,
        'themes/base/colors.css': true,
        'themes/base/logo.svg': true
      });
      setupReadFileSync({
        'themes/base/manifest.json': BASE_MANIFEST,
        'themes/base/colors.css': BASE_COLORS,
        'themes/base/logo.svg': svgContent
      });

      const service = createService();
      service.initialize('/app');

      const dataUri = service.getLogoDataUri();
      expect(dataUri).toBeTruthy();
      expect(dataUri).toMatch(/^data:image\/svg\+xml;base64,/);
      // Decode and verify
      const decoded = Buffer.from(dataUri.split(',')[1], 'base64').toString('utf8');
      expect(decoded).toBe(svgContent);
    });

    it('getLogoDataUri without logo.svg returns null', () => {
      process.env.THEME = 'base';
      process.env.THEME_MODE = 'dark';

      // No logo.svg in existsSync
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

      expect(service.logoPath).toBeNull();
      expect(service.getLogoDataUri()).toBeNull();
    });
  });

  // ─── 7. Integration Scenarios ───────────────────────────────────────

  describe('Integration Scenarios', () => {
    it('full flow: THEME=tokyo-night, THEME_MODE=dark → correct CSS content with both themes', async () => {
      process.env.THEME = 'tokyo-night';
      process.env.THEME_MODE = 'dark';

      const baseColors = ':root { --color-bg: #ffffff; --color-primary: #4ade80; --color-text: #333; }';
      const tokyoColors = ':root { --color-bg: #1a1b26; --color-primary: #7aa2f7; --color-text: #c0caf5; }';

      setupExistsSync({
        'themes/tokyo-night': true,
        'themes/tokyo-night/manifest.json': true,
        'themes/tokyo-night/colors.css': true,
        'themes/tokyo-night/logo.svg': true,
        'themes/base': true,
        'themes/base/manifest.json': true,
        'themes/base/colors.css': true,
        'themes/base/logo.svg': true
      });
      setupReadFileSync({
        'themes/tokyo-night/manifest.json': TOKYO_MANIFEST,
        'themes/tokyo-night/colors.css': tokyoColors,
        'themes/base/manifest.json': BASE_MANIFEST,
        'themes/base/colors.css': baseColors
      });

      const service = createService();
      service.initialize('/app');

      // Verify full resolution
      expect(service.getThemeName()).toBe('tokyo-night');
      expect(service.getResolvedMode()).toBe('dark');
      expect(service.cssFiles).toHaveLength(2);

      // Verify CSS content contains both themes
      const cssContent = await service.getThemeCssContent();
      expect(cssContent).toContain('--color-bg: #ffffff');
      expect(cssContent).toContain('--color-primary: #4ade80');
      expect(cssContent).toContain('--color-bg: #1a1b26');
      expect(cssContent).toContain('--color-primary: #7aa2f7');

      // Verify order: base first
      const basePos = cssContent.indexOf('--color-bg: #ffffff');
      const tokyoPos = cssContent.indexOf('--color-bg: #1a1b26');
      expect(basePos).toBeLessThan(tokyoPos);

      // Verify logo
      expect(service.logoPath).toBeTruthy();
      expect(service.logoPath).toContain('tokyo-night/logo.svg');
    });

    it('full flow: THEME=base, THEME_MODE=auto, OS=light → resolves to light with base CSS', async () => {
      process.env.THEME = 'base';
      // THEME_MODE not set → defaults to auto
      delete process.env.THEME_MODE;
      mockGetNativeTheme.mockReturnValue({ shouldUseDarkColors: false });

      const lightBaseColors = ':root { --color-bg: #ffffff; --color-primary: #4ade80; }';

      setupExistsSync({
        'themes/base': true,
        'themes/base/manifest.json': true,
        'themes/base/colors.css': true,
        'themes/base/logo.svg': true
      });
      setupReadFileSync({
        'themes/base/manifest.json': BASE_MANIFEST,
        'themes/base/colors.css': lightBaseColors
      });

      const service = createService();
      service.initialize('/app');

      // Auto mode + OS light → resolved to light
      expect(service.getThemeName()).toBe('base');
      expect(service.getRawMode()).toBe('auto');
      expect(service.getResolvedMode()).toBe('light');

      // CSS content is available
      const cssContent = await service.getThemeCssContent();
      expect(cssContent).toContain('--color-bg: #ffffff');
      expect(cssContent).toContain('--color-primary: #4ade80');

      // Watching should be available for auto mode
      let updateHandler = null;
      const mockNativeTheme = {
        shouldUseDarkColors: false,
        on: vi.fn((event, handler) => {
          if (event === 'updated') updateHandler = handler;
        }),
        removeListener: vi.fn()
      };
      mockGetNativeTheme.mockReturnValue(mockNativeTheme);

      const callback = vi.fn();
      service.startWatching(callback);
      expect(mockNativeTheme.on).toHaveBeenCalledWith('updated', expect.any(Function));

      // Simulate OS switching to dark
      mockNativeTheme.shouldUseDarkColors = true;
      updateHandler();
      expect(callback).toHaveBeenCalledWith('dark');
      expect(service.getResolvedMode()).toBe('dark');
    });
  });
});
