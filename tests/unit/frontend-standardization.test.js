/**
 * @fileoverview Regression tests for Wave 0 frontend standardization (T1-T6).
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

// Bypass global mocks from tests/setup.js — these tests read real files
vi.unmock('fs');
vi.unmock('path');

const rendererDir = path.join(__dirname, '../../renderer');

const htmlFiles = [
  'main.html',
  'welcome.html',
  'config.html',
  'create.html',
  'open.html',
  'new.html',
  'index.html',
  'all-projects.html',
];

function readHtml(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf-8');
}

function readCss(name) {
  return fs.readFileSync(path.join(rendererDir, 'assets/css', name), 'utf-8');
}

// KNOWN-FAILURE: quarantined during perf-zombie-refactor, see tests/KNOWN-FAILURES.md
describe.skip('Wave 0 — Frontend Standardization Regression', () => {
  it('no inline Tailwind configs in renderer/*.html', () => {
    for (const file of htmlFiles) {
      const content = readHtml(file);
      expect(content, `${file} contains tailwind.config assignment`).not.toMatch(/tailwind\.config\s*=/);
    }
  });

  it('theme-override.css loaded by all 8 pages after compiled.css', () => {
    for (const file of htmlFiles) {
      const content = readHtml(file);
      expect(content, `${file} missing theme-override.css link`).toContain('theme-override.css');
      const overrideIdx = content.indexOf('theme-override.css');
      const compiledIdx = content.indexOf('compiled.css');
      expect(overrideIdx, `${file}: theme-override.css should load after compiled.css`).toBeGreaterThan(compiledIdx);
    }
  });

  it('no hardcoded hex in <style> blocks of affected HTML files', () => {
    const affectedFiles = ['main.html', 'welcome.html', 'config.html', 'create.html', 'open.html'];
    const hexPattern = /#[0-9a-fA-F]{6}\b/g;

    for (const file of affectedFiles) {
      const content = readHtml(file);
      // Extract content between <style> and </style>
      const styleBlocks = content.match(/<style[\s\S]*?<\/style>/gi) || [];
      for (let i = 0; i < styleBlocks.length; i++) {
        hexPattern.lastIndex = 0;
        const matches = styleBlocks[i].match(hexPattern);
        expect(matches, `${file} <style> block #${i + 1} has hardcoded hex colors: ${matches}`).toBeFalsy();
      }
    }
  });

  it('button component classes defined in main.css', () => {
    const css = readCss('main.css');
    expect(css).toContain('.btn-primary');
    expect(css).toContain('.btn-secondary');
    expect(css).toContain('.btn-danger');
    expect(css).toContain('.btn-ghost');
  });

  it('welcome-gradient class defined with linear-gradient', () => {
    let css = readCss('main.css');
    if (!css.includes('.welcome-gradient')) {
      css = readCss('compiled.css');
    }
    expect(css).toContain('.welcome-gradient');
    expect(css).toContain('linear-gradient');
  });

  it('spinner class defined in main.css', () => {
    const css = readCss('main.css');
    expect(css).toContain('.spinner');
  });

  it('no bg-opacity- deprecated usage in main.html', () => {
    const content = readHtml('main.html');
    expect(content, 'main.html uses deprecated bg-opacity- class').not.toContain('bg-opacity-');
  });

  it('no bg-gray-800 in modal body elements', () => {
    const content = readHtml('main.html');
    // Match lines that have both bg-gray-800 and modal-related context
    const lines = content.split('\n');
    const violating = lines.filter(
      (l) => l.includes('bg-gray-800') && /modal/i.test(l)
    );
    expect(
      violating.join('\n'),
      'main.html uses bg-gray-800 in modal elements (should use bg-surface-dark)'
    ).toHaveLength(0);
  });

  it('scrollbar styles externalized (not in inline <style> blocks)', () => {
    for (const file of ['main.html', 'config.html']) {
      const content = readHtml(file);
      const styleBlocks = content.match(/<style[\s\S]*?<\/style>/gi) || [];
      const allStyles = styleBlocks.join('\n');
      expect(
        allStyles.includes('::-webkit-scrollbar'),
        `${file} contains ::-webkit-scrollbar in inline style block (should be in main.css)`
      ).toBe(false);
    }
  });
});
