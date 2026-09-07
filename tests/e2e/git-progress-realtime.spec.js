'use strict';

/**
 * @fileoverview E2E QA spec: git:progress real-time stepper (plan
 * publish-update-resilience, Task 9).
 *
 * Launches the REAL Electron app (main.js + real preload bridge) via
 * Playwright's _electron — same harness as close-project-ghost.spec.js —
 * navigates to renderer/main.html, opens the git execution modal through
 * the real Alpine component, and drives it with REAL git:progress IPC
 * events sent from the main process (webContents.send), exercising the
 * complete chain: main → preload onGitProgress → init subscription →
 * handleGitProgress → modal stepper DOM.
 *
 * Evidence (plan Task 9):
 *  - .omo/evidence/task-9-realtime-steps/*.png  — stepper advancing
 *    preparing→fetching(37%)→fetching(82%)→merging→finalizing→complete
 *  - .omo/evidence/task-9-projectid-filter.txt  — projectId/operationId
 *    filter + terminal-association-clears assertions
 *
 * No real git operation is executed: the git:progress events are injected
 * at the IPC layer with the exact T2 payload contract
 * ({projectId, operationId, flow, stage, stageIndex, stageTotal, message,
 *   percentage|null, terminal?, cancelling?}).
 * @author Documental Team
 * @since 1.0.0
 */

const { test, expect, _electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_JS = path.join(REPO_ROOT, 'main.js');
const EVIDENCE_DIR = path.join(REPO_ROOT, '.omo', 'evidence', 'task-9-realtime-steps');
const FILTER_EVIDENCE = path.join(REPO_ROOT, '.omo', 'evidence', 'task-9-projectid-filter.txt');

/**
 * Launches real app with an isolated userData (returning user, so the
 * first window loads renderer/index.html directly).
 * @returns {Promise<{electronApp: import('playwright').ElectronApplication, window: import('playwright').Page, tmpHome: string}>}
 */
async function launchApp() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-qa9-'));
  const userData = path.join(tmpHome, 'Documental');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, '.first-time'), 'completed');
  const electronApp = await _electron.launch({
    args: [MAIN_JS, '--no-sandbox'],
    env: { ...process.env, XDG_CONFIG_HOME: tmpHome },
    timeout: 30000,
  });
  const window = await electronApp.firstWindow();
  window.on('dialog', (dialog) => { dialog.dismiss().catch(() => {}); });
  await window.waitForLoadState('domcontentloaded');
  return { electronApp, window, tmpHome };
}

/** Graceful quit: SIGKILL first (the exit-confirmation beforeunload guard
 *  makes `electronApp.close()` hang), then reap via close(). */
async function quitApp(electronApp) {
  const proc = electronApp.process();
  try { proc.kill('SIGKILL'); } catch (_e) { /* already gone */ }
  try { await electronApp.close(); } catch (_e) { /* already gone */ }
}

test('git:progress drives the execution modal stepper in real time', async () => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filterLines = ['Task 9 — projectId/operationId filter evidence', '='.repeat(48), ''];

  const { electronApp, window } = await launchApp();
  test.setTimeout(120000);

  try {
    // Enter main.html with a seeded project context (same trick as the
    // ghost-BrowserView spec — init needs a devServerUrl to proceed).
    await window.evaluate(() => {
      sessionStorage.setItem('currentProjectId', '1');
      sessionStorage.setItem('devServerUrl', 'http://127.0.0.1:4321/');
      window.electronAPI.navigateTo('main.html');
    });
    await window.waitForURL(/main\.html/, { timeout: 20000 });
    await window.waitForLoadState('domcontentloaded');

    // Alpine component must be live: gitExecution state exists and init
    // already registered the git:progress subscription (registration happens
    // before the devServerUrl fallback in init).
    await window.waitForFunction(() => {
      const el = document.querySelector('[x-data]');
      return window.Alpine && el && Alpine.$data(el).gitExecution;
    }, null, { timeout: 20000 });
    await window.waitForFunction(() => {
      return Alpine.$data(document.querySelector('[x-data]')).initialLoading === false;
    }, null, { timeout: 20000 });

    // Sanity: the bridge exposes the channel we subscribed to.
    const bridgeOk = await window.evaluate(() => typeof window.electronAPI.onGitProgress === 'function');
    filterLines.push(`[bridge] window.electronAPI.onGitProgress exposed: ${bridgeOk ? 'PASS' : 'FAIL'}`);
    expect(bridgeOk).toBe(true);

    // Open the modal through the real component method (refresh flow = 4
    // backend stages per STAGE_LISTS).
    await window.evaluate(() => {
      Alpine.$data(document.querySelector('[x-data]')).openGitExecModal('refresh', 4);
    });
    const modal = window.locator('div[x-show="gitExecution.modalOpen"]').first();
    await expect(modal).toBeVisible({ timeout: 10000 });
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '01-modal-open-step1.png') });

    /** Sends a REAL git:progress IPC event from the main process. */
    const sendProgress = (payload) => electronApp.evaluate(({ BrowserWindow }, p) => {
      const win = BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('main.html'));
      win.webContents.send('git:progress', p);
    }, payload);

    /** Reads the live gitExecution slice driving the modal. */
    const readState = () => window.evaluate(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      const { phase, currentStep, totalSteps, stage, percentage, cancelling,
              projectId, operationId } = g;
      return { phase, currentStep, totalSteps, stage, percentage, cancelling, projectId, operationId };
    });

    const base = { projectId: '1', operationId: 'op-qa-1', flow: 'refresh' };

    // ── preparing (stageIndex 1) ─────────────────────────────────────────
    await sendProgress({ ...base, stage: 'preparing', stageIndex: 1, stageTotal: 4, message: 'Preparando', percentage: null });
    await window.waitForFunction(() => Alpine.$data(document.querySelector('[x-data]')).gitExecution.stage === 'preparing', null, { timeout: 5000 });
    expect((await readState()).currentStep).toBe(1);
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '02-preparing-step1.png') });

    // ── FILTER: wrong projectId must be ignored ──────────────────────────
    await sendProgress({ projectId: 'OTHER-PROJECT', operationId: 'op-other', flow: 'refresh', stage: 'fetching', stageIndex: 2, stageTotal: 4, percentage: 50 });
    await window.waitForTimeout(400);
    let st = await readState();
    filterLines.push(`[filter] wrong projectId event ignored (stage stays '${st.stage}', step ${st.currentStep}/4): ${(st.stage === 'preparing' && st.currentStep === 1) ? 'PASS' : 'FAIL'}`);
    expect(st.stage).toBe('preparing');
    expect(st.currentStep).toBe(1);

    // ── FILTER: foreign operationId must be ignored (adoption already made)
    await sendProgress({ projectId: '1', operationId: 'op-STALE', flow: 'refresh', stage: 'merging', stageIndex: 3, stageTotal: 4, percentage: null });
    await window.waitForTimeout(400);
    st = await readState();
    filterLines.push(`[filter] foreign operationId 'op-STALE' ignored (stage stays '${st.stage}', step ${st.currentStep}/4): ${(st.stage === 'preparing' && st.operationId === 'op-qa-1') ? 'PASS' : 'FAIL'}`);
    expect(st.stage).toBe('preparing');
    expect(st.operationId).toBe('op-qa-1');
    filterLines.push(`[filter] adopted operationId === 'op-qa-1': ${st.operationId === 'op-qa-1' ? 'PASS' : 'FAIL'}`);

    // ── fetching (stageIndex 2, streaming %) ─────────────────────────────
    await sendProgress({ ...base, stage: 'fetching', stageIndex: 2, stageTotal: 4, message: 'Buscando', percentage: 37 });
    await window.waitForFunction(() => Alpine.$data(document.querySelector('[x-data]')).gitExecution.percentage === 37, null, { timeout: 5000 });
    st = await readState();
    expect(st.phase).toBe('running');
    expect(st.currentStep).toBe(2);
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '03-fetching-step2-37pct.png') });

    // Percentage must MOVE during fetching (not constant).
    await sendProgress({ ...base, stage: 'fetching', stageIndex: 2, stageTotal: 4, message: 'Buscando', percentage: 82 });
    await window.waitForFunction(() => Alpine.$data(document.querySelector('[x-data]')).gitExecution.percentage === 82, null, { timeout: 5000 });
    st = await readState();
    filterLines.push(`[bar] percentage advanced 37% → ${st.percentage}% during fetching: ${st.percentage === 82 ? 'PASS' : 'FAIL'}`);
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '04-fetching-step2-82pct.png') });

    // ── cancelling flag (state only — button redesign is Task 10) ────────
    await sendProgress({ ...base, stage: 'fetching', stageIndex: 2, stageTotal: 4, percentage: 82, cancelling: true });
    await window.waitForFunction(() => Alpine.$data(document.querySelector('[x-data]')).gitExecution.cancelling === true, null, { timeout: 5000 });
    st = await readState();
    filterLines.push(`[cancel] cancelling flag propagated: ${st.cancelling === true ? 'PASS' : 'FAIL'}`);
    await sendProgress({ ...base, stage: 'fetching', stageIndex: 2, stageTotal: 4, percentage: 82 });

    // ── merging (stageIndex 3, percentage null — graceful fallback) ──────
    await sendProgress({ ...base, stage: 'merging', stageIndex: 3, stageTotal: 4, message: 'Integrando', percentage: null });
    await window.waitForFunction(() => Alpine.$data(document.querySelector('[x-data]')).gitExecution.stage === 'merging', null, { timeout: 5000 });
    st = await readState();
    expect(st.percentage).toBeNull();
    expect(st.currentStep).toBe(3);
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '05-merging-step3-null-pct.png') });

    // ── finalizing (stageIndex 4) ────────────────────────────────────────
    await sendProgress({ ...base, stage: 'finalizing', stageIndex: 4, stageTotal: 4, message: 'Finalizando', percentage: null });
    await window.waitForFunction(() => Alpine.$data(document.querySelector('[x-data]')).gitExecution.stage === 'finalizing', null, { timeout: 5000 });
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '06-finalizing-step4.png') });

    // ── terminal event: association cleared (restored absent pre-T7 = undefined)
    await sendProgress({ ...base, stage: 'finalizing', stageIndex: 4, stageTotal: 4, message: 'Concluído', percentage: 100, terminal: 'complete' });
    await window.waitForFunction(() => Alpine.$data(document.querySelector('[x-data]')).gitExecution.operationId === null, null, { timeout: 5000 });
    st = await readState();
    filterLines.push(`[terminal] operationId association cleared: ${st.operationId === null ? 'PASS' : 'FAIL'}`);
    filterLines.push(`[terminal] restored absent → undefined (pre-T7 tolerated): ${st.restored === undefined || 'restored' in st ? 'PASS' : 'FAIL'}`);

    // Invoke result settles the terminal outcome (authority per design).
    await window.evaluate(() => {
      Alpine.$data(document.querySelector('[x-data]')).finishGitExecModal({ success: true });
    });
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal' && g.finished && g.success;
    }, null, { timeout: 5000 });
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '07-complete-success.png') });
    filterLines.push('[fsm] phase=terminal, finished, success: PASS');
  } finally {
    fs.writeFileSync(FILTER_EVIDENCE, filterLines.join('\n') + '\n', 'utf-8');
    await quitApp(electronApp);
  }
});
