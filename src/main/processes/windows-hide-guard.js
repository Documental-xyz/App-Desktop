'use strict';

/**
 * Global Windows console-window guard.
 *
 * Patches the child_process module in-place so that every spawn/exec/execFile/
 * execSync/spawnSync/fork call made AFTER installation forces
 * `windowsHide: true` on win32 — the ultimate safety net against console
 * window flashes (covers unpatched node_modules such as a dugite installed
 * without postinstall, missed call sites, and transitive dependencies).
 *
 * MUST be installed at the very top of main.js, BEFORE any other require,
 * because modules destructure child_process functions at load time
 * (e.g. dugite's build/lib/exec.js) and would otherwise keep pristine
 * references. execa already defaults windowsHide:true and is unaffected.
 *
 * No-op on non-win32 platforms and idempotent on repeated installation.
 *
 * When DOCUMENTAL_DEBUG_SPAWNS === '1', each guarded call appends a debug
 * line (timestamp, fn name, command, truncated args, effective windowsHide)
 * to <userData>/spawn-debug.log; logging never breaks a spawn (try/catch).
 * @param {Object} childProcess - The child_process module object to patch
 * @param {string} platform - Process platform ('win32' installs the guard)
 * @returns {boolean} Whether the guard was installed
 */
function installWindowsHideGuard(childProcess, platform) {
  if (platform !== 'win32' || childProcess.__windowsHideGuardInstalled) {
    return false;
  }

  const patch = (fnName) => {
    const original = childProcess[fnName];
    return function guarded(...args) {
      // Find the existing options object (a plain object that is neither the
      // args array nor a callback) and force windowsHide on it...
      let optionsIndex = -1;
      for (let i = 1; i < args.length; i += 1) {
        const candidate = args[i];
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          optionsIndex = i;
          break;
        }
      }
      if (optionsIndex === -1) {
        // ...or insert one before the callback when absent (spawn/execFile
        // accept (cmd, args, opts, cb); exec accepts (cmd, opts, cb)).
        const insertAt = args.findIndex((a, i) => i > 0 && typeof a === 'function');
        const options = { windowsHide: true };
        if (insertAt === -1) {
          args.push(options);
        } else {
          args.splice(insertAt, 0, options);
        }
      } else {
        args[optionsIndex] = { ...args[optionsIndex], windowsHide: true };
      }
      if (process.env.DOCUMENTAL_DEBUG_SPAWNS === '1') {
        try {
          const electron = require('electron');
          const path = require('path');
          const fs = require('fs');
          const logDir = electron.app.getPath('userData');
          const command = typeof args[0] === 'string' ? args[0] : String(args[0]);
          let argsJson = '[]';
          try {
            argsJson = JSON.stringify(args.slice(1)).slice(0, 300);
          } catch {
            argsJson = '<unserializable>';
          }
          const optsArg = args.find((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a));
          const hide = Boolean(optsArg && optsArg.windowsHide);
          fs.appendFileSync(
            path.join(logDir, 'spawn-debug.log'),
            `${new Date().toISOString()} ${fnName} ${command} ${argsJson} windowsHide=${hide}\n`
          );
        } catch {
          // Logging must never break a spawn.
        }
      }
      return original.apply(this, args);
    };
  };

  ['spawn', 'exec', 'execFile', 'execSync', 'spawnSync', 'fork'].forEach((name) => {
    if (typeof childProcess[name] === 'function') {
      childProcess[name] = patch(name);
    }
  });
  childProcess.__windowsHideGuardInstalled = true;
  return true;
}

module.exports = { installWindowsHideGuard };
