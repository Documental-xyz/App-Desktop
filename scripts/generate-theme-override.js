'use strict';

/**
 * @fileoverview Generate static theme-override.css from active theme configuration
 * @author Documental Team
 * @since 1.0.0
 *
 * Reads THEME and THEME_MODE from environment, resolves the theme CSS chain
 * (with inheritance), parses CSS custom properties, resolves var() references
 * to actual hex values, and writes a static `:root { ... }` override file.
 *
 * Usage: node scripts/generate-theme-override.js
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Environment resolution: env var → .env file → runtime-env.json
// ---------------------------------------------------------------------------

/**
 * Parse a simple .env file (KEY=VALUE lines). No library dependency needed.
 * @param {string} envPath - Absolute path to .env file
 * @returns {Object} Parsed key-value pairs
 */
function parseEnvFile(envPath) {
  const result = {};
  if (!fs.existsSync(envPath)) {
    return result;
  }
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Resolve a config value from: process.env → .env → runtime-env.json
 * @param {string} key - Environment variable name
 * @param {string} [defaultValue] - Default if not found
 * @returns {string} Resolved value
 */
function resolveConfig(key, defaultValue) {
  // 1. process.env (already set or injected by caller)
  const envVal = (process.env[key] || '').trim();
  if (envVal) {
    return envVal;
  }

  // 2. .env file
  const dotEnv = parseEnvFile(path.join(projectRoot, '.env'));
  const dotEnvVal = (dotEnv[key] || '').trim();
  if (dotEnvVal) {
    return dotEnvVal;
  }

  // 3. runtime-env.json
  const runtimePaths = [
    path.join(projectRoot, 'resources', 'config', 'runtime-env.json'),
  ];
  for (const rp of runtimePaths) {
    try {
      if (fs.existsSync(rp)) {
        const runtimeConfig = JSON.parse(fs.readFileSync(rp, 'utf8'));
        const runtimeVal = (runtimeConfig[key] || '').trim();
        if (runtimeVal) {
          return runtimeVal;
        }
      }
    } catch (_err) {
      // skip unreadable
    }
  }

  return defaultValue || '';
}

// ---------------------------------------------------------------------------
// 2. CSS parsing utilities
// ---------------------------------------------------------------------------

/**
 * Parse CSS custom property declarations from raw CSS text.
 * Extracts `--name: value` pairs from within `{ }` blocks, ignoring selectors.
 * @param {string} cssText - Raw CSS content
 * @returns {Object} Map of `--variable-name` → value string
 */
function parseDeclarations(cssText) {
  const decls = {};

  // Remove comments
  const cleaned = cssText.replace(/\/\*[\s\S]*?\*\//g, '');

  // Extract content inside all { } blocks
  const blockRegex = /\{([^}]*)\}/g;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(cleaned)) !== null) {
    const blockContent = blockMatch[1];

    // Parse `--name: value;` declarations
    const declRegex = /(--[\w-]+)\s*:\s*([^;]+)/g;
    let declMatch;
    while ((declMatch = declRegex.exec(blockContent)) !== null) {
      const name = declMatch[1].trim();
      const value = declMatch[2].trim();
      decls[name] = value;
    }
  }

  return decls;
}

/**
 * Build a primitives map from variables.css Tier 1 (`:root` block with hex values).
 * @param {string} variablesCssPath - Path to variables.css
 * @returns {Object} Map of `--primitive-name` → hex value
 */
function buildPrimitivesMap(variablesCssPath) {
  if (!fs.existsSync(variablesCssPath)) {
    console.warn(`⚠️  variables.css not found at ${variablesCssPath}`);
    return {};
  }
  const raw = fs.readFileSync(variablesCssPath, 'utf8');
  return parseDeclarations(raw);
}

/**
 * Resolve `var(--xxx)` references in declaration values using a primitives map.
 * Only resolves if the referenced var exists in the map.
 * @param {Object} decls - Declaration map `--name` → value (may contain var())
 * @param {Object} primitives - Primitive map `--name` → hex
 * @returns {Object} New map with var() references replaced by hex values
 */
function resolveVarReferences(decls, primitives) {
  const resolved = {};

  for (const [name, value] of Object.entries(decls)) {
    let resolvedValue = value;

    // Resolve nested var() references iteratively (max 10 depth for safety)
    let iterations = 0;
    while (resolvedValue.includes('var(') && iterations < 10) {
      resolvedValue = resolvedValue.replace(
        /var\(([\w-]+)\)/g,
        (match, varName) => {
          const lookupKey = varName.startsWith('--') ? varName : `--${varName}`;
          // First check primitives, then check already-resolved decls
          if (primitives[lookupKey] !== undefined) {
            return primitives[lookupKey];
          }
          if (resolved[lookupKey] !== undefined) {
            return resolved[lookupKey];
          }
          // Can't resolve — keep as-is
          return match;
        }
      );
      iterations++;
    }

    resolved[name] = resolvedValue;
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// 3. Theme CSS chain (with inheritance)
// ---------------------------------------------------------------------------

/**
 * Build the ordered list of colors.css file paths (parent first, child last).
 * @param {string} themeDir - Theme directory
 * @param {Object} manifest - Parsed manifest.json
 * @returns {string[]} Ordered CSS file paths
 */
function buildCssChain(themeDir, manifest) {
  const chain = [];

  // Inheritance: load parent first
  if (manifest.inherit) {
    const parentDir = path.join(projectRoot, 'themes', manifest.inherit);
    if (fs.existsSync(parentDir)) {
      const parentManifestPath = path.join(parentDir, 'manifest.json');
      let parentManifest = { mode: ['dark', 'light'], inherit: null };
      try {
        parentManifest = JSON.parse(fs.readFileSync(parentManifestPath, 'utf8'));
      } catch (_err) {
        console.warn(`⚠️  Could not parse parent manifest at ${parentManifestPath}`);
      }

      // Recursive: parent's ancestors first
      const parentChain = buildCssChain(parentDir, parentManifest);
      chain.push(...parentChain);
    } else {
      console.warn(`⚠️  Parent theme "${manifest.inherit}" not found, skipping inheritance`);
    }
  }

  // This theme's colors.css
  const colorsCss = path.join(themeDir, 'colors.css');
  if (fs.existsSync(colorsCss)) {
    chain.push(colorsCss);
  } else {
    console.warn(`⚠️  colors.css not found in ${themeDir}`);
  }

  return chain;
}

/**
 * Filter declarations to only those matching the requested theme mode.
 * Parses theme CSS blocks that use [data-mode="dark/light"] selectors.
 * Falls back to all declarations if no mode-specific selector found.
 * @param {string} cssText - Raw CSS content
 * @param {string} mode - 'dark' or 'light'
 * @returns {Object} Filtered declaration map
 */
function parseModeSpecificDeclarations(cssText, mode) {
  // Remove comments
  const cleaned = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const decls = {};

  // Try to match mode-specific selector: [data-mode="dark"] or [data-mode="light"]
  const modePattern = new RegExp(
    `\\[data-mode=["']${mode}["']\\]\\s*\\{([^}]*)\\}`,
    'g'
  );
  let modeMatch;
  let foundModeBlock = false;

  while ((modeMatch = modePattern.exec(cleaned)) !== null) {
    foundModeBlock = true;
    const blockContent = modeMatch[1];
    const declRegex = /(--[\w-]+)\s*:\s*([^;]+)/g;
    let declMatch;
    while ((declMatch = declRegex.exec(blockContent)) !== null) {
      decls[declMatch[1].trim()] = declMatch[2].trim();
    }
  }

  // If no mode-specific block, fall back to :root or any block
  if (!foundModeBlock) {
    const rootPattern = /:root\s*\{([^}]*)\}/g;
    let rootMatch;
    while ((rootMatch = rootPattern.exec(cleaned)) !== null) {
      const blockContent = rootMatch[1];
      const declRegex = /(--[\w-]+)\s*:\s*([^;]+)/g;
      let declMatch;
      while ((declMatch = declRegex.exec(blockContent)) !== null) {
        decls[declMatch[1].trim()] = declMatch[2].trim();
      }
    }

    // If still nothing, grab any block content
    if (Object.keys(decls).length === 0) {
      return parseDeclarations(cssText);
    }
  }

  return decls;
}

// ---------------------------------------------------------------------------
// 4. OS dark mode detection (for THEME_MODE=auto)
// ---------------------------------------------------------------------------

function detectOsDarkPreference() {
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

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------

function main() {
  console.log('🎨 Generating theme override CSS...');

  // Resolve theme configuration
  const themeName = resolveConfig('THEME', 'base') || 'base';
  let themeMode = resolveConfig('THEME_MODE', 'auto') || 'auto';

  if (themeMode === 'auto') {
    themeMode = detectOsDarkPreference() ? 'dark' : 'light';
    console.log(`   THEME_MODE=auto → resolved to "${themeMode}" based on OS preference`);
  }

  console.log(`   Theme: ${themeName}`);
  console.log(`   Mode:  ${themeMode}`);

  // Resolve theme directory
  let themeDir = path.join(projectRoot, 'themes', themeName);
  if (!fs.existsSync(themeDir)) {
    console.warn(`⚠️  Theme directory "${themeDir}" not found, falling back to "base"`);
    themeDir = path.join(projectRoot, 'themes', 'base');
  }

  const manifestPath = path.join(themeDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.warn(`⚠️  manifest.json not found in "${themeDir}", falling back to "base"`);
    themeDir = path.join(projectRoot, 'themes', 'base');
  }

  // Load manifest
  let manifest = { name: 'Unknown', mode: ['dark', 'light'], inherit: null };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(themeDir, 'manifest.json'), 'utf8'));
  } catch (_err) {
    console.warn(`⚠️  Failed to parse manifest.json, using defaults`);
  }

  // Validate requested mode against available modes
  const availableModes = manifest.mode || ['dark', 'light'];
  const resolvedMode = availableModes.includes(themeMode)
    ? themeMode
    : availableModes[0];

  if (resolvedMode !== themeMode) {
    console.warn(
      `⚠️  Requested mode "${themeMode}" not available in [${availableModes}], using "${resolvedMode}"`
    );
  }

  // Build primitives map from variables.css
  const variablesCssPath = path.join(
    projectRoot, 'renderer', 'assets', 'css', 'variables.css'
  );
  const primitives = buildPrimitivesMap(variablesCssPath);

  // Build CSS chain and parse declarations
  const cssChain = buildCssChain(themeDir, manifest);
  let mergedDecls = {};

  for (const cssFile of cssChain) {
    const raw = fs.readFileSync(cssFile, 'utf8');
    const fileDecls = parseModeSpecificDeclarations(raw, resolvedMode);
    // Child overrides parent (spread parent first, then child on top)
    mergedDecls = { ...mergedDecls, ...fileDecls };
  }

  // If theme is 'base' and we got no declarations from the chain,
  // fall back to parsing the Tier 2 block from variables.css
  if (Object.keys(mergedDecls).length === 0) {
    console.log('   No theme-specific declarations found, using variables.css Tier 2 defaults');
    const variablesRaw = fs.readFileSync(variablesCssPath, 'utf8');
    // Parse the Tier 2 block (:root, [data-theme="base"] { ... })
    const tier2Pattern = /:root\s*,\s*\[data-theme="base"\]\s*\{([^}]*)\}/;
    const tier2Match = tier2Pattern.exec(variablesRaw);
    if (tier2Match) {
      const blockContent = tier2Match[1];
      const declRegex = /(--[\w-]+)\s*:\s*([^;]+)/g;
      let declMatch;
      while ((declMatch = declRegex.exec(blockContent)) !== null) {
        mergedDecls[declMatch[1].trim()] = declMatch[2].trim();
      }
    } else {
      // Final fallback: parse all declarations
      mergedDecls = parseDeclarations(variablesRaw);
    }
  }

  // Resolve var() references to actual hex values
  const resolved = resolveVarReferences(mergedDecls, primitives);

  // Filter to only --color-* semantic tokens for the output
  const semanticTokens = {};
  for (const [name, value] of Object.entries(resolved)) {
    if (name.startsWith('--color-')) {
      semanticTokens[name] = value;
    }
  }

  if (Object.keys(semanticTokens).length === 0) {
    console.error('❌ No semantic color tokens found. Check theme files.');
    process.exit(1);
  }

  // Generate output CSS
  const declLines = Object.entries(semanticTokens)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');

  const output = [
    `/* Auto-generated theme override for: ${themeName}/${resolvedMode} */`,
    `/* DO NOT EDIT — regenerate with: npm run build:theme */`,
    `:root {`,
    declLines,
    `}`,
    '',
  ].join('\n');

  // Write output
  const outputDir = path.join(projectRoot, 'renderer', 'assets', 'css');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'theme-override.css');
  fs.writeFileSync(outputPath, output, 'utf8');

  console.log(
    `✅ Theme override generated: ${themeName}/${resolvedMode} → renderer/assets/css/theme-override.css`
  );
  console.log(`   ${Object.keys(semanticTokens).length} semantic tokens written`);
}

main();
