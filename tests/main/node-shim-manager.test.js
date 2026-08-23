/**
 * @fileoverview Tests for nodeShimManager default-path shim generation
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, afterAll } from 'vitest';

// Real behavior: setup.js globally mocks 'fs' and 'path', but the mocked 'path'
// lacks delimiter/posix extras and the mocked 'fs' writes nothing. Unmock both
// so nodeShimManager does real file I/O in a temp userData dir.
vi.unmock('fs');
vi.unmock('path');

import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { ensureShims, getShimsDir } from '../../src/main/services/nodeShimManager.js';

const shimsDirByTmp = new Set();

describe('nodeShimManager', () => {
  describe('ensureShims with default npm/npx cli resolution', () => {
    it('creates node, npm and npx shims; npm shim references npm-cli.js', async () => {
      const userData = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'shim-test-'));
      shimsDirByTmp.add(userData);

      const shimsDir = await ensureShims({ userDataPath: userData });

      expect(shimsDir).toBe(getShimsDir(userData));
      expect(nodeFs.existsSync(nodePath.join(shimsDir, 'node'))).toBe(true);
      expect(nodeFs.existsSync(nodePath.join(shimsDir, 'npm'))).toBe(true);
      expect(nodeFs.existsSync(nodePath.join(shimsDir, 'npx'))).toBe(true);

      const npmShim = nodeFs.readFileSync(nodePath.join(shimsDir, 'npm'), 'utf8');
      expect(npmShim).toMatch(/npm-cli\.js/);
      expect(npmShim).toContain('ELECTRON_RUN_AS_NODE=1');
      expect(npmShim).toContain(`"${process.execPath}"`);

      const marker = JSON.parse(
        nodeFs.readFileSync(nodePath.join(shimsDir, '.shim-meta.json'), 'utf8')
      );
      // Default resolution went through embeddedRuntimeService: cli path must
      // point at the bundled npm-cli.js (ESM require.resolve is blocked by
      // npm's "exports" map, so assert on the resolved path shape)
      expect(marker.npmCliPath).toMatch(/node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
      expect(nodeFs.existsSync(marker.npmCliPath)).toBe(true);

      // Unix shims are executable
      expect(nodeFs.statSync(nodePath.join(shimsDir, 'node')).mode & 0o111).not.toBe(0);
    });
  });
});

afterAll(() => {
  for (const userData of shimsDirByTmp) {
    nodeFs.rmSync(userData, { recursive: true, force: true });
  }
});
