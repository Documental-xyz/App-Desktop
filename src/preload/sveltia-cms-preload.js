/**
 * @fileoverview Preload script for Sveltia CMS BrowserView
 * Extracts slug from CMS and communicates with main process via IPC
 * @author Documental Team
 * @since 1.0.0
 */

const { contextBridge, ipcRenderer } = require('electron');

// Configuration
const CONFIG = {
  SELECTOR: 'section[data-key-path="slug"] input',
  MAX_POLLING_ATTEMPTS: 15,
  BASE_POLLING_INTERVAL: 150, // ms
  EDIT_PAGE_PATTERN: /#\/collections\/[^/]+\/entries\/[^/]+/
};

// State
let currentPollingTimeout = null;
let lastExtractedSlug = null;

// State for tracking slug changes (hybrid approach for both Sveltia configs)
let initialSlug = null;        // Slug when entering edit page
let slugChangeSent = false;    // Flag to prevent duplicate sends
let currentSlugValue = null;   // Current value being tracked

/**
 * Store initial slug when entering edit page
 */
const storeInitialSlug = () => {
  const slug = extractSlug();
  if (slug) {
    initialSlug = slug;
    currentSlugValue = slug;
    slugChangeSent = false;
    log(`📌 Initial slug stored: "${slug}"`);
  }
};

// Interceptar todos os submits do documento
document.addEventListener('submit', (e) => {
  log('🚀 Form submit detected!');
  
  // Ler valor DIRETAMENTE do DOM no momento do submit
  const input = document.querySelector(CONFIG.SELECTOR);
  const slugAtSubmit = input ? input.value : null;
  
  log(`📸 Slug captured at submit: "${slugAtSubmit}"`);
  
  // Usar este valor para a comparação - update currentSlugValue before check
  if (slugAtSubmit) {
    currentSlugValue = slugAtSubmit;
    checkAndSendSlugChange('submit');
  }
}, true); // Use capture phase

/**
 * Check if slug changed and send IPC if needed
 * @param {string} trigger - What triggered this check ('postSave', 'hashchange', 'beforeunload')
 */
const checkAndSendSlugChange = (trigger) => {
  if (slugChangeSent) {
    log(`⏭️ Slug change already sent, skipping (${trigger})`);
    return;
  }

  // SEMPRE ler diretamente do DOM, nunca usar variável em cache
  const input = document.querySelector(CONFIG.SELECTOR);
  const currentSlug = input ? input.value : null;
  
  log(`🔍 [${trigger}] Checking: initial="${initialSlug}", current="${currentSlug}"`);
  
  if (!currentSlug) {
    log(`⚠️ No slug found (${trigger})`, 'warn');
    return;
  }

  // Comparar com initial slug
  if (initialSlug && currentSlug !== initialSlug) {
    log(`✅ Slug CHANGED from "${initialSlug}" to "${currentSlug}" (${trigger})`);
    const sent = sendSlugToMain('cms:slug-changed', currentSlug);
    if (sent) {
      slugChangeSent = true;
      lastExtractedSlug = currentSlug;
      log(`📤 Sent cms:slug-changed via ${trigger}`);
      
      // LOG NO TERMINAL PARA DEBUG
      console.log(`[SLUG CAPTURED] ${trigger}: "${currentSlug}"`);
      console.log(`[Sveltia CMS] Initial: "${initialSlug}", Current: "${currentSlug}"`);
      console.log(`[Sveltia CMS] Changed: ${currentSlug !== initialSlug}`);
    }
  } else {
    log(`ℹ️ Slug unchanged (${trigger}): "${currentSlug}"`);
  }
};

/**
 * Observe slug field to track current value in real-time
 */
let slugObserver = null;
const observeSlugField = () => {
  const input = document.querySelector(CONFIG.SELECTOR);
  if (!input) {
    log('⚠️ Slug input not found for observation', 'warn');
    return false;
  }
  
  if (slugObserver) slugObserver.disconnect();
  
  // Initialize with current value
  currentSlugValue = input.value;
  log(`📊 Initial slug value set: "${currentSlugValue}"`);
  
  // Track value changes via MutationObserver (for programmatic changes)
  slugObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'attributes' && mutation.attributeName === 'value') {
        const newValue = input.value;
        log(`📝 Slug value changed (mutation): "${newValue}"`);
        currentSlugValue = newValue;
      }
    });
  });
  
  slugObserver.observe(input, { 
    attributes: true, 
    attributeFilter: ['value']
  });
  
  // ALSO observe parent section for structural changes
  const section = input.closest('section[data-key-path="slug"]');
  if (section) {
    const parentObserver = new MutationObserver(() => {
      const currentValue = input.value;
      if (currentValue !== currentSlugValue) {
        log(`📝 Slug changed (via parent observer): "${currentValue}"`);
        currentSlugValue = currentValue;
      }
    });
    parentObserver.observe(section, {
      childList: true,
      subtree: true,
      characterData: true
    });
    log('👁️ Parent section observer started');
  }
  
  // Track via input event (typing)
  input.addEventListener('input', () => {
    currentSlugValue = input.value;
    log(`📊 Slug updated (typing): "${currentSlugValue}"`);
  });
  
  // Track via change event (blur/enter)
  input.addEventListener('change', () => {
    currentSlugValue = input.value;
    log(`📊 Slug updated (change): "${currentSlugValue}"`);
  });
  
  log('👁️ Real-time slug monitoring started');
  return true;
};

// Polling de backup a cada 500ms para garantir que temos o valor mais recente
const SLUG_POLL_INTERVAL_ID = setInterval(() => {
  const input = document.querySelector(CONFIG.SELECTOR);
  if (input && input.value !== currentSlugValue) {
    log(`🔄 Polling update: "${currentSlugValue}" → "${input.value}"`);
    currentSlugValue = input.value;
  }
}, 500);

/**
 * Log with prefix for debugging
 * @param {string} message - Message to log
 * @param {string} [level='log'] - Log level (log, warn, error)
 */
const log = (message, level = 'log') => {
  const prefix = '[Sveltia CMS Preload]';
  const fullMessage = `${prefix} ${message}`;
  
  if (level === 'error') {
    console.error(fullMessage);
  } else if (level === 'warn') {
    console.warn(fullMessage);
  } else {
    console.log(fullMessage);
  }
};

/**
 * Extract slug from Sveltia CMS DOM
 * @returns {string|null} The slug value or null if not found
 */
const extractSlug = () => {
  try {
    const input = document.querySelector(CONFIG.SELECTOR);
    
    if (!input) {
      return null;
    }
    
    const value = input.value?.trim();
    
    if (!value) {
      return null;
    }
    
    return value;
  } catch (error) {
    log(`Error extracting slug: ${error.message}`, 'error');
    return null;
  }
};

/**
 * Check if current page is an edit page
 * @returns {boolean}
 */
const isEditPage = () => {
  const hash = window.location.hash;
  const isEdit = CONFIG.EDIT_PAGE_PATTERN.test(hash);
  log(`Checking if edit page: ${hash} -> ${isEdit}`);
  return isEdit;
};

/**
 * Send IPC message with slug to main process
 * @param {string} channel - IPC channel name
 * @param {string} slug - Slug value
 * @returns {boolean} True if message was sent
 */
const sendSlugToMain = (channel, slug) => {
  try {
    if (!slug || typeof slug !== 'string' || slug.trim() === '') {
      log(`Invalid slug for ${channel}: "${slug}"`, 'warn');
      return false;
    }
    
    ipcRenderer.send(channel, slug.trim());
    log(`Sent IPC "${channel}" with slug: "${slug}"`);
    return true;
  } catch (error) {
    log(`Error sending ${channel}: ${error.message}`, 'error');
    return false;
  }
};

/**
 * Poll for slug with retry
 * @param {number} [attempt=1] - Current attempt number
 * @param {string} [triggerSource='unknown'] - Source that triggered the poll
 */
const pollForSlug = (attempt = 1, triggerSource = 'unknown') => {
  // Cancel any existing polling
  if (currentPollingTimeout) {
    clearTimeout(currentPollingTimeout);
    currentPollingTimeout = null;
  }
  
  log(`Polling for slug (attempt ${attempt}/${CONFIG.MAX_POLLING_ATTEMPTS}, trigger: ${triggerSource})`);
  
  // Check if still on edit page
  if (!isEditPage()) {
    log('No longer on edit page, stopping poll');
    return;
  }
  
  const slug = extractSlug();
  
  if (slug) {
    log(`Successfully extracted slug: "${slug}"`);
    
    // Store as initial slug on first load
    if (!initialSlug) {
      initialSlug = slug;
      slugChangeSent = false;
      log(`📌 Initial slug set: "${slug}"`);
    }
    
    // Start observing the slug field for changes
    observeSlugField();
    
    // Only send if slug changed
    if (slug !== lastExtractedSlug) {
      lastExtractedSlug = slug;
      sendSlugToMain('cms:page-loaded', slug);
    } else {
      log(`Slug unchanged: "${slug}", not sending IPC`);
    }
    return;
  }
  
  // Retry if not at max attempts
  if (attempt < CONFIG.MAX_POLLING_ATTEMPTS) {
    const delay = CONFIG.BASE_POLLING_INTERVAL * Math.min(attempt, 5); // Progressive delay
    log(`Slug not found, retrying in ${delay}ms (attempt ${attempt + 1})`);
    
    currentPollingTimeout = setTimeout(() => {
      pollForSlug(attempt + 1, triggerSource);
    }, delay);
  } else {
    log(`Failed to find slug after ${CONFIG.MAX_POLLING_ATTEMPTS} attempts`, 'warn');
  }
};

/**
 * Handle navigation to edit page
 */
const handleEditPageNavigation = () => {
  log('Edit page navigation detected');
  pollForSlug(1, 'hashchange');
  // Start observing after a short delay to ensure DOM is ready
  setTimeout(() => observeSlugField(), 1000);
};

// Listen for hash changes (SPA navigation)
window.addEventListener('hashchange', (event) => {
  const oldHash = new URL(event.oldURL).hash;
  const newHash = new URL(event.newURL).hash;
  const wasEditPage = CONFIG.EDIT_PAGE_PATTERN.test(oldHash);
  const isEditPageNow = CONFIG.EDIT_PAGE_PATTERN.test(newHash);
  
  log(`Hash changed: ${oldHash} -> ${newHash}`);
  log(`Was edit page: ${wasEditPage}, Is edit page now: ${isEditPageNow}`);
  
  // If leaving edit page and haven't sent slug change yet (for "default" config)
  if (wasEditPage && !isEditPageNow) {
    log('🚪 Leaving edit page, checking for slug change...');
    checkAndSendSlugChange('hashchange');
  }
  
  if (isEditPageNow) {
    // Reset when entering new edit page
    initialSlug = null;
    slugChangeSent = false;
    handleEditPageNavigation();
  } else {
    log('Not an edit page, clearing last slug');
    lastExtractedSlug = null;
  }
});

// On initial load, check if we're on an edit page
window.addEventListener('load', () => {
  log('Window loaded, checking initial state');
  
  if (isEditPage()) {
    log('Initial page is edit page, starting poll');
    pollForSlug(1, 'initial-load');
  }
});

// Register Sveltia CMS postSave event listener
let postSaveRegistered = false;

const initPostSaveListener = () => {
  if (postSaveRegistered) {
    return true; // Already registered
  }

  if (!window.CMS) {
    log('CMS object not available yet, will retry...', 'warn');
    return false;
  }

  try {
    window.CMS.registerEventListener({
      name: 'postSave',
      handler: ({ entry }) => {
        log('✅ postSave event received from Sveltia');
        // Use checkAndSendSlugChange for both configs (stay on page or redirect)
        checkAndSendSlugChange('postSave');
      }
    });
    postSaveRegistered = true;
    log('✅ postSave event listener registered successfully');
    return true;
  } catch (error) {
    log(`❌ Error registering postSave listener: ${error.message}`, 'error');
    return false;
  }
};

// Beforeunload - last resort backup (for when page is being unloaded)
window.addEventListener('beforeunload', () => {
  clearInterval(SLUG_POLL_INTERVAL_ID);
  if (!slugChangeSent && initialSlug && isEditPage()) {
    log('⚠️ Beforeunload triggered, checking slug change as last resort...');
    checkAndSendSlugChange('beforeunload');
  }
});

// Try to register postSave listener with retry mechanism
const tryRegisterPostSave = (attempt = 1) => {
  if (postSaveRegistered) {
    log('postSave listener already registered, skipping retry');
    return;
  }
  
  log(`Attempt ${attempt} to register postSave listener...`);
  const success = initPostSaveListener();
  
  if (!success && attempt < 20) {
    // Retry with increasing delay (1s, 2s, 3s... up to 5s max)
    const delay = Math.min(attempt * 1000, 5000);
    log(`Retrying postSave registration in ${delay}ms (attempt ${attempt + 1}/20)`);
    setTimeout(() => tryRegisterPostSave(attempt + 1), delay);
  } else if (!success) {
    log('❌ Failed to register postSave listener after 20 attempts', 'error');
  }
};

// Initialize postSave listener when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    log('DOMContentLoaded - starting postSave registration attempts');
    tryRegisterPostSave();
  });
} else {
  log('DOM already loaded - starting postSave registration attempts');
  tryRegisterPostSave();
}

// Expose minimal API to renderer for debugging
contextBridge.exposeInMainWorld('sveltiaBridge', {
  getSlug: () => extractSlug(),
  pollForSlug: () => pollForSlug(1, 'manual'),
  getLastSlug: () => lastExtractedSlug,
  isEditPage: () => isEditPage()
});

log('Preload script initialized');
