/**
 * Unit tests for the GitHub client ID build guard (D5):
 * - scripts/lib/client-id-guard.js — denylist validator
 * - scripts/generate-runtime-env.js — generate-time rejection + local-dev escape hatch
 * - scripts/verify-build.js — post-build assertion on packaged runtime-env.json
 *
 * All client IDs below are fixtures (denylisted dummies or made-up
 * correctly-formatted values) — no real client ID is committed.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');

const {
  isDummyClientId,
  SUBSTRING_DENYLIST,
  EXACT_DENYLIST
} = require('../../scripts/lib/client-id-guard.js');
const {
  BuildVerifier,
  validateRuntimeEnvGithubClientId
} = require('../../scripts/verify-build.js');

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testsDir, '..', '..');
const generateScript = path.join(projectRoot, 'scripts', 'generate-runtime-env.js');
const realRuntimeEnvPath = path.join(projectRoot, 'resources', 'config', 'runtime-env.json');

const REAL_FORMAT_IDS = [
  'Iv1.8a61f1b2c3d4e5f6',
  'Iv1.abcdef0123456789',
  'a1b2c3d4e5f6a7b8c9d0'
];

let tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-id-guard-'));
  tempDirs.push(dir);
  return dir;
}

function writeRuntimeEnv(buildDir, config) {
  const configDir = path.join(buildDir, 'resources', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'runtime-env.json'), JSON.stringify(config, null, 2), 'utf8');
}

function runGenerateScript(envOverrides) {
  const outputPath = path.join(makeTempDir(), 'runtime-env.json');
  const result = spawnSync('node', [generateScript], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60000,
    // RUNTIME_ENV_OUTPUT keeps the spawned script away from the real resources/config/runtime-env.json.
    env: { ...process.env, RUNTIME_ENV_OUTPUT: outputPath, ...envOverrides }
  });
  return { result, outputPath };
}

let realRuntimeEnvExistedAtStart = false;

beforeAll(() => {
  realRuntimeEnvExistedAtStart = fs.existsSync(realRuntimeEnvPath);
});

afterEach(() => {
  tempDirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
  tempDirs = [];
});

afterAll(() => {
  // Regression guard: spawning generate-runtime-env.js from tests must never create the real
  // runtime-env.json — it is loaded by src/config/github-config.js in other suites
  // (tests/ipc/git.test.js, tests/ipc/gitClone-security.test.js) and pollutes their auth behavior.
  if (!realRuntimeEnvExistedAtStart) {
    expect(
      fs.existsSync(realRuntimeEnvPath),
      'client-id-guard tests created resources/config/runtime-env.json (test-environment pollution)'
    ).toBe(false);
  }
});

describe('isDummyClientId', () => {
  it('rejects every substring denylist entry', () => {
    SUBSTRING_DENYLIST.forEach(entry => {
      expect(isDummyClientId(entry), entry).toBe(true);
    });
  });

  it('rejects every exact denylist entry', () => {
    EXACT_DENYLIST.forEach(entry => {
      expect(isDummyClientId(entry), entry).toBe(true);
    });
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(isDummyClientId('SPIKE-LOCAL-DUMMY')).toBe(true);
    expect(isDummyClientId('Your_GitHub_Client_ID_Here')).toBe(true);
    expect(isDummyClientId('  Dummy  ')).toBe(true);
    expect(isDummyClientId('\tPlaceholder\n')).toBe(true);
  });

  it('catches denylisted markers embedded in longer values', () => {
    expect(isDummyClientId('spike-local-dummy-2')).toBe(true);
    expect(isDummyClientId('prefix-dummy-suffix')).toBe(true);
    expect(isDummyClientId('my-changeme-id')).toBe(true);
  });

  it('does not reject exact-only tokens when embedded in real-looking values', () => {
    expect(isDummyClientId('testing123')).toBe(false);
    expect(isDummyClientId(' Iv1.test-prefix.abc ')).toBe(false);
  });

  it('accepts real-format GitHub client IDs', () => {
    REAL_FORMAT_IDS.forEach(id => {
      expect(isDummyClientId(id), id).toBe(false);
    });
  });

  it('leaves empty/missing values to the caller (existing empty-check)', () => {
    expect(isDummyClientId('')).toBe(false);
    expect(isDummyClientId('   ')).toBe(false);
    expect(isDummyClientId(undefined)).toBe(false);
    expect(isDummyClientId(null)).toBe(false);
    expect(isDummyClientId(12345)).toBe(false);
  });
});

describe('generate-runtime-env.js guard', () => {
  it('exits 1 with an actionable error when GITHUB_CLIENT_ID is a known dummy', () => {
    const { result } = runGenerateScript({ GITHUB_CLIENT_ID: 'spike-local-dummy' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('spike-local-dummy');
    expect(result.stderr).toContain('release-workflow');
    expect(result.stderr).toContain('electron-builder.env');
  });

  it('exits 1 for the placeholder dummy your_github_client_id_here', () => {
    const { result } = runGenerateScript({ GITHUB_CLIENT_ID: 'your_github_client_id_here' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release-workflow');
  });

  it('escape hatch ALLOW_DUMMY_GITHUB_CLIENT_ID=1 exits 0 with a loud warning', () => {
    const { result, outputPath } = runGenerateScript({
      GITHUB_CLIENT_ID: 'spike-local-dummy',
      ALLOW_DUMMY_GITHUB_CLIENT_ID: '1'
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('WARNING');
    expect(output).toContain('dummy');

    // The write must land on the redirected temp path, proving RUNTIME_ENV_OUTPUT took effect.
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8')).GITHUB_CLIENT_ID).toBe('spike-local-dummy');
  });
});

describe('validateRuntimeEnvGithubClientId (verify-build)', () => {
  it('fails on missing key, empty value, and null config', () => {
    expect(validateRuntimeEnvGithubClientId({}).ok).toBe(false);
    expect(validateRuntimeEnvGithubClientId({ GITHUB_CLIENT_ID: '' }).ok).toBe(false);
    expect(validateRuntimeEnvGithubClientId({ GITHUB_CLIENT_ID: '   ' }).ok).toBe(false);
    expect(validateRuntimeEnvGithubClientId(null).ok).toBe(false);
  });

  it('fails on denylisted dummy values', () => {
    const result = validateRuntimeEnvGithubClientId({ GITHUB_CLIENT_ID: 'spike-local-dummy' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('dummy');
  });

  it('passes on real-format client IDs', () => {
    REAL_FORMAT_IDS.forEach(id => {
      expect(validateRuntimeEnvGithubClientId({ GITHUB_CLIENT_ID: id }).ok, id).toBe(true);
    });
  });
});

describe('BuildVerifier.checkRuntimeEnv (fixture dist dirs)', () => {
  it('fails when packaged runtime-env.json contains a dummy', () => {
    const buildDir = path.join(makeTempDir(), 'win-unpacked');
    writeRuntimeEnv(buildDir, { GITHUB_CLIENT_ID: 'spike-local-dummy' });

    const result = new BuildVerifier().checkRuntimeEnv(buildDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('dummy');
  });

  it('passes when packaged runtime-env.json has a real-format ID', () => {
    const buildDir = path.join(makeTempDir(), 'linux-unpacked');
    writeRuntimeEnv(buildDir, { GITHUB_CLIENT_ID: 'Iv1.8a61f1b2c3d4e5f6' });

    expect(new BuildVerifier().checkRuntimeEnv(buildDir).ok).toBe(true);
  });

  it('fails when packaged runtime-env.json is missing', () => {
    const buildDir = path.join(makeTempDir(), 'win-unpacked');
    fs.mkdirSync(buildDir, { recursive: true });

    const result = new BuildVerifier().checkRuntimeEnv(buildDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('generate-runtime-env');
  });

  it('fails when packaged runtime-env.json is invalid JSON', () => {
    const buildDir = path.join(makeTempDir(), 'win-unpacked');
    const configDir = path.join(buildDir, 'resources', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'runtime-env.json'), '{not json', 'utf8');

    const result = new BuildVerifier().checkRuntimeEnv(buildDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('JSON');
  });
});
