/**
 * @fileoverview Central registry for all IPC handlers
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { AuthHandlers } = require('./auth.js');
const { ProjectHandlers } = require('./projects.js');
const { GitHandlers } = require('./git.js');
const { BrowserHandlers } = require('./browser.js');
const { SystemHandlers } = require('./system.js');
const { FileHandlers } = require('./file.js');
const { ProjectCreationHandler } = require('./projectCreation.js');
const { registerNodeDetectionHandlers } = require('./nodeDetection.js');
const { I18nHandlers } = require('./i18n.js');
const { GithubReposHandlers } = require('./githubRepos.js');
const { PermissionHandlers } = require('./permissionHandlers.js');

/**
 * IPC Registry - Central point for registering all IPC handlers
 */
class IpcRegistry {
  /**
   * Create an instance of IpcRegistry
   * @param {Object} dependencies - Dependency injection container
   */
  constructor(dependencies) {
    this.dependencies = dependencies;
    this.logger = dependencies.logger;
    
    // Initialize handler instances
    this.authHandlers = new AuthHandlers(dependencies);
    this.projectHandlers = new ProjectHandlers(dependencies);

    // Initialize permissionHandlers BEFORE gitHandlers so the latter can
    // receive it as a dependency (used by gitPublishMain for main-push gating).
    this.permissionHandlers = new PermissionHandlers({
      auth: this.authHandlers,
      databaseManager: dependencies.databaseManager,
      logger: this.logger,
    });

    this.gitHandlers = new GitHandlers({
      ...dependencies,
      permissionHandlers: this.permissionHandlers,
    });
    
    // Initialize projectCreationHandler FIRST (needed by browserHandlers and systemHandlers)
    this.projectCreationHandler = new ProjectCreationHandler(dependencies);
    
    // Initialize BrowserHandlers with ProcessManager from projectCreationHandler
    this.browserHandlers = new BrowserHandlers({
      ...dependencies,
      processManager: this.projectCreationHandler.processManager
    });
    this.fileHandlers = new FileHandlers(dependencies);
    
    this.systemHandlers = new SystemHandlers({
      ...dependencies,
      processManager: this.projectCreationHandler.processManager
    });
    
    // Register Node.js detection handlers
    if (dependencies.nodeDetectionService) {
      registerNodeDetectionHandlers(dependencies);
    } else {
      this.logger.warn('⚠️ NodeDetectionService not provided, skipping Node.js detection handlers');
    }
    
    this.i18nHandlers = new I18nHandlers({
      logger: this.logger,
      databaseManager: dependencies.databaseManager
    });

    this.githubReposHandlers = new GithubReposHandlers(dependencies);

    this.isRegistered = false;
  }

  /**
   * Register all IPC handlers
   * This should be called during app initialization
   */
  registerIpcHandlers() {
    if (this.isRegistered) {
      this.logger.warn('⚠️ IPC handlers already registered');
      return;
    }

    this.logger.info('🔌 Registering all IPC handlers...');

    try {
      // Register handlers in logical order
      this.systemHandlers.registerHandlers();
      this.authHandlers.registerHandlers();
      this.projectHandlers.registerHandlers();
      this.gitHandlers.registerHandlers();
      this.browserHandlers.registerHandlers();
      this.fileHandlers.registerHandlers();
      this.projectCreationHandler.registerHandlers();
      this.i18nHandlers.registerHandlers();
      this.githubReposHandlers.registerHandlers();
      this.permissionHandlers.register();

      this.isRegistered = true;
      this.logger.info('✅ All IPC handlers registered successfully');
      
      // Log summary of registered handlers
      this.logRegisteredHandlers();
      
    } catch (error) {
      this.logger.error('❌ Failed to register IPC handlers:', error);
      throw error;
    }
  }

  /**
   * Unregister all IPC handlers
   * This should be called during app cleanup
   */
  unregisterIpcHandlers() {
    if (!this.isRegistered) {
      this.logger.warn('⚠️ IPC handlers not registered');
      return;
    }

    this.logger.info('🔌 Unregistering all IPC handlers...');

    try {
      // Unregister handlers in reverse order
      this.projectCreationHandler.unregisterHandlers();
      this.i18nHandlers.unregisterHandlers();
      this.githubReposHandlers.unregisterHandlers();
      this.permissionHandlers.unregister();
      this.fileHandlers.unregisterHandlers();
      this.browserHandlers.unregisterHandlers();
      this.gitHandlers.unregisterHandlers();
      this.projectHandlers.unregisterHandlers();
      this.authHandlers.unregisterHandlers();
      this.systemHandlers.unregisterHandlers();

      this.isRegistered = false;
      this.logger.info('✅ All IPC handlers unregistered successfully');
      
    } catch (error) {
      this.logger.error('❌ Failed to unregister IPC handlers:', error);
      throw error;
    }
  }

  /**
   * Get handler instances for direct access if needed
   * @returns {Object} Object containing all handler instances
   */
  getHandlers() {
    return {
      auth: this.authHandlers,
      projects: this.projectHandlers,
      git: this.gitHandlers,
      browser: this.browserHandlers,
      system: this.systemHandlers,
      file: this.fileHandlers,
      projectCreation: this.projectCreationHandler,
      i18n: this.i18nHandlers
    };
  }

  /**
   * Log summary of registered handlers
   */
  logRegisteredHandlers() {
    this.logger.info('📋 Registered IPC handlers summary:');
    
    const handlerCategories = [
      { name: 'System', handlers: this.systemHandlers },
      { name: 'Authentication', handlers: this.authHandlers },
      { name: 'Projects', handlers: this.projectHandlers },
      { name: 'Git', handlers: this.gitHandlers },
      { name: 'Browser', handlers: this.browserHandlers },
      { name: 'File', handlers: this.fileHandlers },
      { name: 'Project Creation', handlers: this.projectCreationHandler },
      { name: 'Node Detection', handlers: null },
      { name: 'i18n', handlers: this.i18nHandlers }
    ];

    handlerCategories.forEach(category => {
      this.logger.info(`  📁 ${category.name} handlers registered`);
    });

    this.logger.info(`🔢 Total: ${handlerCategories.length} handler categories registered`);
  }

  /**
   * Check if IPC handlers are registered
   * @returns {boolean} Whether handlers are registered
   */
  isHandlersRegistered() {
    return this.isRegistered;
  }

  /**
   * Re-register all handlers (useful for development hot-reload)
   */
  reregisterIpcHandlers() {
    this.logger.info('🔄 Re-registering IPC handlers...');
    
    if (this.isRegistered) {
      this.unregisterIpcHandlers();
    }
    
    this.registerIpcHandlers();
  }

  /**
   * Get statistics about registered handlers
   * @returns {Object} Statistics object
   */
  getHandlerStats() {
    return {
      isRegistered: this.isRegistered,
      handlerCount: 9,
      categories: [
        'System',
        'Authentication', 
        'Projects',
        'Git',
        'Browser',
        'File',
        'Project Creation',
        'Node Detection',
        'i18n'
      ],
      registrationTime: new Date().toISOString()
    };
  }
}

/**
 * Factory function to create and configure IPC registry
 * @param {Object} dependencies - Dependency injection container
 * @returns {IpcRegistry} Configured IPC registry instance
 */
function createIpcRegistry(dependencies) {
  if (!dependencies.logger) {
    throw new Error('Logger is required in dependencies');
  }
  
  return new IpcRegistry(dependencies);
}

module.exports = {
  IpcRegistry,
  createIpcRegistry
};