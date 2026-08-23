/**
 * @fileoverview Complete project creation handler
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const { createRequire } = require('module');
const { GitOperations } = require('./gitOperations.js');
const { GitService } = require('../git/GitService.js');
const { createGitProvider } = require('../git/GitProviderFactory.js');
const { ProcessManager } = require('./processManager.js');
const { t } = require('../utils/mainI18n');

// iso-git acquisition for the GitService loaders. Unlike the other T12
// modules (dynamic import()), this file MUST acquire via require semantics:
// tests/ipc/gitClone-security.test.js installs a Module._load monkey
// patch, which intercepts require() (incl. createRequire) but NOT dynamic
// import(). Loader promises are memoized (concurrent-import vitest race).
const nodeRequire = createRequire(__filename);
let _gitModulePromise = null;
let _httpModulePromise = null;
let _gitService = null;

function loadGitModule() {
  if (!_gitModulePromise) {
    _gitModulePromise = Promise.resolve().then(() => nodeRequire('isomorphic-git'));
  }
  return _gitModulePromise;
}

function loadHttpModule() {
  if (!_httpModulePromise) {
    _httpModulePromise = Promise.resolve().then(() => nodeRequire('isomorphic-git/http/node'));
  }
  return _httpModulePromise;
}

function getGitService() {
  if (!_gitService) {
    _gitService = new GitService({
      provider: createGitProvider({
        loadGit: loadGitModule,
        loadHttp: loadHttpModule,
      }),
    });
  }
  return _gitService;
}

// iso-git's parallel-mkdir race surfaces as ENOENT/mkdir. Across the
// provider boundary the error is a GitError carrying the original as
// `cause` (code is copied, syscall is not) — check both layers.
function _isMkdirRace(error) {
  const candidates = [error, error && error.cause];
  return candidates.some((e) => e && e.code === 'ENOENT' && e.syscall === 'mkdir');
}

/**
 * Project Creation Handler Class
 */
class ProjectCreationHandler {
  /**
   * Create an instance of ProjectCreationHandler
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.databaseManager - Database manager instance
   * @param {Object} dependencies.nodeDetectionService - Node.js detection service
   */
  constructor({ logger, databaseManager, nodeDetectionService }) {
    this.logger = logger;
    this.databaseManager = databaseManager;
    this.nodeDetectionService = nodeDetectionService;
    this.gitOps = new GitOperations({ logger, databaseManager });
    this.processManager = new ProcessManager({ logger, nodeDetectionService });
  }

  /**
   * Check if directory has partial .git (config without HEAD)
   * @param {string} dir - Directory to check
   * @returns {Promise<boolean>} Whether directory has partial .git
   */
  async hasPartialGit(dir) {
    try {
      const gitDir = path.join(dir, '.git');
      let gitDirExists = false;
      try { await fsPromises.access(gitDir); gitDirExists = true; } catch { gitDirExists = false; }
      if (!gitDirExists) {
        return false;
      }

      // Check for essential git files
      const headPath = path.join(gitDir, 'HEAD');
      const configPath = path.join(gitDir, 'config');
      
      let hasConfig = false;
      let hasHead = false;
      try { await fsPromises.access(configPath); hasConfig = true; } catch { hasConfig = false; }
      try { await fsPromises.access(headPath); hasHead = true; } catch { hasHead = false; }
      
      // If config exists but no HEAD, it's likely a partial git setup
      return hasConfig && !hasHead;
    } catch (error) {
      this.logger.warn('Error checking for partial git:', error);
      return false;
    }
  }

  /**
   * Clean partial .git directory
   * @param {string} dir - Directory to clean
   * @returns {Promise<void>}
   */
  async cleanPartialGit(dir) {
    try {
      const gitDir = path.join(dir, '.git');
      let gitDirExists = false;
      try { await fsPromises.access(gitDir); gitDirExists = true; } catch { gitDirExists = false; }
      if (gitDirExists) {
        this.logger.info(`🧹 Cleaning partial .git directory: ${gitDir}`);
        
        // Simple recursive removal using fs.promises.rm
        try {
          await fsPromises.rm(gitDir, { recursive: true, force: true });
        } catch (execError) {
          // Fallback to manual recursive removal
          const removeRecursive = async (dirPath) => {
            let dirExists = false;
            try { await fsPromises.access(dirPath); dirExists = true; } catch { dirExists = false; }
            if (dirExists) {
              const files = await fsPromises.readdir(dirPath);
              for (const file of files) {
                const curPath = path.join(dirPath, file);
                const stat = await fsPromises.lstat(curPath);
                if (stat.isDirectory()) {
                  await removeRecursive(curPath);
                } else {
                  await fsPromises.unlink(curPath);
                }
              }
              await fsPromises.rmdir(dirPath);
            }
          };
          await removeRecursive(gitDir);
        }
        
        this.logger.info('✅ Partial .git directory cleaned');
      }
    } catch (error) {
      this.logger.error('Error cleaning partial git:', error);
      throw error;
    }
  }

  /**
   * Mask a token for safe logging.
   * @param {string} [token] - The token to mask.
   * @returns {string} Masked representation (e.g. "ghp_…AB12" or "<none>").
   * @private
   */
  _maskToken(token) {
    if (!token) return '<none>';
    if (token.length <= 8) return '***';
    return `${token.slice(0, 4)}…${token.slice(-4)}`;
  }

  /**
   * Probe the remote git smart-HTTP protocol for refs.
   *
   * Returns the discovered refs (branches/tags) and HEAD symref, or `null`
   * if the remote reports zero refs (which is what happens right after a
   * template/fork creation while GitHub is still populating git objects).
   *
   * @param {Object} git - isomorphic-git module.
   * @param {Object} http - isomorphic-git http/node client.
   * @param {string} url - Remote URL.
   * @param {Object} [auth] - Auth object ({ token }) or undefined.
   * @returns {Promise<{ head?: string, branches: string[] }|null>}
   * @private
   */
  async _probeRemoteRefs(git, http, url, auth) {
    try {
      const info = await git.getRemoteInfo({
        http,
        url,
        auth,
      });
      const heads = (info && info.refs && info.refs.heads) || {};
      const branches = Object.keys(heads);
      if (branches.length === 0) {
        return null;
      }
      
      // Determine head source and validate
      let head = info.HEAD;
      let headSource = null;
      
      // Check if HEAD is a 40-character SHA (commit hash) - reject it
      if (head && /^[0-9a-f]{40}$/i.test(head)) {
        this.logger?.warn?.('_probeRemoteRefs: HEAD is a SHA, rejecting:', head);
        head = null;
        headSource = 'sha-rejected';
      }
      
      // Use HEAD if it's a valid branch name
      if (head) {
        headSource = 'top';
      } else {
        // Fall back to first branch when HEAD is missing or SHA
        head = branches[0];
        headSource = 'first-branch';
        this.logger?.info?.('_probeRemoteRefs: HEAD missing/SHA, using first branch:', head);
      }
      
      return { head, headSource, branches };
    } catch (error) {
      this.logger?.warn?.('_probeRemoteRefs failed:', error?.message);
      return null;
    }
  }

  /**
   * Clone repository.
   *
   * Robust against the "empty clone" race: when a template/fork has just been
   * created, GitHub's REST API reports `size > 0` before the git smart-HTTP
   * `/info/refs` endpoint actually serves any refs. `isomorphic-git` then
   * silently completes a clone with zero branches and an empty working tree.
   *
   * To avoid this, we probe `/info/refs` (via `getRemoteInfo`) and retry for
   * up to ~30s until the remote exposes at least one branch. We then pass the
   * discovered default branch as an explicit `ref` to `git.clone`.
   *
   * @param {string} url - Repository URL.
   * @param {string} dir - Directory to clone into.
   * @param {Function} sendOutput - Output function.
   * @returns {Promise<boolean>} Resolves true on success.
   * @throws {Error} When the clone fails or yields an empty working tree.
   */
  async gitClone(url, dir, sendOutput) {
    const git = await loadGitModule();
    const http = await loadHttpModule();
    const nodeFs = require('fs');

    try {
      // ── Diagnostic: pre-clone state ─────────────────────────────────────
      let dirExistsBefore = false;
      try { await fsPromises.access(dir); dirExistsBefore = true; } catch { dirExistsBefore = false; }
      let dirContentsBefore = [];
      if (dirExistsBefore) {
        dirContentsBefore = await fsPromises.readdir(dir);
      }
      this.logger.info(`Cloning repository from ${url} to ${dir}`);
      this.logger.info(`[clone-diag] dir exists=${dirExistsBefore}, contents=${JSON.stringify(dirContentsBefore)}`);

      // Check for and clean partial .git before cloning
      if (await this.hasPartialGit(dir)) {
        sendOutput('🧹 Found partial git setup, cleaning before clone...\n');
        await this.cleanPartialGit(dir);
      }

      // ── Pre-clone cleanup: remove residual working-tree files ───────────
      // A previous failed clone attempt may have left stale files in the
      // target directory. Remove everything except .git so the clone starts
      // from a clean state.
      if (dirExistsBefore && dirContentsBefore.length > 0) {
        const residualFiles = dirContentsBefore.filter((entry) => entry !== '.git');
        if (residualFiles.length > 0) {
          this.logger.info(`🧹 Cleaning residual files before clone: ${JSON.stringify(residualFiles)}`);
          const { execa } = require('execa');
          const isWindows = process.platform === 'win32';
          for (const file of residualFiles) {
            const targetPath = path.join(dir, file);
            try {
              const rmCommand = isWindows ? 'rmdir' : 'rm';
              const rmArgs = isWindows ? ['/s', '/q', targetPath] : ['-rf', targetPath];
              await execa(rmCommand, rmArgs, { stdio: 'ignore', killDescendants: true });
            } catch (execError) {
              try {
                const stat = await fsPromises.lstat(targetPath);
                if (stat.isDirectory()) {
                  const removeRecursive = async (dirPath) => {
                    let dirExists = false;
                    try { await fsPromises.access(dirPath); dirExists = true; } catch { dirExists = false; }
                    if (dirExists) {
                      const entries = await fsPromises.readdir(dirPath);
                      for (const entry of entries) {
                        const curPath = path.join(dirPath, entry);
                        const curStat = await fsPromises.lstat(curPath);
                        if (curStat.isDirectory()) {
                          await removeRecursive(curPath);
                        } else {
                          await fsPromises.unlink(curPath);
                        }
                      }
                      await fsPromises.rmdir(dirPath);
                    }
                  };
                  await removeRecursive(targetPath);
                } else {
                  await fsPromises.unlink(targetPath);
                }
              } catch (fallbackError) {
                this.logger.warn(`Could not remove residual file ${targetPath}:`, fallbackError?.message);
              }
            }
          }
          this.logger.info('✅ Residual files cleaned');
        }
      }

      const isGithubUrl = /^https:\/\/github\.com\//i.test(url);
      const token = isGithubUrl ? await this.gitOps.getGitHubToken() : null;
      const auth = token ? { token } : undefined;
      if (!isGithubUrl) {
        this.logger.warn('Clone URL is not a GitHub URL — proceeding without token auth');
        sendOutput(await t('create.non_github_warning') + '\n');
      }

      this.logger.info(`[clone-diag] url=${url} token=${this._maskToken(token)} auth=${auth ? 'present' : 'none'}`);

      // ── Probe remote refs (guards against empty-clone race) ─────────────
      // The REST API may report size > 0 while git-upload-pack still serves
      // zero refs. Poll /info/refs until at least one branch appears.
      let remoteInfo = await this._probeRemoteRefs(git, http, url, auth);
      let attempt = 0;
      const probeIntervalMs = 2000;
      const probeTimeoutMs = 30000;
      const probeStartedAt = Date.now();
      while (!remoteInfo) {
        attempt += 1;
        const elapsed = Date.now() - probeStartedAt;
        if (elapsed >= probeTimeoutMs) {
          this.logger.warn(`[clone-diag] remote exposed 0 refs after ${attempt} probes (${elapsed}ms) — cloning anyway`);
          sendOutput(`⚠️ Remote ainda sem branches após ${probeTimeoutMs / 1000}s; tentando clone mesmo assim...\n`);
          break;
        }
        sendOutput(`⏳ Aguardando git objects ficarem disponíveis... (tentativa ${attempt})\n`);
        this.logger.info(`[clone-diag] remote exposed 0 refs (attempt ${attempt}); retrying in ${probeIntervalMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, probeIntervalMs));
        remoteInfo = await this._probeRemoteRefs(git, http, url, auth);
      }

      const ref = remoteInfo && remoteInfo.head ? remoteInfo.head : undefined;
      this.logger.info(`[clone-diag] remote refs: head=${ref || '<unknown>'}, source=${remoteInfo?.headSource || '<none>'}, branches=${remoteInfo ? JSON.stringify(remoteInfo.branches) : '[]'}`);
      if (ref) {
        sendOutput(`🌿 Branch padrão do remote: ${ref}\n`);
      }

      const expectedBranch = ref ? ref.replace(/^refs\/heads\//, '') : null;

      // ── Clone + branch verification (with retry on mismatch) ────────────
      // After createUsingTemplate, git protocol may return a stale HEAD symref
      // (e.g. "master" when the repo actually has "main"). Verify the cloned
      // branch matches what we expect. If not, clean up and retry.
      const cloneOpts = {
        auth,
        singleBranch: true,
        depth: 10,
      };
      if (ref) {
        cloneOpts.ref = ref;
      }

      let cloneAttempt = 0;
      const maxCloneAttempts = 3;

      while (cloneAttempt < maxCloneAttempts) {
        cloneAttempt += 1;

        if (cloneAttempt > 1) {
          sendOutput(`🔄 Tentativa ${cloneAttempt} de clone (branch incorreto)...\n`);
          const { execa } = require('execa');
          const isWindows = process.platform === 'win32';
          let dirExists = false;
          try { await fsPromises.access(dir); dirExists = true; } catch { dirExists = false; }
          if (dirExists) {
            try {
              const rmCommand = isWindows ? 'rmdir' : 'rm';
              const rmArgs = isWindows ? ['/s', '/q', dir] : ['-rf', dir];
              await execa(rmCommand, rmArgs, { stdio: 'ignore', killDescendants: true });
            } catch (rmErr) {
              this.logger.warn('[clone-diag] rm failed on retry, falling back to manual:', rmErr?.message);
            }
          }
          try {
            await fsPromises.mkdir(dir, { recursive: true });
          } catch (mkdirErr) {
            this.logger.warn('[clone-diag] mkdir failed on retry:', mkdirErr?.message);
          }
        }

        // ── Clone ───────────────────────────────────────────────────────────
        // isomorphic-git v1.38.4 races on parallel mkdir for nested dirs like
        // `.github/workflows/` (index.cjs:7009-7023). The fast path stays as-is;
        // on ENOENT/mkdir we fall back to a noCheckout clone + safe checkout.
        const cloneOptsNoCheckout = { ...cloneOpts, noCheckout: true };
        try {
          await getGitService().clone(url, dir, cloneOpts);
        } catch (cloneErr) {
          if (!_isMkdirRace(cloneErr)) {
            throw cloneErr;
          }
          this.logger.info(
            '[clone-diag] race condition in parallel mkdir — retrying with noCheckout + safe checkout',
            cloneErr
          );
          sendOutput('🔧 Corrigindo race condition em diretórios aninhados (noCheckout)...\n');

          // Clean partial clone (rm -rf dir, mkdir recursive)
          const { execa: execaRetry } = require('execa');
          const isWindowsRetry = process.platform === 'win32';
          try {
            const rmCommand = isWindowsRetry ? 'rmdir' : 'rm';
            const rmArgs = isWindowsRetry ? ['/s', '/q', dir] : ['-rf', dir];
            await execaRetry(rmCommand, rmArgs, { stdio: 'ignore', killDescendants: true });
          } catch (rmErr) {
            this.logger.warn('[clone-diag] rm failed before noCheckout retry:', rmErr?.message);
          }
          await fsPromises.mkdir(dir, { recursive: true });

          // Clone without checkout, then checkout safely
          await getGitService().clone(url, dir, cloneOptsNoCheckout);

          let checkoutRef;
          try {
            checkoutRef = await getGitService().currentBranch(dir);
          } catch (cbErr) {
            checkoutRef = ref ? ref.replace(/^refs\/heads\//, '') : 'main';
            this.logger.warn('[clone-diag] currentBranch failed, using fallback:', cbErr?.message, '→', checkoutRef);
          }

          try {
            await getGitService().checkout(dir, checkoutRef, { force: true });
          } catch (checkoutErr) {
            if (!_isMkdirRace(checkoutErr)) {
              throw checkoutErr;
            }
            this.logger.info('[clone-diag] checkout also raced on mkdir — pre-creating tree dirs');
            await this._preCreateTreeDirs(git, nodeFs, dir, checkoutRef);
            await getGitService().checkout(dir, checkoutRef, { force: true });
          }
        }

        // ── Diagnostic: post-clone state ────────────────────────────────────
        let gitDirExists = false;
        try { await fsPromises.access(path.join(dir, '.git')); gitDirExists = true; } catch { gitDirExists = false; }
        let postDirContents = [];
        try {
          const entries = await fsPromises.readdir(dir);
          postDirContents = entries.filter((entry) => entry !== '.git');
        } catch (readErr) {
          this.logger.warn('[clone-diag] could not readdir post-clone:', readErr?.message);
        }
        let localBranches = [];
        let remoteBranches = [];
        try {
          localBranches = await getGitService().listBranches(dir);
          remoteBranches = await getGitService().listBranches(dir, { remote: 'origin' });
        } catch (branchErr) {
          this.logger.warn('[clone-diag] listBranches failed:', branchErr?.message);
        }
        let hasPackageJson = false;
        try { await fsPromises.access(path.join(dir, 'package.json')); hasPackageJson = true; } catch { hasPackageJson = false; }

        this.logger.info(
          `[clone-diag] post-clone: attempt=${cloneAttempt} .git=${gitDirExists} files=${postDirContents.length} ` +
          `localBranches=${JSON.stringify(localBranches)} remoteBranches=${JSON.stringify(remoteBranches)} ` +
          `package.json=${hasPackageJson}`
        );

        // ── Empty clone detection ─────────────────────────────────────────
        if (!gitDirExists || (postDirContents.length === 0 && localBranches.length === 0)) {
          const detail = `gitDir=${gitDirExists} files=${postDirContents.length} branches=${localBranches.length}`;
          this.logger.error(`[clone-diag] empty clone detected (${detail})`);
          throw new Error(`Clone concluído mas o diretório está vazio (${detail}). O repositório pode ainda não estar totalmente propagado no GitHub.`);
        }

        // ── Branch match verification ─────────────────────────────────────
        if (expectedBranch && localBranches.length > 0 && !localBranches.includes(expectedBranch)) {
          this.logger.warn(
            `[clone-diag] branch mismatch: expected '${expectedBranch}' but got '${localBranches.join(', ')}' ` +
            `(attempt ${cloneAttempt})`
          );
          if (cloneAttempt < maxCloneAttempts) {
            sendOutput(`⚠️ Branch incorreto (esperado: ${expectedBranch}, obtido: ${localBranches.join(', ')}). Tentando novamente...\n`);
            continue;
          }
          throw new Error(
            `Clone falhou após ${maxCloneAttempts} tentativas: branch esperado '${expectedBranch}' mas obteve '${localBranches.join(', ')}'`
          );
        }

        this.logger.info(`Repository cloned successfully to ${dir}`);
        return true;
      }
    } catch (error) {
      this.logger.error(`Error cloning repository:`, error);
      throw error;
    }
  }

  /**
   * Pre-create every directory referenced in a commit's tree so that
   * isomorphic-git's non-recursive checkout cannot race on missing parents
   * (e.g. `.github/workflows/`). Best-effort: errors are logged, not thrown.
   *
   * @param {object} git - isomorphic-git module.
   * @param {object} fs - Node fs module (the same one passed to git.clone).
   * @param {string} dir - Working tree root.
   * @param {string} ref - Ref name to materialize (branch / tag / HEAD).
   * @returns {Promise<void>}
   */
  async _preCreateTreeDirs(git, fs, dir, ref) {
    try {
      const oid = await git.resolveRef({ fs, dir, ref });
      const commit = await git.readCommit({ fs, dir, oid });
      const treeOid = commit.commit.tree;
      await this._walkAndMkdir(git, fs, dir, treeOid, '');
    } catch (err) {
      this.logger.warn('[clone-diag] _preCreateTreeDirs best-effort failed:', err?.message);
    }
  }

  /**
   * Recursive helper for `_preCreateTreeDirs`. Reads a tree, mkdir -p every
   * subtree entry, then recurses into each subtree using `filepath` so that
   * nested trees resolve against the right path.
   *
   * @param {object} git - isomorphic-git module.
   * @param {object} fs - Node fs module.
   * @param {string} dir - Working tree root.
   * @param {string} treeOid - OID of the tree to walk.
   * @param {string} prefix - Path prefix (relative to dir) for nested walks.
   * @returns {Promise<void>}
   */
  async _walkAndMkdir(git, fs, dir, treeOid, prefix) {
    const { readTree } = git;
    const tree = await readTree({ fs, dir, oid: treeOid, ...(prefix ? { filepath: prefix } : {}) });
    for (const entry of tree.tree) {
      if (entry.type === 'tree') {
        const subdir = prefix ? path.join(prefix, entry.path) : entry.path;
        await fs.promises.mkdir(path.join(dir, subdir), { recursive: true });
        await this._walkAndMkdir(git, fs, dir, entry.oid, subdir);
      }
    }
  }

   /**
    * Update repo folder name in database
    * @param {number} projectId - Project ID
    * @param {string} folderName - Folder name
    * @returns {Promise<void>}
    */
  async updateRepoFolderName(projectId, folderName) {
    try {
      const db = await this.databaseManager.getDatabase();
      
      return new Promise((resolve, reject) => {
        const self = this; // Preserve reference to class
        db.run(`UPDATE projects SET repoFolderName = ? WHERE id = ?`, [folderName, projectId], function (err) {
          if (err) {
            self.logger.error('Error updating repoFolderName:', err.message);
            reject(err.message);
          } else {
            self.logger.info(`repoFolderName updated for project ${projectId}`);
            resolve();
          }
        });
      });
    } catch (error) {
      this.logger.error('Error in updateRepoFolderName:', error);
      throw error;
    }
  }

  /**
   * Retrieve repository folder name from database
   * @param {number} projectId - Project ID
   * @returns {Promise<string|null>} Folder name or null if not stored
   */
  async getRepoFolderName(projectId) {
    try {
      const db = await this.databaseManager.getDatabase();
      return new Promise((resolve, reject) => {
        db.get('SELECT repoFolderName FROM projects WHERE id = ?', [projectId], (err, row) => {
          if (err) {
            this.logger.error('Error fetching repoFolderName:', err.message);
            reject(err);
          } else {
            resolve(row ? row.repoFolderName : null);
          }
        });
      });
    } catch (error) {
      this.logger.error('Error in getRepoFolderName:', error);
      throw error;
    }
  }

  /**
   * Determine repository directory information before running commands
   * @param {string} projectPath - Base project path
   * @param {string} repoUrl - Repository URL
   * @param {boolean} isExistingGitRepo - Whether using an existing repo
   * @param {boolean} isEmptyFolder - Whether cloning into an empty folder
   * @param {string} [projectName] - User-provided project name (slugified for folder)
   * @returns {{ repoDirPath: string, repoFolderName: string, shouldClone: boolean }}
   */
  async determineRepositoryTarget(projectPath, repoUrl, isExistingGitRepo, isEmptyFolder, projectName = '') {
    const ensureDirectory = async (targetPath) => {
      let exists = false;
      try { await fsPromises.access(targetPath); exists = true; } catch { exists = false; }
      if (!exists) {
        await fsPromises.mkdir(targetPath, { recursive: true });
      }
    };

    let projectPathExists = false;
    try { await fsPromises.access(projectPath); projectPathExists = true; } catch { projectPathExists = false; }
    if (!projectPathExists) {
      await ensureDirectory(projectPath);
    }

    if (isExistingGitRepo) {
      return {
        repoDirPath: projectPath,
        repoFolderName: path.basename(projectPath),
        shouldClone: false
      };
    }

    if (isEmptyFolder) {
      return {
        repoDirPath: projectPath,
        repoFolderName: path.basename(projectPath),
        shouldClone: true
      };
    }

    const fallbackName = 'documental-project';
    const repoName = repoUrl ? repoUrl.split('/').pop().replace('.git', '') : fallbackName;
    const slug = projectName
      ? projectName.toString().trim()
          .replace(/\s+/g, '-')
          .replace(/[^\w\-]+/g, '')
          .replace(/\-\-+/g, '-')
          .replace(/^-+/, '')
          .replace(/-+$/, '')
      : '';
    const baseName = slug || repoName || fallbackName;
    let finalRepoFolderName = baseName;
    let counter = 0;
    let repoPathExists = true;
    try { await fsPromises.access(path.join(projectPath, finalRepoFolderName)); repoPathExists = true; } catch { repoPathExists = false; }
    while (repoPathExists) {
      counter += 1;
      finalRepoFolderName = `${baseName}-${counter}`;
      try { await fsPromises.access(path.join(projectPath, finalRepoFolderName)); repoPathExists = true; } catch { repoPathExists = false; }
    }

    const repoDirPath = path.join(projectPath, finalRepoFolderName);
    await ensureDirectory(repoDirPath);

    return {
      repoDirPath,
      repoFolderName: finalRepoFolderName,
      shouldClone: true
    };
  }


  /**
   * Start complete project creation process
   * @param {number} projectId - Project ID
   * @param {string} projectPath - Project path
   * @param {string} repoUrl - Repository URL
   * @param {boolean} isExistingGitRepo - Whether it's an existing git repo
   * @param {boolean} isEmptyFolder - Whether it's an empty folder
   * @param {boolean} [useTemplate] - Whether to create from template repo before cloning
   * @param {string} [projectName] - User-provided project name (for folder slug)
   * @param {boolean} [enablePages] - Whether to enable GitHub Pages
   * @param {string} [organization] - Target organization (null = authenticated user)
   * @param {boolean} [isPrivateRepo] - Whether the created repo should be private
   * @returns {Promise<Object>} Result object
   */
    async startProjectCreation(projectId, projectPath, repoUrl, isExistingGitRepo = false, isEmptyFolder = false, useTemplate = false, projectName = '', enablePages = false, organization = null, isPrivateRepo = false) {
    try {
      this.logger.info('Starting complete project creation:', { projectId, projectPath, repoUrl, isExistingGitRepo, isEmptyFolder });
      
      const broadcastToWindows = (channel, payload) => {
        const normalizedPayload = typeof payload === 'object' && payload !== null
          ? payload
          : { message: String(payload) };

        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed()) {
            window.webContents.send(channel, normalizedPayload);
          }
        });
      };

      const sendOutput = (stepOrPayload, maybeMessage) => {
        let payload;
        if (typeof maybeMessage === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { message: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, message: maybeMessage };
        }
        broadcastToWindows('command-output', payload);
      };

      const sendServerOutput = (stepOrPayload, maybeMessage) => {
        let payload;
        if (typeof maybeMessage === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { message: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, message: maybeMessage };
        }
        broadcastToWindows('server-output', payload);
      };

      const sendStatus = (stepOrPayload, maybeStatus) => {
        let payload;
        if (typeof maybeStatus === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { status: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, status: maybeStatus };
        }
        broadcastToWindows('command-status', payload);
      };

      const getStepOutput = (stepId) => (message) => sendOutput(stepId, message);
      const getStepServerOutput = (stepId) => (message) => sendServerOutput(stepId, message);
      const getStepStatusSender = (stepId) => (status) => sendStatus(stepId, status);

      if (useTemplate) {
        const step0Output = getStepOutput(0);
        const step0Status = getStepStatusSender(0);

        step0Output(await t('create.template_starting') + '\n');
        step0Status('active');

        // Read template owner/repo from config (no longer parsed from URL)
        const { GITHUB_CONFIG } = require('../config/github-config.js');
        const templateOwner = GITHUB_CONFIG.TEMPLATE_REPO.owner;
        const templateRepo = GITHUB_CONFIG.TEMPLATE_REPO.repo;

        // Generate slug from project name (same rule as fork + NFD accent strip)
        const templateSlug = projectName
          ? projectName.toString().trim()
              .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accents
              .replace(/\s+/g, '-')
              .replace(/[^\w\-]+/g, '')
              .replace(/\-\-+/g, '-')
              .replace(/^-+/, '')
              .replace(/-+$/, '')
          : null;

        if (!templateSlug) {
          step0Output('Invalid project name for template\n');
          step0Status('failure');
          throw new Error('Invalid project name for template creation: ' + projectName);
        }

        try {
          const { githubForkService } = require('../services/githubForkService.js');
          const result = await githubForkService.createFromTemplate(
            templateOwner,
            templateRepo,
            templateSlug,
            step0Output,
            {
              owner: organization || undefined,
              private: isPrivateRepo || false,
              description: 'Documental: ' + projectName
            }
          );
          if (result.success) {
            repoUrl = result.cloneUrl;

            // Wait for git objects to be available — template creation returns
            // 201 synchronously but the git smart HTTP protocol can lag by a
            // few seconds; cloning immediately yields an empty repo.
            step0Output('⏳ Aguardando repositório ficar pronto para clone...\n');
            try {
              const readinessMatch = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
              if (readinessMatch) {
                const [, readyOwner, readyRepo] = readinessMatch;
                await githubForkService.waitForRepoReadiness(readyOwner, readyRepo, step0Output);
              }
            } catch (readyError) {
              step0Output(`⚠️ ${readyError.message}\n`);
              // Continue anyway — clone may still succeed.
            }

            // NEW: git protocol readiness probe — guards against empty-clone race
            // after template creation. REST API may report ready while git smart-HTTP
            // /info/refs still serves zero refs. Probe up to 3 times (3s intervals).
            const git = await loadGitModule();
            const http = await loadHttpModule();
            const isGithubUrl = /^https:\/\/github\.com\//i.test(repoUrl);
            const token = isGithubUrl ? await this.gitOps.getGitHubToken() : null;
            const auth = token ? { token } : undefined;
            let probeSuccess = false;
            for (let i = 0; i < 3; i++) {
              const refs = await this._probeRemoteRefs(git, http, repoUrl, auth);
              if (refs) {
                this.logger?.info?.('[readiness-probe] attempt', i + 1, ': refs found:', refs);
                step0Output('✅ Git objects confirmados via protocolo git\n');
                probeSuccess = true;
                break;
              }
              this.logger?.info?.('[readiness-probe] attempt', i + 1, ': no refs yet, retrying in 3s');
              await new Promise((r) => setTimeout(r, 3000));
            }
            if (!probeSuccess) {
              this.logger?.warn?.('[readiness-probe] git protocol still empty after 3 attempts, proceeding anyway');
              step0Output('⚠️ Protocolo git ainda sem refs; clone tentará por até 30s\n');
            }
            // END NEW

            step0Output(await t('create.template_ready') + '\n');
            step0Status('success');
          }
        } catch (error) {
          step0Output(await t('create.template_error', { error: error.message }) + '\n');
          step0Status('failure');
          throw error;
        }
      }

      // GitHub Pages step (stepId 6) — after fork, before clone
      if (enablePages) {
        const step6Output = getStepOutput(6);
        const step6Status = getStepStatusSender(6);

        const pagesMatch = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/i);
        if (pagesMatch) {
          step6Output(await t('create.pages_starting') + '\n');
          step6Status('active');

          const [, pagesOwner, pagesRepo] = pagesMatch;
          const { githubForkService } = require('../services/githubForkService.js');
          const pagesResult = await githubForkService.enableGitHubPages(pagesOwner, pagesRepo);
          if (pagesResult.success) {
            step6Output(await t('create.pages_success') + '\n');

            try {
              const envResult = await githubForkService.configurePagesEnvironment(pagesOwner, pagesRepo);
              if (envResult && envResult.warning) {
                step6Output(`⚠️ ${envResult.warning}\n`);
              } else if (envResult && envResult.error) {
                step6Output(`⚠️ ${envResult.error}\n`);
              } else if (envResult && envResult.success) {
                step6Output('Environment github-pages + preview configurado\n');
              }
            } catch (envError) {
              step6Output(`⚠️ ${envError.message}\n`);
            }
          } else {
            step6Output(await t('create.pages_error', { error: pagesResult.error || 'Unknown' }) + '\n');
          }
          step6Status('success');
        } else {
          this.logger?.info?.('Skipping GitHub Pages: URL is not github.com');
        }
      }

      const { repoDirPath, repoFolderName, shouldClone } = await this.determineRepositoryTarget(
        projectPath,
        repoUrl,
        isExistingGitRepo,
        isEmptyFolder,
        projectName
      );

      const step1Output = getStepOutput(1);
      const step2Output = getStepOutput(2);
      const step3Output = getStepOutput(3);
      const step4Output = getStepOutput(4);
      const step5ServerOutput = getStepServerOutput(5);
      const step1Status = getStepStatusSender(1);
      const step2Status = getStepStatusSender(2);
      const step3Status = getStepStatusSender(3);
      const step4Status = getStepStatusSender(4);
      const step5Status = getStepStatusSender(5);

      if (repoFolderName) {
        await this.updateRepoFolderName(projectId, repoFolderName);
      }

      if (isExistingGitRepo) {
        step1Output(`📁 Using existing repository at ${repoDirPath}\n`);
        
        // Configure git user for existing repos
        step1Output('🔧 Configuring git user for existing repository...\n');
        try {
          const configured = await this.gitOps.configureGitForUser(repoDirPath);
          if (configured) {
            step1Output('✅ Git user configured successfully.\n');
          } else {
            step1Output('⚠️ Could not configure git user, using default configuration.\n');
            step1Output('💡 This may happen if:\n');
            step1Output('   • No GitHub authentication is set up\n');
            step1Output('   • No internet connection is available\n');
            step1Output('   • GitHub API is temporarily unavailable\n');
          }
        } catch (error) {
          step1Output(`⚠️ Warning: Could not configure git user: ${error.message}\n`);
          step1Output('💡 Git operations will use system default configuration\n');
        }
        
        step1Status('success');
        await this.processManager.delay(3000);
      } else {
        // For new repos: clone first, then configure git user
        const cloneMessage = isEmptyFolder
          ? '📥 Cloning repository directly into selected folder...\n'
          : '📥 Cloning repository...\n';
        step1Output(cloneMessage);

        if (shouldClone) {
          try {
            await this.gitClone(repoUrl, repoDirPath, step1Output);
            step1Output(`✅ Repository cloned into ${repoDirPath}\n`);
            
            // Now configure git user in the cloned repository
            step1Output('🔧 Configuring git user for cloned repository...\n');
            try {
              const configured = await this.gitOps.configureGitForUser(repoDirPath);
              if (configured) {
                step1Output('✅ Git user configured successfully.\n');
              } else {
                step1Output('⚠️ Could not configure git user, using default configuration.\n');
                step1Output('💡 This may happen if:\n');
                step1Output('   • No GitHub authentication is set up\n');
                step1Output('   • No internet connection is available\n');
                step1Output('   • GitHub API is temporarily unavailable\n');
              }
            } catch (error) {
              step1Output(`⚠️ Warning: Could not configure git user: ${error.message}\n`);
              step1Output('💡 Git operations will use system default configuration\n');
            }
            
            step1Status('success');
          } catch (error) {
            step1Output(`❌ Error cloning repository: ${error.message}\n`);
            throw error;
          }
        } else {
          step1Status('success');
        }

        await this.processManager.delay(3000);
      }


      // Step 2: ensure preview branch exists and checkout it (skip if existing git repo)
      if (!isExistingGitRepo) {
        step2Output('🔍 Verificando e garantindo branch preview...\n');
        try {
          const previewResult = await this.gitOps.gitEnsurePreviewBranch(repoDirPath, step2Output);
          if (previewResult && previewResult.pushFailed) {
            // Push was attempted but failed. The local preview branch exists,
            // so the project can still open — this is a WARNING, not an error.
            // Status stays 'success' so the renderer advances the flow (a
            // 'failure' status would hide the Finish button and block opening).
            // The warning is surfaced via the step log (output) instead.
            step2Output(`⚠️ Branch preview criada localmente, mas não foi possível publicá-la no repositório remoto.\n`);
            step2Output(`💡 erro: ${previewResult.pushError}\n`);
            step2Output(`💡 Publique manualmente com: git push -u origin preview\n`);
            step2Status('success');
          } else {
            step2Output('✅ Preview branch checked out.\n');
            step2Status('success');
          }
        } catch (error) {
          step2Output(`❌ Error checking out preview branch: ${error.message}\n`);
          // Don't throw error for checkout failure, continue with setup
          step2Status('success');
        }
        await this.processManager.delay(3000);
      } else {
        step2Output('⏭️ Skipping checkout for existing repository.\n');
        step2Status('success');
        await this.processManager.delay(3000);
      }

      // Step 3: npm install
      step3Output('📦 Installing dependencies...\n');
      try {
        await this.processManager.executeCommand('npm', ['install'], repoDirPath, projectId, step3Output);
        step3Output('✅ Dependencies installed.\n');
        step3Status('success');
      } catch (error) {
        step3Output(`❌ Error installing dependencies: ${error.message}\n`);
        throw error;
      }
      await this.processManager.delay(3000);

      // Step 4: npm run build
      step4Output('🔨 Building project...\n');
      try {
        await this.processManager.executeCommand('npm', ['run', 'build'], repoDirPath, `build-${projectId}`, step4Output);
        step4Output('✅ Project built.\n');
        step4Status('success');
      } catch (error) {
        step4Output(`❌ Error building project: ${error.message}\n`);
        throw error;
      }
      await this.processManager.delay(3000);

      // Step 5: npm run dev (keep in background)
      step5ServerOutput('🚀 Starting development server...\n');
      try {
        await this.processManager.startDevServer(repoDirPath, projectId, step5ServerOutput, step5Status);
      } catch (error) {
        step5ServerOutput(`❌ Error starting development server: ${error.message}\n`);
        throw error;
      }

      


      return { success: true };
      
    } catch (error) {
      this.logger.error('Error in start-project-creation handler:', error);
      throw error;
    }
  }

  /**
   * Open project with preview branch check and dev server only
   * @param {number} projectId - Project ID
   * @param {string} projectPath - Project path
   * @param {string} repoUrl - Repository URL
   * @param {string} repoFolderName - Repository folder name
   * @returns {Promise<Object>} Result object
   */
  async openProjectOnlyPreviewAndServer(projectId, projectPath, repoUrl, repoFolderName) {
    try {
      this.logger.info('Opening project with preview and server only:', { projectId, projectPath, repoUrl, repoFolderName });
      
      const broadcastToWindows = (channel, payload) => {
        const normalizedPayload = typeof payload === 'object' && payload !== null
          ? payload
          : { message: String(payload) };

        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed()) {
            window.webContents.send(channel, normalizedPayload);
          }
        });
      };

      const sendOutput = (stepOrPayload, maybeMessage) => {
        let payload;
        if (typeof maybeMessage === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { message: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, message: maybeMessage };
        }
        broadcastToWindows('command-output', payload);
      };

      const sendServerOutput = (stepOrPayload, maybeMessage) => {
        let payload;
        if (typeof maybeMessage === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { message: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, message: maybeMessage };
        }
        broadcastToWindows('server-output', payload);
      };

      const sendStatus = (stepOrPayload, maybeStatus) => {
        let payload;
        if (typeof maybeStatus === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { status: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, status: maybeStatus };
        }
        broadcastToWindows('command-status', payload);
      };

      const step2Output = (message) => sendOutput(2, message);
      const step2Status = (status) => sendStatus(2, status);
      const step5ServerOutput = (message) => sendServerOutput(5, message);
      const step5Status = (status) => sendStatus(5, status);

      // For empty folders that were cloned directly, repoFolderName might be folder name itself
      let repoDirPath;
      let repoPathExists = false;
      if (repoFolderName) {
        try { await fsPromises.access(path.join(projectPath, repoFolderName)); repoPathExists = true; } catch { repoPathExists = false; }
      }
      if (repoFolderName && repoPathExists) {
        repoDirPath = path.join(projectPath, repoFolderName);
      } else {
        // Check if projectPath itself is repo (for empty folder case)
        let gitDirExists = false;
        try { await fsPromises.access(path.join(projectPath, '.git')); gitDirExists = true; } catch { gitDirExists = false; }
        if (gitDirExists) {
          repoDirPath = projectPath;
        } else {
          throw new Error('Repository folder not found');
        }
      }

      // Step 2: ensure preview branch exists and checkout it
      step2Output('🔍 Verificando e garantindo branch preview...\n');
      try {
        await this.gitOps.gitEnsurePreviewBranch(repoDirPath, step2Output);
        step2Output('✅ Branch preview verificada.\n');
        step2Status('success');
      } catch (error) {
        step2Output(`❌ Erro ao verificar branch preview: ${error.message}\n`);
        // Don't throw error for checkout failure, continue with setup
        step2Status('success');
      }
      await this.processManager.delay(3000);

      // Step 5: npm run dev (keep in background)
      step5ServerOutput('🚀 Executando servidor do modo dev...\n');
      try {
        await this.processManager.startDevServer(repoDirPath, projectId, step5ServerOutput, step5Status);
      } catch (error) {
        step5ServerOutput(`❌ Erro ao iniciar servidor de desenvolvimento: ${error.message}\n`);
        throw error;
      }

      return { success: true };
      
    } catch (error) {
      this.logger.error('Error in open-project-only-preview-and-server handler:', error);
      throw error;
    }
  }

  /**
   * Reopen existing project
   * @param {number} projectId - Project ID
   * @param {string} projectPath - Project path
   * @param {string} repoUrl - Repository URL
   * @param {string} repoFolderName - Repository folder name
   * @returns {Promise<Object>} Result object
   */
  async reopenProject(projectId, projectPath, repoUrl, repoFolderName) {
    try {
      this.logger.info('Reopening project:', { projectId, projectPath, repoUrl, repoFolderName });
      
      const broadcastToWindows = (channel, payload) => {
        const normalizedPayload = typeof payload === 'object' && payload !== null
          ? payload
          : { message: String(payload) };

        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed()) {
            window.webContents.send(channel, normalizedPayload);
          }
        });
      };

      const sendOutput = (stepOrPayload, maybeMessage) => {
        let payload;
        if (typeof maybeMessage === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { message: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, message: maybeMessage };
        }
        broadcastToWindows('command-output', payload);
      };

      const sendServerOutput = (stepOrPayload, maybeMessage) => {
        let payload;
        if (typeof maybeMessage === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { message: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, message: maybeMessage };
        }
        broadcastToWindows('server-output', payload);
      };

      const sendStatus = (stepOrPayload, maybeStatus) => {
        let payload;
        if (typeof maybeStatus === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { status: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, status: maybeStatus };
        }
        broadcastToWindows('command-status', payload);
      };

      const step4Output = (message) => sendOutput(4, message);
      const step4Status = (status) => sendStatus(4, status);
      const step5ServerOutput = (message) => sendServerOutput(5, message);
      const step5Status = (status) => sendStatus(5, status);

      // For empty folders that were cloned directly, repoFolderName might be folder name itself
      let repoDirPath;
      let repoPathExists = false;
      if (repoFolderName) {
        try { await fsPromises.access(path.join(projectPath, repoFolderName)); repoPathExists = true; } catch { repoPathExists = false; }
      }
      if (repoFolderName && repoPathExists) {
        repoDirPath = path.join(projectPath, repoFolderName);
      } else {
        // Check if projectPath itself is repo (for empty folder case)
        let gitDirExists = false;
        try { await fsPromises.access(path.join(projectPath, '.git')); gitDirExists = true; } catch { gitDirExists = false; }
        if (gitDirExists) {
          repoDirPath = projectPath;
        } else {
          throw new Error('Repository folder not found');
        }
      }

      // Step 4: npm run build
      step4Output('🔨 Building project...\n');
      try {
        await this.processManager.executeCommand('npm', ['run', 'build'], repoDirPath, `reopen-${projectId}`, step4Output);
        step4Output('✅ Project built.\n');
        step4Status('success');
      } catch (error) {
        step4Output(`❌ Error building project: ${error.message}\n`);
        throw error;
      }
      await this.processManager.delay(3000);

      // Step5: npm run dev (keep in background)
      step5ServerOutput('🚀 Starting development server...\n');
      try {
        await this.processManager.startDevServer(repoDirPath, projectId, step5ServerOutput, step5Status);
      } catch (error) {
        step5ServerOutput(`❌ Error starting development server: ${error.message}\n`);
        throw error;
      }

      return { success: true };
      
    } catch (error) {
      this.logger.error('Error in reopen-project handler:', error);
      throw error;
    }
  }

  /**
   * Cancel project creation
   * @param {number} projectId - Project ID
   * @param {string} projectPath - Project path
   * @param {string} repoFolderName - Repository folder name
   * @returns {Promise<void>}
   */
  async cancelProjectCreation(projectId, projectPath, repoFolderName, shouldDeleteFiles = false) {
    try {
      const resolvedFolderName = repoFolderName || await this.getRepoFolderName(projectId);
      this.logger.info('Canceling project creation:', { projectId, projectPath, repoFolderName: resolvedFolderName, shouldDeleteFiles });
      
      const sendOutput = (output) => {
        // Send to all windows for synchronization
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed()) {
            window.webContents.send('command-output', output);
          }
        });
      };

      await this.processManager.cancelProjectCreation(
        projectId,
        projectPath,
        resolvedFolderName,
        shouldDeleteFiles,
        sendOutput
      );
      
    } catch (error) {
      this.logger.error('Error in cancel-project-creation handler:', error);
      throw error;
    }
  }


  /**
   * Get dev server URL from main process
   * @returns {string|null} Dev server URL
   */
  getDevServerUrl() {
    return this.processManager.getGlobalDevServerUrl();
  }

  /**
   * Register all project creation IPC handlers
   */
  registerHandlers() {
    this.logger.info('🚀 Registering project creation IPC handlers');

    /**
     * Start complete project creation
     */
    ipcMain.handle('start-project-creation', async (event, projectId, projectPath, repoUrl, isExistingGitRepo = false, isEmptyFolder = false, useTemplate = false, projectName = '', enablePages = false, organization = null, isPrivateRepo = false) => {
      try {
        return await this.startProjectCreation(projectId, projectPath, repoUrl, isExistingGitRepo, isEmptyFolder, useTemplate, projectName, enablePages, organization, isPrivateRepo);
      } catch (error) {
        this.logger.error('Error in start-project-creation handler:', error);
        throw error;
      }
    });

    /**
     * Check if a repository with the given name already exists for the authenticated user
     */
    ipcMain.handle('check-repo-exists', async (event, repoName) => {
      try {
        const { githubForkService } = require('../services/githubForkService.js');
        return await githubForkService.checkRepoExists(repoName);
      } catch (error) {
        this.logger.error('Error in check-repo-exists handler:', error);
        return { exists: false, error: error.message };
      }
    });

    ipcMain.handle('check-fork-exists', async (event, sourceOwner, sourceRepo, targetOwner) => {
      try {
        const { githubForkService } = require('../services/githubForkService.js');
        return await githubForkService.checkForkExists(sourceOwner, sourceRepo, targetOwner);
      } catch (error) {
        this.logger.error('Error in check-fork-exists handler:', error);
        return { exists: false, error: error.message };
      }
    });

    ipcMain.handle('check-template-target-exists', async (event, targetOwner, repoName) => {
      try {
        const { githubForkService } = require('../services/githubForkService.js');
        return await githubForkService.checkTemplateTargetExists(targetOwner, repoName);
      } catch (error) {
        this.logger.error('Error in check-template-target-exists handler:', error);
        return { exists: false, error: error.message };
      }
    });

    /**
     * Open project with preview branch check and dev server only
     */
    ipcMain.handle('open-project-only-preview-and-server', async (event, projectId, projectPath, repoUrl, repoFolderName) => {
      try {
        return await this.openProjectOnlyPreviewAndServer(projectId, projectPath, repoUrl, repoFolderName);
      } catch (error) {
        this.logger.error('Error in open-project-only-preview-and-server handler:', error);
        throw error;
      }
    });

    /**
     * Reopen existing project
     */
    ipcMain.handle('reopen-project', async (event, projectId, projectPath, repoUrl, repoFolderName) => {
      try {
        return await this.reopenProject(projectId, projectPath, repoUrl, repoFolderName);
      } catch (error) {
        this.logger.error('Error in reopen-project handler:', error);
        throw error;
      }
    });

    /**
     * Cancel project creation
     */
    ipcMain.handle('cancel-project-creation', async (event, projectId, projectPath, repoFolderName, shouldDeleteFiles = false) => {
      try {
        return await this.cancelProjectCreation(projectId, projectPath, repoFolderName, shouldDeleteFiles);
      } catch (error) {
        this.logger.error('Error in cancel-project-creation handler:', error);
        throw error;
      }
    });




    this.logger.info('✅ Project creation IPC handlers registered');
  }

  /**
   * Unregister all project creation IPC handlers
   */
  unregisterHandlers() {
    this.logger.info('🚀 Unregistering project creation IPC handlers');
    
    ipcMain.removeHandler('start-project-creation');
    ipcMain.removeHandler('open-project-only-preview-and-server');
    ipcMain.removeHandler('reopen-project');
    ipcMain.removeHandler('cancel-project-creation');
    ipcMain.removeHandler('check-fork-exists');
    ipcMain.removeHandler('check-repo-exists');
    ipcMain.removeHandler('check-template-target-exists');

    this.logger.info('✅ Project creation IPC handlers unregistered');
  }
}

module.exports = { ProjectCreationHandler };