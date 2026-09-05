/**
 * @fileoverview IPC handlers for BrowserView management operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain, BrowserView, BrowserWindow } = require('electron');
const path = require('path');

/**
 * @typedef {Object} BrowserViewBounds
 * @property {number} x - X coordinate
 * @property {number} y - Y coordinate
 * @property {number} width - Width
 * @property {number} height - Height
 */

/**
 * Footer height constant (h-8 = 32px) used for BrowserView bounds clamping
 */
const FOOTER_HEIGHT = 32;

/**
 * BrowserView Management IPC Handlers
 */
class BrowserHandlers {
  /**
   * Create an instance of BrowserHandlers
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.windowManager - Window manager instance
   */
  constructor({ logger, windowManager, processManager }) {
    this.logger = logger;
    this.windowManager = windowManager;
    this.processManager = processManager;
    this.windowBrowserViews = new Map(); // Store BrowserViews per window
    this.windowSlugMap = new Map(); // Store page slugs per window for preview sync
  }

  /**
   * Get or create BrowserViews for a window
   * @param {BrowserWindow} window - BrowserWindow instance
   * @returns {Object} Object containing editorView and viewerView
   */
  getOrCreateBrowserViews(window) {
    if (!this.windowBrowserViews.has(window)) {
      const editorView = new BrowserView({
        webPreferences: {
          // Preload script for Sveltia CMS integration (file picker, deep links)
          preload: path.join(__dirname, '../preload/sveltia-cms-preload.js'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,  // Required for preload script to access IPC
          enableRemoteModule: false,
          webSecurity: true
        }
      });

      const viewerView = new BrowserView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          enableRemoteModule: false,
          webSecurity: true
        }
      });

      this.windowBrowserViews.set(window, { editorView, viewerView });
      this.logger.info(`Created BrowserViews for window ${window.id}`);

      // Evict from maps when the window closes (prevents Map leak)
      window.on('closed', () => {
        this.cleanupWindowBrowserViews(window);
      });
    }

    return this.windowBrowserViews.get(window);
  }

  /**
   * Get BrowserViews for the window that sent the IPC event
   * @param {Object} event - IPC event object
   * @returns {Object} Object containing editorView and viewerView
   */
  getBrowserViewsForEvent(event) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      // Fallback to main window for backward compatibility
      const mainWindow = this.windowManager.getMainWindow();
      if (mainWindow) {
        return this.getOrCreateBrowserViews(mainWindow);
      }
      return { editorView: null, viewerView: null };
    }
    return this.getOrCreateBrowserViews(window);
  }

  /**
   * Track BrowserView loading and broadcast completion
   * @param {BrowserView} view - BrowserView instance
   * @param {string} viewName - Name of the view ('editor' or 'viewer')
   * @param {BrowserWindow} window - Parent window
   */
  trackBrowserViewLoad(view, viewName, window) {
    if (!view || !window) return;

    let loadingTimeout;
    
    const handleLoad = () => {
      clearTimeout(loadingTimeout);
      const currentUrl = view.webContents.getURL();
      
      // Broadcast to all windows for synchronization
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('browser-view-loaded', { viewName, url: currentUrl });
        }
      });
      
      this.logger.info(`✅ ${viewName} BrowserView loaded: ${currentUrl}`);
    };

    const handleError = (error) => {
      clearTimeout(loadingTimeout);
      this.logger.error(`❌ ${viewName} BrowserView failed to load:`, error);
      
      // Broadcast error to all windows
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('browser-view-error', { viewName, error: error.message });
        }
      });
    };

    // Set up event listeners
    view.webContents.once('did-finish-load', handleLoad);
    view.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
      handleError(new Error(`${errorDescription} (${errorCode})`));
    });

    // Monitor continuous navigation (replace semantics: remove stale before adding)
    view.webContents.removeAllListeners('did-navigate');
    view.webContents.on('did-navigate', (event, url) => {
      // Broadcast navigation to all windows
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('browser-view-navigated', { viewName, url });
        }
      });
      this.logger.info(`🌐 ${viewName} navigated to: ${url}`);
    });

    // Monitor SPA navigation (replace semantics: remove stale before adding)
    view.webContents.removeAllListeners('did-navigate-in-page');
    view.webContents.on('did-navigate-in-page', (event, url, isMainFrame) => {
      if (!isMainFrame) return;
      
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('browser-view-navigated', { viewName, url });
        }
      });
      this.logger.info(`🌐 ${viewName} navigated in-page to: ${url}`);
    });

    // Set timeout for loading
    loadingTimeout = setTimeout(() => {
      handleError(new Error('Loading timeout after 8 seconds'));
    }, 8000);
  }

  /**
   * Set BrowserView bounds
   * @param {Object} event - IPC event object
   * @param {string} viewName - Name of the view ('editor' or 'viewer')
   * @param {BrowserViewBounds} bounds - Bounds to set
   */
  setBrowserViewBounds(event, viewName, bounds) {
    const { editorView, viewerView } = this.getBrowserViewsForEvent(event);
    const view = viewName === 'editor' ? editorView : viewerView;
    const win = BrowserWindow.fromWebContents(event.sender);
    
    if (view && win) {
      const [, contentHeight] = win.getContentSize();
      const maxBottom = contentHeight - FOOTER_HEIGHT;
      const proposedBottom = bounds.y + bounds.height;

      if (proposedBottom > maxBottom) {
        bounds.height = Math.max(0, maxBottom - bounds.y);
        console.warn(`[browser] Clamped ${viewName} BrowserView height to ${bounds.height}px to avoid footer`);
      }

      view.setBounds(bounds);
    }
  }

  /**
   * Load URL in BrowserView
   * @param {Object} event - IPC event object
   * @param {string} viewName - Name of the view ('editor' or 'viewer')
   * @param {string} url - URL to load
   */
  loadBrowserViewUrl(event, viewName, url) {
    const { editorView, viewerView } = this.getBrowserViewsForEvent(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    const view = viewName === 'editor' ? editorView : viewerView;
    
    if (view) {
      this.logger.info(`🔗 Loading ${viewName} BrowserView with URL: ${url}`);
      this.trackBrowserViewLoad(view, viewName, window);
      view.webContents.loadURL(url);
    } else {
      this.logger.warn(`❌ BrowserView not found for ${viewName}`);
    }
  }

  /**
   * Set BrowserView visibility
   * @param {Object} event - IPC event object
   * @param {string} viewName - Name of the view ('editor' or 'viewer')
   * @param {boolean} visible - Whether to show or hide the view
   */
  setBrowserViewVisibility(event, viewName, visible) {
    const { editorView, viewerView } = this.getBrowserViewsForEvent(event);
    const view = viewName === 'editor' ? editorView : viewerView;
    const window = BrowserWindow.fromWebContents(event.sender);
    
    if (view && window) {
      if (visible) {
        window.addBrowserView(view);
      } else {
        window.removeBrowserView(view);
      }
      this.logger.debug(`Set ${viewName} BrowserView visibility: ${visible}`);
    }
  }

  /**
   * Set visibility for all BrowserViews
   * @param {Object} event - IPC event object
   * @param {boolean} visible - Whether to show or hide all views
   */
  setAllBrowserViewVisibility(event, visible) {
    const { editorView, viewerView } = this.getBrowserViewsForEvent(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    
    if (editorView && window) {
      if (visible) {
        window.addBrowserView(editorView);
      } else {
        window.removeBrowserView(editorView);
      }
    }
    
    if (viewerView && window) {
      if (visible) {
        window.addBrowserView(viewerView);
      } else {
        window.removeBrowserView(viewerView);
      }
    }
    
    this.logger.debug(`Set all BrowserViews visibility: ${visible}`);
  }

  /**
   * Capture page screenshot from BrowserView
   * @param {Object} event - IPC event object
   * @param {string} viewName - Name of the view ('editor' or 'viewer')
   * @returns {Promise<string|null>} Base64 data URL of the screenshot
   */
  async captureBrowserViewPage(event, viewName) {
    const { editorView, viewerView } = this.getBrowserViewsForEvent(event);
    const view = viewName === 'editor' ? editorView : viewerView;
    
    if (view) {
      try {
        const image = await view.webContents.capturePage();
        return image.toDataURL(); // Convert NativeImage to base64 data URL
      } catch (error) {
        this.logger.error(`Error capturing page for ${viewName} view:`, error);
        return null;
      }
    }
    return null;
  }

  /**
   * Navigate back in BrowserView
   * @param {Object} event - IPC event object
   * @param {string} viewName - Name of the view ('editor' or 'viewer')
   * @returns {boolean} Whether navigation was successful
   */
  browserViewGoBack(event, viewName) {
    const { editorView, viewerView } = this.getBrowserViewsForEvent(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    const view = viewName === 'editor' ? editorView : viewerView;
    
    if (view && !view.webContents.isDestroyed() && view.webContents.canGoBack()) {
      this.trackBrowserViewLoad(view, viewName, window);
      view.webContents.goBack();
      return true;
    }
    return false;
  }

  /**
   * Reload BrowserView
   * @param {Object} event - IPC event object
   * @param {string} viewName - Name of the view ('editor' or 'viewer')
   * @returns {boolean} Whether reload was successful
   */
  browserViewReload(event, viewName) {
    const { editorView, viewerView } = this.getBrowserViewsForEvent(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    const view = viewName === 'editor' ? editorView : viewerView;
    
    if (view && !view.webContents.isDestroyed()) {
      this.trackBrowserViewLoad(view, viewName, window);
      
      // For editor (Sveltia), use reloadIgnoringCache to prevent "Loading site data..." freeze
      // This clears HTTP cache but PRESERVES localStorage/sessionStorage (user settings)
      if (viewName === 'editor') {
        view.webContents.reloadIgnoringCache();
      } else {
        view.webContents.reload();
      }
      
      return true;
    }
    return false;
  }

  /**
   * Get current URL from BrowserView
   * @param {Object} event - IPC event object
   * @param {string} viewName - Name of the view ('editor' or 'viewer')
   * @returns {string|null} Current URL
   */
  getBrowserViewUrl(event, viewName) {
    const { editorView, viewerView } = this.getBrowserViewsForEvent(event);
    const view = viewName === 'editor' ? editorView : viewerView;
    
    if (view && !view.webContents.isDestroyed()) {
      return view.webContents.getURL();
    }
    return null;
  }

  /**
   * Clear browser cache and storage data
   * @param {Object} event - IPC event object
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async clearBrowserCache(event) {
    try {
      const { editorView, viewerView } = this.getBrowserViewsForEvent(event);
      
      const clearViewCache = async (view) => {
        if (view && !view.webContents.isDestroyed()) {
          // Clear cache
          await view.webContents.session.clearCache();
          // Clear storage data (cookies, localStorage, sessionStorage, etc.)
          await view.webContents.session.clearStorageData({
            storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
          });
          // Clear navigation history
          view.webContents.clearHistory();
        }
      };

      // Clear cache for both BrowserViews of calling window
      await Promise.all([
        clearViewCache(editorView),
        clearViewCache(viewerView)
      ]);

      this.logger.info('✅ Browser cache cleared successfully');
      return { success: true };
    } catch (error) {
      this.logger.error('Error clearing browser cache:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Clean up BrowserViews for a window
   * @param {BrowserWindow} window - Window to clean up
   */
  cleanupWindowBrowserViews(window) {
    if (this.windowBrowserViews.has(window)) {
      const { editorView, viewerView } = this.windowBrowserViews.get(window);

      // Detach views BEFORE destroying their webContents — on same-window
      // navigation away from main.html the window is still alive and dead
      // views must not stay stacked over the next page. From the window
      // 'closed' event the window is already destroyed, hence the guard.
      const detachView = (view) => {
        if (!view) return;
        try {
          if (window && typeof window.isDestroyed === 'function' && !window.isDestroyed()) {
            window.removeBrowserView(view);
          }
        } catch (_) {
          // Window already gone — webContents.close() below still runs.
        }
      };
      detachView(editorView);
      detachView(viewerView);

      // Clean up BrowserViews
      if (editorView && !editorView.webContents.isDestroyed()) {
        editorView.webContents.close();
      }
      if (viewerView && !viewerView.webContents.isDestroyed()) {
        viewerView.webContents.close();
      }
      
      this.windowBrowserViews.delete(window);
      this.logger.info(`Cleaned up BrowserViews for window ${window.id}`);
    }
    
    // Clean up slug mapping for this window
    if (this.windowSlugMap.has(window.id)) {
      this.windowSlugMap.delete(window.id);
      this.logger.info(`Cleaned up slug mapping for window ${window.id}`);
    }
  }

  /**
   * Validate and sanitize slug value
   * @param {string} slug - Raw slug value
   * @returns {string|null} Sanitized slug or null if invalid
   * @private
   */
  _validateAndSanitizeSlug(slug) {
    // Check for null, undefined, or non-string values
    if (slug === null || slug === undefined) {
      this.logger.warn('⚠️  Invalid slug received: null or undefined');
      return null;
    }

    // Check for non-string type
    if (typeof slug !== 'string') {
      this.logger.warn(`⚠️  Invalid slug type received: ${typeof slug}`);
      return null;
    }

    // Check for empty or whitespace-only string
    const trimmedSlug = slug.trim();
    if (trimmedSlug === '') {
      this.logger.warn('⚠️  Invalid slug received: empty string');
      return null;
    }

    // Sanitize slug: remove special characters that could cause issues
    // Allow: alphanumeric, hyphens, underscores, forward slashes (for paths)
    const sanitizedSlug = trimmedSlug.replace(/[^a-zA-Z0-9-_/]/g, '');

    if (sanitizedSlug !== trimmedSlug) {
      this.logger.warn(`⚠️  Slug contained special characters, sanitized from "${trimmedSlug}" to "${sanitizedSlug}"`);
    }

    // Final check after sanitization
    if (sanitizedSlug === '') {
      this.logger.warn('⚠️  Slug became empty after sanitization');
      return null;
    }

    return sanitizedSlug;
  }

  /**
   * Register all BrowserView management IPC handlers
   */
  registerHandlers() {
    this.logger.info('🌐 Registering BrowserView management IPC handlers');

    /**
     * Set BrowserView bounds
     */
    ipcMain.handle('set-browser-view-bounds', (event, viewName, bounds) => {
      this.setBrowserViewBounds(event, viewName, bounds);
    });

    /**
     * Load URL in BrowserView
     */
    ipcMain.handle('load-browser-view-url', (event, viewName, url) => {
      this.loadBrowserViewUrl(event, viewName, url);
    });

    /**
     * Set BrowserView visibility
     */
    ipcMain.handle('set-browser-view-visibility', (event, viewName, visible) => {
      this.setBrowserViewVisibility(event, viewName, visible);
    });

    /**
     * Set visibility for all BrowserViews
     */
    ipcMain.handle('set-all-browser-view-visibility', (event, visible) => {
      this.setAllBrowserViewVisibility(event, visible);
    });

    /**
     * Capture page screenshot
     */
    ipcMain.handle('capture-browser-view-page', async (event, viewName) => {
      return await this.captureBrowserViewPage(event, viewName);
    });

    /**
     * Navigate back
     */
    ipcMain.handle('browser-view-go-back', (event, viewName) => {
      return this.browserViewGoBack(event, viewName);
    });

    /**
     * Reload BrowserView
     */
    ipcMain.handle('browser-view-reload', (event, viewName) => {
      return this.browserViewReload(event, viewName);
    });

    /**
     * Get current URL
     */
    ipcMain.handle('get-browser-view-url', (event, viewName) => {
      return this.getBrowserViewUrl(event, viewName);
    });

    /**
     * Clear browser cache
     */
    ipcMain.handle('clear-browser-cache', async (event) => {
      return await this.clearBrowserCache(event);
    });


    /**
     * Handle CMS page loaded event from Sveltia preload script
     * Stores the slug and loads preview URL in viewer BrowserView
     */
    ipcMain.on('cms:page-loaded', (event, slug) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        this.logger.warn('❌ Could not determine window for cms:page-loaded event');
        return;
      }

      // Validate and sanitize slug
      const validatedSlug = this._validateAndSanitizeSlug(slug);
      if (!validatedSlug) {
        this.logger.error(`❌ cms:page-loaded rejected: invalid slug "${slug}"`);
        return;
      }

      const windowId = window.id;
      this.windowSlugMap.set(windowId, validatedSlug);
      this.logger.info(`📄 CMS page loaded - stored slug "${validatedSlug}" for window ${windowId}`);

      // Get dev server URL from processManager (dynamically captured from Astro server)
      const devServerUrl = this.processManager?.getGlobalDevServerUrl() || 'http://localhost:4321';
      const previewUrl = `${devServerUrl}${validatedSlug}/`;

      // Load preview URL in viewer BrowserView
      const { viewerView } = this.getOrCreateBrowserViews(window);
      if (viewerView) {
        this.logger.info(`🔗 Loading preview URL in viewer: ${previewUrl}`);
        this.trackBrowserViewLoad(viewerView, 'viewer', window);
        viewerView.webContents.loadURL(previewUrl);
      }
    });

    /**
     * Handle CMS content saved event from Sveltia preload script
     * Only updates preview if the slug has changed
     */
    ipcMain.on('cms:content-saved', (event, newSlug) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        this.logger.warn('❌ Could not determine window for cms:content-saved event');
        return;
      }

      // Validate and sanitize slug
      const validatedSlug = this._validateAndSanitizeSlug(newSlug);
      if (!validatedSlug) {
        this.logger.error(`❌ cms:content-saved rejected: invalid slug "${newSlug}"`);
        return;
      }

      const windowId = window.id;
      const lastSlug = this.windowSlugMap.get(windowId);

      if (validatedSlug !== lastSlug) {
        this.windowSlugMap.set(windowId, validatedSlug);
        this.logger.info(`💾 Content saved - slug changed from "${lastSlug}" to "${validatedSlug}" for window ${windowId}`);

        // Get dev server URL from processManager (dynamically captured from Astro server)
        const devServerUrl = this.processManager?.getGlobalDevServerUrl() || 'http://localhost:4321';
        const previewUrl = `${devServerUrl}${validatedSlug}/`;

        // Update preview URL in viewer BrowserView
        const { viewerView } = this.getOrCreateBrowserViews(window);
        if (viewerView) {
          this.logger.info(`🔗 Updating preview URL in viewer: ${previewUrl}`);
          this.trackBrowserViewLoad(viewerView, 'viewer', window);
          viewerView.webContents.loadURL(previewUrl);
        }
      } else {
        this.logger.info(`💾 Content saved - slug unchanged "${validatedSlug}" for window ${windowId}, skipping preview update`);
      }
    });
    /**
     * Handle CMS slug changed event from Sveltia preload script
     * Triggered when user saves a page with a different slug
     * Works with both Sveltia configurations (default redirect and stay on page)
     */
    ipcMain.on('cms:slug-changed', (event, newSlug) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        this.logger.warn('❌ Could not determine window for cms:slug-changed event');
        return;
      }

      // Validate and sanitize slug
      const validatedSlug = this._validateAndSanitizeSlug(newSlug);
      if (!validatedSlug) {
        this.logger.error(`❌ cms:slug-changed rejected: invalid slug "${newSlug}"`);
        return;
      }

      const windowId = window.id;
      const lastSlug = this.windowSlugMap.get(windowId);

      if (validatedSlug !== lastSlug) {
        this.windowSlugMap.set(windowId, validatedSlug);
        this.logger.info(`📝 Slug changed from "${lastSlug}" to "${validatedSlug}" for window ${windowId}`);

        // Get dev server URL from processManager (dynamically captured from Astro server)
        const devServerUrl = this.processManager?.getGlobalDevServerUrl() || 'http://localhost:4321';
        const previewUrl = `${devServerUrl}${validatedSlug}/`;

        // Update preview URL in viewer BrowserView
        const { viewerView } = this.getOrCreateBrowserViews(window);
        if (viewerView) {
          this.logger.info(`🔗 Updating preview URL after slug change: ${previewUrl}`);
          this.trackBrowserViewLoad(viewerView, 'viewer', window);
          viewerView.webContents.loadURL(previewUrl);
        }
      } else {
        this.logger.info(`📝 Slug unchanged "${validatedSlug}" for window ${windowId}, skipping preview update`);
      }
    });

    this.logger.info('✅ BrowserView management IPC handlers registered');
  }

  /**
   * Unregister all BrowserView management IPC handlers
   */
  unregisterHandlers() {
    this.logger.info('🌐 Unregistering BrowserView management IPC handlers');
    
    ipcMain.removeHandler('set-browser-view-bounds');
    ipcMain.removeHandler('load-browser-view-url');
    ipcMain.removeHandler('set-browser-view-visibility');
    ipcMain.removeHandler('set-all-browser-view-visibility');
    ipcMain.removeHandler('capture-browser-view-page');
    ipcMain.removeHandler('browser-view-go-back');
    ipcMain.removeHandler('browser-view-reload');
    ipcMain.removeHandler('get-browser-view-url');
    ipcMain.removeHandler('clear-browser-cache');
    
    // Remove CMS event listeners
    ipcMain.removeAllListeners('cms:page-loaded');
    ipcMain.removeAllListeners('cms:content-saved');
    ipcMain.removeAllListeners('cms:slug-changed');
    
    this.logger.info('✅ BrowserView management IPC handlers unregistered');
  }
}

module.exports = { BrowserHandlers };
