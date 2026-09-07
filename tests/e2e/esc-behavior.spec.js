'use strict';

/**
 * @fileoverview E2E spec: ESC behavior matrix for the publish/update
 * modals (plan publish-update-resilience, Task 13 — user requirement 4).
 *
 * The Task 10 ESC matrix, exercised against the REAL app:
 *  1. Setup modal open (pre-operation)            → ESC CLOSES it;
 *  2. Execution modal RUNNING (backend op alive)  → ESC does NOT close —
 *     it requests the CANCEL (modal stays open, operation settles
 *     cancelled);
 *  3. Execution modal TERMINAL                    → ESC CLOSES it.
 *
 * Case 2 uses the flag-file fake-ssh transport (same fixture as
 * cancel-mid-op.spec.js) so the refresh flow is genuinely RUNNING and
 * blocked in the fetching stage when ESC is pressed — a silent close
 * there would orphan a live backend operation, which is exactly what the
 * matrix forbids.
 *
 * Launch pattern: REAL Electron app via Playwright's _electron with a
 * pre-seeded SQLite project row (same harness as the other Task 13
 * specs).
 *
 * Runner: npx playwright test tests/e2e/esc-behavior.spec.js
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
const EVIDENCE_DIR = path.join(REPO_ROOT, '.omo', 'evidence', 'task-13-esc-behavior');
const GIT = 'git';

/**
 * Fixture: bare origin + worktree (branch preview) whose ssh transport
 * stalls while <tmp>/HANG exists (case 2 needs a live blocked fetch).
 *
 * @param {string} tmp - Fresh fixture root
 * @returns {{origin: string, worktree: string, hangFlag: string}}
 */
function buildFixture(tmp) {
  const origin = path.join(tmp, 'origin.git');
  const worktree = path.join(tmp, 'project');
  const fakeSsh = path.join(tmp, 'fake-ssh.sh');
  const hangFlag = path.join(tmp, 'HANG');

  const G = (args, opts = {}) => execFileSync(GIT, args, { stdio: 'pipe', ...opts });

  G(['init', '-q', '--bare', origin]);

  fs.writeFileSync(fakeSsh, [
    '#!/bin/sh',
    `while [ -f "${hangFlag}" ]; do sleep 0.2; done`,
    'cmd=""',
    'for a in "$@"; do cmd="$a"; done',
    'exec /bin/sh -c "$cmd"',
    '',
  ].join('\n'));
  fs.chmodSync(fakeSsh, 0o755);

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

  return { origin, worktree, hangFlag };
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

/** Real-app launch with the seeded isolated userData. */
async function launchApp(worktree, repoUrl) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-t13-esc-'));
  const userData = path.join(tmpHome, 'Documental');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, '.first-time'), 'completed');
  await seedProjectDb(userData, worktree, repoUrl);

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

const readModalState = (window) => window.evaluate(() => {
  const d = Alpine.$data(document.querySelector('[x-data]'));
  const g = d.gitExecution;
  return {
    setupOpen: d.publishSetupModalOpen,
    modalOpen: g.modalOpen,
    phase: g.phase,
    terminal: g.terminal,
    stage: g.stage,
    cancelling: g.cancelling,
    restoring: g.restoring,
  };
});

test.describe('ESC matrix (Task 10 semantics, real app)', () => {
  test('setup: ESC fecha · running: ESC cancela (NÃO fecha) · terminal: ESC fecha', async () => {
    test.setTimeout(150000);
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const evidenceLines = ['Task 13 — esc-behavior evidence', '='.repeat(40), ''];

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-t13-fx-'));
    const { worktree, hangFlag, origin } = buildFixture(tmp);
    const { electronApp, window } = await launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

    try {
      await openMainWithProject(window);
      const modal = window.locator('div[x-show="gitExecution.modalOpen"]');

      // ── Case 1: SETUP open → ESC CLOSES ────────────────────────────────
      await window.locator('button[\\@click="openPublishSetupModal()"]').click();
      const setupModal = window.locator('div[x-show="publishSetupModalOpen"]');
      await expect(setupModal).toBeVisible({ timeout: 10000 });
      await window.keyboard.press('Escape');
      await expect(setupModal).toBeHidden({ timeout: 5000 });
      evidenceLines.push('[case 1] setup modal: ESC → CLOSED: PASS');

      // No execution modal may have leaked from case 1.
      await expect(modal).toBeHidden({ timeout: 5000 });

      // ── Case 2: RUNNING → ESC CANCELS, does NOT close ──────────────────
      fs.writeFileSync(hangFlag, 'stall');
      await window.locator('button[\\@click="onRefreshClick()"]').click();
      const refreshConfirm = window.locator('div[x-show="refreshConfirmModalOpen"]');
      await expect(refreshConfirm).toBeVisible({ timeout: 10000 });
      await window.locator('button[\\@click="confirmRefresh()"]').click();
      await expect(modal).toBeVisible({ timeout: 10000 });

      await window.waitForFunction(() => {
        return Alpine.$data(document.querySelector('[x-data]')).gitExecution.stage === 'fetching';
      }, null, { timeout: 30000 });
      evidenceLines.push('[case 2] execution RUNNING at fetching (transport blocked)');

      await window.keyboard.press('Escape');

      // The modal must STILL be open — ESC during running may never
      // silently close the modal (it orphans a live backend operation).
      let st = await readModalState(window);
      expect(st.modalOpen).toBe(true);
      await expect(modal).toBeVisible({ timeout: 5000 });
      evidenceLines.push('[case 2] ESC while running: modal STILL OPEN (no silent close): PASS');

      // And ESC's actual effect: the cancel request — the operation
      // settles cancelled (not complete, not failed-by-itself).
      fs.rmSync(hangFlag, { force: true });
      await window.waitForFunction(() => {
        const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
        return g.phase === 'terminal' && g.terminal === 'cancelled';
      }, null, { timeout: 30000 });
      st = await readModalState(window);
      evidenceLines.push(`[case 2] ESC effect: terminal=${st.terminal} (cancel requested, not a close)`);
      await window.screenshot({ path: path.join(EVIDENCE_DIR, '01-running-esc-cancelled.png') });
      evidenceLines.push('[case 2] running: ESC → CANCEL (modal survived until settle): PASS');

      // ── Case 3: TERMINAL → ESC CLOSES ──────────────────────────────────
      await window.keyboard.press('Escape');
      await expect(modal).toBeHidden({ timeout: 5000 });
      st = await readModalState(window);
      expect(st.modalOpen).toBe(false);
      expect(st.phase).toBe('idle');
      evidenceLines.push('[case 3] terminal: ESC → CLOSED (modalOpen=false, phase=idle): PASS');

      await window.screenshot({ path: path.join(EVIDENCE_DIR, '02-after-terminal-esc.png') });
    } finally {
      fs.rmSync(hangFlag, { force: true });
      fs.writeFileSync(path.join(EVIDENCE_DIR, 'results.txt'), evidenceLines.join('\n') + '\n', 'utf-8');
      await quitApp(electronApp);
    }
  });
});
