#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Verifies that the packaged artifact contains the bundled git binary
// (dugite) at the expected version, matching verify-build.js conventions.
class BundledGitVerifier {
  constructor(distBase) {
    this.projectRoot = path.join(__dirname, '..');
    this.distBasePath = path.resolve(distBase);
    this.expectedVersion = this.readExpectedGitVersion();
  }

  // Parse git version from embedded-git.json entries (name/URL field,
  // e.g. 'dugite-native-v2.53.0-4098283-ubuntu-x64.tar.gz' -> '2.53.0')
  readExpectedGitVersion() {
    const manifestPath = path.join(
      this.projectRoot,
      'node_modules',
      'dugite',
      'script',
      'embedded-git.json'
    );
    if (!fs.existsSync(manifestPath)) {
      console.error(`❌ embedded-git.json not found: ${manifestPath} (run npm install)`);
      process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = manifest['linux-x64'] || manifest['win32-x64'] || Object.values(manifest)[0];
    const source = entry.name || entry.url || '';
    const match = source.match(/git(\d+\.\d+\.\d+)/) || source.match(/v(\d+\.\d+\.\d+)/);
    if (!match) {
      console.error(`❌ Could not parse git version from embedded-git.json entry: "${source}"`);
      process.exit(1);
    }
    return match[1];
  }

  // Locate *-unpacked artifacts (linux-unpacked, win-unpacked, mac-unpacked, linux-arm64-unpacked...)
  findArtifacts() {
    if (!fs.existsSync(this.distBasePath)) {
      return null;
    }
    return fs
      .readdirSync(this.distBasePath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && /-unpacked$/.test(dirent.name))
      .map(dirent => path.join(this.distBasePath, dirent.name));
  }

  // Resolve the git binary inside the artifact, supporting both layouts:
  // - resources/app.asar.unpacked/node_modules/dugite/git/
  // - resources/git/
  findGitBinary(artifactPath) {
    const resourcesPath = path.join(artifactPath, 'resources');
    const gitRoots = [
      path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'dugite', 'git'),
      path.join(resourcesPath, 'git')
    ];

    const candidates = process.platform === 'win32' ? ['cmd/git.exe', 'bin/git.exe'] : ['bin/git'];

    for (const root of gitRoots) {
      for (const rel of candidates) {
        const binaryPath = path.join(root, ...rel.split('/'));
        if (fs.existsSync(binaryPath)) {
          return binaryPath;
        }
      }
    }
    return null;
  }

  runGitVersion(binaryPath) {
    return new Promise(resolve => {
      execFile(binaryPath, ['--version'], { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: error.message });
        } else {
          resolve({ ok: true, output: `${stdout}${stderr}`.trim() });
        }
      });
    });
  }

  async verify() {
    console.log('🔍 Starting bundled git verification...\n');

    const artifacts = this.findArtifacts();
    if (!artifacts || artifacts.length === 0) {
      console.error(`❌ No unpacked artifact found under ${this.distBasePath}. Run build first.`);
      return false;
    }

    console.log(`📁 Found ${artifacts.length} artifact(s):`);
    artifacts.forEach((a, i) => console.log(`   ${i + 1}. ${a}`));
    console.log(`🎯 Expected git version: ${this.expectedVersion}\n`);

    let overallSuccess = true;

    for (const artifact of artifacts) {
      console.log(`🔨 Verifying: ${path.basename(artifact)}`);
      const binaryPath = this.findGitBinary(artifact);

      if (!binaryPath) {
        console.error(`   ❌ Bundled git binary not found (checked app.asar.unpacked and resources/git layouts)`);
        overallSuccess = false;
        continue;
      }

      const result = await this.runGitVersion(binaryPath);
      if (!result.ok) {
        console.error(`   ❌ Bundled git not executable: ${binaryPath} — ${result.error}`);
        overallSuccess = false;
        continue;
      }

      const match = result.output.match(/git version (\d+\.\d+\.\d+)/);
      if (!match) {
        console.error(`   ❌ Could not parse git version from output: "${result.output}"`);
        overallSuccess = false;
        continue;
      }

      if (match[1] !== this.expectedVersion) {
        console.error(`   ❌ Version mismatch: artifact has git ${match[1]}, expected ${this.expectedVersion} (${binaryPath})`);
        overallSuccess = false;
        continue;
      }

      console.log(`   ✅ Bundled git OK: ${binaryPath} (git version ${match[1]})`);
    }

    console.log(`\n📊 Verification Summary:`);
    console.log(`   ${overallSuccess ? '✅' : '❌'} Overall status: ${overallSuccess ? 'PASS' : 'FAIL'}`);
    return overallSuccess;
  }
}

// Parse CLI args: --dist <path> (default: dist)
function parseArgs() {
  const args = process.argv.slice(2);
  let dist = 'dist';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dist' && args[i + 1]) {
      dist = args[++i];
    }
  }
  return dist;
}

const verifier = new BundledGitVerifier(parseArgs());
verifier.verify().then(success => process.exit(success ? 0 : 1));
