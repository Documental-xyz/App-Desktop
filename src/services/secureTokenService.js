/**
 * @fileoverview Secure Token Service for GitHub OAuth tokens
 * @author Documental Team
 * @since 1.0.0
 * 
 * Provides secure storage and validation of GitHub OAuth tokens
 * using Electron's safeStorage API (preferred) or Node.js crypto (fallback)
 * with file-based persistence
 */

'use strict';

const { safeStorage, app } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { getLogger } = require('../main/logging/logger');

const logger = getLogger('SecureTokenService');

/**
 * Service name for storage
 */
const SERVICE_NAME = 'documental-app';

/**
 * Account name for GitHub tokens
 */
const GITHUB_ACCOUNT = 'github-token';

/**
 * Algorithm used for fallback encryption
 */
const FALLBACK_ALGORITHM = 'aes-256-gcm';

/**
 * GitHub token validation patterns
 */
const GITHUB_TOKEN_PATTERNS = {
  // Classic personal access tokens
  CLASSIC: /^ghp_[a-zA-Z0-9]{36}$/,
  // OAuth application tokens (legacy prefixes)
  OAUTH_LEGACY: /^gh[o|u|t]_[a-zA-Z0-9]{36}$/,
  // Fine-grained tokens (fixed length)
  FINE_GRAINED: /^github_pat_[a-zA-Z0-9_]{82}$/,
  // Fine-grained tokens (variable length, GitHub may issue different sizes)
  FINE_GRAINED_V2: /^github_pat_[a-zA-Z0-9_]{10,}$/
};

const MIN_TOKEN_LENGTH = 20;

/**
 * Total attempts for a safeStorage decrypt before giving up.
 * The first decryptString of a process lifetime can race the OS secret
 * store (libsecret via DBus, Windows/macOS keychains) becoming reachable
 * or unlocked on cold start — Electron documents exactly this temporary
 * unavailability for the sync API, so transient failures are retried.
 */
const DECRYPT_MAX_ATTEMPTS = 3;

/**
 * Backoff delays in ms before decrypt attempts 2 and 3 (300ms → 900ms).
 */
const DECRYPT_RETRY_DELAYS_MS = [300, 900];

/**
 * Derive an encryption key from machine-specific data.
 * This is used as a fallback when safeStorage is not available.
 * @returns {string} Hex-encoded 32-byte key
 */
function _getMachineKey() {
  const machineId = [
    os.hostname(),
    os.userInfo().username,
    app.getPath('userData'),
    'documental-token-encryption-v1'
  ].join(':');
  return crypto.createHash('sha256').update(machineId).digest('hex');
}

/**
 * Encrypt text using AES-256-GCM with a machine-derived key
 * @param {string} text - Plain text to encrypt
 * @returns {object} Encrypted payload with iv, tag, encrypted
 */
function _fallbackEncrypt(text) {
  const key = _getMachineKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(FALLBACK_ALGORITHM, Buffer.from(key, 'hex'), iv);
  
  let encrypted = cipher.update(text, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  
  const authTag = cipher.getAuthTag();
  
  return {
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    encrypted: encrypted
  };
}

/**
 * Decrypt text using AES-256-GCM with a machine-derived key
 * @param {object} data - Object with iv, tag, encrypted fields
 * @returns {string} Decrypted plain text
 */
function _fallbackDecrypt(data) {
  const key = _getMachineKey();
  const iv = Buffer.from(data.iv, 'base64');
  const tag = Buffer.from(data.tag, 'base64');
  
  const decipher = crypto.createDecipheriv(FALLBACK_ALGORITHM, Buffer.from(key, 'hex'), iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(data.encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Secure Token Service class
 */
class SecureTokenService {
  /**
   * Get the path to the encrypted token file
   * @returns {string} Path to encrypted token file
   * @private
   */
  _getTokenFilePath() {
    return path.join(app.getPath('userData'), 'github-token.enc.json');
  }

  /**
   * Check if safeStorage encryption is available
   * @returns {boolean}
   * @private
   */
  _isSafeStorageAvailable() {
    try {
      return safeStorage && safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Decrypt via safeStorage, retrying transient failures with backoff.
   * On cold start the OS secret store may not be reachable/unlocked yet and
   * the synchronous decryptString throws until it is; retrying bridges that
   * window so a momentarily-unavailable keyring is not reported as
   * "no token". ENOENT never reaches this method (fast null upstream).
   * @param {Buffer} buffer - Encrypted payload read from the token file
   * @returns {Promise<{ok: boolean, token: string|null}>} ok=false after
   *   DECRYPT_MAX_ATTEMPTS exhausted failures (token file is kept)
   * @private
   */
  async _decryptWithRetry(buffer) {
    for (let attempt = 1; attempt <= DECRYPT_MAX_ATTEMPTS; attempt++) {
      try {
        return { ok: true, token: safeStorage.decryptString(buffer) };
      } catch (error) {
        if (attempt < DECRYPT_MAX_ATTEMPTS) {
          const delay = DECRYPT_RETRY_DELAYS_MS[attempt - 1];
          logger.warn(
            `⚠️ safeStorage decrypt failed (attempt ${attempt}/${DECRYPT_MAX_ATTEMPTS}), ` +
            `retrying in ${delay}ms — keyring may still be warming up: ${error.message}`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          logger.warn(
            `❌ safeStorage decrypt failed after ${DECRYPT_MAX_ATTEMPTS} attempts ` +
            `(keyring unavailable?): ${error.message}`
          );
        }
      }
    }
    return { ok: false, token: null };
  }

  /**
   * Store GitHub token securely
   * @param {string} token - GitHub OAuth token
   * @returns {Promise<boolean>} Success status
   */
  async storeToken(token) {
    try {
      if (!this.isValidToken(token)) {
        logger.error('❌ Attempted to store invalid token format');
        return false;
      }

      const useSafeStorage = this._isSafeStorageAvailable();
      const data = {
        updatedAt: new Date().toISOString()
      };

      if (useSafeStorage) {
        const encrypted = safeStorage.encryptString(token);
        data.method = 'safeStorage';
        data.encrypted = encrypted.toString('base64');
        logger.info('🔐 Using Electron safeStorage for encryption');
      } else {
        logger.warn('⚠️ safeStorage unavailable, using fallback encryption (AES-256-GCM)');
        const fallback = _fallbackEncrypt(token);
        data.method = 'fallback';
        data.encrypted = fallback.encrypted;
        data.iv = fallback.iv;
        data.tag = fallback.tag;
      }

      await fs.writeFile(this._getTokenFilePath(), JSON.stringify(data, null, 2), 'utf8');
      logger.info('✅ GitHub token stored securely');
      return true;
    } catch (error) {
      logger.error('❌ Failed to store GitHub token:', error.message);
      return false;
    }
  }

  /**
   * Retrieve GitHub token from secure storage
   * @returns {Promise<string|null>} Token or null if not found
   */
  async getToken() {
    try {
      const filePath = this._getTokenFilePath();

      try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        const data = JSON.parse(fileContent);
        let token;

        if (data.method === 'safeStorage') {
          const decrypted = await this._decryptWithRetry(Buffer.from(data.encrypted, 'base64'));
          if (!decrypted.ok) {
            // Transient keyring failure — keep the token file so a later
            // call can succeed once the secret store is reachable.
            return null;
          }
          token = decrypted.token;
        } else if (data.method === 'fallback') {
          token = _fallbackDecrypt(data);
        } else {
          // Legacy format (no method field) — try safeStorage first, then fallback
          try {
            token = safeStorage.decryptString(Buffer.from(data.encrypted, 'base64'));
          } catch {
            logger.warn('⚠️ Could not decrypt legacy token, removing it');
            await this.deleteToken();
            return null;
          }
        }

        if (token) {
          if (this.isValidToken(token)) {
            logger.info('✅ GitHub token retrieved from secure storage');
            return token;
          } else {
            logger.warn('⚠️ Stored token has invalid format, removing it');
            await this.deleteToken();
            return null;
          }
        }
      } catch (readError) {
        // File missing/unreadable or payload undecryptable (fallback/legacy
        // paths) — safeStorage transient failures are retried above and
        // never reach this catch.
      }

      logger.info('ℹ️ No GitHub token found in secure storage');
      return null;
    } catch (error) {
      logger.error('❌ Failed to retrieve GitHub token:', error.message);
      return null;
    }
  }

  /**
   * Delete GitHub token from secure storage
   * @returns {Promise<boolean>} Success status
   */
  async deleteToken() {
    try {
      await fs.unlink(this._getTokenFilePath());
      logger.info('✅ GitHub token deleted from secure storage');
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.info('ℹ️ No GitHub token found to delete');
        return false;
      }
      logger.error('❌ Failed to delete GitHub token:', error.message);
      return false;
    }
  }

  /**
   * Validate GitHub token format
   * @param {string} token - Token to validate
   * @returns {boolean} Whether token has valid format
   */
  isValidToken(token) {
    if (!token || typeof token !== 'string') {
      return false;
    }

    const trimmedToken = token.trim();

    if (trimmedToken.length < MIN_TOKEN_LENGTH) {
      logger.warn('⚠️ Token format validation failed (too short)');
      return false;
    }
    
    // Check against all valid patterns (best-effort detection)
    const isRecognizedPattern = Object.values(GITHUB_TOKEN_PATTERNS).some(
      pattern => pattern.test(trimmedToken)
    );

    if (!isRecognizedPattern) {
      logger.warn('⚠️ Token format not recognized (storing as OAuth access token)');
    }

    return true;
  }

  /**
   * Get token type (classic, fine-grained, etc.)
   * @param {string} token - Token to analyze
   * @returns {string|null} Token type or null if invalid
   */
  getTokenType(token) {
    if (!this.isValidToken(token)) {
      return null;
    }

    for (const [type, pattern] of Object.entries(GITHUB_TOKEN_PATTERNS)) {
      if (pattern.test(token)) {
        return type;
      }
    }

    return null;
  }

  /**
   * Check if token exists in secure storage
   * @returns {Promise<boolean>} Whether token exists
   */
  async hasToken() {
    try {
      const token = await this.getToken();
      return token !== null;
    } catch (error) {
      logger.error('❌ Failed to check token existence:', error.message);
      return false;
    }
  }

  /**
   * Refresh token validation and storage
   * @returns {Promise<boolean>} Whether token is valid and stored
   */
  async validateStoredToken() {
    try {
      const token = await this.getToken();
      return token !== null;
    } catch (error) {
      logger.error('❌ Failed to validate stored token:', error.message);
      return false;
    }
  }
}

// Create singleton instance
const secureTokenService = new SecureTokenService();

module.exports = {
  SecureTokenService,
  secureTokenService,
  SERVICE_NAME,
  GITHUB_ACCOUNT,
  GITHUB_TOKEN_PATTERNS
};
