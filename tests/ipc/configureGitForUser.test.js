/**
 * @fileoverview Test for configureGitForUser function
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitOperations } from '../../src/ipc/gitOperations.js';

describe('GitOperations configureGitForUser', () => {
  let gitOps;
  let mockLogger;
  let mockDatabaseManager;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };

    mockDatabaseManager = {
      getDatabase: vi.fn()
    };

    gitOps = new GitOperations({ logger: mockLogger, databaseManager: mockDatabaseManager });
  });

  it('should have configureGitForUser method', () => {
    expect(typeof gitOps.configureGitForUser).toBe('function');
  });

  it('should handle missing token gracefully', async () => {
    // Mock getGitHubToken to return null
    vi.spyOn(gitOps, 'getGitHubToken').mockResolvedValue(null);

    const result = await gitOps.configureGitForUser('/test/path');
    
    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith('⚠️ No GitHub token found, cannot configure git user');
  });

  it('should handle missing user info gracefully', async () => {
    // Mock getGitHubToken to return a token
    vi.spyOn(gitOps, 'getGitHubToken').mockResolvedValue('fake-token');
    // Mock getGitHubUserInfo to return null
    vi.spyOn(gitOps, 'getGitHubUserInfo').mockResolvedValue(null);

    const result = await gitOps.configureGitForUser('/test/path');
    
    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith('⚠️ Could not get GitHub user info, cannot configure git user');
  });

  it('should call gitSetUserConfig with correct parameters', async () => {
    const mockUserInfo = {
      login: 'testuser',
      name: 'Test User',
      email: 'test@example.com'
    };

    // Mock dependencies
    vi.spyOn(gitOps, 'getGitHubToken').mockResolvedValue('fake-token');
    vi.spyOn(gitOps, 'getGitHubUserInfo').mockResolvedValue(mockUserInfo);
    vi.spyOn(gitOps, 'gitSetUserConfig').mockResolvedValue(true);
    vi.spyOn(gitOps.git, 'setConfig').mockResolvedValue(undefined);

    const result = await gitOps.configureGitForUser('/test/path');

    expect(result).toBe(true);
      expect(gitOps.gitSetUserConfig).toHaveBeenCalledWith('/test/path', 'Test User', 'test@example.com');
      expect(mockLogger.info).toHaveBeenCalledWith('✅ Git user configured successfully: Test User <test@example.com>');
  });

  it('should use login as fallback for name when name is missing', async () => {
    const mockUserInfo = {
      login: 'testuser',
      email: 'test@example.com'
    };

    // Mock dependencies
    vi.spyOn(gitOps, 'getGitHubToken').mockResolvedValue('fake-token');
    vi.spyOn(gitOps, 'getGitHubUserInfo').mockResolvedValue(mockUserInfo);
    vi.spyOn(gitOps, 'gitSetUserConfig').mockResolvedValue(true);
    vi.spyOn(gitOps.git, 'setConfig').mockResolvedValue(undefined);

    const result = await gitOps.configureGitForUser('/test/path');

    expect(result).toBe(true);
    expect(gitOps.gitSetUserConfig).toHaveBeenCalledWith('/test/path', 'testuser', 'test@example.com');
  });

  it('should generate noreply email when email is missing', async () => {
    const mockUserInfo = {
      login: 'testuser',
      name: 'Test User'
    };

    // Mock dependencies
    vi.spyOn(gitOps, 'getGitHubToken').mockResolvedValue('fake-token');
    vi.spyOn(gitOps, 'getGitHubUserInfo').mockResolvedValue(mockUserInfo);
    vi.spyOn(gitOps, 'gitSetUserConfig').mockResolvedValue(true);
    vi.spyOn(gitOps.git, 'setConfig').mockResolvedValue(undefined);

    const result = await gitOps.configureGitForUser('/test/path');

    expect(result).toBe(true);
    expect(gitOps.gitSetUserConfig).toHaveBeenCalledWith('/test/path', 'Test User', 'testuser@users.noreply.github.com');
  });

  it('should get cached user info without API calls', async () => {
    const mockCachedUser = {
      githubId: '123456',
      login: 'cacheduser',
      name: 'Cached User',
      email: 'cached@example.com',
      avatarUrl: 'https://avatar.url',
      updatedAt: '2024-01-01T00:00:00Z'
    };

    // Mock database
    const mockDb = {
      get: vi.fn((query, callback) => {
        callback(null, mockCachedUser);
      })
    };
    mockDatabaseManager.getDatabase.mockResolvedValue(mockDb);

    const result = await gitOps.getCachedUserInfo();
    
    expect(result).toEqual({
      id: '123456',
      login: 'cacheduser',
      name: 'Cached User',
      email: 'cached@example.com',
      avatar_url: 'https://avatar.url',
      cached: true,
      cachedAt: '2024-01-01T00:00:00Z'
    });
    expect(mockLogger.info).toHaveBeenCalledWith('✅ Retrieved cached user info: cacheduser');
  });
});