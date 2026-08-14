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
    // FORBID force: true or force=true
    expect(content).not.toMatch(/force\s*:\s*true/i);
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

  it('NEVER calls getBranchProtection anywhere in src/', () => {
    const result = execSync(
      `grep -rn "getBranchProtection" ${path.join(ROOT, 'src/')} || true`
    ).toString().trim();
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
