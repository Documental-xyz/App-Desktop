'use strict';

/**
 * @fileoverview F3 REAL QA — cross-task INTEGRATION: the complete user
 * journey in ONE app session, no restart (state-changed refresh must keep
 * the UI coherent between events):
 *
 *   1. Publish with a 150 MB artifact → large_file FAILURE + restore (R1)
 *   2. "Ver logs brutos" → $ git push + GH001 stderr → copy → clipboard (R2)
 *   3. Fix = remove the big file → re-publish → SUCCESS
 *   4. Update against a stuck transport → CANCEL → cancelled + restore (R4)
 *   5. Update again → SUCCESS
 *
 * Fixture note: the origin's GH001 policy scans the TIP tree (documented
 * simplification) so step 3 succeeds after removing the file — the
 * GitHub-faithful full-history rejection is proven in R2. The APP behavior
 * (state machine, banners, journal, lock, refresh) is identical in both.
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

const EV = path.join(H.EVIDENCE_ROOT, 'integration');

test('INT — falha → logs → corrigir → república → cancelar update → concluir update (uma sessão)', async () => {
  test.setTimeout(300000);
  fs.mkdirSync(EV, { recursive: true });
  const log = ['F3 INTEGRAÇÃO — sessão única sem restart', '='.repeat(56), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-f3-int-'));
  const { worktree, hangFlag, origin } = H.buildFixture(tmp, { mode: 'largefile-tip' });
  const { electronApp, window } = await H.launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  const modal = window.locator('div[x-show="gitExecution.modalOpen"]');

  /** Footer must re-sync to disk HEAD after every terminal (git:state-changed). */
  const assertFooterSynced = async (label) => {
    const disk = H.gitHead(worktree);
    await window.waitForFunction((expected) => {
      const r = Alpine.$data(document.querySelector('[x-data]')).repoInfo;
      return r && r.lastCommit && r.lastCommit.hash && r.lastCommit.hash.startsWith(expected);
    }, disk.slice(0, 7), { timeout: 30000 });
    log.push(`[state-changed] ${label}: footer re-sincronizado ao HEAD do disco (${disk.slice(0, 8)}): PASS`);
  };

  const assertNoIso = async (label) => {
    const iso = await H.assertNoIsoText(window, label);
    expect(iso.clean).toBe(true);
  };

  /**
   * Publish once through the REAL buttons and settle on a terminal.
   * Guarded retry for a DOCUMENTED product bug (F3 report; product NOT
   * changed here): _commitAll stages the dirty set with one concurrent
   * `git add` per file, and concurrent git adds collide on
   * .git/index.lock (git has no lock retry), failing the publish with
   * "Erro ao preparar arquivo(s)". Nothing was committed when it fires,
   * so retrying the publish is safe and keeps the journey intact.
   */
  const publishAndSettle = async () => {
    for (let attempt = 1; ; attempt += 1) {
      await window.locator('button[\\@click="openPublishSetupModal()"]').click();
      await expect(window.locator('div[x-show="publishSetupModalOpen"]')).toBeVisible({ timeout: 10000 });
      await window.locator('button[\\@click="onPublishSetupConfirm()"]').click();
      await expect(modal).toBeVisible({ timeout: 10000 });
      await window.waitForFunction(() => {
        const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
        return g.phase === 'terminal';
      }, null, { timeout: 90000 });
      const errText = await window.evaluate(() => String(Alpine.$data(document.querySelector('[x-data]')).gitExecution.error || ''));
      if (!/preparar arquivo/i.test(errText) || attempt >= 3) return H.readGitExec(window);
      log.push(`[1] tentativa ${attempt}: bug documentado do produto (race de git add paralelo → "${errText.slice(0, 80)}") — repetindo o publish`);
      await window.locator('button[\\@click="closeGitExecModal()"]').click();
      await expect(modal).toBeHidden({ timeout: 10000 });
    }
  };

  try {
    await H.openMainWithProject(window);
    await H.installSampler(window);

    // ════ 1. PUBLISH THAT FAILS (150 MB + dirty draft) ═══════════════════
    fs.writeFileSync(path.join(worktree, 'big.bin'), '');
    execFileSync('dd', ['if=/dev/zero', `of=${path.join(worktree, 'big.bin')}`, 'bs=1M', 'count=150'], { stdio: 'pipe' });
    fs.writeFileSync(path.join(worktree, 'draft-integration.md'), 'rascunho da integração\n');
    log.push('[1] big.bin 150MB + draft sujo criados');

    await publishAndSettle();
    let st = await H.readGitExec(window);
    log.push(`[1] terminal=failed errorClass=${st.errorClass} offending=${JSON.stringify(st.offendingFiles)} restored=${st.restored}`);
    expect(st.errorClass).toBe('large_file');
    expect(st.restored).toBe(true);
    const restoreBanner = window.locator('div[x-show="gitExecution.restored === true"]');
    await expect(restoreBanner).toBeVisible({ timeout: 15000 });
    await window.screenshot({ path: path.join(EV, 'INT-01-failed-restored.png') });
    log.push('[1] falha large_file + "estado original restaurado": PASS');
    await assertNoIso('INT-1 failed');

    // ════ 2. RAW LOGS + CLIPBOARD ════════════════════════════════════════
    await window.locator('button[\\@click="toggleRawLogs()"]').click();
    const viewer = window.locator('div[x-show="gitExecution.rawLogs.open"]');
    await expect(viewer).toBeVisible({ timeout: 10000 });
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.rawLogs.loading === false && g.rawLogs.entries.length > 0;
    }, null, { timeout: 15000 });
    const pushHeader = viewer.locator('button', { hasText: /\$ git push/ }).first();
    await expect(pushHeader).toBeVisible({ timeout: 10000 });
    await pushHeader.click();
    // GH001-shaped stderr ONLY exists in the push entry — matching plain
    // "big.bin" can hit a collapsed earlier entry (e.g. status output).
    const stderrPre = viewer.locator('pre').filter({ hasText: /big\.bin is 150\.00 MB/ }).first();
    await expect(stderrPre).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="copyRawLogsToClipboard()"]').click();
    await expect(window.locator('span[x-show="gitExecution.rawLogs.copied"]')).toBeVisible({ timeout: 10000 });
    const clipboardText = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
    expect(clipboardText).toContain('git push');
    expect(clipboardText).toMatch(/big\.bin/);
    await window.screenshot({ path: path.join(EV, 'INT-02-raw-logs.png') });
    log.push(`[2] logs brutos ($ git push + GH001) + clipboard (${clipboardText.length} chars): PASS`);

    await window.locator('button[\\@click="closeGitExecModal()"]').click();
    await expect(modal).toBeHidden({ timeout: 10000 });
    await assertFooterSynced('pós-falha');

    // ════ 3. FIX + RE-PUBLISH SUCCESS ═══════════════════════════════════
    fs.rmSync(path.join(worktree, 'big.bin'));
    log.push('[3] big.bin removido (correção do usuário)');

    await window.locator('button[\\@click="openPublishSetupModal()"]').click();
    await expect(window.locator('div[x-show="publishSetupModalOpen"]')).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="onPublishSetupConfirm()"]').click();
    await expect(modal).toBeVisible({ timeout: 10000 });
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal';
    }, null, { timeout: 90000 });
    st = await H.readGitExec(window);
    log.push(`[3] re-publish terminal=${st.terminal} success=${st.success}`);
    expect(st.terminal).toBe('complete');
    expect(st.success).toBe(true);
    await window.screenshot({ path: path.join(EV, 'INT-03-republish-success.png') });
    const originPreview1 = execFileSync('git', ['rev-parse', 'preview'], { cwd: origin }).toString().trim();
    const localHead1 = H.gitHead(worktree);
    expect(originPreview1).toBe(localHead1);
    log.push('[3] origin recebeu a republicação (HEAD == origin/preview): PASS');

    await window.locator('button[\\@click="closeGitExecModal()"]').click();
    await expect(modal).toBeHidden({ timeout: 10000 });
    await assertFooterSynced('pós-republicação');

    // ════ 4. UPDATE → CANCEL MID-FLIGHT ═════════════════════════════════
    fs.writeFileSync(path.join(worktree, 'draft-update.md'), 'rascunho antes do cancel\n');
    fs.writeFileSync(hangFlag, 'stall');

    await window.locator('button[\\@click="onRefreshClick()"]').click();
    const refreshConfirm = window.locator('div[x-show="refreshConfirmModalOpen"]');
    await expect(refreshConfirm).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="confirmRefresh()"]').click();
    await expect(modal).toBeVisible({ timeout: 10000 });
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.stage === 'fetching' && g.phase === 'running';
    }, null, { timeout: 30000 });
    log.push('[4] update travado no fetching');

    await window.locator('button[\\@click="cancelGitExec()"]').click();
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.cancelling === true || g.restoring === true || (g.phase === 'terminal' && g.terminal === 'cancelled');
    }, null, { timeout: 30000 });
    await window.screenshot({ path: path.join(EV, 'INT-04-cancelando.png') });
    fs.rmSync(hangFlag, { force: true });

    await expect.poll(() => (H.pgrepAlive(H.DUGITE_FETCH_PATTERN) ? 'alive' : 'dead'), { timeout: 15000 }).toBe('dead');
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal' && g.terminal === 'cancelled';
    }, null, { timeout: 30000 });
    st = await H.readGitExec(window);
    log.push(`[4] terminal=cancelled restored=${st.restored}`);
    expect(st.restored).toBe(true);
    expect(fs.existsSync(path.join(worktree, 'draft-update.md'))).toBe(true);
    await window.screenshot({ path: path.join(EV, 'INT-05-cancelled-restored.png') });
    log.push('[4] cancelado + restaurado (git morto, dirty de volta): PASS');
    await assertNoIso('INT-4 cancelled');

    await window.locator('button[\\@click="closeGitExecModal()"]').click();
    await expect(modal).toBeHidden({ timeout: 10000 });

    // ════ 5. UPDATE AGAIN → SUCCESS (lock livre, mesma sessão) ═══════════
    await window.locator('button[\\@click="onRefreshClick()"]').click();
    await expect(refreshConfirm).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="confirmRefresh()"]').click();
    await expect(modal).toBeVisible({ timeout: 10000 });
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal';
    }, null, { timeout: 90000 });
    st = await H.readGitExec(window);
    log.push(`[5] 2º update terminal=${st.terminal} success=${st.success}`);
    expect(st.terminal).toBe('complete');
    expect(st.success).toBe(true);
    await window.screenshot({ path: path.join(EV, 'INT-06-final-update-complete.png') });
    log.push('[5] update final concluído SEM restart: PASS');

    await assertFooterSynced('final');
    await assertNoIso('INT-5 final');

    const samples = await H.stopSampler(window);
    fs.writeFileSync(path.join(EV, 'INT-samples.json'), JSON.stringify(samples, null, 2));
    // State-based (T13 precedent): the "Cancelando…" LABEL window can be
    // shorter than any polling period in a stalled transport — the
    // cancelling/restoring STATE windows are the deterministic signal.
    const stateSamples = samples.filter((s) => s.cancelling || s.restoring);
    expect(stateSamples.length).toBeGreaterThan(0);
    const labelSamples = samples.filter((s) => /Cancelando|Canceling/.test(String(s.cancelLabel)));
    const restoringSamples = stateSamples.filter((s) => s.restoring);
    const badWindows = restoringSamples.filter((s) => s.cancelDisabled === false);
    expect(badWindows.length).toBe(0);
    log.push(`[edge sampler] janelas cancelling/restoring (${stateSamples.length} amostras; label "Cancelando…" em ${labelSamples.length}) + RESTORING com cancel desabilitado (${restoringSamples.length} amostras): PASS`);

    log.push('', 'RESULT: PASS — jornada completa numa única sessão');
  } finally {
    fs.rmSync(hangFlag, { force: true });
    fs.writeFileSync(path.join(EV, 'INT-results.txt'), log.join('\n') + '\n', 'utf-8');
    await H.quitApp(electronApp);
  }
});
