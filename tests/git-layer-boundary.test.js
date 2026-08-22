/**
 * @fileoverview Layer boundary test — the raw git backends
 * (`isomorphic-git`, `isomorphic-git/http/node`, `dugite`) may only be
 * required from inside `src/git/**`. Any require of these modules
 * elsewhere in `src/` is a layering violation (regression by copy-paste
 * guarded here). Strict mode: matches anywhere in the file, including
 * comments — the facade (src/git/GitService.js) is the only public API.
 * @author Documental Team
 * @since 2.0.0
 */

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const GIT_LAYER = path.join('src', 'git') + path.sep;

/** Recursively collect .js files under a directory. */
function collectJsFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const FORBIDDEN = /require\(\s*['"](?:isomorphic-git(?:\/http\/node)?|dugite)['"]\s*\)/;

describe('Layer boundary: raw git backends only inside src/git/', () => {
  it('no file outside src/git/** requires isomorphic-git or dugite (comments included)', () => {
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
