/**
 * @fileoverview IPC handlers for GitHub authentication and user management
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain, clipboard } = require('electron');
const { secureTokenService } = require('../services/secureTokenService.js');
const { GITHUB_CONFIG } = require('../config/github-config.js');

/**
 * @typedef {Object} AuthResult
 * @property {boolean} success - Whether the operation succeeded
 * @property {Object} [userInfo] - GitHub user information
 * @property {string} [error] - Error message if operation failed
 */

/**
 * @typedef {Object} AuthStatus
 * @property {boolean} authenticated - Whether user is authenticated
 * @property {Object} [userInfo] - User information if authenticated
 * @property {string} [error] - Error message if not authenticated
 */

/**
 * Authentication IPC Handlers
 */
class AuthHandlers {
  /**
   * Create an instance of AuthHandlers
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.databaseManager - Database manager instance
   */
  constructor({ logger, databaseManager }) {
    this.logger = logger;
    this.databaseManager = databaseManager;
  }

  /**
   * Get GitHub token from secure storage
   * @returns {Promise<string|null>} GitHub token or null if not found
   */
  async getGitHubToken() {
    try {
      const token = await secureTokenService.getToken();
      return token;
    } catch (error) {
      this.logger.error('Error getting GitHub token:', error);
      return null;
    }
  }

  /**
   * Get GitHub user information using token
   * @param {string} token - GitHub token
   * @returns {Promise<Object|null>} User information or null if error
   */
  async getGitHubUserInfo(token) {
    try {
      // Dynamic import to handle ESM module
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: token });
      const { data } = await octokit.users.getAuthenticated();
      return data;
    } catch (error) {
      this.logger.error('Error getting GitHub user info:', error);
      return null;
    }
  }

  /**
   * Show authentication window with device code
   * @param {Object} deviceCodeResponse - Device code response from GitHub
   * @returns {Promise<Object>} Authentication result
   */
  async showAuthenticationWindow(deviceCodeResponse) {
    return new Promise((resolve) => {
      const { user_code, verification_uri, expires_in, device_code } = deviceCodeResponse;
      
      this.logger.info('🪟 Creating authentication window...');
      
      // Import BrowserWindow dynamically to avoid circular dependencies
      const { BrowserWindow } = require('electron');
      
      // Create authentication window
      const authWindow = new BrowserWindow({
        width: 650,
        height: 550,
        show: false,
        parent: BrowserWindow.getFocusedWindow(),
        modal: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        alwaysOnTop: true,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false
        }
      });
      
      // Create HTML with instructions
      const instructionsHTML = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Autenticação GitHub - Documental</title>
          <meta charset="utf-8">
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: linear-gradient(135deg, #0d1117 0%, #161b22 100%);
              color: #c9d1d9;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            .container {
              max-width: 500px;
              width: 90%;
              text-align: center;
            }
            .logo { font-size: 48px; margin-bottom: 20px; }
            h2 { 
              font-size: 24px; 
              margin-bottom: 10px; 
              color: #58a6ff;
              font-weight: 600;
            }
            .subtitle { 
              color: #8b949e; 
              margin-bottom: 20px; 
              font-size: 14px;
            }
            .warning {
              background: rgba(255, 193, 7, 0.1);
              border: 1px solid rgba(255, 193, 7, 0.3);
              border-radius: 6px;
              padding: 12px;
              margin-bottom: 20px;
              font-size: 12px;
              color: #ffc107;
            }
            .code-container {
              background: #0d1117;
              border: 2px solid #30363d;
              border-radius: 8px;
              padding: 20px;
              margin-bottom: 25px;
            }
            .code-label {
              font-size: 11px;
              color: #8b949e;
              margin-bottom: 8px;
              text-transform: uppercase;
              letter-spacing: 1px;
            }
            .code {
              font-size: 32px;
              font-weight: bold;
              color: #58a6ff;
              letter-spacing: 4px;
              margin-bottom: 15px;
              font-family: 'Courier New', monospace;
            }
            .copy-button {
              background: #238636;
              color: white;
              border: none;
              padding: 10px 20px;
              border-radius: 6px;
              cursor: pointer;
              font-size: 14px;
              transition: all 0.2s;
            }
            .copy-button:hover { background: #2ea043; }
            .copy-button.copied { background: #1a7f37; }
            .steps {
              text-align: left;
              background: rgba(22, 27, 34, 0.5);
              border-radius: 8px;
              padding: 20px;
              margin-bottom: 20px;
            }
            .step {
              margin-bottom: 12px;
              font-size: 14px;
              line-height: 1.5;
            }
            .step-number { color: #58a6ff; font-weight: bold; }
            .link {
              color: #58a6ff;
              text-decoration: none;
            }
            .link:hover { text-decoration: underline; }
            .status {
              background: rgba(56, 139, 253, 0.1);
              border: 1px solid rgba(56, 139, 253, 0.3);
              border-radius: 6px;
              padding: 15px;
              margin-top: 20px;
            }
            .spinner {
              border: 2px solid #30363d;
              border-top: 2px solid #58a6ff;
              border-radius: 50%;
              width: 20px;
              height: 20px;
              animation: spin 1s linear infinite;
              margin: 0 auto 10px;
            }
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
            @keyframes pulse {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.7; }
            }
            .success {
              background: rgba(35, 134, 54, 0.1);
              border: 1px solid rgba(35, 134, 54, 0.3);
              border-radius: 6px;
              padding: 12px;
              margin: 15px 0;
              color: #3fb950;
            }
            .error {
              background: rgba(248, 81, 73, 0.1);
              border: 1px solid rgba(248, 81, 73, 0.3);
              border-radius: 6px;
              padding: 12px;
              margin: 15px 0;
              color: #f85149;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo">🔐</div>
            <h2>Conectar com GitHub</h2>
            <p class="subtitle">Use o código abaixo para autorizar o Documental</p>
            
            <div class="warning">
              ⚠️ Mantenha esta janela aberta durante a autenticação
            </div>
            
            <div class="code-container">
              <div class="code-label">SEU CÓDIGO</div>
              <div class="code" id="userCode">${user_code}</div>
              <button class="copy-button" onclick="copyCode()">📋 Copiar Código</button>
            </div>
            
            <div class="steps">
              <div class="step">
                <span class="step-number">1.</span>
                <strong>Visite:</strong> 
                <a href="${verification_uri}" target="_blank" class="link">${verification_uri}</a>
              </div>
              <div class="step">
                <span class="step-number">2.</span>
                <strong>Digite o código:</strong> ${user_code}
              </div>
              <div class="step">
                <span class="step-number">3.</span>
                <strong>Autorize</strong> o acesso do Documental App
              </div>
            </div>
            
            <div class="status" id="status">
              <div class="spinner"></div>
              <p><strong>Aguardando autorização...</strong></p>
              <p id="timer">⏱️ Tempo restante: ${Math.floor(expires_in / 60)}:${(expires_in % 60).toString().padStart(2, '0')}</p>
            </div>
          </div>
          
          <script>
            let timeLeft = ${expires_in};
            const timerEl = document.getElementById('timer');
            const statusEl = document.getElementById('status');
            
            function updateStatus(message, type = 'info') {
              const statusHTML = type === 'success' ? 
                '<div class="success">✅ ' + message + '</div>' :
                type === 'error' ? 
                '<div class="error">❌ ' + message + '</div>' :
                '<div class="spinner"></div><p><strong>' + message + '</strong></p>';
              
              statusEl.innerHTML = statusHTML + '<p id="timer">⏱️ Tempo restante: ' + formatTime(timeLeft) + '</p>';
            }
            
            function formatTime(seconds) {
              const mins = Math.floor(seconds / 60);
              const secs = seconds % 60;
              return mins + ':' + secs.toString().padStart(2, '0');
            }
            
            function copyCode() {
              const codeElement = document.getElementById('userCode');
              const code = codeElement ? codeElement.textContent : '${user_code}';
              
              // Try Electron's clipboard API first (most reliable)
              if (window.electronAPI && window.electronAPI.writeToClipboard) {
                window.electronAPI.writeToClipboard(code).then((result) => {
                  if (result.success) {
                    const btn = document.querySelector('.copy-button');
                    btn.textContent = '✅ Copiado!';
                    btn.classList.add('copied');
                    setTimeout(() => {
                      btn.textContent = '📋 Copiar Código';
                      btn.classList.remove('copied');
                    }, 2000);
                  } else {
                    console.error('Electron clipboard failed:', result.error);
                    fallbackCopy(code);
                  }
                }).catch(err => {
                  console.error('Electron clipboard error:', err);
                  fallbackCopy(code);
                });
              } else {
                // Fallback to browser clipboard
                fallbackCopy(code);
              }
            }
            
            function fallbackCopy(code) {
              // Try modern clipboard API
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(code).then(() => {
                  const btn = document.querySelector('.copy-button');
                  btn.textContent = '✅ Copiado!';
                  btn.classList.add('copied');
                  setTimeout(() => {
                    btn.textContent = '📋 Copiar Código';
                    btn.classList.remove('copied');
                  }, 2000);
                }).catch(err => {
                  console.error('Modern clipboard failed:', err);
                  legacyCopy(code);
                });
              } else {
                // Legacy fallback
                legacyCopy(code);
              }
            }
            
            function legacyCopy(code) {
              const textArea = document.createElement('textarea');
              textArea.value = code;
              textArea.style.position = 'fixed';
              textArea.style.left = '-999999px';
              textArea.style.top = '-999999px';
              textArea.style.opacity = '0';
              textArea.setAttribute('readonly', '');
              document.body.appendChild(textArea);
              textArea.select();
              textArea.setSelectionRange(0, 99999); // For mobile devices
              
              try {
                const successful = document.execCommand('copy');
                document.body.removeChild(textArea);
                
                if (successful) {
                  const btn = document.querySelector('.copy-button');
                  btn.textContent = '✅ Copiado!';
                  btn.classList.add('copied');
                  setTimeout(() => {
                    btn.textContent = '📋 Copiar Código';
                    btn.classList.remove('copied');
                  }, 2000);
                } else {
                  showCopyError(code);
                }
              } catch (fallbackErr) {
                document.body.removeChild(textArea);
                console.error('Legacy copy failed:', fallbackErr);
                showCopyError(code);
              }
            }
            
            function showCopyError(code) {
              console.error('All copy methods failed');
              // Show the code in a more accessible way
              const codeDisplay = document.createElement('div');
              codeDisplay.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #2d3748; color: white; padding: 20px; border-radius: 8px; z-index: 10000; font-family: monospace; font-size: 18px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 80%; text-align: center;';
              codeDisplay.innerHTML = '<div style="margin-bottom: 10px;">❌ Falha ao copiar automaticamente</div><div style="margin-bottom: 10px;">Por favor, copie manualmente:</div><div style="background: #1a202c; padding: 10px; border-radius: 4px; margin: 10px 0; font-weight: bold;">' + code + '</div><button onclick="this.parentElement.remove()" style="background: #4299e1; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Fechar</button>';
              document.body.appendChild(codeDisplay);
            }
            
            const timer = setInterval(() => {
              timeLeft--;
              const timerEl = document.getElementById('timer');
              if (timerEl) {
                timerEl.textContent = '⏱️ Tempo restante: ' + formatTime(timeLeft);
              }
              
              if (timeLeft <= 60) {
                updateStatus('Código expirando em breve! Aja rápido.', 'warning');
              }
              
              if (timeLeft <= 0) {
                clearInterval(timer);
                updateStatus('Código expirado. Feche esta janela e tente novamente.', 'error');
              }
            }, 1000);
            
            // Auto-focus on code for better visibility
            document.addEventListener('DOMContentLoaded', () => {
              const codeEl = document.getElementById('userCode');
              if (codeEl) {
                codeEl.style.animation = 'pulse 2s infinite';
              }
            });
          </script>
        </body>
        </html>
      `;
      
      // Load instructions page
      authWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(instructionsHTML));
      authWindow.show();
      authWindow.center();
      
      // Start token polling in background
      this.logger.info('🔄 Starting token polling...');
      this.continueGitHubAuthentication(device_code, 5).then(tokenResult => {
        // Close authentication window
        authWindow.close();
        
        if (tokenResult.success && tokenResult.userInfo) {
          // Save user info to database
          this.saveUserInfo(tokenResult.userInfo).then(saved => {
            if (saved) {
              this.logger.info('✅ User info saved successfully');
              resolve({
                success: true,
                userInfo: tokenResult.userInfo
              });
            } else {
              resolve({
                success: false,
                error: 'Failed to save user information'
              });
            }
          });
        } else {
          resolve({
            success: false,
            error: tokenResult.error || 'Authentication failed'
          });
        }
      }).catch(error => {
        authWindow.close();
        this.logger.error('❌ Authentication error:', error);
        resolve({
          success: false,
          error: error.message
        });
      });
    });
  }

  /**
   * Authenticate with GitHub using device flow
   * @returns {Promise<AuthResult>} Authentication result
   */
  async authenticateWithGitHub() {
    try {
      this.logger.info('🔐 Starting GitHub authentication flow...');

      const deviceCodeResponse = await this.initiateDeviceFlow();

      this.logger.info('✅ Device flow initiated:', {
        deviceCode: deviceCodeResponse.user_code,
        verificationUri: deviceCodeResponse.verification_uri,
        expiresIn: deviceCodeResponse.expires_in,
        interval: deviceCodeResponse.interval
      });

      return {
        requiresDeviceCode: true,
        deviceCode: deviceCodeResponse.user_code,
        deviceCodeInternal: deviceCodeResponse.device_code,
        verificationUri: deviceCodeResponse.verification_uri,
        expiresIn: deviceCodeResponse.expires_in,
        interval: deviceCodeResponse.interval
      };

    } catch (error) {
      this.logger.error('❌ GitHub authentication failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Continue GitHub authentication after showing device code
   * @param {string} deviceCode - Internal device code
   * @param {number} interval - Polling interval
   * @returns {Promise<AuthResult>} Authentication result
   */
  async continueGitHubAuthentication(deviceCode, interval) {
    try {
      this.logger.info('🔄 Continuing GitHub authentication polling...');
      this.logger.info('📋 Polling parameters:', {
        deviceCode: deviceCode,
        interval: interval
      });
      
      // Step 3: Poll for token
      this.logger.info('⏳ Starting token polling...');
      const token = await this.pollForToken(deviceCode, interval);
      
      if (!token) {
        throw new Error('Failed to obtain access token - token is null');
      }
      
      this.logger.info('🔑 Access token obtained successfully');
      
      // Step 4: Store token securely
      this.logger.info('💾 Storing token securely...');
      const stored = await secureTokenService.storeToken(token);
      if (!stored) {
        throw new Error('Failed to store token securely');
      }
      this.logger.info('✅ Token stored successfully');
      
      // Step 5: Get user information
      this.logger.info('👤 Getting user information...');
      const userInfo = await this.getGitHubUserInfo(token);
      
      if (!userInfo) {
        throw new Error('Failed to get user information - userInfo is null');
      }
      
      this.logger.info(`✅ Successfully authenticated as ${userInfo.login}`, {
        id: userInfo.id,
        login: userInfo.login,
        name: userInfo.name,
        email: userInfo.email
      });
      
      return { 
        success: true, 
        userInfo: {
          id: userInfo.id,
          login: userInfo.login,
          name: userInfo.name,
          email: userInfo.email,
          avatar_url: userInfo.avatar_url
        }
      };
      
    } catch (error) {
      this.logger.error('❌ GitHub authentication continuation failed:', error);
      this.logger.error('🔍 Continuation error details:', {
        message: error.message,
        stack: error.stack,
        deviceCode: deviceCode,
        interval: interval
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Make HTTPS request using Node.js native https module
   * @param {string} url - Request URL
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Response data
   */
  async makeHttpsRequest(url, options) {
    const https = require('https');
    const { URL } = require('url');
    
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      
      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: options.headers || {}
      };

      // Add Content-Length if body is provided
      if (options.body) {
        requestOptions.headers['Content-Length'] = Buffer.byteLength(options.body);
      }

      this.logger.info('🌐 Making HTTPS request:', {
        hostname: requestOptions.hostname,
        path: requestOptions.path,
        method: requestOptions.method,
        headers: requestOptions.headers,
        hasBody: !!options.body
      });

      const req = https.request(requestOptions, (res) => {
        let data = '';
        
        this.logger.info('📥 HTTPS response received:', {
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers
        });

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          this.logger.info('📋 Response body received:', {
            length: data.length,
            preview: data.substring(0, 100)
          });

          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const jsonData = JSON.parse(data);
              resolve(jsonData);
            } catch (parseError) {
              this.logger.error('❌ Failed to parse JSON response:', parseError);
              reject(new Error(`Invalid JSON response: ${data}`));
            }
          } else {
            this.logger.error('❌ HTTPS request failed:', {
              statusCode: res.statusCode,
              statusMessage: res.statusMessage,
              body: data
            });
            reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        this.logger.error('💥 HTTPS request error:', error);
        reject(error);
      });

      // Write body if provided
      if (options.body) {
        req.write(options.body);
      }

      req.end();
    });
  }

  /**
   * Initiate GitHub device flow
   * @returns {Promise<Object>} Device code response
   */
  async initiateDeviceFlow() {
    try {
      this.logger.info('🔧 Building device flow request...');
      
      const requestBody = {
        client_id: GITHUB_CONFIG.CLIENT_ID,
        scope: GITHUB_CONFIG.SCOPES.join(' ')
      };

      this.logger.info('📤 Sending request to GitHub device code API:', {
        url: GITHUB_CONFIG.DEVICE_CODE_URL,
        method: 'POST',
        clientId: GITHUB_CONFIG.CLIENT_ID,
        scopes: GITHUB_CONFIG.SCOPES.join(' '),
        body: requestBody
      });

      // Use native Node.js https module instead of fetch for better Electron compatibility
      const responseData = await this.makeHttpsRequest(GITHUB_CONFIG.DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Documental-App/1.0'
        },
        body: JSON.stringify(requestBody)
      });

      this.logger.info('✅ Device flow response received:', responseData);
      return responseData;
      
    } catch (error) {
      this.logger.error('💥 Error in initiateDeviceFlow:', error);
      throw error;
    }
  }

  /**
   * Poll GitHub for access token
   * @param {string} deviceCode - Device code from GitHub
   * @param {number} interval - Polling interval in seconds
   * @returns {Promise<string|null>} Access token or null if failed
   */
  async pollForToken(deviceCode, interval) {
    const maxAttempts = 180; // Maximum 15 minutes (180 * 5 seconds)
    let attempts = 0;

    this.logger.info('⏱️ Starting token polling with parameters:', {
      deviceCode: deviceCode,
      interval: interval,
      maxAttempts: maxAttempts,
      tokenUrl: GITHUB_CONFIG.TOKEN_URL
    });

    while (attempts < maxAttempts) {
      attempts++;
      this.logger.info(`🔄 Polling attempt ${attempts}/${maxAttempts}...`);
      
      await new Promise(resolve => setTimeout(resolve, interval * 1000));

      const params = new URLSearchParams({
        client_id: GITHUB_CONFIG.CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      });

      try {
        this.logger.info('📤 Sending token request to GitHub:', {
          url: GITHUB_CONFIG.TOKEN_URL,
          method: 'POST',
          clientId: GITHUB_CONFIG.CLIENT_ID,
          deviceCode: deviceCode,
          params: params.toString()
        });

        const tokenRequestBody = {
          client_id: GITHUB_CONFIG.CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        };

        const responseData = await this.makeHttpsRequest(GITHUB_CONFIG.TOKEN_URL, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Documental-App/1.0'
          },
          body: JSON.stringify(tokenRequestBody)
        });

        this.logger.info('✅ Token response received:', responseData);
        
        // Check if response contains an error
        if (responseData.error) {
          this.logger.info('📥 Token response contains error:', responseData.error);
          
          if (responseData.error === 'authorization_pending') {
            this.logger.info('⏳ Authorization still pending, continuing polling...');
            continue;
          } else if (responseData.error === 'slow_down') {
            this.logger.info('🐌 GitHub requested slower polling, waiting longer...');
            // Wait longer before next poll
            await new Promise(resolve => setTimeout(resolve, interval * 2000));
            continue;
          } else {
            throw new Error(`Token request failed: ${responseData.error_description || responseData.error}`);
          }
        }
        
        this.logger.info('✅ Token received successfully!', {
          hasAccessToken: !!responseData.access_token,
          tokenType: responseData.token_type,
          scope: responseData.scope,
          fullResponse: responseData
        });
        return responseData.access_token;

      } catch (error) {
        this.logger.error(`💥 Error in polling attempt ${attempts}:`, error);
        this.logger.error('🔍 Polling error details:', {
          message: error.message,
          stack: error.stack,
          attempts: attempts,
          maxAttempts: maxAttempts
        });
        
        if (attempts >= maxAttempts) {
          throw error;
        }
      }
    }

    throw new Error(`Authentication timed out after ${maxAttempts} attempts. Please try again.`);
  }

  /**
   * Get user information from database (cache)
   * @returns {Promise<Object|null>} User information or null if not found
   */
  async getUserInfoFromDatabase() {
    try {
      const db = await this.databaseManager.getDatabase();
      
      const userInfo = await new Promise((resolve, reject) => {
        db.get(
          `SELECT githubId, login, name, email, avatarUrl, updatedAt 
           FROM users 
           ORDER BY updatedAt DESC 
           LIMIT 1`,
          (err, row) => {
            if (err) {
              this.logger.error('Error getting user info from database:', err.message);
              reject(err);
            } else {
              resolve(row);
            }
          }
        );
      });
      
      if (userInfo) {
        this.logger.info('✅ User info retrieved from database cache');
        return {
          id: userInfo.githubId,
          login: userInfo.login,
          name: userInfo.name,
          email: userInfo.email,
          avatar_url: userInfo.avatarUrl,
          cached: true,
          cachedAt: userInfo.updatedAt
        };
      }
      
      this.logger.info('ℹ️ No user info found in database cache');
      return null;
    } catch (error) {
      this.logger.error('Error getting user info from database:', error);
      return null;
    }
  }

  /**
   * Save user information to database
   * @param {Object} userInfo - GitHub user information
   * @returns {Promise<boolean>} Success status
   */
  async saveUserInfo(userInfo) {
    try {
      const db = await this.databaseManager.getDatabase();
      
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT OR REPLACE INTO users (githubId, login, name, email, avatarUrl, updatedAt) 
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [userInfo.id, userInfo.login, userInfo.name, userInfo.email, userInfo.avatar_url],
          (err) => {
            if (err) {
              this.logger.error('Error saving user info:', err.message);
              reject(err);
            } else {
              this.logger.info('✅ User info saved to database');
              resolve();
            }
          }
        );
      });
      
      return true;
    } catch (error) {
      this.logger.error('Error saving user info:', error);
      return false;
    }
  }

  /**
   * Register all authentication IPC handlers
   */
  registerHandlers() {
    this.logger.info('🔐 Registering authentication IPC handlers');

    /**
     * Check GitHub authentication status
     */
    ipcMain.handle('checkGitHubAuth', async () => {
      try {
        const token = await this.getGitHubToken();
        if (!token) {
          return { authenticated: false };
        }

        const userInfo = await this.getGitHubUserInfo(token);
        if (userInfo) {
          return { authenticated: true, userInfo };
        } else {
          return { authenticated: false };
        }
      } catch (error) {
        this.logger.error('Error checking GitHub auth:', error);
        return { authenticated: false, error: error.message };
      }
    });

    /**
     * Authenticate with GitHub
     */
    ipcMain.handle('authenticateWithGitHub', async () => {
      try {
        const result = await this.authenticateWithGitHub();
        
        if (result.success && result.userInfo) {
          // Save user info to database
          const saved = await this.saveUserInfo(result.userInfo);
          if (!saved) {
            return { success: false, error: 'Failed to save user information' };
          }
        }
        
        return result;
      } catch (error) {
        this.logger.error('Error in GitHub authentication:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Continue GitHub authentication after device code display
     */
    ipcMain.handle('continueGitHubAuth', async (event, deviceCode, interval) => {
      try {
        const result = await this.continueGitHubAuthentication(deviceCode, interval);
        
        if (result.success && result.userInfo) {
          // Save user info to database
          const saved = await this.saveUserInfo(result.userInfo);
          if (!saved) {
            return { success: false, error: 'Failed to save user information' };
          }
        }
        
        return result;
      } catch (error) {
        this.logger.error('Error continuing GitHub authentication:', error);
        return { success: false, error: error.message };
      }
    });



    /**
     * Handle logout from GitHub
     */
    ipcMain.handle('logoutFromGitHub', async () => {
      try {
        const result = await this.logoutFromGitHub();
        return result;
      } catch (error) {
        this.logger.error('Error in logout handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Handle clipboard write operation
     */
    ipcMain.handle('writeToClipboard', async (event, text) => {
      try {
        clipboard.writeText(text);
        return { success: true };
      } catch (error) {
        this.logger.error('Error writing to clipboard:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Get user info from database
     */
    ipcMain.handle('user:get-info', async () => {
      try {
        const db = await this.databaseManager.getDatabase();

        const row = await new Promise((resolve, reject) => {
          db.get(
            `SELECT githubId, login, name, email, avatarUrl
             FROM users
             ORDER BY updatedAt DESC
             LIMIT 1`,
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });

        if (!row) {
          return { success: false, error: 'No user found in database' };
        }

        return {
          success: true,
          user: {
            name: row.name || '',
            email: row.email || '',
            login: row.login || '',
            avatarUrl: row.avatarUrl || ''
          }
        };
      } catch (error) {
        this.logger.error('Error getting user info:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Update user name and email in database
     */
    ipcMain.handle('user:update-info', async (event, data) => {
      try {
        if (!data || typeof data.name !== 'string' || typeof data.email !== 'string') {
          return { success: false, error: 'Name and email must be strings' };
        }

        const name = data.name.trim();
        const email = data.email.trim();

        if (!name || !email) {
          return { success: false, error: 'Name and email must not be empty' };
        }

        const db = await this.databaseManager.getDatabase();

        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE users SET name = ?, email = ?
             WHERE githubId = (SELECT githubId FROM users ORDER BY updatedAt DESC LIMIT 1)`,
            [name, email],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        this.logger.info('✅ User info updated:', { name, email });
        return { success: true };
      } catch (error) {
        this.logger.error('Error updating user info:', error);
        return { success: false, error: error.message };
      }
    });

    this.logger.info('✅ Authentication IPC handlers registered');
  }

  /**
   * Logout from GitHub
   * @returns {Promise<Object>} Logout result
   */
  async logoutFromGitHub() {
    try {
      this.logger.info('🔘 Starting GitHub logout...');
      
      // Remove token from secure storage
      const deleted = await secureTokenService.deleteToken();
      if (!deleted) {
        this.logger.warn('⚠️ Token may not have existed in secure storage');
      } else {
        this.logger.info('✅ Token removed from secure storage');
      }
      
      // Clear user info from database (optional - keep for history)
      // const db = await this.databaseManager.getDatabase();
      // await new Promise((resolve, reject) => {
      //   db.run('DELETE FROM users', (err) => {
      //     if (err) reject(err);
      //     else resolve();
      //   });
      // });
      // this.logger.info('✅ User info cleared from database');
      
      this.logger.info('✅ GitHub logout completed successfully');
      
      return { 
        success: true, 
        message: 'Logged out successfully' 
      };
      
    } catch (error) {
      this.logger.error('❌ GitHub logout failed:', error);
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

    /**
     * Unregister all authentication IPC handlers
     */
    unregisterHandlers() {
      this.logger.info('🔐 Unregistering authentication IPC handlers');
      
      ipcMain.removeHandler('checkGitHubAuth');
      ipcMain.removeHandler('authenticateWithGitHub');
      ipcMain.removeHandler('continueGitHubAuth');
      ipcMain.removeHandler('logoutFromGitHub');
      ipcMain.removeHandler('writeToClipboard');
      ipcMain.removeHandler('user:get-info');
      ipcMain.removeHandler('user:update-info');
      
      this.logger.info('✅ Authentication IPC handlers unregistered');
    }
}

module.exports = { AuthHandlers };