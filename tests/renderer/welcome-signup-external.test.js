/**
 * @fileoverview Source-contract tests for the Wizard "Criar conta" button
 * @author Documental Team
 * @since 0.92.0
 *
 * Task 1 (ajustes-wizard-preview-servicos): the wizard signup button must open
 * https://github.com/signup in the OS default browser via the canonical
 * open-external flow, replacing the removed in-app <webview> signup mode.
 * Static source assertions follow the repo pattern (see
 * tests/main/lifecycle.test.js) because the renderer is plain Alpine.js HTML
 * that cannot be loaded in a node test harness.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const nativeRequire = createRequire(import.meta.url);
const realFs = nativeRequire('fs');
const realPath = nativeRequire('path');

const ROOT = realPath.resolve(
  realPath.dirname(fileURLToPath(import.meta.url)),
  '../..'
);

const WELCOME_HTML_PATH = realPath.join(ROOT, 'renderer/welcome.html');
const LOCALE_DIRS = [
  realPath.join(ROOT, 'src/locales'),
  realPath.join(ROOT, 'tests/fixtures/locales'),
];

let welcomeSource = '';
let localeFiles = [];

beforeAll(() => {
  welcomeSource = realFs.readFileSync(WELCOME_HTML_PATH, 'utf-8');
  localeFiles = LOCALE_DIRS.flatMap((dir) => {
    if (!realFs.existsSync(dir)) return [];
    return realFs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => ({ path: realPath.join(dir, f), content: realFs.readFileSync(realPath.join(dir, f), 'utf-8') }));
  });
});

function extractButtonBlock(source, marker) {
  const markerIdx = source.indexOf(marker);
  if (markerIdx === -1) return null;
  const start = source.lastIndexOf('<button', markerIdx);
  const end = source.indexOf('</button>', markerIdx);
  if (start === -1 || end === -1) return null;
  return source.slice(start, end + '</button>'.length);
}

describe('Wizard signup button opens GitHub signup in external browser', () => {
  it('should call openExternal("https://github.com/signup") on the button with the person_add icon', () => {
    const block = extractButtonBlock(welcomeSource, 'person_add');
    expect(block).not.toBeNull();
    expect(block).toMatch(/@click\.prevent="openExternal\('https:\/\/github\.com\/signup'\)"/);
    expect(block).toMatch(/welcome\.create_github_account_button/);
  });

  it('should not reference isCreatingAccount anywhere in welcome.html', () => {
    expect(welcomeSource).not.toMatch(/isCreatingAccount/);
  });

  it('should not embed a signup <webview> in welcome.html', () => {
    const webviewMatches = welcomeSource.match(/<webview[^>]*>/g) || [];
    const signupWebviews = webviewMatches.filter((tag) =>
      /github\.com\/signup/.test(tag)
    );
    expect(signupWebviews).toHaveLength(0);
  });

  it('should not have any locale containing the orphan key login_now', () => {
    expect(localeFiles.length).toBeGreaterThan(0);
    for (const file of localeFiles) {
      expect(file.content, `${file.path} should not contain login_now`).not.toMatch(/login_now/);
    }
  });
});
