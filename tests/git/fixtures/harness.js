/**
 * @fileoverview Git sync fixtures harness (git-sync-strategy plan, Task 1;
 * REWRITTEN for dugite in publish-update-resilience Task 16).
 *
 * Provides REAL git repositories driven by the bundled git CLI (dugite
 * exec) — zero isomorphic-git anywhere in fixture construction. Every
 * repo-building operation (init, add, commit, push, fetch, branch,
 * checkout, log, statusMatrix) shells out to the same git binary the
 * production DugiteProvider uses; the provider-under-test is never
 * involved in SETUP (it stays the thing under test).
 *
 * Transport (UNCHANGED by design — Task 16 audit): the "origin" remains a
 * local bare repo served over LOOPBACK http via the bundled git
 * http-backend. The Task 16 brief considered migrating to file://, but
 * two live suites depend on http-origin BEHAVIOR, so the loopback stays:
 *   - tests/ipc/git.progress.test.js kills the origin via
 *     `pair.server.close()` (origin-down → terminal failed at fetching);
 *   - tests/git/push-retry.test.js drops the connection mid-push by
 *     killing git-receive-pack from a pre-receive hook — over http this
 *     reproduces the exact "conexão ruim" transport failure the retry
 *     logic must self-heal.
 * `createRepoPair` keeps returning `{ server, url, ... }` so both keep
 * working untouched. Everything else (construction) is CLI now:
 *   - `local`:  the repo under test (simulates the user's machine)
 *   - `remote`: a second working repo (simulates a colleague) pushing
 *     to the same origin — advancing the remote state is just a
 *     commit+push from `remote`, no bare-repo surgery needed.
 *
 * Repo handle API (unchanged surface, CLI-backed): writeFiles, commit,
 * push, fetch, statusMatrix, head, resolveRef, readFile, readBytes, log.
 * The OLD `repo.git` isomorphic-git binding is GONE (Task 16) — suites
 * that spread it into iso calls now use the handle methods.
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
import os from 'os';
import path from 'path';

import {
  gitSetup,
  createGitHttpServer,
  makeTempDir,
  GIT_AUTHOR,
} from '../../git-providers/harness.js';

// Re-export so fixture suites can gate on the loopback-transport
// capability (conditional skip, providerHarness convention — re-opens
// automatically when the runner's bundled git ships http-backend). The
// probe lives in a LEAF module so import evaluation order can never
// shadow the flag.
export { httpBackendAvailable } from '../../git-providers/httpBackend.js';

// ─── Machine git identity for CLI-backed flows (CI portability) ───────────────
//
// Every harness CLI call carries an explicit `-c` identity (gitSetup),
// so commits never depend on the machine's gitconfig; identity-less
// commands run by the PROVIDER under test (e.g. `git merge`) inherit the
// deterministic GIT_CONFIG_GLOBAL file below instead (same mechanism the
// pre-Task-16 harness installed — kept verbatim).
{
  const globalConfig = path.join(os.tmpdir(), `smc-test-gitconfig-${process.pid}`);
  try {
    fs.writeFileSync(
      globalConfig,
      `[user]\n\tname = ${GIT_AUTHOR.name}\n\temail = ${GIT_AUTHOR.email}\n`
    );
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
  } catch (_e) { /* best-effort: dev machines already carry an identity */ }
}

// ─── Repo handle ─────────────────────────────────────────────────────────────

/**
 * Run a setup git command inside `dir`. Throws on failure (gitSetup).
 * @param {string} dir
 * @param {string[]} args
 * @returns {Promise<string>} stdout
 */
async function runIn(dir, args) {
  const res = await gitSetup(args, dir);
  return res.stdout;
}

/**
 * Bind CLI git operations to a working directory. All ops go through
 * the bundled git binary — the production provider's engine.
 * @param {string} dir
 */
function makeRepo(dir) {
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
   *   log(depth?: number, ref?: string): Promise<Array<{ oid: string, commit: { message: string, parent: string[] } }>>,
   * }} RepoHandle */

  /** Current branch short name ('' on detached/unborn). */
  const currentBranchName = async () => {
    try {
      return (await runIn(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    } catch (_e) {
      return '';
    }
  };

  const resolveRef = async (ref) =>
    (await runIn(dir, ['rev-parse', `${ref}^{commit}`])).trim();

  return {
    dir,

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
      const arr = Array.isArray(list) ? list : [list];
      if (arr.length > 0) {
        await runIn(dir, ['add', '--', ...arr]);
      }
      await runIn(dir, ['commit', '-m', message]);
      return resolveRef('HEAD');
    },

    /** Push current (or given) branch to origin. */
    async push(branch) {
      const b = branch || (await currentBranchName());
      const refspec = b ? `refs/heads/${b}:refs/heads/${b}` : '';
      await runIn(dir, ['push', 'origin', ...(refspec ? [refspec] : [])]);
    },

    async fetch() {
      await runIn(dir, ['fetch', 'origin']);
    },

    /**
     * iso-git-shaped status matrix [filepath, head, workdir, stage] —
     * same plumbing as DugiteProvider.statusMatrix (proven parity in
     * tests/git-providers/provider-suite.test.js), condensed for the
     * harness: HEAD via ls-tree, stage via ls-files -s, workdir facts
     * via status --porcelain=v2 -z -uall --no-renames, real blob OIDs
     * via batched hash-object.
     */
    async statusMatrix() {
      const headOut = await runIn(dir, ['ls-tree', '-r', '-z', 'HEAD']).catch((err) => {
        const msg = `${err?.stderr || ''}\n${err?.message || ''}`;
        if (/Not a valid object name|unknown revision|ambiguous argument/i.test(msg)) {
          return ''; // unborn HEAD — empty tree (iso-git semantics)
        }
        throw err;
      });
      const indexOut = await runIn(dir, ['ls-files', '-s', '-z']);
      const statusOut = await runIn(dir, [
        'status', '--porcelain=v2', '-z', '-uall', '--no-renames',
      ]);

      // path → HEAD blob OID
      const headMap = new Map();
      for (const entry of String(headOut || '').split('\0')) {
        if (!entry) continue;
        const [meta, filepath] = entry.split('\t');
        const oid = meta.split(' ')[2];
        if (oid && filepath) headMap.set(filepath, oid);
      }

      // path → index OID, FIRST entry per path wins (lowest stage)
      const indexMap = new Map();
      for (const entry of String(indexOut || '').split('\0')) {
        if (!entry) continue;
        const [meta, filepath] = entry.split('\t');
        if (!indexMap.has(filepath)) {
          indexMap.set(filepath, meta.split(' ')[1]);
        }
      }

      // path → porcelain workdir facts
      const statusMap = parsePorcelainV2Workdir(statusOut);

      const allPaths = new Set([
        ...headMap.keys(),
        ...indexMap.keys(),
        ...statusMap.keys(),
      ]);

      const toHash = [];
      /** @type {Map<string, string|undefined>} filepath → workdir OID */
      const workdirOids = new Map();

      for (const filepath of allPaths) {
        const info = statusMap.get(filepath);
        if (info && info.absentFromWorkdir) {
          workdirOids.set(filepath, undefined);
          continue;
        }
        if (!info && !indexMap.has(filepath)) {
          workdirOids.set(filepath, undefined);
          continue;
        }
        const headOid = headMap.get(filepath);
        const stageOid = indexMap.get(filepath);
        if (headOid === undefined && stageOid === undefined) {
          workdirOids.set(filepath, '42'); // iso-git untracked placeholder
          continue;
        }
        if (info && info.cleanVsIndex) {
          workdirOids.set(filepath, stageOid); // stat-cache shortcut
          continue;
        }
        toHash.push(filepath);
      }

      if (toHash.length > 0) {
        const stdout = await runIn(dir, ['hash-object', '--', ...toHash]);
        const oids = String(stdout || '').split('\n').filter(Boolean);
        toHash.forEach((p, j) => workdirOids.set(p, oids[j]));
      }

      /** @type {Array<[string, number, number, number]>} */
      const rows = [];
      for (const filepath of allPaths) {
        const entry = [
          undefined,
          headMap.get(filepath),
          workdirOids.get(filepath),
          indexMap.get(filepath),
        ];
        const result = entry.map((value) => entry.indexOf(value));
        result.shift();
        rows.push([filepath, ...result]);
      }
      rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return rows;
    },

    async head() {
      return resolveRef('HEAD');
    },

    async resolveRef(ref) {
      return resolveRef(ref);
    },

    async readFile(file) {
      return fs.readFileSync(path.join(dir, file), 'utf8');
    },

    async readBytes(file) {
      return fs.readFileSync(path.join(dir, file));
    },

    /**
     * Commit log (newest first) with iso-git WalkEntry shape
     * `{oid, commit: {message, parent}}` — message is the RAW body
     * (trailing \n kept), parent the full parent-OID array.
     */
    async log(depth = 10, ref = 'HEAD') {
      const out = await runIn(dir, [
        'log', '-n', String(depth), ref,
        '--format=%H%x1f%P%x1f%B%x1e',
      ]);
      const entries = [];
      for (const record of String(out || '').split('\x1e')) {
        const trimmed = record.replace(/^\n/, '');
        if (!trimmed.trim()) continue;
        const [oid, parents, message] = trimmed.split('\x1f');
        entries.push({
          oid: oid.trim(),
          commit: {
            message: message || '',
            parent: parents ? parents.trim().split(' ').filter(Boolean) : [],
          },
        });
      }
      return entries;
    },
  };
}

/**
 * Parse `git status --porcelain=v2 -z` workdir facts. VERBATIM port of
 * DugiteProvider's private parser (proven parity in provider-suite) —
 * `2` records consume their trailing origPath token, `u` records map
 * the workdir stage, `cleanVsIndex` treats ' '/'.' as unmodified.
 * @param {string} out
 * @returns {Map<string, {absentFromWorkdir: boolean, cleanVsIndex: boolean}>}
 */
function parsePorcelainV2Workdir(out) {
  const tokens = String(out || '').split('\0');
  /** @type {Map<string, {absentFromWorkdir: boolean, cleanVsIndex: boolean}>} */
  const facts = new Map();
  const set = (filepath, absentFromWorkdir, cleanVsIndex) =>
    facts.set(filepath, { absentFromWorkdir, cleanVsIndex });
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.startsWith('#')) {
      continue;
    }
    if (entry.startsWith('? ')) {
      set(entry.slice(2), false, false);
      continue;
    }
    if (entry.startsWith('! ')) {
      continue;
    }
    const fields = entry.split(' ');
    const kind = fields[0];
    const y = fields[1] ? fields[1][1] : '';
    const unmod = (c) => c === ' ' || c === '.';
    if (kind === '1') {
      set(fields.slice(8).join(' '), y === 'D', unmod(y));
    } else if (kind === '2') {
      // `2` records are followed by a NUL + origPath token — consume it.
      set(fields.slice(9).join(' '), y === 'D', unmod(y));
      i++;
    } else if (kind === 'u') {
      set(fields.slice(10).join(' '), fields[6] === '0', false);
    }
  }
  return facts;
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

  // Bare origin behind http-backend (same transport contract as always).
  await gitSetup(['init', '--bare', '-b', branch, 'remote.git'], baseDir);
  await gitSetup(['config', 'http.receivepack', 'true'], bare);

  const { server, url } = await createGitHttpServer(baseDir);

  // Local repo: plain init + origin remote (CLI, no provider involved).
  const localDir = path.join(baseDir, 'local');
  fs.mkdirSync(localDir, { recursive: true });
  await gitSetup(['init', '-b', branch, '.'], localDir);
  await gitSetup(['remote', 'add', 'origin', url], localDir);

  const local = makeRepo(localDir);

  if (opts.files && Object.keys(opts.files).length > 0) {
    local.writeFiles(opts.files);
    await local.commit('base: common ancestor', Object.keys(opts.files));
    await local.push(branch);
  }

  // Second working repo talks to the same origin via a real clone
  // (all branches, like the old singleBranch:false iso clone).
  const remoteDir = path.join(baseDir, 'colleague');
  const hasOriginBranch = Boolean(opts.files && Object.keys(opts.files).length);
  if (hasOriginBranch) {
    await gitSetup(['clone', url, remoteDir], baseDir);
  } else {
    fs.mkdirSync(remoteDir, { recursive: true });
    await gitSetup(['init', '-b', branch, '.'], remoteDir);
    await gitSetup(['remote', 'add', 'origin', url], remoteDir);
  }

  const remote = makeRepo(remoteDir);

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
 * `syncRemote: true` first advances the COLLEAGUE to origin's current
 * tip (fetch + branch materialization — the proven makeConflict
 * pattern). Without it, the colleague stays at its clone-time base, so
 * any test that PUBLISHES before diverging builds a non-fast-forward
 * push that git rejects server-side (kept semantics from the iso-era
 * harness: the colleague must never push a base-rooted commit under
 * an origin that has moved).
 *
 * @param {Awaited<ReturnType<typeof createRepoPair>>} pair
 * @param {{localFiles?: Object<string,string|Buffer>, remoteFiles?: Object<string,string|Buffer>,
 *          localMessage?: string, remoteMessage?: string, syncRemote?: boolean}} [opts]
 * @returns {Promise<{localHead: string, originHead: string}>}
 */
export async function makeDivergent(pair, opts = {}) {
  if (opts.syncRemote) {
    await pair.remote.fetch();
    const originTip = await pair.remote.resolveRef(`origin/${pair.branch}`);
    const colleagueHead = await pair.remote.resolveRef(pair.branch).catch(() => null);
    if (colleagueHead !== originTip) {
      // Unborn-or-stale colleague branch: (re)materialize at origin tip
      // (`checkout -B` = force branch + checkout, the CLI equivalent of
      // the old iso branch{force} + checkout{force} dance).
      await runIn(pair.remote.dir, ['checkout', '-B', pair.branch, `origin/${pair.branch}`]);
    }
  }
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
  // CLI clone already tracks origin; materialize the LOCAL branch at
  // the remote tip (`checkout -B`), then commit the remote edit.
  await runIn(pair.remote.dir, ['checkout', '-B', pair.branch, `origin/${pair.branch}`]);

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
