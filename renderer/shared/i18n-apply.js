'use strict';
/**
 * @fileoverview Shared i18n scanner for declarative data-i18n attributes.
 * @author Documental Team
 * @since 1.0.0
 */

/** @type {string|undefined} Cached app version ('' when unavailable). */
let cachedAppVersion;

/**
 * Resolve the app version once via the preload bridge (cached). Resolves to
 * '' when the bridge is unavailable (plain-browser dev) or the invoke fails,
 * so callers treat '' as "no version suffix".
 * @returns {Promise<string>}
 */
async function getAppVersion() {
  if (cachedAppVersion !== undefined) return cachedAppVersion;
  try {
    const version = await window.electronAPI?.getAppVersion?.();
    cachedAppVersion = typeof version === 'string' && version.trim() ? version : '';
  } catch (_e) {
    cachedAppVersion = '';
  }
  return cachedAppVersion;
}

/**
 * Append the ` v{version}` suffix to an already-localized title when the
 * app version is available; returns the title unchanged otherwise.
 * @param {string} title - Base (already localized) title
 * @returns {Promise<string>}
 */
async function withVersion(title) {
  const version = await getAppVersion();
  return version ? `${title} v${version}` : title;
}

/**
 * Apply translations to all declarative i18n attributes under rootEl.
 * Supports: data-i18n, data-i18n-placeholder, data-i18n-title, data-i18n-html,
 * and data-i18n-document-title (on <html>).
 * @param {Document|Element} [rootEl] - Root node to scan; defaults to document.
 * @returns {Promise<void>}
 */
async function applyTranslations(rootEl) {
  rootEl = rootEl || (typeof document !== 'undefined' ? document : null);
  if (!rootEl) return;
  if (window.__i18nReady) await window.__i18nReady;

  // [data-i18n] → textContent
  rootEl.querySelectorAll('[data-i18n]').forEach(function (el) {
    el.textContent = window.__t(el.getAttribute('data-i18n'));
  });

  // [data-i18n-placeholder] → placeholder
  rootEl.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
    el.placeholder = window.__t(el.getAttribute('data-i18n-placeholder'));
  });

  // [data-i18n-title] → title
  rootEl.querySelectorAll('[data-i18n-title]').forEach(function (el) {
    el.title = window.__t(el.getAttribute('data-i18n-title'));
  });

  // [data-i18n-html] → innerHTML (for keys containing markup)
  rootEl.querySelectorAll('[data-i18n-html]').forEach(function (el) {
    el.innerHTML = window.__t(el.getAttribute('data-i18n-html'));
  });

  // document.title (if <html data-i18n-document-title> present), with the
  // dynamic app version appended when available
  const docTitleKey = document.documentElement.getAttribute('data-i18n-document-title');
  if (docTitleKey) document.title = await withVersion(window.__t(docTitleKey));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { applyTranslations, withVersion, getAppVersion };
}
if (typeof window !== 'undefined') {
  window.Documental = window.Documental || {};
  window.Documental.applyTranslations = applyTranslations;
  window.Documental.withVersion = withVersion;
}
