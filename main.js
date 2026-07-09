/**
 * @fileoverview Production main process with pure modular architecture
 * @author Documental Team
 * @since 1.0.0
 */

// Load environment variables FIRST - before any other imports
require('dotenv').config();

'use strict';

// Core Electron imports
const { app, BrowserWindow } = require('electron');

// Import modular components
const { getLogger } = require('./src/main/logging/logger.js');
const { appTracker } = require('./src/main/processes/documentalTracker.js');
const { ProcessInspectorFactory } = require('./src/main/platform/index.js');
const { PIDRegistryFile } = require('./src/main/processes/PIDRegistryFile.js');
const { DatabaseManager } = require('./src/main/database/database.js');
const { WindowManager } = require('./src/main/window/windowManager.js');
const { ProjectService } = require('./src/application/ProjectService.js');
const { FileService } = require('./src/main/services/fileService.js');
const { MenuManager } = require('./src/main/services/menuManager.js');
const { NodeDetectionService } = require('./src/main/services/nodeDetectionService.js');
const { ThemeService } = require('./src/main/services/themeService.js');
const { createIpcRegistry } = require('./src/ipc/index.js');

// Initialize modular logging system
const logger = getLogger('MainProcess');
logger.info('🚀 Starting Documental with production modular architecture');

// Modular service instances
let databaseManager;
let windowManager;
let projectService;
let fileService;
let menuManager;
let nodeDetectionService;
let themeService;
let ipcRegistry;

// Application state
let isInitialized = false;
let isCleaningUp = false;

// Reference to processManager extracted from ipcRegistry for will-quit handler
/** @type {import('./src/ipc/processManager.js')|null} */
let processManager = null;

/**
 * Initialize core services
 */
async function initializeServices() {
  logger.info('🔧 Initializing core services...');

  try {
    // Initialize database
    logger.info('🗄️ Initializing database...');
    databaseManager = new DatabaseManager({
      userDataPath: app.getPath('userData'),
      dbName: 'documental.db'
    });
    await databaseManager.initialize();
    logger.info('✅ Database initialized');

    // Initialize theme service
    logger.info('🎨 Initializing theme service...');
    themeService = new ThemeService({
      logger: getLogger('ThemeService'),
      fs: require('fs'),
      path: require('path'),
      getNativeTheme: () => require('electron').nativeTheme
    });
    await themeService.initialize(app.getAppPath());
    try {
      require('electron').nativeTheme.themeSource = 'system';
    } catch (_e) { }
    logger.info('✅ Theme service initialized');

    // Initialize window manager
    logger.info('🪟 Initializing window manager...');
    windowManager = new WindowManager({
      basePath: __dirname,
      userDataPath: app.getPath('userData'),
      windowConfig: {
        width: 900,
        height: 600,
        show: false,
        maximize: true
      }
    });
    logger.info('✅ Window manager initialized');

    // Initialize project service
    logger.info('📁 Initializing project service...');
    projectService = new ProjectService({
      logger,
      databaseManager
    });
    logger.info('✅ Project service initialized');

    // Initialize file service
    logger.info('📂 Initializing file service...');
    fileService = new FileService({
      logger,
      windowManager
    });
    logger.info('✅ File service initialized');

    // Initialize menu manager
    logger.info('🍽️ Initializing menu manager...');
    menuManager = new MenuManager({
      logger,
      windowManager,
      fileService
    });
    menuManager.initialize();
    logger.info('✅ Menu manager initialized');

    // Initialize Node.js detection service
    logger.info('🟢 Initializing Node.js detection service...');
    nodeDetectionService = new NodeDetectionService({
      logger
    });
    logger.info('✅ Node.js detection service initialized');

    // Initialize IPC registry
    logger.info('🔌 Initializing IPC registry...');
    ipcRegistry = createIpcRegistry({
      logger,
      databaseManager,
      windowManager,
      projectService,
      fileService,
      nodeDetectionService,
      themeService
    });
    // Extract processManager reference for will-quit cleanup
    processManager = ipcRegistry.projectCreationHandler.processManager;
    ipcRegistry.registerIpcHandlers();
    logger.info('✅ IPC registry initialized');

    logger.info('✅ All core services initialized successfully');
    isInitialized = true;

  } catch (error) {
    logger.error('❌ Failed to initialize services:', error);
    throw error;
  }
}

/**
 * Check if welcome setup has been completed
 * @returns {Promise<boolean>} True if setup is completed
 */
async function checkWelcomeSetupCompleted() {
  try {
    const fs = require('fs');
    const path = require('path');
    const firstTimeFile = path.join(app.getPath('userData'), '.first-time');
    
    logger.info(`🔍 Checking welcome setup completion at: ${firstTimeFile}`);
    
    if (fs.existsSync(firstTimeFile)) {
      const content = fs.readFileSync(firstTimeFile, 'utf8').trim();
      const isCompleted = content === 'completed';
      logger.info(`📋 Setup file exists with content: "${content}", completed: ${isCompleted}`);
      return isCompleted;
    } else {
      logger.info('📝 No setup completion file found');
      return false;
    }
  } catch (error) {
    logger.error('❌ Error checking setup completion:', error);
    return false;
  }
}

/**
 * Check Node.js setup and create appropriate window
 */
async function createInitialWindow() {
  try {
    logger.info('🔍 Checking initial window requirements...');
    
    // FIRST: Check if welcome setup has been completed
    const setupCompleted = await checkWelcomeSetupCompleted();
    
    if (setupCompleted) {
      logger.info('✅ Welcome setup already completed - showing main window');
      return await windowManager.createMainWindow();
    }
    
    logger.info('👋 Welcome setup not completed - checking Node.js setup...');
    
    // SECOND: Check Node.js detection (managed runtime ensures Node availability)
    const detection = await nodeDetectionService.detectNodeInstallation();
    logger.info('🔍 Node.js detection result:', detection);
    
    // ALWAYS show welcome window on first run for Node.js verification
    logger.info('👋 First time setup - showing welcome window for Node.js verification');
    
    // Store detection result for the welcome window to use
    global.nodeDetectionResult = detection;
    
    return await windowManager.createWindow('language.html', {
      width: 900,
      height: 700,
      resizable: true,
      maximizable: true,
      minimizable: true,
      maximize: true
    });
    
    // FOURTH: Otherwise, show welcome window with Node.js setup step
    logger.info('⚙️ Node.js setup required, showing welcome window');
    return await windowManager.createWindow('language.html', {
      width: 900,
      height: 700,
      resizable: true,
      maximizable: true,
      minimizable: true,
      maximize: true
    });
    
  } catch (error) {
    logger.error('❌ Failed to create initial window:', error);
    throw error;
  }
}

/**
 * Create main window
 */
async function createMainWindow() {
  try {
    logger.info('🪟 Creating main window...');
    const mainWindow = await windowManager.createMainWindow();
    logger.info('✅ Main window created successfully');
    return mainWindow;
  } catch (error) {
    logger.error('❌ Failed to create main window:', error);
    throw error;
  }
}

/**
 * Load and validate tracked processes
 */
async function initializeProcessTracking() {
  try {
    logger.info('📊 Initializing process tracking...');

    // Reap orphaned processes from PID registry (hard-crash recovery)
    const inspector = ProcessInspectorFactory.getInspector();
    const { reaped } = await appTracker.pidRegistry.reapOrphans(inspector);
    if (reaped.length > 0) {
      logger.info(`🧹 Reaped ${reaped.length} orphaned process(es) from PID registry`);
    }
    logger.info('✅ Process tracking initialized');
  } catch (error) {
    logger.error('❌ Failed to initialize process tracking:', error);
    // Don't throw - process tracking failure shouldn't stop app startup
  }
}

/**
 * Setup application event handlers
 */
function setupAppEventHandlers() {
  logger.info('🔗 Setting up application event handlers...');

  // App ready event
  app.whenReady().then(async () => {
    try {
      logger.info('🚀 App ready - starting initialization...');
      
      // Reset cleanup flag
      isCleaningUp = false;
      
      // Log platform information
      const platformInfo = {
        platform: ProcessInspectorFactory.getPlatformName(),
        isWindows: ProcessInspectorFactory.isWindows(),
        isUnix: ProcessInspectorFactory.isUnix(),
        isMacOS: ProcessInspectorFactory.isMacOS(),
        isLinux: ProcessInspectorFactory.isLinux()
      };
      logger.info('🖥️ Platform information:', platformInfo);
      
      // Initialize services
      await initializeServices();
      
      // Create initial window (main or node-setup based on detection)
      await createInitialWindow();
      
      // Initialize process tracking
      await initializeProcessTracking();
      
      logger.info('✅ Application initialization completed successfully');
      
    } catch (error) {
      logger.error('❌ Application initialization failed:', error);
      app.quit();
    }
  });

  // Window all closed event
  app.on('window-all-closed', () => {
    const windowCount = windowManager ? windowManager.getAllWindows().length : 0;
    logger.info(`🪟 Window-all-closed event triggered. Current window count: ${windowCount}`);
    
    // Only quit if there are actually no windows (safeguard)
    if (windowCount === 0) {
      logger.info('🚪 No windows remaining, quitting app...');
      app.quit();
    } else {
      logger.info(`⚠️ Window-all-closed triggered but ${windowCount} windows still exist. Not quitting.`);
    }
  });

  // Activate event (for macOS)
  app.on('activate', async () => {
    logger.info('🔄 App activated');
    if (windowManager && windowManager.getAllWindows().length === 0) {
      await createMainWindow();
    }

  // Track individual window close events for debugging
  app.on('browser-window-created', (event, window) => {
    logger.info(`🪟 Browser window created: ID ${window.id}`);
    
    window.on('closed', () => {
      const windowCount = windowManager ? windowManager.getAllWindows().length : 0;
      logger.info(`🪟 Window ID ${window.id} closed. Remaining windows: ${windowCount}`);
    });
  });

  });

  // Before quit event
  app.on('before-quit', async (event) => {
    if (isCleaningUp) {
      logger.info('🚫 Cleanup already in progress, skipping duplicate before-quit');
      return; // Prevent multiple cleanup attempts
    }

    // Check if this is a real app quit or just a secondary window closing
    const windowCount = BrowserWindow.getAllWindows().length;
    logger.info(`👋 before-quit triggered. Windows remaining: ${windowCount}`);
    
    if (windowCount > 1) {
      // More than 1 window still open - this is likely just a secondary window closing
      // Don't proceed with full cleanup yet
      logger.info(`⏸️ Deferring cleanup: ${windowCount} windows still open (secondary window close detected)`);
      return;
    }
    
    // If there's exactly 1 window, check if it's in the process of closing
    if (windowCount === 1) {
      const remainingWindow = BrowserWindow.getAllWindows()[0];
      if (!remainingWindow.isDestroyed() && remainingWindow.isVisible()) {
        logger.info('⏸️ Deferring cleanup: main window still active');
        return;
      }
    }

    logger.info('✅ Confirmed app quit - proceeding with cleanup...');
    isCleaningUp = true;
    try {
      // FIRST: Unregister IPC handlers so windows cannot send more IPC calls
      if (ipcRegistry) {
        logger.info('🔌 Unregistering IPC handlers...');
        ipcRegistry.unregisterIpcHandlers();
        logger.info('✅ IPC handlers unregistered');
      }

      // SECOND: Kill all child processes before closing windows/DB
      if (processManager && typeof processManager.killAll === 'function') {
        logger.info('💀 Killing all child processes...');
        await processManager.killAll();
        logger.info('✅ Child processes killed');
      }

      // THIRD: Close all windows
      if (windowManager) {
        logger.info('🪟 Closing all windows...');
        windowManager.closeAllWindows();
        logger.info('✅ All windows closed');
      }

      // Double-check no windows remain after explicit close
      const finalWindowCount = BrowserWindow.getAllWindows().length;
      if (finalWindowCount > 0) {
        logger.warn(`⚠️ ${finalWindowCount} windows still open after closeAllWindows, forcing destroy...`);
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.destroy();
          }
        });
      }

      if (menuManager) {
        menuManager.cleanup();
        logger.info('✅ Menu manager cleaned up');
      }
      if (databaseManager) {
        // KillAll ran before DB — no zombie handles can corrupt writes
        await databaseManager.close();
        logger.info('✅ Database closed');
      }
      logger.info('✅ Application cleanup completed successfully');
    } catch (error) {
      logger.error('❌ Error during cleanup:', error);
    }
  });

  // Will-quit — async cleanup BEFORE the app exits
  app.on('will-quit', async (event) => {
    event.preventDefault();
    logger.info('🛑 will-quit: starting async cleanup...');

    // Hard timeout: AC3 budget = 2000ms
    const hardTimeout = setTimeout(() => {
      logger.error('❌ will-quit cleanup timed out, forcing exit');
      app.exit(0);
    }, 2000);

    try {
      // 1. Kill all child processes via ProcessManager
      if (processManager && typeof processManager.killAll === 'function') {
        await processManager.killAll();
        logger.info('✅ Child processes killed via killAll');
      }

      // 2. Kill remaining tracked PIDs via DocumentalTracker
      const inspector = ProcessInspectorFactory.getInspector();
      if (appTracker && typeof appTracker.killAllProcesses === 'function') {
        await appTracker.killAllProcesses(inspector);
        logger.info('✅ Remaining PIDs killed via killAllProcesses');
      }

      // 3. Clear PID registry so a crash-recovered startup won't reap us
      if (appTracker && appTracker.pidRegistry && typeof appTracker.pidRegistry.clear === 'function') {
        await appTracker.pidRegistry.clear();
        logger.info('✅ PID registry cleared');
      }

      // 4. Stop theme file watcher
      if (themeService && typeof themeService.stopWatching === 'function') {
        themeService.stopWatching();
        logger.info('✅ Theme watcher stopped');
      }

      // 5. Restore original console methods
      if (logger && typeof logger.restoreConsoleMethods === 'function') {
        logger.restoreConsoleMethods();
      }

      // 6. Cleanup browser views on all windows
      if (ipcRegistry && ipcRegistry.browserHandlers &&
          typeof ipcRegistry.browserHandlers.cleanupAllWindowBrowserViews === 'function') {
        ipcRegistry.browserHandlers.cleanupAllWindowBrowserViews();
        logger.info('✅ Browser views cleaned up');
      }
    } catch (error) {
      logger.error('❌ Error during will-quit cleanup:', error);
    } finally {
      clearTimeout(hardTimeout);
      app.exit(0);
    }
  });

  // Process exit — synchronous SIGKILL fallback (last resort)
  process.on('exit', () => {
    // Sync only: send SIGKILL to any remaining known PIDs via PID registry
    if (appTracker && appTracker.pidRegistry) {
      // Load from in-memory cache — no async file reads in exit handler
      // We send SIGKILL to everything; ESRCH (already dead) is silently ignored.
      try {
        // We cannot await, so we just iteratively kill PIDs synchronously
        // The PID registry entries are loaded from disk at startup and kept
        // in the pidRegistryFile's in-memory state; we attempt to sync-load
        // the file as a last resort.
        try {
          const fs = require('fs');
          const raw = fs.readFileSync(appTracker.pidRegistry.filePath, 'utf8');
          const entries = JSON.parse(raw);
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              if (entry && typeof entry.pid === 'number') {
                try {
                  process.kill(-entry.pid, 'SIGKILL');
                } catch (e) {
                  // ESRCH — already dead, ignore
                }
              }
            }
          }
        } catch (e) {
          // File missing or corrupt — nothing to kill
        }
      } catch (e) {
        // Silent — this is last-resort cleanup
      }
    }
  });

  // Uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error('💥 Uncaught Exception:', error);
    // Continue execution but log the error
  });

  // Unhandled rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    // Continue execution but log the error
  });

  logger.info('✅ Application event handlers configured');
}

/**
 * Get service instances (for debugging or external access)
 * @returns {Object} Service instances
 */
function getServices() {
  return {
    databaseManager,
    windowManager,
    projectService,
    fileService,
    menuManager,
    ipcRegistry,
    appTracker,
    logger
  };
}

/**
 * Get application status
 * @returns {Object} Application status
 */
function getApplicationStatus() {
  return {
    isInitialized,
    isCleaningUp,
    platform: ProcessInspectorFactory.getPlatformName(),
    version: app.getVersion(),
    services: {
      database: !!databaseManager,
      windowManager: !!windowManager,
      projectService: !!projectService,
      fileService: !!fileService,
      menuManager: !!menuManager,
      ipcRegistry: !!ipcRegistry
    }
  };
}

// Initialize application
setupAppEventHandlers();

// Log successful startup
logger.info('✅ Production modular main process loaded successfully');
logger.info('🔧 Architecture: Pure modular with dependency injection');
logger.info('📦 Services: Database, Window, Project, File, Menu, IPC');

// Export for testing or debugging (only in development)
if (process.env.NODE_ENV === 'development') {
  module.exports = {
    getServices,
    getApplicationStatus,
    // Expose for testing
    _private: {
      initializeServices,
      createMainWindow,
      initializeProcessTracking,
      setupAppEventHandlers
    }
  };
}