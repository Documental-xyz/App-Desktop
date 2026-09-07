'use strict';

/**
 * @fileoverview E2E spec: cancel a repository Update mid-operation
 * (plan publish-update-resilience, Task 13 — user requirement 1).
 *
 * User acceptance criteria covered:
 *  - start an Update (refresh flow) and let it reach the FETCHING stage
 *    against a REAL origin whose transport hangs on a flag file;
 *  - click "Cancelar" while the git fetch child is alive;
 *  - the in-flight git process dies, the single git lock is released,
 *    and the modal shows the cancelled banner + "estado original
 *    restaurado" (Task 7 auto-restore);
 *  - a NEW Update started immediately afterwards reaches the fetching
 *    stage again (proves the lock is NOT stuck) and completes.
 *
 * Launch pattern: REAL Electron app via Playwright's _electron (same
 * harness as close-project-ghost.spec.js / git-progress-realtime.spec.js)
 * with an isolated XDG_CONFIG_HOME whose SQLite DB is pre-seeded with a
 * project row pointing at a REAL git worktree. Backend git runs for real
 * (dugite), so progress events, the operation journal, the git lock and
 * the auto-restore engine are all exercised end-to-end.
 *
 * Fixture: the worktree's origin is a local bare repo reached through a
 * ssh:// URL whose `core.sshCommand` is a QA script that (a) sleeps while
 * a HANG flag file exists — deterministically freezing the fetch inside
 * the FETCHING stage — and (b) otherwise serves the requested git command
 * locally. This gives flag-file control over the transport without any
 * external process (see notepad: uploadpack.packObjectsHook is ignored
 * over file:// local transport on git 2.54, hence the fake-ssh bridge).
 *
 * Runner: npx playwright test tests/e2e/cancel-mid-op.spec.js
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
const EVIDENCE_DIR = path.join(REPO_ROOT, '.omo', 'evidence', 'task-13-cancel-mid-op');

/** System git — used only to BUILD the fixture (the app uses its own dugite). */
const GIT = 'git';

/**
 * Builds the QA fixture: bare origin + worktree whose origin remote is
 * served through the fake-ssh bridge (stall-on-flag transport).
 *
 * Layout: <tmp>/origin.git (bare) · <tmp>/project (worktree, branch
 * preview) · <tmp>/fake-ssh.sh · <tmp>/HANG (flag file).
 *
 * @param {string} tmp - Fixture root (fresh temp dir)
 * @returns {{origin: string, worktree: string, fakeSsh: string, hangFlag: string}}
 */
function buildFixture(tmp) {
  const origin = path.join(tmp, 'origin.git');
  const worktree = path.join(tmp, 'project');
  const fakeSsh = path.join(tmp, 'fake-ssh.sh');
  const hangFlag = path.join(tmp, 'HANG');

  const G = (args, opts = {}) => execFileSync(GIT, args, { stdio: 'pipe', ...opts });

  // Bare origin.
  G(['init', '-q', '--bare', origin]);

  // fake-ssh bridge: while HANG exists the transport sleeps (the git
  // child stays alive inside the FETCHING stage); once released it
  // serves the requested git-upload-pack/receive-pack command locally.
  fs.writeFileSync(fakeSsh, [
    '#!/bin/sh',
    `while [ -f "${hangFlag}" ]; do sleep 0.2; done`,
    'cmd=""',
    'for a in "$@"; do cmd="$a"; done',
    'exec /bin/sh -c "$cmd"',
    '',
  ].join('\n'));
  fs.chmodSync(fakeSsh, 0o755);

  // Worktree on branch `preview` whose origin goes through fake-ssh.
  G(['init', '-q', worktree]);
  const sshUrl = `ssh://git@127.0.0.1${origin}`;
  G(['remote', 'add', 'origin', sshUrl], { cwd: worktree });
  G(['config', 'core.sshCommand', fakeSsh], { cwd: worktree });
  G(['config', 'user.name', 'QA Fixture'], { cwd: worktree });
  G(['config', 'user.email', 'qa@fixture.local'], { cwd: worktree });
  G(['config', 'commit.gpgsign', 'false'], { cwd: worktree });
  fs.writeFileSync(path.join(worktree, 'content.md'), '# QA base content\n');
  G(['add', '.'], { cwd: worktree });
  G(['commit', '-qm', 'QA base commit'], { cwd: worktree });
  G(['branch', '-M', 'preview'], { cwd: worktree });
  G(['push', '-q', '-u', 'origin', 'preview'], { cwd: worktree });

  return { origin, worktree, fakeSsh, hangFlag };
}

/**
 * Seeds the app's SQLite DB (documental.db) with project id 1 pointing
 * at the fixture worktree, so the REAL git handlers resolve it.
 *
 * @param {string} userData - $XDG_CONFIG_HOME/Documental (pre-created)
 * @param {string} worktree - Absolute fixture worktree path
 * @param {string} repoUrl - Origin URL (bookkeeping only)
 * @returns {Promise<void>}
 */
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
 * Launches the real app with the seeded isolated userData (returning
 * user → first window is index.html).
 * @returns {Promise<{electronApp: import('playwright').ElectronApplication, window: import('playwright').Page}>}
 */
async function launchApp(worktree, repoUrl) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-t13-cancel-'));
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

/** SIGKILL-then-close quit (the exit-confirmation beforeunload guard
 *  makes a graceful close hang — same as the existing e2e specs). */
async function quitApp(electronApp) {
  const proc = electronApp.process();
  try { proc.kill('SIGKILL'); } catch (_e) { /* already gone */ }
  try { await electronApp.close(); } catch (_e) { /* already gone */ }
}

/** Navigates to main.html with project 1 open and Alpine fully live. */
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

/**
 * pgrep patterns scoped to THIS fixture / THIS app:
 * - the fake-ssh helper carries the unique tmp path in its argv;
 * - the app's git children run from the bundled dugite binary (the host
 *   may run unrelated `git fetch` processes — never match those).
 */
const fakeSshPattern = (tmp) => `${tmp}/fake-ssh.sh`;
const DUGITE_FETCH_PATTERN = 'dugite.*fetch';

/** Reads the live gitExecution slice (state-based waits, never sleeps). */
const readGitExec = (window) => window.evaluate(() => {
  const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
  return {
    modalOpen: g.modalOpen,
    phase: g.phase,
    terminal: g.terminal,
    stage: g.stage,
    cancelling: g.cancelling,
    restoring: g.restoring,
    restored: g.restored,
    restoredFrom: g.restoredFrom,
    success: g.success,
    operationId: g.operationId,
  };
});

test('cancel Update during fetching: git child dies, lock freed, banner cancelled + restaurado, next Update works', async () => {
  test.setTimeout(150000);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidenceLines = ['Task 13 — cancel-mid-op evidence', '='.repeat(40), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-t13-fx-'));
  const { worktree, hangFlag, origin } = buildFixture(tmp);
  const { electronApp, window } = await launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await openMainWithProject(window);

    // Dirty the worktree BEFORE the Update: the refresh flow WIP-commits
    // it and the Task 7 auto-restore must bring the dirty file back —
    // "estado original restaurado" is only meaningful with something to
    // restore.
    fs.writeFileSync(path.join(worktree, 'dirty-notes.md'), 'unsaved editor work\n');

    // ── Start Update through the REAL buttons ───────────────────────────
    const refreshBtn = window.locator('button[\\@click="onRefreshClick()"]');
    await expect(refreshBtn).toBeVisible({ timeout: 15000 });
    await refreshBtn.click();

    const refreshConfirm = window.locator('div[x-show="refreshConfirmModalOpen"]');
    await expect(refreshConfirm).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="confirmRefresh()"]').click();

    const modal = window.locator('div[x-show="gitExecution.modalOpen"]');
    await expect(modal).toBeVisible({ timeout: 10000 });

    // ── Wait for the FETCHING stage (transport is HANGING on the flag) ──
    fs.writeFileSync(hangFlag, 'stall'); // freeze the fetch mid-flight
    await window.waitForFunction(() => {
      return Alpine.$data(document.querySelector('[x-data]')).gitExecution.stage === 'fetching';
    }, null, { timeout: 30000 });
    let st = await readGitExec(window);
    expect(st.phase).toBe('running');
    evidenceLines.push(`[stage] fetching reached while origin hangs (running, op ${st.operationId}): PASS`);

    // Stepper DOM: the fetching row is the ACTIVE step (spinner icon).
    const fetchingRow = window.locator('div.bg-background-dark div.flex.items-center', {
      hasText: /Buscando alterações|Fetching changes/,
    }).filter({ has: window.locator('.step-icon-active, [style*="autorenew"]') });
    await expect(fetchingRow.first()).toBeVisible({ timeout: 5000 });
    evidenceLines.push('[stepper] fetching row rendered ACTIVE in the stepper: PASS');

    // The stalled transport helper must genuinely be alive pre-cancel:
    // poll until the fake-ssh helper process exists (it spawns a few ms
    // after the fetching stage event) — the cancel below then provably
    // kills a LIVE in-flight git operation.
    await expect.poll(async () => {
      try {
        execFileSync('pgrep', ['-f', fakeSshPattern(tmp)]);
        return 'alive';
      } catch (_e) { return 'gone'; }
    }, { timeout: 15000 }).toBe('alive');
    evidenceLines.push('[process] fake-ssh helper alive during stalled fetching: PASS');

    // ── CANCEL mid-operation ────────────────────────────────────────────
    await window.locator('button[\\@click="cancelGitExec()"]').click();

    // Wait for the cancel to TAKE EFFECT (settle): the backend kills the
    // git child, runs the auto-restore ("Restaurando…" dynamic stage) and
    // settles on the cancelled terminal. NOTE: no further git:progress
    // event fires between requestCancel and the restoring stage in this
    // scenario (dugite does not stream transfer % over the stalled ssh
    // transport), so the "Cancelando…" label is asserted via state
    // (cancelling|restoring) rather than a fixed wait — see notepad.
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.cancelling === true || g.restoring === true ||
        (g.phase === 'terminal' && g.terminal === 'cancelled');
    }, null, { timeout: 30000 });
    evidenceLines.push('[cancel] cancel settle signal observed (cancelling/restoring/terminal): PASS');

    // The stalled `git fetch` child must be DEAD after the cancel (real
    // signal forwarding — dugite kill). Scoped to the bundled dugite
    // binary: the sandbox may run unrelated `git fetch` processes.
    const fetchProcGone = async () => {
      try {
        execFileSync('pgrep', ['-f', DUGITE_FETCH_PATTERN]);
        return 'alive';
      } catch (_e) { return 'dead'; }
    };
    await expect.poll(fetchProcGone, { timeout: 15000 }).toBe('dead');
    evidenceLines.push('[process] stalled `git fetch` child DEAD after cancel (signal forwarding): PASS');

    // Release the transport: the (possibly orphaned) fake-ssh helper loop
    // exits on its own once the flag file is gone.
    fs.rmSync(hangFlag, { force: true });
    await expect.poll(async () => {
      try {
        execFileSync('pgrep', ['-f', fakeSshPattern(tmp)]);
        return 'alive';
      } catch (_e) { return 'dead'; }
    }, { timeout: 15000 }).toBe('dead');
    evidenceLines.push('[process] full process tree gone (fake-ssh helper exited): PASS');

    // ── Terminal: cancelled banner + restored notification ──────────────
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal' && g.terminal === 'cancelled';
    }, null, { timeout: 30000 });
    st = await readGitExec(window);
    evidenceLines.push(`[terminal] terminal=cancelled restored=${st.restored} restoredFrom=${st.restoredFrom}`);

    const cancelledBanner = window.locator('div[x-show="gitExecution.phase === \'terminal\' && gitExecution.terminal === \'cancelled\'"]');
    await expect(cancelledBanner).toBeVisible({ timeout: 10000 });
    await expect(cancelledBanner).toContainText(/Operação cancelada|Operation cancelled/);

    const restoreBanner = window.locator('div[x-show="gitExecution.restored === true"]');
    await expect(restoreBanner).toBeVisible({ timeout: 10000 });
    await expect(restoreBanner).toContainText(/estado original do seu repositório foi restaurado|original state of your repository was restored/);
    await expect(restoreBanner.locator('p.font-mono')).toContainText(/backup\//);
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '01-cancelled-restored.png') });
    evidenceLines.push('[banner] cancelled + restored(+restoredFrom) banners visible: PASS');

    // The dirty editor work must be back on disk (original state).
    await expect.poll(() => fs.existsSync(path.join(worktree, 'dirty-notes.md')), { timeout: 10000 }).toBe(true);
    evidenceLines.push('[worktree] dirty file restored on disk: PASS');

    // ── NEW Update immediately: proves the git lock was released ────────
    await window.locator('button[\\@click="closeGitExecModal()"]').click();
    await expect(modal).toBeHidden({ timeout: 10000 });

    await refreshBtn.click();
    await expect(refreshConfirm).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="confirmRefresh()"]').click();
    await expect(modal).toBeVisible({ timeout: 10000 });

    // Lock-held would return a failure WITHOUT ever emitting stages —
    // reaching `fetching` again is the discriminator.
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.stage === 'fetching' && g.phase === 'running';
    }, null, { timeout: 30000 });
    evidenceLines.push('[lock] second Update reached fetching again — lock NOT stuck: PASS');

    // And it completes: full recovery.
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal';
    }, null, { timeout: 60000 });
    st = await readGitExec(window);
    evidenceLines.push(`[recovery] second Update terminal=${st.terminal} success=${st.success}`);
    expect(st.terminal).toBe('complete');
    expect(st.success).toBe(true);
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '02-second-update-complete.png') });
    evidenceLines.push('[recovery] second Update completed: PASS');
  } finally {
    fs.rmSync(hangFlag, { force: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'results.txt'), evidenceLines.join('\n') + '\n', 'utf-8');
    await quitApp(electronApp);
  }
});
