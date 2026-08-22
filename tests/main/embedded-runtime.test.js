/**
 * @fileoverview Unit tests for the embedded Node runtime service
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { EmbeddedRuntimeService } from '../../src/main/services/embeddedRuntimeService.js';

// Note: vi.mock('execa') cannot intercept the service's CJS `require('execa')`
// in this setup (probed: the real execa runs regardless). execa is therefore
// exercised for real, spawning process.execPath — plain Node under vitest.
// Also: tests/setup.js globally mocks 'fs' and 'path', so we use node:module's
// createRequire (native, unmocked) to verify CLI paths actually resolve.

const realRequire = createRequire(import.meta.url);
const npmCliRe = /node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/;
const npxCliRe = /node_modules[\\/]npm[\\/]bin[\\/]npx-cli\.js$/;

describe('EmbeddedRuntimeService', () => {
  let service;
  let savedCustomNpmPath;

  beforeEach(() => {
    service = new EmbeddedRuntimeService();
    savedCustomNpmPath = process.env.CUSTOM_NPM_PATH;
    delete process.env.CUSTOM_NPM_PATH;
  });

  afterEach(() => {
    if (savedCustomNpmPath === undefined) {
      delete process.env.CUSTOM_NPM_PATH;
    } else {
      process.env.CUSTOM_NPM_PATH = savedCustomNpmPath;
    }
  });

  describe('buildChildEnv', () => {
    it('removes all ELECTRON_* vars and NODE_OPTIONS, keeps unrelated vars, sets ELECTRON_RUN_AS_NODE=1', () => {
      const baseEnv = {
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NO_ATTACH_CONSOLE: '1',
        ELECTRON_ENABLE_LOGGING: 'yes',
        NODE_OPTIONS: '--inspect-brk',
        PATH: '/usr/local/bin:/usr/bin',
        HOME: '/home/user',
        MY_APP_VAR: 'untouched'
      };

      const env = service.buildChildEnv(baseEnv);

      // All ELECTRON_* vars scrubbed, then the flag re-set explicitly
      expect(Object.keys(env).filter((k) => k.startsWith('ELECTRON_'))).toEqual([
        'ELECTRON_RUN_AS_NODE'
      ]);
      expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
      expect(env.NODE_OPTIONS).toBeUndefined();
      // Unrelated vars preserved verbatim
      expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
      expect(env.HOME).toBe('/home/user');
      expect(env.MY_APP_VAR).toBe('untouched');
    });

    it('with a clean base env produces minimal env containing just the flag', () => {
      expect(service.buildChildEnv({})).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    });
  });

  describe('getNpmExecutable / getNpxExecutable', () => {
    it('resolves npm: command is execPath, args point to a resolvable npm-cli.js', () => {
      const { command, args, envExtra } = service.getNpmExecutable();
      expect(command).toBe(process.execPath);
      expect(args).toHaveLength(1);
      expect(args[0].match(npmCliRe)).toBeTruthy();
      expect(() => realRequire.resolve(args[0])).not.toThrow();
      expect(envExtra).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    });

    it('resolves npx: command is execPath, args point to a resolvable npx-cli.js', () => {
      const { command, args } = service.getNpxExecutable();
      expect(command).toBe(process.execPath);
      expect(args[0].match(npxCliRe)).toBeTruthy();
      expect(() => realRequire.resolve(args[0])).not.toThrow();
    });

    it('CUSTOM_NPM_PATH ending in .js runs via execPath with the custom script as arg', () => {
      process.env.CUSTOM_NPM_PATH = '/opt/custom/npm-cli.js';
      const { command, args, envExtra } = service.getNpmExecutable();
      expect(command).toBe(process.execPath);
      expect(args).toEqual(['/opt/custom/npm-cli.js']);
      expect(envExtra).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    });

    it('CUSTOM_NPM_PATH not ending in .js is used directly as the command', () => {
      process.env.CUSTOM_NPM_PATH = '/usr/local/bin/npm';
      const { command, args } = service.getNpmExecutable();
      expect(command).toBe('/usr/local/bin/npm');
      expect(args).toEqual([]);
    });

    it('CUSTOM_NPM_PATH does not affect npx resolution', () => {
      process.env.CUSTOM_NPM_PATH = '/opt/custom/npm-cli.js';
      const { args } = service.getNpxExecutable();
      expect(args[0].match(npxCliRe)).toBeTruthy();
    });
  });

  describe('getNodeExecutable', () => {
    it('returns execPath with no args and ELECTRON_RUN_AS_NODE envExtra', () => {
      expect(service.getNodeExecutable()).toEqual({
        command: process.execPath,
        args: [],
        envExtra: { ELECTRON_RUN_AS_NODE: '1' }
      });
    });
  });

  describe('spawnNodeChild (real spawn of process.execPath)', () => {
    it('passes options through verbatim (cwd observed in child) and scrubs env', async () => {
      const result = await service.spawnNodeChild(process.execPath, ['-p', 'process.cwd()'], {
        cwd: '/tmp',
        windowsHide: true,
        killDescendants: true,
        env: {
          PATH: '/bin',
          NODE_OPTIONS: '--inspect',
          ELECTRON_ENABLE_LOGGING: '1',
          SPAWN_PROBE: 'hello'
        }
      });

      // cwd passed through verbatim
      expect(result.stdout.trim()).toBe('/tmp');
      // Env scrubbed and child exited cleanly despite Electron/Node overrides in base env
      expect(result.exitCode).toBe(0);
    });

    it('scrubs env: leaked parent vars are not merged back (extendEnv: false)', async () => {
      process.env.NODE_OPTIONS = '--foo';
      process.env.ELECTRON_NO_ATTACH_CONSOLE = '1';
      try {
        const script =
          'process.env.NODE_OPTIONS === undefined && ' +
          'process.env.ELECTRON_NO_ATTACH_CONSOLE === undefined && ' +
          "process.env.ELECTRON_RUN_AS_NODE === '1'";
        const result = await service.spawnNodeChild(process.execPath, ['-p', script], {
          env: { PATH: '/bin' }
        });
        expect(result.stdout.trim()).toBe('true');
        expect(result.exitCode).toBe(0);
      } finally {
        delete process.env.NODE_OPTIONS;
        delete process.env.ELECTRON_NO_ATTACH_CONSOLE;
      }
    });

    it('defaults to scrubbed process.env when no env option is given', async () => {
      process.env.SPAWN_TEST_MARKER = 'present';
      try {
        const result = await service.spawnNodeChild(process.execPath, [
          '-p',
          'process.env.ELECTRON_RUN_AS_NODE + "/" + process.env.SPAWN_TEST_MARKER'
        ]);
        expect(result.stdout.trim()).toBe('1/present');
      } finally {
        delete process.env.SPAWN_TEST_MARKER;
      }
    });
  });
});
