'use strict';

/**
 * @fileoverview Shared footer component for renderer pages.
 * @author Documental Team
 * @since 1.0.0
 *
 * Generates the app footer bar. Supports two modes:
 *  - 3-zone mode ({ left, center, right }): info | main buttons | progress
 *  - Legacy mode ({ content, buttons }): right-aligned content (justify-end)
 *
 * Pattern extracted from new.html, open.html, create.html:
 *   p-4 border-t border-border-subtle bg-surface-dark mt-auto
 */

/**
 * Renders a footer button.
 * @param {{label: string, class?: string, id?: string, attributes?: string}} btn
 * @returns {string} Button HTML
 */
function renderFooterButton(btn) {
  const classes = btn.class || 'btn-secondary';
  const id = btn.id ? ` id="${btn.id}"` : '';
  const attrs = btn.attributes || '';
  return `<button${id} class="${classes} px-5 py-2 font-semibold"${attrs}>${btn.label}</button>`;
}

/**
 * Renders a page footer bar.
 *
 * 3-zone mode (preferred): pass { left, center, right }.
 *   - left:   info HTML (justify-start, flex-1)
 *   - center: main buttons — array of button objects OR raw HTML (justify-center)
 *   - right:  progress HTML (justify-end, flex-1)
 *
 * Legacy mode: pass { content, buttons } for right-aligned layout.
 *
 * @param {Object} opts
 * @param {string} [opts.left=''] - Left zone HTML (info). Enables 3-zone mode.
 * @param {string|Array<{label: string, class?: string, id?: string, attributes?: string}>} [opts.center=null]
 *   Center zone: button array or HTML string. Enables 3-zone mode.
 * @param {string} [opts.right=''] - Right zone HTML (progress). Enables 3-zone mode.
 * @param {string} [opts.content=''] - Arbitrary footer content HTML (legacy)
 * @param {Array<{label: string, class?: string, id?: string, attributes?: string}>} [opts.buttons=[]]
 *   Action buttons (legacy, right-aligned)
 * @param {string} [opts.maxWidth='max-w-4xl'] - Max-width class for inner container
 * @returns {string} Footer HTML string
 */
function renderFooter({
  left = '',
  center = null,
  right = '',
  content = '',
  buttons = [],
  maxWidth = 'max-w-4xl',
} = {}) {
  const maxWClass = maxWidth ? ` ${maxWidth}` : '';

  // 3-zone mode: any of left/center/right provided
  if (left || center !== null || right) {
    const centerHtml = Array.isArray(center)
      ? center.map(renderFooterButton).join('\n')
      : center || '';

    return [
      '<div class="p-4 border-t border-border-subtle bg-surface-dark mt-auto">',
      `    <div class="flex items-center justify-between gap-4${maxWClass} mx-auto">`,
      `        <div class="flex-1 flex justify-start gap-2">${left}</div>`,
      `        <div class="flex justify-center gap-3">${centerHtml}</div>`,
      `        <div class="flex-1 flex justify-end gap-2">${right}</div>`,
      '    </div>',
      '</div>',
    ].join('\n');
  }

  // Legacy mode: right-aligned content/buttons
  const alignClass = buttons.length > 0 || content
    ? 'flex justify-end gap-4'
    : '';

  let buttonsHtml = '';
  if (buttons.length > 0) {
    buttonsHtml = buttons.map((btn) => {
      const classes = btn.class || 'btn-secondary';
      const id = btn.id ? ` id="${btn.id}"` : '';
      const attrs = btn.attributes || '';
      return `            <button${id} class="${classes} px-5 py-2 font-semibold"${attrs}>${btn.label}</button>`;
    }).join('\n');
  }

  const innerContent = [content, buttonsHtml].filter(Boolean).join('\n');

  return [
    '<div class="p-4 border-t border-border-subtle bg-surface-dark mt-auto">',
    `    <div class="${alignClass}${maxWClass}">`,
    innerContent,
    '    </div>',
    '</div>',
  ].join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderFooter };
}
if (typeof window !== 'undefined') {
  window.Documental = window.Documental || {};
  window.Documental.renderFooter = renderFooter;
}
