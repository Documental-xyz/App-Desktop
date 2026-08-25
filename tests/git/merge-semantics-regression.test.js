/**
 * @fileoverview Regression: merge-first semantics on publish/refresh.
 *
 * User criterion: when local and remote change DIFFERENT lines of the
 * SAME file, publish/refresh must produce a REAL merge (both changes
 * coexist + merge commit). "Local wins" may only arbitrate CONFLICTING
 * hunks (same line), per-hunk within the same file — never a whole-file
 * substitution.
 *
 * Gap closed vs existing suites: COMMITTED local edits on line N vs
 * COMMITTED remote edits on line M (N≠M) of the SAME file, through the
 * production flows (gitPublishPreview / gitRefresh), dual-provider.
 *
 * @vitest-environment node
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';

import { providersUnderTest } from '../git-providers/harness.js';
import {
  createRepoPair,
  makeDivergent,
  commitFile,
} from './fixtures/harness.js';
import {
  makeFlowHandlers,
  divergentFlowsWork,
  gateOnCapability,
} from './fixtures/providerHarness.js';
import { theirsMergeDriver } from '../../src/ipc/gitMergeDriver.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Base fixture: 8 lines. Local commits an edit on line 2; remote commits
// an edit on line 6 — different lines, SAME file, both COMMITTED.
const BASE = Array.from({ length: 8 }, (_, i) => `line${i + 1}\n`).join('');
const LOCAL_VERSION = BASE.replace('line2\n', 'line2-LOCAL\n');
const REMOTE_VERSION_DIFFERENT = BASE.replace('line6\n', 'line6-REMOTE\n');
// Real conflict on line 2 PLUS a non-conflicting remote edit on line 6:
// proves arbitration is per-hunk, not per-file.
const REMOTE_VERSION_CONFLICT =
  BASE.replace('line2\n', 'line2-REMOTE\n').replace('line6\n', 'line6-REMOTE\n');

/** @param {Awaited<ReturnType<typeof pair.local.log>>} log */
const messagesOf = (log) => log.map((c) => c.commit.message);

describe.each(providersUnderTest())('merge semantics regression [%s]', (providerName) => {
  let pair;
  let handlers;
  let divergentGateOpen;

  beforeEach(async () => {
    divergentGateOpen = await divergentFlowsWork(providerName);
  });

  afterEach(() => {
    pair?.dispose();
  });

  describe('publish — committed edits on different lines of the same file', () => {
    beforeEach(async () => {
      pair = await createRepoPair({
        branch: 'preview',
        files: { 'doc.md': BASE },
      });
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });

    it('merges BOTH changes (real merge, not substitution)', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (divergent publish)');

      await makeDivergent(pair, {
        remoteFiles: { 'doc.md': REMOTE_VERSION_DIFFERENT },
        remoteMessage: 'remote: edit line6',
      });
      await commitFile(pair.local, 'doc.md', LOCAL_VERSION, 'local: edit line2');

      const result = await handlers.gitPublishPreview(1, 'publish after divergence');
      expect(result.success).toBe(true);
      expect(result.branch).toBe('preview');

      const merged = await pair.local.readFile('doc.md');
      expect(merged).toContain('line2-LOCAL\n');
      expect(merged).toContain('line6-REMOTE\n');
      expect(merged).not.toContain('line2\n');
      expect(merged).not.toContain('line6\n');

      const messages = messagesOf(await pair.local.log(20));
      expect(messages.some((m) => m.includes('local: edit line2'))).toBe(true);
      expect(messages.some((m) => m.includes('remote: edit line6'))).toBe(true);
      expect(messages.some((m) => /merge/i.test(m))).toBe(true);

      expect(await pair.local.resolveRef('HEAD')).toBe(
        await pair.local.resolveRef('refs/remotes/origin/preview'),
      );
    });

    it('arbitrates ONLY the conflicting hunk by local (per-hunk, same file)', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (divergent publish)');

      await makeDivergent(pair, {
        remoteFiles: { 'doc.md': REMOTE_VERSION_CONFLICT },
        remoteMessage: 'remote: edit line2+line6',
      });
      await commitFile(pair.local, 'doc.md', LOCAL_VERSION, 'local: edit line2');

      const result = await handlers.gitPublishPreview(1, 'publish conflicting');
      expect(result.success).toBe(true);

      const merged = await pair.local.readFile('doc.md');
      // Conflicting line 2: LOCAL wins.
      expect(merged).toContain('line2-LOCAL\n');
      expect(merged).not.toContain('line2-REMOTE\n');
      // Non-conflicting remote hunk in the SAME file: preserved.
      expect(merged).toContain('line6-REMOTE\n');
    });
  });

  describe('refresh — committed edits on different lines of the same file', () => {
    beforeEach(async () => {
      pair = await createRepoPair({
        branch: 'preview',
        files: { 'doc.md': BASE },
      });
      handlers = makeFlowHandlers(pair.local.dir, providerName);
    });

    it('merges BOTH changes (real merge, not substitution)', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (divergent refresh)');

      await makeDivergent(pair, {
        remoteFiles: { 'doc.md': REMOTE_VERSION_DIFFERENT },
        remoteMessage: 'remote: edit line6',
      });
      await commitFile(pair.local, 'doc.md', LOCAL_VERSION, 'local: edit line2');

      const result = await handlers.gitRefresh(1);
      expect(result.success).toBe(true);

      const merged = await pair.local.readFile('doc.md');
      expect(merged).toContain('line2-LOCAL\n');
      expect(merged).toContain('line6-REMOTE\n');

      const messages = messagesOf(await pair.local.log(20));
      expect(messages.some((m) => m.includes('local: edit line2'))).toBe(true);
      expect(messages.some((m) => m.includes('remote: edit line6'))).toBe(true);
      expect(messages.some((m) => /merge/i.test(m))).toBe(true);
    });

    it('arbitrates ONLY the conflicting hunk by local (per-hunk, same file)', async (ctx) => {
      gateOnCapability(ctx, divergentGateOpen, 'T10-D1/T10-D2 (divergent refresh)');

      await makeDivergent(pair, {
        remoteFiles: { 'doc.md': REMOTE_VERSION_CONFLICT },
        remoteMessage: 'remote: edit line2+line6',
      });
      await commitFile(pair.local, 'doc.md', LOCAL_VERSION, 'local: edit line2');

      const result = await handlers.gitRefresh(1);
      expect(result.success).toBe(true);

      const merged = await pair.local.readFile('doc.md');
      expect(merged).toContain('line2-LOCAL\n');
      expect(merged).not.toContain('line2-REMOTE\n');
      expect(merged).toContain('line6-REMOTE\n');
    });
  });
});

// Cross-branch publish maps LOCAL commits to the THEIRS side of the
// merge (anti-inversion contract); its iso driver must also arbitrate
// per-hunk, matching dugite's native `-X theirs`.
describe('theirsMergeDriver — per-hunk arbitration (cross-branch publish side)', () => {
  it('keeps THEIRS on the conflicting hunk AND keeps OURS non-conflicting hunk', () => {
    const base = 'a\nb\nc\n';
    const ours = 'a-OURS\nb\nc\n'; // ours edits line 1
    const theirs = 'a\nb\nc-THEIRS\nd\n'; // theirs edits line 3 + appends

    const { cleanMerge, mergedText } = theirsMergeDriver({
      branches: ['base', 'ours', 'theirs'],
      contents: [base, ours, theirs],
      path: 'doc.md',
    });

    expect(cleanMerge).toBe(true);
    expect(mergedText).toContain('a-OURS\n'); // non-conflicting ours hunk kept
    expect(mergedText).toContain('c-THEIRS\n');
    expect(mergedText).toContain('d\n');
  });

  it('conflicting hunk resolved by THEIRS only', () => {
    const { mergedText } = theirsMergeDriver({
      branches: ['base', 'ours', 'theirs'],
      contents: ['a\nb\nc\n', 'a\nb-OURS\nc\n', 'a\nb-THEIRS\nc\n'],
      path: 'doc.md',
    });
    expect(mergedText).toContain('b-THEIRS\n');
    expect(mergedText).not.toContain('b-OURS\n');
  });

  it('binary (U+FFFD) surfaces cleanMerge:false for caller fallback', () => {
    const { cleanMerge, mergedText } = theirsMergeDriver({
      branches: ['base', 'ours', 'theirs'],
      contents: ['\uFFFDbin', 'ours', '\uFFFDbin2'],
      path: 'asset.bin',
    });
    expect(cleanMerge).toBe(false);
    expect(mergedText).toBe('\uFFFDbin2');
  });
});
