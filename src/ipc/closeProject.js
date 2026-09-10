/**
 * @fileoverview IPC handler for closing a project workspace: "Fechar
 * Ambiente" (renderer/main.html confirmCloseProject) and the close of a
 * secondary window mapped to a project. Terminates the project's process
 * trees only when no other window still uses it.
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain, BrowserWindow } = require('electron');

/**
 * Upper bound for the invoke response. The kill itself is fire-and-forget:
 * when this deadline is hit the tree kill continues in the background and
 * the handler answers { killed: false, reason: 'timeout' }.
 * @type {number}
 */
const CLOSE_PROJECT_KILL_TIMEOUT_MS = 1500;

/**
 * Close Project IPC Handlers
 */
class CloseProjectHandlers {
  /**
   * Create an instance of CloseProjectHandlers
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.processManager - Process manager instance
   * @param {number} [dependencies.killTimeoutMs] - Kill wait budget (tests)
   */
  constructor({ logger, processManager, killTimeoutMs = CLOSE_PROJECT_KILL_TIMEOUT_MS }) {
    this.logger = logger;
    this.processManager = processManager;
    this.killTimeoutMs = killTimeoutMs;
  }

  /**
   * Dissociate a window from its project and, when no other window still
   * uses that project, terminate its process trees. Never rejects and never
   * runs longer than this.killTimeoutMs.
   * @param {number|null} windowId - Sender window id (null when unknown)
   * @param {string|number} projectId - Project being closed
   * @returns {Promise<{killed: boolean, reason?: string}>} Outcome
   */
  async closeProject(windowId, projectId) {
    if (projectId === null || projectId === undefined || projectId === '') {
      return { killed: false, reason: 'no-project' };
    }
    const normalizedId = String(projectId);

    // The sender window is leaving the project — drop its association
    // before counting the remaining users.
    if (windowId !== null && windowId !== undefined) {
      this.processManager.dissociateWindow(windowId);
    }

    if (this.processManager.getWindowsUsingProject(normalizedId).length > 0) {
      this.logger.info(`[close-project] project ${normalizedId} still in use by another window — keeping its processes alive`);
      return { killed: false, reason: 'in-use' };
    }

    const killPromise = this.processManager.terminateProjectProcesses(normalizedId)
      .catch((error) => {
        this.logger.warn(`[close-project] kill failed for project ${normalizedId}:`, error?.message || error);
      });
    const killed = await Promise.race([
      killPromise.then(() => true),
      new Promise((resolve) => {
        setTimeout(() => resolve(false), this.killTimeoutMs);
      }),
    ]);
    if (!killed) {
      this.logger.warn(`[close-project] kill for project ${normalizedId} still pending after ${this.killTimeoutMs}ms — continuing in background`);
    }

    this.recalculateGlobalDevServerUrl(normalizedId);
    return killed ? { killed: true } : { killed: false, reason: 'timeout' };
  }

  /**
   * Recompute globalDevServerUrl from the tracked dev servers that survive
   * the closed project (most recently started first) and broadcast it to the
   * remaining windows when it changed. No-op when the global URL belonged to
   * a server that is still alive.
   * @param {string|number} excludedProjectId - Project whose server went away
   */
  recalculateGlobalDevServerUrl(excludedProjectId) {
    const current = this.processManager.getGlobalDevServerUrl();
    const remaining = Object.values(this.processManager.getActiveDocumentalProcesses() || {})
      .filter((proc) => proc && String(proc.projectId) !== String(excludedProjectId) && (proc.url || proc.port))
      .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    const nextUrl = remaining.length > 0
      ? (remaining[0].url || `http://localhost:${remaining[0].port}/`)
      : null;
    if (nextUrl === current) {
      return;
    }
    this.processManager.setGlobalDevServerUrl(nextUrl);
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send('dev-server-url', nextUrl);
      }
    });
    this.logger.info(`[close-project] dev-server-url recalculated after closing project ${excludedProjectId}: ${nextUrl}`);
  }

  /**
   * Register the close-project IPC handler
   */
  registerHandlers() {
    this.logger.info('🔒 Registering close-project IPC handler');

    ipcMain.handle('close-project', async (event, projectId) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const windowId = window && !window.isDestroyed() ? window.id : null;
      return this.closeProject(windowId, projectId);
    });

    this.logger.info('✅ close-project IPC handler registered');
  }

  /**
   * Unregister the close-project IPC handler
   */
  unregisterHandlers() {
    this.logger.info('🔒 Unregistering close-project IPC handler');
    ipcMain.removeHandler('close-project');
    this.logger.info('✅ close-project IPC handler unregistered');
  }
}

module.exports = { CloseProjectHandlers, CLOSE_PROJECT_KILL_TIMEOUT_MS };
