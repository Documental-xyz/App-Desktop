"use strict";

/**
 * Generate Electron build icons from the monochrome SVG logo.
 * Produces a WHITE logo (in-memory recolor of the #3CAEE9 source) on a
 * solid #3CAEE9 background:
 *   - assets/icon.png                     1024x1024, rounded corners (20%), transparent corners (Win/Linux)
 *   - assets/icon-mac.png                 1024x1024, full-bleed opaque, no rounded mask (macOS;
 *                                          electron-builder converts this PNG to ICNS at build time)
 *   - assets/icon.ico                     real multi-entry ICO (16/24/32/48/64/128/256)
 *   - assets/icons/NxN.png                freedesktop hicolor set 16–512 (Linux multi-size desktop
 *                                          icons; electron-builder 26.x ships a single-PNG
 *                                          linux.icon as-is — multi-size hicolor requires a
 *                                          directory of per-size PNGs named NxN.png)
 *   - renderer/assets/icon-favicon.png    64x64 favicon
 *
 * The recolored SVG only ever lives in memory — the source file on disk is
 * never modified and no .icns file is ever written.
 *
 * @author Documental Team
 * @since 1.0.0
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico');

// Configuration
const CONFIG = {
  // Source SVG logo (optimized single-color version)
  sourceSvg: path.join(__dirname, '../renderer/assets/img/logo-documental.svg'),

  // Output paths
  outputDir: path.join(__dirname, '../assets'),
  iconPng: path.join(__dirname, '../assets/icon.png'),
  iconIco: path.join(__dirname, '../assets/icon.ico'),
  iconMacPng: path.join(__dirname, '../assets/icon-mac.png'),
  iconsDir: path.join(__dirname, '../assets/icons'),
  favicon: path.join(__dirname, '../renderer/assets/icon-favicon.png'),

  // Icon sizes
  sizes: {
    png: 1024,                          // High-res source for electron-builder (mac auto-converts to ICNS)
    favicon: 64,                        // For renderer/assets/icon-favicon.png
    ico: [16, 24, 32, 48, 64, 128, 256], // Explicit multi-entry ICO sizes
    hicolor: [16, 24, 32, 48, 64, 128, 256, 512] // Freedesktop hicolor set (linux.icon directory)
  },

  // Background color (from SVG primary color #3CAEE9)
  backgroundColor: '#3CAEE9',

  // Rounded corner radius (20% of size)
  cornerRadius: 0.2
};

// Cached in-memory white-recolored SVG buffer (loaded once per run, never written to disk)
let whiteSvgBuffer = null;

/**
 * Create rounded rectangle mask for sharp.
 *
 * @param {number} width - Rectangle width
 * @param {number} height - Rectangle height
 * @param {number} radius - Corner radius
 * @returns {Buffer} - SVG mask data
 */
function createRoundedRectMask(width, height, radius) {
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" 
            fill="white" stroke="white" stroke-width="0"/>
    </svg>
  `;

  return Buffer.from(svg);
}

/**
 * Load the source SVG and recolor it to WHITE, in memory only.
 * The logo is monochrome #3CAEE9 (7 paths) — without this recolor the logo
 * would be blue-on-blue and invisible. The assert guards against silent
 * regressions if the source SVG format ever changes.
 *
 * @returns {Buffer} - SVG buffer with all #3CAEE9 fills replaced by #FFFFFF
 * @throws {Error} if fewer than 7 `fill="#3CAEE9"` occurrences are found
 */
function loadWhiteLogoSvgBuffer() {
  const svgContent = fs.readFileSync(CONFIG.sourceSvg, 'utf8');

  // Count occurrences BEFORE replacing (fail-hard on source format changes)
  const count = svgContent.split('fill="#3CAEE9"').length - 1;
  if (count < 7) {
    throw new Error('SVG recolor failed — expected >=7 #3CAEE9 fills, found ' + count);
  }

  const whiteSvg = svgContent.replaceAll('fill="#3CAEE9"', 'fill="#FFFFFF"');
  console.log(`✓ Logo recolored #3CAEE9 → #FFFFFF in memory (${count} paths, source file untouched)`);

  // In-memory only: the recolored SVG must NEVER be written to disk
  return Buffer.from(whiteSvg);
}

/**
 * Render the icon at an exact size via the parametric composite pipeline.
 *
 * Pipeline (base image = white-recolored SVG rendered by sharp):
 *   1. Render the white logo with `fit: 'contain'` on a transparent canvas.
 *   2. Draw the #3CAEE9 background BENEATH the logo (`blend: 'dest-over'`).
 *   3. If `rounded`, cut rounded corners with the mask LAST (`blend: 'dest-in'`)
 *      so the corners stay transparent. (Mask-before-background would let the
 *      `dest-over` background bleed back into the corners.)
 *
 * @param {number} size - Icon width/height in pixels
 * @param {object} [options]
 * @param {boolean} [options.rounded=true] - Apply the rounded-corner mask
 * @returns {Promise<Buffer>} - PNG buffer at exactly `size`x`size`
 */
async function renderIconBuffer(size, { rounded = true } = {}) {
  if (!whiteSvgBuffer) {
    whiteSvgBuffer = loadWhiteLogoSvgBuffer();
  }

  // Solid opaque background rect (alpha 255 everywhere)
  const bgBuffer = await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: CONFIG.backgroundColor
    }
  }).png().toBuffer();

  const compositeOps = [
    // Background drawn beneath the existing logo content
    { input: bgBuffer, blend: 'dest-over' }
  ];

  if (rounded) {
    const radius = Math.round(size * CONFIG.cornerRadius);
    const maskBuffer = await sharp(createRoundedRectMask(size, size, radius))
      .png()
      .toBuffer();
    // Rounded-corner mask applied last keeps the corners transparent
    compositeOps.push({ input: maskBuffer, blend: 'dest-in' });
  }

  return sharp(whiteSvgBuffer)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .composite(compositeOps)
    .png()
    .toBuffer();
}

/**
 * Generate the Win/Linux icon (rounded corners, transparent corners).
 *
 * @param {string} outputPath - Path to output PNG
 * @param {number} size - Icon size (width/height)
 */
async function generateIcon(outputPath, size) {
  try {
    console.log(`Generating icon: ${path.basename(outputPath)} (${size}x${size})`);

    const buffer = await renderIconBuffer(size, { rounded: true });
    fs.writeFileSync(outputPath, buffer);

    console.log(`✓ Created: ${path.basename(outputPath)}`);
  } catch (error) {
    console.error(`✗ Failed to generate ${path.basename(outputPath)}:`, error.message);
    throw error;
  }
}

/**
 * Generate ICO file (Windows) using png-to-ico.
 * Re-renders a white-on-blue rounded PNG at EACH exact size (crisper small
 * sizes than a single downscale of the 1024 source) and produces a real
 * multi-entry MS Windows icon resource (NOT a renamed PNG).
 *
 * @param {string} icoPath - Path to output ICO
 * @param {number[]} sizes - ICO entry sizes (e.g. [16, 24, 32, 48, 64, 128, 256])
 */
async function generateIco(icoPath, sizes) {
  try {
    console.log(`Generating ICO: ${path.basename(icoPath)} (entries: ${sizes.join(', ')})`);

    const pngBuffers = [];
    for (const size of sizes) {
      pngBuffers.push(await renderIconBuffer(size, { rounded: true }));
    }

    const icoBuffer = await pngToIco(pngBuffers);
    fs.writeFileSync(icoPath, icoBuffer);

    console.log(`✓ Created: ${path.basename(icoPath)} (${sizes.length} entries)`);
  } catch (error) {
    console.error(`✗ Failed to generate ${path.basename(icoPath)}:`, error.message);
    throw error;
  }
}

/**
 * Generate the macOS icon source PNG (full-bleed, opaque).
 * Own composite — NOT a resize of icon.png: no rounded-corner mask, the
 * #3CAEE9 background fills the whole 1024x1024 canvas (alpha 255 on every
 * pixel) with the white logo centered via `fit: 'contain'`.
 * electron-builder reads mac.icon as a PNG and generates the ICNS itself at
 * build time, so we intentionally never write an .icns file here.
 *
 * @param {string} outputPath - Path to output PNG (assets/icon-mac.png)
 * @param {number} size - Icon size (width/height)
 */
async function generateIcns(outputPath, size) {
  try {
    console.log(`Generating macOS icon source PNG (${size}x${size}, full-bleed)`);

    const buffer = await renderIconBuffer(size, { rounded: false });
    fs.writeFileSync(outputPath, buffer);

    console.log(`✓ Created: ${path.basename(outputPath)} (opaque full-bleed, electron-builder auto-converts to ICNS)`);
  } catch (error) {
    console.error(`✗ Failed to generate macOS icon source:`, error.message);
    throw error;
  }
}

/**
 * Generate the freedesktop hicolor icon set (Linux).
 * electron-builder 26.x's iconConverter ships a single-PNG `linux.icon`
 * through as-is (ONE hicolor size); a DIRECTORY of per-size PNGs named
 * `NxN.png` is installed into usr/share/icons/hicolor/NxN/apps/ for real
 * multi-size desktop icons. Same rounded white-on-blue rendering as
 * icon.png (design consistency).
 *
 * @param {string} dirPath - Output directory (assets/icons)
 * @param {number[]} sizes - Hicolor sizes (e.g. [16, 24, 32, 48, 64, 128, 256, 512])
 */
async function generateHicolorSet(dirPath, sizes) {
  try {
    console.log(`Generating freedesktop hicolor set: ${dirPath} (${sizes.join(', ')})`);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(`Created hicolor directory: ${dirPath}`);
    }

    for (const size of sizes) {
      const outputPath = path.join(dirPath, `${size}x${size}.png`);
      const buffer = await renderIconBuffer(size, { rounded: true });
      fs.writeFileSync(outputPath, buffer);
      console.log(`✓ Created: ${path.basename(outputPath)}`);
    }

    console.log(`✓ Hicolor set complete: ${sizes.length} PNGs in ${path.basename(dirPath)}/`);
  } catch (error) {
    console.error(`✗ Failed to generate hicolor set:`, error.message);
    throw error;
  }
}

/**
 * Update favicon file (inherits the fixed design via the same pipeline).
 *
 * @param {string} faviconPath - Path to output favicon
 * @param {number} size - Favicon size
 */
async function updateFavicon(faviconPath, size) {
  try {
    console.log(`Updating favicon: ${path.basename(faviconPath)} (${size}x${size})`);

    const buffer = await renderIconBuffer(size, { rounded: true });
    fs.writeFileSync(faviconPath, buffer);

    console.log(`✓ Updated: ${path.basename(faviconPath)}`);
  } catch (error) {
    console.error(`✗ Failed to update favicon ${path.basename(faviconPath)}:`, error.message);
    throw error;
  }
}

/**
 * Main function to generate all icons.
 */
async function main() {
  try {
    console.log('🚀 Starting icon generation...');
    console.log(`Source SVG: ${CONFIG.sourceSvg}`);
    console.log(`Output directory: ${CONFIG.outputDir}`);

    // Ensure output directory exists
    if (!fs.existsSync(CONFIG.outputDir)) {
      fs.mkdirSync(CONFIG.outputDir, { recursive: true });
      console.log(`Created output directory: ${CONFIG.outputDir}`);
    }

    // Check if source SVG exists
    if (!fs.existsSync(CONFIG.sourceSvg)) {
      throw new Error(`Source SVG not found: ${CONFIG.sourceSvg}`);
    }

    // Load and recolor the logo to white ONCE (asserts >=7 fills, in-memory only)
    whiteSvgBuffer = loadWhiteLogoSvgBuffer();

    // Generate main icon (1024x1024 PNG, rounded corners — Win/Linux)
    await generateIcon(CONFIG.iconPng, CONFIG.sizes.png);

    // Generate ICO (Windows, multi-entry 16-256)
    await generateIco(CONFIG.iconIco, CONFIG.sizes.ico);

    // Generate macOS full-bleed source PNG (electron-builder converts to ICNS at build time)
    await generateIcns(CONFIG.iconMacPng, CONFIG.sizes.png);

    await generateHicolorSet(CONFIG.iconsDir, CONFIG.sizes.hicolor);

    // Update favicon (64x64 PNG)
    await updateFavicon(CONFIG.favicon, CONFIG.sizes.favicon);

    console.log('\n✅ Icon generation completed successfully!');
    console.log('\nGenerated files:');
    console.log(`  - ${CONFIG.iconPng} (${CONFIG.sizes.png}x${CONFIG.sizes.png}, rounded corners)`);
    console.log(`  - ${CONFIG.iconIco} (real multi-entry ICO: ${CONFIG.sizes.ico.join(', ')})`);
    console.log(`  - ${CONFIG.iconMacPng} (${CONFIG.sizes.png}x${CONFIG.sizes.png}, full-bleed, electron-builder auto-converts to ICNS)`);
    console.log(`  - ${CONFIG.iconsDir}/{${CONFIG.sizes.hicolor.map((s) => `${s}x${s}`).join(',')}}.png (freedesktop hicolor set for linux.icon)`);
    console.log(`  - ${CONFIG.favicon} (${CONFIG.sizes.favicon}x${CONFIG.sizes.favicon})`);

  } catch (error) {
    console.error('\n❌ Icon generation failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { main };
