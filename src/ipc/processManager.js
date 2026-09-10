/**
 * @fileoverview Process management for project operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { execa } = require('execa');
const fs = require('fs');
const path = require('path');
const { rimraf } = require('rimraf');
const { PlatformService } = require('../main/services/platform/PlatformService');
const { EmbeddedRuntimeService } = require('../main/services/embeddedRuntimeService');
const { EmbeddedFallbackService } = require('../main/services/embeddedFallbackService');
const nodeShimManager = require('../main/services/nodeShimManager');
const { killPidTree } = require('../main/processes/killPidTree');
const { appTracker } = require('../main/processes/documentalTracker');

const fsp = fs.promises;


// Global state
let globalDevServerUrl = null;
let activeProcesses = {};
let activeDocumentalProcesses = {};
// Readiness callbacks for re-callers of a still-booting dev server (keyed by
// pid; kept separate because activeDocumentalProcesses is JSON-persisted).
let devServerUrlWaiters = {};
let processManagerLock = false;

/**
 * Acquire the process manager lock to prevent concurrent killAll races
 * @param {string} operation - Name of the operation requesting the lock (used in error message)
 * @throws {Error} If another operation is already holding the lock (message: "Process manager busy: <operation>")
 */
function acquireProcessManagerLock(operation) {
  if (processManagerLock) {
    throw new Error('Process manager busy: ' + operation);
  }
  processManagerLock = true;
}

/**
 * Release the process manager lock
 */
function releaseProcessManagerLock() {
  processManagerLock = false;
}

// Window id → project id (string). Main-process source of truth for which
// window is using which project — the renderer's sessionStorage is not
// consultable from the main process. Populated when a dev server starts
// (via the invoke sender), cleared on navigate-away and window close.
const windowProjectMap = new Map();

/**
 * Record that a window uses a project (raw primitive).
 * @param {number} windowId - BrowserWindow id
 * @param {string|number} projectId
 */
function mapWindowToProject(windowId, projectId) {
  windowProjectMap.set(windowId, String(projectId));
}

/**
 * Record that the window owning `senderWebContents` uses the project —
 * called from startDevServer with the webContents of the invoke that
 * requested the server.
 * @param {Electron.WebContents} senderWebContents - event.sender of the invoke
 * @param {string|number} projectId
 */
function associateWindowWithProject(senderWebContents, projectId) {
  if (!senderWebContents) {
    return;
  }
  try {
    const { BrowserWindow } = require('electron');
    const window = BrowserWindow.fromWebContents(senderWebContents);
    if (window) {
      mapWindowToProject(window.id, projectId);
    }
  } catch (error) {
    // Best-effort bookkeeping — never fail a dev server start over it.
  }
}

/**
 * Remove a window's project association (navigate back to index, window closed).
 * @param {number} windowId
 * @returns {string|undefined} The project id that was mapped, if any
 */
function dissociateWindow(windowId) {
  const projectId = windowProjectMap.get(windowId);
  windowProjectMap.delete(windowId);
  return projectId;
}

/**
 * @param {number} windowId
 * @returns {string|undefined} Project id currently used by the window
 */
function getWindowProject(windowId) {
  return windowProjectMap.get(windowId);
}

/**
 * @param {string|number} projectId
 * @returns {number[]} Ids of the windows still using the project
 */
function getWindowsUsingProject(projectId) {
  const normalizedId = String(projectId);
  const windowIds = [];
  for (const [windowId, mappedProjectId] of windowProjectMap) {
    if (mappedProjectId === normalizedId) {
      windowIds.push(windowId);
    }
  }
  return windowIds;
}

// Dev-server starts that are in flight (between startDevServer entry and
// full registration). A closeProject/cancel arriving in this window finds
// nothing in activeProcesses yet — without this registry the newborn server
// would survive the close that already answered {killed:true} (F3 leak).
// Keyed by projectId → Set of per-start tokens so a legitimate reopen that
// begins while an aborted start is still winding down gets a FRESH token
// and is never poisoned by the earlier close.
const startingProjectServers = new Map();

function registerStartingServer(projectId, token) {
  const key = String(projectId);
  let tokens = startingProjectServers.get(key);
  if (!tokens) {
    tokens = new Set();
    startingProjectServers.set(key, tokens);
  }
  tokens.add(token);
}

function unregisterStartingServer(projectId, token) {
  const tokens = startingProjectServers.get(String(projectId));
  if (!tokens) {
    return;
  }
  tokens.delete(token);
  if (tokens.size === 0) {
    startingProjectServers.delete(String(projectId));
  }
}

/**
 * Mark every in-flight start of the project as aborted; each start token
 * checks its own flag after registering its newborn and terminates it.
 * @param {string|number} projectId
 */
function abortStartingServers(projectId) {
  const tokens = startingProjectServers.get(String(projectId));
  if (!tokens) {
    return;
  }
  for (const token of tokens) {
    token.aborted = true;
  }
}

/**
 * Process Manager Class
 */
class ProcessManager {
  /**
   * Create an instance of ProcessManager
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.nodeDetectionService - Node.js detection service
   */
  constructor({ logger, nodeDetectionService, killPidTree: killPidTreeFn }) {
    this.logger = logger;
    this.nodeDetectionService = nodeDetectionService;
    this.platformService = new PlatformService({ logger });
    /** @type {Function|undefined} Optional injection for tests — defaults to killPidTree from require */
    this._killPidTree = killPidTreeFn;
    /** Shared tracker singleton: in-memory tracking + PID registry (crash-recovery reap) */
    this.appTracker = appTracker;
    this.embeddedRuntimeService = new EmbeddedRuntimeService();
    this.fallbackService = new EmbeddedFallbackService({ logger, nodeDetectionService });
    /** @type {Promise<string>|null} Cached ensureShims() result (per app session) */
    this._shimsDirPromise = null;
    this.processesFile = this.platformService.joinPath(this.platformService.getHomeDirectory(), '.documental-processes.json');
    (async () => {
      await this.loadDocumentalProcesses();
    })();
  }

  /**
   * Load Documental processes from file
   * @returns {Object} Processes object
   */
  async loadDocumentalProcesses() {
    // DEPRECATED: PID persistence replaced by PIDRegistryFile in
    // perf-zombie-refactor. No-op — stale PIDs accumulate in the old
    // file and are never acted upon (killAll routes PIDs through
    // killPidTree instead).
    return {};
  }

  /**
   * Save Documental processes to file
   */
  async saveDocumentalProcesses() {
    try {
      await fsp.writeFile(this.processesFile, JSON.stringify(activeDocumentalProcesses, null, 2));
      this.logger.info('Saved Documental processes to file');
    } catch (error) {
      this.logger.error('Error saving Documental processes:', error);
    }
  }

  /**
   * Add Documental process to tracking
   * @param {number} pid - Process ID
   * @param {Object} processInfo - Process information
   */
  async addDocumentalProcess(pid, processInfo) {
    activeDocumentalProcesses[pid] = {
      pid,
      port: processInfo.port,
      projectId: processInfo.projectId,
      startTime: Date.now(),
      command: processInfo.command,
      cwd: processInfo.cwd
    };
    await this.saveDocumentalProcesses();
    this.logger.info(`Added Documental process to tracking: PID ${pid}, Port ${processInfo.port}`);
  }

  /**
   * Remove Documental process from tracking
   * @param {number} pid - Process ID
   */
  async removeDocumentalProcess(pid) {
    if (activeDocumentalProcesses[pid]) {
      delete activeDocumentalProcesses[pid];
      await this.saveDocumentalProcesses();
      this.logger.info(`Removed Documental process from tracking: PID ${pid}`);
    }
  }

  /**
   * Get npm path
   * @returns {Promise<string>} npm executable path
   */
  async getNpmPath() {
    try {
      // Always prefer custom npm path if available
      if (process.env.CUSTOM_NPM_PATH) {
        this.logger.info(`Using custom npm path: ${process.env.CUSTOM_NPM_PATH}`);
        return process.env.CUSTOM_NPM_PATH;
      }
      
      // Use Node.js detection service to get preferred npm
      if (this.nodeDetectionService) {
        const npmPath = await this.nodeDetectionService.getPreferredNpmExecutable();
        this.logger.info(`Using detected npm path: ${npmPath}`);
        return npmPath;
      }
      
      this.logger.info('Using system npm');
      return 'npm';
    } catch (error) {
      this.logger.warn('Failed to get npm path from detection service, falling back to system npm:', error.message);
      return 'npm';
    }
  }

  /**
   * Get Node.js path
   * @returns {Promise<string>} Node.js executable path
   */
  async getNodePath() {
    try {
      // Always prefer custom node path if available
      if (process.env.CUSTOM_NODE_PATH) {
        this.logger.info(`Using custom node path: ${process.env.CUSTOM_NODE_PATH}`);
        return process.env.CUSTOM_NODE_PATH;
      }
      
      // Use Node.js detection service to get preferred node
      if (this.nodeDetectionService) {
        const nodePath = await this.nodeDetectionService.getPreferredNodeExecutable();
        this.logger.info(`Using detected node path: ${nodePath}`);
        return nodePath;
      }
      
      this.logger.info('Using system node');
      return 'node';
    } catch (error) {
      this.logger.warn('Failed to get node path from detection service, falling back to system node:', error.message);
      return 'node';
    }
  }

  /**
   * Extract port from URL
   * @param {string} url - URL string
   * @returns {number|null} Port number or null
   */
  extractPortFromUrl(url) {
    const match = url.match(/http:\/\/localhost:(\d+)\//);
    return match ? parseInt(match[1]) : null;
  }

  /**
   * Create delay function
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise} Promise that resolves after delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Resolve a node-family command (node/npm/npx) to the embedded runtime
   * and build a child env with the shims dir prepended to PATH (so npm
   * lifecycle scripts find `node`). Throws if the embedded CLI cannot be
   * resolved — callers let the error propagate (fallback is Task 8).
   * @param {'node'|'npm'|'npx'} command - Command name
   * @param {Object} baseEnv - Base environment (usually a copy of process.env)
   * @returns {Promise<{command: string, args: string[], env: Object}>} Spawn descriptor
   */
  async resolveEmbeddedExecutable(command, baseEnv) {
    if (process.env.DOCUMENTAL_DISABLE_EMBEDDED === '1') {
      // Test-only hook: force embedded failure so QA can exercise the fallback
      throw new Error('Embedded runtime disabled via DOCUMENTAL_DISABLE_EMBEDDED (test hook)');
    }

    const svc = this.embeddedRuntimeService;
    const descriptor = command === 'node'
      ? svc.getNodeExecutable()
      : command === 'npm'
        ? svc.getNpmExecutable()
        : svc.getNpxExecutable();

    let shimsDir = null;
    try {
      if (!this._shimsDirPromise) {
        this._shimsDirPromise = nodeShimManager.ensureShims();
      }
      shimsDir = await this._shimsDirPromise;
    } catch (error) {
      // Shims only affect `node` PATH lookups in lifecycle scripts; the
      // spawn itself uses absolute paths, so continue without them.
      this._shimsDirPromise = null;
      this.logger.warn(`⚠️ Could not ensure node shims: ${error.message}`);
    }

    const env = { ...baseEnv };
    if (shimsDir) {
      env.PATH = shimsDir + path.delimiter + (env.PATH || '');
    }
    return { command: descriptor.command, args: descriptor.args, env };
  }

  /**
   * Resolve a node-family command to a spawn descriptor, falling back to the
   * managed runtime (reuse → download once per session, progress forwarded)
   * when embedded resolution fails. Only spawn/resolution failures trigger
   * the fallback — non-zero exits of a working runtime never do.
   * @param {'node'|'npm'|'npx'} command - Command name
   * @param {Object} baseEnv - Base environment
   * @param {string} processId - Process ID (for logging)
   * @param {Object} [options] - Resolution options
   * @param {boolean} [options.forceManaged=false] - Skip the embedded runtime
   * @returns {Promise<{command: string, args: string[], env: Object, runtime: 'embedded'|'managed'}>} Spawn descriptor
   */
  async resolveRuntimeExecutable(command, baseEnv, processId, { forceManaged = false } = {}) {
    if (!forceManaged) {
      try {
        const embedded = await this.resolveEmbeddedExecutable(command, baseEnv);
        this.logger.info(`📦 Using embedded ${command} for process ${processId}`);
        return { ...embedded, runtime: 'embedded' };
      } catch (error) {
        if (!this.nodeDetectionService) {
          throw error;
        }
        this.logger.warn(`⚠️ Embedded ${command} unavailable (${error.message}); falling back to managed runtime`);
      }
    }
    const managed = await this.resolveManagedExecutable(command, baseEnv);
    this.logger.info(`📦 Using managed ${command} for process ${processId}`);
    return { ...managed, runtime: 'managed' };
  }

  /**
   * Resolve a node-family command to the managed runtime under
   * userData/node-runtime, ensuring it is installed first.
   * @param {'node'|'npm'|'npx'} command - Command name
   * @param {Object} baseEnv - Base environment
   * @returns {Promise<{command: string, args: string[], env: Object}>} Spawn descriptor
   */
  async resolveManagedExecutable(command, baseEnv) {
    await this.fallbackService.ensureManagedRuntime();
    const runtimeManager = this.nodeDetectionService.runtimeManager;
    const commandPath = command === 'node'
      ? runtimeManager.getNodeExecutablePath()
      : command === 'npm'
        ? runtimeManager.getNpmExecutablePath()
        : runtimeManager.getNpxExecutablePath();
    return {
      command: commandPath,
      args: [],
      env: this.nodeDetectionService.getManagedRuntimeEnv(baseEnv)
    };
  }

  /**
   * Spawn a command, track it, and stream stdout/stderr to sendOutput.
   * Rejects with an isStartupError-tagged Error when the process never
   * spawned (used by executeCommand to trigger the managed fallback).
   * @param {string} actualCommand - Executable path
   * @param {string[]} prefixArgs - Runtime prefix arguments (e.g. npm-cli.js)
   * @param {string[]} args - User command arguments
   * @param {Object} env - Child environment
   * @param {string} cwd - Working directory
   * @param {string} processId - Process ID for tracking
   * @param {Function} sendOutput - Output callback
   * @param {boolean} viaEmbeddedRuntime - Spawn through spawnNodeChild (env scrub)
   * @returns {Promise<void>}
   */
  runTrackedCommand(actualCommand, prefixArgs, args, env, cwd, processId, sendOutput, viaEmbeddedRuntime) {
    return new Promise(async (resolve, reject) => {
      const actualArgs = [...prefixArgs, ...args];
      this.logger.info(`🚀 Executing: ${actualCommand} ${actualArgs.join(' ')} in ${cwd}`);

      try {
        const spawnOptions = {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          killSignal: 'SIGTERM',
          cleanup: true,
          windowsHide: true
        };
        // detached on POSIX makes the child a process-group leader so
        // killPidTree's kill(-pid) reaches the whole tree and the PID
        // registry can reap it after a hard crash. On win32 it stays false
        // (would break the console-host chain windowsHide relies on).
        // windowsHide is pinned explicitly: execa already defaults it to true,
        // but a future execa major must not be able to silently regress it.
        // On win32 the embedded runtime spawns through a shell host (cmd.exe)
        // so the DIRECT console-subsystem child gets one hidden console
        // instead of flashing a window — electron.exe itself is GUI-subsystem
        // and never attaches to a console, so nothing is inherited by the npm
        // child-tree; deeper npm descendants are hidden by the npm-internal
        // windowsHide patches (@npmcli/promise-spawn, @npmcli/run-script).
        // Do not clobber an existing shell option.
        const embeddedShellHost = process.platform === 'win32' &&
          typeof actualCommand === 'string' &&
          path.resolve(actualCommand).toLowerCase() === path.resolve(process.execPath).toLowerCase();
        const mergedSpawnOptions = { ...spawnOptions, shell: embeddedShellHost || spawnOptions.shell || false };
        const subprocess = viaEmbeddedRuntime
          ? this.embeddedRuntimeService.spawnNodeChild(actualCommand, actualArgs, mergedSpawnOptions)
          : execa(actualCommand, actualArgs, mergedSpawnOptions);

        activeProcesses[processId] = subprocess;

        let spawned = false;
        subprocess.once('spawn', () => {
          spawned = true;
          this._trackSpawnedPid(subprocess.pid, processId, `${actualCommand} ${actualArgs.join(' ')}`, cwd);
        });

        // Handle stdout
        subprocess.stdout?.on('data', (data) => {
          sendOutput(data.toString());
        });

        // Handle stderr
        subprocess.stderr?.on('data', (data) => {
          sendOutput(data.toString());
        });

        // Handle process completion
        subprocess.on('exit', (code, signal) => {
          // Identity guard: a late 'exit' of a REPLACED handle (same key,
          // e.g. quick close+reopen of a project) must not delete the new
          // subprocess from tracking.
          if (activeProcesses[processId] === subprocess) {
            delete activeProcesses[processId];
          }
          this._untrackSpawnedPid(subprocess.pid);
          if (!spawned) {
            reject(Object.assign(new Error('Command failed to spawn'), { isStartupError: true }));
            return;
          }
          if (code === 0) {
            resolve();
          } else if (signal) {
            reject(`Command killed with signal: ${signal}`);
          } else {
            reject(`Command failed with code ${code}`);
          }
        });

        // Handle process errors
        subprocess.on('error', (err) => {
          if (activeProcesses[processId] === subprocess) {
            delete activeProcesses[processId];
          }
          this._untrackSpawnedPid(subprocess.pid);
          if (!spawned) {
            reject(Object.assign(new Error(`Failed to start command: ${err.message}`), { isStartupError: true }));
            return;
          }
          reject(`Failed to start command: ${err.message}`);
        });

      } catch (error) {
        delete activeProcesses[processId];
        reject(`Failed to execute command: ${error.message}`);
      }
    });
  }

  /**
   * Register a spawned PID for crash recovery. Mirrors the process into
   * appTracker (in-memory) and the on-disk PID registry (reaped on next
   * boot if this process dies without cleaning up). projectId is derived
   * from the tracking key when it follows the `<kind>-<id>` convention.
   * @param {number|undefined} pid
   * @param {string} processKey - Tracking key (e.g. `dev-3`, `build-3`)
   * @param {string} command - Full command line (identity for the PID-reuse guard)
   * @param {string} cwd
   */
  _trackSpawnedPid(pid, processKey, command, cwd) {
    if (typeof pid !== 'number' || pid <= 0) {
      return;
    }
    const idMatch = typeof processKey === 'string' ? processKey.match(/^(?:dev|build|reopen)-(.+)$/) : null;
    try {
      this.appTracker.addProcess(pid, {
        port: null,
        projectId: idMatch ? idMatch[1] : undefined,
        command,
        cwd
      });
    } catch (error) {
      this.logger.warn(`Failed to register PID ${pid} in tracker: ${error.message}`);
    }
  }

  /**
   * Unregister a PID after a clean exit so the registry doesn't linger
   * (a lingering entry would make the next boot's reapOrphans inspect,
   * and possibly kill, an unrelated reused PID).
   * @param {number|undefined} pid
   */
  _untrackSpawnedPid(pid) {
    if (typeof pid !== 'number' || pid <= 0) {
      return;
    }
    try {
      this.appTracker.removeProcess(pid);
    } catch {
      /* best-effort — registry writes are already swallowed downstream */
    }
  }

  /**
   * Execute a command in a directory
   * @param {string} command - Command to execute
   * @param {Array<string>} args - Command arguments
   * @param {string} cwd - Working directory
   * @param {string} processId - Process ID for tracking
   * @param {Function} sendOutput - Output callback
   * @returns {Promise<void>}
   */
  async executeCommand(command, args, cwd, processId, sendOutput) {
    const isNodeFamily = command === 'node' || command === 'npm' || command === 'npx';
    const baseEnv = { ...process.env };

    if (!isNodeFamily) {
      return this.runTrackedCommand(command, [], args, baseEnv, cwd, processId, sendOutput, false);
    }

    const descriptor = await this.resolveRuntimeExecutable(command, baseEnv, processId);

    try {
      return await this.runTrackedCommand(
        descriptor.command, descriptor.args, args, descriptor.env, cwd, processId, sendOutput,
        descriptor.runtime === 'embedded'
      );
    } catch (error) {
      // Startup failure of the embedded runtime (process never spawned) is
      // the only failure class that triggers the managed fallback here.
      if (descriptor.runtime !== 'embedded' || !error.isStartupError) {
        throw error;
      }
      this.logger.warn(`⚠️ Embedded ${command} failed to start (${error.message}); retrying with managed runtime`);
      const managed = await this.resolveRuntimeExecutable(command, baseEnv, processId, { forceManaged: true });
      return this.runTrackedCommand(managed.command, managed.args, args, managed.env, cwd, processId, sendOutput, false);
    }
  }

  /**
   * Find an already-running dev server a new startDevServer call could reuse.
   * Two dev servers on the same repo race on node_modules/.astro/data-store.json
   * and surface as ENOENT, so match by projectId slot first, then by resolved
   * repo cwd across tracked dev servers (activeDocumentalProcesses only ever
   * holds dev servers — addDocumentalProcess is called solely from
   * startDevServer).
   * @param {string} projectId - Project ID of the incoming request
   * @param {string} repoDirPath - Repo directory of the incoming request
   * @returns {null|{process: Object, projectId: string, url: string|null, matchedBy: string}}
   */
  _findReusableDevServer(projectId, repoDirPath) {
    const isAlive = (proc) => Boolean(proc && proc.pid && proc.exitCode === null);
    const resolvedRepo = repoDirPath ? path.resolve(repoDirPath) : null;

    const byId = activeProcesses[`dev-${projectId}`];
    if (isAlive(byId)) {
      const record = byId.pid ? activeDocumentalProcesses[byId.pid] : null;
      // Primary dedupe key is the resolved repo dir: if the slot's process runs
      // in a different repo (project recreated elsewhere under the same id), it
      // must not shadow the repo scan below. Unknown cwd falls back to id match.
      if (!resolvedRepo || !record || !record.cwd || path.resolve(record.cwd) === resolvedRepo) {
        return { process: byId, projectId, url: (record && record.url) || null, matchedBy: 'projectId' };
      }
    }

    if (resolvedRepo) {
      for (const record of Object.values(activeDocumentalProcesses)) {
        if (!record || !record.cwd || path.resolve(record.cwd) !== resolvedRepo) {
          continue;
        }
        const handle = Object.values(activeProcesses).find((proc) => proc && proc.pid === record.pid);
        if (isAlive(handle)) {
          return { process: handle, projectId: record.projectId, url: record.url || null, matchedBy: 'repoDirPath' };
        }
      }
    }
    return null;
  }

  /**
   * Register a callback fired when the dev server for pid captures its URL
   * (null if it exits before capturing one).
   * @param {number} pid - Process ID
   * @param {Function} callback - Receives the URL or null
   */
  _waitForDevServerUrl(pid, callback) {
    if (typeof pid !== 'number' || pid <= 0) {
      return;
    }
    if (!devServerUrlWaiters[pid]) {
      devServerUrlWaiters[pid] = [];
    }
    devServerUrlWaiters[pid].push(callback);
  }

  /**
   * Flush URL waiters for pid (url=null means the server died before ready).
   * @param {number} pid - Process ID
   * @param {string|null} url - Captured dev server URL, or null
   */
  _notifyDevServerUrlWaiters(pid, url) {
    if (typeof pid !== 'number' || pid <= 0) {
      return;
    }
    const waiters = devServerUrlWaiters[pid];
    if (!waiters) {
      return;
    }
    delete devServerUrlWaiters[pid];
    for (const fn of waiters) {
      try {
        fn(url);
      } catch (error) {
        this.logger.warn(`[devserver] URL waiter failed: ${error.message}`);
      }
    }
  }

  /**
   * Start development server with URL detection
   * @param {string} repoDirPath - Repository directory path
   * @param {number} projectId - Project ID
   * @param {Function} sendServerOutput - Server output callback
   * @param {Function} sendStatus - Status callback
   * @param {Electron.WebContents} [senderWebContents] - event.sender of the
   *   invoke requesting the server; its window is mapped to the project so
   *   close-project knows whether the processes are still in use
   * @returns {Promise<Object>} Process information
   */
  async startDevServer(repoDirPath, projectId, sendServerOutput, sendStatus, senderWebContents) {
    // Map the requesting window FIRST so reused (deduplicated) starts keep
    // the window→project association fresh too.
    associateWindowWithProject(senderWebContents, projectId);

    // Dedupe: never spawn a second server for a project/repo that already has
    // one running — re-callers (reopen-project, open-only-preview) get the
    // existing handle and the URL already captured (or relayed when ready).
    const existing = this._findReusableDevServer(projectId, repoDirPath);
    if (existing) {
      const target = existing.matchedBy === 'projectId' ? projectId : path.resolve(repoDirPath);
      this.logger.info(`[devserver] reutilizando server existente para ${target} (PID ${existing.process.pid})`);
      if (existing.url) {
        sendServerOutput(`Development server already running at ${existing.url} — reusing existing process.\n`);
        sendStatus('success');
      } else {
        sendServerOutput('Development server already running — reusing existing process, waiting for readiness...\n');
        this._waitForDevServerUrl(existing.process.pid, (url) => {
          if (url) {
            sendServerOutput('Development server is ready.\n');
            sendStatus('success');
          }
        });
      }
      return { process: existing.process, url: existing.url, reused: true };
    }

    // Startup-race fix: publish this start BEFORE the first await so a
    // closeProject arriving mid-startup can abort the newborn. This
    // function has exactly two exits (the early return below and the
    // final return) — both unregister the token.
    const startToken = { aborted: false };
    registerStartingServer(projectId, startToken);

    let serverReady = false;
    const checkServerReady = (data) => {
      if (!serverReady && (data.includes('ready') || data.includes('compiled successfully') || data.includes('listening on'))) {
        serverReady = true;
        sendServerOutput('Development server is ready.\n');
        sendStatus('success'); // Mark as success only when server is truly ready
      }
    };

    let devServerUrl = null;
    const urlRegex = /http:\/\/localhost:\d+\//;

    const processOutput = (data) => {
      const output = data.toString();
      sendServerOutput(output);
      checkServerReady(output);

      if (!devServerUrl) {
        const match = output.match(urlRegex);
        if (match) {
          devServerUrl = match[0];
          globalDevServerUrl = devServerUrl; // Store globally
          
          // Extract port and update tracked Documental process
          const port = this.extractPortFromUrl(devServerUrl);
          if (port && devProcess.pid) {
            // Update process with port information
            if (activeDocumentalProcesses[devProcess.pid]) {
              activeDocumentalProcesses[devProcess.pid].port = port;
              activeDocumentalProcesses[devProcess.pid].url = devServerUrl;
              this.saveDocumentalProcesses();
              this.logger.info(`Updated Documental process ${devProcess.pid} with port ${port}`);
            }
          }

          this._notifyDevServerUrlWaiters(devProcess.pid, devServerUrl);

          this.logger.info(`Development server URL: ${devServerUrl}`);
          // Send to all windows for synchronization
          const { BrowserWindow } = require('electron');
          const allWindows = BrowserWindow.getAllWindows();
          this.logger.info(`Sending dev-server-url to ${allWindows.length} windows`);
          BrowserWindow.getAllWindows().forEach(window => {
            if (!window.isDestroyed()) {
              this.logger.info(`Sending to window: ${window.id}`);
              window.webContents.send('dev-server-url', devServerUrl);
            }
          });
        }
      }
    };

    // Use executeCommand to ensure managed Node.js/NPM is used

    let devProcess;
    let processStarted = false;
    
    try {
      // Resolve npm via the embedded runtime, with managed-runtime fallback
      let env = { ...process.env };
      const runtime = await this.resolveRuntimeExecutable('npm', env, `dev-${projectId}`);
      const actualNpmPath = runtime.command;
      const npmArgs = [...runtime.args, 'run', 'dev'];
      env = runtime.env;


      this.logger.info(`🚀 Starting dev server: ${actualNpmPath} run dev in ${repoDirPath}`);

      let spawnFailedEarly = false;

      try {
        devProcess = this.embeddedRuntimeService.spawnNodeChild(actualNpmPath, npmArgs, {
          cwd: repoDirPath,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          killSignal: 'SIGTERM',
          cleanup: true,
          windowsHide: true
        });

        // Race 1 fix: execa's pid is undefined until 'spawn'. Wait for it so
        // pid reads below are safe; reject on early 'error' (e.g. ENOENT).
        if (!devProcess.pid) {
          await new Promise((resolve, reject) => {
            devProcess.once('spawn', resolve);
            devProcess.once('error', (err) => {
              spawnFailedEarly = true;
              reject(err);
            });
          });
        }

        processStarted = true;
        const processId = `dev-${projectId}`;
        activeProcesses[processId] = devProcess;

        this._trackSpawnedPid(devProcess.pid, processId, `${actualNpmPath} ${npmArgs.join(' ')}`, repoDirPath);

        await this.addDocumentalProcess(devProcess.pid, {
          port: null, // Will be updated when URL is detected
          projectId: projectId,
          command: 'npm run dev',
          cwd: repoDirPath
        });

        // Startup-race fix: a closeProject that raced this start marked the
        // token while nothing was trackable yet — terminate the newborn now
        // instead of leaking it past the close that already answered.
        if (startToken.aborted) {
          this.logger.warn(`[devserver] project ${projectId} closed during startup — terminating newborn dev server (PID ${devProcess.pid})`);
          if (activeProcesses[processId] === devProcess) {
            await this.terminateProcessByKey(processId);
          } else {
            // A legitimate reopen already claimed the slot key — kill only
            // OUR orphan by pid, never the replacement handle.
            try {
              const killFn = this._killPidTree || killPidTree;
              await killFn(devProcess.pid, 300);
            } catch (error) {
              this.logger.warn(`Error terminating aborted newborn ${devProcess.pid}:`, error);
            }
            await this.removeDocumentalProcess(devProcess.pid);
            this._untrackSpawnedPid(devProcess.pid);
          }
          sendServerOutput('Development server aborted: project closed during startup.\n');
          sendStatus('failure');
          unregisterStartingServer(projectId, startToken);
          return { process: devProcess, url: null };
        }

        // Race 3 fix: any error between spawn and listener attach must kill
        // the child and clean up tracking, else devServerReady stays false
        // forever with a leaked process.
        try {
          devProcess.stdout?.on('data', processOutput);
          devProcess.stderr?.on('data', processOutput);

          devProcess.on('exit', async (code, signal) => {
            // Same identity guard as runTrackedCommand: a replaced dev
            // server (quick close+reopen) must survive the old handle's
            // late 'exit'.
            if (activeProcesses[processId] === devProcess) {
              delete activeProcesses[processId];
            }
            this._untrackSpawnedPid(devProcess.pid);
            this._notifyDevServerUrlWaiters(devProcess.pid, null);
            if (devProcess.pid) {
              await this.removeDocumentalProcess(devProcess.pid);
            }
            if (signal) {
              sendServerOutput(`Development server killed with signal: ${signal}\n`);
              sendStatus('failure');
            } else if (code !== 0) {
              sendServerOutput(`Development server exited with code ${code}\n`);
              sendStatus('failure');
            }
          });

          // Handle process errors
          devProcess.on('error', async (err) => {
            if (activeProcesses[processId] === devProcess) {
              delete activeProcesses[processId];
            }
            this._untrackSpawnedPid(devProcess.pid);
            this._notifyDevServerUrlWaiters(devProcess.pid, null);
            if (devProcess.pid) {
              await this.removeDocumentalProcess(devProcess.pid);
            }
            sendServerOutput(`Failed to start development server: ${err.message}\n`);
            sendStatus('failure');
          });
        } catch (attachError) {
          this.logger.error(`Failed to attach dev server listeners: ${attachError.message}`);
          try {
            devProcess.kill('SIGTERM');
          } catch (killErr) {
            // already exited
          }
          delete activeProcesses[processId];
          if (devProcess.pid) {
            await this.removeDocumentalProcess(devProcess.pid);
          }
          sendServerOutput(`Failed to start development server: ${attachError.message}\n`);
          sendStatus('failure');
          throw attachError;
        }

      } catch (error) {
        // Race 3 fix: kill any spawned child on a later failure; skip when
        // spawn itself rejected (no process to kill).
        if (!spawnFailedEarly && devProcess && devProcess.pid && devProcess.exitCode === null) {
          try {
            devProcess.kill('SIGTERM');
          } catch (killErr) {
            // best-effort
          }
        }
        if (processStarted) {
          delete activeProcesses[`dev-${projectId}`];
          if (devProcess && devProcess.pid) {
            await this.removeDocumentalProcess(devProcess.pid);
          }
        }
        sendServerOutput(`Failed to start development server: ${error.message}\n`);
        sendStatus('failure');
      }

    } catch (error) {
      sendServerOutput(`Failed to start development server: ${error.message}\n`);
      sendStatus('failure');
    }

    // Race 2 fix: success is now signalled only from checkServerReady() once
    // the server is truly ready. The old unconditional sendStatus('success')
    // that fired right after spawn (before URL detection) is intentionally gone.

    sendServerOutput('Development server started in background. Waiting for readiness signal...\n');

    unregisterStartingServer(projectId, startToken);

    return {
      process: devProcess,
      url: devServerUrl
    };
  }

  /**
   * Get global dev server URL
   * @returns {string|null} Global dev server URL
   */
  getGlobalDevServerUrl() {
    this.logger.info('get-dev-server-url-from-main called, returning:', globalDevServerUrl);
    return globalDevServerUrl;
  }

  /**
   * Set global dev server URL
   * @param {string} url - Dev server URL
   */
  setGlobalDevServerUrl(url) {
    globalDevServerUrl = url;
    this.logger.info('Global dev server URL set to:', url);
  }

  /**
   * Get active processes
   * @returns {Object} Active processes object
   */
  getActiveProcesses() {
    return activeProcesses;
  }

  /**
   * Get active Documental processes
   * @returns {Object} Active Documental processes object
   */
  getActiveDocumentalProcesses() {
    return activeDocumentalProcesses;
  }

  /**
   * Kill ALL tracked processes (both regular and Documental) under a lock-guard.
   *
   * Contract:
   *   - acquires the process manager lock before iterating (throws "Process
   *     manager busy: killAll" if another op holds it)
   *   - routes each tracked PID through killPidTree(pid) — Unix process-group
   *     kill (detached spawns) with ESRCH fallback to enumerated descendants,
   *     Windows taskkill /T /F
   *   - uses Promise.allSettled so one failure doesn't short-circuit the rest
   *   - releases the lock in a `finally` block (even on error)
   *   - idempotent: safe to call repeatedly; empty state is a no-op
   *   - swallows ESRCH/EPERM (already-dead processes) so callers don't see them
   *
   * @param {number} [gracePeriod=1500] - Grace period in ms forwarded to killPidTree
   * @returns {Promise<void>}
   */
  async killAll(gracePeriod = 1500) {
    acquireProcessManagerLock('killAll');
    try {
      // Snapshot via instance getters (tests override them); read under the lock.
      const regular = this.getActiveProcesses() || {};
      const documental = this.getActiveDocumentalProcesses() || {};

      // A dev server appears both as an execa handle (regular) and as a
      // documental record — dedupe by pid so its tree is only signalled once.
      const pids = new Set();
      for (const proc of Object.values(regular)) {
        if (proc && typeof proc.pid === 'number') {
          pids.add(proc.pid);
        }
      }
      for (const proc of Object.values(documental)) {
        if (proc && typeof proc.pid === 'number') {
          pids.add(proc.pid);
        }
      }

      if (pids.size > 0) {
        // Prefer injected killPidTree (for testability); fall back to lazy
        // require which bypasses vi.mock in CJS context (see learnings Task 11).
        const killFn = this._killPidTree || require('../main/processes/killPidTree').killPidTree;
        const results = await Promise.allSettled(
          [...pids].map((pid) =>
            killFn(pid, gracePeriod).catch((err) => {
              // ESRCH = already dead, EPERM = not ours; both are safe to ignore.
              const code = err && err.code;
              if (code !== 'ESRCH' && code !== 'EPERM') {
                this.logger?.warn?.('killAll: error killing process', err?.message || err);
              }
            })
          )
        );
        const rejected = results.filter((r) => r.status === 'rejected');
        if (rejected.length > 0) {
          this.logger?.warn?.(`killAll: ${rejected.length} process kill(s) rejected`);
        }
      }

      // Clear both maps so repeated calls are idempotent no-ops.
      activeProcesses = {};
      activeDocumentalProcesses = {};
      devServerUrlWaiters = {};
    } finally {
      releaseProcessManagerLock();
    }
  }

  /**
   * Kill process by ID
   * @param {string} processId - Process ID
   * @returns {Promise<boolean>} Success status
   */
  async killProcess(processId) {
    try {
      const process = activeProcesses[processId];
      if (process && !process.killed) {
        // Use platform-specific signals
        const signal = this.platformService.getTerminationSignal();
        process.kill(signal);
        process.killed = true;
        
        // Wait a bit and force kill if still running
        setTimeout(() => {
          if (!process.killed) {
            const forceSignal = this.platformService.getForceTerminationSignal();
            process.kill(forceSignal);
          }
        }, 5000);
        
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error(`Error killing process ${processId}:`, error);
      return false;
    }
  }

  /**
   * Terminate all processes associated with a project
   * @param {number} projectId - Project ID
   */
  async terminateProcessesForProject(projectId) {
    const normalizedId = String(projectId);
    // Startup-race fix: a start still in flight has nothing in
    // activeProcesses for the key loop below — mark its token so the
    // newborn gets terminated at its own post-registration check.
    abortStartingServers(normalizedId);
    const keysToTerminate = Object.keys(this.getActiveProcesses()).filter((key) => {
      return (
        key === normalizedId ||
        key === `build-${normalizedId}` ||
        key.startsWith(`build-${normalizedId}-`) ||
        key === `dev-${normalizedId}` ||
        key === `reopen-${normalizedId}` ||
        key.startsWith(`${normalizedId}-`)
      );
    });

    for (const key of keysToTerminate) {
      await this.terminateProcessByKey(key);
    }
  }

  /**
   * Terminate every process tree of a project (dev-${id}, build-${id}*,
   * reopen-${id} — see the key filter above) routed through killPidTree.
   * Resolves once all trees are finalized; callers that must stay
   * responsive race this promise against a timeout (close-project IPC).
   * @param {string|number} projectId - Project ID
   * @returns {Promise<void>}
   */
  async terminateProjectProcesses(projectId) {
    return this.terminateProcessesForProject(projectId);
  }

  /**
   * Instance accessors for the module-level window→project map so IPC
   * modules consume it through dependency injection instead of a
   * cross-module require (which lands on a different module instance
   * under vitest's CJS bridge than the test-side import).
   */
  dissociateWindow(windowId) {
    return dissociateWindow(windowId);
  }

  getWindowProject(windowId) {
    return getWindowProject(windowId);
  }

  getWindowsUsingProject(projectId) {
    return getWindowsUsingProject(projectId);
  }

  /**
   * Terminate a specific tracked process
   * @param {string} processKey - Process key identifier
   */
  async terminateProcessByKey(processKey) {
    const processRef = this.getActiveProcesses()[processKey];
    if (!processRef) {
      return;
    }

    let finalized = false;
    const finalize = async () => {
      if (finalized) {
        return;
      }
      finalized = true;
      if (processRef.pid) {
        await this.removeDocumentalProcess(processRef.pid);
        this._untrackSpawnedPid(processRef.pid);
      }
      // Identity guard: only drop the slot if it still belongs to the
      // process being terminated (a replaced handle must survive).
      if (activeProcesses[processKey] === processRef) {
        delete activeProcesses[processKey];
      }
      resolvePromise();
    };

    let resolvePromise;
    await new Promise((resolve) => {
      resolvePromise = resolve;

      // If the process already exited, finalize immediately
      if (typeof processRef.exitCode === 'number' || processRef.killed) {
        finalize();
        return;
      }

      const killTree = async () => {
        try {
          // Kill the whole tree (process-group kill for detached spawns,
          // ESRCH fallback with enumerated descendants otherwise).
          // Short grace: well-behaved children exit on SIGTERM; SIGKILL
          // escalates fast so callers are not left waiting.
          const killFn = this._killPidTree || killPidTree;
          await killFn(processRef.pid, 300);
        } catch (error) {
          this.logger.warn(`Error terminating process ${processKey}:`, error);
        }
        await finalize();
      };

      killTree();
    });
  }

  /**
   * Resolve repository path considering nested folders
   * @param {string} projectPath - Base project path
   * @param {string} repoFolderName - Repository folder name
   * @returns {string|null} Resolved repository path
   */
  async resolveRepoPath(projectPath, repoFolderName) {
    if (repoFolderName) {
      if (path.basename(projectPath) === repoFolderName) {
        try {
          await fsp.access(projectPath);
          return projectPath;
        } catch {
          // doesn't exist
        }
      }

      const nestedPath = path.join(projectPath, repoFolderName);
      try {
        await fsp.access(nestedPath);
        return nestedPath;
      } catch {
        // doesn't exist
      }

      try {
        await fsp.access(projectPath);
        await fsp.access(path.join(projectPath, '.git'));
        return projectPath;
      } catch {
        // doesn't exist
      }
    }

    // Security: never return a bare workspace parent folder when repoFolderName
    // is null — cancelProjectCreation would rimraf ALL projects.
    return null;
  }

  /**
   * Cancel project creation and clean up

   * @param {number} projectId - Project ID
   * @param {string} projectPath - Project path
   * @param {string} repoFolderName - Repository folder name
   * @param {Function} sendOutput - Output callback
   * @returns {Promise<void>}
   */
  async cancelProjectCreation(projectId, projectPath, repoFolderName, shouldDeleteFiles, sendOutput) {
    try {
      await this.terminateProcessesForProject(projectId);

      if (!shouldDeleteFiles) {
        if (sendOutput) {
          sendOutput('ℹ️ Project creation canceled. Files preserved as requested.\n');
        }
        return;
      }

      const repoPath = await this.resolveRepoPath(projectPath, repoFolderName);
      let repoPathExists = false;
      try {
        await fsp.access(repoPath);
        repoPathExists = true;
      } catch {
        repoPathExists = false;
      }
      if (repoPath && repoPathExists) {
        // Safety: refuse to delete the workspace root folder itself.
        if (!repoFolderName && repoPath === projectPath) {
          this.logger.warn(`Refusing to delete workspace root: ${repoPath}`);
          if (sendOutput) sendOutput('⚠️ Refusing to delete workspace root folder.\n');
          return;
        }
        if (sendOutput) {
          sendOutput(`🗑️ Removing repository folder: ${repoPath}\n`);
        }
        await rimraf(repoPath);
        if (sendOutput) {
          sendOutput('✅ Repository folder removed successfully\n');
        }
      } else {
        this.logger.warn(`Repository path not found for project ${projectId}, skipping removal`);
        if (sendOutput) {
          sendOutput('⚠️ Repository folder not found, nothing to remove.\n');
        }
      }
    } catch (error) {
      this.logger.error('Error canceling project creation:', error);
      throw error;
    }
  }

}

module.exports = {
  ProcessManager,
  acquireProcessManagerLock,
  releaseProcessManagerLock,
  mapWindowToProject,
  associateWindowWithProject,
  dissociateWindow,
  getWindowProject,
  getWindowsUsingProject
};