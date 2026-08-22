#!/usr/bin/env node
/**
 * git-benchmark.js — Comparative benchmark: isomorphic-git vs dugite providers
 * (plan checkbox 22 / PRD §30). Analysis tool — NOT wired into CI.
 *
 * Measures clone/fetch/pull/push (duration, success, error) for each provider
 * against a synthetic repository backed by a LOCAL bare remote (absolute
 * filesystem path — no external network, no auth, no tokens).
 *
 * NOTE on transport: isomorphic-git supports ONLY http(s) transport (no
 * file://, no bare path — UrlParseError), so the local bare repo is served
 * over LOOPBACK (git http-backend CGI, 127.0.0.1 only) and BOTH providers
 * use the same http://127.0.0.1:<port>/remote.git URL — identical
 * transport, no external network, no auth, no tokens (dugite's
 * setupEnvironment resolves the CGI binary automatically).
 *
 * Usage:
 *   node scripts/git-benchmark.js [--files N] [--size MB] [--runs N] [--compare]
 *
 *   --files N   Number of files in the synthetic repo (default 500)
 *   --size MB   Total content size, e.g. `10` or `10MB` (default 10)
 *   --runs N    Runs per operation; median is reported (default 3)
 *   --compare   Run BOTH providers and print a delta table. Without it, only
 *               the currently configured provider (GIT_PROVIDER env or
 *               default) runs.
 *
 * SUCCESS DEFINITION (reported, not enforced — gate is human/staging):
 *   push (dugite) median <= 1.5x push (isomorphic-git) median at the default
 *   repo shape (500 files / 10MB), AND 100% success on every operation where
 *   isomorphic-git has 100% success. This script only REPORTS the numbers.
 *
 * Output: human-readable table on stdout + JSON array (PRD §30 shape) on
 * stdout after the table:
 *   [{provider, operation, durationMs, success, error, bundledVersion, ...}]
 *   (durationMs = median across runs; extras: runs[], successRate)
 *
 * Security: remotes are local paths; no credentials are used or logged. Error
 * messages are redacted defensively anyway.
 *
 * @since 2.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { createGitProvider, resetGitProviderCache } = require('../src/git/GitProviderFactory');
const { getBundledGitVersion } = require('../src/git/GitRuntime');
const {
  exec: dugiteExec,
  resolveGitBinary,
  resolveGitExecPath
} = require('dugite');
const isoGit = require('isomorphic-git');

const OP_TIMEOUT_MS = 120_000;
const OPERATIONS = ['clone', 'fetch', 'pull', 'push'];
const BENCH_AUTHOR = { name: 'git-benchmark', email: 'bench@example.local' };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseSizeMB(raw) {
  const m = /^(\d+(?:\.\d+)?)\s*(mb|mib)?$/i.exec(String(raw).trim());
  if (!m) {
    throw new Error(`Invalid --size value: ${raw} (expected e.g. "10" or "10MB")`);
  }
  return Number(m[1]);
}

function parseArgs(argv) {
  const out = { files: 500, sizeMB: 10, runs: 3, compare: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--compare':
        out.compare = true;
        break;
      case '--files':
        out.files = Number(argv[++i]);
        break;
      case '--size':
        out.sizeMB = parseSizeMB(argv[++i]);
        break;
      case '--runs':
        out.runs = Number(argv[++i]);
        break;
      default:
        throw new Error(`Unknown argument: ${a} (see --help)`);
    }
  }
  if (!Number.isInteger(out.files) || out.files < 1) {
    throw new Error('--files must be a positive integer');
  }
  if (!(out.sizeMB > 0)) {
    throw new Error('--size must be > 0');
  }
  if (!Number.isInteger(out.runs) || out.runs < 1) {
    throw new Error('--runs must be a positive integer');
  }
  return out;
}

const HELP = `git-benchmark.js — isomorphic-git vs dugite comparative benchmark

Usage: node scripts/git-benchmark.js [--files N] [--size MB] [--runs N] [--compare]

  --files N   Files in the synthetic repo (default 500)
  --size MB   Total repo content size (default 10 MB)
  --runs N    Runs per operation; median reported (default 3)
  --compare   Benchmark BOTH providers and print a delta table.
              Without it, only the current provider (GIT_PROVIDER env /
              runtime-env.json / default) runs.

Per-operation timeout: ${OP_TIMEOUT_MS / 1000}s. Remote is a LOCAL bare repo
(absolute path, no network, no auth). JSON (PRD §30) is printed after the table:
[{provider, operation, durationMs, success, error, bundledVersion}] (+runs,
successRate extras; durationMs is the median across runs).

Success definition (REPORTED only — gate is human/staging evaluation):
  dugite push median <= 1.5x isomorphic-git push median at 500 files / 10MB,
  AND 100% success wherever isomorphic-git achieves 100%.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Defensive redaction — never log token-like strings (should never appear). */
function redact(text) {
  return String(text || '')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]')
    .replace(/\b[0-9a-f]{40}\b/g, '[SHA]')
    .replace(/https:\/\/[^@\s]+@/g, 'https://[REDACTED]@')
    .slice(0, 300);
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Run an async provider op with a hard timeout (harness guard). */
async function withTimeout(label, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, OP_TIMEOUT_MS);
  const killer = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new Error(`${label} timed out after ${OP_TIMEOUT_MS}ms`));
    });
  });
  try {
    return await Promise.race([
      fn(controller.signal),
      killer,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** dugite exec helper for SETUP ONLY (bare clone, advancing the remote). */
function gitSetup(args, cwd) {
  return dugiteExec(args, cwd || path.join(__dirname, '..')).then((res) => {
    if (res.exitCode !== 0) {
      throw new Error(
        `setup git ${args.join(' ')} failed (exit ${res.exitCode}): ${redact(res.stderr)}`
      );
    }
    return res;
  });
}

function isoVersion() {
  // package.json subpath is blocked by exports; read from the resolved dir.
  const pkgPath = path.join(
    path.dirname(require.resolve('isomorphic-git')),
    'package.json'
  );
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
}

// ---------------------------------------------------------------------------
// Synthetic repository (local, no external network — loopback http-backend)
// ---------------------------------------------------------------------------

/**
 * git http-backend CGI server bound to loopback (recipe proven in T9:
 * PATH_INFO WITHOUT query string; bare needs `http.receivepack true` for
 * anonymous push). Uses the bundled git binary + environment from dugite.
 * @returns {Promise<{server: http.Server, url: string}>}
 */
function createGitHttpServer(rootDir) {
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
        PATH_INFO: u.pathname, // no query string (T9)
        REQUEST_METHOD: req.method,
        QUERY_STRING: u.search.replace(/^\?/, ''),
        CONTENT_TYPE: req.headers['content-type'] || '',
        CONTENT_LENGTH: req.headers['content-length'] || '',
        REMOTE_USER: 'git-benchmark',
        REMOTE_ADDR: req.socket.remoteAddress || '127.0.0.1'
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
        res.writeHead(status ? Number(status[1]) : 200, ctype ? { 'Content-Type': ctype[1] } : {});
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
 * Build the synthetic repo: `seed` work repo (N random files, one commit,
 * created with isomorphic-git directly — pure setup) + `remote.git` bare
 * clone served over loopback http as the remote for both providers.
 * @returns {Promise<{baseDir: string, seedDir: string, remoteUrl: string,
 *   server: http.Server}>}
 */
async function buildSyntheticRepo(baseDir, fileCount, sizeMB) {
  const seedDir = path.join(baseDir, 'seed');
  const bareDir = path.join(baseDir, 'remote.git');

  fs.mkdirSync(seedDir, { recursive: true });
  await isoGit.init({ fs, dir: seedDir, defaultBranch: 'main' });

  const totalBytes = Math.max(fileCount, Math.round(sizeMB * 1024 * 1024));
  const perFile = Math.max(1, Math.floor(totalBytes / fileCount));
  const names = [];
  for (let i = 0; i < fileCount; i++) {
    const name = `file-${String(i).padStart(6, '0')}.bin`;
    fs.writeFileSync(path.join(seedDir, name), crypto.randomBytes(perFile));
    names.push(name);
  }

  const author = { name: 'git-benchmark', email: 'bench@example.local' };
  await isoGit.add({ fs, dir: seedDir, filepath: names });
  await isoGit.commit({
    fs,
    dir: seedDir,
    message: 'bench: synthetic repo',
    author,
    committer: author,
  });

  // Bare clone = the local remote (advanced over the local path by setup
  // only; providers talk to it over loopback http).
  await gitSetup(['clone', '--bare', '--', seedDir, bareDir]);
  await gitSetup(['symbolic-ref', 'HEAD', 'refs/heads/main'], bareDir);
  // Anonymous push over http-backend requires receivepack enabled (T9).
  await gitSetup(['config', 'http.receivepack', 'true'], bareDir);

  const { server, url } = await createGitHttpServer(baseDir);
  return { baseDir, seedDir, bareDir, remoteUrl: url, server };
}

/**
 * Advance the bare remote's main by one commit (untimed setup step).
 * Done in-place via commit-tree + update-ref (T9 recipe: bare repos have no
 * worktree, `git commit` is unusable) — avoids non-ff conflicts with commits
 * providers pushed in earlier runs.
 */
async function advanceRemote(bareDir, runIndex) {
  const tree = (await gitSetup(['rev-parse', 'main^{tree}'], bareDir)).stdout.trim();
  const commit = (
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const child = spawn(
        resolveGitBinary(),
        ['-C', bareDir, 'commit-tree', tree, '-p', 'main'],
        { env: { ...process.env, GIT_EXEC_PATH: resolveGitExecPath() } }
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', () => {});
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(out.trim()) : reject(new Error(`commit-tree exit ${code}`))
      );
      child.stdin.end(`bench: remote advance ${runIndex}\n`);
    })
  );
  await gitSetup(['update-ref', 'refs/heads/main', commit], bareDir);
}

// ---------------------------------------------------------------------------
// Provider instantiation + benchmark
// ---------------------------------------------------------------------------

function makeProvider(providerName) {
  process.env.GIT_PROVIDER = providerName;
  resetGitProviderCache();
  return createGitProvider();
}

async function bundledVersionFor(providerName) {
  if (providerName === 'dugite') {
    try {
      return await getBundledGitVersion();
    } catch {
      return 'unknown';
    }
  }
  return `isomorphic-git@${isoVersion()}`;
}

/**
 * Benchmark one provider across clone/fetch/pull/push.
 * Per run: fresh clone dir → timed clone → timed fetch(depth:1, app
 * semantics) → advance remote (untimed) → timed ff-only pull → local commit
 * via the provider (untimed) → timed push.
 * @returns {Array} PRD §30 entries (with runs/successRate extras)
 */
async function benchmarkProvider(providerName, ctx, runs) {
  const provider = makeProvider(providerName);
  const bundledVersion = await bundledVersionFor(providerName);
  const byOp = Object.fromEntries(OPERATIONS.map((op) => [op, []]));

  for (let run = 0; run < runs; run++) {
    const dir = path.join(ctx.baseDir, providerName, `run-${run}`);
    fs.rmSync(dir, { recursive: true, force: true });

    const record = async (op, fn) => {
      const t0 = process.hrtime.bigint();
      try {
        await withTimeout(`${providerName}.${op}`, fn);
        byOp[op].push({
          durationMs: Number(process.hrtime.bigint() - t0) / 1e6,
          success: true,
          error: null,
        });
      } catch (err) {
        byOp[op].push({
          durationMs: Number(process.hrtime.bigint() - t0) / 1e6,
          success: false,
          error: redact(err?.message || err),
        });
      }
    };

    // clone (fresh dir)
    await record('clone', (signal) => provider.clone(ctx.remoteUrl, dir, { signal }));

    // fetch — app-wide shallow semantics
    await record('fetch', (signal) => provider.fetch(dir, { depth: 1, signal }));

    // pull — advance the remote first so the pull has work to do
    // (iso-git pull demands an author even for fast-forward merges)
    await advanceRemote(ctx.bareDir, run);
    await record('pull', (signal) =>
      provider.pull(dir, {
        fastForwardOnly: true,
        author: BENCH_AUTHOR,
        committer: BENCH_AUTHOR,
        signal,
      }));

    // push — new local commit (via the provider itself, untimed)
    try {
      fs.mkdirSync(dir, { recursive: true });
      const pushFile = `local-push-${run}.txt`;
      fs.writeFileSync(path.join(dir, pushFile), crypto.randomBytes(64));
      await provider.add(dir, [pushFile]);
      await provider.commit(dir, `bench: local commit ${run}`);
      const branch = await provider.currentBranch(dir);
      await record('push', (signal) =>
        provider.push(dir, { ...(branch ? { branch } : {}), signal }));
    } catch (err) {
      byOp.push.push({
        durationMs: 0,
        success: false,
        error: redact(`push setup failed: ${err?.message || err}`),
      });
    }
  }

  resetGitProviderCache();

  return OPERATIONS.map((op) => {
    const runResults = byOp[op];
    const okDurations = runResults.filter((r) => r.success).map((r) => r.durationMs);
    const firstError = runResults.find((r) => !r.success)?.error || null;
    return {
      provider: providerName,
      operation: op,
      durationMs: median(okDurations),
      success: runResults.every((r) => r.success),
      error: firstError,
      bundledVersion,
      runs: runResults,
      successRate: runResults.length
        ? runResults.filter((r) => r.success).length / runResults.length
        : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmtMs(v) {
  return v === null ? 'n/a' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}

function printTable(entries, compare) {
  const providers = [...new Set(entries.map((e) => e.provider))];
  const widths = { provider: Math.max(8, ...providers.map((p) => p.length)), operation: 9 };

  const header =
    `| ${'provider'.padEnd(widths.provider)} | ${'operation'.padEnd(widths.operation)} | ` +
    `median     | success  | error`;
  const sep = `| ${'-'.repeat(widths.provider)} | ${'-'.repeat(widths.operation)} | ` +
    `----------- | -------- | -----`;
  console.log(header);
  console.log(sep);
  for (const e of entries) {
    const rate = `${Math.round(e.successRate * 100)}%`;
    console.log(
      `| ${e.provider.padEnd(widths.provider)} | ${e.operation.padEnd(widths.operation)} | ` +
      `${fmtMs(e.durationMs).padEnd(9)} | ${rate.padEnd(8)} | ${e.error ? 'yes' : '-'}`
    );
  }

  if (compare && providers.length === 2) {
    const [iso, dug] = ['isomorphic-git', 'dugite'].map((p) =>
      Object.fromEntries(
        entries.filter((e) => e.provider === p).map((e) => [e.operation, e])
      )
    );
    console.log('\nDelta (dugite vs isomorphic-git, medians):');
    for (const op of OPERATIONS) {
      const a = iso[op]?.durationMs;
      const b = dug[op]?.durationMs;
      if (a == null || b == null) {
        console.log(`  ${op.padEnd(8)} n/a (missing successful run)`);
        continue;
      }
      const ratio = b / a;
      const flag =
        op === 'push' && ratio > 1.5
          ? '  <-- exceeds 1.5x success criterion (evaluate manually)'
          : '';
      console.log(`  ${op.padEnd(8)} iso ${fmtMs(a)} | dugite ${fmtMs(b)} | ${ratio.toFixed(2)}x${flag}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const originalProvider = process.env.GIT_PROVIDER;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-benchmark-'));
  console.log(
    `Synthetic repo: ${args.files} files / ${args.sizeMB}MB total -> ${baseDir}` +
    ` | runs: ${args.runs}${args.compare ? ' | compare mode' : ''}`
  );

  let httpServer = null;
  try {
    const ctx = await buildSyntheticRepo(baseDir, args.files, args.sizeMB);
    httpServer = ctx.server;
    console.log(`Local bare remote over loopback http (no external network): ${ctx.remoteUrl}\n`);

    const providerNames = args.compare
      ? ['isomorphic-git', 'dugite']
      : [
          (process.env.GIT_PROVIDER || '').trim() ||
            require('../src/config/git-config').resolveGitProvider().provider,
        ];

    const entries = [];
    for (const name of providerNames) {
      console.log(`--- provider: ${name} ---`);
      entries.push(...(await benchmarkProvider(name, ctx, args.runs)));
    }

    console.log('');
    printTable(entries, args.compare);
    console.log('\nJSON (PRD §30; durationMs = median across runs):');
    console.log(JSON.stringify(entries, null, 2));
  } finally {
    process.env.GIT_PROVIDER = originalProvider;
    resetGitProviderCache();
    if (httpServer) {
      await new Promise((r) => httpServer.close(r));
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[git-benchmark] FATAL: ${redact(err?.stack || err?.message || err)}`);
  process.exitCode = 1;
});
