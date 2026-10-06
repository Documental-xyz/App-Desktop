'use strict';

/**
 * @fileoverview F3 REAL QA — edge cases.
 *
 * E1. CONFLICT_PENDING (diverged repo): the Update hits a real merge
 *     conflict → the conflict-strategy modal appears → ESC does NOT close
 *     it (explicit decision required) → choosing MERGE_LOCAL completes the
 *     flow with the local content winning.
 *
 * E2. Journal expired / unknown operationId → LOG_NOT_FOUND: the raw-logs
 *     viewer shows the graceful "Log indisponível — pode ter expirado
 *     (mantido por 30 minutos)" message (the 30 min TTL is not fakeable in
 *     a QA run — the nonexistent-operationId path exercises the exact same
 *     IPC + UI branch).
 *
 * @author Documental Team
 * @since 1.0.0
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const H = require('./helpers');

const EV = path.join(H.EVIDENCE_ROOT, 'edges');
const G = (args, opts = {}) => execFileSync('git', args, { stdio: 'pipe', ...opts });

test('E1 — CONFLICT_PENDING: ESC NÃO fecha; MERGE_LOCAL completa o fluxo', async () => {
  test.setTimeout(180000);
  fs.mkdirSync(EV, { recursive: true });
  const log = ['F3 E1 — conflict pending + MERGE_LOCAL', '='.repeat(48), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-f3-e1-'));
  const { worktree, origin } = H.buildFixture(tmp, { mode: 'plain' });

  // Diverge: LOCAL commits a change to content.md…
  fs.writeFileSync(path.join(worktree, 'content.md'), '# LOCAL version\ntrabalho local\n');
  G(['add', '.'], { cwd: worktree });
  G(['commit', '-qm', 'Local change'], { cwd: worktree });

  // …and ORIGIN receives a different change to the SAME file. The push is
  // ref-explicit so the change lands on preview no matter what HEAD the
  // clone checked out.
  const clone = path.join(tmp, 'origin-side');
  G(['clone', '-q', '--branch', 'preview', origin, clone]);
  G(['config', 'user.name', 'QA Origin'], { cwd: clone });
  G(['config', 'user.email', 'qa-origin@fixture.local'], { cwd: clone });
  G(['config', 'commit.gpgsign', 'false'], { cwd: clone });
  fs.writeFileSync(path.join(clone, 'content.md'), '# ORIGIN version\nmudança remota\n');
  G(['add', '.'], { cwd: clone });
  G(['commit', '-qm', 'Origin change'], { cwd: clone });
  G(['push', '-q', 'origin', 'preview'], { cwd: clone });
  log.push('[fixture] repo divergido: local e origin alteraram content.md');
  const originTipBefore = execFileSync('git', ['rev-parse', 'preview'], { cwd: origin }).toString().trim();

  const { electronApp, window } = await H.launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await H.openMainWithProject(window);

    await window.locator('button[\\@click="onRefreshClick()"]').click();
    const refreshConfirm = window.locator('div[x-show="refreshConfirmModalOpen"]');
    await expect(refreshConfirm).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="confirmRefresh()"]').click();

    // CONFLICT_PENDING → typed conflict-strategy modal.
    const conflictModal = window.locator('div[x-show="conflictDecision.open"]');
    await expect(conflictModal).toBeVisible({ timeout: 60000 });
    await window.waitForFunction(() => {
      const d = Alpine.$data(document.querySelector('[x-data]')).conflictDecision;
      return d.open && d.files && d.files.length > 0;
    }, null, { timeout: 15000 });
    const files = await window.evaluate(() => Alpine.$data(document.querySelector('[x-data]')).conflictDecision.files);
    log.push(`[modal] CONFLICT_PENDING aberto, arquivos conflitantes: ${JSON.stringify(files)}`);
    expect(files).toContain('content.md');
    await expect(conflictModal).toContainText(/Alterações precisam da sua decisão|Changes need your decision/);
    await window.screenshot({ path: path.join(EV, 'E1-01-conflict-modal.png') });

    // ESC must NOT close it (deliberate: no X, no ESC, no click.outside).
    await window.keyboard.press('Escape');
    await window.waitForTimeout(600);
    await expect(conflictModal).toBeVisible({ timeout: 2000 });
    const stillOpen = await window.evaluate(() => Alpine.$data(document.querySelector('[x-data]')).conflictDecision.open);
    expect(stillOpen).toBe(true);
    log.push('[esc] ESC NÃO fechou o modal de conflito: PASS');

    // Choose MERGE_LOCAL (local wins) through the REAL button.
    const mergeLocalBtn = conflictModal.locator('button', { hasText: /Mesclar priorizando|Merge favoring/ }).first();
    await expect(mergeLocalBtn).toBeVisible({ timeout: 5000 });
    await mergeLocalBtn.click();
    log.push('[decisão] MERGE_LOCAL escolhido');

    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal';
    }, null, { timeout: 90000 });
    const st = await H.readGitExec(window);
    log.push(`[terminal] terminal=${st.terminal} success=${st.success}`);
    expect(st.terminal).toBe('complete');
    expect(st.success).toBe(true);

    await expect(conflictModal).toBeHidden({ timeout: 5000 });
    await window.screenshot({ path: path.join(EV, 'E1-02-merge-local-complete.png') });

    // Local content won on disk.
    const finalContent = fs.readFileSync(path.join(worktree, 'content.md'), 'utf-8');
    expect(finalContent).toContain('# LOCAL version');
    log.push(`[disco] content.md final = versão LOCAL ("${finalContent.split('\n')[0]}"): PASS`);

    // The flow genuinely completed: HEAD is a MERGE commit whose second
    // parent is the origin tip that was integrated (an Update resolves
    // the conflict locally — the push happens on the next Publish, so
    // origin/preview legitimately still points at the old tip).
    const head = H.gitHead(worktree);
    const parent2 = execFileSync('git', ['rev-parse', 'HEAD^2'], { cwd: worktree }).toString().trim();
    expect(parent2).toBe(originTipBefore);
    log.push('[história] HEAD é merge commit com parent2 == tip da origin integrada: PASS');

    const iso = await H.assertNoIsoText(window, 'E1 conflict complete');
    expect(iso.clean).toBe(true);
    log.push('[R5.3] tela SEM "isomorphic-git": PASS');

    log.push('', 'RESULT: PASS');
  } finally {
    fs.writeFileSync(path.join(EV, 'E1-conflict-results.txt'), log.join('\n') + '\n', 'utf-8');
    await H.quitApp(electronApp);
  }
});

test('E2 — LOG_NOT_FOUND: journal expirado/desconhecido → mensagem graciosa', async () => {
  test.setTimeout(120000);
  const log = ['F3 E2 — LOG_NOT_FOUND graceful', '='.repeat(48), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-f3-e2-'));
  const { worktree, origin } = H.buildFixture(tmp, { mode: 'plain' });
  const { electronApp, window } = await H.launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await H.openMainWithProject(window);

    // Direct IPC contract: unknown operationId → typed LOG_NOT_FOUND.
    const ipcResult = await window.evaluate(() => window.electronAPI.getOperationLog('f3-qa-nonexistent-op'));
    log.push(`[ipc] getOperationLog(inexistente) → ${JSON.stringify({ success: ipcResult.success, code: ipcResult.code })}`);
    expect(ipcResult.success).toBe(false);
    expect(ipcResult.code).toBe('LOG_NOT_FOUND');

    // UI path: the raw-logs viewer lives INSIDE the exec modal shell, so
    // mirror the post-failure component state a real terminal leaves
    // behind (modal open, failed terminal) before pointing the viewer at
    // the expired/unknown operation — the IPC roundtrip + unavailable
    // branch exercised below are the real product path.
    await window.evaluate(() => {
      const d = Alpine.$data(document.querySelector('[x-data]'));
      d.gitExecution.modalOpen = true;
      d.gitExecution.phase = 'terminal';
      d.gitExecution.terminal = 'failed';
      d.gitExecution.rawLogOpId = 'f3-qa-nonexistent-op';
      d.gitExecution.rawLogs = { open: false, loading: false, unavailable: false, entries: [], copied: false };
      d.toggleRawLogs();
    });
    const viewer = window.locator('div[x-show="gitExecution.rawLogs.open"]');
    await expect(viewer).toBeVisible({ timeout: 10000 });
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.rawLogs.loading === false && g.rawLogs.unavailable === true;
    }, null, { timeout: 15000 });
    await expect(viewer).toContainText(/Log indisponível|Log not available/i);
    await expect(viewer).toContainText(/30 minutos|30 minutes/);
    await window.screenshot({ path: path.join(EV, 'E2-01-log-not-found.png') });
    log.push('[viewer] "Log indisponível — pode ter expirado (mantido por 30 minutos)" gracioso: PASS');

    log.push('', 'RESULT: PASS');
  } finally {
    fs.writeFileSync(path.join(EV, 'E2-log-not-found-results.txt'), log.join('\n') + '\n', 'utf-8');
    await H.quitApp(electronApp);
  }
});
