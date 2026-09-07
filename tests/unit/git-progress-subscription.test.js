/**
 * @fileoverview Structural tests for the git:progress subscription
 * (publish-update-resilience Task 9).
 *
 * Same style as frontend-standardization.test.js (regex on renderer HTML) —
 * that suite is quarantined (tests/KNOWN-FAILURES.md), so Task 9 assertions
 * live here, active and scoped to main.html only.
 * @since 1.0.0
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

// Bypass global mocks from tests/setup.js — these tests read real files
vi.unmock('fs');
vi.unmock('path');

const mainHtml = fs.readFileSync(
  path.join(__dirname, '../../renderer/main.html'),
  'utf-8'
);

describe('Task 9 — git:progress subscription (structural)', () => {
  it('subscribes to onGitProgress in init', () => {
    expect(mainHtml).toContain('window.electronAPI.onGitProgress');
  });

  it('filters events by projectId (multi-window protection)', () => {
    expect(mainHtml).toContain('handleGitProgress');
    const filterLine = mainHtml
      .split('\n')
      .find((l) => l.includes('String(payload.projectId)'));
    expect(filterLine, 'missing String(payload.projectId) comparison').toBeTruthy();
  });

  it('adopts operationId from the first event and ignores foreign ones', () => {
    const handler = mainHtml.slice(
      mainHtml.indexOf('handleGitProgress(payload)')
    );
    expect(handler.slice(0, 3000)).toContain('this.gitExecution.operationId === null');
    expect(handler.slice(0, 3000)).toContain('!== this.gitExecution.operationId');
  });

  it('derives currentStep from event stageIndex (single source of truth)', () => {
    const handler = mainHtml.slice(
      mainHtml.indexOf('handleGitProgress(payload)')
    );
    expect(handler.slice(0, 3000)).toMatch(/currentStep\s*=\s*payload\.stageIndex/);
  });

  it('handles terminal events and tolerates absent restored (T7 additive)', () => {
    const handler = mainHtml.slice(
      mainHtml.indexOf('handleGitProgress(payload)')
    );
    expect(handler.slice(0, 3000)).toContain('payload.terminal');
    expect(handler.slice(0, 3000)).toContain('payload.restored');
  });

  it('subscribes onGitStateChanged behind a guard (T7 parallel)', () => {
    expect(mainHtml).toMatch(/if\s*\(window\.electronAPI\.onGitStateChanged\)/);
    expect(mainHtml).toContain("window.electronAPI.onGitStateChanged(cb)");
  });

  it('cleans git listeners up in Alpine destroy()', () => {
    const destroyIdx = mainHtml.indexOf('destroy()');
    expect(destroyIdx).toBeGreaterThan(-1);
    const destroyBody = mainHtml.slice(destroyIdx, destroyIdx + 800);
    expect(destroyBody).toContain('_gitEventCleanups');
  });

  it('removes the fastPath string-matching heuristic entirely', () => {
    expect(mainHtml).not.toContain('fastPath');
    expect(mainHtml).not.toContain('⚡ Modo rápido');
    expect(mainHtml).not.toContain('git_exec_fast_path_badge');
  });

  it('FSM phases exist: idle → preflight → running → terminal', () => {
    expect(mainHtml).toContain("phase: 'idle'");
    expect(mainHtml).toContain("phase = 'running'");
    expect(mainHtml).toContain("phase = 'preflight'");
    expect(mainHtml).toContain("phase = 'terminal'");
  });

  it('preflightRunning wraps ONLY the checkPublishMain invokes', () => {
    // Every preflightRunning=true assignment must sit next to a
    // checkPublishMain call — never around publishToMain/pushToBranch.
    const lines = mainHtml.split('\n');
    lines.forEach((line, i) => {
      if (line.includes('gitExecution.preflightRunning = true')) {
        const window = lines.slice(i, i + 6).join('\n');
        expect(
          window.includes('checkPublishMain'),
          `preflightRunning=true at line ${i + 1} not wrapping checkPublishMain`
        ).toBe(true);
      }
    });
  });

  it('progress bar consumes percentage with graceful null fallback', () => {
    expect(mainHtml).toContain('gitExecution.percentage !== null');
  });

  it('step totals mirror backend STAGE_LISTS (refresh=4, publish=5)', () => {
    expect(mainHtml).toContain("openGitExecModal('refresh', 4)");
    expect(mainHtml).toContain("openGitExecModal('publish-main', 5)");
    expect(mainHtml).toContain("openGitExecModal('publish-preview', 5)");
  });
});
