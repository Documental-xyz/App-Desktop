'use strict';

(function () {
  function injectCss(css) {
    if (!css) return;
    var el = document.getElementById('__theme_injected');
    if (!el) {
      el = document.createElement('style');
      el.id = '__theme_injected';
      document.head.appendChild(el);
    }
    el.textContent = css;
  }

  function applyThemeClass(mode) {
    var shouldBeDark;
    if (mode === 'auto') {
      shouldBeDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } else {
      shouldBeDark = mode === 'dark';
    }
    document.documentElement.classList.toggle('dark', shouldBeDark);
  }

  async function initTheme() {
    if (!window.electronAPI || !window.electronAPI.getThemeMode) return;

    try {
      var r = await window.electronAPI.getThemeMode();
      if (!r || !r.success) return;

      var effectiveMode = r.resolvedMode || r.mode;
      applyThemeClass(effectiveMode);
      // CSS injection is handled by main process via regenerateOverrideCss at startup.
      // No IPC round-trip needed here anymore.
    } catch (_e) {}
  }

  function registerThemeChangeListener() {
    if (!window.electronAPI || !window.electronAPI.onThemeChange) return;

    window.electronAPI.onThemeChange(function (data) {
      if (!data || !data.resolvedMode) return;

      applyThemeClass(data.resolvedMode);

      var modeToSend = data.rawMode || 'auto';

      if (window.electronAPI.setThemeMode) {
        window.electronAPI.setThemeMode(modeToSend).then(function (result) {
          if (result && result.css) {
            injectCss(result.css);
          }
        }).catch(function () {});
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initTheme();
      registerThemeChangeListener();
    });
  } else {
    initTheme();
    registerThemeChangeListener();
  }
})();
