'use strict';

/**
 * Native require() bridge for vitest's vi.mock registry and the shared
 * electron stub.
 *
 * Companion to `resolve.alias` in vitest.config.mjs (which only covers
 * vite-processed ESM imports). Synchronous CJS `require()` inside src/
 * modules bypasses the vite resolver, so `vi.mock(...)` factories registered
 * by test files never reach those requires — outside Electron the bare
 * `require('electron')` even resolves to the real npm package, whose only
 * export is a path string.
 *
 * This hook (loaded as a vitest setupFile, so it runs inside each worker)
 * patches `Module._load` and, for every require:
 *
 *  1. If vitest's mock registry (globalThis.__vitest_mocker__) holds a
 *     MANUAL mock whose registered id matches the request (builtins via
 *     `node:` prefix; relative requests via their project-root-relative
 *     path; the bare `electron` via the alias-resolved stub path), resolve
 *     the factory and return its exports. This gives vi.mock factories the
 *     same precedence over native requires that they already have over ESM
 *     imports in the vitest pipeline.
 *  2. If the request is `electron` with no registered mock, return the
 *     shared stub (tests/__mocks__/electron.js) — a Proxy over
 *     `global.mockElectron` (from tests/setup.js) with safe fallbacks.
 *  3. Everything else is delegated to the original Module._load untouched.
 */

const path = require('path');
const nodeModule = require('node:module');
const { asConstructable } = require('./electron-constructor.cjs');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const STUB_PATH = path.resolve(__dirname, 'electron.js');

if (!globalThis.__ELECTRON_NATIVE_REQUIRE_HOOK__) {
  globalThis.__ELECTRON_NATIVE_REQUIRE_HOOK__ = true;

  const originalLoad = nodeModule._load;
  const pristineResolveFilename = nodeModule._resolveFilename;
  let stubInstance;

  function seededElectronExports(parent) {
    // Some suites deliberately seed require.cache at the REAL resolved
    // electron path with their own exports (the documented Wave-1
    // workaround for vi.mock not reaching CJS requires — e.g.
    // tests/integration/preview-branch-sync.integration.test.js). Those
    // seeds must keep winning over vi.mock factories and the stub.
    try {
      const realPath = pristineResolveFilename.call(nodeModule, 'electron', parent);
      const cached = nodeModule._cache[realPath];
      if (cached && cached.loaded && cached.exports) {
        return cached.exports;
      }
    } catch {
      /* resolution failed — no seed */
    }
    return undefined;
  }

  function getRegistry() {
    const mocker = globalThis.__vitest_mocker__;
    if (!mocker || typeof mocker.getMockerRegistry !== 'function') {
      return undefined;
    }
    try {
      return mocker.getMockerRegistry();
    } catch {
      return undefined;
    }
  }

  function manualMockFor(url) {
    const registry = getRegistry();
    if (!registry) return undefined;
    try {
      const mock = registry.get(url);
      if (mock && mock.type === 'manual' && typeof mock.resolve === 'function') {
        return mock;
      }
    } catch {
      /* registry not usable — treat as absent */
    }
    return undefined;
  }

  function toRootRel(absolutePath) {
    return absolutePath.slice(ROOT_DIR.length).split(path.sep).join('/');
  }

  function findManualMock(request, parent) {
    // Builtins: vitest registers them as `node:<name>` / raw name.
    if (nodeModule.builtinModules.includes(request)) {
      return manualMockFor(`node:${request}`) || manualMockFor(request);
    }
    if (request === 'electron') {
      // Registered via resolve.alias → stub path, root-relative id.
      const reg = getRegistry();
      if (process.env.DEBUG_EHOOK && reg) {
        console.error('[hook] electron require; keys:', JSON.stringify([...reg.keys()]));
        const m = reg.get(toRootRel(STUB_PATH));
        console.error('[hook] lookup', toRootRel(STUB_PATH), '->', m && m.type, typeof (m && m.resolve));
      }
      return manualMockFor(toRootRel(STUB_PATH));
    }
    if (request.startsWith('.') && parent && typeof parent.filename === 'string') {
      // Relative request: resolve natively (adds the extension), then look
      // up the project-root-relative id vitest registered.
      let resolved;
      try {
        resolved = nodeModule._resolveFilename(request, parent);
      } catch {
        return undefined;
      }
      if (typeof resolved !== 'string' || !resolved.startsWith(ROOT_DIR + path.sep)) {
        return undefined;
      }
      const rootRel = toRootRel(resolved);
      const withoutExt = rootRel.replace(/\.[cm]?js$/, '');
      return manualMockFor(rootRel) || manualMockFor(withoutExt);
    }
    return undefined;
  }

  nodeModule._load = function patchedLoad(request, parent, isMain) {
    const fromNodeModules =
      parent && typeof parent.filename === 'string' && parent.filename.includes('/node_modules/');
    const parentFile = (parent && parent.filename) || '';
    // vitest 4 cannot deliver vi.mock factories to synchronous CJS requires.
    // Repo tests were largely written around that limitation (partial fs/path
    // factories that must NOT reach src), so the bridge is only enabled
    // wholesale for src/services/secureTokenService.js — whose test file
    // provides complete factories and depends on them being delivered.
    // 'electron' is always bridged (factory when registered, stub otherwise)
    // because the bare require otherwise resolves to the real npm package,
    // whose only export is a path string.
    const scopedBridge =
      parentFile.split(path.sep).join('/').includes('src/services/secureTokenService.js');
    const interceptable =
      request === 'electron' ||
      (scopedBridge &&
        (nodeModule.builtinModules.includes(request) || request.startsWith('.')));
    if (!fromNodeModules && interceptable) {
      if (request === 'electron') {
        const seeded = seededElectronExports(parent);
        if (seeded) return seeded;
      }
      const manualMock = findManualMock(request, parent);
      if (manualMock) {
        const exports = manualMock.resolve();
        if (exports && typeof exports.then !== 'function') {
          if (exports && typeof exports === 'object') {
            for (const key of Object.keys(exports)) {
              if (typeof exports[key] === 'function') exports[key] = asConstructable(exports[key]);
            }
          }
          return exports;
        }
        // Async factory: cannot satisfy a synchronous require() — fail
        // loudly rather than silently returning a promise.
        throw new Error(
          `[native-require-hook] vi.mock factory for "${request}" returned a Promise; ` +
            'CJS require() needs a synchronous factory.'
        );
      }
      if (request === 'electron') {
        // Honor virtual electron stubs other suites install by patching
        // Module._resolveFilename and seeding require.cache (e.g.
        // tests/main/node-detection.test.js): a non-node_modules resolution
        // present in the cache wins over the generic stub.
        try {
          const resolved = nodeModule._resolveFilename(request, parent);
          if (
            typeof resolved === 'string' &&
            !resolved.includes('node_modules') &&
            nodeModule._cache[resolved]
          ) {
            return nodeModule._cache[resolved].exports;
          }
        } catch {
          /* fall through to the shared stub */
        }
        stubInstance ??= originalLoad.call(this, STUB_PATH, parent, isMain);
        return stubInstance;
      }
    }
    return originalLoad.apply(this, arguments);
  };
}
