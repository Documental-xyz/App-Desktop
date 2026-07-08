document.addEventListener('DOMContentLoaded', async () => {
  if (window.__i18nReady) await window.__i18nReady;
  const navigateButtons = document.querySelectorAll('[data-navigate]');
  function navigateToPage(page) {
    window.isNavigating = true;
    if (window.electronAPI && window.electronAPI.navigateTo) {
      window.electronAPI.navigateTo(page);
    }
  }
  const projectPathInput = document.getElementById('project-path');
  const selectFolderButton = document.getElementById('select-folder-button');
  const createProjectButton = document.getElementById('create-project-button');
  const projectNameInput = document.getElementById('project-name');
  const githubUrlInput = document.getElementById('github-url');

  // Cross-platform path utility functions
  const PathUtils = {
    join: async (...segments) => {
      if (window.electronAPI && window.electronAPI.joinPath) {
        return await window.electronAPI.joinPath(...segments);
      }
      // Fallback for development/testing
      return segments.join('/').replace(/\/+/g, '/');
    },
    
    normalize: async (filePath) => {
      if (window.electronAPI && window.electronAPI.normalizePath) {
        return await window.electronAPI.normalizePath(filePath);
      }
      // Fallback for development/testing
      return filePath.replace(/\\/g, '/');
    }
  };

  // Load recent projects
  await loadRecentProjects();
  
  // Load all projects if on all-projects page
  await loadAllProjects();
  
  // Handle open folder button
  const openFolderButton = document.getElementById('open-folder-button');
  if (openFolderButton) {
    openFolderButton.addEventListener('click', async () => {
      if (window.electronAPI && window.electronAPI.openDirectoryDialog) {
        try {
          openFolderButton.disabled = true;
          const selectedPath = await window.electronAPI.openDirectoryDialog();
          if (selectedPath) {
            await handleFolderSelection(selectedPath);
          }
        } catch (error) {
          console.error('Error opening directory dialog:', error);
        } finally {
          openFolderButton.disabled = false;
        }
      }
    });
  }
  
  navigateButtons.forEach(button => {
    button.addEventListener('click', () => {
      const page = button.dataset.navigate;
      if (window.electronAPI && window.electronAPI.navigateTo) {
        navigateToPage(page);
      } else {
        console.error('Electron API not available or navigateTo function missing.');
      }
    });
  });

  // Set default project path only if empty and we're on the new project page
  const isNewProjectPage = window.location.pathname.includes('new.html') || window.location.href.includes('new.html');
  
  if (isNewProjectPage) {
    // Wait a bit for DOM to be fully ready
    setTimeout(async () => {
      // Re-get the element to make sure it exists
      const projectPathInputRetry = document.getElementById('project-path');
      
      if (window.electronAPI && window.electronAPI.getHomeDirectory && projectPathInputRetry) {
        if (!projectPathInputRetry.value) {
          try {
            const homeDir = await window.electronAPI.getHomeDirectory();
            const defaultPath = await PathUtils.join(homeDir, 'Workspaces');
            const normalizedPath = await PathUtils.normalize(defaultPath);
            projectPathInputRetry.value = normalizedPath;
          } catch (error) {
            console.error('Error setting default project path:', error);
          }
        }
      }
    }, 100); // Small delay to ensure DOM is ready
  }

  // Handle folder selection
  if (selectFolderButton && window.electronAPI && window.electronAPI.openDirectoryDialog) {
    selectFolderButton.addEventListener('click', async () => {
      try {
        selectFolderButton.disabled = true;
        const selectedPath = await window.electronAPI.openDirectoryDialog();
        if (selectedPath && projectPathInput) {
          const normalizedPath = await PathUtils.normalize(selectedPath);
          projectPathInput.value = normalizedPath;
        }
      } catch (error) {
        console.error('Error opening directory dialog:', error);
      } finally {
        selectFolderButton.disabled = false;
      }
    });
  } else {
    // Don't log error if elements don't exist (they may not be on this page)
  }

  // Handle project creation
  if (createProjectButton && window.electronAPI && window.electronAPI.saveProject) {
    createProjectButton.addEventListener('click', async () => {
      const projectName = projectNameInput ? projectNameInput.value : '';
      const githubUrl = githubUrlInput ? githubUrlInput.value : '';
      const projectPath = projectPathInput ? projectPathInput.value : '';

      if (!projectName || !githubUrl || !projectPath) {
        alert(__t('new.fill_all_fields'));
        return;
      }

      const isTemplateMode = sessionStorage.getItem('repoSelectMode') === 'template';
      console.log('[template-check] isTemplateMode:', isTemplateMode, 'checkRepoExists available:', !!window.electronAPI?.checkRepoExists);
      if (isTemplateMode) {
        if (!window.electronAPI || !window.electronAPI.checkRepoExists) {
          console.warn('[template-check] checkRepoExists IPC not available — preload may need app restart');
        } else {
          const slug = projectName.trim()
            .replace(/\s+/g, '-')
            .replace(/[^\w\-]+/g, '')
            .replace(/\-\-+/g, '-')
            .replace(/^-+/, '')
            .replace(/-+$/, '');
          console.log('[template-check] project name:', projectName, '→ slug:', slug);
          if (slug) {
            const result = await window.electronAPI.checkRepoExists(slug);
            console.log('[template-check] checkRepoExists result:', result);
            if (result.exists) {
              alert(__t('new.repo_exists_alert', { name: slug }));
              return;
            }
          }
        }
      }

      try {
        // Check if this is an existing git repo or empty folder
        let isExistingGitRepo = false;
        let isEmptyFolder = false;
        const folderInfo = sessionStorage.getItem('folderInfo');
        if (folderInfo) {
          const info = JSON.parse(folderInfo);
          isExistingGitRepo = info.isGitRepo;
          isEmptyFolder = info.isEmpty;
        }
        
        // Normalize project path before saving
        const normalizedProjectPath = await PathUtils.normalize(projectPath);
        const useTemplate = sessionStorage.getItem('repoSelectMode') === 'template';
        const projectId = await window.electronAPI.saveProject({ projectName, repoUrl: githubUrl, projectPath: normalizedProjectPath });
        sessionStorage.setItem('currentProjectId', projectId);
        sessionStorage.setItem('isExistingGitRepo', isExistingGitRepo.toString());
        sessionStorage.setItem('isEmptyFolder', isEmptyFolder.toString());
        sessionStorage.setItem('useTemplate', useTemplate.toString());
        sessionStorage.setItem('projectName', projectName);
        const enablePagesToggle = document.getElementById('enable-pages-toggle');
        const enablePages = enablePagesToggle ? enablePagesToggle.checked : false;
        sessionStorage.setItem('enableGitHubPages', enablePages.toString());
        const privateRepoToggle = document.getElementById('private-repo-toggle');
        const isPrivateRepo = privateRepoToggle ? privateRepoToggle.checked : false;
        sessionStorage.setItem('isPrivateRepo', isPrivateRepo.toString());
        sessionStorage.removeItem('folderInfo');
        sessionStorage.removeItem('repoSelectMode');
        sessionStorage.removeItem('selectedRepo');
        navigateToPage('create.html'); // Navigate to create page after creation
      } catch (error) {
        alert(__t('new.error_create_project', {error}));
        console.error('Error saving project:', error);
      }
    });
  } else {
    // Don't log error if elements don't exist (they may not be on this page)
  }

  // Function to load recent projects
  async function loadRecentProjects() {
    const recentProjectsContainer = document.getElementById('recent-projects-container');
    if (!recentProjectsContainer) return;

    try {
      if (window.electronAPI && window.electronAPI.getRecentProjects) {
        const recentProjects = await window.electronAPI.getRecentProjects();
        
        if (recentProjects.length === 0) {
          recentProjectsContainer.innerHTML = `
            <div class="text-center text-muted-dark py-8">
              <span class="material-symbols-outlined text-4xl mb-2">folder_off</span>
              <p>${__t('index.no_recent_projects')}</p>
            </div>
          `;
          return;
        }

        recentProjectsContainer.innerHTML = await Promise.all(recentProjects.map(async (project) => {
          const fullPath = project.repoFolderName 
            ? await PathUtils.join(project.projectPath, project.repoFolderName)
            : project.projectPath;
          
          const repoName = project.repoFullName || '';
          return `
            <div class="flex items-center justify-between bg-surface-dark p-4 rounded-lg hover:bg-gray-800 cursor-pointer recent-project-item" data-project-id="${project.id}">
              <div class="flex items-center gap-4">
                <span class="material-symbols-outlined text-muted-dark">description</span>
                <div>
                  <p class="font-semibold text-text-dark">${project.projectName}</p>
                  ${repoName ? `<p class="text-sm text-muted-dark flex items-center gap-1 mt-0.5"><span class="material-symbols-outlined text-xs">commit</span>${repoName}</p>` : ''}
                  <p class="text-sm text-muted-dark flex items-center gap-1 mt-0.5"><span class="material-symbols-outlined text-xs">folder</span>${fullPath}</p>
                </div>
              </div>
              <button class="p-2 rounded-full hover:bg-gray-700 remove-project" data-project-id="${project.id}">
                <span class="material-symbols-outlined text-muted-dark text-xl">close</span>
              </button>
            </div>
          `;
        })).then(htmlArray => htmlArray.join(''));

        // Add click handlers for recent projects
        document.querySelectorAll('.recent-project-item').forEach(item => {
          item.addEventListener('click', (e) => {
            if (!e.target.closest('.remove-project')) {
              const projectId = item.dataset.projectId;
              openRecentProject(projectId);
            }
          });
        });

        // Add click handlers for remove buttons
        document.querySelectorAll('.remove-project').forEach(button => {
          button.addEventListener('click', (e) => {
            e.stopPropagation();
            const projectId = button.dataset.projectId;
            const projectItem = button.closest('.recent-project-item');
            const projectName = projectItem.querySelector('.font-semibold').textContent;
            removeProject(projectId, projectName);
          });
        });

      } else {
        console.error('Electron API for getRecentProjects missing.');
      }
    } catch (error) {
      console.error('Error loading recent projects:', error);
      recentProjectsContainer.innerHTML = `
        <div class="text-center text-red-400 py-8">
          <p>${__t('index.error_load_recent')}</p>
        </div>
      `;
    }
  }

  // Function to open recent project
  async function openRecentProject(projectId) {
    try {
      sessionStorage.setItem('currentProjectId', projectId);
      sessionStorage.setItem('reopenMode', 'true');
      navigateToPage('create.html');
    } catch (error) {
      console.error('Error opening recent project:', error);
      alert(__t('all_projects.error_open_project', {error}));
    }
  }

  // Function to remove project
  async function removeProject(projectId, projectName = null) {
    // Simple confirmation for now
    const confirmRemoval = confirm(__t('all_projects.confirm_remove', {name: projectName || __t('script.project_fallback', {id: projectId})}));
    
    if (!confirmRemoval) {
      return;
    }
    
    try {
      if (window.electronAPI && window.electronAPI.removeProject) {
        await window.electronAPI.removeProject(projectId);
        
        // Reload the projects list
        await loadAllProjects();
        await loadRecentProjects(); // Also reload recent projects if on index page
        
        console.log('Project removed successfully');
      } else {
        console.error('removeProject API not available');
        alert(__t('all_projects.error_remove_api'));
      }
    } catch (error) {
      console.error('Error removing project:', error);
      alert(__t('all_projects.error_remove', {error}));
    }
  }

  // Function to load all projects
  async function loadAllProjects() {
    const allProjectsContainer = document.getElementById('all-projects-container');
    const projectsCountContainer = document.getElementById('projects-count-container');
    if (!allProjectsContainer) return;

    try {
      console.log('Loading all projects...');
      if (window.electronAPI && window.electronAPI.getAllProjects) {
        console.log('Calling getAllProjects API...');
        const allProjects = await window.electronAPI.getAllProjects();
        console.log('Received projects:', allProjects);
        
        if (projectsCountContainer) {
          projectsCountContainer.textContent = __t('all_projects.projects_found', { count: allProjects.length });
        }
        
        if (allProjects.length === 0) {
          allProjectsContainer.innerHTML = `
            <div class="text-center text-muted-dark py-8">
              <span class="material-symbols-outlined text-4xl mb-2">folder_off</span>
              <p>${__t('all_projects.no_projects')}</p>
            </div>
          `;
          return;
        }

        allProjectsContainer.innerHTML = await Promise.all(allProjects.map(async (project) => {
          const fullPath = project.repoFolderName 
            ? await PathUtils.join(project.projectPath, project.repoFolderName)
            : project.projectPath;
          
          const repoName = project.repoFullName || '';
          return `
            <div class="flex items-center justify-between bg-gray-900/50 p-4 rounded-lg hover:bg-gray-800 cursor-pointer all-project-item" data-project-id="${project.id}">
              <div class="flex items-center gap-4">
                <span class="material-symbols-outlined text-muted-dark">description</span>
                <div>
                  <p class="font-semibold text-text-dark">${project.projectName}</p>
                  ${repoName ? `<p class="text-sm text-muted-dark flex items-center gap-1 mt-0.5"><span class="material-symbols-outlined text-xs">commit</span>${repoName}</p>` : ''}
                  <p class="text-sm text-muted-dark flex items-center gap-1 mt-0.5"><span class="material-symbols-outlined text-xs">folder</span>${fullPath}</p>
                  <p class="text-xs text-muted-dark mt-1">${__t('all_projects.created_at', {date: new Date(project.createdAt).toLocaleDateString(__t('common.date_locale'))})}</p>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <button class="p-2 rounded-full hover:bg-gray-700 open-project" data-project-id="${project.id}" title="${__t('all_projects.open_project')}">
                  <span class="material-symbols-outlined text-primary text-xl">folder_open</span>
                </button>
                <button class="p-2 rounded-full hover:bg-gray-700 remove-project" data-project-id="${project.id}" title="${__t('all_projects.remove_project')}">
                  <span class="material-symbols-outlined text-red-400 text-xl">delete</span>
                </button>
              </div>
            </div>
          `;
        })).then(htmlArray => htmlArray.join(''));

        // Add click handlers for all projects
        document.querySelectorAll('.all-project-item').forEach(item => {
          item.addEventListener('click', (e) => {
            if (!e.target.closest('.open-project') && !e.target.closest('.remove-project')) {
              const projectId = item.dataset.projectId;
              openRecentProject(projectId);
            }
          });
        });

        // Add click handlers for open buttons
        document.querySelectorAll('.open-project').forEach(button => {
          button.addEventListener('click', (e) => {
            e.stopPropagation();
            const projectId = button.dataset.projectId;
            openRecentProject(projectId);
          });
        });

        // Add click handlers for remove buttons
        document.querySelectorAll('.remove-project').forEach(button => {
          button.addEventListener('click', (e) => {
            e.stopPropagation();
            const projectId = button.dataset.projectId;
            const projectItem = button.closest('.all-project-item');
            const projectName = projectItem.querySelector('.font-semibold').textContent;
            removeProject(projectId, projectName);
          });
        });

      } else {
        console.error('Electron API for getAllProjects missing.');
        allProjectsContainer.innerHTML = `
          <div class="text-center text-red-400 py-8">
            <p>${__t('all_projects.api_not_found')}</p>
          </div>
        `;
      }
    } catch (error) {
      console.error('Error loading all projects:', error);
      allProjectsContainer.innerHTML = `
        <div class="text-center text-red-400 py-8">
          <p>${__t('all_projects.error_load_all', {error: error.message || error})}</p>
        </div>
      `;
    }
  }

  // Function to handle folder selection
  async function handleFolderSelection(folderPath) {
    try {
      // Normalize the folder path before processing
      const normalizedPath = await PathUtils.normalize(folderPath);

      if (window.electronAPI && window.electronAPI.checkProjectExists) {
        const projectExists = await window.electronAPI.checkProjectExists(normalizedPath);

        if (projectExists.exists) {
          // Project exists, open it using create.html + reopenMode
          sessionStorage.setItem('currentProjectId', projectExists.projectId);
          sessionStorage.setItem('reopenMode', 'true');
          navigateToPage('create.html');
          return;
        }

        const folderInfo = projectExists.folderInfo;
        if (!folderInfo) {
          showFolderModal(normalizedPath, folderInfo);
          return;
        }

        if (!folderInfo.isGitRepo) {
          const notGitModal = document.getElementById('not-git-modal');
          if (notGitModal) notGitModal.style.display = 'flex';
          return;
        }

        if (folderInfo.isGitRepo && !folderInfo.isDocumental) {
          const notDocModal = document.getElementById('not-documental-modal');
          if (notDocModal) {
            notDocModal.dataset.selectedPath = normalizedPath;
            notDocModal.dataset.remoteUrl = folderInfo.remoteUrl || '';
            notDocModal.style.display = 'flex';
          }
          return;
        }

        // Git repo + Documental project: show existing folder modal
        showFolderModal(normalizedPath, folderInfo);
      }
    } catch (error) {
      console.error('Error checking folder:', error);
      alert(__t('script.error_check_folder', {error}));
    }
  }

  // Function to show folder modal
  function showFolderModal(folderPath, folderInfo) {
    const folderModal = document.getElementById('folder-modal');
    const folderInfoDiv = document.getElementById('folder-info');

    folderModal.dataset.selectedPath = folderPath;

    // Store early so new.html reads reliable isExistingGitRepo/isEmptyFolder
    // even if the user clicks Create before async detection completes.
    if (folderInfo) {
      sessionStorage.setItem('folderInfo', JSON.stringify(folderInfo));
    }

    let infoHTML = `<p><strong>${__t('script.folder_path_label')}</strong> ${folderPath}</p>`;
    
    if (folderInfo) {
      if (folderInfo.isEmpty) {
        infoHTML += `<p><strong>${__t('script.status_label')}</strong> ${__t('script.status_empty')}</p>`;
        infoHTML += `<p><strong>${__t('script.action_label')}</strong> ${__t('script.action_clone')}</p>`;
      } else if (folderInfo.isGitRepo) {
        infoHTML += `<p><strong>${__t('script.status_label')}</strong> ${__t('script.status_git')}</p>`;
        if (folderInfo.remoteUrl) {
          infoHTML += `<p><strong>${__t('script.remote_url')}</strong> ${folderInfo.remoteUrl}</p>`;
        }
        infoHTML += `<p><strong>${__t('script.action_label')}</strong> ${__t('script.action_existing')}</p>`;
      } else {
        infoHTML += `<p><strong>${__t('script.status_label')}</strong> ${__t('script.status_files')}</p>`;
        infoHTML += `<p><strong>${__t('script.action_label')}</strong> ${__t('script.action_subfolder')}</p>`;
      }
      infoHTML += `<p><strong>${__t('script.content_label')}</strong> ${__t('script.content_count', {count: folderInfo.fileCount || 0})}</p>`;
    }
    
    folderInfoDiv.innerHTML = infoHTML;
    folderModal.style.display = 'flex';
  }

  // Handle confirm new project button
  const confirmNewProjectBtn = document.getElementById('confirm-new-project');
  if (confirmNewProjectBtn) {
    confirmNewProjectBtn.addEventListener('click', () => {
      const folderModal = document.getElementById('folder-modal');
      const selectedPath = folderModal.dataset.selectedPath;
      
      if (selectedPath) {
        sessionStorage.setItem('selectedProjectPath', selectedPath);
        sessionStorage.setItem('createFromFolder', 'true');
        navigateToPage('new.html');
      }
      folderModal.style.display = 'none';
    });
  }

  // Handle cancel folder button
  const cancelFolderBtn = document.getElementById('cancel-folder');
  if (cancelFolderBtn) {
    cancelFolderBtn.addEventListener('click', () => {
      const folderModal = document.getElementById('folder-modal');
      folderModal.style.display = 'none';
    });
  }

  // Not-git modal close
  const notGitClose = document.getElementById('not-git-close');
  if (notGitClose) {
    notGitClose.addEventListener('click', () => {
      document.getElementById('not-git-modal').style.display = 'none';
    });
  }

  // Not-git modal open another folder
  const notGitOpenAnother = document.getElementById('not-git-open-another');
  if (notGitOpenAnother) {
    notGitOpenAnother.addEventListener('click', async () => {
      document.getElementById('not-git-modal').style.display = 'none';
      if (window.electronAPI && window.electronAPI.openDirectoryDialog) {
        try {
          const selectedPath = await window.electronAPI.openDirectoryDialog();
          if (selectedPath) {
            await handleFolderSelection(selectedPath);
          }
        } catch (error) {
          console.error('Error opening directory dialog:', error);
        }
      }
    });
  }

  // Not-documental modal buttons
  const notDocCancel = document.getElementById('not-documental-cancel');
  if (notDocCancel) {
    notDocCancel.addEventListener('click', () => {
      document.getElementById('not-documental-modal').style.display = 'none';
    });
  }

  const notDocContinue = document.getElementById('not-documental-continue');
  if (notDocContinue) {
    notDocContinue.addEventListener('click', () => {
      const notDocModal = document.getElementById('not-documental-modal');
      const selectedPath = notDocModal.dataset.selectedPath;
      notDocModal.style.display = 'none';
      if (selectedPath) {
        window.electronAPI.getFolderInfo(selectedPath).then(folderInfo => {
          showFolderModal(selectedPath, folderInfo);
        }).catch(err => {
          console.error('Error getting folder info:', err);
          showFolderModal(selectedPath, null);
        });
      }
    });
  }

});
