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
 * @param {Object} childProcess - The child_process module object to patch
 * @param {string} platform - Process platform ('win32' installs the guard)
 * @returns {boolean} Whether the guard was installed
 */
function installWindowsHideGuard(childProcess, platform) {
  if (platform !== 'win32' || childProcess.__windowsHideGuardInstalled) {
    return false;
  }

  const patch = (original) => function guarded(...args) {
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
    return original.apply(this, args);
  };

  ['spawn', 'exec', 'execFile', 'execSync', 'spawnSync', 'fork'].forEach((name) => {
    if (typeof childProcess[name] === 'function') {
      childProcess[name] = patch(childProcess[name]);
    }
  });
  childProcess.__windowsHideGuardInstalled = true;
  return true;
}

module.exports = { installWindowsHideGuard };
