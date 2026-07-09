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
 * @param {Object} fsImpl - fs implementation (real or mock)
 * @param {Object} pathImpl - path implementation (real or mock)
 * @param {string} appRoot - Application root directory
 * @returns {Object|null} Parsed runtime env or null
 */
async function loadRuntimeEnv(fsImpl, pathImpl, appRoot) {
  const candidatePaths = [
    pathImpl.join(appRoot, 'resources', 'config', 'runtime-env.json'),
    pathImpl.join(process.cwd(), 'resources', 'config', 'runtime-env.json')
  ];

  if (process.resourcesPath) {
    candidatePaths.unshift(
      pathImpl.join(process.resourcesPath, 'config', 'runtime-env.json')
    );
  }

  try {
    const { app } = require('electron');
    if (app && app.getPath) {
      candidatePaths.unshift(
        pathImpl.join(app.getPath('userData'), 'runtime-env.json')
      );
    }
  } catch (_e) {}

  const fsPromises = fsImpl.promises || require('fs').promises;
  for (const candidate of candidatePaths) {
    try {
      await fsPromises.access(candidate);
      const raw = await fsPromises.readFile(candidate, 'utf8');
      return JSON.parse(raw);
    } catch (_err) {
      // Skip unreadable candidates
    }
  }

  return null;
}

class ThemeService {
  /**
   * @param {Object} deps - Dependency injection container
   * @param {Object} deps.logger - Logger instance
   * @param {Object} [deps.fs] - fs module (injected for testing)
   * @param {Object} [deps.path] - path module (injected for testing)
   * @param {Function} [deps.getNativeTheme] - nativeTheme resolver (injected for testing)
   */
  constructor({ logger, fs: fsImpl, path: pathImpl, getNativeTheme: nativeThemeFn }) {
    this.logger = logger;
    this._fs = fsImpl || fs;
    this._fsPromises = (fsImpl || fs).promises;
    this._path = pathImpl || path;
    this._getNativeTheme = nativeThemeFn || getNativeTheme;
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
    this.themeMode = this._resolveMode(this.manifest);
    this.cssFiles = await this._buildCssChain(this.themeDir, this.manifest, appRoot);
    await this._resolveAssetPaths(this.themeDir);

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

  async _validateThemeDir(themeDir, themeName) {
    let themeDirExists = false;
    try { await this._fsPromises.access(themeDir); themeDirExists = true; } catch { themeDirExists = false; }
    if (!themeDirExists) {
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

  _resolveMode(manifest) {
    const availableModes = manifest.mode || ['dark', 'light'];
    const requestedMode = this._resolveThemeModeEnv();

    if (requestedMode === 'auto') {
      const osPrefersDark = this._detectOsDarkPreference();
      const resolved = osPrefersDark ? 'dark' : 'light';
      if (availableModes.includes(resolved)) {
        return resolved;
      }
      this.logger.warn(
        `ThemeService: OS prefers "${resolved}" but theme only supports [${availableModes}], using "${availableModes[0]}"`
      );
      return availableModes[0];
    }

    if (availableModes.includes(requestedMode)) {
      return requestedMode;
    }

    this.logger.warn(
      `ThemeService: requested mode "${requestedMode}" not available in [${availableModes}], using "${availableModes[0]}"`
    );
    return availableModes[0];
  }

  _detectOsDarkPreference() {
    const nt = this._getNativeTheme();
    if (nt) {
      if (nt.shouldUseDarkColors) {
        return true;
      }

      if (process.platform === 'linux') {
        try {
          const { execSync } = require('child_process');
          const colorScheme = execSync(
            'gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null',
            { timeout: 2000, encoding: 'utf8' }
          ).trim();
          if (colorScheme.includes('dark')) {
            return true;
          }
        } catch (_e) { }

        try {
          const { execSync } = require('child_process');
          const gtkTheme = execSync(
            'gsettings get org.gnome.desktop.interface gtk-theme 2>/dev/null',
            { timeout: 2000, encoding: 'utf8' }
          ).trim().toLowerCase();
          if (gtkTheme.includes('dark')) {
            return true;
          }
        } catch (_e) { }
      }

      if (process.platform === 'darwin') {
        try {
          const { execSync } = require('child_process');
          const output = execSync(
            'defaults read -g AppleInterfaceStyle 2>/dev/null',
            { timeout: 2000, encoding: 'utf8' }
          ).trim();
          if (output.toLowerCase().includes('dark')) {
            return true;
          }
        } catch (_e) { }
      }

      return false;
    }

    return true;
  }

  _resolveThemeModeEnv() {
    this._appRoot = this._appRoot || null;

    if (this._appRoot) {
      const runtimeEnv = loadRuntimeEnv(this._fs, this._path, this._appRoot);
      const runtimeMode = (runtimeEnv?.THEME_MODE || '').trim().toLowerCase();
      if (runtimeMode) {
        this._rawMode = runtimeMode;
        return runtimeMode;
      }
    }

    const envMode = (process.env.THEME_MODE || '').trim().toLowerCase();
    if (envMode) {
      this._rawMode = envMode;
      return envMode;
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
      let parentDirExists = false;
      try { await this._fsPromises.access(parentDir); parentDirExists = true; } catch { parentDirExists = false; }
      if (parentDirExists) {
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
