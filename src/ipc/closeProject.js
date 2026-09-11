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
 * Delay between webContents.send('app-exiting') and window.close() in
 * _forceCloseWindow. IPC delivery to the renderer is asynchronous, so
 * closing in the same tick would let the close-induced beforeunload run
 * before the renderer's 'app-exiting' listener armed its suppression
 * flag. setImmediate only yields the MAIN loop (probe-validated: the
 * close task consistently wins over the queued renderer message), while
 * a short real-time flush gives the renderer's event loop a window to
 * process the message first — 50ms covers cross-process delivery plus a
 * busy renderer with margin. The delay sits entirely outside the invoke
 * response path (closes are fire-and-forget), so it never eats into
 * CLOSE_PROJECT_KILL_TIMEOUT_MS.
 * @type {number}
 */
const FORCE_CLOSE_FLUSH_MS = 50;

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
   * @param {number} [dependencies.forceCloseFlushMs] - app-exiting flush delay (tests)
   */
  constructor({
    logger,
    processManager,
    killTimeoutMs = CLOSE_PROJECT_KILL_TIMEOUT_MS,
    forceCloseFlushMs = FORCE_CLOSE_FLUSH_MS
  }) {
    this.logger = logger;
    this.processManager = processManager;
    this.killTimeoutMs = killTimeoutMs;
    this.forceCloseFlushMs = forceCloseFlushMs;
    /** Project ids with a mode-driven close decision in flight (E3). */
    this.closingProjectIds = new Set();
  }

  /**
   * Dissociate a window from its project and, when no other window still
   * uses that project, terminate its process trees. Never rejects and never
   * runs longer than this.killTimeoutMs.
   * @param {number|null} windowId - Sender window id (null when unknown)
   * @param {string|number} projectId - Project being closed
   * @param {('this-window'|'all-windows')|undefined} [mode] - Close mode;
   *   absent/undefined/null keeps the legacy single-window semantics
   *   byte-identical (G1). 'this-window' = sender-only close with a
   *   server-side last-window re-check (E4); 'all-windows' = kill
   *   everything + programmatic close of the project's other windows.
   * @returns {Promise<{killed: boolean, reason?: string, becameLast?: boolean, closedOthers?: number}>} Outcome
   */
  async closeProject(windowId, projectId, mode) {
    if (projectId === null || projectId === undefined || projectId === '') {
      return { killed: false, reason: 'no-project' };
    }
    const normalizedId = String(projectId);

    if (mode === 'this-window') {
      return this._closeProjectThisWindow(windowId, normalizedId);
    }
    if (mode === 'all-windows') {
      return this._closeProjectAllWindows(windowId, normalizedId);
    }
    if (mode !== undefined && mode !== null) {
      this.logger.warn(`[close-project] unknown mode "${mode}" for project ${normalizedId} — refusing`);
      return { killed: false, reason: 'invalid-mode' };
    }

    // The sender window is leaving the project — drop its association
    // before counting the remaining users.
    if (windowId !== null && windowId !== undefined) {
      this.processManager.dissociateWindow(windowId);
    }

    if (this.processManager.getWindowsUsingProject(normalizedId).length > 0) {
      this.logger.info(`[close-project] project ${normalizedId} still in use by another window — keeping its processes alive`);
      return { killed: false, reason: 'in-use' };
    }

    const killed = await this._terminateAndRecalculate(normalizedId);
    return killed ? { killed: true } : { killed: false, reason: 'timeout' };
  }

  /**
   * mode 'this-window': the sender leaves the project; the trees die only
   * when no other live window still uses it (server-side re-check — the
   * count may have dropped between the modal opening and the click, E4).
   * @param {number|null} windowId - Sender window id
   * @param {string} normalizedId - Project id (already normalized)
   * @returns {Promise<{killed: boolean, reason?: string, becameLast?: boolean}>}
   */
  async _closeProjectThisWindow(windowId, normalizedId) {
    if (windowId !== null && windowId !== undefined) {
      this.processManager.dissociateWindow(windowId);
    }

    if (this.processManager.getWindowsUsingProject(normalizedId).length > 0) {
      this.logger.info(`[close-project] project ${normalizedId} still in use by another window — keeping its processes alive`);
      return { killed: false, reason: 'in-use' };
    }

    if (this.closingProjectIds.has(normalizedId)) {
      this.logger.info(`[close-project] project ${normalizedId} already being closed by another window`);
      return { killed: false, reason: 'already-closing' };
    }
    this.closingProjectIds.add(normalizedId);
    try {
      const killed = await this._terminateAndRecalculate(normalizedId);
      return killed
        ? { killed: true, becameLast: true }
        : { killed: false, reason: 'timeout', becameLast: true };
    } finally {
      this.closingProjectIds.delete(normalizedId);
    }
  }

  /**
   * mode 'all-windows': every window of the project leaves (G4), the trees
   * die unconditionally, and the OTHER windows (never the sender) are
   * closed programmatically with exit-prompt suppression. Closes are
   * fire-and-forget AFTER the kill decision so a stuck window can never
   * delay the invoke response (G7/AC5).
   * @param {number|null} windowId - Sender window id
   * @param {string} normalizedId - Project id (already normalized)
   * @returns {Promise<{killed: boolean, reason?: string, closedOthers: number}>}
   */
  async _closeProjectAllWindows(windowId, normalizedId) {
    if (this.closingProjectIds.has(normalizedId)) {
      this.logger.info(`[close-project] project ${normalizedId} already being closed by another window`);
      return { killed: false, reason: 'already-closing' };
    }
    this.closingProjectIds.add(normalizedId);
    try {
      // Capture the other windows BEFORE dissociating — the map is the
      // source of truth for who still uses the project.
      const otherWindowIds = this.processManager
        .getWindowsUsingProject(normalizedId)
        .filter((id) => id !== windowId);
      const otherWindows = [];
      for (const otherId of otherWindowIds) {
        this.processManager.dissociateWindow(otherId);
        const window = this._windowFromId(otherId);
        if (window) {
          otherWindows.push(window);
        }
      }
      if (windowId !== null && windowId !== undefined) {
        this.processManager.dissociateWindow(windowId);
      }

      const killed = await this._terminateAndRecalculate(normalizedId);

      for (const window of otherWindows) {
        this._forceCloseWindow(window);
      }

      return killed
        ? { killed: true, closedOthers: otherWindows.length }
        : { killed: false, reason: 'timeout', closedOthers: otherWindows.length };
    } finally {
      this.closingProjectIds.delete(normalizedId);
    }
  }

  /**
   * Terminate the project's trees within this.killTimeoutMs and refresh
   * the global dev-server URL afterwards. Shared by every close path.
   * @param {string} normalizedId - Project id (already normalized)
   * @returns {Promise<boolean>} Whether the kill finalized inside the budget
   */
  async _terminateAndRecalculate(normalizedId) {
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
    return killed;
  }

  /**
   * Resolve a live BrowserWindow from its id.
   * @param {number} windowId - BrowserWindow id
   * @returns {Electron.BrowserWindow|null} null when gone or destroyed
   */
  _windowFromId(windowId) {
    try {
      const window = BrowserWindow.fromId(windowId);
      return window && !window.isDestroyed() ? window : null;
    } catch (error) {
      this.logger.warn(`[close-project] resolving window ${windowId} failed:`, error?.message || error);
      return null;
    }
  }

  /**
   * Close a window programmatically without triggering its beforeunload
   * exit confirmation: arm the renderer's suppression flag through the
   * existing 'app-exiting' channel (per-window send — never a broadcast,
   * E5), then close after the forceCloseFlushMs delay so the renderer's
   * listener runs BEFORE the close-induced beforeunload (G3). Uses
   * close(), never destroy(), so the normal window lifecycle hooks fire.
   * @param {Electron.BrowserWindow} window - Target window (never the sender)
   */
  _forceCloseWindow(window) {
    if (!window || window.isDestroyed()) {
      return;
    }
    const windowId = window.id;
    try {
      window.webContents.send('app-exiting');
    } catch (error) {
      this.logger.warn(`[close-project] sending app-exiting to window ${windowId} failed:`, error?.message || error);
    }
    setTimeout(() => {
      try {
        if (!window.isDestroyed()) {
          window.close();
        }
      } catch (error) {
        this.logger.warn(`[close-project] force-closing window ${windowId} failed:`, error?.message || error);
      }
    }, this.forceCloseFlushMs);
  }

  /**
   * Count the live windows still using a project. Includes the CALLING
   * window (mapped by the time it asks — AC1); the renderer treats
   * count >= 2 as "there are other windows" for the modal variant.
   * @param {string|number} projectId - Project id
   * @returns {{count: number}}
   */
  getProjectWindowCount(projectId) {
    if (projectId === null || projectId === undefined || projectId === '') {
      return { count: 0 };
    }
    return { count: this.processManager.getWindowsUsingProject(String(projectId)).length };
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
   * Register the close-project IPC handlers
   */
  registerHandlers() {
    this.logger.info('🔒 Registering close-project IPC handler');

    ipcMain.handle('close-project', async (event, projectId, mode) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const windowId = window && !window.isDestroyed() ? window.id : null;
      return this.closeProject(windowId, projectId, mode);
    });

    ipcMain.handle('get-project-window-count', (event, projectId) => {
      return this.getProjectWindowCount(projectId);
    });

    this.logger.info('✅ close-project IPC handler registered');
  }

  /**
   * Unregister the close-project IPC handlers
   */
  unregisterHandlers() {
    this.logger.info('🔒 Unregistering close-project IPC handler');
    ipcMain.removeHandler('close-project');
    ipcMain.removeHandler('get-project-window-count');
    this.logger.info('✅ close-project IPC handler unregistered');
  }
}

module.exports = { CloseProjectHandlers, CLOSE_PROJECT_KILL_TIMEOUT_MS, FORCE_CLOSE_FLUSH_MS };
