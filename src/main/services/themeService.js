/**
 * @fileoverview Theme service for resolving, validating, and loading UI themes
 * @author Documental Team
 * @since 1.0.0
 *
 * Reads THEME and THEME_MODE from .env / runtime-env.json, resolves the theme
 * directory, validates it, reads manifest.json, builds the CSS injection chain
 * with inheritance, and handles fallbacks.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execa } = require('execa');

function getNativeTheme() {
  try {
    // eslint-disable-next-line global-require
    return require('electron').nativeTheme;
  } catch (_err) {
    return null;
  }
}

/**
 * Attempt to load runtime-env.json (mirrors github-config.js pattern).
 * Reads ALL readable candidates and MERGES them, assigning in increasing
 * priority order so the packaged build config (resources/config) wins over
 * a stale userData/runtime-env.json written by older builds. First-read-wins
 * semantics previously let a legacy/partial userData file (e.g. a persisted
 * "base" fallback) permanently shadow the packaged .env config.
 * @param {Object} fsImpl - fs implementation (real or mock)
 * @param {Object} pathImpl - path implementation (real or mock)
 * @param {string} appRoot - Application root directory
 * @returns {Object|null} Merged runtime env or null
 */
async function loadRuntimeEnv(fsImpl, pathImpl, appRoot) {
  // Ordered lowest → highest priority: later candidates override earlier ones.
  const candidatePaths = [
    pathImpl.join(process.cwd(), 'resources', 'config', 'runtime-env.json'),
    pathImpl.join(appRoot, 'resources', 'config', 'runtime-env.json')
  ];

  try {
    const { app } = require('electron');
    if (app && app.getPath) {
      candidatePaths.push(
        pathImpl.join(app.getPath('userData'), 'runtime-env.json')
      );
    }
  } catch (_e) {}

  if (process.resourcesPath) {
    candidatePaths.push(
      pathImpl.join(process.resourcesPath, 'config', 'runtime-env.json')
    );
  }

  const fsPromises = fsImpl.promises || require('fs').promises;
  const merged = {};
  for (const candidate of candidatePaths) {
    try {
      await fsPromises.access(candidate);
      const raw = await fsPromises.readFile(candidate, 'utf8');
      Object.assign(merged, JSON.parse(raw));
    } catch (_err) {
      // Skip unreadable/invalid candidates
    }
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

class ThemeService {
  /**
   * @param {Object} deps - Dependency injection container
   * @param {Object} deps.logger - Logger instance
   * @param {Object} [deps.fs] - fs module (injected for testing)
   * @param {Object} [deps.path] - path module (injected for testing)
   * @param {Function} [deps.getNativeTheme] - nativeTheme resolver (injected for testing)
   * @param {Object} [deps.databaseManager] - Database manager for persisting theme mode
   */
  constructor({ logger, fs: fsImpl, path: pathImpl, getNativeTheme: nativeThemeFn, databaseManager }) {
    this.logger = logger;
    this._fs = fsImpl || fs;
    this._fsPromises = (fsImpl || fs).promises;
    this._path = pathImpl || path;
    this._getNativeTheme = nativeThemeFn || getNativeTheme;
    this._db = databaseManager || null;
    this.themeName = null;
    this.themeMode = null;
    this.themeDir = null;
    this.manifest = null;
    this.cssFiles = [];
    this.logoPath = null;
    this.iconCssPath = null;
  }

  /**
   * Initialize the theme service: read config, resolve theme, load manifest,
   * build CSS chain.
   * @param {string} appRoot - Application root directory
   * @returns {void}
   */
  async initialize(appRoot) {
    this._appRoot = appRoot;

    const themeName = await this._resolveThemeName(appRoot);
    this.logger.info(`ThemeService: resolved theme name "${themeName}"`);

    const themeDir = this._path.join(appRoot, 'themes', themeName);

    const validated = await this._validateThemeDir(themeDir, themeName);
    this.themeName = validated.themeName;
    this.themeDir = validated.themeDir;

    this.manifest = await this._loadManifest(this.themeDir);

    // Resolve mode priority: env → runtime-env.json → database (highest)
    await this._resolveThemeModeEnv(); // sets _rawMode from env/file
    await this._loadDbThemeMode(); // async, overrides from database if present

    // Resolve to actual themeMode using the final _rawMode
    this.themeMode = await this._resolveMode(this.manifest, this._rawMode);
    this.cssFiles = await this._buildCssChain(this.themeDir, this.manifest, appRoot);
    await this._resolveAssetPaths(this.themeDir);

    // Overwrite static theme-override.css with user's persisted theme
    // so <link> loads correct colors on first paint (zero flash).
    // Must run AFTER cssFiles is built so getResolvedCssForMode() can read theme CSS.
    await this.regenerateOverrideCss(this.themeMode);

    this.logger.info(
      `ThemeService: initialized — theme="${this.themeName}", mode="${this.themeMode}", ` +
      `cssFiles=${this.cssFiles.length}, logo=${!!this.logoPath}, icons=${!!this.iconCssPath}`
    );

    try {
      const { app } = require('electron');
      if (app.isPackaged) {
        const userDataPath = app.getPath('userData');
        const fs2Promises = this._fsPromises;
        const path2 = this._path;
        const userRuntimeEnvPath = path2.join(userDataPath, 'runtime-env.json');
        let needsWrite = false;
        let existingConfig = {};
        try {
          const raw = await fs2Promises.readFile(userRuntimeEnvPath, 'utf8');
          existingConfig = JSON.parse(raw);
          if (!existingConfig.THEME) {
            needsWrite = true;
          }
        } catch (_e) {
          needsWrite = true;
        }
        if (needsWrite && this.themeName) {
          existingConfig.THEME = this.themeName;
          if (!existingConfig.THEME_MODE) {
            existingConfig.THEME_MODE = this._rawMode || 'auto';
          }
          try {
            await fs2Promises.writeFile(userRuntimeEnvPath, JSON.stringify(existingConfig, null, 2), 'utf8');
          } catch (_e) {}
        }
      }
    } catch (_e) {}
  }

  /**
   * Get concatenated CSS content from all files in the chain.
   * @returns {Promise<string>} Concatenated CSS
   */
  async getThemeCssContent() {
    const contents = [];
    for (const cssFile of this.cssFiles) {
      try {
        const content = await this._fsPromises.readFile(cssFile, 'utf8');
        contents.push(content);
      } catch (err) {
        this.logger.warn(`ThemeService: failed to read CSS file "${cssFile}": ${err.message}`);
      }
    }
    return contents.join('\n');
  }

  /**
   * Build a fully-resolved, injectable CSS string for a specific mode
   * (dark/light). Reads colors.css files in the chain, extracts only the
   * declarations matching the requested mode, merges with variables.css
   * base defaults, resolves all var() references against primitives, and
   * returns a flat `:root { ... }` block ready for webContents.insertCSS().
   *
   * @param {string} mode - 'dark' or 'light' (NOT 'auto' — caller must resolve)
   * @returns {Promise<string>} Resolved CSS string with concrete values
   */
  async getResolvedCssForMode(mode) {
    const primitives = await this._buildPrimitivesMap();

    let combined = '';
    for (const cssFile of this.cssFiles) {
      try {
        const content = await this._fsPromises.readFile(cssFile, 'utf8');
        const modeSpecific = this._extractModeDeclarations(content, mode);
        if (modeSpecific) combined += modeSpecific + '\n';
      } catch (err) {
        this.logger.warn(`ThemeService: failed to read CSS file "${cssFile}": ${err.message}`);
      }
    }

    // Prepend base semantic-token defaults from variables.css filtered to the
    // same mode so unresolved tokens still have sensible values.
    let baseVarsContent = '';
    try {
      baseVarsContent = await this._fsPromises.readFile(
        this._path.join(this._appRoot, 'renderer', 'assets', 'css', 'variables.css'), 'utf8'
      );
    } catch (_e) {}
    const baseDefaults = this._extractModeDeclarations(baseVarsContent, mode) || '';
    combined = baseDefaults + '\n' + combined;

    return this._resolveVarRefs(combined, primitives);
  }

  /**
   * Regenerate the static theme-override.css file on disk with the user's
   * persisted theme mode. This ensures the <link> stylesheet loads correct
   * colors on first paint — zero flash, no JavaScript injection needed.
   * @param {string} mode - Resolved mode ('dark' or 'light')
   * @returns {Promise<void>}
   */
  async regenerateOverrideCss(mode) {
    try {
      const css = await this.getResolvedCssForMode(mode);
      const header = `/* Auto-generated at runtime for: ${this.themeName}/${mode} */\n`;
      const output = header + css + '\n';

      const overridePath = this._path.join(this._appRoot, 'renderer', 'assets', 'css', 'theme-override.css');
      await this._fsPromises.writeFile(overridePath, output, 'utf8');
      this.logger.info(`ThemeService: regenerated theme-override.css for mode "${mode}"`);
    } catch (err) {
      this.logger.warn(`ThemeService: failed to regenerate theme-override.css: ${err.message}`);
    }
  }

  /**
   * Build a map of primitive variable names to their concrete values by
   * parsing the Tier 1 `:root { ... }` block in variables.css.
   * @returns {Object} Map of '--name' -> 'value'
   * @private
   */
  async _buildPrimitivesMap() {
    const map = {};
    try {
      const content = await this._fsPromises.readFile(
        this._path.join(this._appRoot, 'renderer', 'assets', 'css', 'variables.css'), 'utf8'
      );
      const rootMatch = content.match(/:root\s*\{([^}]*)\}/);
      if (rootMatch) {
        const decls = rootMatch[1];
        const re = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
        let m;
        while ((m = re.exec(decls))) {
          map[m[1].trim()] = m[2].trim();
        }
      }
    } catch (err) {
      this.logger.warn(`ThemeService: failed to build primitives map: ${err.message}`);
    }
    return map;
  }

  /**
   * Extract declarations targeting the given mode from a CSS source string.
   * Matches `[data-theme="X"][data-mode="MODE"] { ... }` blocks (and a
   * fallback generic `[data-theme="*"][data-mode="MODE"]` pattern), plus
   * `:root { ... }` as a last-resort default if no mode-specific block
   * exists. Returns a normalized `:root { ... }` block, or null if nothing
   * matched.
   * @param {string} cssText - Raw CSS source
   * @param {string} mode - 'dark' or 'light'
   * @returns {string|null} `:root { ... }` block or null
   * @private
   */
  _extractModeDeclarations(cssText, mode) {
    const themeName = this.themeName;
    const patterns = [
      new RegExp(`\\[data-theme="${themeName}"\\]\\[data-mode="${mode}"\\]\\s*\\{([^}]*)\\}`, 'g'),
      new RegExp(`\\[data-theme="[^"]*"\\]\\[data-mode="${mode}"\\]\\s*\\{([^}]*)\\}`, 'g')
    ];
    let combined = '';
    for (const re of patterns) {
      let m;
      while ((m = re.exec(cssText))) {
        combined += m[1] + '\n';
      }
    }

    // Fallback to :root defaults if no mode-specific declarations matched
    const rootMatch = cssText.match(/:root\s*\{([^}]*)\}/);
    if (rootMatch && !combined) {
      combined = rootMatch[1];
    }

    return combined ? `:root { ${combined} }` : null;
  }

  /**
   * Resolve all var() references in a CSS string against the primitives map.
   * Performs up to 5 substitution passes to handle nested refs, then merges
   * any inline declarations from the input itself into the primitives map
   * for a final pass. Unresolvable refs fall back to their fallback value
   * or are left intact.
   * @param {string} cssText - CSS with var() references
   * @param {Object} primitives - Map of '--name' -> 'value'
   * @returns {string} CSS with var() refs resolved where possible
   * @private
   */
  _resolveVarRefs(cssText, primitives) {
    let resolved = cssText;
    // Iteratively resolve nested var() references against primitives
    for (let i = 0; i < 5; i++) {
      const prev = resolved;
      resolved = resolved.replace(/var\((--[a-zA-Z0-9_-]+)(?:,\s*([^)]+))?\)/g, (match, name, fallback) => {
        return primitives[name] || fallback || match;
      });
      if (resolved === prev) break;
    }

    // Merge any declarations present in the input itself, then do one more pass
    const re = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(cssText))) {
      primitives[m[1].trim()] = m[2].trim();
    }
    resolved = resolved.replace(/var\((--[a-zA-Z0-9_-]+)(?:,\s*([^)]+))?\)/g, (match, name, fallback) => {
      return primitives[name] || fallback || match;
    });

    return resolved;
  }

  /**
    * Get the theme logo as a data URI for CSS injection.
   * Returns null when no theme logo.svg exists.
   * @returns {string|null} data:image/svg+xml;base64,... URI or null
   */
  async getLogoDataUri() {
    if (!this.logoPath) {
      return null;
    }
    try {
      const raw = await this._fsPromises.readFile(this.logoPath, 'utf8');
      return 'data:image/svg+xml;base64,' + Buffer.from(raw).toString('base64');
    } catch (err) {
      this.logger.warn(`ThemeService: failed to read logo "${this.logoPath}": ${err.message}`);
      return null;
    }
  }

  /**
    * Get the resolved theme name for data-theme attribute.
    * @returns {string} Theme name
    */
  getThemeName() {
    return this.themeName;
  }

  /**
    * Get the resolved mode ('dark' or 'light').
    * @returns {string} Resolved mode
    */
  getResolvedMode() {
    return this.themeMode;
  }

  /**
   * Get the raw THEME_MODE string before auto-resolution ('dark', 'light', or 'auto').
   * @returns {string} Raw mode from env/runtime-env
   */
  getRawMode() {
    return this._rawMode || 'auto';
  }

  /**
   * Load persisted theme_mode from the database, overriding _rawMode if found.
   * Database has highest priority (env → runtime-env.json → DB).
   * @returns {Promise<void>}
   */
  async _loadDbThemeMode() {
    if (!this._db) return;
    try {
      const dbMode = await this._db.getSetting('theme_mode');
      if (dbMode) {
        const trimmed = dbMode.trim().toLowerCase();
        if (['auto', 'dark', 'light'].includes(trimmed)) {
          this._rawMode = trimmed;
          this.logger.info(`ThemeService: loaded theme_mode="${trimmed}" from database`);
        }
      }
    } catch (_err) {
      this.logger.warn(`ThemeService: failed to load theme_mode from database: ${_err.message}`);
    }
  }

  /**
   * Persist theme_mode to the database and update in-memory state.
   * Valid modes: 'auto', 'dark', 'light'.
   * @param {string} mode - Theme mode to persist
   * @returns {Promise<void>}
   */
  async saveThemeMode(mode) {
    const validModes = ['auto', 'dark', 'light'];
    if (!validModes.includes(mode)) return;
    this._rawMode = mode;
    if (!this._db) return;
    try {
      await this._db.setSetting('theme_mode', mode);
      this.logger.info(`ThemeService: persisted theme_mode="${mode}" to database`);
      const availableModes = this.manifest?.mode || ['dark', 'light'];
      let resolvedMode = mode;
      if (mode === 'auto') {
        const osPrefersDark = await this._detectOsDarkPreference();
        resolvedMode = osPrefersDark ? 'dark' : 'light';
      }
      if (!availableModes.includes(resolvedMode)) resolvedMode = availableModes[0];
      await this.regenerateOverrideCss(resolvedMode);
    } catch (_err) {
      this.logger.warn(`ThemeService: failed to persist theme_mode="${mode}": ${_err.message}`);
    }
  }

  async _resolveThemeName(appRoot) {
    const envTheme = (process.env.THEME || '').trim();
    if (envTheme) {
      return envTheme;
    }

    const runtimeEnv = await loadRuntimeEnv(this._fs, this._path, appRoot);
    const runtimeTheme = (runtimeEnv?.THEME || '').trim();
    if (runtimeTheme) {
      return runtimeTheme;
    }

    return 'base';
  }

  /**
   * Check that a directory exists. Uses stat() because Electron's asar fs
   * shim fails fs.access() with ENOENT for DIRECTORY entries inside asar
   * archives (file entries work), which made every packaged theme dir look
   * missing and forced the "base" fallback.
   * @param {string} dirPath - Directory to check
   * @returns {Promise<boolean>} True if directory exists
   */
  async _dirExists(dirPath) {
    try {
      const stats = await this._fsPromises.stat(dirPath);
      return stats.isDirectory();
    } catch (_err) {
      return false;
    }
  }

  async _validateThemeDir(themeDir, themeName) {
    if (!(await this._dirExists(themeDir))) {
      this.logger.warn(
        `ThemeService: theme directory "${themeDir}" not found, falling back to "base"`
      );
      return { themeName: 'base', themeDir: this._path.join(this._path.dirname(themeDir), 'base') };
    }

    const manifestPath = this._path.join(themeDir, 'manifest.json');
    let manifestExists = false;
    try { await this._fsPromises.access(manifestPath); manifestExists = true; } catch { manifestExists = false; }
    if (!manifestExists) {
      this.logger.warn(
        `ThemeService: manifest.json not found in "${themeDir}", falling back to "base"`
      );
      return { themeName: 'base', themeDir: this._path.join(this._path.dirname(themeDir), 'base') };
    }

    return { themeName, themeDir };
  }

  async _loadManifest(themeDir) {
    const manifestPath = this._path.join(themeDir, 'manifest.json');
    try {
      const raw = await this._fsPromises.readFile(manifestPath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      this.logger.warn(
        `ThemeService: failed to parse manifest.json: ${err.message}, using defaults`
      );
      return { name: 'unknown', mode: ['dark', 'light'], inherit: null };
    }
  }

  async _resolveMode(manifest, explicitMode) {
    const availableModes = manifest.mode || ['dark', 'light'];
    const mode = explicitMode || await this._resolveThemeModeEnv();

    if (mode === 'auto') {
      const osPrefersDark = await this._detectOsDarkPreference();
      const resolved = osPrefersDark ? 'dark' : 'light';
      if (availableModes.includes(resolved)) {
        return resolved;
      }
      this.logger.warn(
        `ThemeService: OS prefers "${resolved}" but theme only supports [${availableModes}], using "${availableModes[0]}"`
      );
      return availableModes[0];
    }

    if (availableModes.includes(mode)) {
      return mode;
    }

    this.logger.warn(
      `ThemeService: requested mode "${mode}" not available in [${availableModes}], using "${availableModes[0]}"`
    );
    return availableModes[0];
  }

  async _detectOsDarkPreference() {
    const nt = this._getNativeTheme();
    if (nt) {
      if (nt.shouldUseDarkColors) {
        return true;
      }

      if (process.platform === 'linux') {
        try {
          const { stdout: colorScheme } = await execa(
            'gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme'],
            { timeout: 2000 }
          );
          if (colorScheme.trim().includes('dark')) {
            return true;
          }
        } catch (_e) { }

        try {
          const { stdout: gtkTheme } = await execa(
            'gsettings', ['get', 'org.gnome.desktop.interface', 'gtk-theme'],
            { timeout: 2000 }
          );
          if (gtkTheme.trim().toLowerCase().includes('dark')) {
            return true;
          }
        } catch (_e) { }
      }

      if (process.platform === 'darwin') {
        try {
          const { stdout: output } = await execa(
            'defaults', ['read', '-g', 'AppleInterfaceStyle'],
            { timeout: 2000 }
          );
          if (output.trim().toLowerCase().includes('dark')) {
            return true;
          }
        } catch (_e) { }
      }

      return false;
    }

    return true;
  }

  async _resolveThemeModeEnv() {
    this._appRoot = this._appRoot || null;

    const envMode = (process.env.THEME_MODE || '').trim().toLowerCase();
    if (envMode) {
      this._rawMode = envMode;
      return envMode;
    }

    if (this._appRoot) {
      const runtimeEnv = await loadRuntimeEnv(this._fs, this._path, this._appRoot);
      const runtimeMode = (runtimeEnv?.THEME_MODE || '').trim().toLowerCase();
      if (runtimeMode) {
        this._rawMode = runtimeMode;
        return runtimeMode;
      }
    }

    this._rawMode = 'auto';
    return 'auto';
  }

  startWatching(callback) {
    if (this._rawMode !== 'auto') return;

    const nt = this._getNativeTheme();
    if (!nt || typeof nt.on !== 'function') return;

    this._themeChangeHandler = () => {
      try {
        const osPrefersDark = nt.shouldUseDarkColors ?? true;
        const newMode = osPrefersDark ? 'dark' : 'light';
        const availableModes = this.manifest?.mode || ['dark', 'light'];
        const resolved = availableModes.includes(newMode) ? newMode : availableModes[0];
        if (resolved !== this.themeMode) {
          this.themeMode = resolved;
          callback(resolved);
        }
      } catch (err) {
        this.logger.warn(`ThemeService: error in theme change handler: ${err.message}`);
      }
    };

    nt.on('updated', this._themeChangeHandler);
    this.logger.info('ThemeService: started watching OS theme changes');
  }

  stopWatching() {
    if (!this._themeChangeHandler) return;

    const nt = this._getNativeTheme();
    if (nt && typeof nt.removeListener === 'function') {
      nt.removeListener('updated', this._themeChangeHandler);
    }
    this._themeChangeHandler = null;
    this.logger.info('ThemeService: stopped watching OS theme changes');
  }

  async _buildCssChain(themeDir, manifest, appRoot) {
    const chain = [];

    if (manifest.inherit) {
      const parentDir = this._path.join(appRoot, 'themes', manifest.inherit);
      if (await this._dirExists(parentDir)) {
        const parentManifest = await this._loadManifest(parentDir);
        const parentChain = await this._buildCssChain(parentDir, parentManifest, appRoot);
        chain.push(...parentChain);
      } else {
        this.logger.warn(
          `ThemeService: parent theme "${manifest.inherit}" directory not found, skipping inheritance`
        );
      }
    }

    const colorsCss = this._path.join(themeDir, 'colors.css');
    let colorsExist = false;
    try { await this._fsPromises.access(colorsCss); colorsExist = true; } catch { colorsExist = false; }
    if (colorsExist) {
      chain.push(colorsCss);
    } else {
      this.logger.warn(`ThemeService: required colors.css not found in "${themeDir}"`);
    }

    const iconsCss = this._path.join(themeDir, 'icons.css');
    let iconsExist = false;
    try { await this._fsPromises.access(iconsCss); iconsExist = true; } catch { iconsExist = false; }
    if (iconsExist) {
      chain.push(iconsCss);
    }

    return chain;
  }

  async _resolveAssetPaths(themeDir) {
    const logoPath = this._path.join(themeDir, 'logo.svg');
    let logoExists = false;
    try { await this._fsPromises.access(logoPath); logoExists = true; } catch { logoExists = false; }
    if (logoExists) {
      this.logoPath = logoPath;
    }

    const iconCssPath = this._path.join(themeDir, 'icons.css');
    let iconExists = false;
    try { await this._fsPromises.access(iconCssPath); iconExists = true; } catch { iconExists = false; }
    if (iconExists) {
      this.iconCssPath = iconCssPath;
    }
  }
}

module.exports = { ThemeService };
