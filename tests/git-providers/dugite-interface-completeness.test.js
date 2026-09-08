/**
 * @fileoverview Task 14 — DugiteProvider interface completeness: the
 * FORMAL GATE for Task 15 (deleting the legacy provider).
 *
 * The interface method list is derived by REFLECTION from the JSDoc
 * contract in src/git/GitProvider.js (`@name GitProvider#<method>`
 * tags — the interface is documentation-only, `module.exports = {}`).
 * The extracted list is pinned against EXPECTED_INTERFACE_METHODS so a
 * JSDoc-format change can NOT silently turn the gate vacuous.
 *
 * POST_CONTRACT_METHODS (canFastForward, Task 4) postdate the JSDoc
 * contract but flow call sites (git.js _publishCore/_refreshCore/
 * _pullCore localAhead checks) depend on them — they are part of the
 * gate. The interface marks no method as optional/no-op: all 24 are
 * required. Dugite-only superset methods (mergeBase, mergeTree) are
 * allowed extras, not gate items.
 *
 * If this suite FAILS, Task 15 MUST NOT delete the legacy provider
 * (documented exception in the plan).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';

import { DugiteProvider } from '../../src/git/providers/DugiteProvider.js';

const EXPECTED_INTERFACE_METHODS = [
  // ─── Network operations (GitProvider.js) ───
  'clone',
  'fetch',
  'pull',
  'push',
  'getRemoteInfo',
  'listServerRefs',
  // ─── Local write operations ───
  'add',
  'remove',
  'commit',
  'branch',
  'deleteBranch',
  'checkout',
  'merge',
  'fastForward',
  'writeRef',
  // ─── Read / status operations ───
  'statusMatrix',
  'currentBranch',
  'listBranches',
  'listRefs',
  'resolveRef',
  'readCommit',
  'readBlob',
  'getConfig',
  'setConfig'
];

const POST_CONTRACT_METHODS = ['canFastForward'];

function extractInterfaceMethods() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'git', 'GitProvider.js'),
    'utf-8'
  );
  return Array.from(source.matchAll(/@name GitProvider#(\w+)/g), (m) => m[1]);
}

describe('Task 14 — DugiteProvider interface completeness (T15 gate)', () => {
  it('extracts the pinned 24-method contract from GitProvider.js JSDoc', () => {
    expect(extractInterfaceMethods()).toEqual(EXPECTED_INTERFACE_METHODS);
  });

  it('DugiteProvider implements EVERY interface method (T15 deletion gate)', () => {
    const missing = EXPECTED_INTERFACE_METHODS.filter(
      (method) => typeof DugiteProvider.prototype[method] !== 'function'
    );

    expect(
      missing,
      `T15 GATE BLOCKED — DugiteProvider is missing ${missing.length} ` +
        `GitProvider interface method(s): [${missing.join(', ')}]. ` +
        'Task 15 must NOT delete the legacy provider until these land.'
    ).toEqual([]);
  });

  it('DugiteProvider implements post-contract methods flows depend on (canFastForward, T4)', () => {
    const missing = POST_CONTRACT_METHODS.filter(
      (method) => typeof DugiteProvider.prototype[method] !== 'function'
    );

    expect(
      missing,
      `T15 GATE BLOCKED — DugiteProvider is missing post-contract ` +
        `method(s): [${missing.join(', ')}] required by git.js flow call sites.`
    ).toEqual([]);
  });

  it('gate covers the full 24 + canFastForward surface (guard against list rot)', () => {
    expect(EXPECTED_INTERFACE_METHODS).toHaveLength(24);
    expect(POST_CONTRACT_METHODS).toContain('canFastForward');
  });
});
