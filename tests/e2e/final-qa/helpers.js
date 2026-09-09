'use strict';

/**
 * @fileoverview Shared harness for the F3 REAL MANUAL QA specs
 * (plan publish-update-resilience, final verification wave).
 *
 * Everything here reuses the proven Task 13 launch protocol: REAL Electron
 * app via Playwright's _electron, REAL dugite backend, isolated userData
 * (XDG_CONFIG_HOME) with a pre-seeded SQLite project row, and a local bare
 * origin reached through a flag-controlled fake-ssh bridge.
 *
 * Fixture modes (see buildFixture):
 *  - reject:        pre-receive refuses pushes while <tmp>/REJECT exists
 *  - reject-slow:   same, but the hook sleeps 8s first (chmod window for
 *                   the R1 restore-abort edge)
 *  - hang:          transport stalls while <tmp>/HANG exists
 *  - slow:          transport sleeps ~2.5s per command while <tmp>/SLOW
 *                   exists (R3 real-time stepper)
 *  - largefile:     GitHub-faithful GH001 policy (full incoming history,
 *                   100 MB blob limit) — R2
 *  - largefile-tip: same GH001 stderr shape but only the TIP tree is
 *                   scanned (integration: republish after removing the
 *                   big file succeeds; documented simplification — the
 *                   GitHub-faithful variant is proven in R2)
 *  - plain:         no hooks (success flows)
 *
 * @author Documental Team
 * @since 1.0.0
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MAIN_JS = path.join(REPO_ROOT, 'main.js');
const EVIDENCE_ROOT = path.join(REPO_ROOT, '.omo', 'evidence', 'final-qa');
const GIT = 'git';

/** Large-file threshold (bytes) for the GH001 policy fixtures. */
const GH_LIMIT = 100 * 1024 * 1024;

/**
 * @param {string} tmp - Fresh fixture root
 * @param {{mode?: string, hookSleepSec?: number}} [opts]
 * @returns {{origin: string, worktree: string, fakeSsh: string,
 *            rejectFlag: string, hangFlag: string, slowFlag: string,
 *            connTimeoutFlag: string}}
 */
function buildFixture(tmp, opts = {}) {
  const mode = opts.mode || 'plain';
  const origin = path.join(tmp, 'origin.git');
  const worktree = path.join(tmp, 'project');
  const fakeSsh = path.join(tmp, 'fake-ssh.sh');
  const rejectFlag = path.join(tmp, 'REJECT');
  const hangFlag = path.join(tmp, 'HANG');
  const slowFlag = path.join(tmp, 'SLOW');
  const connTimeoutFlag = path.join(tmp, 'CONNTIMEOUT');

  const G = (args, o = {}) => execFileSync(GIT, args, { stdio: 'pipe', ...o });

  G(['init', '-q', '--bare', origin]);
  // HEAD must point at the branch the app talks to (preview). With the
  // default (unborn master), any `git clone` of the fixture checks out
  // master — origin-side pushes then land on refs/heads/master and the
  // app's origin/preview never diverges (bug observed live in E1/R3.1).
  G(['symbolic-ref', 'HEAD', 'refs/heads/preview'], { cwd: origin });

  // fake-ssh bridge: CONNTIMEOUT fails like an unreachable ssh endpoint
  // (R2.2 — real "Connection timed out" stderr for the timeout class);
  // HANG freezes the transport; SLOW adds a per-command delay
  // (deterministic stage windows); otherwise serve locally.
  fs.writeFileSync(fakeSsh, [
    '#!/bin/sh',
    `if [ -f "${connTimeoutFlag}" ]; then`,
    '  echo "ssh: connect to host 127.0.0.1 port 22: Connection timed out" >&2',
    '  exit 255',
    'fi',
    `while [ -f "${hangFlag}" ]; do sleep 0.2; done`,
    `if [ -f "${slowFlag}" ]; then sleep ${opts.slowSec || 2.5}; fi`,
    'cmd=""',
    'for a in "$@"; do cmd="$a"; done',
    'exec /bin/sh -c "$cmd"',
    '',
  ].join('\n'));
  fs.chmodSync(fakeSsh, 0o755);

  const hooks = [];

  if (mode === 'reject' || mode === 'reject-slow') {
    const sleep = mode === 'reject-slow' ? `sleep ${opts.hookSleepSec || 8}; ` : '';
    hooks.push(
      '#!/bin/sh',
      `if [ -f "${rejectFlag}" ]; then`,
      `  ${sleep}echo "QA fixture: origin is refusing the push (simulated origin failure)" >&2`,
      '  exit 1',
      'fi',
      'exit 0',
      '',
    );
  }

  if (mode === 'largefile' || mode === 'largefile-tip') {
    // GitHub-style large-file policy emitting the exact GH001 stderr shape
    // GitError.extractOffendingFiles / classifyError expect.
    if (mode === 'largefile') {
      // Full incoming history (faithful to GitHub's real behavior).
      hooks.push(
        '#!/bin/sh',
        'tmp=$(mktemp)',
        'while read old new ref; do',
        '  [ "$new" != "0000000000000000000000000000000000000000" ] || continue',
        '  git rev-list --objects "$new" --not --all \\',
        `    | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' > "$tmp.list" 2>/dev/null || true`,
        '  while read type size fpath; do',
        '    [ "$type" = blob ] || continue',
        `    if [ "$size" -gt ${GH_LIMIT} ]; then`,
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
      );
    } else {
      // TIP-tree-only scan: the integration journey (fix = remove the big
      // file → republish succeeds) stays exercisable end-to-end. The
      // GitHub-faithful full-history variant is covered by R2.
      hooks.push(
        '#!/bin/sh',
        'tmp=$(mktemp)',
        'while read old new ref; do',
        '  [ "$new" != "0000000000000000000000000000000000000000" ] || continue',
        '  git ls-tree -r "$new" > "$tmp.tip" 2>/dev/null || true',
        '  while read mode type oid fpath; do',
        '    [ "$type" = blob ] || continue',
        `    size=$(git cat-file -s "$oid" 2>/dev/null || echo 0)`,
        `    if [ "$size" -gt ${GH_LIMIT} ]; then`,
        '      mb=$(awk "BEGIN{printf \\"%.2f\\", $size/1048576}")',
        `      echo "error: File $fpath is $mb MB; this exceeds GitHub's file size limit of 100.00 MB" >&2`,
        '      echo "error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com." >&2',
        '      echo 1 > "$tmp.bad"',
        '    fi',
        '  done < "$tmp.tip"',
        'done',
        'rm -f "$tmp.tip"',
        'if [ -f "$tmp.bad" ]; then rm -f "$tmp.bad"; exit 1; fi',
        'exit 0',
        '',
      );
    }
  }

  if (hooks.length > 0) {
    fs.mkdirSync(path.join(origin, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), hooks.join('\n'));
    fs.chmodSync(path.join(origin, 'hooks', 'pre-receive'), 0o755);
  }

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

  return { origin, worktree, fakeSsh, rejectFlag, hangFlag, slowFlag, connTimeoutFlag };
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
 * Seeds a fake GitHub token in SecureTokenService fallback format (same
 * derivation as failure-restore.spec.js — publish flows require a token
 * before the backup/push core; it is never used against the local ssh
 * origin).
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
async function launchApp(worktree, repoUrl, opts = {}) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), opts.homePrefix || 'documental-f3-'));
  const userData = path.join(tmpHome, 'Documental');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, '.first-time'), 'completed');
  await seedProjectDb(userData, worktree, repoUrl);
  if (!opts.noToken) seedGithubToken(userData);

  /* eslint-disable global-require */
  const { _electron } = require('@playwright/test');
  /* eslint-enable global-require */
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

/** SIGKILL-then-close quit (beforeunload exit guard hangs a graceful close). */
async function quitApp(electronApp) {
  const proc = electronApp.process();
  try { proc.kill('SIGKILL'); } catch (_e) { /* already gone */ }
  try { await electronApp.close(); } catch (_e) { /* already gone */ }
}

/** main.html with project 1 open, Alpine live, locale pt-BR (default). */
async function openMainWithProject(window, opts = {}) {
  await window.waitForURL(/index\.html/, { timeout: 20000 });
  await window.evaluate((locale) => {
    localStorage.setItem('appLocale', locale);
    sessionStorage.setItem('currentProjectId', '1');
    sessionStorage.setItem('devServerUrl', 'http://127.0.0.1:4321/');
    window.electronAPI.navigateTo('main.html');
  }, opts.locale || 'pt-BR');
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
    restoreAborted: g.restoreAborted,
    success: g.success,
    operationId: g.operationId,
    errorCode: g.errorCode,
    errorClass: g.errorClass,
    error: g.error ? String(g.error).slice(0, 200) : null,
    errorTitleKey: g.errorTitleKey,
    offendingFiles: g.offendingFiles,
    rawLogOpId: g.rawLogOpId,
    progressWidth: g.progress ? g.progress.width : null,
    percentage: g.percentage,
  };
});

const readRepoInfo = (window) => window.evaluate(() => {
  const r = Alpine.$data(document.querySelector('[x-data]')).repoInfo;
  return { branch: r.currentBranch || null, hash: (r.lastCommit && r.lastCommit.hash) || null, message: (r.lastCommit && r.lastCommit.message) || null };
});

const gitHead = (worktree) => execFileSync(GIT, ['rev-parse', 'HEAD'], { cwd: worktree }).toString().trim();

/**
 * R5.3: the visible page must NEVER mention the legacy provider
 * (requirement: error screens contain no "isomorphic-git" string).
 */
const assertNoIsoText = async (window, label) => window.evaluate((l) => {
  const text = document.body.innerText || '';
  return { label: l, clean: !/isomorphic/i.test(text) };
}, label);

/**
 * Installs an in-page high-frequency sampler (every ~60ms) recording the
 * gitExecution evolution: stage, progress width, restoring flag and the
 * cancel button's disabled state. Used to prove (a) the bar advances
 * gradually (no 0→100 jump) and (b) cancel is disabled while RESTORING.
 */
async function installSampler(window) {
  await window.evaluate(() => {
    window.__qaSamples = [];
    // Stage-transition trace: an Alpine.effect dependency records EVERY
    // gitExecution.stage/phase/progress-width write — deterministic,
    // unlike interval sampling (fast local stages can pass between two
    // 60ms ticks).
    window.__qaStageTrace = [];
    const el = () => document.querySelector('[x-data]');
    if (window.Alpine && el()) {
      window.__qaTraceEffect = Alpine.effect(() => {
        const g = Alpine.$data(el()).gitExecution;
        if (!g) return;
        const last = window.__qaStageTrace[window.__qaStageTrace.length - 1];
        const cur = { t: Date.now(), stage: g.stage, phase: g.phase, width: g.progress ? g.progress.width : null };
        if (!last || last.stage !== cur.stage || last.phase !== cur.phase || last.width !== cur.width) {
          window.__qaStageTrace.push(cur);
        }
      });
    }
    // Unique to the exec modal: only this button's x-text references
    // common.canceling. Disabled = visual (cursor-not-allowed class) +
    // functional guard in cancelGitExec() — the button has no native
    // :disabled binding, so we capture the disabled STYLE + label.
    const btn = () => document.querySelector('button[x-text*="canceling"]');
    window.__qaSampler = setInterval(() => {
      try {
        const root = document.querySelector('[x-data]');
        if (!root || !window.Alpine) return;
        const g = Alpine.$data(root).gitExecution;
        const b = btn();
        window.__qaSamples.push({
          t: Date.now(),
          phase: g.phase,
          stage: g.stage,
          width: g.progress ? g.progress.width : null,
          pct: g.percentage,
          restoring: !!g.restoring,
          cancelling: !!g.cancelling,
          cancelDisabled: b ? (b.className.includes('cursor-not-allowed') || b.disabled) : null,
          cancelLabel: b ? b.textContent.trim() : null,
        });
        if (window.__qaSamples.length > 4000) window.__qaSamples.shift();
      } catch (_e) { /* page tearing down */ }
    }, 60);
  });
}

const readSamples = (window) => window.evaluate(() => ({
  samples: window.__qaSamples || [],
  stop() { if (window.__qaSampler) clearInterval(window.__qaSampler); },
}));

const stopSampler = async (window) => window.evaluate(() => {
  if (window.__qaSampler) clearInterval(window.__qaSampler);
  return window.__qaSamples || [];
});

/** Deterministic stage/phase transitions recorded by installSampler's effect. */
const readStageTrace = (window) => window.evaluate(() => window.__qaStageTrace || []);

/** Scoped process probes (precedent: cancel-mid-op.spec.js). */
const fakeSshPattern = (tmp) => `${tmp}/fake-ssh.sh`;
const DUGITE_FETCH_PATTERN = 'dugite.*fetch';
const pgrepAlive = (pattern) => {
  try { execFileSync('pgrep', ['-f', pattern]); return true; } catch (_e) { return false; }
};

module.exports = {
  REPO_ROOT,
  EVIDENCE_ROOT,
  buildFixture,
  seedProjectDb,
  seedGithubToken,
  launchApp,
  quitApp,
  openMainWithProject,
  readGitExec,
  readRepoInfo,
  gitHead,
  assertNoIsoText,
  installSampler,
  stopSampler,
  readStageTrace,
  fakeSshPattern,
  DUGITE_FETCH_PATTERN,
  pgrepAlive,
};
