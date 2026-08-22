/**
 * @fileoverview On-demand managed-runtime fallback for the embedded runtime
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

/**
 * Orchestrates the embedded-runtime fallback flow: when an embedded spawn
 * fails, reuse the managed Node runtime under userData/node-runtime if valid,
 * or download it (at most once per app session) via nodeRuntimeManager,
 * forwarding install progress on the existing 'node:install-progress' IPC
 * channel. Concurrent triggers share a single installation.
 */
class EmbeddedFallbackService {
  /**
   * Create fallback orchestrator
   * @param {Object} dependencies - Dependency container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.nodeDetectionService - Detection service (owns the runtime manager)
   */
  constructor({ logger, nodeDetectionService }) {
    this.logger = logger;
    this.nodeDetectionService = nodeDetectionService;
    /** @type {Promise<Object>|null} Cached managed-runtime availability (per app session) */
    this.sessionRuntimePromise = null;
  }

  /**
   * Forward install progress to every renderer window on the existing
   * 'node:install-progress' channel ({stage, message, percent} contract).
   * No-op outside Electron (tests/harnesses).
   * @param {{stage: string, message: string, percent: number}} payload - Progress event
   */
  broadcastProgress(payload) {
    let BrowserWindow;
    try {
      ({ BrowserWindow } = require('electron'));
    } catch {
      return;
    }
    if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
      return;
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('node:install-progress', payload);
      }
    }
  }

  /**
   * Ensure a valid managed runtime exists, downloading it at most once per
   * app session. Concurrent callers share the same installation (the runtime
   * manager's installation lock also deduplicates). A failed install clears
   * the session cache so a later spawn can retry.
   * @returns {Promise<Object>} Managed runtime info (installed and valid)
   */
  ensureManagedRuntime() {
    if (!this.sessionRuntimePromise) {
      this.sessionRuntimePromise = this.nodeDetectionService
        .installManagedRuntime({
          onProgress: (payload) => this.broadcastProgress(payload)
        })
        .then((runtime) => {
          if (!runtime.installed || !runtime.isValid) {
            throw new Error(`Managed runtime invalid after install: ${JSON.stringify(runtime)}`);
          }
          return runtime;
        })
        .catch((error) => {
          this.sessionRuntimePromise = null;
          throw error;
        });
    }
    return this.sessionRuntimePromise;
  }
}

module.exports = { EmbeddedFallbackService };
