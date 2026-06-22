/**
 * @fileoverview Main-process i18n utility for translating strings outside the renderer
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

let _locale = 'en';
let _cache = {};

function getLocalesDir() {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'src', 'locales');
    if (fs.existsSync(packaged)) return packaged;
  }
  return path.join(process.cwd(), 'src', 'locales');
}

function loadLocale(locale) {
  if (_cache[locale]) return _cache[locale];
  const filePath = path.join(getLocalesDir(), `${locale}.yaml`);
  try {
    if (fs.existsSync(filePath)) {
      const data = yaml.load(fs.readFileSync(filePath, 'utf8'));
      _cache[locale] = data || {};
      return _cache[locale];
    }
  } catch (error) {
    // fall through to default
  }
  if (locale !== 'en') {
    return loadLocale('en');
  }
  return {};
}

function setLocale(locale) {
  _locale = locale || 'en';
}

function getLocale() {
  return _locale;
}

/**
 * Translate a dot-path key using the current locale.
 * Supports {placeholder} interpolation.
 * @param {string} key - Dot-separated key (e.g. "create.fork_creating")
 * @param {Object} [vars] - Interpolation variables
 * @returns {string} Translated string (falls back to key if not found)
 */
function t(key, vars) {
  const translations = loadLocale(_locale);
  const parts = key.split('.');
  let val = translations;
  for (const p of parts) {
    if (val === null || val === undefined) break;
    val = val[p];
  }
  if (typeof val !== 'string') {
    return key;
  }
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      val = val.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    }
  }
  return val;
}

module.exports = { t, setLocale, getLocale };
