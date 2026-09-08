/**
 * @fileoverview Layer boundary test — the raw git backends
 * (`isomorphic-git`, `isomorphic-git/http/node`, `dugite`) may only be
 * loaded from inside `src/git/**`. Any require / nodeRequire / import
 * (static or dynamic) of these modules elsewhere in `src/` is a layering
 * violation (regression by copy-paste guarded here). Strict mode:
 * matches anywhere in the file, including comments — the facade
 * (src/git/GitService.js) is the only public API.
 *
 * KNOWN EXCEPTION (publish-update-resilience T15/T16): src/ipc/
 * projectCreation.js keeps a LIVE isomorphic-git probe (`_probeRemoteRefs`
 * pre-clone via loadGitModule/loadHttpModule nodeRequire — mock-visible
 * on purpose, see gitClone-security.test). Removing it would break
 * clone; migrating the probe to dugite ls-remote is Task 17. The
 * allowlist below admits EXACTLY the two known nodeRequire lines and
 * pins their presence — any OTHER iso usage in that file still fails,
 * and once T17 deletes the probe the stale allowlist entry fails loudly
 * so it gets removed with the migration.
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

const MODULE = String.raw`isomorphic-git(?:\/http\/node)?|dugite`;

// Any load form: require()/nodeRequire() call, dynamic import(), or a
// static import/export-from statement.
const FORBIDDEN = new RegExp(
  [
    String.raw`(?:nodeRequire|require)\s*\(\s*['"](?:${MODULE})['"]\s*\)`,
    String.raw`import\s*\(\s*['"](?:${MODULE})['"]\s*\)`,
    String.raw`(?:^|\n)\s*(?:import|export)\s[^;\n]*from\s*['"](?:${MODULE})['"]`,
  ].join('|')
);

// T17-scoped exception: the exact projectCreation probe lines.
const ALLOWLIST = [
  {
    file: path.join('src', 'ipc', 'projectCreation.js'),
    // TODO(T17): migrate the pre-clone probe to dugite ls-remote and
    // delete this allowlist entry together with loadGitModule/loadHttpModule.
    snippets: [
      `nodeRequire('isomorphic-git')`,
      `nodeRequire('isomorphic-git/http/node')`,
    ],
  },
];

describe('Layer boundary: raw git backends only inside src/git/', () => {
  it('no file outside src/git/** loads isomorphic-git or dugite in ANY form (require, nodeRequire, static or dynamic import; comments included)', () => {
    const violations = [];
    for (const file of collectJsFiles(SRC)) {
      const rel = path.relative(ROOT, file);
      if (rel.startsWith(GIT_LAYER)) continue;

      let content = fs.readFileSync(file, 'utf8');
      const entry = ALLOWLIST.find((e) => rel === e.file);
      if (entry) {
        for (const snippet of entry.snippets) {
          expect(
            content.includes(snippet),
            `stale allowlist: ${rel} no longer contains the pinned snippet "${snippet}" — remove the entry with the T17 probe migration`
          ).toBe(true);
          content = content.split(snippet).join('');
        }
      }
      if (FORBIDDEN.test(content)) violations.push(rel);
    }
    expect(violations).toEqual([]);
  });

  it('the projectCreation exception is scoped: exactly one allowlisted file, exactly two pinned probe lines', () => {
    expect(ALLOWLIST).toHaveLength(1);
    expect(ALLOWLIST[0].snippets).toHaveLength(2);
    const content = fs.readFileSync(path.join(ROOT, ALLOWLIST[0].file), 'utf8');
    expect(content.match(/nodeRequire\('isomorphic-git[^']*'\)/g)).toEqual(
      ALLOWLIST[0].snippets
    );
  });
});
