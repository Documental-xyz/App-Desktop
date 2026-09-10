/**
 * @fileoverview Source-contract tests for "Fechar Ambiente" (Task 6,
 * ajustes-wizard-preview-servicos): confirmCloseProject must invoke the
 * close-project IPC fire-and-forget (navigation never awaits the kill) and
 * the preload must expose the matching bridge. Static source assertions
 * follow the repo pattern (see tests/main/lifecycle.test.js) because the
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
const PRELOAD_PATH = realPath.join(ROOT, 'preload.js');

let mainSource = '';
let preloadSource = '';

/** Extracts a top-level Alpine method body from renderer/main.html. */
function extractMethod(name) {
  const start = mainSource.indexOf(`${name}() {`);
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
  preloadSource = realFs.readFileSync(PRELOAD_PATH, 'utf-8');
});

describe('renderer/main.html — confirmCloseProject', () => {
  it('invoca window.electronAPI.closeProject(projectId) dentro de confirmCloseProject', () => {
    const body = extractMethod('confirmCloseProject');
    expect(body).not.toBe('');
    expect(body).toMatch(/window\.electronAPI\.closeProject\(projectId\)/);
  });

  it('kill é fire-and-forget: chamada SEM await, com .catch (falha só loga)', () => {
    const body = extractMethod('confirmCloseProject');
    expect(body).not.toMatch(/await[^;\n]*closeProject/);
    expect(body).toMatch(/window\.electronAPI\.closeProject\(projectId\)\.catch\(/);
  });

  it('navegação incondicional: navigateTo(\'index.html\') permanece no fluxo', () => {
    const body = extractMethod('confirmCloseProject');
    expect(body).toMatch(/navigateTo\('index\.html'\)/);
  });

  it('comentário de paridade antigo (dev server NÃO encerrado) foi substituído', () => {
    expect(mainSource).not.toMatch(/Paridade intencional/);
  });
});

describe('preload.js — bridge close-project', () => {
  it('expõe closeProject no padrão das bridges invoke existentes', () => {
    expect(preloadSource).toMatch(
      /closeProject: \(projectId\) => ipcRenderer\.invoke\('close-project', projectId\)/
    );
  });
});
