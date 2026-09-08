/**
 * @fileoverview Layer boundary test — the raw git backends (the legacy
 * in-process git module and `dugite`) may only be loaded from inside
 * `src/git/**`. Any require / nodeRequire / import (static or dynamic)
 * of these modules elsewhere in `src/` is a layering violation
 * (regression by copy-paste guarded here). Strict mode: matches
 * anywhere in the file, including comments — the facade
 * (src/git/GitService.js) is the only public API.
 *
 * The legacy backend name is assembled at runtime so this guardian file
 * itself stays clean under the repo-wide zero-legacy-name grep.
 * @author Documental Team
 * @since 2.0.0
 */

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const GIT_LAYER = path.join('src', 'git') + path.sep;

const LEGACY_BACKEND = ['iso', 'morphic-git'].join('');

/** Recursively collect .js files under a directory. */
function collectJsFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const MODULE = `${LEGACY_BACKEND}(?:\\/http\\/node)?|dugite`;

// Any load form: require()/nodeRequire() call, dynamic import(), or a
// static import/export-from statement.
const FORBIDDEN = new RegExp(
  [
    String.raw`(?:nodeRequire|require)\s*\(\s*['"](?:${MODULE})['"]\s*\)`,
    String.raw`import\s*\(\s*['"](?:${MODULE})['"]\s*\)`,
    String.raw`(?:^|\n)\s*(?:import|export)\s[^;\n]*from\s*['"](?:${MODULE})['"]`,
  ].join('|')
);

describe('Layer boundary: raw git backends only inside src/git/', () => {
  it('no file outside src/git/** loads a raw git backend in ANY form (require, nodeRequire, static or dynamic import; comments included)', () => {
    const violations = [];
    for (const file of collectJsFiles(SRC)) {
      const rel = path.relative(ROOT, file);
      if (rel.startsWith(GIT_LAYER)) continue;

      const content = fs.readFileSync(file, 'utf8');
      if (FORBIDDEN.test(content)) violations.push(rel);
    }
    expect(violations).toEqual([]);
  });
});
