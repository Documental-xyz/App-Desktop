'use strict';
/**
 * @fileoverview Shared modal resilience guards.
 * @author Documental Team
 * @since 1.0.0
 *
 * invokeWithTimeout: races a promise against a deadline so a hung IPC
 * invoke can never freeze modal opening. Rejects with Error('IPC timeout…')
 * on timeout; the underlying promise is left to settle on its own.
 */
(function () {
  /**
   * Race a promise against a deadline.
   * @param {Promise<*>} promise - Promise to bound (typically an ipcRenderer.invoke)
   * @param {number} ms - Deadline in milliseconds
   * @returns {Promise<*>} The promise's value, or a rejection on timeout
   */
  function invokeWithTimeout(promise, ms) {
    let timer = null;
    return Promise.race([
      promise,
      new Promise(function (_resolve, reject) {
        timer = setTimeout(function () {
          reject(new Error('IPC timeout after ' + ms + 'ms'));
        }, ms);
      }),
    ]).finally(function () {
      if (timer !== null) clearTimeout(timer);
    });
  }

  if (typeof window !== 'undefined') {
    window.Documental = window.Documental || {};
    window.Documental.invokeWithTimeout = invokeWithTimeout;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { invokeWithTimeout };
  }
})();
