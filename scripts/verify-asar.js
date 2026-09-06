'use strict';

/**
 * Fails the build if any file critical to app startup is missing from the
 * packaged app.asar. Silent packaging drops (glob matcher regressions,
 * node_modules hoisting bugs, stale builder caches) otherwise only surface
 * at user runtime as ERR_FILE_NOT_FOUND — see win-asar-packaging evidence.
 *
 * @electron/asar's listPackage() joins header paths with path.join('/', ...),
 * so entries are '/main.js' on POSIX but '\main.js' (backslash-joined, with a
 * leading backslash) on Windows. Every comparison here MUST go through
 * normalizeEntry() — the raw strings are not comparable across platforms
 * (ci-empty-asar evidence: the gate failed 16/16 required files on
 * windows-latest against a complete, healthy app.asar).
 */

const fs = require('fs');
const path = require('path');
const { listPackage } = require('@electron/asar');

const REQUIRED_FILES = [
  'package.json',
  'main.js',
  'preload.js',
  'src/main/window/windowManager.js',
  'renderer/index.html',
  'renderer/main.html',
  'renderer/welcome.html',
  'renderer/language.html',
  'renderer/all-projects.html',
  'renderer/config.html',
  'renderer/create.html',
  'renderer/new.html',
  'renderer/open.html',
  'renderer/repo-select.html',
  'renderer/script.js',
  'renderer/i18n.js',
];

// npm-internal spawn files forced to windowsHide: true by the nested
// patch-package patches (patches/npm++@npmcli+*.patch). The packaged app
// must never regress to flashing console windows during workspace opens.
const PATCHED_NPM_SPAWN_FILES = [
  '@npmcli/promise-spawn/lib/index.js',
  '@npmcli/run-script/lib/make-spawn-args.js',
];

/**
 * Convert an asar listPackage() entry to a comparable forward-slash relative
 * path, regardless of the host OS separator.
 * @param {string} entry Raw entry ('/renderer/index.html' or '\renderer\index.html')
 * @returns {string} Normalized entry ('renderer/index.html')
 */
function normalizeEntry(entry) {
  return entry
    .replace(/^[\\/]+/, '')
    .replace(/\\/g, '/');
}

function findAsarArchives(distDir) {
  const results = [];
  if (!fs.existsSync(distDir)) {
    return results;
  }
  for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidates = [
      path.join(distDir, entry.name, 'resources', 'app.asar'),
    ];
    // macOS layout: dist/mac-arm64/Documental.app/Contents/Resources/app.asar
    const appBundles = fs.existsSync(path.join(distDir, entry.name))
      ? fs.readdirSync(path.join(distDir, entry.name), { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name.endsWith('.app'))
          .map((e) => path.join(distDir, entry.name, e.name, 'Contents', 'Resources', 'app.asar'))
      : [];
    for (const candidate of [...candidates, ...appBundles]) {
      if (fs.existsSync(candidate)) {
        results.push(candidate);
      }
    }
  }
  return results;
}

/**
 * Verify the npm-internal windowsHide patches survived into the packaged
 * app. electron-builder hoists npm's bundled deps from npm/node_modules
 * into top-level node_modules (dist's npm/node_modules keeps none of the
 * @npmcli packages — verified against win-unpacked), so each patched file
 * is looked up at the hoisted path and at the original nested path:
 * EVERY copy that exists must carry `windowsHide: true`, and at least one
 * copy must exist per file.
 * @param {string} asarPath - path to app.asar; unpacked files are its sibling `.unpacked` dir
 * @returns {boolean} true when every patched npm spawn file verifies
 */
function verifyPatchedNpmFiles(asarPath) {
  const unpackedRoot = `${asarPath}.unpacked`;
  let ok = true;
  for (const rel of PATCHED_NPM_SPAWN_FILES) {
    const parts = rel.split('/');
    const candidates = [
      path.join(unpackedRoot, 'node_modules', ...parts), // hoisted (packaged layout)
      path.join(unpackedRoot, 'node_modules', 'npm', 'node_modules', ...parts), // nested (dev-tree layout)
    ];
    const found = candidates.filter((p) => fs.existsSync(p));
    if (found.length === 0) {
      console.error(`    PATCHED-NPM MISSING: ${rel} — no hoisted or nested copy in app.asar.unpacked`);
      ok = false;
      continue;
    }
    for (const target of found) {
      if (!/windowsHide:\s*true/.test(fs.readFileSync(target, 'utf8'))) {
        console.error(
          `    PATCHED-NPM STALE: ${path.relative(process.cwd(), target)} lacks windowsHide: true` +
            ' (patch-package patch not applied before the build)'
        );
        ok = false;
      }
    }
  }
  if (ok) {
    console.log(`    all ${PATCHED_NPM_SPAWN_FILES.length} patched npm spawn files carry windowsHide: true`);
  }
  return ok;
}

function verifyArchive(asarPath) {
  const entries = listPackage(asarPath).map(normalizeEntry);
  const entrySet = new Set(entries);
  const missing = REQUIRED_FILES.filter((f) => !entrySet.has(f));

  const rendererCount = entries.filter((e) => e.startsWith('renderer/')).length;
  const srcCount = entries.filter((e) => e.startsWith('src/')).length;

  console.log(`  asar: ${path.relative(process.cwd(), asarPath)}`);
  console.log(`    total entries: ${entries.length}, renderer/: ${rendererCount}, src/: ${srcCount}`);

  if (missing.length > 0) {
    console.error(`    MISSING (${missing.length}):`);
    for (const file of missing) {
      console.error(`      - ${file}`);
    }
    return false;
  }
  console.log(`    all ${REQUIRED_FILES.length} required startup files present`);
  return verifyPatchedNpmFiles(asarPath);
}

function main() {
  const distDir = path.resolve(__dirname, '..', 'dist');
  const archives = findAsarArchives(distDir);

  if (archives.length === 0) {
    console.error(`No app.asar found under ${distDir} — run a build first.`);
    process.exit(1);
  }

  console.log(`Verifying ${archives.length} app.asar archive(s):`);
  const results = archives.map(verifyArchive);
  if (results.some((ok) => !ok)) {
    console.error(
      '\napp.asar verification FAILED — the packaged app would crash at startup ' +
        '(ERR_FILE_NOT_FOUND). Do not ship. See .omo/evidence/win-asar-packaging.md.'
    );
    process.exit(1);
  }
  console.log('\napp.asar verification passed.');
}

module.exports = { normalizeEntry, REQUIRED_FILES, verifyPatchedNpmFiles, PATCHED_NPM_SPAWN_FILES };

if (require.main === module) {
  main();
}
