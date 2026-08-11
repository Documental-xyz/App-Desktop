/**
 * @fileoverview Pre-flight checks for publish-to-preview and publish-to-main flows.
 *
 * Runs all read-only validation BEFORE any git lock is acquired, so the user
 * gets fast feedback (token, permission, branch protection, precedence,
 * workflows) without blocking other concurrent operations. The actual publish
 * steps (fetch/checkout/merge/push) live in GitHandlers and acquire the lock
 * only after preflight returns `canProceed: true`.
 *
 * Design rules:
 *  - NO git lock acquired here (read-only / shallow-fetch only).
 *  - NO ref or working-tree mutation (the shallow `fetch` updates
 *    `refs/remotes/origin/*` which is the standard read-only sync).
 *  - Warnings are informational; only `errors` block.
 *  - Workflows result cached per-projectId for 5 minutes to avoid hammering
 *    the GitHub Content API on every publish click.
 *
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const http = require('isomorphic-git/http/node');
const { BRANCH_PREVIEW, BRANCH_MAIN } = require('./gitFlowTypes.js');

/**
 * Regex to extract owner/repo from a GitHub remote URL. Mirrors the one in
 * permissionHandlers.js so both layers resolve repos identically.
 */
const GITHUB_URL_RE = /github\.com[\/:]([^\/]+)\/([^\/\.]+)(\.git)?$/;

/**
 * How long a workflows lookup stays fresh (ms). 5 minutes balances freshness
 * against API quota — workflows rarely toggle on every publish.
 */
const WORKFLOWS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Substrings that indicate "remote branch does not exist" in an
 * isomorphic-git fetch error message. Matched case-insensitively.
 */
const REMOTE_BRANCH_MISSING_HINTS = ['could not find', 'not found', '404'];

/**
 * @typedef {Object} PreflightCheckEntry
 * @property {string} code - Machine-readable check code
 * @property {string} message - Human-readable (pt-BR) message
 */

/**
 * @typedef {Object} PreflightResult
 * @property {boolean} canProceed - True when `errors` is empty
 * @property {boolean} [firstPublish] - (Preview only) true when remote preview branch doesn't exist yet
 * @property {PreflightCheckEntry[]} checks - Informational check entries (never blocks)
 * @property {PreflightCheckEntry[]} warnings - Soft signals (never blocks)
 * @property {PreflightCheckEntry[]} errors - Hard blocks
 */

/**
 * GitPreflight — runs all pre-flight checks before lock acquisition.
 *
 * Constructor deps:
 *   - `logger`         — { info, warn, error, debug }
 *   - `gitOps`         — GitOperations instance (has `getGitHubToken`, `configureGitForUser`)
 *   - `databaseManager — Database manager (used to resolve owner/repo for workflows check)
 */
class GitPreflight {
  /**
   * @param {Object} deps
   * @param {Object} deps.logger - Logger instance
   * @param {Object} deps.gitOps - GitOperations instance (has getGitHubToken(), configureGitForUser())
   * @param {Object} deps.databaseManager - Database manager instance
   */
  constructor({ logger, gitOps, databaseManager }) {
    this.logger = logger;
    this.gitOps = gitOps;
    this.databaseManager = databaseManager;

    /**
     * Workflows lookup cache.
     * Key: projectId (string)
     * Value: { hasWorkflows: boolean|null, timestamp: number }
     * (`null` = looked up but API failed; we still cache the failure briefly.)
     * @type {Map<string, {hasWorkflows: (boolean|null), timestamp: number}>}
     * @private
     */
    this._workflowsCache = new Map();

    /**
     * isomorphic-git module cache (dynamic import). Lazily populated by `_getGit`.
     * @type {Object|null}
     * @private
     */
    this._gitModuleCache = null;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Run preflight checks for publishing to the `preview` branch.
   *
   * Checks (independent ones parallelized):
   *   1. Token is available (HARD block).
   *   2. `preview` branch exists on remote? If not → `firstPublish: true` (not an error).
   *   3. `.github/workflows/` exists? → warn that Actions will fire.
   *   4. Working tree dirty? → informational check entry (never blocks).
   *
   * @param {number|string} projectId - Project ID (for workflows lookup).
   * @param {string} projectPath - Absolute path to the local repository working tree.
   * @returns {Promise<PreflightResult>} Aggregated preflight result.
   */
  async runPreflightForPreview(projectId, projectPath) {
    /** @type {PreflightCheckEntry[]} */
    const checks = [];
    /** @type {PreflightCheckEntry[]} */
    const warnings = [];
    /** @type {PreflightCheckEntry[]} */
    const errors = [];
    let firstPublish = false;

    // ── Step 1: token (gates everything that needs auth) ────────────────────
    const token = await this._checkToken(errors);
    if (!token) {
      // Without a token, remote fetches / API calls can't proceed — short-circuit.
      return { canProceed: false, firstPublish: false, checks, warnings, errors };
    }

    // ── Steps 2-4 in parallel (each is independent) ─────────────────────────
    const auth = { username: token, password: 'x-oauth-basic' };
    const gitMod = await this._getGit();

    const [branchResult, workflowsResult, dirtyResult] = await Promise.allSettled([
      this._checkBranchExists(projectPath, BRANCH_PREVIEW, auth, gitMod),
      this._checkWorkflows(projectId),
      this._checkDirtyWorkingTree(projectPath, gitMod),
    ]);

    // Branch existence — sets `firstPublish` flag or pushes an error.
    if (branchResult.status === 'fulfilled') {
      if (branchResult.value.missing) {
        // Remote preview doesn't exist → this is the first-publish scenario.
        firstPublish = true;
        checks.push({
          code: 'PREVIEW_REMOTE_MISSING',
          message: 'Branch preview não existe no remoto — será criada nesta publicação',
        });
      } else {
        checks.push({
          code: 'PREVIEW_EXISTS',
          message: 'Branch preview existe no remoto',
        });
      }
    } else {
      // Unexpected fetch error (network / auth / corrupt) → hard block.
      errors.push({
        code: 'FETCH_FAILED',
        message: `Falha ao verificar branch ${BRANCH_PREVIEW}: ${branchResult.reason?.message || branchResult.reason}`,
      });
    }

    // Workflows — informational warning; never blocks.
    if (workflowsResult.status === 'fulfilled') {
      if (workflowsResult.value === true) {
        warnings.push({
          code: 'WORKFLOWS_WILL_FIRE',
          message: '⚡ Actions serão disparadas neste publish',
        });
      } else if (workflowsResult.value === false) {
        checks.push({
          code: 'NO_WORKFLOWS',
          message: 'Nenhuma GitHub Action configurada',
        });
      }
      // null = lookup failed silently → nothing to report.
    }

    // Dirty working tree — informational only.
    if (dirtyResult.status === 'fulfilled' && dirtyResult.value !== null) {
      checks.push(dirtyResult.value);
    }

    return {
      canProceed: errors.length === 0,
      firstPublish,
      checks,
      warnings,
      errors,
    };
  }

  /**
   * Run preflight checks for promoting `preview` → `main`.
   *
   * Checks:
   *   1. Token (HARD block).
   *   2. Permission to push to main (HARD block if denied).
   *   3. Branch protection status (informational warning; never blocks).
   *   4. Precedence: preview must be ahead of main (HARD block if equal).
   *   5. main branch exists on remote (HARD block if missing).
   *   6. Workflows warning.
   *
   * @param {number|string} projectId - Project ID.
   * @param {string} projectPath - Absolute path to the local repository working tree.
   * @param {Object} permissionHandlers - PermissionHandlers instance (has checkMainPermission, checkBranchProtection).
   * @returns {Promise<PreflightResult>} Aggregated preflight result.
   */
  async runPreflightForMain(projectId, projectPath, permissionHandlers) {
    /** @type {PreflightCheckEntry[]} */
    const checks = [];
    /** @type {PreflightCheckEntry[]} */
    const warnings = [];
    /** @type {PreflightCheckEntry[]} */
    const errors = [];

    // ── Step 1: token ───────────────────────────────────────────────────────
    const token = await this._checkToken(errors);
    if (!token) {
      return { canProceed: false, checks, warnings, errors };
    }

    const auth = { username: token, password: 'x-oauth-basic' };
    const gitMod = await this._getGit();

    // ── Steps 2 & 3 in parallel (both use cached permission data) ───────────
    const [permResult, protectionResult] = await Promise.all([
      this._checkMainPermission(projectId, permissionHandlers, errors),
      this._checkBranchProtection(projectId, BRANCH_MAIN, permissionHandlers, warnings, checks),
    ]);

    // Permission is a hard block — short-circuit remaining checks if denied.
    // (We still let protection/warnings accumulate for visibility, but no point
    // fetching refs if the user can't push anyway.)
    if (!permResult) {
      // Best-effort: still run workflows warning in parallel-ish fashion.
      const workflows = await this._checkWorkflows(projectId).catch(() => null);
      if (workflows === true) {
        warnings.push({
          code: 'WORKFLOWS_WILL_FIRE',
          message: '⚡ Actions serão disparadas neste publish',
        });
      }
      return { canProceed: false, checks, warnings, errors };
    }

    // ── Steps 4, 5, 6 in parallel ───────────────────────────────────────────
    const [precedenceResult, mainExistsResult, workflowsResult] = await Promise.allSettled([
      this._checkPrecedence(projectPath, auth, gitMod, warnings),
      this._checkBranchExists(projectPath, BRANCH_MAIN, auth, gitMod),
      this._checkWorkflows(projectId),
    ]);

    // Precedence — may push HARD block error or warning.
    if (precedenceResult.status === 'fulfilled' && precedenceResult.value) {
      const entry = precedenceResult.value;
      if (entry.code === 'PREVIEW_NOT_AHEAD') {
        errors.push(entry);
      } else {
        warnings.push(entry);
      }
    } else if (precedenceResult.status === 'rejected') {
      // Precedence failed unexpectedly (network / resolveRef error).
      // Treat as a hard block — safer than allowing through.
      errors.push({
        code: 'PRECEDENCE_CHECK_FAILED',
        message: `Não foi possível comparar preview com main: ${precedenceResult.reason?.message || precedenceResult.reason}`,
      });
    }

    // Main exists on remote? — hard block if missing.
    if (mainExistsResult.status === 'fulfilled') {
      if (mainExistsResult.value.missing) {
        errors.push({
          code: 'MAIN_MISSING',
          message: 'Repositório mal configurado: branch main não encontrada no remoto',
        });
      } else {
        checks.push({
          code: 'MAIN_EXISTS',
          message: 'Branch main existe no remoto',
        });
      }
    } else {
      errors.push({
        code: 'FETCH_FAILED',
        message: `Falha ao verificar branch ${BRANCH_MAIN}: ${mainExistsResult.reason?.message || mainExistsResult.reason}`,
      });
    }

    // Workflows — informational warning.
    if (workflowsResult.status === 'fulfilled') {
      if (workflowsResult.value === true) {
        warnings.push({
          code: 'WORKFLOWS_WILL_FIRE',
          message: '⚡ Actions serão disparadas neste publish',
        });
      } else if (workflowsResult.value === false) {
        checks.push({
          code: 'NO_WORKFLOWS',
          message: 'Nenhuma GitHub Action configurada',
        });
      }
    }

    return {
      canProceed: errors.length === 0,
      checks,
      warnings,
      errors,
    };
  }

  // ─── Individual checks ────────────────────────────────────────────────────

  /**
   * Token check. Pushes a hard-block error on failure.
   * @param {PreflightCheckEntry[]} errors
   * @returns {Promise<string|null>} The token, or null if missing.
   * @private
   */
  async _checkToken(errors) {
    try {
      const token = await this.gitOps.getGitHubToken();
      if (!token) {
        errors.push({
          code: 'NO_TOKEN',
          message: 'GitHub authentication required',
        });
        return null;
      }
      return token;
    } catch (error) {
      this.logger.error('❌ Preflight token check threw:', error);
      errors.push({
        code: 'NO_TOKEN',
        message: `GitHub authentication required: ${error.message}`,
      });
      return null;
    }
  }

  /**
   * Check whether a remote branch exists via a shallow single-branch fetch.
   *
   * NOTE: this updates `refs/remotes/origin/<branch>` — that is the standard
   * read-only sync semantics and is safe to run before lock acquisition.
   *
   * @param {string} projectPath
   * @param {string} branchName
   * @param {Object} auth - `{ username, password }` for onAuth.
   * @param {Object} [gitModOverride] - Pre-resolved isomorphic-git module.
   * @returns {Promise<{missing: boolean}>} `missing: true` when the branch doesn't exist on remote.
   * @private
   */
  async _checkBranchExists(projectPath, branchName, auth, gitModOverride) {
    const gitMod = gitModOverride || (await this._getGit());
    const fs = require('fs');
    try {
      await gitMod.fetch({
        fs,
        http,
        dir: projectPath,
        remote: 'origin',
        ref: branchName,
        singleBranch: true,
        depth: 1,
        onAuth: () => auth,
      });
      return { missing: false };
    } catch (error) {
      const msg = String(error && error.message || error).toLowerCase();
      const missing = REMOTE_BRANCH_MISSING_HINTS.some((hint) => msg.includes(hint));
      if (missing) {
        return { missing: true };
      }
      // Unexpected error — rethrow so the caller can map it.
      throw error;
    }
  }

  /**
   * Check whether `.github/workflows/` exists in the repo via the GitHub
   * Content API. Cached per-project for WORKFLOWS_CACHE_TTL_MS.
   *
   * Returns:
   *   - `true`  → workflows directory exists (Actions will fire)
   *   - `false` → workflows directory does not exist (404)
   *   - `null`  → API call failed (skip silently, don't block)
   *
   * @param {number|string} projectId
   * @returns {Promise<(boolean|null)>}
   * @private
   */
  async _checkWorkflows(projectId) {
    const key = String(projectId);
    const cached = this._workflowsCache.get(key);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < WORKFLOWS_CACHE_TTL_MS) {
      return cached.hasWorkflows;
    }

    try {
      const { owner, repo } = await this._resolveRepo(projectId);
      if (!owner || !repo) {
        // Can't resolve repo — treat as "unknown", cache briefly to avoid retry storm.
        this._workflowsCache.set(key, { hasWorkflows: null, timestamp: now });
        return null;
      }

      const token = await this.gitOps.getGitHubToken();
      if (!token) {
        this._workflowsCache.set(key, { hasWorkflows: null, timestamp: now });
        return null;
      }

      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: token });

      try {
        await octokit.repos.getContent({ owner, repo, path: '.github/workflows' });
        this._workflowsCache.set(key, { hasWorkflows: true, timestamp: now });
        return true;
      } catch (apiError) {
        if (apiError.status === 404) {
          this._workflowsCache.set(key, { hasWorkflows: false, timestamp: now });
          return false;
        }
        // Any other API error → skip silently (don't block publish).
        this._workflowsCache.set(key, { hasWorkflows: null, timestamp: now });
        this.logger.warn('⚠️ Workflows lookup failed (non-404), skipping:', apiError.message);
        return null;
      }
    } catch (error) {
      // Octokit import / repo resolution blew up → skip silently.
      this._workflowsCache.set(key, { hasWorkflows: null, timestamp: now });
      this.logger.warn('⚠️ Workflows preflight check failed, skipping:', error.message);
      return null;
    }
  }

  /**
   * Check whether the working tree has uncommitted changes. Informational only.
   * @param {string} projectPath
   * @param {Object} [gitModOverride]
   * @returns {Promise<PreflightCheckEntry|null>} An informational check entry, or null on failure.
   * @private
   */
  async _checkDirtyWorkingTree(projectPath, gitModOverride) {
    try {
      const gitMod = gitModOverride || (await this._getGit());
      const fs = require('fs');
      const matrix = await gitMod.statusMatrix({ fs, dir: projectPath });
      // statusMatrix rows: [filepath, HEAD, WORKDIR, STAGE]
      // A clean file has HEAD===WORKDIR===STAGE===1. Count dirty otherwise.
      const dirty = matrix.filter(
        (row) => !(row[1] === 1 && row[2] === 1 && row[3] === 1),
      );
      if (dirty.length === 0) {
        return {
          code: 'WORKDIR_CLEAN',
          message: 'Diretório de trabalho limpo',
        };
      }
      return {
        code: 'WORKDIR_DIRTY',
        message: `Diretório de trabalho com ${dirty.length} arquivo(s) modificado(s) (não bloqueia)`,
      };
    } catch (error) {
      // statusMatrix is best-effort — never fail the preflight over it.
      this.logger.debug('statusMatrix skipped:', error && error.message);
      return null;
    }
  }

  /**
   * Permission check for pushing to main. Hard-blocks via `errors` on denial.
   * @param {number|string} projectId
   * @param {Object} permissionHandlers
   * @param {PreflightCheckEntry[]} errors
   * @returns {Promise<boolean>} true if user can push to main.
   * @private
   */
  async _checkMainPermission(projectId, permissionHandlers, errors) {
    if (!permissionHandlers || typeof permissionHandlers.checkMainPermission !== 'function') {
      // No permission handler available — fail open (don't block) but log.
      this.logger.warn('⚠️ No permissionHandlers provided to preflight; skipping permission check');
      return true;
    }
    try {
      const perm = await permissionHandlers.checkMainPermission(projectId);
      if (!perm || !perm.canPushToMain) {
        errors.push({
          code: 'PERMISSION_DENIED',
          message: 'Sem permissão para publicar em main',
        });
        return false;
      }
      return true;
    } catch (error) {
      // Treat thrown permission check as denial — safer to block.
      this.logger.error('❌ checkMainPermission threw:', error);
      errors.push({
        code: 'PERMISSION_DENIED',
        message: `Sem permissão para publicar em main: ${error.message}`,
      });
      return false;
    }
  }

  /**
   * Branch protection check. Always informational — pushes warnings, never errors.
   * @param {number|string} projectId
   * @param {string} branchName
   * @param {Object} permissionHandlers
   * @param {PreflightCheckEntry[]} warnings
   * @param {PreflightCheckEntry[]} checks
   * @returns {Promise<{isProtected: boolean}>}
   * @private
   */
  async _checkBranchProtection(projectId, branchName, permissionHandlers, warnings, checks) {
    if (!permissionHandlers || typeof permissionHandlers.checkBranchProtection !== 'function') {
      return { isProtected: false };
    }
    try {
      const result = await permissionHandlers.checkBranchProtection(projectId, branchName);
      if (!result || !result.isProtected) {
        checks.push({
          code: 'BRANCH_NOT_PROTECTED',
          message: `Branch ${branchName} não está protegida`,
        });
        return { isProtected: false };
      }
      // Protected — split by whether we know the user can push.
      if (result.canUserPush === false) {
        warnings.push({
          code: 'BRANCH_PROTECTED_NO_PUSH',
          message: `Branch ${branchName} protegida — regras podem bloquear o push`,
        });
      } else if (result.canUserPush === null) {
        warnings.push({
          code: 'BRANCH_PROTECTED_UNKNOWN',
          message: `Branch ${branchName} protegida — não foi possível confirmar se você pode pushar`,
        });
      } else {
        warnings.push({
          code: 'BRANCH_PROTECTED',
          message: `Branch ${branchName} protegida — você tem direito de admin/maintain`,
        });
      }
      return { isProtected: true };
    } catch (error) {
      this.logger.warn('⚠️ checkBranchProtection threw; treating as informational:', error);
      checks.push({
        code: 'BRANCH_PROTECTION_UNKNOWN',
        message: `Não foi possível verificar proteção de ${branchName}`,
      });
      return { isProtected: false };
    }
  }

  /**
   * THE KEY CHECK: preview must be strictly ahead of main.
   *
   * Steps:
   *   a. Fetch both branches shallow in parallel (read-only sync).
   *   b. Resolve `origin/preview` and `origin/main` SHAs.
   *   c. If SHAs are equal → return HARD BLOCK error entry.
   *   d. If local preview ≠ origin/preview → return LOCAL_UNPUSHED warning.
   *   e. Otherwise return null (no signal).
   *
   * @param {string} projectPath
   * @param {Object} auth
   * @param {Object} gitModOverride
   * @param {PreflightCheckEntry[]} _warnings - (unused; warnings returned as entries)
   * @returns {Promise<PreflightCheckEntry|null>}
   * @private
   */
  async _checkPrecedence(projectPath, auth, gitModOverride, _warnings) {
    const gitMod = gitModOverride || (await this._getGit());
    const fs = require('fs');

    // a. Parallel shallow fetch — updates refs/remotes/origin/{main,preview}.
    await Promise.all([
      gitMod.fetch({
        fs,
        http,
        dir: projectPath,
        remote: 'origin',
        ref: BRANCH_MAIN,
        singleBranch: true,
        depth: 1,
        onAuth: () => auth,
      }),
      gitMod.fetch({
        fs,
        http,
        dir: projectPath,
        remote: 'origin',
        ref: BRANCH_PREVIEW,
        singleBranch: true,
        depth: 1,
        onAuth: () => auth,
      }),
    ]);

    // b. Resolve SHAs. If local ref doesn't exist yet (first publish already
    //    handled by preview preflight), resolveRef throws — treat as preview
    //    missing on remote, which means "publish to preview first".
    let previewSha;
    let mainSha;
    try {
      previewSha = await gitMod.resolveRef({
        fs,
        dir: projectPath,
        ref: `origin/${BRANCH_PREVIEW}`,
      });
    } catch (_e) {
      return {
        code: 'PREVIEW_NOT_AHEAD',
        message: 'Publique em preview primeiro — branch preview não encontrada no remoto',
      };
    }
    try {
      mainSha = await gitMod.resolveRef({
        fs,
        dir: projectPath,
        ref: `origin/${BRANCH_MAIN}`,
      });
    } catch (_e) {
      // main missing is reported separately by _checkBranchExists — neutral here.
      return null;
    }

    // c. Hard block: preview hasn't moved past main.
    if (previewSha === mainSha) {
      return {
        code: 'PREVIEW_NOT_AHEAD',
        message: 'Publique em preview primeiro — preview não tem mudanças além de main',
      };
    }

    // d. Warning: local preview diverged from origin/preview (unpushed work).
    try {
      const localPreviewSha = await gitMod.resolveRef({
        fs,
        dir: projectPath,
        ref: BRANCH_PREVIEW,
      });
      if (localPreviewSha !== previewSha) {
        return {
          code: 'LOCAL_UNPUSHED',
          message: 'Você tem trabalho local não publicado em preview',
        };
      }
    } catch (_e) {
      // Local preview ref doesn't exist — not necessarily a problem, skip.
    }

    return null;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Lazily import and cache isomorphic-git. Mirrors GitHandlers._getGit.
   * @returns {Promise<Object>}
   * @private
   */
  async _getGit() {
    if (!this._gitModuleCache) {
      this._gitModuleCache = await import('isomorphic-git');
    }
    return this._gitModuleCache;
  }

  /**
   * Resolve owner/repo for a project by reading the projects table.
   * Mirrors the private resolver in PermissionHandlers (regex duplicated
   * intentionally — see fileoverview).
   * @param {number|string} projectId
   * @returns {Promise<{owner: string|null, repo: string|null}>}
   * @private
   */
  async _resolveRepo(projectId) {
    try {
      if (!this.databaseManager || typeof this.databaseManager.getDatabase !== 'function') {
        return { owner: null, repo: null };
      }
      const db = await this.databaseManager.getDatabase();
      const row = await new Promise((resolve) => {
        let settled = false;
        db.get(
          'SELECT repoUrl, repoFullName FROM projects WHERE id = ?',
          [projectId],
          (err, r) => {
            if (settled) return;
            settled = true;
            if (err) {
              this.logger.error(`Error loading project ${projectId} for preflight:`, err.message);
              resolve(null);
              return;
            }
            resolve(r || null);
          },
        );
      });
      if (!row) {
        return { owner: null, repo: null };
      }
      const remoteUrl = row.repoUrl || row.remoteUrl || null;
      if (remoteUrl) {
        const match = remoteUrl.match(GITHUB_URL_RE);
        if (match) {
          return { owner: match[1], repo: match[2] };
        }
      }
      // Fall back to repoFullName ("owner/repo") if the URL didn't parse.
      if (row.repoFullName && row.repoFullName.includes('/')) {
        const [owner, repo] = row.repoFullName.split('/');
        if (owner && repo) {
          return { owner, repo: repo.replace(/\.git$/, '') };
        }
      }
      return { owner: null, repo: null };
    } catch (error) {
      this.logger.error('❌ Preflight _resolveRepo failed:', error);
      return { owner: null, repo: null };
    }
  }

  /**
   * Invalidate the workflows cache for a project. Call after repo settings
   * change or after a workflows toggle.
   * @param {number|string} projectId
   * @returns {void}
   */
  invalidateWorkflowsCache(projectId) {
    this._workflowsCache.delete(String(projectId));
  }
}

module.exports = { GitPreflight, WORKFLOWS_CACHE_TTL_MS };
