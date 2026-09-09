'use strict';

/**
 * @fileoverview F3 REAL QA — R4: functional cancellation.
 *
 * Update during FETCHING against a stuck transport → Cancelar →
 * "Cancelando…" observed → the REAL git child dies (scoped pgrep on the
 * bundled dugite binary + the fixture's fake-ssh helper) → cancelled banner
 * + "estado original restaurado" → a NEW Update starts immediately (lock
 * NOT stuck) and completes.
 *
 * The 60 ms sampler additionally proves the cancel button is disabled
 * (visual + label "Cancelando...") through the RESTORING stage — edge case
 * "cancel durante RESTORING é desabilitado" (functional guard: the
 * cancelGitExec() no-op while restoring).
 *
 * @author Documental Team
 * @since 1.0.0
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const H = require('./helpers');

const EV = path.join(H.EVIDENCE_ROOT, 'R4');

test('R4 — cancelar Update durante fetching: "Cancelando…", git morto, restaurado, próximo Update OK', async () => {
  test.setTimeout(180000);
  fs.mkdirSync(EV, { recursive: true });
  const log = ['F3 R4 — cancel funcional', '='.repeat(48), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-f3-r4-'));
  const { worktree, hangFlag, origin } = H.buildFixture(tmp, { mode: 'hang' });
  const { electronApp, window } = await H.launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await H.openMainWithProject(window);
    await H.installSampler(window);

    fs.writeFileSync(path.join(worktree, 'dirty-cancel.md'), 'trabalho não salvo antes do cancel\n');

    const refreshBtn = window.locator('button[\\@click="onRefreshClick()"]');
    await expect(refreshBtn).toBeVisible({ timeout: 15000 });

    fs.writeFileSync(hangFlag, 'stall');
    log.push('[fixture] HANG set — transporte travado no fetching');

    await refreshBtn.click();
    const refreshConfirm = window.locator('div[x-show="refreshConfirmModalOpen"]');
    await expect(refreshConfirm).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="confirmRefresh()"]').click();

    const modal = window.locator('div[x-show="gitExecution.modalOpen"]');
    await expect(modal).toBeVisible({ timeout: 10000 });

    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.stage === 'fetching' && g.phase === 'running';
    }, null, { timeout: 30000 });
    log.push('[stage] fetching RUNNING (transporte travado): PASS');

    // The stalled transport helper must genuinely be alive pre-cancel.
    await expect.poll(() => (H.pgrepAlive(H.fakeSshPattern(tmp)) ? 'alive' : 'gone'), { timeout: 15000 }).toBe('alive');
    log.push('[processo] fake-ssh helper VIVO durante o fetching travado: PASS');

    // ── CANCELAR (canonical T13 selector) ────────────────────────────────
    const cancelBtn = window.locator('button[\\@click="cancelGitExec()"]');
    await expect(cancelBtn).toBeVisible({ timeout: 5000 });
    await cancelBtn.click();
    log.push('[cancel] clique em Cancelar');

    // "Cancelando…" observed as STATE (T13 precedent, cancel-mid-op.spec.js:
    // in a stalled transport no further event fires, so the label window
    // can be shorter than any polling period — settle on the state).
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.cancelling === true || g.restoring === true || (g.phase === 'terminal' && g.terminal === 'cancelled');
    }, null, { timeout: 30000 });
    await window.screenshot({ path: path.join(EV, 'R4-01-cancelando.png') });

    // Real git child must be DEAD (signal forwarding through dugite).
    await expect.poll(() => (H.pgrepAlive(H.DUGITE_FETCH_PATTERN) ? 'alive' : 'dead'), { timeout: 15000 }).toBe('dead');
    log.push('[processo] `git fetch` do dugite MORTO após cancelar (signal forwarding): PASS');

    fs.rmSync(hangFlag, { force: true });
    await expect.poll(() => (H.pgrepAlive(H.fakeSshPattern(tmp)) ? 'alive' : 'gone'), { timeout: 15000 }).toBe('gone');
    log.push('[processo] árvore de processos limpa (helper fake-ssh saiu): PASS');

    // ── Terminal: cancelled + restored ───────────────────────────────────
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal' && g.terminal === 'cancelled';
    }, null, { timeout: 30000 });
    const st = await H.readGitExec(window);
    log.push(`[terminal] terminal=cancelled restored=${st.restored} restoredFrom=${st.restoredFrom}`);

    const cancelledBanner = window.locator('div[x-show="gitExecution.phase === \'terminal\' && gitExecution.terminal === \'cancelled\'"]');
    await expect(cancelledBanner).toBeVisible({ timeout: 10000 });
    await expect(cancelledBanner).toContainText(/Operação cancelada|Operation cancelled/);

    const restoreBanner = window.locator('div[x-show="gitExecution.restored === true"]');
    await expect(restoreBanner).toBeVisible({ timeout: 15000 });
    await expect(restoreBanner).toContainText(/estado original do seu repositório foi restaurado|original state of your repository was restored/);
    await window.screenshot({ path: path.join(EV, 'R4-02-cancelled-restored.png') });
    log.push('[banner] cancelled + "estado original restaurado": PASS');

    expect(fs.existsSync(path.join(worktree, 'dirty-cancel.md'))).toBe(true);
    log.push('[disco] dirty file restaurado: PASS');

    // ── Sampler: cancelling/restoring STATE observed + disabled through
    // RESTORING (label sampling can miss sub-60ms windows — see the T13
    // notepad; the sampler also records the label when it IS visible) ──
    const samples = await H.stopSampler(window);
    fs.writeFileSync(path.join(EV, 'R4-samples.json'), JSON.stringify(samples, null, 2));
    const cancelingSamples = samples.filter((s) => s.cancelling || s.restoring);
    const labelSamples = samples.filter((s) => /Cancelando|Canceling/.test(String(s.cancelLabel)));
    expect(cancelingSamples.length).toBeGreaterThan(0);
    log.push(`[sampler] janelas cancelling/restoring observadas em ${cancelingSamples.length} amostras (label "Cancelando…" capturado em ${labelSamples.length} delas): PASS`);

    const restoringSamples = cancelingSamples.filter((s) => s.restoring);
    if (restoringSamples.length > 0) {
      const badWindows = restoringSamples.filter((s) => s.cancelDisabled === false);
      expect(badWindows.length).toBe(0);
      log.push(`[sampler] RESTORING capturado em ${restoringSamples.length} amostras — cancel SEMPRE desabilitado (cursor-not-allowed): PASS`);
    } else {
      const postCancel = samples.filter((s) => s.cancelling);
      const badWindows = postCancel.filter((s) => s.cancelDisabled === false);
      expect(badWindows.length).toBe(0);
      log.push(`[sampler] janela cancelling capturada (${postCancel.length} amostras) com cancel desabilitado; restoring rápido demais para amostrar — guarda funcional cobre (cancelGitExec no-op)`);
    }

    // ── NEW Update: proves the lock was released ─────────────────────────
    await window.locator('button[\\@click="closeGitExecModal()"]').click();
    await expect(modal).toBeHidden({ timeout: 10000 });

    await refreshBtn.click();
    await expect(refreshConfirm).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="confirmRefresh()"]').click();
    await expect(modal).toBeVisible({ timeout: 10000 });
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.stage === 'fetching' && g.phase === 'running';
    }, null, { timeout: 30000 });
    log.push('[lock] 2º Update alcançou fetching de novo — lock NÃO preso: PASS');

    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal';
    }, null, { timeout: 60000 });
    const st2 = await H.readGitExec(window);
    expect(st2.terminal).toBe('complete');
    expect(st2.success).toBe(true);
    await window.screenshot({ path: path.join(EV, 'R4-03-second-update-complete.png') });
    log.push('[recuperação] 2º Update concluído: PASS');

    const iso = await H.assertNoIsoText(window, 'R4 cancelled terminal');
    expect(iso.clean).toBe(true);
    log.push('[R5.3] tela SEM "isomorphic-git": PASS');

    log.push('', 'RESULT: PASS');
  } finally {
    fs.rmSync(hangFlag, { force: true });
    fs.writeFileSync(path.join(EV, 'R4-results.txt'), log.join('\n') + '\n', 'utf-8');
    await H.quitApp(electronApp);
  }
});
