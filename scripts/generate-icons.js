"use strict";

/**
 * Generate Electron build icons from optimized SVG logo.
 * Creates square PNG icons with rounded corners and solid background
 * for use with electron-builder.
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
  iconIcns: path.join(__dirname, '../assets/icon.icns'),
  
  // Icon sizes
  sizes: {
    png: 1024,     // High-res source for electron-builder (mac auto-converts to ICNS)
    favicon: 64     // For renderer/assets/icon-favicon.png
  },
  
  // Background color (from SVG primary color #3CAEE9)
  backgroundColor: '#3CAEE9',
  
  // Rounded corner radius (20% of size)
  cornerRadius: 0.2
};

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
 * Generate icon with rounded corners and background.
 * 
 * @param {string} inputPath - Path to source SVG
 * @param {string} outputPath - Path to output PNG
 * @param {number} size - Icon size (width/height)
 * @param {boolean} isFavicon - Whether this is a favicon (smaller)
 * @returns {Promise} - Sharp promise
 */
async function generateIcon(inputPath, outputPath, size, isFavicon = false) {
  try {
    console.log(`Generating icon: ${path.basename(outputPath)} (${size}x${size})`);
    
    const radius = Math.round(size * CONFIG.cornerRadius);
    
    // Create rounded rectangle mask
    const mask = await sharp(createRoundedRectMask(size, size, radius))
      .png()
      .toBuffer();
    
    // Composite operations:
    // 1. Load source SVG
    // 2. Resize to target size
    // 3. Add rounded corners via mask
    // 4. Add background color
    await sharp(inputPath)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .composite([
        // Apply rounded corners mask
        { input: mask, blend: 'dest-in' },
        // Add background color
        { input: { create: { width: size, height: size, channels: 4, background: CONFIG.backgroundColor } }, blend: 'over' }
      ])
      .toFile(outputPath);
    
    console.log(`✓ Created: ${path.basename(outputPath)}`);
    
  } catch (error) {
    console.error(`✗ Failed to generate ${path.basename(outputPath)}:`, error.message);
    throw error;
  }
}

/**
 * Generate ICO file (Windows) from PNG using png-to-ico.
 * Produces a real MS Windows icon resource (NOT a renamed PNG).
 *
 * @param {string} pngPath - Path to source PNG
 * @param {string} icoPath - Path to output ICO
 * @param {number} size - Icon size (unused; source PNG size is used)
 */
async function generateIco(pngPath, icoPath, size) {
  try {
    console.log(`Generating ICO: ${path.basename(icoPath)} (${size}x${size})`);

    const pngBuffer = fs.readFileSync(pngPath);
    const icoBuffer = await pngToIco(pngBuffer);
    fs.writeFileSync(icoPath, icoBuffer);

    console.log(`✓ Created: ${path.basename(icoPath)}`);
  } catch (error) {
    console.error(`✗ Failed to generate ${path.basename(icoPath)}:`, error.message);
    throw error;
  }
}

/**
 * Generate icon for macOS.
 * electron-builder accepts a 1024×1024 PNG and auto-converts it to ICNS
 * internally, so we resize the source PNG rather than producing a fake
 * ICNS file. The output is written as a PNG (.png extension) so that no
 * invalid ICNS data is ever created.
 *
 * @param {string} pngPath - Path to source PNG
 * @param {string} icnsPath - Path to output (kept for config compatibility; unused)
 * @param {number} size - Icon size
 */
async function generateIcns(pngPath, icnsPath, size) {
  try {
    console.log(`Generating macOS icon source PNG (${size}x${size})`);

    // electron-builder reads mac.icon as a PNG and generates the ICNS itself,
    // so we only need a high-resolution PNG. We intentionally do NOT write an
    // .icns file (the previous implementation copied PNG bytes into a .icns
    // path, producing an invalid file).
    const macPngPath = path.join(path.dirname(pngPath), 'icon-mac.png');
    await sharp(pngPath)
      .resize(size, size)
      .toFile(macPngPath);

    console.log(`✓ Created: ${path.basename(macPngPath)} (electron-builder auto-converts to ICNS)`);
  } catch (error) {
    console.error(`✗ Failed to generate macOS icon source:`, error.message);
    // Don't throw for ICNS as it's not critical for all platforms
  }
}

/**
 * Update favicon file.
 * 
 * @param {string} pngPath - Path to source PNG
 * @param {string} faviconPath - Path to output favicon
 * @param {number} size - Favicon size
 */
async function updateFavicon(pngPath, faviconPath, size) {
  try {
    console.log(`Updating favicon: ${path.basename(faviconPath)} (${size}x${size})`);
    
    await sharp(pngPath)
      .resize(size, size)
      .toFile(faviconPath);
    
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
    
    // Generate main icon (512x512 PNG)
    await generateIcon(CONFIG.sourceSvg, CONFIG.iconPng, CONFIG.sizes.png);
    
    // Generate ICO (Windows)
    await generateIco(CONFIG.iconPng, CONFIG.iconIco, CONFIG.sizes.png);
    
    // Generate ICNS (macOS) - placeholder
    await generateIcns(CONFIG.iconPng, CONFIG.iconIcns, CONFIG.sizes.png);
    
    // Update favicon (64x64 PNG)
    await updateFavicon(CONFIG.iconPng, path.join(__dirname, '../renderer/assets/icon-favicon.png'), CONFIG.sizes.favicon);
    
    console.log('\n✅ Icon generation completed successfully!');
    console.log('\nGenerated files:');
    console.log(`  - ${CONFIG.iconPng} (${CONFIG.sizes.png}x${CONFIG.sizes.png})`);
    console.log(`  - ${CONFIG.iconIco} (real ICO format, ${CONFIG.sizes.png}x${CONFIG.sizes.png})`);
    console.log(`  - assets/icon-mac.png (${CONFIG.sizes.png}x${CONFIG.sizes.png}, electron-builder auto-converts to ICNS)`);
    console.log(`  - renderer/assets/icon-favicon.png (${CONFIG.sizes.favicon}x${CONFIG.sizes.favicon})`);
    
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