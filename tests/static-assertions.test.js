/**
 * @fileoverview Static code invariant tests — grep-based checks for
 * the "Must NOT Have" rules and success criteria from the project plan.
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

describe('Static code invariants', () => {
  it('NEVER uses force push in src/ipc/git.js', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/ipc/git.js'), 'utf8');
    // Allow force: false, force=false, force: undefined
    // FORBID force: true or force=true in any push path. Allowed only:
    // (1) the body of _hardResetBranch (local `git reset --hard` equivalent)
    // (2) this.git.checkout(...) calls — checkout is always a local
    //     operation in isomorphic-git and can never push.
    const withoutHardReset = content.replace(
      /async _hardResetBranch\(projectPath, targetRef\) \{[\s\S]*?\n  \}/,
      ''
    );
    const withoutLocalCheckouts = withoutHardReset
      .split('\n')
      .filter((line) => !/this\.git\.checkout\([^)]*force\s*:\s*true/i.test(line))
      .join('\n');
    expect(withoutLocalCheckouts).not.toMatch(/force\s*:\s*true/i);
  });

  it('NEVER shells out to native git in src/ipc/git*.js', () => {
    // Only check git-related files — other IPC handlers (system.js,
    // projectCreation.js, processManager.js) legitimately use child_process
    // for non-git system operations.
    const gitDir = path.join(ROOT, 'src/ipc');
    const result = execSync(
      `grep -rn "child_process\\|execSync\\|require.*spawn" ${gitDir}/git*.js ${gitDir}/githubRepos.js || true`
    ).toString().trim();
    expect(result).toBe('');
  });

  it('NEVER calls getBranchProtection anywhere in src/ (one allowlisted call)', () => {
    // Exact allowlist: the single legitimate call at
    // src/ipc/permissionHandlers.js:391 inside _fetchBranchProtection(),
    // used to gate publish-main (read-only protection check). Any other
    // occurrence anywhere in src/ still fails this invariant.
    const ALLOWLIST = [
      'src/ipc/permissionHandlers.js:391:      const { data } = await octokit.repos.getBranchProtection({ owner, repo, branch });'
    ];
    const result = execSync(
      `grep -rn "getBranchProtection" ${path.join(ROOT, 'src/')} || true`
    )
      .toString()
      .trim()
      // Normalize to repo-relative paths so the allowlist is stable
      .split('\n')
      .filter((line) => line && !ALLOWLIST.includes(line.replace(ROOT + '/', '')))
      .join('\n');
    expect(result).toBe('');
  });

  it('NEVER uses getCollaboratorPermissionLevel in src/ipc/ (RBAC removed)', () => {
    const ipcDir = path.join(ROOT, 'src/ipc');
    const result = execSync(
      `grep -rn "getCollaboratorPermissionLevel" ${ipcDir}/ || true`
    ).toString().trim();
    expect(result).toBe('');
  });

  it('NEVER has _checkMainPermission in gitPreflight.js', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/ipc/gitPreflight.js'), 'utf8');
    expect(content).not.toMatch(/_checkMainPermission/);
  });

  it('core.autocrlf and core.filemode are set in configureGitForUser', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/ipc/gitOperations.js'), 'utf8');
    expect(content).toMatch(/core\.autocrlf/);
    expect(content).toMatch(/core\.filemode/);
  });

  it('most git.fetch calls in src/ipc/git.js use depth:1 (shallow)', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/ipc/git.js'), 'utf8');
    const fetchCount = (content.match(/gitMod\.fetch\s*\(/g) || []).length;
    const depthCount = (content.match(/depth\s*:\s*1/g) || []).length;
    // 5 out of 6 fetches currently use depth:1.
    // One fetch in the push flow (line ~1101) does not set depth.
    // At minimum keep the count at fetchCount - 1 or higher.
    expect(depthCount).toBeGreaterThanOrEqual(fetchCount - 1);
    // No fetch should ever use depth > 1 (wasteful)
    expect(content).not.toMatch(/depth\s*:\s*[2-9]\b/);
  });
});

// ---------------------------------------------------------------------------
// windowsHide guard (D1a) — every raw child_process call site in production
// code must pass `windowsHide: true` so Windows never flashes a console
// window. Unix-only platform files are allowlisted.
// ---------------------------------------------------------------------------

/**
 * Files that only ever run on Unix (ps/kill shims, POSIX adapter) and can
 * never open a Windows console window.
 * @type {Set<string>}
 */
const WINDOWS_HIDE_ALLOWLIST = new Set([
  'src/main/platform/unix.js',
  'src/main/adapters/UnixPlatformAdapter.js'
]);

const WINDOWS_HIDE_RE = /windowsHide\s*:\s*true/;

/**
 * Replace comments and string/template-literal contents with spaces,
 * preserving length (and therefore line/column positions).
 * @param {string} content - raw JS source
 * @returns {string} masked source of identical length
 */
function maskCommentsAndStrings(content) {
  const chars = content.split('');
  let state = 'code'; // code | sq | dq | tpl | line | block
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    if (state === 'code') {
      if (c === "'") { state = 'sq'; chars[i] = ' '; }
      else if (c === '"') { state = 'dq'; chars[i] = ' '; }
      else if (c === '`') { state = 'tpl'; chars[i] = ' '; }
      else if (c === '/' && next === '/') {
        state = 'line'; chars[i] = ' '; chars[i + 1] = ' '; i++;
      } else if (c === '/' && next === '*') {
        state = 'block'; chars[i] = ' '; chars[i + 1] = ' '; i++;
      }
    } else if (state === 'sq' || state === 'dq' || state === 'tpl') {
      if (c === '\\') { chars[i] = ' '; if (next !== undefined) chars[i + 1] = ' '; i++; }
      else if (
        (state === 'sq' && c === "'") ||
        (state === 'dq' && c === '"') ||
        (state === 'tpl' && c === '`')
      ) { state = 'code'; chars[i] = ' '; }
      else if (c !== '\n') { chars[i] = ' '; }
    } else if (state === 'line') {
      if (c === '\n') state = 'code'; else chars[i] = ' ';
    } else if (state === 'block') {
      if (c === '*' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; i++; state = 'code'; }
      else if (c !== '\n') { chars[i] = ' '; }
    }
  }
  return chars.join('');
}

/**
 * Collect function names destructured from require('child_process').
 * Matches top-level and inline requires alike.
 * @param {string} raw - raw JS source
 * @returns {Set<string>} e.g. Set{'spawn','execFile'}
 */
function destructuredChildProcessFns(raw) {
  const fns = new Set();
  const re = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*['"]child_process['"]\s*\)/g;
  let m;
  while ((m = re.exec(raw))) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].trim();
      if (name) fns.add(name);
    }
  }
  return fns;
}

/**
 * Slice the inside of a balanced (...) starting at openIndex on masked text.
 * @param {string} masked - masked source
 * @param {number} openIndex - index of the opening '('
 * @returns {?string} inner segment, or null when unbalanced
 */
function extractBalancedParens(masked, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return masked.slice(openIndex + 1, i);
    }
  }
  return null;
}

/**
 * Split a call-arguments segment on top-level commas.
 * @param {string} segment - masked inner argument text
 * @returns {string[]} trimmed arguments
 */
function splitTopLevelArgs(segment) {
  const args = [];
  let depth = 0;
  let current = '';
  for (const c of segment) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { args.push(current); current = ''; }
    else current += c;
  }
  args.push(current);
  return args.map((a) => a.trim());
}

/**
 * When options are passed as a variable (e.g. spawn(cmd, args, mergedOptions)),
 * resolve `const <ident> = { ... }` on masked text and check it there.
 * @param {string} masked - masked source
 * @param {string} ident - variable name holding the options object
 * @returns {boolean} true when the resolved literal has windowsHide: true
 */
function optionsVariableHasWindowsHide(masked, ident) {
  const re = new RegExp('(?:const|let|var)\\s+' + ident + '\\s*=\\s*\\{');
  const m = re.exec(masked);
  if (!m) return false;
  const openIndex = masked.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let i = openIndex; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return WINDOWS_HIDE_RE.test(masked.slice(openIndex, i));
    }
  }
  return false;
}

/**
 * Pure detector: find raw child_process call sites missing windowsHide: true.
 *
 * A call site passes when its own argument list contains
 * `windowsHide: true`, or when the options object is a local variable whose
 * object literal contains it. Comments, strings and method calls such as
 * `re.exec(...)` are ignored.
 *
 * @param {string} content - raw JS source of one file
 * @param {string} [relPath='<memory>'] - repo-relative path for messages
 * @returns {Array<{file: string, line: number, call: string}>} violations
 */
export function detectMissingWindowsHide(content, relPath = '<memory>') {
  const violations = [];
  const fns = destructuredChildProcessFns(content);
  if (fns.size === 0) return violations;

  const masked = maskCommentsAndStrings(content);

  for (const fn of fns) {
    const callRe = new RegExp(fn + '\\s*\\(', 'g');
    let m;
    while ((m = callRe.exec(masked))) {
      const idx = m.index;
      const prev = idx > 0 ? masked[idx - 1] : '';
      // Skip property access (re.exec, child.spawn, this.spawn, execa.spawn)
      if (prev && /[\w.$]/.test(prev)) continue;

      const segment = extractBalancedParens(masked, idx + m[0].length - 1);
      if (segment === null) continue; // unbalanced — not a plain call expression

      if (WINDOWS_HIDE_RE.test(segment)) continue;

      const args = splitTopLevelArgs(segment).filter((a) => a.length > 0);
      const lastArg = args[args.length - 1] || '';
      if (/^[A-Za-z_$][\w$]*$/.test(lastArg) && optionsVariableHasWindowsHide(masked, lastArg)) {
        continue;
      }

      const line = content.slice(0, idx).split('\n').length;
      const rawSnippet = content
        .slice(idx, Math.min(idx + 120, content.length))
        .split('\n')[0]
        .trim();
      violations.push({ file: relPath, line, call: `${fn}(...${rawSnippet}` .slice(0, 100) });
    }
  }
  return violations;
}

/**
 * Recursively collect .js files under a directory.
 * @param {string} dir - absolute directory path
 * @param {string[]} [acc] - accumulator
 * @returns {string[]} absolute file paths
 */
function walkJsFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

describe('windowsHide detector — pure function (negative path)', () => {
  it('flags a spawn call with no options object', () => {
    const fixture = [
      "const { spawn } = require('child_process');",
      'function bad() {',
      "  return spawn('node', ['-v']);",
      '}'
    ].join('\n');
    const violations = detectMissingWindowsHide(fixture, 'src/fixtures/bad-no-options.js');
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('src/fixtures/bad-no-options.js');
    expect(violations[0].line).toBe(3);
  });

  it('flags a spawn call whose options object lacks windowsHide', () => {
    const fixture = [
      "const { spawn } = require('child_process');",
      "spawn('node', ['-v'], { stdio: 'ignore' });"
    ].join('\n');
    const violations = detectMissingWindowsHide(fixture, 'src/fixtures/bad-options.js');
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
  });

  it('accepts call sites that pass windowsHide: true inline', () => {
    const fixture = [
      "const { execFile } = require('child_process');",
      "execFile('taskkill', ['/T'], { windowsHide: true }, () => {});"
    ].join('\n');
    expect(detectMissingWindowsHide(fixture)).toEqual([]);
  });

  it('accepts options passed as a local variable containing windowsHide', () => {
    const fixture = [
      "const { spawn } = require('child_process');",
      'const mergedOptions = { shell: true, windowsHide: true };',
      "spawn('cmd', [], mergedOptions);"
    ].join('\n');
    expect(detectMissingWindowsHide(fixture)).toEqual([]);
  });

  it('flags a local-variable options object lacking windowsHide', () => {
    const fixture = [
      "const { spawn } = require('child_process');",
      'const mergedOptions = { shell: true, timeout: 30000 };',
      "spawn('cmd', [], mergedOptions);"
    ].join('\n');
    const violations = detectMissingWindowsHide(fixture, 'src/fixtures/bad-var.js');
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(3);
  });

  it('ignores comments, strings, and method calls like re.exec()', () => {
    const fixture = [
      "const { exec } = require('child_process');",
      "// spawn('node', ['-v']);",
      "const s = 'exec(x)';",
      "const re = /foo/; re.exec('pattern');",
      "exec('ls', { windowsHide: true }, () => {});"
    ].join('\n');
    expect(detectMissingWindowsHide(fixture)).toEqual([]);
  });
});

describe('windowsHide static guard over src/', () => {
  it('every raw child_process call site sets windowsHide: true (Unix-only files allowlisted)', () => {
    const srcDir = path.join(ROOT, 'src');
    const violations = [];
    for (const file of walkJsFiles(srcDir)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (WINDOWS_HIDE_ALLOWLIST.has(rel)) continue;
      violations.push(...detectMissingWindowsHide(fs.readFileSync(file, 'utf8'), rel));
    }
    expect(violations).toEqual([]);
  });

  it('src/ declares at least 10 windowsHide: true option sites', () => {
    // Inventory locked by D1a: 2 GitRuntime + 1 nodeDetectionService +
    // 1 nodeRuntimeManager + 1 killPidTree + 4 windows.js + 1 PlatformService.
    let count = 0;
    for (const file of walkJsFiles(path.join(ROOT, 'src'))) {
      const content = fs.readFileSync(file, 'utf8');
      count += (content.match(/windowsHide\s*:\s*true/g) || []).length;
    }
    expect(count).toBeGreaterThanOrEqual(10);
  });
});
