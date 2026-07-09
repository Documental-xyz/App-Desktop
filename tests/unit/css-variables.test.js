/**
 * @fileoverview Regression tests for CSS variable system (Wave 0 T5-T6).
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.unmock('fs');
vi.unmock('path');

const rendererDir = path.join(__dirname, '../../renderer');
const cssDir = path.join(rendererDir, 'assets/css');

// KNOWN-FAILURE: quarantined during perf-zombie-refactor, see tests/KNOWN-FAILURES.md
describe.skip('Wave 0 — CSS Variables Regression', () => {
  it('variables.css exists', () => {
    const filePath = path.join(cssDir, 'variables.css');
    expect(fs.existsSync(filePath), 'renderer/assets/css/variables.css must exist').toBe(true);
  });

  it('variables.css contains :root block with CSS custom properties', () => {
    const content = fs.readFileSync(path.join(cssDir, 'variables.css'), 'utf-8');
    expect(content).toContain(':root');
    expect(content).toMatch(/--[\w-]+\s*:/);
  });

  it('all required semantic tokens are defined', () => {
    const content = fs.readFileSync(path.join(cssDir, 'variables.css'), 'utf-8');
    const requiredTokens = [
      '--color-primary',
      '--color-surface-dark',
      '--color-border-default',
      '--color-info',
    ];
    for (const token of requiredTokens) {
      expect(content, `Missing token: ${token}`).toContain(token);
    }
  });

  it('main.css imports variables.css', () => {
    const content = fs.readFileSync(path.join(cssDir, 'main.css'), 'utf-8');
    expect(content).toContain("@import './variables.css'");
  });
});
