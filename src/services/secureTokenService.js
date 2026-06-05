/**
 * @fileoverview Secure Token Service for GitHub OAuth tokens
 * @author Documental Team
 * @since 1.0.0
 * 
 * Provides secure storage and validation of GitHub OAuth tokens
 * using Electron's safeStorage API for encryption with file-based persistence
 */

'use strict';

const { safeStorage, app } = require('electron');
const fs = require('fs').promises;
const path = require('path');
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

      if (!safeStorage.isEncryptionAvailable()) {
        logger.error('❌ safeStorage encryption is not available on this system');
        return false;
      }

      const encrypted = safeStorage.encryptString(token);
      const data = {
        encrypted: encrypted.toString('base64'),
        updatedAt: new Date().toISOString()
      };

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
        const token = safeStorage.decryptString(Buffer.from(data.encrypted, 'base64'));

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
        // File doesn't exist or can't be read
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
