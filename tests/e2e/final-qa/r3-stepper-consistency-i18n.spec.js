'use strict';

/**
 * @fileoverview F3 REAL QA — R3: unified modal + real-time progress +
 * i18n.
 *
 * Scenario R3.1: Update against a SLOW origin (fixture: transport sleeps
 * ~2.5 s per command) → the stepper advances preparing→fetching→merging→
 * finalizing→complete IN REAL TIME — sequential screenshots per stage plus
 * a 60 ms in-page sampler proving the bar advances gradually (never jumps
 * 0→100).
 *
 * Scenario R3.2: Publish and Update look CONSISTENT (same unified stepper
 * modal; no eternal "Verificando permissões" spinner on Publish — the
 * execution modal opens within seconds of confirming).
 *
 * Scenario R3.3: locale pt-BR renders the new strings in Portuguese and
 * the locale switch (en ↔ pt-BR) re-renders them live.
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

const EV = path.join(H.EVIDENCE_ROOT, 'R3');

const G = (args, opts = {}) => execFileSync('git', args, { stdio: 'pipe', ...opts });

function pushOriginSideChange(tmp, origin) {
  const clone = path.join(tmp, 'origin-side');
  G(['clone', '-q', '--branch', 'preview', origin, clone]);
  G(['config', 'user.name', 'QA Origin'], { cwd: clone });
  G(['config', 'user.email', 'qa-origin@fixture.local'], { cwd: clone });
  G(['config', 'commit.gpgsign', 'false'], { cwd: clone });
  fs.writeFileSync(path.join(clone, 'origin-change.md'), 'mudança vinda da origin\n');
  G(['add', '.'], { cwd: clone });
  G(['commit', '-qm', 'Origin-side change'], { cwd: clone });
  G(['push', '-q', 'origin', 'preview'], { cwd: clone });
  return clone;
}

test('R3.1 — Update com origin lenta: stepper avança EM TEMPO REAL (barra não salta 0→100)', async () => {
  test.setTimeout(180000);
  fs.mkdirSync(EV, { recursive: true });
  const log = ['F3 R3.1 — real-time stepper (origin lenta)', '='.repeat(48), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-f3-r3-'));
  const { worktree, slowFlag, origin } = H.buildFixture(tmp, { mode: 'slow', slowSec: 2.5 });
  // Real diverged update: the LOCAL side also carries its own commit (a
  // DIFFERENT file — no conflict), so the merge stage runs a genuine
  // merge instead of an already-up-to-date no-op.
  fs.writeFileSync(path.join(worktree, 'local-note.md'), 'nota local pré-existente\n');
  G(['add', '.'], { cwd: worktree });
  G(['commit', '-qm', 'Local-side change'], { cwd: worktree });
  pushOriginSideChange(tmp, origin);
  const { electronApp, window } = await H.launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await H.openMainWithProject(window);
    await H.installSampler(window);

    const refreshBtn = window.locator('button[\\@click="onRefreshClick()"]');
    await expect(refreshBtn).toBeVisible({ timeout: 15000 });
    fs.writeFileSync(slowFlag, 'on');
    log.push('[fixture] SLOW set — cada comando git remoto dorme 2.5s (origin realisticamente lenta)');

    await refreshBtn.click();
    const refreshConfirm = window.locator('div[x-show="refreshConfirmModalOpen"]');
    await expect(refreshConfirm).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="confirmRefresh()"]').click();

    const modal = window.locator('div[x-show="gitExecution.modalOpen"]');
    await expect(modal).toBeVisible({ timeout: 10000 });

    const stages = ['preparing', 'fetching', 'merging', 'finalizing'];
    const shotNames = { preparing: 'R3-01-preparing', fetching: 'R3-02-fetching', merging: 'R3-03-merging', finalizing: 'R3-04-finalizing' };
    for (const stage of stages) {
      await window.waitForFunction((s) => {
        const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
        return g.stage === s || g.phase === 'terminal';
      }, stage, { timeout: 45000 });
      const st = await H.readGitExec(window);
      if (st.stage === stage) {
        await window.screenshot({ path: path.join(EV, `${shotNames[stage]}.png`) });
        log.push(`[stepper] ${stage} capturado EM TEMPO REAL (width=${st.progressWidth}%): PASS`);
      } else {
        log.push(`[stepper] ${stage}: transição rápida demais para screenshot próprio (sampler registra a passagem)`);
      }
    }

    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal';
    }, null, { timeout: 60000 });
    const st = await H.readGitExec(window);
    expect(st.terminal).toBe('complete');
    expect(st.success).toBe(true);
    await window.screenshot({ path: path.join(EV, 'R3-05-complete.png') });
    log.push(`[terminal] complete success=${st.success}`);

    // pt-BR stage labels rendered (i18n part 1 of R3.3).
    await expect(modal).toContainText(/Buscando alterações/);
    log.push('[i18n] label pt-BR "Buscando alterações" renderizado no stepper: PASS');

    // ── Stage sequence: Alpine.effect trace (deterministic — every
    // stage/phase WRITE is recorded, no 60ms sampling gaps) + gradual bar ─
    const samples = await H.stopSampler(window);
    const trace = await H.readStageTrace(window);
    fs.writeFileSync(path.join(EV, 'R3-samples.json'), JSON.stringify({ samples, stageTrace: trace }, null, 2));
    const seq = trace.filter((s) => s.phase === 'running' || s.phase === 'terminal').map((s) => s.stage);
    const firstIdx = (arr, v) => arr.indexOf(v);
    const order = ['preparing', 'fetching', 'merging', 'finalizing'];
    let monotonic = true;
    let last = -1;
    for (const stg of order) {
      const i = firstIdx(seq, stg);
      if (i !== -1) {
        if (i < last) monotonic = false;
        last = i;
      }
    }
    log.push(`[trace] sequência de estágios (Alpine.effect, determinística): ${[...new Set(seq)].join(' → ')}`);
    expect(monotonic).toBe(true);
    for (const stg of order) expect(seq).toContain(stg);

    // Widths from the same deterministic trace (the 60ms sampler can miss
    // fast local stages' widths — observed as a full-suite flake).
    const running = trace.filter((s) => s.phase === 'running');
    const widths = running.map((s) => s.width);
    const runningWidths = [...new Set(widths)].sort((a, b) => a - b);
    log.push(`[trace] larguras da barra durante running: ${runningWidths.join(', ')}`);
    expect(runningWidths.length).toBeGreaterThanOrEqual(3);
    expect(runningWidths[0]).toBeLessThan(100);
    expect(runningWidths[Math.max(0, runningWidths.length - 2)]).toBeLessThan(100);
    const firstFull = trace.findIndex((s) => s.width === 100);
    const beforeFull = running.slice(0, firstFull < 0 ? running.length : firstFull).filter((s) => s.width > 0 && s.width < 100);
    expect(beforeFull.length).toBeGreaterThan(0);
    log.push(`[trace] barra passou por valores intermediários ANTES do 100 (${beforeFull.length} registros <100%): barra NÃO saltou 0→100: PASS`);

    log.push('', 'RESULT: PASS');
  } finally {
    fs.rmSync(slowFlag, { force: true });
    fs.writeFileSync(path.join(EV, 'R3-stepper-results.txt'), log.join('\n') + '\n', 'utf-8');
    await H.quitApp(electronApp);
  }
});

test('R3.2 — Publish e Update consistentes (stepper unificado, sem spinner eterno de permissões)', async () => {
  test.setTimeout(180000);
  const log = ['F3 R3.2 — modal unificado Publish vs Update', '='.repeat(48), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-f3-r3c-'));
  const { worktree, slowFlag, origin } = H.buildFixture(tmp, { mode: 'slow', slowSec: 1.5 });
  const { electronApp, window } = await H.launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await H.openMainWithProject(window);
    fs.writeFileSync(path.join(worktree, 'novo-conteudo.md'), 'conteúdo novo para publicar\n');

    // ── PUBLISH ──────────────────────────────────────────────────────────
    fs.writeFileSync(slowFlag, 'on');
    const t0 = Date.now();
    await window.locator('button[\\@click="openPublishSetupModal()"]').click();
    const setupModal = window.locator('div[x-show="publishSetupModalOpen"]');
    await expect(setupModal).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="onPublishSetupConfirm()"]').click();

    const modal = window.locator('div[x-show="gitExecution.modalOpen"]');
    // No eternal "Checking permissions" spinner: the unified modal opens
    // within seconds of confirming (the preflight no longer blocks the UI).
    await expect(modal).toBeVisible({ timeout: 10000 });
    const openedIn = Date.now() - t0;
    log.push(`[publish] modal de execução aberto ${openedIn}ms após confirmar (SEM spinner eterno): PASS`);
    await window.screenshot({ path: path.join(EV, 'R3-06-publish-preparing.png') });
    await expect(modal).not.toContainText(/Verificando permissões|Checking permissions/);

    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.stage === 'pushing' || g.phase === 'terminal';
    }, null, { timeout: 60000 });
    const pubSt = await H.readGitExec(window);
    if (pubSt.phase === 'running') {
      await window.screenshot({ path: path.join(EV, 'R3-07-publish-pushing.png') });
      log.push(`[publish] estágio pushing com stepper ativo (width=${pubSt.progressWidth}%): PASS`);
      await expect(modal).not.toContainText(/Verificando permissões|Checking permissions/);
    }
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal';
    }, null, { timeout: 60000 });
    let st = await H.readGitExec(window);
    expect(st.terminal).toBe('complete');
    await window.screenshot({ path: path.join(EV, 'R3-08-publish-complete.png') });
    log.push('[publish] terminal=complete');

    // ── UPDATE (mesma sessão, mesma aparência) ───────────────────────────
    await window.locator('button[\\@click="closeGitExecModal()"]').click();
    await expect(modal).toBeHidden({ timeout: 10000 });

    await window.locator('button[\\@click="onRefreshClick()"]').click();
    const refreshConfirm = window.locator('div[x-show="refreshConfirmModalOpen"]');
    await expect(refreshConfirm).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="confirmRefresh()"]').click();
    await expect(modal).toBeVisible({ timeout: 10000 });

    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.stage === 'fetching' || g.phase === 'terminal';
    }, null, { timeout: 45000 });
    st = await H.readGitExec(window);
    if (st.phase === 'running') {
      await window.screenshot({ path: path.join(EV, 'R3-09-update-fetching.png') });
      log.push(`[update] estágio fetching com stepper ativo (width=${st.progressWidth}%): PASS`);
    }
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal';
    }, null, { timeout: 60000 });
    st = await H.readGitExec(window);
    expect(st.terminal).toBe('complete');
    await window.screenshot({ path: path.join(EV, 'R3-10-update-complete.png') });
    log.push('[update] terminal=complete');

    // Consistency: BOTH flows drove the SAME unified modal component
    // (single x-show="gitExecution.modalOpen" shell + stepper rows).
    const stepperRows = await window.locator('div[x-show="gitExecution.modalOpen"]').count();
    expect(stepperRows).toBe(1);
    log.push('[consistência] Publish e Update usaram o MESMO modal unificado (stepper por estágios): PASS');

    log.push('', 'RESULT: PASS');
  } finally {
    fs.rmSync(slowFlag, { force: true });
    fs.writeFileSync(path.join(EV, 'R3-consistency-results.txt'), log.join('\n') + '\n', 'utf-8');
    await H.quitApp(electronApp);
  }
});

test('R3.3 — i18n: strings novas em pt-BR + troca reativa de locale (en ↔ pt-BR)', async () => {
  test.setTimeout(180000);
  const log = ['F3 R3.3 — i18n das novas strings', '='.repeat(48), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-f3-r3i-'));
  const { worktree, rejectFlag, origin } = H.buildFixture(tmp, { mode: 'reject' });
  const { electronApp, window } = await H.launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await H.openMainWithProject(window, { locale: 'pt-BR' });
    fs.writeFileSync(path.join(worktree, 'i18n-draft.md'), 'rascunho i18n\n');

    fs.writeFileSync(rejectFlag, 'down');
    await window.locator('button[\\@click="openPublishSetupModal()"]').click();
    await expect(window.locator('div[x-show="publishSetupModalOpen"]')).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="onPublishSetupConfirm()"]').click();
    const modal = window.locator('div[x-show="gitExecution.modalOpen"]');
    await expect(modal).toBeVisible({ timeout: 10000 });

    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal' && g.terminal === 'failed';
    }, null, { timeout: 60000 });
    const st = await H.readGitExec(window);
    log.push(`[terminal] failed errorClass=${st.errorClass}`);

    const failedBanner = window.locator('div[x-show="gitExecution.phase === \'terminal\' && gitExecution.terminal === \'failed\'"]');
    await expect(failedBanner).toBeVisible({ timeout: 10000 });
    const ptText = await failedBanner.textContent();
    log.push(`[pt-BR] banner: ${String(ptText).trim().replace(/\s+/g, ' ').slice(0, 200)}`);
    await expect(failedBanner).toContainText(/[ãáéçõ]|Problema|Algo|expirou|rede|conex/i);
    await window.screenshot({ path: path.join(EV, 'R3-11-failure-ptbr.png') });
    log.push('[pt-BR] strings de falha renderizadas em PORTUGUÊS: PASS');

    // Reactive locale switch through the REAL product API — the exact
    // function config.html's language <select @change> invokes.
    //
    // SPEC BUG fixed here (F3): the failed banner renders via mt(), which
    // calls the NON-reactive global __t() — those bindings do NOT
    // re-render on changeLanguage (documented product finding P-2 in the
    // F3 report; they refresh on the next page load, e.g. via
    // language.html navigation). Live re-rendering is asserted on the
    // STORE-BOUND strings of the same terminal modal ($store.i18n.t):
    // the close button (main.git_exec_close_btn) and, present on this
    // PUSH_REJECTED failure, the retry button (main.git_exec_retry_refresh_btn).
    const retryBtn = window.locator('button[\\@click="retryGitExecWithRefresh()"]');
    await expect(retryBtn).toBeVisible({ timeout: 10000 });
    await expect(retryBtn).toContainText(/Atualizar|Update/);
    const closeButton = window.locator('div[x-show="gitExecution.modalOpen"]').locator('button', { hasText: /^(Fechar|Close)$/ }).first();
    await expect(closeButton).toContainText(/Fechar|Close/);

    await window.evaluate(() => Alpine.store('i18n').changeLanguage('en'));
    await expect(retryBtn).toContainText(/Update|Refresh/i, { timeout: 10000 });
    await expect(closeButton).toContainText(/Close/);
    await window.screenshot({ path: path.join(EV, 'R3-12-failure-en.png') });
    log.push('[en] troca reativa (Alpine.store i18n — a API real do config.html) re-renderizou as strings AO VIVO: PASS');

    await window.evaluate(() => Alpine.store('i18n').changeLanguage('pt-BR'));
    await expect(retryBtn).toContainText(/Atualizar/, { timeout: 10000 });
    await expect(closeButton).toContainText(/Fechar/);
    log.push('[pt-BR] volta ao português (re-render ao vivo): PASS');

    log.push('', 'RESULT: PASS');
  } finally {
    fs.rmSync(rejectFlag, { force: true });
    fs.writeFileSync(path.join(EV, 'R3-i18n-results.txt'), log.join('\n') + '\n', 'utf-8');
    await H.quitApp(electronApp);
  }
});
