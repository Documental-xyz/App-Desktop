/**
 * @fileoverview Integration test for GitHub authentication
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// GITHUB_CONFIG (src/config/github-config.js) resolves CLIENT_ID exactly once,
// at module import time. Setting the env var in beforeEach is too late, so we
// capture it here at the top of the file, before any dynamic import of the
// config module. No real client-id is embedded — only the env value is used.
const githubClientId = (process.env.GITHUB_CLIENT_ID || '').trim();
const hasGithubClientId = githubClientId.length > 0;

// The config module resolves CLIENT_ID in an async IIFE after import, so we
// poll briefly until it settles instead of racing it.
async function waitForResolvedConfig(timeoutMs = 2000) {
  const { GITHUB_CONFIG } = await import('../../src/config/github-config.js');
  const start = Date.now();
  while (GITHUB_CONFIG.CLIENT_ID === '' && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return GITHUB_CONFIG;
}

describe('GitHub Authentication Integration Tests', () => {
  let authHandlers;
  let mockLogger;
  let mockDatabaseManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };

    mockDatabaseManager = {
      getDatabase: vi.fn().mockResolvedValue({
        run: vi.fn((query, params, callback) => {
          callback(null);
        })
      })
    };

    const { AuthHandlers } = await import('../../src/ipc/auth.js');
    authHandlers = new AuthHandlers({
      logger: mockLogger,
      databaseManager: mockDatabaseManager
    });
  });

  describe('Device Flow Integration', () => {
    it.skipIf(!hasGithubClientId, 'requires GITHUB_CLIENT_ID (live network request)')('should successfully initiate device flow with real GitHub API', async () => {
      // Test the actual device flow initiation
      const GITHUB_CONFIG = await waitForResolvedConfig();

      expect(GITHUB_CONFIG.CLIENT_ID).toBe(githubClientId);
      expect(GITHUB_CONFIG.DEVICE_CODE_URL).toBe('https://github.com/login/device/code');
      
      // Test the makeHttpsRequest method directly
      const testResponse = await authHandlers.makeHttpsRequest(GITHUB_CONFIG.DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Documental-App/1.0'
        },
        body: JSON.stringify({
          client_id: GITHUB_CONFIG.CLIENT_ID,
          scope: GITHUB_CONFIG.SCOPES.join(' ')
        })
      });

      expect(testResponse).toBeDefined();
      expect(testResponse.device_code).toBeDefined();
      expect(testResponse.user_code).toBeDefined();
      expect(testResponse.verification_uri).toBe('https://github.com/login/device');
      expect(testResponse.expires_in).toBeGreaterThan(0);
      expect(testResponse.interval).toBeGreaterThan(0);

      console.log('✅ Device flow integration test passed!');
      console.log('Device Code:', testResponse.device_code);
      console.log('User Code:', testResponse.user_code);
      console.log('Verification URI:', testResponse.verification_uri);
    }, 15000); // 15 second timeout for network request

    it('should handle invalid client ID gracefully', async () => {
      // Test with invalid client ID
      const { GITHUB_CONFIG } = await import('../../src/config/github-config.js');
      const originalClientId = GITHUB_CONFIG.CLIENT_ID;
      
      // Temporarily set invalid client ID
      GITHUB_CONFIG.CLIENT_ID = 'invalid_client_id';

      try {
        await authHandlers.makeHttpsRequest(GITHUB_CONFIG.DEVICE_CODE_URL, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Documental-App/1.0'
          },
          body: JSON.stringify({
            client_id: GITHUB_CONFIG.CLIENT_ID,
            scope: GITHUB_CONFIG.SCOPES.join(' ')
          })
        });
        
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(error.message).toContain('HTTP 404');
        expect(error.message).toContain('Not Found');
      } finally {
        // Restore original client ID
        GITHUB_CONFIG.CLIENT_ID = originalClientId;
      }
    }, 10000); // 10 second timeout
  });

  describe('Configuration Validation', () => {
    it.skipIf(!hasGithubClientId, 'requires GITHUB_CLIENT_ID (validates env-provided client-id)')('should validate GitHub configuration in test environment', async () => {
      const { validateGitHubConfig } = await import('../../src/config/github-config.js');
      const GITHUB_CONFIG = await waitForResolvedConfig();
      
      const validation = validateGitHubConfig();
      
      expect(validation.isValid).toBe(true);
      expect(validation.warnings.length).toBe(0); // Should be no warnings when env var is set
      expect(validation.errors.length).toBe(0);
      
      expect(GITHUB_CONFIG.CLIENT_ID).toBe(githubClientId);
      expect(GITHUB_CONFIG.SCOPES).toEqual(['user:email', 'repo', 'read:org']);
      expect(GITHUB_CONFIG.DEVICE_CODE_URL).toBe('https://github.com/login/device/code');
      expect(GITHUB_CONFIG.TOKEN_URL).toBe('https://github.com/login/oauth/access_token');
      expect(GITHUB_CONFIG.VERIFICATION_URI).toBe('https://github.com/login/device');
    });
  });
});