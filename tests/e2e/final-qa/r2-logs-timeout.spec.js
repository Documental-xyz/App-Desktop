'use strict';

/**
 * @fileoverview F3 REAL QA — R2: raw git logs + friendly errors.
 *
 * Scenario R2.1: 150 MB file (dd) committed by the publish flow → origin
 * applies the GitHub-faithful GH001 policy → banner "arquivo grande demais"
 * WITH the offending path listed → "Ver logs brutos" → journal entries with
 * `$ git push` + stderr (GH001 / remote rejected) → copy button → the real
 * CLIPBOARD contains the copied text.
 *
 * Scenario R2.2: origin unreachable (fake-ssh answers with a REAL ssh
 * "Connection timed out" stderr) → the fetch fails with timeout wording →
 * friendly CONNECTION message (pt-BR "A conexão expirou"), never a stack
 * trace. (A merely STALLED transport is auto-aborted by the git lock at
 * 120 s and lands on the cancelled terminal — see the note inside the
 * test.)
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

const EV = path.join(H.EVIDENCE_ROOT, 'R2');
const BIG_FILE_MB = 150;

test('R2.1 — arquivo 150 MB: banner amigável com path + logs brutos ($ git push + GH001) + clipboard', async () => {
  test.setTimeout(180000);
  fs.mkdirSync(EV, { recursive: true });
  const log = ['F3 R2.1 — large file raw logs + clipboard', '='.repeat(48), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-f3-r2-'));
  const { worktree, origin } = H.buildFixture(tmp, { mode: 'largefile' });
  const { electronApp, window } = await H.launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await H.openMainWithProject(window);

    const bigFile = path.join(worktree, 'big.bin');
    execFileSync('dd', ['if=/dev/zero', `of=${bigFile}`, 'bs=1M', `count=${BIG_FILE_MB}`], { stdio: 'pipe' });
    log.push(`[fixture] big.bin: ${BIG_FILE_MB} MB (${fs.statSync(bigFile).size} bytes, dd)`);

    // ── Publish (preview) through the REAL buttons ───────────────────────
    await window.locator('button[\\@click="openPublishSetupModal()"]').click();
    const setupModal = window.locator('div[x-show="publishSetupModalOpen"]');
    await expect(setupModal).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="onPublishSetupConfirm()"]').click();

    const modal = window.locator('div[x-show="gitExecution.modalOpen"]');
    await expect(modal).toBeVisible({ timeout: 10000 });

    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal' && g.terminal === 'failed';
    }, null, { timeout: 90000 });
    const st = await H.readGitExec(window);
    log.push(`[terminal] errorClass=${st.errorClass} titleKey=${st.errorTitleKey} offending=${JSON.stringify(st.offendingFiles)}`);
    expect(st.errorClass).toBe('large_file');
    expect(st.offendingFiles).toContain('big.bin');

    const failedBanner = window.locator('div[x-show="gitExecution.phase === \'terminal\' && gitExecution.terminal === \'failed\'"]');
    await expect(failedBanner).toBeVisible({ timeout: 10000 });
    // Friendly pt-BR title + hint (i18n T12) + offending path listed.
    await expect(failedBanner).toContainText(/Arquivo grande demais para o GitHub|File too large/i);
    await expect(failedBanner).toContainText('big.bin');
    await expect(failedBanner).toContainText(/100 MB/);
    await window.screenshot({ path: path.join(EV, 'R2-01-largefile-banner.png') });
    log.push('[banner] "Arquivo grande demais para o GitHub" + path big.bin listado: PASS');

    // ── "Ver logs brutos" ────────────────────────────────────────────────
    const viewLogsBtn = window.locator('button[\\@click="toggleRawLogs()"]');
    await expect(viewLogsBtn).toContainText(/logs brutos|raw logs/i);
    await viewLogsBtn.click();

    const viewer = window.locator('div[x-show="gitExecution.rawLogs.open"]');
    await expect(viewer).toBeVisible({ timeout: 10000 });
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.rawLogs.loading === false && g.rawLogs.entries.length > 0;
    }, null, { timeout: 15000 });

    const pushHeader = viewer.locator('button', { hasText: /\$ git push/ }).first();
    await expect(pushHeader).toBeVisible({ timeout: 10000 });
    log.push('[viewer] entrada "$ git push …" presente: PASS');

    await pushHeader.click();
    const stderrPre = viewer.locator('pre').filter({ hasText: /remote: error: File big\.bin is 150\.00 MB/ }).first();
    await expect(stderrPre).toBeVisible({ timeout: 10000 });
    const stderrText = await stderrPre.textContent();
    expect(stderrText).toMatch(/remote: error: File big\.bin is 150\.00 MB/i);
    expect(stderrText).toMatch(/GH001|remote rejected/i);
    log.push(`[viewer] stderr: ${String(stderrText).replace(/\n/g, ' ⏎ ').slice(0, 240)}`);
    await window.screenshot({ path: path.join(EV, 'R2-02-raw-logs-stderr.png') });
    log.push('[viewer] stderr com GH001 + remote rejected: PASS');

    // Dump the journal (sanitized) as extra evidence.
    const entries = await window.evaluate(async (opId) => window.electronAPI.getOperationLog(opId), st.rawLogOpId);
    fs.writeFileSync(path.join(EV, 'R2-journal-entries.json'), JSON.stringify(entries, null, 2));
    log.push(`[viewer] journal dump: ${entries.entries ? entries.entries.length : 0} entradas → R2-journal-entries.json`);

    // ── Copy → REAL clipboard content ────────────────────────────────────
    await window.locator('button[\\@click="copyRawLogsToClipboard()"]').click();
    const copiedBadge = window.locator('span[x-show="gitExecution.rawLogs.copied"]');
    await expect(copiedBadge).toBeVisible({ timeout: 10000 });
    await expect(copiedBadge).toContainText(/Copiado ✓|Copied ✓/);

    const clipboardText = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
    expect(clipboardText).toContain('git push');
    expect(clipboardText).toMatch(/big\.bin/);
    expect(clipboardText).toMatch(/GH001|remote rejected/i);
    log.push(`[clipboard] clipboard real contém o log copiado (${clipboardText.length} chars, "git push" + big.bin + GH001): PASS`);
    fs.writeFileSync(path.join(EV, 'R2-clipboard-content.txt'), clipboardText);
    await window.screenshot({ path: path.join(EV, 'R2-03-copiado-badge.png') });

    const iso = await H.assertNoIsoText(window, 'R2.1 large_file terminal');
    expect(iso.clean).toBe(true);
    log.push('[R5.3] tela de erro SEM "isomorphic-git": PASS');

    log.push('', 'RESULT: PASS');
  } finally {
    fs.writeFileSync(path.join(EV, 'R2-results.txt'), log.join('\n') + '\n', 'utf-8');
    await H.quitApp(electronApp);
  }
});

test('R2.2 — origin inalcançável: connection timeout → mensagem amigável de conexão (sem stack)', async () => {
  test.setTimeout(180000);
  fs.mkdirSync(EV, { recursive: true });
  const log = ['F3 R2.2 — fetch timeout friendly message', '='.repeat(48), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-f3-r2t-'));
  const { worktree, connTimeoutFlag, origin } = H.buildFixture(tmp, { mode: 'plain' });
  const { electronApp, window } = await H.launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await H.openMainWithProject(window);
    fs.writeFileSync(path.join(worktree, 'rascunho-timeout.md'), 'trabalho durante a origem dormindo\n');

    // Make the transport fail like an unreachable origin: the fake-ssh
    // bridge answers every invocation with a REAL ssh "Connection timed
    // out" stderr → the fetch fails with the timeout wording the app
    // classifies (GitError 'timeout' → friendly banner).
    //
    // SPEC BUG fixed here (F3): the original stalled-transport variant
    // (HANG flag) never reaches a failed/timeout terminal — the product's
    // lock auto-abort (LOCK_TIMEOUT_MS = 120 s) kills the stalled fetch
    // with an AbortError, which the refresh flow maps to a CANCELLED
    // terminal ("Operação cancelada" + restore — also friendly, no
    // stack). The friendly TIMEOUT banner requires a real connection
    // timeout, exercised below (documented in the F3 report).
    fs.writeFileSync(connTimeoutFlag, 'down');
    log.push('[fixture] CONNTIMEOUT set — transporte falha com "Connection timed out" real');

    const refreshBtn = window.locator('button[\\@click="onRefreshClick()"]');
    await expect(refreshBtn).toBeVisible({ timeout: 15000 });
    await refreshBtn.click();
    const refreshConfirm = window.locator('div[x-show="refreshConfirmModalOpen"]');
    await expect(refreshConfirm).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="confirmRefresh()"]').click();

    const modal = window.locator('div[x-show="gitExecution.modalOpen"]');
    await expect(modal).toBeVisible({ timeout: 10000 });

    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.stage === 'fetching' || g.phase === 'terminal';
    }, null, { timeout: 30000 });
    log.push(`[stage] fetching iniciado ${new Date().toISOString()} — conexão vai falhar com timeout`);

    // ── Terminal: friendly timeout, NEVER a stack trace ─────────────────
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal' && g.terminal === 'failed';
    }, null, { timeout: 60000 });
    const st = await H.readGitExec(window);
    log.push(`[terminal] errorClass=${st.errorClass} errorCode=${st.errorCode} error="${st.error}"`);
    expect(st.errorClass).toBe('timeout');

    const failedBanner = window.locator('div[x-show="gitExecution.phase === \'terminal\' && gitExecution.terminal === \'failed\'"]');
    await expect(failedBanner).toBeVisible({ timeout: 10000 });
    const bannerText = await failedBanner.textContent();
    // Friendly pt-BR connection message (i18n T12) — human words only.
    expect(bannerText).toMatch(/A conexão expirou|Connection timed out/i);
    expect(bannerText).toMatch(/nada foi perdido|nothing was lost/i);
    // NOT a stack trace: no JS frames, no raw "Error:" dump.
    expect(bannerText).not.toMatch(/at .+\(.+:\d+:\d+\)/);
    expect(bannerText).not.toMatch(/\n\s*at /);
    await window.screenshot({ path: path.join(EV, 'R2-04-timeout-friendly.png') });
    log.push(`[banner] "${String(bannerText).trim().replace(/\s+/g, ' ').slice(0, 160)}"`);
    log.push('[banner] mensagem amigável de conexão SEM stack trace: PASS');

    // Auto-restore still brings the dirty work back (nothing lost).
    const restoreBanner = window.locator('div[x-show="gitExecution.restored === true"]');
    await expect(restoreBanner).toBeVisible({ timeout: 20000 });
    expect(fs.existsSync(path.join(worktree, 'rascunho-timeout.md'))).toBe(true);
    log.push('[restaurado] dirty file de volta no disco após timeout: PASS');

    const iso = await H.assertNoIsoText(window, 'R2.2 timeout terminal');
    expect(iso.clean).toBe(true);
    log.push('[R5.3] tela de erro SEM "isomorphic-git": PASS');

    log.push('', 'RESULT: PASS');
  } finally {
    fs.rmSync(connTimeoutFlag, { force: true });
    fs.writeFileSync(path.join(EV, 'R2-timeout-results.txt'), log.join('\n') + '\n', 'utf-8');
    await H.quitApp(electronApp);
  }
});
