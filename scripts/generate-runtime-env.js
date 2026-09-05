'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const { isDummyClientId } = require('./lib/client-id-guard');

const projectRoot = path.resolve(__dirname, '..');

/**
 * Load environment variables from a file if it exists.
 * @param {string} envPath - Absolute path to env file
 * @param {boolean} [override=false] - Whether to override existing values
 */
function loadEnvFile(envPath, override = false) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const result = dotenv.config({ path: envPath, override });
  if (result.error) {
    console.warn(`⚠️  Failed to load env file at ${envPath}:`, result.error.message);
  } else {
    console.log(`ℹ️  Loaded environment variables from ${envPath}`);
  }
}

function main() {
  console.log('🔧 Generating runtime environment configuration...');

  // Load default env files (development)
  loadEnvFile(path.join(projectRoot, '.env'));
  loadEnvFile(path.join(projectRoot, '.env.local'));

  // Load electron-builder env (overrides)
  loadEnvFile(path.join(projectRoot, 'electron-builder.env'), true);

  const clientId = (process.env.GITHUB_CLIENT_ID || '').trim();
  if (!clientId) {
    console.error('❌ GITHUB_CLIENT_ID is not defined.');
    console.error('   Please set GITHUB_CLIENT_ID in your environment or electron-builder.env before building.');
    process.exit(1);
  }

  // Guard: known dummy/placeholder client IDs must never ship in a build.
  if (isDummyClientId(clientId)) {
    if (process.env.ALLOW_DUMMY_GITHUB_CLIENT_ID === '1') {
      console.warn('⚠️  WARNING: GITHUB_CLIENT_ID is a dummy/placeholder value ("%s").', clientId);
      console.warn('⚠️  WARNING: this build CANNOT be shipped or distributed (GitHub auth will not work).');
      console.warn('⚠️  WARNING: allowed only because ALLOW_DUMMY_GITHUB_CLIENT_ID=1 is set (local spikes/dev).');
    } else {
      console.error('❌ GITHUB_CLIENT_ID is set to a known dummy/placeholder value ("%s").', clientId);
      console.error('   Dummy client IDs must never ship — the packaged app would fail GitHub authentication.');
      console.error('   Fix: set the real client ID in electron-builder.env (gitignored):');
      console.error('       GITHUB_CLIENT_ID=<your real client ID>');
      console.error('   Release/CI: the workflow injects the GH_CLIENT_ID secret as GITHUB_CLIENT_ID');
      console.error('   (GITHUB_* secret names are reserved on GitHub Actions) — see docs/release-workflow.md.');
      console.error('   Local spikes ONLY: prefix the command with ALLOW_DUMMY_GITHUB_CLIENT_ID=1 to bypass.');
      process.exit(1);
    }
  }

  const outputDir = path.join(projectRoot, 'resources', 'config');
  fs.mkdirSync(outputDir, { recursive: true });

  const runtimeConfig = {
    generatedAt: new Date().toISOString(),
    GITHUB_CLIENT_ID: clientId
  };

  // Include theme configuration if set in environment
  const theme = (process.env.THEME || '').trim();
  if (theme) {
    runtimeConfig.THEME = theme;
  }

  const themeMode = (process.env.THEME_MODE || '').trim();
  if (themeMode) {
    runtimeConfig.THEME_MODE = themeMode;
  }

  const gitProvider = (process.env.GIT_PROVIDER || '').trim();
  runtimeConfig.GIT_PROVIDER = gitProvider || 'isomorphic-git';

  const outputPath = path.join(outputDir, 'runtime-env.json');
  fs.writeFileSync(outputPath, JSON.stringify(runtimeConfig, null, 2), 'utf8');
  console.log(`✅ Runtime environment file created at ${outputPath}`);
}

if (require.main === module) {
  main();
}

module.exports = { main, isDummyClientId };
