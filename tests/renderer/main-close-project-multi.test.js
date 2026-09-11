/**
 * @fileoverview Source-contract tests for the multi-window "Fechar Ambiente"
 * modal (Task 3, fechar-ambiente-multi-janela): the modal opener must query
 * the project window count with a single-window fallback (AC12), the two new
 * actions must send the 'this-window'/'all-windows' modes with the exact
 * navigation ordering (unconditional vs .finally), the legacy confirm stays
 * mode-less (rule 1), the modal HTML carries both conditional variants with
 * the conflictDecision mold, the git-progress adoption is gated to
 * non-secondary windows (R1) and ESC/backdrop cancel in both variants (AC11).
 *
 * Static source assertions follow the repo pattern (see
 * tests/renderer/main-close-project.test.js) because the renderer is plain
 * Alpine.js HTML that cannot run in a node harness.
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
let modalSlice = '';

/**
 * Extracts a top-level Alpine method body from renderer/main.html. Pass the
 * full signature when the method takes parameters (e.g.
 * 'handleGitProgress(payload)') — 'name() {' alone does not match methods
 * with params.
 */
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
  const modalStart = mainSource.indexOf('x-show="closeProjectModalOpen"');
  modalSlice = modalStart === -1 ? '' : mainSource.slice(modalStart, modalStart + 5000);
});

describe('renderer/main.html — modal Fechar Ambiente multi-janela (Task 3)', () => {
  it('(a) closeProject consulta getProjectWindowCount com fallback count=1 + warn (AC12)', () => {
    const body = extractMethod('closeProject()');
    expect(body).not.toBe('');
    expect(body).toMatch(/window\.electronAPI\.getProjectWindowCount\(projectId\)/);
    expect(body).toMatch(/closeProjectWindowCount = 1/);
    expect(body).toMatch(/\.catch\(\(error\) => \{/);
    expect(body).toMatch(/console\.warn/);
  });

  it('(b) confirmCloseProjectHere envia this-window fire-and-forget e navega incondicional', () => {
    const body = extractMethod('confirmCloseProjectHere()');
    expect(body).not.toBe('');
    expect(body).toMatch(/window\.electronAPI\.closeProject\(projectId, 'this-window'\)/);
    expect(body).not.toMatch(/await[^;\n]*closeProject/);
    expect(body).toMatch(/becameLast/); // E4 surface via console.warn
    expect(body).toMatch(/this\.navigateToSelectionGuarded\(\)/);
    // Navegação incondicional: fora de .then/.finally (statement próprio
    // após o fire-and-forget).
    expect(body).not.toMatch(/(?:then|finally)\(\s*\(\s*\)\s*=>\s*\{[^}]*navigateToSelectionGuarded/);
    // O helper de navegação guarda o destino da tela de seleção.
    const navBody = extractMethod('navigateToSelectionGuarded()');
    expect(navBody).toMatch(/navigateTo\('index\.html'\)/);
  });

  it('(c) confirmCloseProjectAll envia all-windows com catch e navega no .finally', () => {
    const body = extractMethod('confirmCloseProjectAll()');
    expect(body).not.toBe('');
    expect(body).toMatch(/window\.electronAPI\.closeProject\(projectId, 'all-windows'\)/);
    expect(body).toMatch(/\.catch\(\(error\) => \{/);
    // Limpeza de sessionStorage E navegação dentro do .finally (sempre).
    expect(body).toMatch(/\.finally\(\s*\(\s*\)\s*=>\s*\{[\s\S]*this\.clearProjectSessionState\(projectId\);[\s\S]*this\.navigateToSelectionGuarded\(\);[\s\S]*\}\);/);
    // A limpeza acontece antes da navegação dentro do finally.
    expect(body.indexOf('clearProjectSessionState(projectId);')).toBeLessThan(
      body.indexOf('navigateToSelectionGuarded();')
    );
  });

  it('(d) confirmCloseProject legacy continua SEM mode (regra 1)', () => {
    const body = extractMethod('confirmCloseProject()');
    expect(body).not.toBe('');
    expect(body).toMatch(/window\.electronAPI\.closeProject\(projectId\)/);
    expect(body).not.toMatch(/closeProject\(projectId,\s*['"]/);
  });

  it('(e) modal tem as 3 opções condicionais (molde conflictDecision) + keys multi', () => {
    expect(modalSlice).not.toBe('');
    // Duas variantes condicionais complementares.
    expect(modalSlice).toMatch(/x-show="closeProjectWindowCount < 2"/);
    expect(modalSlice).toMatch(/x-show="closeProjectWindowCount >= 2"/);
    // Variante single (regra 1) preserva os 2 botões atuais.
    expect(modalSlice).toMatch(/@click="confirmCloseProject\(\)"/);
    expect(modalSlice).toMatch(/__t\('main\.close_project_confirm'\)/);
    // Variante multi: botões full-width do molde conflictDecision com ícone.
    expect(modalSlice).toMatch(/@click="confirmCloseProjectHere\(\)"/);
    expect(modalSlice).toMatch(/@click="confirmCloseProjectAll\(\)"/);
    expect(modalSlice).toMatch(/material-symbols-outlined/);
    expect(modalSlice).toMatch(/w-full text-left p-3 bg-background-dark border border-border-default rounded-md flex items-start gap-3/);
    // Keys i18n multi ligadas ao modal.
    for (const key of [
      'close_project_multi_title',
      'close_project_multi_desc',
      'close_project_here',
      'close_project_here_desc',
      'close_project_all',
      'close_project_all_desc',
    ]) {
      expect(modalSlice).toMatch(new RegExp(`__t\\('main\\.${key}'\\)`));
    }
  });

  it('(f) git-progress adoption gated a janelas não-secundárias (R1)', () => {
    const body = extractMethod('handleGitProgress(payload)');
    expect(body).not.toBe('');
    expect(body).toMatch(/if \(!this\.isSecondaryWindow\) \{[\s\S]*?this\.gitExecution\.operationId = payload\.operationId/);
  });

  it('(g) ESC e backdrop cancelam o modal nas duas variantes (AC11)', () => {
    // ESC: matriz unificada trata closeProjectModalOpen como Cancelar.
    expect(mainSource).toMatch(
      /if \(this\.closeProjectModalOpen\) \{ this\.cancelCloseProject\(\); return; \}/
    );
    // Backdrop: cada variante do modal tem seu click.outside = Cancelar.
    expect(modalSlice).not.toBe('');
    const backdropCancels = modalSlice.match(/@click\.outside="cancelCloseProject\(\)"/g) || [];
    expect(backdropCancels.length).toBe(2);
    // Botão Cancelar explícito na variante multi.
    expect(modalSlice).toMatch(/@click="cancelCloseProject\(\)"/);
  });
});
