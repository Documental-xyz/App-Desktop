/**
 * @vitest-environment node
 *
 * Sync capability probe: does the bundled git ship `git-http-backend`
 * in libexec? Some minimal git builds inside dugite (mac/win runners)
 * lack the CGI — every clone against the loopback smart-http server
 * then dies with HTTP 500 ("git: 'http-backend' is not a git command").
 *
 * Suites that DEPEND on the loopback transport gate on this flag
 * (describe/it .skipIf — conditional skip, providerHarness convention):
 * the probe re-evaluates on every run, so the gates re-open by
 * themselves the moment a runner's git ships the binary. This module is
 * a LEAF (dugite + fs + path only) so no import-cycle evaluation order
 * can shadow the flag — do NOT add imports here.
 */
import { vi } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import { resolveGitExecPath } from 'dugite';

export const httpBackendAvailable = (() => {
  try {
    const bin = process.platform === 'win32' ? 'git-http-backend.exe' : 'git-http-backend';
    return fs.existsSync(path.join(resolveGitExecPath(), bin));
  } catch (_e) {
    return false;
  }
})();
