'use strict';

/**
 * @fileoverview electronAPI stub for the visual-consistency Playwright harness.
 * Builds a self-contained init script (installed via page.addInitScript, i.e.
 * executed BEFORE any page script on every navigation/reload) that:
 *
 * 1. reads the fixture mode from `?fixture=short|long|selection` into
 *    `window.__QA_FIXTURE__` (default: short);
 * 2. installs a `window.electronAPI` covering EVERY method the 9 screens call
 *    at load/init (enumerated by grep across renderer/*.html,
 *    renderer/script.js, renderer/i18n.js and renderer/shared/*.js — see
 *    plan Task 2): i18n sync+async, theme mode, welcome auth/node, project
 *    lists/details, repo listing/documental scan, project creation/open
 *    process, config user/backups and the on* event listeners;
 * 3. seeds sessionStorage (`currentProjectId`) that open/create/config read
 *    at init — without it those screens console.error and every geometry
 *    assertion becomes invalid;
 * 4. returns fixture-shaped synthetic data (short: 2 items, long: 64 items,
 *    selection: repo list fully loaded so repo-select's x-show footer is
 *    visible);
 * 5. records + warns about any UNCOVERED method call via a Proxy fallback
 *    ({success:true, data:[]}) so missing coverage is visible in console and
 *    in `window.__QA_STUB_UNCOVERED__`.
 *
 * Also loads real translations from src/locales/en.yaml (via transitive
 * js-yaml — no new dependency) so baseline screenshots render readable text
 * instead of raw i18n keys.
 *
 * @author Documental Team
 * @since 1.0.0
 */

const fs = require('fs');
const path = require('path');

/** Repository root (tests/e2e/visual -> 3 levels up). */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Supported fixture modes. */
const FIXTURE_MODES = ['short', 'long', 'selection'];

/**
 * Best-effort loader for real English translations used by the stub's
 * getTranslationsSync/getTranslations. Falls back to {} (pages then render
 * raw i18n keys — deterministic, still valid for geometry).
 *
 * @returns {object} Nested translation dictionary.
 */
function loadTranslations() {
  try {
    const yaml = require('js-yaml');
    const localePath = path.join(REPO_ROOT, 'src', 'locales', 'en.yaml');
    return yaml.load(fs.readFileSync(localePath, 'utf8')) || {};
  } catch (_e) {
    return {};
  }
}

/**
 * Builds the page init script string. `__QA_TRANSLATIONS_JSON__` is replaced
 * with the serialized dictionary (replace-with-function avoids `$` escaping
 * pitfalls in the JSON payload).
 *
 * @param {object} translations - Nested translation dictionary.
 * @returns {string} JavaScript source for page.addInitScript.
 */
function buildElectronApiInitScript(translations) {
  const translationsJson = JSON.stringify(translations || {});
  return INIT_SCRIPT_TEMPLATE.replace('__QA_TRANSLATIONS_JSON__', () => translationsJson);
}

/**
 * Template of the browser-side init script. Plain ES5 on purpose (runs on
 * every page, before any app script). Kept as a string so it can be injected
 * via addInitScript without sharing closures with the Node side.
 */
const INIT_SCRIPT_TEMPLATE = `
(function () {
  'use strict';
  if (window.__QA_ELECTRON_API_INSTALLED__) return;
  window.__QA_ELECTRON_API_INSTALLED__ = true;

  // --- Fixture mode (URL ?fixture=short|long|selection, default short) ---
  var fixture = 'short';
  try {
    var params = new URLSearchParams(window.location.search);
    var requested = params.get('fixture');
    if (requested === 'short' || requested === 'long' || requested === 'selection') {
      fixture = requested;
    }
  } catch (e) { /* keep default */ }
  window.__QA_FIXTURE__ = fixture;
  window.__QA_STUB_UNCOVERED__ = [];

  var TRANSLATIONS = __QA_TRANSLATIONS_JSON__;

  // --- Synthetic data builders ---
  var OWNERS = [
    { login: 'qa-user', type: 'User' },
    { login: 'documental-org', type: 'Organization' },
    { login: 'acme-org', type: 'Organization' }
  ];

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function makeProjects(count) {
    var list = [];
    for (var i = 1; i <= count; i++) {
      list.push({
        id: 'qa-project-' + i,
        projectName: 'QA Project ' + pad(i) + ' (' + fixture + ')',
        projectPath: '/home/qa/projects/qa-project-' + i,
        repoFolderName: 'repo',
        repoFullName: 'qa-user/docs-' + pad(i),
        createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 27), 12, 0, 0)).toISOString()
      });
    }
    return list;
  }

  function makeRepos(count, allDocumental) {
    var repos = [];
    for (var i = 1; i <= count; i++) {
      var owner = OWNERS[i % OWNERS.length];
      var isDoc = allDocumental || (i % 5 !== 4); /* ~80% documental */
      var name = (isDoc ? 'docs-' : 'misc-') + pad(i);
      repos.push({
        id: i,
        name: name,
        full_name: owner.login + '/' + name,
        private: (i % 7 === 0),
        owner: owner,
        html_url: 'https://github.com/' + owner.login + '/' + name,
        clone_url: 'https://github.com/' + owner.login + '/' + name + '.git',
        updated_at: new Date(Date.UTC(2026, 0, 1 + (i % 27), 12, 0, 0)).toISOString()
      });
    }
    return repos;
  }

  var projectCount = fixture === 'long' ? 64 : 2;
  var repoCount = fixture === 'long' ? 64 : (fixture === 'selection' ? 8 : 2);
  var PROJECTS = makeProjects(projectCount);
  var REPOS = makeRepos(repoCount, fixture === 'selection');
  var DOCUMENTAL_REPOS = REPOS
    .filter(function (r) { return r.name.indexOf('docs-') === 0; })
    .map(function (r) { return r.full_name; });
  var BACKUPS = makeProjects(projectCount).map(function (p, i) {
    return { name: 'backup-' + pad(i + 1), createdAt: p.createdAt, size: 2048 + i };
  });

  // --- Session state that screens read during Alpine init ---
  try {
    if (!sessionStorage.getItem('currentProjectId')) {
      sessionStorage.setItem('currentProjectId', PROJECTS[0].id);
    }
  } catch (e) { /* sessionStorage unavailable — screens degrade gracefully */ }

  var noopListener = function () { return undefined; };

  var api = {
    // navigation (no-op: never navigate away mid-measurement)
    navigateTo: function (page) { window.__QA_STUB_LAST_NAVIGATE__ = page; },

    // i18n (sync pair runs BEFORE Alpine inside i18n.js)
    getAppLocaleSync: function () { return 'en'; },
    getTranslationsSync: function () { return TRANSLATIONS; },
    getAppLocale: function () { return Promise.resolve('en'); },
    getTranslations: function () { return Promise.resolve(TRANSLATIONS); },
    setAppLocale: function () { return Promise.resolve({ success: true }); },

    // theme (theme-init.js + inline pickers)
    getThemeMode: function () {
      return Promise.resolve({ success: true, mode: 'auto', resolvedMode: 'light' });
    },
    setThemeMode: function (mode) {
      return Promise.resolve({ success: true, mode: mode, css: '' });
    },
    onThemeChange: noopListener,
    getOsDarkPreference: function () {
      return Promise.resolve({ success: true, prefersDark: false });
    },

    // welcome (auth check runs in init(); node detection is click-time).
    // authenticated=true with a fully populated userInfo: welcome assigns
    // this.userInfo only when authenticated, and its template dereferences
    // userInfo.avatar_url/.name/.email under x-show (evaluated even when
    // hidden) — a null userInfo pageerrors on load.
    checkGitHubAuth: function () {
      return Promise.resolve({
        authenticated: true,
        userInfo: {
          login: 'qa-user',
          name: 'QA User',
          email: 'qa@example.com',
          avatar_url: '',
          html_url: 'https://github.com/qa-user'
        }
      });
    },
    onNodeInstallProgress: noopListener,
    detectNode: function () {
      return Promise.resolve({ success: true, installed: true, managed: true, version: 'v22.14.0', path: '/stub/bin/node' });
    },
    installManagedNode: function () { return Promise.resolve({ success: true }); },
    completeWelcomeSetup: function () { return Promise.resolve({ success: true }); },
    openExternal: function (url) { window.__QA_STUB_LAST_EXTERNAL__ = String(url); },

    // projects (index + all-projects + script.js at DOMContentLoaded)
    getRecentProjects: function () { return Promise.resolve(PROJECTS); },
    getAllProjects: function () { return Promise.resolve(PROJECTS); },
    getProjectDetails: function (id) {
      var base = PROJECTS[0];
      return Promise.resolve({
        success: true,
        id: id || base.id,
        projectName: base.projectName,
        projectPath: base.projectPath,
        repoFolderName: base.repoFolderName,
        githubUrl: 'https://github.com/' + base.repoFullName + '.git',
        repoUrl: 'https://github.com/' + base.repoFullName
      });
    },
    saveProject: function () { return Promise.resolve({ success: true, id: PROJECTS[0].id, project: PROJECTS[0] }); },
    removeProject: function () { return Promise.resolve({ success: true }); },

    // path helpers (script.js PathUtils)
    joinPath: function () {
      var segments = Array.prototype.slice.call(arguments).filter(Boolean);
      return Promise.resolve(segments.join('/').replace(/\\/{2,}/g, '/'));
    },
    normalizePath: function (filePath) { return Promise.resolve(filePath); },
    getHomeDirectory: function () { return Promise.resolve('/home/qa'); },
    openDirectoryDialog: function () { return Promise.resolve('/home/qa/selected-project'); },

    // repo browsing (repo-select init)
    listUserRepos: function () { return Promise.resolve({ success: true, repos: REPOS }); },
    findDocumentalRepos: function () {
      return Promise.resolve({ success: true, documentalRepos: DOCUMENTAL_REPOS });
    },
    listUserOrgs: function () {
      return Promise.resolve({ success: true, orgs: [{ login: 'documental-org' }, { login: 'acme-org' }] });
    },
    checkRepoExists: function () { return Promise.resolve({ success: true, exists: false }); },
    checkTemplateTargetExists: function () { return Promise.resolve({ success: true, exists: false }); },
    checkProjectExists: function () { return Promise.resolve({ success: true, exists: false }); },
    getFolderInfo: function (folderPath) {
      return Promise.resolve({
        success: true,
        path: folderPath,
        exists: true,
        isGitRepo: true,
        isDocumental: true,
        isEmptyFolder: false
      });
    },

    // project creation/open process (auto-invoked at init by open/create)
    startProjectCreation: function () { return Promise.resolve({ success: true }); },
    reopenProject: function () { return Promise.resolve({ success: true }); },
    openProjectOnlyPreviewAndServer: function () { return Promise.resolve({ success: true }); },
    cancelProjectCreation: function () { return Promise.resolve({ success: true }); },
    onCommandOutput: noopListener,
    onCommandStatus: noopListener,
    onDevServerUrl: noopListener,
    onServerOutput: noopListener,

    // config (init: getUserInfo + loadBackups)
    getUserInfo: function () {
      return Promise.resolve({
        success: true,
        user: { login: 'qa-user', name: 'QA User', email: 'qa@example.com', avatarUrl: '' }
      });
    },
    updateUserInfo: function () { return Promise.resolve({ success: true }); },
    listBackups: function () { return Promise.resolve({ success: true, backups: BACKUPS }); },
    restoreBackup: function () { return Promise.resolve({ success: true }); },
    deleteBackup: function () { return Promise.resolve({ success: true }); },

    // misc
    writeToClipboard: function () { return Promise.resolve({ success: true }); }
  };

  window.electronAPI = new Proxy(api, {
    get: function (target, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
      return function () {
        var argTypes = Array.prototype.slice.call(arguments).map(function (a) {
          return a === null ? 'null' : typeof a;
        });
        window.__QA_STUB_UNCOVERED__.push(prop + '(' + argTypes.join(', ') + ')');
        console.warn('[QA-STUB] uncovered electronAPI method called: ' + prop);
        return Promise.resolve({ success: true, data: [] });
      };
    }
  });
})();
`;

module.exports = {
  FIXTURE_MODES,
  loadTranslations,
  buildElectronApiInitScript
};
