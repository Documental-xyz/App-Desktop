/**
 * @fileoverview Detection precedence + wizard contract tests for the
 * embedded-first NodeDetectionService rework (Task 7 / Task 11).
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

// NodeRuntimeManager (constructed by NodeDetectionService) calls
// app.getPath('userData') at construction time; under plain node
// require('electron') resolves to a path string. Stub the resolver
// BEFORE the service graph loads (learnings: Module._resolveFilename hook).
const require2 = createRequire(import.meta.url);
const Module = require2('node:module');
const ELECTRON_STUB_KEY = 'electron-stub-documental';
require2.cache[ELECTRON_STUB_KEY] = {
  id: ELECTRON_STUB_KEY,
  filename: ELECTRON_STUB_KEY,
  loaded: true,
  exports: { app: { getPath: () => '/tmp/opencode/documental-test-userData' } }
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(request, ...rest) {
  if (request === 'electron') {
    return ELECTRON_STUB_KEY;
  }
  return originalResolveFilename.call(this, request, ...rest);
};

const { NodeDetectionService } = await import('../../src/main/services/nodeDetectionService.js');

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const managedRuntimeInfo = {
  installed: true,
  isValid: true,
  version: '20.12.0',
  npmVersion: '10.5.0',
  nodePath: '/userData/node-runtime/linux/x64/bin/node',
  npmPath: '/userData/node-runtime/linux/x64/bin/npm',
  major: 20,
  minor: 12,
  patch: 0
};

describe('NodeDetectionService precedence (embedded-first)', () => {
  let service;

  beforeEach(() => {
    service = new NodeDetectionService({ logger: noopLogger });
    // Keep detection deterministic: system node lookup is informational only
    // and spawns a real shell lookup — stub it out.
    service.checkSystemNode = async () => null;
    service.runtimeManager.getRuntimeInfo = async () => ({
      installed: false,
      isValid: false,
      version: null,
      npmVersion: null,
      nodePath: null,
      npmPath: null,
      major: 0,
      minor: 0,
      patch: 0
    });
  });

  it('recommends embedded_ready when the embedded runtime is available, even with no managed runtime', async () => {
    // Under vitest (plain node) the embedded info comes from the running
    // process itself: process.versions.node + bundled npm both resolve.
    const payload = await service.detectNodeInstallation();

    expect(payload.embedded.available).toBe(true);
    expect(payload.recommendation).toBe('embedded_ready');
    // Managed runtime absent → normalized "empty" shape, not an error
    expect(payload.runtime).toMatchObject({ installed: false, isValid: false });
  });

  it('recommends managed_ready when the embedded runtime is unavailable and a valid managed runtime exists', async () => {
    service.getEmbeddedRuntimeInfo = () => ({ available: false, nodeAvailable: false, npmAvailable: false });
    service.runtimeManager.getRuntimeInfo = async () => managedRuntimeInfo;

    const payload = await service.detectNodeInstallation();

    expect(payload.embedded.available).toBe(false);
    expect(payload.recommendation).toBe('managed_ready');
    expect(payload.runtime).toMatchObject({ installed: true, isValid: true, version: '20.12.0' });
  });

  it('recommends install_required when neither embedded nor a valid managed runtime exist', async () => {
    service.getEmbeddedRuntimeInfo = () => ({ available: false, nodeAvailable: false, npmAvailable: false });

    const payload = await service.detectNodeInstallation();

    expect(payload.recommendation).toBe('install_required');
  });

  it('managed runtime that is installed but INVALID does not count as ready', async () => {
    service.getEmbeddedRuntimeInfo = () => ({ available: false, nodeAvailable: false, npmAvailable: false });
    service.runtimeManager.getRuntimeInfo = async () => ({ ...managedRuntimeInfo, isValid: false });

    const payload = await service.detectNodeInstallation();

    expect(payload.runtime.isValid).toBe(false);
    expect(payload.recommendation).toBe('install_required');
  });
});

describe('NodeDetectionService wizard IPC contract (node:detect payload shape)', () => {
  it('keeps legacy fields (runtime, systemNode, recommendation) and adds embedded', async () => {
    const service = new NodeDetectionService({ logger: noopLogger });
    service.checkSystemNode = async () => ({
      version: '22.0.0',
      rawVersion: 'v22.0.0',
      path: '/usr/bin/node',
      major: 22,
      minor: 0,
      patch: 0,
      isValid: true
    });
    service.runtimeManager.getRuntimeInfo = async () => managedRuntimeInfo;

    const payload = await service.detectNodeInstallation();

    // Legacy shape consumed by the renderer (welcome.html) and preload bridge
    expect(Object.keys(payload).sort()).toEqual(['embedded', 'recommendation', 'runtime', 'systemNode']);
    expect(payload.runtime).toMatchObject({
      installed: expect.any(Boolean),
      isValid: expect.any(Boolean),
      version: expect.anything(),
      nodePath: expect.anything()
    });
    expect(payload.systemNode).toMatchObject({ version: '22.0.0', isValid: true });
    // Additive embedded field (Task 7): renderer branches on recommendation
    expect(payload.embedded).toMatchObject({
      available: expect.any(Boolean),
      version: expect.any(String),
      nodePath: process.execPath
    });
    expect(payload.recommendation).toBe('embedded_ready');
  });

  it('getPreferred* return string paths (legacy caller contract)', async () => {
    const service = new NodeDetectionService({ logger: noopLogger });

    await expect(service.getPreferredNodeExecutable()).resolves.toBe(process.execPath);
    await expect(service.getPreferredNpmExecutable()).resolves.toEqual(expect.stringContaining('npm'));
    await expect(service.getPreferredNpxExecutable()).resolves.toEqual(expect.stringContaining('npx'));
  });
});
