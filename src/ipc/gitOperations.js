/**
 * @fileoverview Git operations for project management
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const fs = require('fs');
const path = require('path');
const { secureTokenService } = require('../services/secureTokenService.js');

// Dynamic import for ESM module - will be loaded when needed
let Octokit = null;

/**
 * Git Operations Class
 */
class GitOperations {
  /**
   * Create an instance of GitOperations
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.databaseManager - Database manager instance
   */
  constructor({ logger, databaseManager }) {
    this.logger = logger;
    this.databaseManager = databaseManager;
    this._gitCache = {};
    this._userInfoCache = null;
    this._userInfoCacheAt = 0;
  }

  /**
   * Get GitHub token from secure storage
   * @returns {Promise<string|null>} GitHub token or null
   */
  async getGitHubToken() {
    try {
      return await secureTokenService.getToken();
    } catch (error) {
      this.logger.error('Error getting GitHub token:', error);
      return null;
    }
  }

  /**
   * Get cached user information from database (no API calls)
   * @returns {Promise<Object|null>} Cached user info or null
   */
  async getCachedUserInfo() {
    try {
      if (!this.databaseManager) {
        this.logger.warn('⚠️ No databaseManager available for cache lookup');
        return null;
      }

      const db = await this.databaseManager.getDatabase();
      const cachedUserInfo = await new Promise((resolve, reject) => {
        db.get(
          `SELECT githubId, login, name, email, avatarUrl, updatedAt 
           FROM users 
           ORDER BY updatedAt DESC 
           LIMIT 1`,
          (err, row) => {
            if (err) {
              reject(err);
            } else {
              resolve(row);
            }
          }
        );
      });
      
      if (cachedUserInfo) {
        const userInfo = {
          id: cachedUserInfo.githubId,
          login: cachedUserInfo.login,
          name: cachedUserInfo.name,
          email: cachedUserInfo.email,
          avatar_url: cachedUserInfo.avatarUrl,
          cached: true,
          cachedAt: cachedUserInfo.updatedAt
        };
        
        this.logger.info(`✅ Retrieved cached user info: ${userInfo.login}`);
        return userInfo;
      }
      
      this.logger.info('ℹ️ No cached user info found');
      return null;
    } catch (error) {
      this.logger.error('❌ Error getting cached user info:', error);
      return null;
    }
  }

  /**
   * Get GitHub user information with cache fallback
   * @returns {Promise<Object|null>} User info or null
   */
  async getGitHubUserInfo() {
    try {
      // Return in-memory cache if fresh (< 10 minutes)
      if (this._userInfoCache && (Date.now() - this._userInfoCacheAt) < 600000) {
        this.logger.info(`✅ Returning cached GitHub user info: ${this._userInfoCache.login}`);
        return this._userInfoCache;
      }

      const token = await this.getGitHubToken();
      if (!token) {
        this.logger.warn('⚠️ No GitHub token available for user info lookup');
        return null;
      }

      this.logger.info('🔍 Fetching GitHub user information...');
      
      try {
        // Dynamic import for Octokit only when needed
        if (!Octokit) {
          const octokitModule = await import('@octokit/rest');
          Octokit = octokitModule.Octokit;
        }
        
        // Try to get fresh data from GitHub API
        const octokit = new Octokit({ auth: token });
        const { data: user } = await octokit.rest.users.getAuthenticated();
        
        const userInfo = {
          login: user.login,
          name: user.name,
          email: user.email,
          avatar_url: user.avatar_url,
          id: user.id,
          cached: false,
          fetchedAt: new Date().toISOString()
        };

        this._userInfoCache = userInfo;
        this._userInfoCacheAt = Date.now();
        
        this.logger.info(`✅ GitHub user info fetched: ${userInfo.login}`);
        return userInfo;
      } catch (apiError) {
        this._userInfoCache = null;

        this.logger.warn('⚠️ Failed to fetch from GitHub API, trying cache fallback:', apiError.message);
        
        // Fallback to database cache
        const cachedUserInfo = await this.getCachedUserInfo();
        if (cachedUserInfo) {
          return cachedUserInfo;
        }
        
        this.logger.error('❌ No user info available from API or cache');
        return null;
      }
    } catch (error) {
      this.logger.error('Error getting GitHub user info:', error);
      return null;
    }
  }

  /**
   * Set git user configuration
   * @param {string} dir - Repository directory
   * @param {string} name - User name
   * @param {string} email - User email
   * @returns {Promise<boolean>} Success status
   */
  async gitSetUserConfig(dir, name, email) {
    try {
      this.logger.info(`Setting git user config: ${name} <${email}>`);
      
      await git.setConfig({
        fs,
        dir,
        path: 'user.name',
        value: name
      });
      this._gitCache = {};
      
      await git.setConfig({
        fs,
        dir,
        path: 'user.email',
        value: email
      });
      this._gitCache = {};
      
      this.logger.info('Git user config set successfully');
      return true;
    } catch (error) {
      this.logger.error('Error setting git user config:', error);
      throw error;
    }
  }

  /**
   * Get GitHub authentication headers
   * @param {string} token - GitHub token
   * @returns {Promise<Object>} Authentication headers
   */
  async getGitHubAuth(token) {
    try {
      // Dynamic import for Octokit
      if (!Octokit) {
        const octokitModule = await import('@octokit/rest');
        Octokit = octokitModule.Octokit;
      }
      
      const octokit = new Octokit({ auth: token });
      const { data } = await octokit.users.getAuthenticated();
      
      return {
        'X-GitHub-OTP': '0',
        'Authorization': `token ${token}`,
        'User-Agent': data.login || 'documental-app'
      };
    } catch (error) {
      this.logger.warn('Could not get GitHub user info, using basic auth:', error.message);
      return {
        'X-GitHub-OTP': '0',
        'Authorization': `token ${token}`,
        'User-Agent': 'documental-app'
      };
    }
  }

  /**
   * Create a new branch
   * @param {string} dir - Repository directory
   * @param {string} branchName - Branch name
   * @param {Function} sendOutput - Output function
   * @returns {Promise<void>}
   */
  async gitCreateBranch(dir, branchName, sendOutput) {
    try {
      sendOutput(`🌿 Criando nova branch '${branchName}' em ${dir}...\n`);
      
      // Validate branch name
      if (!branchName || !/^[a-zA-Z0-9._-]+$/.test(branchName)) {
        throw new Error('Invalid branch name. Only alphanumeric characters, dots, hyphens and underscores are allowed.');
      }
      
      sendOutput(`🔍 Verificando se branch já existe...\n`);
      const existingBranches = await git.listBranches({ fs, dir, cache: this._gitCache });
      if (existingBranches.includes(branchName)) {
        const errorMsg = `❌ Branch '${branchName}' já existe.\n`;
        sendOutput(errorMsg);
        throw new Error(`Branch '${branchName}' already exists.`);
      }
      
      sendOutput(`📝 Criando branch '${branchName}'...\n`);
      // Create branch
      await git.branch({
        fs,
        dir,
        ref: branchName
      });
      this._gitCache = {};
      sendOutput(`✅ Branch '${branchName}' criada com sucesso\n`);
      
      sendOutput(`🔄 Mudando para nova branch '${branchName}'...\n`);
      // Checkout new branch
      await git.checkout({
        fs,
        dir,
        ref: branchName
      });
      this._gitCache = {};
      sendOutput(`✅ Branch '${branchName}' selecionada com sucesso\n`);
    } catch (error) {
      this.logger.error('Error creating branch:', error);
      throw error;
    }
  }

  /**
   * Checkout to a specific branch
   * @param {string} dir - Repository directory
   * @param {string} branchName - Branch name
   * @param {Function} sendOutput - Output function
   * @returns {Promise<void>}
   */
  async gitCheckoutBranch(dir, branchName, sendOutput) {
    try {
      sendOutput(`🔄 Mudando para branch '${branchName}' em ${dir}...\n`);
      
      // Check if branch exists
      sendOutput(`🔍 Verificando se branch existe...\n`);
      const branches = await git.listBranches({ fs, dir, cache: this._gitCache });
      const localBranch = branches.find(b => b === branchName);
      const remoteBranch = branches.find(b => b === `origin/${branchName}`);
      
      if (!localBranch && !remoteBranch) {
        const errorMsg = `❌ Branch '${branchName}' não encontrada.\n`;
        sendOutput(errorMsg);
        throw new Error(`Branch '${branchName}' not found.`);
      }
      
      // If only remote branch exists, create local tracking branch
      if (!localBranch && remoteBranch) {
        sendOutput(`📥 Criando branch local '${branchName}' para rastrear branch remota\n`);
        await git.branch({
          fs,
          dir,
          ref: branchName,
          object: `origin/${branchName}`,
          checkout: true
        });
        await git.setConfig({ fs, dir, path: `branch.${branchName}.remote`, value: 'origin' });
        await git.setConfig({ fs, dir, path: `branch.${branchName}.merge`, value: `refs/heads/${branchName}` });
        this._gitCache = {};
        sendOutput(`✅ Branch local '${branchName}' criada e selecionada\n`);
      } else {
        // Checkout existing local branch
        sendOutput(`📂 Selecionando branch local existente '${branchName}'\n`);
        await git.checkout({
          fs,
          dir,
          ref: branchName
        });
        this._gitCache = {};
        sendOutput(`✅ Branch '${branchName}' selecionada com sucesso\n`);
      }
    } catch (error) {
      this.logger.error('Error checking out branch:', error);
      throw error;
    }
  }

  /**
   * Ensure preview branch exists and checkout it
   * @param {string} dir - Repository directory
   * @param {Function} sendOutput - Output function
   * @returns {Promise<Object>} Result object
   */
  async gitEnsurePreviewBranch(dir, sendOutput) {
    try {
      sendOutput(`🔍 Verificando branch 'preview' em ${dir}...\n`);
      
      // List all branches (local and remote)
      const branches = await git.listBranches({ fs, dir, cache: this._gitCache });
      const localBranches = branches.filter(branch => !branch.includes('origin/'));
      const remoteBranches = branches.filter(branch => branch.includes('origin/'))
        .map(branch => branch.replace('origin/', ''));
      
      sendOutput(`📋 Branches locais encontradas: ${localBranches.join(', ') || 'nenhuma'}\n`);
      sendOutput(`📋 Branches remotas encontradas: ${remoteBranches.join(', ') || 'nenhuma'}\n`);
      
      const hasLocalPreview = localBranches.includes('preview');
      const hasRemotePreview = remoteBranches.includes('preview');
      
      sendOutput(`📂 Branch 'preview' local: ${hasLocalPreview ? '✅' : '❌'}\n`);
      sendOutput(`🌐 Branch 'preview' remota: ${hasRemotePreview ? '✅' : '❌'}\n`);
      
      if (hasLocalPreview || hasRemotePreview) {
        // Branch exists, checkout it
        sendOutput(`📂 Branch 'preview' encontrada (${hasLocalPreview ? 'local' : 'remota'}), selecionando...\n`);
        await this.gitCheckoutBranch(dir, 'preview', sendOutput);
        sendOutput(`✅ Branch 'preview' selecionada com sucesso\n`);
        return { created: false, checkedOut: true, source: hasLocalPreview ? 'local' : 'remote' };
      }
      
      // Branch doesn't exist locally or remotely, create it from main
      sendOutput(`❌ Branch 'preview' não encontrada localmente ou remotamente\n`);
      sendOutput(`🌿 Criando branch 'preview' a partir de 'main'...\n`);
      
      // First, try to checkout main (or master as fallback)
      let baseBranch = 'main';
      try {
        sendOutput(`🔍 Tentando selecionar branch 'main' como base...\n`);
        await this.gitCheckoutBranch(dir, 'main', sendOutput);
        sendOutput(`✅ Branch 'main' selecionada como base\n`);
      } catch (mainError) {
        sendOutput(`⚠️ Branch 'main' não encontrada: ${mainError.message}\n`);
        try {
          sendOutput(`🔍 Tentando selecionar branch 'master' como base...\n`);
          await this.gitCheckoutBranch(dir, 'master', sendOutput);
          baseBranch = 'master';
          sendOutput(`✅ Branch 'master' selecionada como base (main não encontrada)\n`);
        } catch (masterError) {
          sendOutput(`❌ Branch 'master' também não encontrada: ${masterError.message}\n`);
          throw new Error('Nem branch "main" nem "master" encontrada para criar a branch "preview"');
        }
      }
      
      // Check if working directory is clean before creating branch
      try {
        const status = await git.status({ fs, dir, cache: this._gitCache });
        if (status.files && status.files.length > 0) {
          sendOutput(`⚠️ Existem arquivos não commitados no diretório de trabalho\n`);
          sendOutput(`📋 Arquivos modificados: ${status.files.map(f => f.path).join(', ')}\n`);
          sendOutput(`💡 Criando branch 'preview' mesmo com arquivos pendentes\n`);
        } else {
          sendOutput(`✅ Diretório de trabalho limpo, seguro para criar branch\n`);
        }
      } catch (statusError) {
        sendOutput(`⚠️ Não foi possível verificar status do diretório: ${statusError.message}\n`);
      }
      
      // Create preview branch
      sendOutput(`🌿 Criando branch 'preview' a partir de '${baseBranch}'...\n`);
      await this.gitCreateBranch(dir, 'preview', sendOutput);
      sendOutput(`✅ Branch 'preview' criada a partir de '${baseBranch}' com sucesso\n`);
      
      // Optionally push to remote if remote exists and user has authentication
      this.logger?.info?.('[preview-push] starting push attempt', { dir });
      let pushFailed = false;
      let pushErrorMsg = null;
      try {
        const remoteUrl = await this.gitGetRemoteUrl(dir);
        this.logger?.info?.('[preview-push] remoteUrl resolved', { remoteUrl });
        if (remoteUrl) {
          sendOutput(`🌐 Repositório remoto encontrado: ${remoteUrl}\n`);
          sendOutput(`🚀 Tentando publicar branch 'preview' para o repositório remoto...\n`);
          
          const token = await this.getGitHubToken();
          this.logger?.info?.('[preview-push] token retrieved', { hasToken: Boolean(token), tokenLen: token ? token.length : 0 });
          if (token) {
            sendOutput(`🔐 Autenticação GitHub configurada\n`);
            const auth = { username: token, password: 'x-oauth-basic' };
            
            this.logger?.info?.('[preview-push] calling _pushWithRetry', { ref: 'preview', remoteRef: 'preview', authUsernamePrefix: token.substring(0, 4) });
            await this._pushWithRetry(dir, remoteUrl, auth, 'preview', 'preview', sendOutput);
            this.logger?.info?.('[preview-push] push succeeded');
            this._gitCache = {};
            sendOutput(`✅ Branch 'preview' publicada com sucesso para o repositório remoto\n`);
          } else {
            this.logger?.info?.('[preview-push] no token — skipping push');
            sendOutput(`⚠️ Autenticação GitHub não configurada\n`);
            sendOutput(`💡 Configure a autenticação GitHub para publicar automaticamente\n`);
          }
        } else {
          this.logger?.info?.('[preview-push] no remoteUrl found — skipping push');
          sendOutput(`ℹ️ Nenhum repositório remoto configurado\n`);
        }
      } catch (pushErr) {
        // Push was attempted but failed — surface this to the caller so it can
        // show a visible warning. This is NOT a fatal error: the local preview
        // branch exists and the project can still open. (skip-vs-fail: an
        // absent remote/token skips push entirely and never enters this catch.)
        pushFailed = true;
        pushErrorMsg = pushErr.message;
        this.logger?.error?.('[preview-push] PUSH FAILED — error swallowed by outer catch', {
          message: pushErr.message,
          code: pushErr.code,
          status: pushErr.status,
          name: pushErr.name,
          data: pushErr.data ? JSON.stringify(pushErr.data).substring(0, 500) : undefined,
          stack: pushErr.stack
        });
        sendOutput(`⚠️ Não foi possível publicar branch 'preview' para o repositório remoto: ${pushErr.message}\n`);
        sendOutput(`💡 A branch 'preview' foi criada localmente e pode ser publicada manualmente depois\n`);
        sendOutput(`💡 Comando para publicar manualmente: git push -u origin preview\n`);
      }
      
      return { created: true, checkedOut: true, baseBranch, pushFailed, pushError: pushFailed ? pushErrorMsg : undefined };
    } catch (error) {
      const errorMsg = `❌ Erro ao garantir branch 'preview': ${error.message}\n`;
      sendOutput(errorMsg);
      this.logger.error('Error ensuring preview branch:', error);
      
      // Provide helpful suggestions based on error type
      if (error.message.includes('main') || error.message.includes('master')) {
        sendOutput(`💡 Sugestão: Verifique se o repositório possui uma branch principal (main ou master)\n`);
      } else if (error.message.includes('authentication') || error.message.includes('auth')) {
        sendOutput(`💡 Sugestão: Configure a autenticação GitHub nas configurações do aplicativo\n`);
      } else if (error.message.includes('network') || error.message.includes('connection')) {
        sendOutput(`💡 Sugestão: Verifique sua conexão com a internet\n`);
      }
      
      throw error;
    }
  }

  /**
   * Push a branch to the remote with exponential backoff retry for
   * transient failures (network errors, HTTP 5xx). Non-retriable errors
   * (auth 401/403, non-fast-forward, ref conflict) abort immediately.
   * @param {string} dir - Repository directory
   * @param {string} url - Remote URL
   * @param {Object} auth - Auth object ({ username, password })
   * @param {string} ref - Source branch name to push (e.g. 'preview')
   * @param {string} remoteRef - Destination branch name on the remote (e.g. 'preview')
   * @param {Function} sendOutput - Output function
   * @param {number} maxAttempts - Max attempts (default 3)
   * @returns {Promise<void>}
   */
  async _pushWithRetry(dir, url, auth, ref, remoteRef, sendOutput, maxAttempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.logger?.info?.('[push-retry] attempt starting', { attempt, maxAttempts });
      try {
        await git.push({
          fs,
          http,
          dir,
          url,
          ref,
          remoteRef,
          onAuth: () => auth,
          force: false
        });
        this.logger?.info?.('[push-retry] push succeeded', { attempt });
        return;
      } catch (error) {
        lastError = error;
        this.logger?.info?.('[push-retry] error caught', {
          attempt,
          code: error.code,
          status: error.status,
          name: error.name,
          message: error.message,
          isRetriable: this._isRetriablePushError(error)
        });
        if (!this._isRetriablePushError(error)) {
          throw error;
        }
        if (attempt === maxAttempts) {
          break;
        }
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        this.logger?.info?.('[push-retry] will retry', { attempt, delayMs: 1000 * Math.pow(2, attempt - 1) });
        sendOutput(`⚠️ Tentativa ${attempt} falhou: ${error.message}. Retentando em ${delayMs / 1000}s...\n`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    this.logger?.error?.('[push-retry] exhausted all attempts', { maxAttempts, lastErrorMessage: lastError?.message });
    throw new Error(
      `Falha ao criar branch preview remota após ${maxAttempts} tentativas. ` +
      `Último erro: ${lastError.message}. Verifique conectividade e permissões.`
    );
  }

  /**
   * Determine whether a git.push error is transient (retriable).
   * @param {Error} error - Error thrown by git.push
   * @returns {boolean} True if the error is retriable
   */
  _isRetriablePushError(error) {
    if (!error) return false;
    let retriable = false;
    if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code)) {
      retriable = true;
    } else if (error.code === 'PushRejectedError') {
      retriable = false;
    } else {
      const status = error.response && error.response.status;
      if (status) {
        if (status >= 500 && status < 600) retriable = true;
        if ([401, 403, 409, 422].includes(status)) retriable = false;
      }
    }
    this.logger?.info?.('[push-retry] classification', { code: error?.code, status: error?.response?.status, retriable });
    return retriable;
  }

  /**
   * Configure git user for repository using GitHub authentication
   * @param {string} dir - Repository directory
   * @returns {Promise<boolean>} Success status
   */
  async configureGitForUser(dir) {
    try {
      this.logger.info('🔧 Configuring git user for repository...');
      
      // Step 1: Check for GitHub token
      this.logger.info('🔍 Checking for GitHub token...');
      const token = await this.getGitHubToken();
      if (!token) {
        this.logger.warn('⚠️ No GitHub token found, cannot configure git user');
        return false;
      }
      this.logger.info('✅ GitHub token found');

      // Step 2: Get GitHub user information
      this.logger.info('👤 Getting GitHub user information...');
      const userInfo = await this.getGitHubUserInfo();
      if (!userInfo) {
        this.logger.warn('⚠️ Could not get GitHub user info, cannot configure git user');
        return false;
      }

      // Step 3: Prepare user configuration
      const userName = userInfo.name || userInfo.login;
      const userEmail = userInfo.email || `${userInfo.login}@users.noreply.github.com`;
      const source = userInfo.cached ? 'cache' : 'API';

      this.logger.info(`👤 Configuring git user: ${userName} <${userEmail}> (source: ${source})`);

      // Step 4: Configure git user in repository
      this.logger.info('⚙️ Applying git configuration...');
      await this.gitSetUserConfig(dir, userName, userEmail);

      // Step 5: Set core.autocrlf and core.filemode to avoid spurious diffs
      // (CRLF/LF on Windows, file mode bit flips on Unix)
      await git.setConfig({ fs, dir, path: 'core.autocrlf', value: 'true' });
      await git.setConfig({ fs, dir, path: 'core.filemode', value: 'false' });
      this.logger.info('✅ Set core.autocrlf=true and core.filemode=false');

      this.logger.info(`✅ Git user configured successfully: ${userName} <${userEmail}>`);
      return true;
    } catch (error) {
      this.logger.error('❌ Error configuring git user:', error);
      this.logger.error('🔍 Error details:', {
        message: error.message,
        stack: error.stack,
        directory: dir
      });
      throw error;
    }
  }

  /**
   * Get remote URL from repository
   * @param {string} dir - Repository directory
   * @returns {Promise<string|null>} Remote URL or null
   */
  async gitGetRemoteUrl(dir) {
    try {
      return await git.getConfig({
        fs,
        dir,
        path: 'remote.origin.url',
        cache: this._gitCache
      });
    } catch (error) {
      this.logger.debug('Could not get git remote URL:', error.message);
      return null;
    }
  }
}

module.exports = { GitOperations };