const { contextBridge, ipcRenderer } = require('electron');

console.log('🔧 Preload script loaded successfully!');

contextBridge.exposeInMainWorld('electronAPI', {
  navigateTo: (page) => ipcRenderer.send('navigate', page),
  getHomeDirectory: () => ipcRenderer.invoke('get-home-directory'),
  openDirectoryDialog: () => ipcRenderer.invoke('open-directory-dialog'),
  saveProject: (projectData) => ipcRenderer.invoke('save-project', projectData),
  getProjectDetails: (projectId) => ipcRenderer.invoke('get-project-details', projectId),
  getRecentProjects: () => ipcRenderer.invoke('get-recent-projects'),
  getAllProjects: () => ipcRenderer.invoke('getAllProjects'),
  removeProject: (projectId) => ipcRenderer.invoke('remove-project', projectId),
  checkProjectExists: (folderPath) => ipcRenderer.invoke('checkProjectExists', folderPath),
  getFolderInfo: (folderPath) => ipcRenderer.invoke('getFolderInfo', folderPath),
  startProjectCreation: (projectId, projectPath, githubUrl, isExistingGitRepo = false, isEmptyFolder = false, useTemplate = false, projectName = '', enablePages = false, organization = null, isPrivateRepo = false) =>
    ipcRenderer.invoke('start-project-creation', projectId, projectPath, githubUrl, isExistingGitRepo, isEmptyFolder, useTemplate, projectName, enablePages, organization, isPrivateRepo),
  checkRepoExists: (repoName) => ipcRenderer.invoke('check-repo-exists', repoName),
  checkTemplateTargetExists: (targetOwner, repoName) => ipcRenderer.invoke('check-template-target-exists', targetOwner, repoName),
  reopenProject: (projectId, projectPath, githubUrl, repoFolderName) => ipcRenderer.invoke('reopen-project', projectId, projectPath, githubUrl, repoFolderName),
  openProjectOnlyPreviewAndServer: (projectId, projectPath, githubUrl, repoFolderName) => ipcRenderer.invoke('open-project-only-preview-and-server', projectId, projectPath, githubUrl, repoFolderName),
  cancelProjectCreation: (projectId, projectPath, repoFolderName, shouldDeleteFiles = false) =>
    ipcRenderer.invoke('cancel-project-creation', projectId, projectPath, repoFolderName, shouldDeleteFiles),

  onCommandOutput: (callback) => ipcRenderer.on('command-output', (event, ...args) => callback(...args)),
  onCommandStatus: (callback) => ipcRenderer.on('command-status', (event, ...args) => callback(...args)),
  onDevServerUrl: (callback) => ipcRenderer.on('dev-server-url', (event, ...args) => callback(...args)),
  onAppLogOutput: (callback) => ipcRenderer.on('app-log-output', (event, ...args) => callback(...args)),
  onServerOutput: (callback) => ipcRenderer.on('server-output', (event, ...args) => callback(...args)),
  getAppLogs: () => ipcRenderer.invoke('get-app-logs'),
  clearConsoleOutput: (type) => ipcRenderer.send('clear-console-output', type),
  setBrowserViewBounds: (viewName, bounds) => ipcRenderer.invoke('set-browser-view-bounds', viewName, bounds),
  loadBrowserViewUrl: (viewName, url) => ipcRenderer.invoke('load-browser-view-url', viewName, url),
  setBrowserViewVisibility: (viewName, visible) => ipcRenderer.invoke('set-browser-view-visibility', viewName, visible),
  setAllBrowserViewVisibility: (visible) => ipcRenderer.invoke('set-all-browser-view-visibility', visible),
  getDevServerUrlFromMain: () => ipcRenderer.invoke('get-dev-server-url-from-main'),
  captureBrowserViewPage: (viewName) => ipcRenderer.invoke('capture-browser-view-page', viewName),
  browserViewGoBack: (viewName) => ipcRenderer.invoke('browser-view-go-back', viewName),
  browserViewReload: (viewName) => ipcRenderer.invoke('browser-view-reload', viewName),
  getBrowserViewUrl: (viewName) => ipcRenderer.invoke('get-browser-view-url', viewName),
  clearBrowserCache: () => ipcRenderer.invoke('clear-browser-cache'),
  createNewWindowWithState: (windowState) => ipcRenderer.invoke('create-new-window-with-state', windowState),
  closeAndReopenToIndex: () => ipcRenderer.invoke('close-and-reopen-to-index'),
  onBrowserViewLoaded: (callback) => ipcRenderer.on('browser-view-loaded', (event, payload) => callback(payload)),
  onBrowserViewNavigated: (callback) => ipcRenderer.on('browser-view-navigated', (event, payload) => callback(payload)),
  confirmExitApp: () => ipcRenderer.invoke('confirm-exit-app'),
  onShowExitConfirmation: (callback) => ipcRenderer.on('show-exit-confirmation', callback),
  onAppExiting: (callback) => ipcRenderer.on('app-exiting', callback),
  sendExitConfirmationResponse: (confirmed) => ipcRenderer.send('exit-confirmation-response', confirmed),
  // GitHub authentication functions
  checkGitHubAuth: () => ipcRenderer.invoke('checkGitHubAuth'),
  authenticateWithGitHub: () => ipcRenderer.invoke('authenticateWithGitHub'),
  continueGitHubAuth: (deviceCode, interval) => ipcRenderer.invoke('continueGitHubAuth', deviceCode, interval),
  completeWelcomeSetup: () => ipcRenderer.invoke('completeWelcomeSetup'),
  logoutFromGitHub: () => ipcRenderer.invoke('logoutFromGitHub'),
  writeToClipboard: (text) => ipcRenderer.invoke('writeToClipboard', text),
  getUserInfo: () => ipcRenderer.invoke('user:get-info'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  updateUserInfo: (data) => ipcRenderer.invoke('user:update-info', data),
  // Node.js detection and installation functions
  checkNodeInstallation: () => ipcRenderer.invoke('checkNodeInstallation'),
  installNodeDependencies: (options) => ipcRenderer.invoke('installNodeDependencies', options),
  getNodeInstallationProgress: () => ipcRenderer.invoke('getNodeInstallationProgress'),
  detectNode: () => ipcRenderer.invoke('node:detect'),
  installManagedNode: (options) => ipcRenderer.invoke('node:install', options),
  onNodeInstallProgress: (callback) => ipcRenderer.on('node:install-progress', (event, payload) => callback(payload)),
  onGitProgress: (callback) => ipcRenderer.on('git:progress', (event, payload) => callback(payload)),

  // Git branch management functions
  listBranches: (projectId) => ipcRenderer.invoke('git:list-branches', projectId),
  createBranch: (projectId, branchName) => ipcRenderer.invoke('git:create-branch', projectId, branchName),
  checkoutBranch: (projectId, branchName) => ipcRenderer.invoke('git:checkout-branch', projectId, branchName),
  getCurrentBranch: (projectId) => ipcRenderer.invoke('git:get-current-branch', projectId),
  // Repository information functions
  getRepositoryInfo: (projectId) => ipcRenderer.invoke('git:get-repository-info', projectId),
  // Git pull, push, and status functions
  checkGitStatus: (projectId) => ipcRenderer.invoke('git:check-status', projectId),
  checkUnpushed: (projectId) => ipcRenderer.invoke('git:check-unpushed', projectId),
  pullFromPreview: (projectId, commitMessage) => ipcRenderer.invoke('git:pull-from-preview', projectId, commitMessage),
  pushToBranch: (projectId, targetBranch, commitMessage) => ipcRenderer.invoke('git:push-to-branch', projectId, targetBranch, commitMessage),
  refreshProject: (projectId, force) => ipcRenderer.invoke('git:refresh', projectId, force),
  publishToPreview: (projectId, commitMessage) => ipcRenderer.invoke('git:publish-preview', projectId, commitMessage),
  publishToMain: (projectId) => ipcRenderer.invoke('git:publish-main', projectId),
  /**
   * Resolve a pending conflict decision (counterpart of a CONFLICT_PENDING
   * result returned by refreshProject/publishToPreview/publishToMain).
   *
   * @param {string} resumeToken - single-use token from the CONFLICT_PENDING payload
   * @param {'MERGE_LOCAL'|'MERGE_REMOTE'|'FULL_LOCAL'|'FULL_REMOTE'|'CANCEL'} strategy
   *   Context mapping — publish/refresh: LOCAL = this machine, REMOTE = origin;
   *   publish-main: LOCAL = main, REMOTE = preview. MERGE_* = per-hunk winner,
   *   FULL_* = same winner as a total decision. CANCEL = clean abort (local
   *   version and backup are kept).
   * @returns {Promise<{success: boolean, code?: string, error?: string, message?: string, branch?: string}>}
   *   Typed codes: CANCELLED, INVALID_TOKEN, TOKEN_EXPIRED, INVALID_STRATEGY.
   */
  resolveGitConflict: (resumeToken, strategy) => ipcRenderer.invoke('git:resolve-conflict', resumeToken, strategy),
  checkPublishMain: (projectId) => ipcRenderer.invoke('git:check-publish-main', projectId),
  invalidatePermissionCache: (projectId) => ipcRenderer.invoke('git:invalidate-permission-cache', projectId),
  listRemoteBranches: (projectId) => ipcRenderer.invoke('git:list-remote-branches', projectId),
  listBackups: (projectId) => ipcRenderer.invoke('git:backup-list', projectId),
  restoreBackup: (projectId, backupBranch) => ipcRenderer.invoke('git:backup-restore', projectId, backupBranch),
  deleteBackup: (projectId, backupBranch) => ipcRenderer.invoke('git:backup-delete', projectId, backupBranch),
  cancelGitOperation: () => ipcRenderer.invoke('git:cancel-operation'),
  openInFileExplorer: (path) => ipcRenderer.invoke('open-file-explorer', path),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  listUserRepos: () => ipcRenderer.invoke('github:list-user-repos'),
  findDocumentalRepos: () => ipcRenderer.invoke('github:find-documental-repos'),
  listUserOrgs: () => ipcRenderer.invoke('github:list-user-orgs'),
  // Path utility functions
  joinPath: (...segments) => ipcRenderer.invoke('join-path', ...segments),
  normalizePath: (filePath) => ipcRenderer.invoke('normalizePath', filePath),
  getDirName: (filePath) => ipcRenderer.invoke('get-dir-name', filePath),
  getBaseName: (filePath) => ipcRenderer.invoke('get-base-name', filePath),
  // i18n (internationalization) functions
  getTranslations: (locale) => ipcRenderer.invoke('i18n:get-translations', locale),
  getTranslationsSync: (locale) => ipcRenderer.sendSync('i18n:get-translations-sync', locale),
  getAppLocale: () => ipcRenderer.invoke('i18n:get-locale'),
  getAppLocaleSync: () => ipcRenderer.sendSync('i18n:get-locale-sync'),
  setAppLocale: (locale) => ipcRenderer.invoke('i18n:set-locale', locale),
  getAvailableLocales: () => ipcRenderer.invoke('i18n:get-available-locales'),
  setThemeMode: (mode) => ipcRenderer.invoke('set-theme-mode', mode),
  getThemeMode: () => ipcRenderer.invoke('get-theme-mode'),
  onThemeChange: (callback) => ipcRenderer.on('theme-changed', (event, data) => callback(data)),
  getOsDarkPreference: () => ipcRenderer.invoke('get-os-dark-preference'),
});

console.log('✅ electronAPI exposed to renderer successfully');
