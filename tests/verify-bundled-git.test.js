/**
 * Unit tests for scripts/verify-bundled-git.js — findGitBinary layout support
 * (flat Linux/Windows resources, macOS .app/Contents/Resources bundles).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

// Global setup.js mocks fs/path; native require returns the real CJS module
// objects (spyOn-able, and the same instances the script itself requires).
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { BundledGitVerifier } = require('../scripts/verify-bundled-git.js');

const originalPlatform = process.platform;

// findGitBinary is stateless, so skip the constructor (which reads the dugite
// manifest and may call process.exit) by instantiating from the prototype.
function makeVerifier() {
  return Object.create(BundledGitVerifier.prototype);
}

const dir = name => ({ name, isDirectory: () => true });

// existsPaths: absolute paths for which fs.existsSync returns true.
// dirs: map of absolute dir path -> Dirent-like entries for fs.readdirSync.
function stubFs({ existsPaths = [], dirs = {} } = {}) {
  const existsSet = new Set(existsPaths.map(p => path.resolve(p)));
  const dirsMap = new Map(Object.entries(dirs).map(([d, entries]) => [path.resolve(d), entries]));
  vi.spyOn(fs, 'existsSync').mockImplementation(p => existsSet.has(path.resolve(p)));
  vi.spyOn(fs, 'readdirSync').mockImplementation(p => {
    const entries = dirsMap.get(path.resolve(p));
    if (!entries) throw new Error(`unexpected readdirSync: ${p}`);
    return entries;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('verify-bundled-git findGitBinary', () => {
  it('finds git in flat linux layout (resources/app.asar.unpacked)', () => {
    const artifact = path.resolve('/dist/linux-unpacked');
    const binary = path.join(artifact, 'resources', 'app.asar.unpacked', 'node_modules', 'dugite', 'git', 'bin', 'git');
    stubFs({ existsPaths: [artifact, path.join(artifact, 'resources'), binary], dirs: { [artifact]: [] } });

    expect(makeVerifier().findGitBinary(artifact)).toBe(binary);
  });

  it('finds git.exe in flat windows layout (resources/git)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const artifact = path.resolve('/dist/win-unpacked');
    const binary = path.join(artifact, 'resources', 'git', 'cmd', 'git.exe');
    stubFs({ existsPaths: [artifact, path.join(artifact, 'resources'), binary], dirs: { [artifact]: [] } });

    expect(makeVerifier().findGitBinary(artifact)).toBe(binary);
  });

  it('finds git inside macOS .app/Contents/Resources layout', () => {
    const artifact = path.resolve('/dist/mac-unpacked');
    const resources = path.join(artifact, 'Sveltia.app', 'Contents', 'Resources');
    const binary = path.join(resources, 'app.asar.unpacked', 'node_modules', 'dugite', 'git', 'bin', 'git');
    stubFs({
      existsPaths: [artifact, resources, binary],
      dirs: { [artifact]: [dir('Sveltia.app')] }
    });

    expect(makeVerifier().findGitBinary(artifact)).toBe(binary);
  });

  it('checks every .app bundle when multiple exist (universal + x64)', () => {
    const artifact = path.resolve('/dist/mac-unpacked');
    const alphaResources = path.join(artifact, 'Alpha.app', 'Contents', 'Resources');
    const betaResources = path.join(artifact, 'Beta.app', 'Contents', 'Resources');
    const binary = path.join(betaResources, 'git', 'bin', 'git');
    stubFs({
      existsPaths: [artifact, alphaResources, betaResources, binary],
      dirs: { [artifact]: [dir('Beta.app'), dir('Alpha.app')] }
    });

    expect(makeVerifier().findGitBinary(artifact)).toBe(binary);
  });

  it('returns null when no layout contains the binary', () => {
    const artifact = path.resolve('/dist/linux-unpacked');
    stubFs({
      existsPaths: [artifact, path.join(artifact, 'resources')],
      dirs: { [artifact]: [] }
    });

    expect(makeVerifier().findGitBinary(artifact)).toBeNull();
  });
});
