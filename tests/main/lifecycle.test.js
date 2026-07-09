/**
 * @fileoverview Lifecycle shutdown tests (TDD RED phase — Task 9)
 * @author Documental Team
 * @since 1.0.0
 *
 * RED phase: these tests assert lifecycle handlers/behaviors that do NOT yet
 * exist in main.js. They are expected to FAIL until Wave 4 (Tasks 20-22)
 * implements:
 *   - `app.on('will-quit')` async cleanup
 *   - `process.on('exit')` synchronous SIGKILL fallback
 *   - correct before-quit ordering (unregister IPC BEFORE closing windows)
 *
 * Why static source-contract tests: main.js is a CommonJS entry point that
 * uses `require('electron')`. Vitest cannot intercept `require()` calls
 * (documented limitation: "Vitest does not support mocking modules imported
 * using require()"), so main.js cannot be loaded in a test harness with a
 * mocked electron app. Instead we assert against the source text that the
 * expected registrations exist and are correctly ordered. These tests turn
 * GREEN when Wave 4 edits main.js to add the handlers.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const nativeRequire = createRequire(import.meta.url);
const realFs = nativeRequire('fs');
const realPath = nativeRequire('path');

const MAIN_JS_PATH = realPath.resolve(
  realPath.dirname(fileURLToPath(import.meta.url)),
  '../../main.js'
);

let mainSource = '';

beforeAll(() => {
  mainSource = realFs.readFileSync(MAIN_JS_PATH, 'utf-8');
});

function extractHandlerBlock(source, eventName) {
  const startRegex = new RegExp(
    `(?:app|process)\\.on\\(\\s*['"]${eventName}['"]`
  );
  const startMatch = source.match(startRegex);
  if (!startMatch) return null;
  const startIdx = startMatch.index;
  const rest = source.slice(startIdx);
  const lines = rest.split('\n');
  const blockLines = [];
  let depth = 0;
  let started = false;
  for (const line of lines) {
    const opens = (line.match(/\(/g) || []).length;
    const closes = (line.match(/\)/g) || []).length;
    depth += opens - closes;
    blockLines.push(line);
    if (opens > 0) started = true;
    if (started && depth <= 0) break;
  }
  return blockLines.join('\n');
}

describe('Lifecycle shutdown (TDD RED)', () => {
  describe('app.on("will-quit")', () => {
    it('should register a will-quit handler', () => {
      expect(mainSource).toMatch(/app\.on\(\s*['"]will-quit['"]/);
    });

    it('should call processManager.killAll in will-quit', () => {
      const block = extractHandlerBlock(mainSource, 'will-quit');
      expect(block).not.toBeNull();
      expect(block).toMatch(/killAll/);
    });

    it('should call themeService.stopWatching in will-quit', () => {
      const block = extractHandlerBlock(mainSource, 'will-quit');
      expect(block).not.toBeNull();
      expect(block).toMatch(/stopWatching/);
    });

    it('should call logger.restoreConsoleMethods in will-quit', () => {
      const block = extractHandlerBlock(mainSource, 'will-quit');
      expect(block).not.toBeNull();
      expect(block).toMatch(/restoreConsoleMethods/);
    });

    it('should preventDefault on event to allow async cleanup', () => {
      const block = extractHandlerBlock(mainSource, 'will-quit');
      expect(block).not.toBeNull();
      expect(block).toMatch(/preventDefault/);
    });
  });

  describe('process.on("exit")', () => {
    it('should register a process exit handler', () => {
      expect(mainSource).toMatch(/process\.on\(\s*['"]exit['"]/);
    });

    it('should send SIGKILL to known PIDs synchronously in exit handler', () => {
      const block = extractHandlerBlock(mainSource, 'exit');
      expect(block).not.toBeNull();
      expect(block).toMatch(/SIGKILL/);
    });
  });

  describe('before-quit order', () => {
    it('should unregister IPC BEFORE closing windows (regression for current bug)', () => {
      // CURRENT BUG (main.js): closeAllWindows() is called BEFORE
      // unregisterIpcHandlers(). Correct order: unregister IPC first so the
      // renderer cannot send more IPC calls while windows are torn down.
      const block = extractHandlerBlock(mainSource, 'before-quit');
      expect(block).not.toBeNull();
      const ipcIndex = block.indexOf('unregisterIpcHandlers');
      const closeWinIndex = block.indexOf('closeAllWindows');
      expect(ipcIndex).toBeGreaterThan(-1);
      expect(closeWinIndex).toBeGreaterThan(-1);
      expect(ipcIndex).toBeLessThan(closeWinIndex);
    });

    it('should call killAll before database.close', () => {
      // Ordering matters: killing child processes before closing the DB avoids
      // zombies holding DB handles / corrupting writes.
      const block = extractHandlerBlock(mainSource, 'before-quit');
      expect(block).not.toBeNull();
      const killIndex = block.indexOf('killAll');
      const dbCloseIndex = block.indexOf('databaseManager.close');
      expect(killIndex).toBeGreaterThan(-1);
      expect(dbCloseIndex).toBeGreaterThan(-1);
      expect(killIndex).toBeLessThan(dbCloseIndex);
    });

    it('should complete shutdown within 2000ms (AC3 budget)', () => {
      // AC3 budget: the before-quit handler must not block on unbounded waits.
      // We assert there is no setTimeout-based artificial delay inside the
      // before-quit block (the current code has `await new Promise(resolve =>
      // setTimeout(resolve, 100))` which violates the budget under load).
      const block = extractHandlerBlock(mainSource, 'before-quit');
      expect(block).not.toBeNull();
      expect(block).not.toMatch(/setTimeout/);
    });
  });
});
