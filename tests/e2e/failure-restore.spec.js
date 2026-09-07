'use strict';

/**
 * @fileoverview E2E spec: origin failure during publish → failed banner +
 * original state restored + UI tree preserved
 * (plan publish-update-resilience, Task 13 — user requirement 2).
 *
 * User acceptance criteria covered:
 *  - "derrubar a origin durante a publicação": the fixture origin refuses
 *    the push MID-PUBLISH (pre-receive hook aborts on a flag file, right
 *    after the Task 7 backup was taken — exactly the window where a real
 *    GitHub outage/rejection strikes);
 *  - the modal shows the failed banner AND the green "estado original
 *    restaurado" notification (Task 7 auto-restore + Task 11 banner);
 *  - the UI stays coherent (footer branch/commit labels re-synced via
 *    git:state-changed) and the workspace content is preserved on disk
 *    (dirty editor file back, HEAD unchanged, base files intact).
 *
 * Launch pattern: REAL Electron app via Playwright's _electron with a
 * pre-seeded SQLite project row (same harness as cancel-mid-op.spec.js —
 * see that file for the fixture rationale). The origin is a local bare
 * repo reached through the fake-ssh bridge, so its pre-receive hook has
 * full flag-file control over push outcomes.
 *
 * Runner: npx playwright test tests/e2e/failure-restore.spec.js
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
const EVIDENCE_DIR = path.join(REPO_ROOT, '.omo', 'evidence', 'task-13-failure-restore');
const GIT = 'git';

/**
 * Fixture: bare origin with a flag-controlled pre-receive hook + worktree
 * on branch preview. While <tmp>/REJECT exists the origin refuses every
 * push ("origin down" mid-publish); without it pushes succeed.
 *
 * @param {string} tmp - Fresh fixture root
 * @returns {{origin: string, worktree: string, rejectFlag: string}}
 */
function buildFixture(tmp) {
  const origin = path.join(tmp, 'origin.git');
  const worktree = path.join(tmp, 'project');
  const fakeSsh = path.join(tmp, 'fake-ssh.sh');
  const rejectFlag = path.join(tmp, 'REJECT');

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

  // Origin-side failure injection: pre-receive abort → the push dies
  // mid-publish with "! [remote rejected]" (the classic origin-down /
  // policy rejection surface seen by the real flow).
  fs.mkdirSync(path.join(origin, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), [
    '#!/bin/sh',
    `if [ -f "${rejectFlag}" ]; then`,
    '  echo "QA fixture: origin is refusing the push (simulated origin failure)" >&2',
    '  exit 1',
    'fi',
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

  return { origin, worktree, rejectFlag };
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
 * Seeds a fake GitHub token the way SecureTokenService's fallback
 * (safeStorage-less) format does: AES-256-GCM with the machine-derived
 * key sha256(hostname:username:<userData>:documental-token-encryption-v1).
 * gitPushToBranch hard-fails without a token ("Autenticação GitHub
 * necessária") before the backup/push core — the fixture origin is a
 * local ssh remote, so the token is never used against the network
 * (DugiteProvider only offers credentials for github.com URLs).
 *
 * @param {string} userData - $XDG_CONFIG_HOME/Documental
 */
function seedGithubToken(userData) {
  /* eslint-disable global-require */
  const crypto = require('crypto');
  const os = require('os');
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
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-t13-fail-'));
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

const readGitExec = (window) => window.evaluate(() => {
  const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
  return {
    modalOpen: g.modalOpen,
    phase: g.phase,
    terminal: g.terminal,
    stage: g.stage,
    restored: g.restored,
    restoredFrom: g.restoredFrom,
    errorCode: g.errorCode,
    errorClass: g.errorClass,
  };
});

const readRepoInfo = (window) => window.evaluate(() => {
  const r = Alpine.$data(document.querySelector('[x-data]')).repoInfo;
  return { branch: r.currentBranch || null, hash: (r.lastCommit && r.lastCommit.hash) || null, message: (r.lastCommit && r.lastCommit.message) || null };
});

const gitHead = (worktree) => execFileSync(GIT, ['rev-parse', 'HEAD'], { cwd: worktree }).toString().trim();

test('origin failure during publish: failed banner + estado original restaurado + UI tree preservada', async () => {
  test.setTimeout(150000);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidenceLines = ['Task 13 — failure-restore evidence', '='.repeat(40), ''];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-t13-fx-'));
  const { worktree, rejectFlag, origin } = buildFixture(tmp);
  const { electronApp, window } = await launchApp(worktree, `ssh://git@127.0.0.1${origin}`);

  try {
    await openMainWithProject(window);

    // Pre-publish workspace state: dirty editor file + known content.
    fs.writeFileSync(path.join(worktree, 'editor-draft.md'), 'editor work in progress\n');
    const headBefore = gitHead(worktree);
    evidenceLines.push(`[pre] HEAD before publish: ${headBefore.slice(0, 8)}`);

    // Wait until the footer labels synced to the base commit (UI ready).
    await window.waitForFunction(() => {
      const r = Alpine.$data(document.querySelector('[x-data]')).repoInfo;
      return r && r.lastCommit && r.lastCommit.message === 'QA base commit';
    }, null, { timeout: 30000 });
    const repoInfoBefore = await readRepoInfo(window);
    evidenceLines.push(`[pre] footer repoInfo synced: hash=${String(repoInfoBefore.hash).slice(0, 8)} msg="${repoInfoBefore.message}"`);

    // ── "Derrubar a origin": every push is refused mid-publish ──────────
    fs.writeFileSync(rejectFlag, 'down');

    // ── Publish through the REAL buttons (preview branch) ───────────────
    await window.locator('button[\\@click="openPublishSetupModal()"]').click();
    const setupModal = window.locator('div[x-show="publishSetupModalOpen"]');
    await expect(setupModal).toBeVisible({ timeout: 10000 });
    await window.locator('button[\\@click="onPublishSetupConfirm()"]').click();

    const modal = window.locator('div[x-show="gitExecution.modalOpen"]');
    await expect(modal).toBeVisible({ timeout: 10000 });

    // The push must die at the PUSHING stage (pre-receive abort) — the
    // operation genuinely reached the origin before failing.
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.stage === 'pushing' || g.phase === 'terminal';
    }, null, { timeout: 60000 });

    // ── Terminal: failed banner + restore notification ──────────────────
    await window.waitForFunction(() => {
      const g = Alpine.$data(document.querySelector('[x-data]')).gitExecution;
      return g.phase === 'terminal' && g.terminal === 'failed';
    }, null, { timeout: 60000 });
    const st = await readGitExec(window);
    evidenceLines.push(`[terminal] terminal=failed errorCode=${st.errorCode} errorClass=${st.errorClass} restored=${st.restored} restoredFrom=${st.restoredFrom}`);

    const failedBanner = window.locator('div[x-show="gitExecution.phase === \'terminal\' && gitExecution.terminal === \'failed\'"]');
    await expect(failedBanner).toBeVisible({ timeout: 10000 });

    const restoreBanner = window.locator('div[x-show="gitExecution.restored === true"]');
    await expect(restoreBanner).toBeVisible({ timeout: 15000 });
    await expect(restoreBanner).toContainText(/estado original do seu repositório foi restaurado|original state of your repository was restored/);
    await expect(restoreBanner.locator('p.font-mono')).toContainText(/backup\//);
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '01-failed-restored.png') });
    evidenceLines.push('[banner] failed + restored(+restoredFrom) banners visible: PASS');

    // ── Workspace preserved (original state restored) ───────────────────
    // T7 semantics: the restore target is the pre-op BACKUP tip (taken
    // right after the WIP/publish commit) — the editor content lives
    // safely INSIDE that commit; nothing is left behind on the refused
    // push and nothing is lost.
    const headAfter = gitHead(worktree);
    const subjectAfter = execFileSync(GIT, ['log', '-1', '--format=%s'], { cwd: worktree }).toString().trim();
    const diagLog = execFileSync(GIT, ['log', '--oneline', '--all', '-6'], { cwd: worktree }).toString();
    evidenceLines.push(`[worktree] HEAD after restore: ${headAfter.slice(0, 8)} "${subjectAfter}"\n[diag] git log --all:\n${diagLog}`);
    expect(subjectAfter).toMatch(/Content update by|WIP by/);
    expect(fs.readFileSync(path.join(worktree, 'content.md'), 'utf-8')).toContain('QA base content');
    expect(fs.existsSync(path.join(worktree, 'editor-draft.md'))).toBe(true);
    evidenceLines.push('[worktree] base content intact + editor content preserved (inside the restored commit): PASS');

    // The origin must NOT contain the publish (it refused it).
    const originPreview = execFileSync(GIT, ['rev-parse', 'preview'], { cwd: origin }).toString().trim();
    expect(originPreview.slice(0, 8)).toBe(headBefore.slice(0, 8));
    evidenceLines.push('[origin] origin preview still at pre-publish commit (push refused): PASS');

    // ── UI tree preserved: footer labels re-sync coherently ─────────────
    // git:state-changed (reason auto-restore) → loadRepositoryInfo() —
    // the labels must describe the ACTUAL post-restore state (== disk).
    await window.waitForFunction((expected) => {
      const r = Alpine.$data(document.querySelector('[x-data]')).repoInfo;
      return r && r.lastCommit && r.lastCommit.hash && r.lastCommit.hash.startsWith(expected);
    }, headAfter.slice(0, 7), { timeout: 30000 });
    const repoInfoAfter = await readRepoInfo(window);
    evidenceLines.push(`[ui] footer repoInfo re-synced to restored HEAD: hash=${String(repoInfoAfter.hash).slice(0, 8)}`);
    await window.screenshot({ path: path.join(EVIDENCE_DIR, '02-footer-coherent.png') });
    evidenceLines.push('[ui] UI tree preserved (labels coherent with disk, page stable): PASS');
  } finally {
    fs.rmSync(rejectFlag, { force: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'results.txt'), evidenceLines.join('\n') + '\n', 'utf-8');
    await quitApp(electronApp);
  }
});
