/**
 * @fileoverview E2E spec for the "Fechar Ambiente" ghost-BrowserView bug
 * (plan: fechar-ambiente-ghost-browserviews, Task 3 — TDD RED phase).
 *
 * Reproduces the EXACT user flow against the REAL Electron app (main.js +
 * real IPC + real BrowserViews) via Playwright's _electron:
 *
 * AC8 [GREEN post-fix]: main.html with an open project → menu → "Fechar
 *   Ambiente" → confirm → index.html → click the "Criar novo" card
 *   ([data-navigate="repo-select.html"]) → the click reaches the page and
 *   repo-select.html loads. Pre-fix, the ghost BrowserView re-attached
 *   during the navigate race swallowed the click so the URL never changed;
 *   GREEN after the 3-layer fix.
 *
 * AC9 [GREEN]: the normal overlay cycle (menu → Help modal → close)
 *   leaves the header tab buttons fully clickable — regression guard so the
 *   fix cannot break the legitimate overlay path.
 *
 * Runner: `npx playwright test` (NEVER vitest — tests/e2e/** is excluded in
 * vitest.config.mjs). Launch: real `electron main.js --no-sandbox`, matching
 * the `start` script; the app's userData is isolated via XDG_CONFIG_HOME
 * with a pre-seeded `.first-time` marker (app.setName('Documental') in
 * main.js:20 → userData = $XDG_CONFIG_HOME/Documental) so the app boots
 * straight to index.html as a returning user.
 *
 * Selectors are locale-agnostic (attribute-based on x-text keys); pt-BR is
 * still forced via localStorage appLocale to mirror the user's environment
 * ("Fechar Ambiente" / "Ajuda").
 * @author Documental Team
 * @since 1.0.0
 */

const { test, expect, _electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_JS = path.join(REPO_ROOT, 'main.js');
const EVIDENCE_DIR = path.join(REPO_ROOT, '.omo', 'evidence');

/**
 * Launches the real app with an isolated userData (returning user, so the
 * first window loads renderer/index.html directly).
 * @returns {Promise<{electronApp: import('playwright').ElectronApplication, window: import('playwright').Page, tmpHome: string}>}
 */
async function launchApp() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'documental-e2e-'));
  // app.setName('Documental') → app.getPath('userData') = $XDG_CONFIG_HOME/Documental
  const userData = path.join(tmpHome, 'Documental');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, '.first-time'), 'completed');

  const electronApp = await _electron.launch({
    args: [MAIN_JS, '--no-sandbox'], // same flags as the `start` script
    env: { ...process.env, XDG_CONFIG_HOME: tmpHome },
    timeout: 30000
  });

  const window = await electronApp.firstWindow();
  // The renderer surfaces failures via native alert() (e.g. script.js
  // navigate-failed catch-all, main.html's onNavFailed) — native dialogs
  // are MODAL in Electron and would freeze every page interaction. The
  // E2E drives the UI, not the dialogs: auto-dismiss them all.
  window.on('dialog', (dialog) => { dialog.dismiss().catch(() => {}); });

  await window.waitForLoadState('domcontentloaded');
  return { electronApp, window, tmpHome };
}

/** Graceful quit, escalating to SIGKILL — app close can hang on the
 *  exit-confirmation beforeunload guard. */
async function quitApp(electronApp) {
  const killed = new Promise((resolve) => {
    const proc = electronApp.process();
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} resolve(); }, 5000);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  try { await electronApp.close(); } catch (_) { /* fallback below */ }
  await killed;
}

/**
 * Drives the window to main.html with an "open project" context — the exact
 * pre-condition of the user bug (BrowserViews exist for the window).
 */
async function openEditorWithContext(window) {
  await window.waitForURL(/index\.html/, { timeout: 20000 });
  await window.evaluate(() => {
    // Mirror the user's pt-BR environment (menu reads "Fechar Ambiente").
    localStorage.setItem('appLocale', 'pt-BR');
    // main.html's init early-returns ("No devServerUrl found") BEFORE it
    // registers the $watch('isAnyOverlayOpen') race trigger (:1356) and the
    // 12s loading fallback (:1403) unless a devServerUrl is present — a
    // seeded URL keeps init on its full path: BrowserViews get created for
    // the window (the ghost precondition) exactly like a real session.
    sessionStorage.setItem('currentProjectId', '1');
    sessionStorage.setItem('devServerUrl', 'http://127.0.0.1:4321/');
    window.electronAPI.navigateTo('main.html');
  });
  await window.waitForURL(/main\.html/, { timeout: 20000 });
  await window.waitForLoadState('domcontentloaded');
  // Alpine must be up: the header menu button (main.html:1866) is the gate
  // to the "Fechar Ambiente" item (main.html:2073).
  const menuButton = window.locator('header button:has(span.material-icons:text-is("menu"))');
  await expect(menuButton).toBeVisible({ timeout: 15000 });
  // main.html's init blocks on project/dev-server setup for the seeded
  // project id, but its own 12s fallback timeout (main.html:1403-1410,
  // "⏰ Loading timeout - forcing loading to complete") force-clears
  // initialLoading — after that the z-30 loading overlay stops intercepting
  // pointer events and the header/menu become clickable.
  const loadingOverlay = window.locator('div[x-show="initialLoading || clearingCache"]');
  await expect(loadingOverlay).toBeHidden({ timeout: 25000 });
  return menuButton;
}

test.describe('Fechar Ambiente — ghost BrowserViews (plan: fechar-ambiente-ghost-browserviews)', () => {
  test('AC8 fluxo exato do usuário: fechar ambiente → clique no card de index.html chega à página (não engolido pelo fantasma)', async () => {
    test.setTimeout(120000);
    const { electronApp, window } = await launchApp();
    try {
      await openEditorWithContext(window);

      // (2) open the header dropdown menu
      const menuButton = window.locator('header button:has(span.material-icons:text-is("menu"))');
      await menuButton.click();

      // (3) menu item "Fechar Ambiente" (x-text main.menu_close_project;
      //     pt-BR renders "Fechar Ambiente" — main.html:2072-2077)
      const closeItem = window.locator('div[x-show="menuOpen"] a:has(span[x-text="__t(\'main.menu_close_project\')"])');
      await expect(closeItem).toBeVisible({ timeout: 5000 });
      await closeItem.click();

      // (4) confirmation modal (x-show closeProjectModalOpen) → orange confirm
      //     button calls confirmCloseProject() (main.html:2469-2478)
      const confirmButton = window.locator(
        'div[x-show="closeProjectModalOpen"] button[x-text="__t(\'main.close_project_confirm\')"]'
      );
      await expect(confirmButton).toBeVisible({ timeout: 5000 });
      await confirmButton.click();

      // (5) same-window navigation back to the environment selection screen
      await window.waitForURL(/index\.html/, { timeout: 20000 });

      // Instrument the "Criar novo" card (index.html:133) so a swallowed
      // click is distinguishable from a navigation failure. The proof flag
      // MUST live in sessionStorage, not window state: a SUCCESSFUL click
      // navigates this same tab to repo-select.html, destroying the document
      // where a window flag lives — a post-click evaluate then reads the
      // fresh page (flag undefined) and fails even though the click worked.
      // sessionStorage is same-origin and survives the same-tab navigation,
      // keeping the click-time flag readable after landing on repo-select.
      await window.evaluate(() => {
        sessionStorage.removeItem('__cardClicked');
        const card = document.querySelector('[data-navigate="repo-select.html"]');
        card.addEventListener('click', () => { sessionStorage.setItem('__cardClicked', '1'); });
      });
      const card = window.locator('[data-navigate="repo-select.html"]');
      await expect(card).toBeVisible({ timeout: 5000 });

      // (6)+(7) click the card with a short timeout. With the ghost
      // BrowserView bug (pre-fix), the view re-attached by the visibility
      // race during navigate covers everything below the 64px header and
      // swallows the input: the page never sees the click, the flag is never
      // set and repo-select.html never loads. Post-fix both proofs hold:
      // the click reaches the page AND the navigation completes.
      await card.click({ timeout: 5000 });
      await window.waitForURL(/repo-select\.html/, { timeout: 5000 });
      const cardClicked = await window.evaluate(() => sessionStorage.getItem('__cardClicked') === '1');
      expect(cardClicked, 'card click reached the index.html page (not swallowed by ghost BrowserView)').toBe(true);
    } finally {
      await quitApp(electronApp);
    }
  });

  test('AC9 overlay normal intacto: menu → Ajuda → fechar; tabs do header continuam clicáveis', async () => {
    test.setTimeout(120000);
    const { electronApp, window } = await launchApp();
    try {
      await openEditorWithContext(window);

      // open menu → Help modal (main.html:2087 helpModalOpen trigger)
      await window.locator('header button:has(span.material-icons:text-is("menu"))').click();
      const helpItem = window.locator('div[x-show="menuOpen"] a:has(span[x-text="__t(\'main.menu_help\')"])');
      await expect(helpItem).toBeVisible({ timeout: 5000 });
      await helpItem.click();

      const helpModal = window.locator('div[x-show="helpModalOpen"]');
      await expect(helpModal).toBeVisible({ timeout: 5000 });

      // close it via the "Entendido" button (main.html:2439)
      await window.locator('div[x-show="helpModalOpen"] button[x-text="__t(\'common.understand\')"]').click();
      await expect(helpModal).toBeHidden({ timeout: 5000 });

      // header tab buttons (main.html:1821-1828) must remain fully clickable:
      // switch to "view" tab → ring-2 active state appears on it…
      const viewTab = window.locator('header button:has(span.material-icons:text-is("visibility"))');
      const editorTab = window.locator('header button:has(span.material-icons:text-is("edit"))');
      await viewTab.click({ timeout: 5000 });
      await expect(viewTab).toHaveClass(/ring-2/, { timeout: 5000 });
      await expect(editorTab).not.toHaveClass(/ring-2/, { timeout: 5000 });

      // …and back to "editor"
      await editorTab.click({ timeout: 5000 });
      await expect(editorTab).toHaveClass(/ring-2/, { timeout: 5000 });
      await expect(viewTab).not.toHaveClass(/ring-2/, { timeout: 5000 });
    } finally {
      await quitApp(electronApp);
    }
  });
});
