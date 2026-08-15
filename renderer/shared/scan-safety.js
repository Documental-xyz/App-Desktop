'use strict';

/**
 * @fileoverview Shared scan-safety helpers for renderer pages.
 * Provides runWithSafetyTimeout() — an atomic safety timeout that propagates
 * work rejections to the caller and never leaves an unhandled rejection —
 * and createEpoch() — a stale-async-continuation guard for flows that can be
 * re-entered (e.g. "Try Again" while a previous scan is still pending).
 *
 * Plain browser global: loads as a classic <script> and assigns
 * window.ScanSafety. No require/import/module.exports and no build step —
 * matches the renderer/shared/* pattern (see zoom.js, i18n-apply.js).
 * @author Documental Team
 * @since 1.0.0
 */

(function () {
  /**
   * Guards async flows against stale continuations. Tokens are plain objects
   * compared by identity. Capture a token via current() at flow start, call
   * advance() when a NEW flow begins (or create a fresh epoch), and gate
   * every await continuation on isCurrent(token).
   * @returns {{current: function(): Object,
   *   isCurrent: function(Object): boolean,
   *   advance: function(): Object}}
   */
  function createEpoch() {
    var token = {};
    return {
      current: function () {
        return token;
      },
      isCurrent: function (candidate) {
        return candidate === token;
      },
      advance: function () {
        token = {};
        return token;
      }
    };
  }

  /**
   * Runs fn under a safety timeout.
   * - fn settles first (resolved): resolves { status: 'ok', value } and the
   *   timer is cleared.
   * - fn settles first (rejected): the rejection PROPAGATES to the returned
   *   promise (the caller catches it) and the timer is cleared.
   * - timeoutMs elapses first: resolves { status: 'timeout' }.
   *
   * The losing promise is never discarded silently: when the timeout fires
   * first, a no-op catch is attached to the still-pending work promise so a
   * LATE rejection is consumed — it can never surface as an unhandled
   * rejection — and any late settlement is ignored by design.
   *
   * @param {function(): (Promise<*>|*)} fn Work to guard; may return a
   *   promise or a plain value.
   * @param {number} timeoutMs Safety timeout in ms. The CALLER supplies this
   *   (e.g. 120000 for the whole repo-select init); nothing is hardcoded here.
   * @returns {Promise<{status: 'ok', value: *}|{status: 'timeout'}>}
   */
  function runWithSafetyTimeout(fn, timeoutMs) {
    var outcome = Promise.resolve().then(fn);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        // Consume a late rejection of the losing promise so it never becomes
        // an unhandled rejection; its late settlement is ignored by design.
        outcome.catch(function () {});
        resolve({ status: 'timeout' });
      }, timeoutMs);

      // Two-arg form: the derived promise always settles (both handlers
      // return), so a work rejection can never surface as an unhandled
      // rejection through the ok-handler branch.
      outcome.then(
        function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: 'ok', value: value });
        },
        function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  window.ScanSafety = {
    createEpoch: createEpoch,
    runWithSafetyTimeout: runWithSafetyTimeout
  };
})();
