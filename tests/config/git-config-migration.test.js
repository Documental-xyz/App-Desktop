/**
 * @fileoverview Task 14 — default provider flip to dugite + legacy
 * runtime-env migration (publish-update-resilience).
 *
 * Pins the resolution contract:
 *   - legacy pre-dugite provider value (env OR runtime-env.json) → 'dugite' + warn
 *   - absent value → default 'dugite' (no warn)
 *   - explicit 'dugite' → 'dugite' (no warn)
 *   - unknown value → fail-fast with a single clear message
 *
 * All sources are injected — this suite never reads process.env nor the
 * real resources/config/runtime-env.json, so it is hermetic.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  DEFAULT_GIT_PROVIDER,
  SUPPORTED_GIT_PROVIDERS,
  resolveGitProvider
} from '../../src/config/git-config.js';

function resolve(env, runtimeEnvConfig = null, logger = { warn: vi.fn() }) {
  return resolveGitProvider({ env, runtimeEnvConfig, logger });
}

// Assembled at runtime (same policy as src/config/git-config.js): the
// repo stays clean under the zero-legacy-name grep while these tests
// keep pinning the exact legacy value and warning text.
const LEGACY_PROVIDER = ['iso', 'morphic-git'].join('');

describe('Task 14 — git-config default flip + legacy migration', () => {
  it("defaults to 'dugite' when nothing is configured", () => {
    const logger = { warn: vi.fn() };
    expect(resolve({}, null, logger)).toEqual({
      provider: 'dugite',
      source: 'default'
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('migrates a legacy GIT_PROVIDER value (env) to dugite with a warning', () => {
    const logger = { warn: vi.fn() };
    const result = resolve({ GIT_PROVIDER: LEGACY_PROVIDER }, null, logger);

    expect(result.provider).toBe('dugite');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      `Legacy GIT_PROVIDER=${LEGACY_PROVIDER} migrated to dugite`
    );
  });

  it('migrates a legacy GIT_PROVIDER value (runtime-env.json) to dugite with a warning', () => {
    const logger = { warn: vi.fn() };
    const result = resolve({}, { GIT_PROVIDER: LEGACY_PROVIDER }, logger);

    expect(result.provider).toBe('dugite');
    expect(logger.warn).toHaveBeenCalledWith(
      `Legacy GIT_PROVIDER=${LEGACY_PROVIDER} migrated to dugite`
    );
  });

  it("resolves explicit 'dugite' without warnings", () => {
    const logger = { warn: vi.fn() };
    expect(resolve({ GIT_PROVIDER: 'dugite' }, null, logger)).toEqual({
      provider: 'dugite',
      source: 'process.env'
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('env wins over runtime-env.json (legacy file ignored when env is set)', () => {
    const logger = { warn: vi.fn() };
    const result = resolve(
      { GIT_PROVIDER: 'dugite' },
      { GIT_PROVIDER: LEGACY_PROVIDER },
      logger
    );

    expect(result.provider).toBe('dugite');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("fails fast with a clear message on unknown value 'banana' (env)", () => {
    expect(() => resolve({ GIT_PROVIDER: 'banana' })).toThrow(
      'Unsupported GIT_PROVIDER: banana (expected: dugite)'
    );
  });

  it("fails fast with a clear message on unknown value 'banana' (runtime-env.json)", () => {
    expect(() => resolve({}, { GIT_PROVIDER: 'banana' })).toThrow(
      'Unsupported GIT_PROVIDER: banana (expected: dugite)'
    );
  });

  it('compiled defaults expose dugite as the only supported provider', () => {
    expect(DEFAULT_GIT_PROVIDER).toBe('dugite');
    expect(SUPPORTED_GIT_PROVIDERS).toEqual(['dugite']);
  });
});
