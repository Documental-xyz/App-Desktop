'use strict';

/**
 * @fileoverview E2E spec: large_file failure → "Ver logs brutos" viewer
 * with real git entries (plan publish-update-resilience, Task 13 — user
 * requirement 3).
 *
 * User acceptance criteria covered:
 *  - publish with a 150 MB file (dd fixture) → the fixture origin applies
 *    a GitHub-style large-file policy in pre-receive (REAL size check via
 *    cat-file, GH001-shaped stderr) → push rejected;
 *  - the failed banner shows the large_file error (title via i18n/fallback)
 *    and the offending file list contains the 150 MB artifact;
 *  - "Ver logs brutos" opens the Task 11 viewer: at least one journal
 *    entry containing "git push", its stderr carrying the remote
 *    rejection (remote: error: GH001 / ! [remote rejected]);
 *  - the copy button reflects "Copiado ✓".
 *
 * Launch pattern: REAL Electron app via Playwright's _electron with a
 * pre-seeded SQLite project row + fake-ssh transport to a local bare
 * origin (same harness as cancel-mid-op.spec.js / failure-restore.spec.js).
 *
 * Runner: npx playwright test tests/e2e/raw-logs.spec.js
 *   -c tests/e2e/playwright.config.js   (xvfb-run required, no sandbox)
 *
 * @author Documental Team
 * @since 1.0.0
 */

const { test, expect, _electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_JS = path.join(REPO_ROOT, 'main.js');
const EVIDENCE_DIR = path.join(REPO_ROOT, '.omo', 'evidence', 'task-13-raw-logs');
const GIT = 'git';
const BIG_FILE_MB = 150;

/**
 * Fixture: bare origin whose pre-receive hook enforces a GitHub-style
 * 100 MB blob policy (real size inspection of the incoming objects) +
 * worktree on branch preview.
 *
 * @param {string} tmp - Fresh fixture root
 * @returns {{origin: string, worktree: string}}
 */
function buildFixture(tmp) {
  const origin = path.join(tmp, 'origin.git');
  const worktree = path.join(tmp, 'project');
  const fakeSsh = path.join(tmp, 'fake-ssh.sh');

  const G = (args, opts = {}) => execFileSync(GIT, args, { stdio: 'pipe', ...opts });

  G(['init', '-q', '--bare', origin]);

  fs.writeFileSync(fakeSsh, [
    '#!/bin/sh',
    'cmd=""',
    'for a in "$@"; do cmd="$a"; done',
    'exec /bin/sh -c "$cmd"',
    '',
  ].join('\n'));
  fs.chmodSync(fakeSsh, 0o755);

  // GitHub-style large-file policy: inspect every incoming blob (size in
  // bytes via cat-file --batch-check) and reject with the exact GH001
  // stderr shape GitError.extractOffendingFiles/classifyError expect.
  fs.mkdirSync(path.join(origin, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), [
    '#!/bin/sh',
    'tmp=$(mktemp)',
    'while read old new ref; do',
    '  [ "$new" != "0000000000000000000000000000000000000000" ] || continue',
    '  git rev-list --objects "$new" --not --all \\',
    `    | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' > "$tmp.list" 2>/dev/null || true`,
    '  while read type size fpath; do',
    '    [ "$type" = blob ] || continue',
    '    if [ "$size" -gt 104857600 ]; then',
    '      mb=$(awk "BEGIN{printf \\"%.2f\\", $size/1048576}")',
    `      echo "error: File $fpath is $mb MB; this exceeds GitHub's file size limit of 100.00 MB" >&2`,
    '      echo "error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com." >&2',
    '      echo 1 > "$tmp.bad"',
    '    fi',
    '  done < "$tmp.list"',
    'done',
    'rm -f "$tmp.list"',
    'if [ -f "$tmp.bad" ]; then rm -f "$tmp.bad"; exit 1; fi',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(origin, 'hooks', 'pre-receive'), 0o755);

  G(['init', '-q', worktree]);
  G(['remote', 'add', 'origin', `ssh://git@127.0.0.1${origin}`], { cwd: worktree });
  G(['config', 'core.sshCommand', fakeSsh], { cwd: worktree });
  G(['config', 'user.name', 'QA Fixture'], { cwd: worktree });
  G(['config', 'user.email', 'qa@fixture.local'], { cwd: worktree });
  G(['config', 'commit.gpgsign', 'false'], { cwd: worktree });
  fs.writeFileSync(path.join(worktree, 'content.md'), '# QA base content\n');
  G(['add', '.'], { cwd: worktree });
  G(['commit', '-qm', 'QA base commit'], { cwd: worktree });
  G(['branch', '-M', 'preview'], { cwd: worktree });
  G(['push', '-q', '-u', 'origin', 'preview'], { cwd: worktree });

  return { origin, worktree };
}

/** Seeds documental.db with project 1 → fixture worktree. */
function seedProjectDb(userData, worktree, repoUrl) {
  /* eslint-disable global-require */
  const sqlite3 = require(path.join(REPO_ROOT, 'node_modules', 'sqlite3'));
  /* eslint-enable global-require */
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(userData, 'documental.db'));
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projectName TEXT NOT NULL,
        projectPath TEXT NOT NULL,
        repoFolderName TEXT,
        repoUrl TEXT,
        repoFullName TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      db.run(
        'INSERT INTO projects (id, projectName, projectPath, repoFolderName, repoUrl) VALUES (1, ?, ?, NULL, ?)',
        ['QA Fixture', worktree, repoUrl],
        (err) => (err ? reject(err) : resolve()),
      );
    });
    db.close();
  });
}

/**
 * Fake GitHub token in SecureTokenService fallback format (same
 * derivation as failure-restore.spec.js — see the rationale there).
 * @param {string} userData - $XDG_CONFIG_HOME/Documental
 */
function seedGithubToken(userData) {
  /* eslint-disable global-require */
  const crypto = require('crypto');
  /* eslint-enable global-require */
  const machineKey = crypto.createHash('sha256').update([
    os.hostname(),
    os.userInfo().username,
    userData,
    'documental-token-encryption-v1',
  ].join(':')).digest('hex');
  const token = `ghp_${'q'.repeat(36)}`;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(machineKey, 'hex'), iv);
  const encrypted = cipher.update(token, 'utf-8', 'base64') + cipher.final('base64');
  fs.writeFileSync(path.join(userData, 'github-token.enc.json'), JSON.stringify({
    updatedAt: new Date().toISOString(),
    method: 'fallback',
    encrypted,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }, null, 2));
}

/** Real-app launch with the seeded isolated userData. */
async function launchApp(worktree, repoUrl) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-t13-logs-'));
  const userData = path.join(tmpHome, 'Documental');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, '.first-time'), 'completed');
  await seedProjectDb(userData, worktree, repoUrl);
  seedGithubToken(userData);

  const electronApp = await _electron.launch({
    args: [MAIN_JS, '--no-sandbox'],
    env: { ...process.env, XDG_CONFIG_HOME: tmpHome },
    timeout: 30000,
  });
  const window = await electronApp.firstWindow();
  window.on('dialog', (dialog) => { dialog.dismiss().catch(() => {}); });
  await window.waitForLoadState('domcontentloaded');
  return { electronApp, window };
}

async function quitApp(electronApp) {
  const proc = electronApp.process();
  try { proc.kill('SIGKILL'); } catch (_e) { /* already gone */ }
  try { await electronApp.close(); } catch (_e) { /* already gone */ }
}

/** main.html with project 1 open and Alpine live. */
async function openMainWithProject(window) {
  await window.waitForURL(/index\.html/, { timeout: 20000 });
  await window.evaluate(() => {
    localStorage.setItem('appLocale', 'pt-BR');
    sessionStorage.setItem('currentProjectId', '1');
    sessionStorage.setItem('devServerUrl', 'http://127.0.0.1:4321/');
    window.electronAPI.navigateTo('main.html');
  });
  await window.waitForURL(/main\.html/, { timeout: 20000 });
  await window.waitForLoadState('domcontentloaded');
  await window.waitForFunction(() => {
    const el = document.querySelector('[x-data]');
    return window.Alpine && el && Alpine.$data(el).gitExecution;
  }, null, { timeout: 20000 });
  await window.waitForFunction(() => {
    return Alpine.$data(document.querySelector('[x-data]')).initialLoading === false;
  }, null, { timeout: 30000 });
}

test('large_file publish failure: banner + Ver logs brutos com entradas git reais + copiar', async () => {
  test.setTimeout(150000);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidenceLines = ['Task 13 — raw-logs evidence', '='.repeat(40), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-t13-fx-'));
  const { worktree, origin } = buildFixture(tmp);
  const { electronApp, window } = await launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await openMainWithProject(window);

    // The oversized artifact: 150 MB (dd) — the pre-receive policy
    // rejects blobs over 100 MB with GitHub's GH001 stderr shape.
    const bigFile = path.join(worktree, 'big.bin');
    execFileSync('dd', ['if=/dev/zero', `of=${bigFile}`, 'bs=1M', `count=${BIG_FILE_MB}`], { stdio: 'pipe' });
    evidenceLines.push(`[fixture] big.bin created: ${BIG_FILE_MB} MB (${fs.statSync(bigFile).size} bytes)`);

    // ── Publish (preview) through the REAL buttons ──────────────────────
    await window.locator('button[\\@click="openPublishSetupModal()"]').click();
    const setupModal = window.locator('div[x-show="publishSetupModalOpen"]');
    await expect(setupModal).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="onPublishSetupConfirm()"]').click();

    const modal = window.locator('div[x-show="gitExecution.modalOpen"]');
    await expect(modal).toBeVisible({ timeout: 10000 });

    // ── Terminal: large_file failure ────────────────────────────────────
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal' && g.terminal === 'failed';
    }, null, { timeout: 90000 });
    const st = await window.evaluate(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return { errorClass: g.errorClass, errorTitleKey: g.errorTitleKey, offendingFiles: g.offendingFiles, rawLogOpId: g.rawLogOpId };
    });
    evidenceLines.push(`[terminal] failed errorClass=${st.errorClass} titleKey=${st.errorTitleKey} offending=${JSON.stringify(st.offendingFiles)}`);
    expect(st.errorClass).toBe('large_file');
    expect(st.offendingFiles).toContain('big.bin');
    expect(st.rawLogOpId).toBeTruthy();

    const failedBanner = window.locator('div[x-show="gitExecution.phase === \'terminal\' && gitExecution.terminal === \'failed\'"]');
    await expect(failedBanner).toBeVisible({ timeout: 10000 });
    // Friendly title: i18n key (T12) or its EN fallback — both describe
    // the oversized-file failure.
    await expect(failedBanner).toContainText(/arquivo|file/i);
    await expect(failedBanner).toContainText('big.bin');
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '01-largefile-banner.png') });
    evidenceLines.push('[banner] large_file banner with offending file list: PASS');

    // ── "Ver logs brutos" → journal entries ─────────────────────────────
    const viewLogsBtn = window.locator('button[\\@click="toggleRawLogs()"]');
    await expect(viewLogsBtn).toBeVisible({ timeout: 10000 });
    await expect(viewLogsBtn).toContainText(/logs brutos|raw logs/i);
    await viewLogsBtn.click();

    const viewer = window.locator('div[x-show="gitExecution.rawLogs.open"]');
    await expect(viewer).toBeVisible({ timeout: 10000 });
    // Journal fetch (getOperationLog) must resolve with real entries.
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.rawLogs.loading === false && g.rawLogs.entries.length > 0;
    }, null, { timeout: 15000 });
    const entryCount = await window.evaluate(() => Alpine.$data(document.querySelector('[x-data]')).gitExecution.rawLogs.entries.length);
    evidenceLines.push(`[viewer] journal loaded: ${entryCount} entries (op ${st.rawLogOpId}): PASS`);

    // ≥1 entry whose command line contains "git push".
    const pushHeader = viewer.locator('button', { hasText: /\$ git push/ }).first();
    await expect(pushHeader).toBeVisible({ timeout: 10000 });
    evidenceLines.push('[viewer] journal entry with "$ git push …" header: PASS');

    // Expand the push entry: stderr must carry the remote rejection
    // (remote: error: GH001 / ! [remote rejected]).
    await pushHeader.click();
    const stderrPre = viewer.locator('pre').filter({ hasText: /remote: error: File big\.bin is 150\.00 MB/ }).first();
    await expect(stderrPre).toBeVisible({ timeout: 10000 });
    const stderrText = await stderrPre.textContent();
    evidenceLines.push(`[viewer] push stderr excerpt: ${String(stderrText).replace(/\n/g, ' ⏎ ').slice(0, 220)}`);
    expect(stderrText).toMatch(/remote: error: File big\.bin is 150\.00 MB/i);
    expect(stderrText).toMatch(/GH001|remote rejected/i);
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '02-raw-logs-push-stderr.png') });
    evidenceLines.push('[viewer] push stderr visible with remote rejection + GH001: PASS');

    // ── Copy → "Copiado ✓" badge ────────────────────────────────────────
    await window.locator('button[\\@click="copyRawLogsToClipboard()"]').click();
    const copiedBadge = window.locator('span[x-show="gitExecution.rawLogs.copied"]');
    await expect(copiedBadge).toBeVisible({ timeout: 10000 });
    await expect(copiedBadge).toContainText(/Copiado ✓|Copied ✓/);
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '03-copied-badge.png') });
    evidenceLines.push('[clipboard] copied badge shown: PASS');
  } finally {
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'results.txt'), evidenceLines.join('\n') + '\n', 'utf-8');
    await quitApp(electronApp);
  }
});
