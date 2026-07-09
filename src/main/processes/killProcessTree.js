/**
 * @fileoverview Two-phase process tree killer using execa's killDescendants
 * @author Documental Team
 * @since 2.0.0
 */

'use strict';

/**
 * Gracefully terminate a process tree with SIGTERM, escalating to SIGKILL.
 *
 * Designed for execa subprocesses spawned with `killDescendants: true`,
 * which causes signals to propagate to the entire process group.
 *
 * @param {import('execa').ExecaChildProcess} subprocess - The execa subprocess to terminate
 * @param {number} [gracePeriod=1500] - Milliseconds to wait before escalating to SIGKILL
 * @returns {Promise<void>} Resolves when the subprocess has actually exited
 */
async function killProcessTree(subprocess, gracePeriod = 1500) {
  // Already killed or already exited — no-op
  if (subprocess.killed || subprocess.exitCode !== null || subprocess.pid === undefined) {
    return;
  }

  // Phase 1: Send SIGTERM (with killDescendants:true, this propagates to the process group)
  const sigtermSent = subprocess.kill('SIGTERM');
  if (!sigtermSent) {
    // Process already exited between our check and kill call
    return;
  }

  // Phase 2: Wait for subprocess to exit or timeout
  let exited = false;

  const exitPromise = new Promise((resolve) => {
    const onExit = () => {
      exited = true;
      resolve();
    };
    subprocess.once('exit', onExit);
    subprocess.once('error', onExit);
  });

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(resolve, gracePeriod + 1000);
  });

  await Promise.race([exitPromise, timeoutPromise]);

  // Phase 3: Escalate to SIGKILL if still alive
  if (!exited) {
    subprocess.kill('SIGKILL');
    // Wait for actual exit
    await new Promise((resolve) => {
      subprocess.once('exit', resolve);
      subprocess.once('error', resolve);
    });
  }
}

module.exports = { killProcessTree };
