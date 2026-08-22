/**
 * @fileoverview Node.js runtime detection service (embedded-first precedence)
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { spawn } = require('child_process');
const { NodeRuntimeManager } = require('./nodeRuntimeManager.js');
const { EmbeddedRuntimeService } = require('./embeddedRuntimeService.js');

/**
 * Handles discovery of Node.js runtimes with embedded-first precedence:
 * (1) embedded Electron runtime → (2) managed runtime under userData/node-runtime
 * (legacy users, preferred fallback) → (3) system node (informational only).
 */
class NodeDetectionService {
  /**
   * Create service instance
   * @param {Object} dependencies - Dependency container
   * @param {Object} dependencies.logger - Logger instance
   */
  constructor({ logger }) {
    this.logger = logger;
    this.runtimeManager = new NodeRuntimeManager({ logger });
    this.embeddedRuntime = new EmbeddedRuntimeService();
    // Gates managed/system runtimes only — the embedded runtime always satisfies app needs
    this.MIN_REQUIRED_MAJOR = 20;
  }

  /**
   * Detect current runtime state (embedded, managed and system Node availability)
   * @returns {Promise<Object>} Detection payload
   */
  async detectNodeInstallation() {
    this.logger.info('🔍 Verificando runtimes Node.js (embedded → gerenciado → sistema)...');

    try {
      const embedded = this.getEmbeddedRuntimeInfo();
      const runtimeInfo = await this.runtimeManager.getRuntimeInfo();
      const systemNode = await this.checkSystemNode();

      const recommendation = embedded.available
        ? 'embedded_ready'
        : runtimeInfo.installed && runtimeInfo.isValid
          ? 'managed_ready'
          : 'install_required';

      return {
        embedded,
        runtime: this.normalizeRuntimeInfo(runtimeInfo),
        systemNode,
        recommendation
      };
    } catch (error) {
      this.logger.error('❌ Falha ao detectar Node.js:', error);
      return {
        embedded: this.getEmbeddedRuntimeInfo(),
        runtime: this.normalizeRuntimeInfo(),
        systemNode: null,
        recommendation: 'error',
        error: error.message
      };
    }
  }

  /**
   * Collect embedded runtime info from the running process (no spawn needed)
   * @returns {Object} Embedded runtime payload
   */
  getEmbeddedRuntimeInfo() {
    const parsed = this.runtimeManager.parseVersion(process.versions.node || '');
    const nodeAvailable = parsed.major > 0;

    let npmPath = null;
    let npxPath = null;
    try {
      npmPath = this.getEmbeddedToolPath('npm');
    } catch (error) {
      this.logger.warn('⚠️ npm empacotado não encontrado:', error.message);
    }
    try {
      npxPath = this.getEmbeddedToolPath('npx');
    } catch {
      // npx is optional; npm alone still makes the embedded runtime usable
    }

    return {
      available: nodeAvailable && Boolean(npmPath),
      nodeAvailable,
      npmAvailable: Boolean(npmPath),
      version: parsed.clean,
      npmVersion: this.getEmbeddedNpmVersion(),
      nodePath: process.execPath,
      npmPath,
      npxPath,
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch
    };
  }

  /**
   * Resolve a bundled tool path via the embedded runtime service (honors CUSTOM_NPM_PATH)
   * @param {'npm'|'npx'} tool - Tool name
   * @returns {string} Path to the tool entrypoint (CLI script or executable)
   */
  getEmbeddedToolPath(tool) {
    const descriptor = tool === 'npm'
      ? this.embeddedRuntime.getNpmExecutable()
      : this.embeddedRuntime.getNpxExecutable();
    return descriptor.args.length ? descriptor.args[0] : descriptor.command;
  }

  /**
   * Best-effort bundled npm version lookup
   * @returns {string|null} npm version or null
   */
  getEmbeddedNpmVersion() {
    try {
      return require('npm/package.json').version;
    } catch {
      return null;
    }
  }

  /**
   * Normalize managed runtime data for renderer consumption
   * @param {import('./nodeRuntimeManager.js').RuntimeInfo} [runtimeInfo]
   * @returns {Object} Normalized runtime payload
   */
  normalizeRuntimeInfo(runtimeInfo) {
    if (!runtimeInfo) {
      return {
        installed: false,
        isValid: false,
        version: null,
        npmVersion: null,
        nodePath: null,
        npmPath: null,
        npxPath: null,
        major: 0,
        minor: 0,
        patch: 0
      };
    }

    return {
      installed: runtimeInfo.installed,
      isValid: runtimeInfo.isValid,
      version: runtimeInfo.version,
      npmVersion: runtimeInfo.npmVersion,
      nodePath: runtimeInfo.nodePath,
      npmPath: runtimeInfo.npmPath,
      npxPath: runtimeInfo.installed ? this.runtimeManager.getNpxExecutablePath() : null,
      major: runtimeInfo.major,
      minor: runtimeInfo.minor,
      patch: runtimeInfo.patch
    };
  }

  /**
   * Install or update the managed Node runtime (on-demand fallback, Task 8)
   * @param {Object} [options] - Installation options
   * @param {boolean} [options.force=false] - Force reinstall
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<Object>} Updated runtime info
   */
  async installManagedRuntime(options = {}) {
    const runtimeInfo = await this.runtimeManager.installRuntime(options);
    return this.normalizeRuntimeInfo(runtimeInfo);
  }

  /**
   * Get preferred Node executable (embedded Electron runtime)
   * @returns {Promise<string>} Executable path
   */
  async getPreferredNodeExecutable() {
    return this.embeddedRuntime.getNodeExecutable().command;
  }

  /**
   * Get preferred npm executable (bundled npm via embedded runtime; honors CUSTOM_NPM_PATH)
   * @returns {Promise<string>} npm entrypoint path
   */
  async getPreferredNpmExecutable() {
    return this.getEmbeddedToolPath('npm');
  }

  /**
   * Get preferred npx executable (bundled npx via embedded runtime; honors CUSTOM_NPM_PATH)
   * @returns {Promise<string>} npx entrypoint path
   */
  async getPreferredNpxExecutable() {
    return this.getEmbeddedToolPath('npx');
  }

  /**
   * Environment additions required when running the managed Node/npm fallback
   * @param {NodeJS.ProcessEnv} [baseEnv=process.env] - Base environment
   * @returns {NodeJS.ProcessEnv} Environment variables
   */
  getManagedRuntimeEnv(baseEnv = process.env) {
    return this.runtimeManager.buildRuntimeEnv(baseEnv);
  }

  /**
   * Discover system Node.js installation (informational only)
   * @returns {Promise<Object|null>} System node description
   */
  async checkSystemNode() {
    return new Promise((resolve) => {
      const child = spawn('node', ['-p', 'JSON.stringify({ version: process.version, path: process.execPath })'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code !== 0 || !stdout) {
          resolve(null);
          return;
        }

        try {
          const payload = JSON.parse(stdout.trim());
          const parsed = this.runtimeManager.parseVersion(payload.version || '');
          resolve({
            version: parsed.clean,
            rawVersion: payload.version,
            path: payload.path,
            major: parsed.major,
            minor: parsed.minor,
            patch: parsed.patch,
            isValid: parsed.major >= this.MIN_REQUIRED_MAJOR
          });
        } catch (error) {
          this.logger.warn('⚠️ Não foi possível analisar dados do Node.js do sistema:', error.message);
          resolve(null);
        }
      });
    });
  }
}

module.exports = { NodeDetectionService };
