/**
 * @vitest-environment node
 * @fileoverview Tests for SecureTokenService
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mocks — available inside vi.mock() factories ─────────────────

const {
  mockSafeStorage,
  mockApp,
  mockFs,
  mockLogger,
  mockGetLogger
} = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  };
  return {
    mockSafeStorage: {
      encryptString: vi.fn(() => Buffer.from('encrypted-data')),
      decryptString: vi.fn(() => 'ghp_' + 'a'.repeat(36)),
      isEncryptionAvailable: vi.fn(() => true)
    },
    mockApp: {
      getPath: vi.fn(() => '/tmp/test-userdata')
    },
    mockFs: {
      readFile: vi.fn(),
      writeFile: vi.fn(() => Promise.resolve()),
      unlink: vi.fn(() => Promise.resolve())
    },
    mockLogger: logger,
    mockGetLogger: vi.fn(() => logger)
  };
});

// ── Module mocks (hoisted before imports by vitest) ──────────────────────

vi.mock('electron', () => ({
  safeStorage: mockSafeStorage,
  app: mockApp,
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => undefined
  }
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  promises: mockFs
}));

vi.mock('../../src/main/logging/logger', () => ({
  getLogger: mockGetLogger,
  Logger: vi.fn(),
  appLogger: mockLogger
}));

// ── Static import AFTER vi.mock() (vitest hoists mocks above this) ───────

import { SecureTokenService } from '../../src/services/secureTokenService.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const VALID_CLASSIC_TOKEN = 'ghp_' + 'a'.repeat(36);

function resetMocks() {
  mockSafeStorage.encryptString.mockClear();
  mockSafeStorage.decryptString.mockClear();
  mockSafeStorage.isEncryptionAvailable.mockClear();

  mockFs.readFile.mockClear();
  mockFs.writeFile.mockClear();
  mockFs.unlink.mockClear();

  mockLogger.info.mockClear();
  mockLogger.error.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.debug.mockClear();

  // Reset behaviours
  mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
  mockSafeStorage.encryptString.mockReturnValue(Buffer.from('encrypted-data'));
  mockSafeStorage.decryptString.mockReturnValue(VALID_CLASSIC_TOKEN);
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.unlink.mockResolvedValue(undefined);
  mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('SecureTokenService', () => {
  let service;

  beforeEach(() => {
    resetMocks();
    service = new SecureTokenService();
  });

  // ── storeToken ─────────────────────────────────────────────────────────

  describe('storeToken', () => {
    it('should encrypt and write file for a valid token, returning true', async () => {
      const result = await service.storeToken(VALID_CLASSIC_TOKEN);

      expect(result).toBe(true);
      expect(mockSafeStorage.encryptString).toHaveBeenCalledWith(VALID_CLASSIC_TOKEN);
      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
    });

    it('should return false for token under 20 characters', async () => {
      const result = await service.storeToken('short-token');

      expect(result).toBe(false);
      expect(mockSafeStorage.encryptString).not.toHaveBeenCalled();
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('should return false for null token', async () => {
      const result = await service.storeToken(null);

      expect(result).toBe(false);
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('should return false for empty string token', async () => {
      const result = await service.storeToken('');

      expect(result).toBe(false);
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('should return false when safeStorage encryption is unavailable', async () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

      const result = await service.storeToken(VALID_CLASSIC_TOKEN);

      expect(result).toBe(false);
      expect(mockSafeStorage.encryptString).not.toHaveBeenCalled();
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('should return false when writeFile throws', async () => {
      mockFs.writeFile.mockRejectedValue(new Error('Disk full'));

      const result = await service.storeToken(VALID_CLASSIC_TOKEN);

      expect(result).toBe(false);
    });
  });

  // ── getToken ───────────────────────────────────────────────────────────

  describe('getToken', () => {
    it('should decrypt and return token when file exists with valid data', async () => {
      const encryptedBase64 = Buffer.from('encrypted-data').toString('base64');
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ encrypted: encryptedBase64, updatedAt: new Date().toISOString() })
      );
      mockSafeStorage.decryptString.mockReturnValue(VALID_CLASSIC_TOKEN);

      const result = await service.getToken();

      expect(result).toBe(VALID_CLASSIC_TOKEN);
      expect(mockSafeStorage.decryptString).toHaveBeenCalledTimes(1);
    });

    it('should return null when file does not exist', async () => {
      const error = new Error('ENOENT: no such file');
      error.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(error);

      const result = await service.getToken();

      expect(result).toBeNull();
    });

    it('should delete token and return null when stored token has invalid format', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ encrypted: 'abc', updatedAt: new Date().toISOString() })
      );
      mockSafeStorage.decryptString.mockReturnValue('short');
      mockFs.unlink.mockResolvedValue(undefined);

      const result = await service.getToken();

      expect(result).toBeNull();
      expect(mockFs.unlink).toHaveBeenCalled();
    });

    it('should return null when decryption fails', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ encrypted: '!!!bad-data!!!', updatedAt: new Date().toISOString() })
      );
      mockSafeStorage.decryptString.mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      const result = await service.getToken();

      expect(result).toBeNull();
    });
  });

  // ── deleteToken ────────────────────────────────────────────────────────

  describe('deleteToken', () => {
    it('should delete file and return true when file exists', async () => {
      mockFs.unlink.mockResolvedValue(undefined);

      const result = await service.deleteToken();

      expect(result).toBe(true);
      expect(mockFs.unlink).toHaveBeenCalledTimes(1);
    });

    it('should return false when file does not exist (ENOENT)', async () => {
      const error = new Error('ENOENT: no such file');
      error.code = 'ENOENT';
      mockFs.unlink.mockRejectedValue(error);

      const result = await service.deleteToken();

      expect(result).toBe(false);
    });

    it('should return false for non-ENOENT unlink errors', async () => {
      const error = new Error('Permission denied');
      error.code = 'EACCES';
      mockFs.unlink.mockRejectedValue(error);

      const result = await service.deleteToken();

      expect(result).toBe(false);
    });
  });

  // ── isValidToken ───────────────────────────────────────────────────────

  describe('isValidToken', () => {
    it('should return true for valid classic PAT (ghp_ prefix)', () => {
      expect(service.isValidToken(VALID_CLASSIC_TOKEN)).toBe(true);
    });

    it('should return false for token under 20 characters', () => {
      expect(service.isValidToken('ghp_short')).toBe(false);
    });

    it('should return false for null', () => {
      expect(service.isValidToken(null)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(service.isValidToken('')).toBe(false);
    });

    it('should return false for non-string values', () => {
      expect(service.isValidToken(12345)).toBe(false);
    });

    it('should return true for unrecognized but sufficiently long token', () => {
      expect(service.isValidToken('x'.repeat(25))).toBe(true);
    });

    it('should return true for valid fine-grained PAT', () => {
      const token = 'github_pat_' + 'a'.repeat(82);
      expect(service.isValidToken(token)).toBe(true);
    });
  });

  // ── getTokenType ───────────────────────────────────────────────────────

  describe('getTokenType', () => {
    it('should return CLASSIC for ghp_ tokens', () => {
      expect(service.getTokenType(VALID_CLASSIC_TOKEN)).toBe('CLASSIC');
    });

    it('should return null for valid but unrecognized token', () => {
      expect(service.getTokenType('x'.repeat(30))).toBeNull();
    });

    it('should return null for invalid token', () => {
      expect(service.getTokenType('short')).toBeNull();
    });
  });

  // ── hasToken ───────────────────────────────────────────────────────────

  describe('hasToken', () => {
    it('should return true when token exists', async () => {
      const encryptedBase64 = Buffer.from('encrypted-data').toString('base64');
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ encrypted: encryptedBase64, updatedAt: new Date().toISOString() })
      );
      mockSafeStorage.decryptString.mockReturnValue(VALID_CLASSIC_TOKEN);

      expect(await service.hasToken()).toBe(true);
    });

    it('should return false when no token exists', async () => {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(error);

      expect(await service.hasToken()).toBe(false);
    });
  });

  // ── validateStoredToken ────────────────────────────────────────────────

  describe('validateStoredToken', () => {
    it('should return true when stored token is valid', async () => {
      const encryptedBase64 = Buffer.from('encrypted-data').toString('base64');
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ encrypted: encryptedBase64, updatedAt: new Date().toISOString() })
      );
      mockSafeStorage.decryptString.mockReturnValue(VALID_CLASSIC_TOKEN);

      expect(await service.validateStoredToken()).toBe(true);
    });

    it('should return false when no token is stored', async () => {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(error);

      expect(await service.validateStoredToken()).toBe(false);
    });
  });
});
