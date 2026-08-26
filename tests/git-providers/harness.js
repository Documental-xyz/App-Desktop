/**
 * @fileoverview Shared harness for the dual-provider test suite
 * (plan checkbox 18 / PRD §28-29).
 *
 * Transport contract: isomorphic-git speaks ONLY http(s) (no file://, no
 * bare path — UrlParseError, T22 learning), so every remote in these tests
 * is a LOCAL bare repo served over LOOPBACK (git http-backend CGI behind
 * http.createServer, 127.0.0.1 only) and BOTH providers talk to the same
 * http://127.0.0.1:<port>/remote.git URL — identical transport, no
 * external network, no credentials.
 *
 * Setup steps (repo seeding, bare cloning, remote advancing) use the
 * bundled git CLI via dugite's exec — these are SETUP ONLY; every
 * assertion runs through the provider under test, and fixture
 * expectations are derived from the INCUMBENT (isomorphic-git)
 * behavior.
 *
 * @vitest-environment node
 */

import { vi } from 'vitest';

// tests/setup.js mocks fs/path globally (setupFiles vi.mock) — these
// tests need the REAL filesystem (dugite exec, temp repos, http server).
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { spawn } from 'child_process';

import {
  exec as dugiteExec,
  resolveGitBinary,
  resolveGitExecPath,
} from 'dugite';
import {
  createGitProvider,
  resetGitProviderCache,
} from '../../src/git/GitProviderFactory.js';

export const GIT_AUTHOR = { name: 'dual-suite', email: 'dual@example.local' };

// CI runners (GitHub Actions) have NO global user.name/user.email, and
// `git merge` / `git commit` / `git commit-tree` / `git tag` refuse to run
// without a committer identity (exit 128). EVERY CLI setup call therefore
// carries an EXPLICIT identity via `-c` — global config is never assumed.
const IDENTITY_ARGS = [
  '-c', `user.email=${GIT_AUTHOR.email}`,
  '-c', `user.name=${GIT_AUTHOR.name}`,
];
// Same identity in env form for raw spawn() call sites — belt and braces
// with the -c flags (GIT_AUTHOR_*/GIT_COMMITTER_* cover ident-sensitive
// plumbing like commit-tree that reads env before config).
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: GIT_AUTHOR.name,
  GIT_AUTHOR_EMAIL: GIT_AUTHOR.email,
  GIT_COMMITTER_NAME: GIT_AUTHOR.name,
  GIT_COMMITTER_EMAIL: GIT_AUTHOR.email,
};

/** @returns {string} fresh temp working directory */
export function makeTempDir(prefix = 'dual-providers-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── Capability probe: git http-backend (loopback smart-http transport) ───────
//
// Probe lives in the LEAF module ./httpBackend.js (no heavy imports, so
// evaluation order can never shadow the flag). Loopback-dependent suites
// gate with .skipIf(!httpBackendAvailable) — conditional skip that
// re-opens automatically when the runner's git ships the CGI.
export { httpBackendAvailable } from './httpBackend.js';

/**
 * Run bundled git (SETUP ONLY — never for assertions). Throws on failure.
 * Identity is injected EXPLICITLY (CI runners have no global git identity).
 * @param {string[]} args git argv
 * @param {string} [cwd]
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
export async function gitSetup(args, cwd) {
  const res = await dugiteExec([...IDENTITY_ARGS, ...args], cwd || os.tmpdir(), { env: {} });
  if (res.exitCode !== 0) {
    throw new Error(
      `setup git ${args.join(' ')} failed (exit ${res.exitCode}): ${res.stderr}`
    );
  }
  return res;
}

// ─── git http-backend CGI loopback server (T9/T22 proven recipe) ─────────────

/**
 * http server speaking the git smart protocol via the bundled
 * `git http-backend` CGI. PATH_INFO must NOT include the query string.
 * @param {string} rootDir - GIT_PROJECT_ROOT (bare repos live here)
 * @returns {Promise<{server: http.Server, url: string}>} url of `remote.git`
 */
export function createGitHttpServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const gitDir = path.resolve(path.dirname(resolveGitBinary()), '..', '..');
      const env = {
        ...process.env,
        // Bundled-git env contract (T8): http-backend lives in libexec.
        GIT_EXEC_PATH: resolveGitExecPath(),
        GIT_CONFIG_SYSTEM: path.join(gitDir, 'etc', 'gitconfig'),
        GIT_TEMPLATE_DIR: path.join(gitDir, 'share', 'git-core', 'templates'),
        PREFIX: gitDir,
        GIT_SSL_CAINFO: path.join(gitDir, 'ssl', 'cacert.pem'),
        GIT_PROJECT_ROOT: rootDir,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: u.pathname, // NO query string (T9)
        REQUEST_METHOD: req.method,
        QUERY_STRING: u.search.replace(/^\?/, ''),
        CONTENT_TYPE: req.headers['content-type'] || '',
        CONTENT_LENGTH: req.headers['content-length'] || '',
        REMOTE_USER: 'dual-suite',
        REMOTE_ADDR: req.socket.remoteAddress || '127.0.0.1',
      };
      const child = spawn(resolveGitBinary(), ['http-backend'], { env });
      const chunks = [];
      let stderrTail = '';
      child.stdout.on('data', (d) => chunks.push(d));
      child.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d.toString()).slice(-500);
      });
      req.pipe(child.stdin);
      child.on('error', (err) => {
        res.writeHead(500);
        res.end(String(err));
      });
      child.on('close', () => {
        const buf = Buffer.concat(chunks);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) {
          res.writeHead(500);
          res.end(`http-backend: no header block. stderr: ${stderrTail}`);
          return;
        }
        const head = buf.slice(0, idx).toString('latin1');
        const body = buf.slice(idx + 4);
        const status = /Status:\s*(\d+)/i.exec(head);
        const ctype = /Content-Type:\s*([^\r\n]+)/i.exec(head);
        res.writeHead(
          status ? Number(status[1]) : 200,
          ctype ? { 'Content-Type': ctype[1] } : {}
        );
        res.end(body);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/remote.git` });
    });
  });
}

/**
 * Server that accepts connections and NEVER responds — used to make a
 * push genuinely SLOW/hung so an AbortSignal fires mid-operation.
 * (iso-git http/node does not honor in-flight aborts and falls back to
 * its internal ~5s 'Request timed out'; dugite kills the process via the
 * signal — both surface as GitError.)
 * @returns {Promise<{server: http.Server, url: string}>}
 */
export function createBlackholeServer() {
  return new Promise((resolve, reject) => {
    /** @type {Set<import('net').Socket>} */
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      // Swallow the request body and never answer.
      req.resume();
    });
    server.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}/remote.git`,
        /** Hard close: destroys lingering half-open sockets first. */
        close: () =>
          new Promise((r) => {
            for (const sock of sockets) {
              sock.destroy();
            }
            server.close(() => r());
          }),
      });
    });
  });
}

/**
 * Build a seeded bare remote served over loopback http. Both providers
 * clone/push against `url`.
 * @param {string} baseDir - temp base (bare + seed live here)
 * @param {{files?: Object<string, string|Buffer>, commits?: number, bareName?: string}} [opts]
 * @returns {Promise<{server: http.Server, url: string, bare: string, seed: string}>}
 */
export async function createHttpRemote(baseDir, opts = {}) {
  const files = opts.files || { 'README.md': '# dual-suite remote\n' };
  const commits = opts.commits || 1;
  const bareName = opts.bareName || 'remote.git';
  const seed = path.join(baseDir, 'seed');
  const bare = path.join(baseDir, bareName);

  fs.mkdirSync(seed, { recursive: true });
  await gitSetup(['init', '-b', 'main', '.'], seed);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(seed, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  await gitSetup(['add', '.'], seed);
  for (let i = 0; i < commits; i++) {
    // Identity comes from gitSetup's explicit -c injection (CI-safe).
    await gitSetup(['commit', '-m', `seed #${i + 1}`, '--allow-empty'], seed);
  }

  await gitSetup(['clone', '--bare', '--', seed, bare], baseDir);
  await gitSetup(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
  // Anonymous push over http-backend requires receivepack enabled (T9).
  await gitSetup(['config', 'http.receivepack', 'true'], bare);

  const { server, url } = await createGitHttpServer(baseDir);
  return { server, url, bare, seed };
}

/**
 * Advance a bare remote's branch by one commit, in place, via
 * commit-tree + update-ref (T9/T22 recipe — bare repos have no
 * worktree). Used to fabricate non-fast-forward rejections.
 * @param {string} bare
 * @param {string} [message]
 * @param {string} [ref='main'] branch to advance
 * @returns {Promise<string>} new remote branch OID
 */
export async function advanceRemoteHead(bare, message = 'remote advance', ref = 'main') {
  const tree = (await gitSetup(['rev-parse', `${ref}^{tree}`], bare)).stdout.trim();
  const commit = await new Promise((resolve, reject) => {
    const child = spawn(
      resolveGitBinary(),
      // Explicit identity on the argv AND via env — commit-tree is
      // ident-sensitive and CI runners have no global identity (exit 128).
      [...IDENTITY_ARGS, '-C', bare, 'commit-tree', tree, '-p', ref],
      { env: { ...process.env, ...IDENTITY_ENV, GIT_EXEC_PATH: resolveGitExecPath() } }
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`commit-tree exit ${code}`))
    );
    child.stdin.end(`${message}\n`);
  });
  await gitSetup(['update-ref', `refs/heads/${ref}`, commit], bare);
  return commit;
}

/** @returns {Promise<string>} OID of bare's `main` */
export async function remoteHead(bare) {
  return (await gitSetup(['rev-parse', 'main'], bare)).stdout.trim();
}

/** @returns {Promise<string[]>} branch names on the bare remote */
export async function remoteBranches(bare) {
  const out = (await gitSetup(
    ['for-each-ref', 'refs/heads', '--format=%(refname:short)'],
    bare
  )).stdout;
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Init an empty local repo (SETUP ONLY, standard `git init -b main`).
 * @param {string} dir
 */
export async function initLocalRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  await gitSetup(['init', '-b', 'main', '.'], dir);
}

// ─── Provider selection (GIT_PROVIDER runner contract) ───────────────────────

/**
 * Providers under test: GIT_PROVIDER env selects ONE; unset runs BOTH
 * sequentially (plan checkbox 18 runner contract).
 * @returns {string[]}
 */
export function providersUnderTest() {
  const v = process.env.GIT_PROVIDER;
  if (v === 'isomorphic-git' || v === 'dugite') {
    return [v];
  }
  return ['isomorphic-git', 'dugite'];
}

/**
 * Factory for a provider instance via the REAL factory (env + cache
 * reset per inherited wisdom — resetGitProviderCache between providers).
 * @param {string} name
 * @returns {() => Object} provider factory
 */
export function providerFactory(name) {
  return () => {
    process.env.GIT_PROVIDER = name;
    resetGitProviderCache();
    return createGitProvider();
  };
}

/**
 * Cross-instance-safe GitError check (vitest transforms the CJS provider
 * files, yielding a second GitError class — instanceof fails; T19
 * pattern).
 * @param {unknown} e
 * @returns {boolean}
 */
export function isGitError(e) {
  return Boolean(e) && typeof e === 'object' &&
    e.constructor.name === 'GitError';
}

/** Random incompressible payload (crypto — git's zlib cannot shrink it). */
export function randomBytes(n) {
  return crypto.randomBytes(n);
}
