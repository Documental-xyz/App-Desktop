/**
 * @fileoverview Source-contract tests for Task 1
 * (fechar-ambiente-multi-janela): the window state captured by
 * getCurrentWindowState must carry currentProjectId (so the secondary
 * window can be associated with the project in the main process) and
 * applyWindowState must restore sessionStorage.currentProjectId — and ONLY
 * that (G5: wizard/open transient state is never restored). Static source
 * assertions follow tests/renderer/main-close-project.test.js because the
 * renderer is plain Alpine.js HTML that cannot run in a node harness.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const nativeRequire = createRequire(import.meta.url);
const realFs = nativeRequire('fs');
const realPath = nativeRequire('node:path');

const ROOT = realPath.resolve(
  realPath.dirname(fileURLToPath(import.meta.url)),
  '../..'
);

const MAIN_HTML_PATH = realPath.join(ROOT, 'renderer/main.html');

let mainSource = '';

/** Extracts a top-level Alpine method body from renderer/main.html. */
function extractMethod(signature) {
  const start = mainSource.indexOf(`${signature} {`);
  if (start === -1) return '';
  // Walk braces from the method's opening brace to its matching close.
  const open = mainSource.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < mainSource.length; i++) {
    if (mainSource[i] === '{') depth++;
    if (mainSource[i] === '}') {
      depth--;
      if (depth === 0) return mainSource.slice(start, i + 1);
    }
  }
  return '';
}

beforeAll(() => {
  mainSource = realFs.readFileSync(MAIN_HTML_PATH, 'utf-8');
});

describe('renderer/main.html — windowState carrega currentProjectId', () => {
  it('getCurrentWindowState inclui currentProjectId lido do sessionStorage', () => {
    const body = extractMethod('getCurrentWindowState()');
    expect(body).not.toBe('');
    expect(body).toMatch(/currentProjectId:\s*sessionStorage\.getItem\('currentProjectId'\)/);
  });
});

describe('renderer/main.html — applyWindowState restaura o projeto (só ele)', () => {
  it('restaura sessionStorage.currentProjectId quando presente no state', () => {
    const body = extractMethod('applyWindowState(windowState)');
    expect(body).not.toBe('');
    expect(body).toMatch(/if\s*\(windowState\.currentProjectId\)/);
    expect(body).toMatch(/sessionStorage\.setItem\('currentProjectId',\s*windowState\.currentProjectId\)/);
  });

  it('G5: NÃO restaura estados transitórios de wizard/abertura na secundária', () => {
    const body = extractMethod('applyWindowState(windowState)');
    expect(body).not.toMatch(/projectCreationState/);
    expect(body).not.toMatch(/projectOpenState/);
  });
});
