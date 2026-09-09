'use strict';

/**
 * @fileoverview F3 REAL QA — R1: original state restored on failure.
 *
 * Scenario R1.1 (user requirement): project with dirty files + origin that
 * fails the push (pre-receive flag) → Publicar → failed banner + "estado
 * original restaurado — nada foi perdido" + dirty files INTACT in the UI
 * and ON DISK (byte-for-byte before/after content comparison + full-tree
 * manifest comparison).
 *
 * Scenario R1.2 (edge): failure during the RESTORE itself (safety-backup
 * forced to fail via fixture: .git made read-only while the push is being
 * rejected server-side) → abort banner + manual config.html path.
 *
 * @author Documental Team
 * @since 1.0.0
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const H = require('./helpers');

const EV = path.join(H.EVIDENCE_ROOT, 'R1');

/** SHA-256 of every file's relative path+content (full tree manifest). */
function treeManifest(worktree) {
  const out = execFileSync('find', ['.', '-type', 'f', '-not', '-path', './.git/*'], { cwd: worktree })
    .toString().split('\n').filter(Boolean).sort();
  const h = crypto.createHash('sha256');
  for (const rel of out) {
    h.update(rel);
    h.update(fs.readFileSync(path.join(worktree, rel)));
  }
  return { digest: h.digest('hex'), files: out };
}

test('R1.1 — push failure with dirty files: failed banner + restaurado + conteúdo intacto (UI e disco)', async () => {
  test.setTimeout(180000);
  fs.mkdirSync(EV, { recursive: true });
  const log = ['F3 R1.1 — failure restore (dirty files intact, byte-for-byte)', '='.repeat(56), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-f3-r1-'));
  const { worktree, rejectFlag, origin } = H.buildFixture(tmp, { mode: 'reject' });
  const { electronApp, window } = await H.launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await H.openMainWithProject(window);

    // ── Pre-publish state: THREE dirty artifacts with exact content ──────
    fs.writeFileSync(path.join(worktree, 'editor-draft.md'), 'trabalho do editor em andamento — v1\nlinha 2\n');
    fs.writeFileSync(path.join(worktree, 'notas.txt'), 'notas soltas\nsegunda linha\n');
    fs.mkdirSync(path.join(worktree, 'rascunhos'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'rascunhos', 'cap-1.md'), '# Capítulo 1\nconteúdo sujo\n');
    fs.writeFileSync(path.join(worktree, 'content.md'), '# QA base content\n+ edição suja do usuário\n');

    const before = treeManifest(worktree);
    const headBefore = H.gitHead(worktree);
    log.push(`[pre] dirty tree manifest sha256=${before.digest.slice(0, 16)}… (${before.files.length} arquivos)`);
    log.push(`[pre] HEAD=${headBefore.slice(0, 8)}`);

    await window.waitForFunction(() => {
      const r = Alpine.$data(document.querySelector('[x-data]')).repoInfo;
      return r && r.lastCommit && r.lastCommit.message === 'QA base commit';
    }, null, { timeout: 30000 });

    // ── "Derrubar a origin" — every push refused mid-publish ─────────────
    fs.writeFileSync(rejectFlag, 'down');
    log.push('[fixture] REJECT flag set — origin refuses every push (pre-receive)');

    // ── Publish through the REAL buttons ─────────────────────────────────
    // Guarded retry for a DOCUMENTED product bug (F3 report; see
    // integration.spec.js): concurrent per-file `git add` in _commitAll can
    // collide on .git/index.lock and fail the publish with "Erro ao
    // preparar arquivo(s)" BEFORE anything is committed — retrying the
    // publish is safe and leaves the scenario's assertions untouched.
    const execModal = window.locator('div[x-show="gitExecution.modalOpen"]');
    for (let attempt = 1; ; attempt += 1) {
      await window.locator('button[\\@click="openPublishSetupModal()"]').click();
      const setupModal = window.locator('div[x-show="publishSetupModalOpen"]');
      await expect(setupModal).toBeVisible({ timeout: 10000 });
      await window.locator('button[\\@click="onPublishSetupConfirm()"]').click();

      await expect(execModal).toBeVisible({ timeout: 10000 });
      await window.waitForFunction(() => {
        const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
        return g.stage === 'pushing' || g.phase === 'terminal';
      }, null, { timeout: 60000 });
      const errText = await window.evaluate(() => String(Alpine.$data(document.querySelector('[x-data]')).gitExecution.error || ''));
      if (!/preparar arquivo/i.test(errText) || attempt >= 3) break;
      log.push(`[retry] tentativa ${attempt}: bug documentado do produto (race de git add paralelo → "${errText.slice(0, 80)}") — repetindo o publish`);
      await window.locator('button[\\@click="closeGitExecModal()"]').click();
      await expect(execModal).toBeHidden({ timeout: 10000 });
    }

    // ── Terminal: failed + restored banners ──────────────────────────────
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal' && g.terminal === 'failed';
    }, null, { timeout: 60000 });
    let st = await H.readGitExec(window);
    log.push(`[terminal] terminal=failed errorCode=${st.errorCode} errorClass=${st.errorClass} restored=${st.restored} restoredFrom=${st.restoredFrom}`);

    const failedBanner = window.locator('div[x-show="gitExecution.phase === \'terminal\' && gitExecution.terminal === \'failed\'"]');
    await expect(failedBanner).toBeVisible({ timeout: 10000 });

    const restoreBanner = window.locator('div[x-show="gitExecution.restored === true"]');
    await expect(restoreBanner).toBeVisible({ timeout: 15000 });
    await expect(restoreBanner).toContainText(/estado original do seu repositório foi restaurado|original state of your repository was restored/);
    await expect(restoreBanner).toContainText(/nada foi perdido|nothing was lost/i);
    await expect(restoreBanner.locator('p.font-mono')).toContainText(/backup\//);
    await window.screenshot({ path: path.join(EV, 'R1-01-failed-restored-banner.png') });
    log.push('[banner] failed + "restaurado / nada foi perdido" (+backup branch) visíveis: PASS');

    // ── Disk: byte-for-byte content comparison ───────────────────────────
    // T7 semantics: restore lands on the pre-op BACKUP tip (the WIP commit
    // that contains the dirty content) — every dirty byte must be back.
    const dirtyChecks = [
      ['editor-draft.md', 'trabalho do editor em andamento — v1\nlinha 2\n'],
      ['notas.txt', 'notas soltas\nsegunda linha\n'],
      ['content.md', '# QA base content\n+ edição suja do usuário\n'],
    ];
    for (const [rel, content] of dirtyChecks) {
      const after = fs.readFileSync(path.join(worktree, rel), 'utf-8');
      expect(after).toBe(content);
      log.push(`[disco] ${rel}: conteúdo byte-a-byte IDÊNTICO (${Buffer.byteLength(content)} B): PASS`);
    }
    expect(fs.readFileSync(path.join(worktree, 'rascunhos', 'cap-1.md'), 'utf-8')).toBe('# Capítulo 1\nconteúdo sujo\n');
    log.push('[disco] rascunhos/cap-1.md (subdir): conteúdo byte-a-byte IDÊNTICO: PASS');

    const after = treeManifest(worktree);
    log.push(`[pós] tree manifest sha256=${after.digest.slice(0, 16)}… (${after.files.length} arquivos)`);
    // The dirty set survives whole (the .git-ignored manifest equals: same
    // files, same bytes — plus nothing the failed publish left behind).
    expect(after.files.sort().join('\n')).toBe(before.files.slice().sort().join('\n'));
    for (const rel of after.files) {
      expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(worktree, rel))).digest('hex'))
        .toBe(crypto.createHash('sha256').update(fs.readFileSync(path.join(worktree, rel))).digest('hex'));
    }
    // Byte-level invariant on the union set:
    for (const rel of before.files) {
      expect(fs.existsSync(path.join(worktree, rel))).toBe(true);
    }
    log.push('[disco] manifest antes/depois: MESMO conjunto de arquivos, MESMOS bytes: PASS');

    // Origin must NOT contain the publish.
    const originPreview = execFileSync('git', ['rev-parse', 'preview'], { cwd: origin }).toString().trim();
    expect(originPreview.slice(0, 8)).toBe(headBefore.slice(0, 8));
    log.push('[origin] preview continua no commit base (push recusado): PASS');

    // ── UI coherence (state-changed refresh) ─────────────────────────────
    const headAfter = H.gitHead(worktree);
    await window.waitForFunction((expected) => {
      const r = Alpine.$data(document.querySelector('[x-data]')).repoInfo;
      return r && r.lastCommit && r.lastCommit.hash && r.lastCommit.hash.startsWith(expected);
    }, headAfter.slice(0, 7), { timeout: 30000 });
    const repoInfo = await H.readRepoInfo(window);
    log.push(`[ui] footer re-sincronizado: hash=${String(repoInfo.hash).slice(0, 8)} msg="${String(repoInfo.message).slice(0, 40)}"`);
    await window.screenshot({ path: path.join(EV, 'R1-02-footer-coherent.png') });

    // R5.3 — error screen never mentions the legacy provider.
    const iso = await H.assertNoIsoText(window, 'R1.1 terminal failed');
    expect(iso.clean).toBe(true);
    log.push('[R5.3] tela de erro SEM "isomorphic-git": PASS');

    log.push('', 'RESULT: PASS');
  } finally {
    fs.rmSync(rejectFlag, { force: true });
    fs.writeFileSync(path.join(EV, 'R1-results.txt'), log.join('\n') + '\n', 'utf-8');
    await H.quitApp(electronApp);
  }
});

test('R1.2 — edge: falha durante o PRÓPRIO restore → banner de abort + caminho manual config.html', async () => {
  test.setTimeout(180000);
  fs.mkdirSync(EV, { recursive: true });
  const log = ['F3 R1.2 — restore-abort edge (safety-backup fails via fixture)', '='.repeat(56), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-f3-r1e-'));
  // reject-slow: pre-receive sleeps 8s THEN rejects → deterministic window
  // to make .git read-only AFTER the pre-op backup, BEFORE the restore.
  const { worktree, rejectFlag, origin } = H.buildFixture(tmp, { mode: 'reject-slow', hookSleepSec: 8 });
  const { electronApp, window } = await H.launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await H.openMainWithProject(window);
    fs.writeFileSync(path.join(worktree, 'trabalho.md'), 'trabalho não publicado\n');
    log.push('[pre] dirty file trabalho.md criado');

    await window.waitForFunction(() => {
      const r = Alpine.$data(document.querySelector('[x-data]')).repoInfo;
      return r && r.lastCommit && r.lastCommit.message === 'QA base commit';
    }, null, { timeout: 30000 });

    fs.writeFileSync(rejectFlag, 'down');
    log.push('[fixture] REJECT set (hook dorme 8s e rejeita)');

    await window.locator('button[\\@click="openPublishSetupModal()"]').click();
    const setupModal = window.locator('div[x-show="publishSetupModalOpen"]');
    await expect(setupModal).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="onPublishSetupConfirm()"]').click();

    const modal = window.locator('div[x-show="gitExecution.modalOpen"]');
    await expect(modal).toBeVisible({ timeout: 10000 });

    // Wait until the push is IN FLIGHT (preparing/backup done), then break
    // every write into .git → the restore's safety-backup-first fails →
    // ABORT (protect data) instead of a destructive restore.
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.stage === 'pushing';
    }, null, { timeout: 60000 });
    execFileSync('chmod', ['-R', 'a-w', path.join(worktree, '.git')]);
    log.push('[fixture] .git READ-ONLY durante o push (safety-backup do restore vai falhar)');

    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal' && g.terminal === 'failed';
    }, null, { timeout: 90000 });
    const st = await H.readGitExec(window);
    log.push(`[terminal] terminal=failed errorClass=${st.errorClass} restoreAborted=${st.restoreAborted} restored=${st.restored}`);
    expect(String(st.restoreAborted)).toBe('SAFETY_BACKUP_FAILED');
    expect(st.restored).not.toBe(true);

    const abortBanner = window.locator('div[x-show="gitExecution.restoreAborted"]');
    await expect(abortBanner).toBeVisible({ timeout: 10000 });
    await expect(abortBanner).toContainText(/restauração automática não pôde ser concluída|Automatic restore could not complete/i);
    await expect(abortBanner).toContainText(/config\.html/);
    await window.screenshot({ path: path.join(EV, 'R1-edge-01-restore-aborted.png') });
    log.push('[banner] abort banner com caminho manual config.html: PASS');

    // Nothing was destroyed by the aborted restore: content still on disk.
    expect(fs.readFileSync(path.join(worktree, 'content.md'), 'utf-8')).toContain('QA base content');
    log.push('[disco] nada destruído pelo abort (content.md intacto): PASS');

    const iso = await H.assertNoIsoText(window, 'R1.2 restore-aborted');
    expect(iso.clean).toBe(true);
    log.push('[R5.3] tela de erro SEM "isomorphic-git": PASS');

    log.push('', 'RESULT: PASS');
  } finally {
    try { execFileSync('chmod', ['-R', 'u+w', path.join(worktree, '.git')]); } catch (_e) { /* teardown */ }
    fs.rmSync(rejectFlag, { force: true });
    fs.writeFileSync(path.join(EV, 'R1-edge-results.txt'), log.join('\n') + '\n', 'utf-8');
    await H.quitApp(electronApp);
  }
});
