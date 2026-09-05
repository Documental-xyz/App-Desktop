/**
 * @fileoverview Managed Node.js runtime downloader and installer
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const https = require('https');
const tar = require('tar');
const yauzl = require('yauzl');
const { app } = require('electron');

/**
 * Module-level extraction state.
 *
 * Extraction is library-based (tar/yauzl run in-process, no child subprocess),
 * so `currentExtractionPid` tracks the main Electron process while it is
 * performing the synchronous extraction work — not a child pid. Callers
 * (e.g. will-quit handler) use `waitForExtractionComplete()` to coordinate
 * graceful shutdown without interrupting an in-flight extraction that would
 * leave a half-written runtime directory behind.
 */
let extractionInProgress = false;
let currentExtractionPid = null;

/**
 * @typedef {Object} RuntimeInfo
 * @property {boolean} installed - Whether the runtime exists locally
 * @property {boolean} isValid - Whether the runtime satisfies the required major version
 * @property {string|null} version - Node.js version string
 * @property {string|null} npmVersion - npm version string
 * @property {string|null} nodePath - Full path to node executable
 * @property {string|null} npmPath - Full path to npm executable
 * @property {number} major - Node.js major version
 * @property {number} minor - Node.js minor version
 * @property {number} patch - Node.js patch version
 */

/**
 * Manages downloading, installing, and verifying a portable Node.js runtime under userData.
 */
class NodeRuntimeManager {
  /**
   * Create a runtime manager
   * @param {Object} options - Configuration options
   * @param {Object} options.logger - Logger instance
   * @param {number} [options.requiredMajor=20] - Minimum major version required
   */
  constructor({ logger, requiredMajor = 20 }) {
    this.logger = logger;
    this.requiredMajor = requiredMajor;
    this.version = '20.12.0';
    this.downloadBaseUrl = `https://nodejs.org/dist/v${this.version}`;
    this.platform = process.platform;
    this.arch = process.arch;
    this.runtimeRoot = path.join(app.getPath('userData'), 'node-runtime');
    this.installationLock = null;
  }

  /**
   * Get platform label used by Node downloads
   * @returns {string} Platform string
   */
  getPlatformLabel() {
    if (this.platform === 'darwin') {
      return 'darwin';
    }
    if (this.platform === 'win32') {
      return 'win';
    }
    return 'linux';
  }

  /**
   * Get normalized architecture label
   * @returns {string} Architecture string
   */
  getArchitectureLabel() {
    if (this.arch === 'arm64') {
      return 'arm64';
    }
    return 'x64';
  }

  /**
   * Get the directory containing the runtime for the current platform/arch
   * @returns {string} Runtime directory path
   */
  getInstallDir() {
    return path.join(this.runtimeRoot, this.platform, this.getArchitectureLabel());
  }

  /**
   * Get the path to the Node executable
   * @returns {string} Node executable path
   */
  getNodeExecutablePath() {
    if (this.platform === 'win32') {
      return path.join(this.getInstallDir(), 'node.exe');
    }
    return path.join(this.getInstallDir(), 'bin', 'node');
  }

  /**
   * Get the path to the npm executable
   * @returns {string} npm executable path
   */
  getNpmExecutablePath() {
    if (this.platform === 'win32') {
      return path.join(this.getInstallDir(), 'npm.cmd');
    }
    return path.join(this.getInstallDir(), 'bin', 'npm');
  }

  /**
   * Get the path to the npx executable
   * @returns {string} npx executable path
   */
  getNpxExecutablePath() {
    if (this.platform === 'win32') {
      return path.join(this.getInstallDir(), 'npx.cmd');
    }
    return path.join(this.getInstallDir(), 'bin', 'npx');
  }

  /**
   * Build environment variables that ensure we prefer the managed runtime
   * @param {NodeJS.ProcessEnv} [baseEnv=process.env] - Base environment
   * @returns {NodeJS.ProcessEnv} Environment configuration
   */
  buildRuntimeEnv(baseEnv = process.env) {
    const env = { ...baseEnv };
    const binDir = this.platform === 'win32'
      ? this.getInstallDir()
      : path.join(this.getInstallDir(), 'bin');
    env.PATH = env.PATH ? `${binDir}${path.delimiter}${env.PATH}` : binDir;
    env.NODE_HOME = this.getInstallDir();
    env.DOCUMENTAL_MANAGED_NODE = 'true';
    const nodeModulesPath = this.platform === 'win32'
      ? path.join(this.getInstallDir(), 'node_modules')
      : path.join(this.getInstallDir(), 'lib', 'node_modules');
    env.NODE_PATH = nodeModulesPath;
    return env;
  }

  /**
   * Get runtime download information for the current OS
   * @returns {{ filename: string, url: string, archiveType: 'zip'|'tar.gz' }} Download metadata
   */
  getDownloadInfo() {
    const arch = this.getArchitectureLabel();
    const platformLabel = this.getPlatformLabel();

    if (this.platform === 'win32') {
      return {
        filename: `node-v${this.version}-${platformLabel}-${arch}.zip`,
        url: `${this.downloadBaseUrl}/node-v${this.version}-${platformLabel}-${arch}.zip`,
        archiveType: 'zip'
      };
    }

    const suffix = platformLabel === 'darwin'
      ? `${platformLabel}-${arch}`
      : `${platformLabel}-${arch}`;

    return {
      filename: `node-v${this.version}-${suffix}.tar.gz`,
      url: `${this.downloadBaseUrl}/node-v${this.version}-${suffix}.tar.gz`,
      archiveType: 'tar.gz'
    };
  }

  /**
   * Ensure the runtime directory exists
   */
  async ensureBaseDirectories() {
    await fsPromises.mkdir(this.runtimeRoot, { recursive: true });
  }

  /**
   * Download and install the managed runtime (idempotent)
   * @param {Object} [options] - Installation options
   * @param {boolean} [options.force=false] - Force reinstall even if runtime is valid
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<RuntimeInfo>} Installation result
   */
  async installRuntime(options = {}) {
    const { force = false, onProgress } = options;

    if (this.installationLock) {
      this.logger.info('⏳ Node runtime installation already running, waiting for completion');
      return this.installationLock;
    }

    this.installationLock = this.performInstallation({ force, onProgress })
      .finally(() => {
        this.installationLock = null;
      });

    return this.installationLock;
  }

  /**
   * Perform installation logic
   * @private
   * @param {Object} options - Options passed from installRuntime
   * @returns {Promise<RuntimeInfo>} Runtime information
   */
  async performInstallation({ force, onProgress }) {
    await this.ensureBaseDirectories();
    const current = await this.getRuntimeInfo();

    if (!force && current.installed && current.isValid) {
      this.logger.info('✅ Managed Node.js runtime already installed');
      return current;
    }

    const downloadInfo = this.getDownloadInfo();
    const downloadDir = path.join(this.runtimeRoot, 'downloads');
    const tempDir = path.join(this.runtimeRoot, 'tmp-install');
    await fsPromises.mkdir(downloadDir, { recursive: true });
    await fsPromises.rm(tempDir, { recursive: true, force: true });
    await fsPromises.mkdir(tempDir, { recursive: true });

    try {
      const archivePath = await this.downloadArchive(downloadInfo, downloadDir, onProgress);
      if (onProgress) {
        onProgress({ stage: 'extracting', message: 'Extraindo Node.js...', percent: 65 });
      }
      extractionInProgress = true;
      currentExtractionPid = process.pid;
      await this.extractArchive(downloadInfo, archivePath, tempDir);
      await this.moveExtractedRuntime(tempDir);
      await fsPromises.unlink(archivePath);
      await fsPromises.rm(tempDir, { recursive: true, force: true });
      if (onProgress) {
        onProgress({ stage: 'verifying', message: 'Verificando instalação...', percent: 90 });
      }
      const runtimeInfo = await this.getRuntimeInfo();
      if (!runtimeInfo.installed || !runtimeInfo.isValid) {
        throw new Error('Falha ao verificar Node.js instalado');
      }
      this.logger.info(`✅ Node.js ${runtimeInfo.version} instalado em ${runtimeInfo.nodePath}`);
      return runtimeInfo;
    } catch (error) {
      this.logger.error('❌ Erro durante a instalação do Node.js gerenciado:', error);
      throw error;
    } finally {
      extractionInProgress = false;
      currentExtractionPid = null;
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Download archive from official Node servers
   * @param {Object} downloadInfo - Download metadata
   * @param {string} downloadDir - Directory to store archive
   * @param {Function} [onProgress] - Progress callback
   * @returns {Promise<string>} Path to downloaded archive
   */
  downloadArchive(downloadInfo, downloadDir, onProgress) {
    return new Promise((resolve, reject) => {
      const archivePath = path.join(downloadDir, downloadInfo.filename);
      const fileStream = fs.createWriteStream(archivePath);
      if (onProgress) {
        onProgress({ stage: 'downloading', message: 'Baixando Node.js oficial...', percent: 5 });
      }

      const request = https.get(downloadInfo.url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Falha ao baixar Node.js: HTTP ${response.statusCode}`));
          return;
        }

        const totalBytes = Number(response.headers['content-length'] || 0);
        let received = 0;

        response.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && totalBytes > 0) {
            const percent = Math.min(60, Math.round((received / totalBytes) * 60));
            onProgress({
              stage: 'downloading',
              message: 'Baixando Node.js oficial...',
              percent
            });
          }
        });

        response.pipe(fileStream);
      });

      fileStream.on('finish', () => {
        fileStream.close(() => resolve(archivePath));
      });

      fileStream.on('error', (error) => {
        fs.unlink(archivePath, () => reject(error));
      });

      request.on('error', (error) => {
        fs.unlink(archivePath, () => reject(error));
      });

      request.setTimeout(120000, () => {
        request.destroy(new Error('Timeout ao baixar Node.js'));
        fs.unlink(archivePath, () => {});
      });
    });
  }

  /**
   * Extract downloaded archive to temporary directory
   * @param {Object} downloadInfo - Download metadata
   * @param {string} archivePath - Path to archive
   * @param {string} tempDir - Temporary extraction directory
   * @returns {Promise<void>} Extraction promise
   */
  async extractArchive(downloadInfo, archivePath, tempDir) {
    if (downloadInfo.archiveType === 'zip') {
      await this.extractZip(archivePath, tempDir);
      return;
    }

    await tar.x({
      file: archivePath,
      cwd: tempDir
    });
  }

  /**
   * Extract ZIP archive
   * @param {string} zipPath - Path to archive
   * @param {string} extractTo - Extraction directory
   * @returns {Promise<void>} Extraction promise
   */
  extractZip(zipPath, extractTo) {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          reject(err);
          return;
        }

        zipfile.readEntry();
        zipfile.on('entry', async (entry) => {
          const entryPath = path.join(extractTo, entry.fileName);
          if (entry.fileName.endsWith('/')) {
            await fsPromises.mkdir(entryPath, { recursive: true });
            zipfile.readEntry();
            return;
          }

          const directory = path.dirname(entryPath);
          await fsPromises.mkdir(directory, { recursive: true });

          zipfile.openReadStream(entry, (error, readStream) => {
            if (error) {
              reject(error);
              return;
            }

            const writeStream = fs.createWriteStream(entryPath);
            readStream.on('error', reject);
            readStream.pipe(writeStream);

            writeStream.on('close', () => {
              zipfile.readEntry();
            });

            writeStream.on('error', reject);
          });
        });

        zipfile.on('end', resolve);
        zipfile.on('error', reject);
      });
    });
  }

  /**
   * Move extracted runtime into final installation directory
   * @param {string} tempDir - Temporary directory containing extracted files
   */
  async moveExtractedRuntime(tempDir) {
    const extractedEntries = await fsPromises.readdir(tempDir, { withFileTypes: true });
    const extractedDir = extractedEntries.find((entry) => entry.isDirectory() && entry.name.startsWith('node-v'))
      || extractedEntries.find((entry) => entry.isDirectory());

    if (!extractedDir) {
      throw new Error('Arquivos extraídos do Node.js não encontrados');
    }

    const sourcePath = path.join(tempDir, extractedDir.name);
    const targetDir = this.getInstallDir();

    await fsPromises.rm(targetDir, { recursive: true, force: true });
    await fsPromises.mkdir(path.dirname(targetDir), { recursive: true });
    await fsPromises.rename(sourcePath, targetDir);
  }

  /**
   * Parse version string
   * @param {string} version - Version string such as "v20.12.0"
   * @returns {{ major: number, minor: number, patch: number, clean: string }} Parsed version data
   */
  parseVersion(version) {
    const clean = version.replace(/^v/, '').trim();
    const [majorStr, minorStr, patchStr] = clean.split('.');
    return {
      major: Number(majorStr) || 0,
      minor: Number(minorStr) || 0,
      patch: Number(patchStr) || 0,
      clean
    };
  }

  /**
   * Run a binary and capture stdout
   * @param {string} executable - Executable path
   * @param {string[]} args - Arguments
   * @returns {Promise<string|null>} Stdout or null if execution failed
   */
  runBinary(executable, args = []) {
    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      const child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.buildRuntimeEnv(),
        shell: this.platform === 'win32' && executable.endsWith('.cmd'),
        windowsHide: true
      });

      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });

      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          resolve(null);
        }
      });
    });
  }

  /**
   * Retrieve runtime metadata (without downloading)
   * @returns {Promise<RuntimeInfo>} Runtime info
   */
  async getRuntimeInfo() {
    const nodePath = this.getNodeExecutablePath();
    let nodeExists;
    try {
      await fsPromises.access(nodePath);
      nodeExists = true;
    } catch {
      nodeExists = false;
    }

    if (!nodeExists) {
      return {
        installed: false,
        isValid: false,
        version: null,
        npmVersion: null,
        nodePath: null,
        npmPath: null,
        major: 0,
        minor: 0,
        patch: 0
      };
    }

    const npmPath = this.getNpmExecutablePath();
    let npmExists;
    try {
      await fsPromises.access(npmPath);
      npmExists = true;
    } catch {
      npmExists = false;
    }

    const nodeVersionRaw = await this.runBinary(nodePath, ['--version']);

    if (!nodeVersionRaw) {
      return {
        installed: true,
        isValid: false,
        version: null,
        npmVersion: null,
        nodePath,
        npmPath: npmExists ? npmPath : null,
        major: 0,
        minor: 0,
        patch: 0
      };
    }

    const parsed = this.parseVersion(nodeVersionRaw);
    const npmVersionRaw = npmExists
      ? await this.runBinary(npmPath, ['--version'])
      : null;

    return {
      installed: true,
      isValid: parsed.major >= this.requiredMajor,
      version: parsed.clean,
      npmVersion: npmVersionRaw ? npmVersionRaw.replace(/^v/, '').trim() : null,
      nodePath,
      npmPath: npmExists ? npmPath : null,
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch
    };
  }

  /**
   * Wait for any in-flight extraction to finish. Resolves (never rejects) when
   * `extractionInProgress` is false or after `timeoutMs` has elapsed. Use before
   * tearing down the process so we don't leave a half-extracted runtime behind.
   * @param {number} [timeoutMs=2000] - Maximum time to wait in milliseconds
   * @returns {Promise<boolean>} true if extraction finished, false on timeout
   */
  async waitForExtractionComplete(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (extractionInProgress && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !extractionInProgress;
  }

  /**
   * Remove partial extraction directories left behind by a killed install.
   * Scans `runtimeRoot` for `node-v*-*` directories missing the runtime marker
   * (`bin/node` on Unix, `node.exe` on Windows) and deletes them. Complete
   * directories under the platform/arch install dir are left untouched.
   * @returns {Promise<string[]>} Removed directory paths
   */
  async cleanupPartialExtractions() {
    const removed = [];
    let entries;
    try {
      entries = await fs.promises.readdir(this.runtimeRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return removed;
      }
      throw error;
    }

    const marker = this.platform === 'win32' ? 'node.exe' : path.join('bin', 'node');

    for (const entry of entries) {
      if (!entry.isDirectory() || !/^node-v.*-.*$/.test(entry.name)) {
        continue;
      }
      const dirPath = path.join(this.runtimeRoot, entry.name);
      const markerPath = path.join(dirPath, marker);
      try {
        await fs.promises.access(markerPath);
      } catch {
        try {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
          removed.push(dirPath);
        } catch (rmError) {
          this.logger.warn(`⚠️ Falha ao limpar extração parcial ${dirPath}:`, rmError);
        }
      }
    }
    return removed;
  }
}

module.exports = { NodeRuntimeManager };
