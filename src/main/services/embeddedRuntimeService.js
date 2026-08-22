/**
 * @fileoverview Embedded Node runtime resolution, env scrub and spawn helper
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execa } = require('execa');

/**
 * Resolves and spawns the Electron binary as a plain Node.js runtime
 * (ELECTRON_RUN_AS_NODE) and the bundled npm/npx CLIs.
 */
class EmbeddedRuntimeService {
  /**
   * Get the embedded Node executable (Electron binary in as-node mode)
   * @returns {{ command: string, args: string[], envExtra: Object }} Executable descriptor
   */
  getNodeExecutable() {
    return {
      command: process.execPath,
      args: [],
      envExtra: { ELECTRON_RUN_AS_NODE: '1' }
    };
  }

  /**
   * Get the bundled npm executable descriptor
   * @returns {{ command: string, args: string[], envExtra: Object }} Executable descriptor
   */
  getNpmExecutable() {
    return this.getToolExecutable('npm');
  }

  /**
   * Get the bundled npx executable descriptor
   * @returns {{ command: string, args: string[], envExtra: Object }} Executable descriptor
   */
  getNpxExecutable() {
    return this.getToolExecutable('npx');
  }

  /**
   * Build an executable descriptor for a bundled npm-family CLI.
   * Resolution is lazy (call time) so packaging state at import doesn't matter.
   * @param {'npm'|'npx'} tool - Tool name
   * @returns {{ command: string, args: string[], envExtra: Object }} Executable descriptor
   */
  getToolExecutable(tool) {
    const envExtra = { ELECTRON_RUN_AS_NODE: '1' };

    if (tool === 'npm' && process.env.CUSTOM_NPM_PATH) {
      const custom = process.env.CUSTOM_NPM_PATH;
      if (custom.endsWith('.js')) {
        return { command: process.execPath, args: [custom], envExtra };
      }
      return { command: custom, args: [], envExtra };
    }

    const cliPath = this.resolveCliPath(`${tool}-cli.js`);
    return { command: process.execPath, args: [cliPath], envExtra };
  }

  /**
   * Resolve a bundled npm CLI script path
   * @param {string} name - CLI file name (npm-cli.js / npx-cli.js)
   * @returns {string} Absolute path to the CLI script
   * @throws {Error} If the CLI cannot be found
   */
  resolveCliPath(name) {
    try {
      return require.resolve(`npm/bin/${name}`);
    } catch {
      // Fall through to packaged-app candidates
    }

    const candidates = [];
    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin', name),
        path.join(process.resourcesPath, 'app', 'node_modules', 'npm', 'bin', name)
      );
    }
    candidates.push(
      path.join(process.cwd(), 'node_modules', 'npm', 'bin', name)
    );

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      `Bundled npm CLI not found: ${name}. Ensure the "npm" package is installed as a dependency.`
    );
  }

  /**
   * Build a child environment free of Electron/Node override variables.
   * The single env scrub helper for embedded-runtime spawns.
   * @param {NodeJS.ProcessEnv} [baseEnv=process.env] - Base environment
   * @returns {NodeJS.ProcessEnv} Scrubbed environment with ELECTRON_RUN_AS_NODE set
   */
  buildChildEnv(baseEnv = process.env) {
    const env = {};
    for (const [key, value] of Object.entries(baseEnv)) {
      if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') {
        continue;
      }
      env[key] = value;
    }
    env.ELECTRON_RUN_AS_NODE = '1';
    return env;
  }

  /**
   * Spawn a child process using the embedded runtime's env scrub.
   * All options except `env` are passed through to execa verbatim
   * (killDescendants, cleanup, windowsHide, cwd, stdio, ...).
   * @param {string} cmd - Executable path (no shell interpolation)
   * @param {string[]} args - Arguments array
   * @param {Object} [opts] - execa options; `env` defaults to process.env and is scrubbed
   * @returns {Object} execa subprocess
   */
  spawnNodeChild(cmd, args, opts = {}) {
    const { env, ...rest } = opts;
    return execa(cmd, args, {
      ...rest,
      env: this.buildChildEnv(env || process.env)
    });
  }
}

module.exports = { EmbeddedRuntimeService };
