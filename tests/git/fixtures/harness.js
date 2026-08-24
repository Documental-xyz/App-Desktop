/**
 * @fileoverview Git sync fixtures harness (git-sync-strategy plan, Task 1).
 *
 * Provides REAL git repositories driven by isomorphic-git (the default
 * provider) so every scenario (dirty tree, divergence, text/binary
 * conflicts) exercises the exact library the production code uses —
 * the git CLI (dugite exec) is used ONLY for one-time transport setup
 * (bare origin init), never as a behavioral oracle.
 *
 * Transport contract (inherited from tests/git-providers/harness.js):
 * isomorphic-git speaks ONLY http(s) — no file://, no bare path — so
 * the "origin" is a local bare repo served over loopback http via the
 * bundled git http-backend. `createRepoPair` yields:
 *   - `local`:  the repo under test (simulates the user's machine)
 *   - `remote`: a second working repo (simulates a colleague) pushing
 *     to the same origin — advancing the remote state is just a
 *     commit+push from `remote`, no bare-repo surgery needed.
 *
 * Reusable scenario helpers (Tasks 2-8):
 *   createRepoPair, commitFile, makeDirty, makeDivergent, makeConflict
 *
 * @vitest-environment node
 */

import { vi } from 'vitest';

// tests/setup.js mocks fs/path globally (setupFiles vi.mock) — these
// fixtures need the REAL filesystem (temp repos, http server).
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import gitModule from 'isomorphic-git';
import * as httpNs from 'isomorphic-git/http/node';

import {
  gitSetup,
  createGitHttpServer,
  makeTempDir,
  GIT_AUTHOR,
} from '../../git-providers/harness.js';

const git = gitModule.default || gitModule;
const http = httpNs.default?.request ? httpNs.default : httpNs;

// ─── Repo handle ─────────────────────────────────────────────────────────────

/**
 * Bind isomorphic-git operations to a working directory.
 * All ops go through iso-git — the production provider's engine.
 * @param {string} dir
 */
function makeRepo(dir) {
  const api = {
    fs,
    dir,
    http,
    author: GIT_AUTHOR,
  };

  /** @typedef {{
   *   writeFiles(files: Object<string, string|Buffer>): void,
   *   commit(message: string, files?: string|string[]): Promise<string>,
   *   push(branch?: string): Promise<void>,
   *   fetch(): Promise<void>,
   *   statusMatrix(): Promise<Array<[string, number, number, number]>>,
   *   head(): Promise<string>,
   *   resolveRef(ref: string): Promise<string>,
   *   readFile(file: string): Promise<string>,
   *   readBytes(file: string): Promise<Buffer>,
   *   log(depth?: number): Promise<Array<{ oid: string, message: string }>>,
   * }} RepoHandle */

  return {
    dir,
    git: api,

    /** Write files to the working tree (no staging, no commit). */
    writeFiles(files) {
      for (const [name, content] of Object.entries(files)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
    },

    /** Stage + commit. `files` defaults to every file just written. */
    async commit(message, files) {
      const list = files || fs.readdirSync(dir).filter((f) => f !== '.git');
      for (const f of Array.isArray(list) ? list : [list]) {
        await git.add({ ...api, filepath: f });
      }
      return git.commit({ ...api, message });
    },

    /** Push current (or given) branch to origin. */
    async push(branch) {
      await git.push({ ...api, remote: 'origin', ref: branch });
    },

    async fetch() {
      await git.fetch(api);
    },

    async statusMatrix() {
      return git.statusMatrix(api);
    },

    async head() {
      return git.resolveRef({ ...api, ref: 'HEAD' });
    },

    async resolveRef(ref) {
      return git.resolveRef({ ...api, ref });
    },

    async readFile(file) {
      return fs.readFileSync(path.join(dir, file), 'utf8');
    },

    async readBytes(file) {
      return fs.readFileSync(path.join(dir, file));
    },

    async log(depth = 10) {
      return git.log({ ...api, depth });
    },
  };
}

// ─── Pair creation ───────────────────────────────────────────────────────────

/**
 * Create a local repo + bare http origin + a second "colleague" repo,
 * all seeded with an optional common base commit.
 *
 * @param {{files?: Object<string, string|Buffer>, branch?: string}} [opts]
 *   `files` seeds the common base commit (pushed to origin, cloned by
 *   the remote repo). Without files, both repos are empty and unbranched.
 * @returns {Promise<{
 *   baseDir: string, url: string, bare: string,
 *   server: import('http').Server,
 *   local: RepoHandle, remote: RepoHandle,
 *   branch: string, dispose(): void,
 * }>}
 */
export async function createRepoPair(opts = {}) {
  const branch = opts.branch || 'main';
  const baseDir = makeTempDir('git-sync-');
  const bare = path.join(baseDir, 'remote.git');

  // Transport setup ONLY (git CLI): empty bare origin behind http-backend.
  await gitSetup(['init', '--bare', '-b', branch, 'remote.git'], baseDir);
  await gitSetup(['config', 'http.receivepack', 'true'], bare);

  const { server, url } = await createGitHttpServer(baseDir);

  const localDir = path.join(baseDir, 'local');
  fs.mkdirSync(localDir, { recursive: true });
  await git.init({ fs, dir: localDir, defaultBranch: branch });
  await git.addRemote({ fs, dir: localDir, remote: 'origin', url });

  const local = makeRepo(localDir);

  if (opts.files && Object.keys(opts.files).length > 0) {
    local.writeFiles(opts.files);
    await local.commit('base: common ancestor', Object.keys(opts.files));
    await local.push(branch);
  }

  // Second working repo talks to the same origin via a real clone.
  const remoteDir = path.join(baseDir, 'colleague');
  const hasOriginBranch = Boolean(opts.files && Object.keys(opts.files).length);
  if (hasOriginBranch) {
    await git.clone({ fs, dir: remoteDir, http, url, singleBranch: false });
  } else {
    fs.mkdirSync(remoteDir, { recursive: true });
    await git.init({ fs, dir: remoteDir, defaultBranch: branch });
  }

  const remote = makeRepo(remoteDir);
  if (!hasOriginBranch) {
    await git.addRemote({ fs, dir: remoteDir, remote: 'origin', url });
  }

  return {
    baseDir,
    url,
    bare,
    server,
    local,
    remote,
    branch,
    dispose() {
      server.closeAllConnections?.();
      server.close();
      fs.rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

// ─── Scenario helpers (Tasks 2-8 reuse these) ────────────────────────────────

/**
 * Write one file and commit it. Returns the commit OID.
 * @param {RepoHandle} repo
 * @param {string} file
 * @param {string|Buffer} content
 * @param {string} [message]
 */
export async function commitFile(repo, file, content, message = `commit ${file}`) {
  repo.writeFiles({ [file]: content });
  return repo.commit(message, file);
}

/**
 * Make the working tree dirty (modified/untracked files, no commit).
 * @param {RepoHandle} repo
 * @param {Object<string, string|Buffer>} files
 */
export function makeDirty(repo, files) {
  repo.writeFiles(files);
}

/**
 * Create a local↔remote divergence on top of the pair's common base.
 * Local files are committed locally; remote files are committed on the
 * colleague repo AND pushed to origin. Neither side fetches — callers
 * (or the flow under test) decide when to fetch/merge.
 *
 * @param {Awaited<ReturnType<typeof createRepoPair>>} pair
 * @param {{localFiles?: Object<string,string|Buffer>, remoteFiles?: Object<string,string|Buffer>,
 *          localMessage?: string, remoteMessage?: string}} [opts]
 * @returns {Promise<{localHead: string, originHead: string}>}
 */
export async function makeDivergent(pair, opts = {}) {
  if (opts.localFiles && Object.keys(opts.localFiles).length) {
    pair.local.writeFiles(opts.localFiles);
    await pair.local.commit(
      opts.localMessage || 'local: divergent commit',
      Object.keys(opts.localFiles)
    );
  }
  if (opts.remoteFiles && Object.keys(opts.remoteFiles).length) {
    pair.remote.writeFiles(opts.remoteFiles);
    await pair.remote.commit(
      opts.remoteMessage || 'remote: divergent commit',
      Object.keys(opts.remoteFiles)
    );
    await pair.remote.push(pair.branch);
  }
  return {
    localHead: await pair.local.head(),
    originHead: await pair.remote.head(),
  };
}

/**
 * Create a conflict precursor: common base version of `file`, then a
 * divergent local edit and a divergent remote edit (committed + pushed).
 * Pass `binary: true` for binary conflicts (contents should be Buffers).
 *
 * By default both sides COMMIT their version (`dirtyLocal: true` leaves
 * the local edit uncommitted — the dirty-tree + conflict scenario).
 *
 * @param {Awaited<ReturnType<typeof createRepoPair>>} pair - pair WITHOUT base files
 * @param {{file?: string, base?: string|Buffer, local?: string|Buffer,
 *          remote?: string|Buffer, binary?: boolean, dirtyLocal?: boolean}} [opts]
 * @returns {Promise<{file: string, baseOid: string, localHead: string, originHead: string}>}
 */
export async function makeConflict(pair, opts = {}) {
  const file = opts.file || (opts.binary ? 'asset.bin' : 'conflict.txt');
  const base =
    opts.base !== undefined
      ? opts.base
      : opts.binary
        ? Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
        : 'line1\nline2\nline3\n';
  const localVersion =
    opts.local !== undefined
      ? opts.local
      : opts.binary
        ? Buffer.from([1, 2, 0xff, 0xff, 0, 0, 7, 8])
        : 'line1\nline2-LOCAL\nline3\n';
  const remoteVersion =
    opts.remote !== undefined
      ? opts.remote
      : opts.binary
        ? Buffer.from([1, 2, 0xaa, 0xbb, 0, 0, 7, 8])
        : 'line1\nline2-REMOTE\nline3\n';

  const baseOid = await commitFile(pair.local, file, base, `base: ${file}`);
  await pair.local.push(pair.branch);

  // Sync colleague to the base, then diverge.
  await pair.remote.fetch();
  await git.checkout({
    fs,
    dir: pair.remote.dir,
    ref: `origin/${pair.branch}`,
  });

  await commitFile(pair.remote, file, remoteVersion, `remote: edit ${file}`);
  await pair.remote.push(pair.branch);

  if (opts.dirtyLocal) {
    makeDirty(pair.local, { [file]: localVersion });
  } else {
    await commitFile(pair.local, file, localVersion, `local: edit ${file}`);
  }

  return {
    file,
    baseOid,
    localHead: await pair.local.head(),
    originHead: await pair.remote.head(),
  };
}
