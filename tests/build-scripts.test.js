/**
 * @fileoverview Regression tests for build scripts and config unification (Bugs 3 & 4)
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, vi } from 'vitest';

const fs = await vi.importActual('fs');
const path = await vi.importActual('path');

const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
const ymlContent = fs.readFileSync(path.resolve(process.cwd(), 'electron-builder.yml'), 'utf8');

describe('Build Scripts', () => {
  const scripts = pkg.scripts;

  it('build:win should include build:theme and build:css', () => {
    expect(scripts['build:win']).toContain('build:theme');
    expect(scripts['build:win']).toContain('build:css');
  });

  it('build:win:portable should include build:theme and build:css', () => {
    expect(scripts['build:win:portable']).toContain('build:theme');
    expect(scripts['build:win:portable']).toContain('build:css');
  });

  it('build:linux should include build:theme and build:css', () => {
    expect(scripts['build:linux']).toContain('build:theme');
    expect(scripts['build:linux']).toContain('build:css');
  });

  it('build:linux:deb should include build:theme and build:css', () => {
    expect(scripts['build:linux:deb']).toContain('build:theme');
    expect(scripts['build:linux:deb']).toContain('build:css');
  });

  it('build:linux:dir should include build:theme and build:css', () => {
    expect(scripts['build:linux:dir']).toContain('build:theme');
    expect(scripts['build:linux:dir']).toContain('build:css');
  });

  it('build:linux:snap should include build:theme and build:css', () => {
    expect(scripts['build:linux:snap']).toContain('build:theme');
    expect(scripts['build:linux:snap']).toContain('build:css');
  });

  it('build:linux:appimage should include build:theme and build:css', () => {
    expect(scripts['build:linux:appimage']).toContain('build:theme');
    expect(scripts['build:linux:appimage']).toContain('build:css');
  });

  it('build:macos should include build:theme and build:css', () => {
    expect(scripts['build:macos']).toContain('build:theme');
    expect(scripts['build:macos']).toContain('build:css');
  });

  it('build:all should include build:theme and build:css', () => {
    expect(scripts['build:all']).toContain('build:theme');
    expect(scripts['build:all']).toContain('build:css');
  });

  it('build:theme should run BEFORE build:css in all scripts', () => {
    const scriptsToCheck = [
      'build:win', 'build:win:portable', 'build:linux', 'build:linux:deb',
      'build:linux:dir', 'build:linux:snap', 'build:linux:appimage',
      'build:macos', 'build:all'
    ];
    for (const scriptName of scriptsToCheck) {
      const script = scripts[scriptName];
      const themeIdx = script.indexOf('build:theme');
      const cssIdx = script.indexOf('build:css');
      if (themeIdx !== -1 && cssIdx !== -1) {
        expect(themeIdx).toBeLessThan(cssIdx);
      }
    }
  });
});

describe('Config Unification', () => {
  it('package.json should NOT have a "build" key (electron-builder.yml is the single config source)', () => {
    // A package.json build field makes electron-builder SKIP electron-builder.yml
    // entirely (config shadowing) — removed in the icon fix; keep it gone.
    expect(pkg.build).toBeUndefined();
  });

  it('electron-builder.yml should exist and be parseable', () => {
    expect(ymlContent).toBeTruthy();
  });

  it('electron-builder.yml must NOT use the unsupported $fromFile macro', () => {
    // app-builder-lib 26.x silently ships the literal {$fromFile: ...} object
    // into the packaged package.json instead of reading the file.
    expect(ymlContent).not.toContain('$fromFile');
    const configLines = ymlContent.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(configLines.some((l) => l.trim().startsWith('extraMetadata:'))).toBe(false);
  });

  it('electron-builder.yml should own packaging keys (files/win/linux/asarUnpack)', () => {
    expect(ymlContent).toContain('files');
    expect(ymlContent).toContain('win');
    expect(ymlContent).toContain('linux');
    expect(ymlContent).toContain('asarUnpack');
  });

  it('electron-builder.yml should have extraResources', () => {
    expect(ymlContent).toContain('extraResources');
  });

  it('electron-builder.yml should include themes in files', () => {
    expect(ymlContent).toContain('themes');
  });

  it('electron-builder.yml should have portable in win targets', () => {
    expect(ymlContent).toContain('portable');
  });
});

describe('verify-asar entry normalization', () => {
  const { normalizeEntry, REQUIRED_FILES } = require('../scripts/verify-asar.js');

  it('normalizes POSIX-style listPackage() entries', () => {
    expect(normalizeEntry('/renderer/index.html')).toBe('renderer/index.html');
    expect(normalizeEntry('/main.js')).toBe('main.js');
  });

  it('normalizes Windows-style listPackage() entries (leading backslash, backslash joins)', () => {
    // @electron/asar joins header paths with path.join('/', ...) — on Windows
    // that yields '\renderer\index.html'. The gate compared these against
    // forward-slash REQUIRED_FILES and failed 16/16 on a healthy asar.
    expect(normalizeEntry('\\renderer\\index.html')).toBe('renderer/index.html');
    expect(normalizeEntry('\\main.js')).toBe('main.js');
    expect(normalizeEntry('\\src\\main\\window\\windowManager.js')).toBe('src/main/window/windowManager.js');
  });

  it('every required file normalizes to itself (self-check of REQUIRED_FILES shape)', () => {
    for (const file of REQUIRED_FILES) {
      expect(normalizeEntry(`/${file}`)).toBe(file);
      expect(normalizeEntry(`\\${file.split('/').join('\\')}`)).toBe(file);
    }
  });
});
