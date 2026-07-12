'use strict';

/**
 * @fileoverview Alpine.js zoom controls component with HTML generator.
 * Provides zoom in/out/reset functionality (50-200%, 25% steps)
 * persisted to sessionStorage. Uses CSS transform: scale() on a
 * content wrapper to prevent scrollbar/displacement from body.zoom.
 * Falls back to document.body.style.zoom when no content wrapper found.
 * Also exposes createZoomControlsHTML() for injecting zoom UI into any page.
 * @author Documental Team
 * @since 1.0.0
 */

(function () {
  var MIN_ZOOM = 50;
  var MAX_ZOOM = 200;
  var ZOOM_STEP = 25;
  var DEFAULT_ZOOM = 100;

  document.addEventListener('alpine:init', function () {
    Alpine.data('zoomControls', function () {
      return {
        zoomLevel: DEFAULT_ZOOM,

        init: function () {
          this.initZoom();
        },

        initZoom: function () {
          var stored = sessionStorage.getItem('zoom-level');
          this.zoomLevel = stored ? parseInt(stored, 10) : DEFAULT_ZOOM;
          if (this.zoomLevel < MIN_ZOOM) this.zoomLevel = MIN_ZOOM;
          if (this.zoomLevel > MAX_ZOOM) this.zoomLevel = MAX_ZOOM;
          this.applyZoom();
        },

        zoomIn: function () {
          if (this.zoomLevel < MAX_ZOOM) {
            this.zoomLevel += ZOOM_STEP;
            this.applyZoom();
          }
        },

        zoomOut: function () {
          if (this.zoomLevel > MIN_ZOOM) {
            this.zoomLevel -= ZOOM_STEP;
            this.applyZoom();
          }
        },

        resetZoom: function () {
          this.zoomLevel = DEFAULT_ZOOM;
          this.applyZoom();
        },

        getZoomTarget: function () {
          return document.getElementById('zoom-content')
            || document.querySelector('.flex.flex-col.h-screen')
            || document.querySelector('main')
            || document.body;
        },

        applyZoom: function () {
          var scale = this.zoomLevel / 100;
          var target = this.getZoomTarget();
          if (target && target !== document.body) {
            target.style.transform = 'scale(' + scale + ')';
            target.style.transformOrigin = 'top center';
            target.style.width = (100 / scale * 100) + '%';
            target.style.maxWidth = 'none';
          } else {
            document.body.style.zoom = scale.toString();
          }
          sessionStorage.setItem('zoom-level', this.zoomLevel.toString());
        },

        get zoomLevelPercent() {
          return this.zoomLevel + '%';
        }
      };
    });
  });

  /**
   * Returns an HTML string for the zoom controls UI.
   * Alpine directives work when placed inside an x-data="zoomControls" scope.
   * @returns {string} The zoom controls HTML.
   */
  function createZoomControlsHTML() {
    return '<div id="zoom-controls" class="inline-flex items-center gap-1 theme-picker-group" style="padding:0.25rem;border-radius:0.5rem;background:var(--color-surface-dark);border:1px solid var(--color-border-subtle)">'
      + '<button id="zoom-out" @click="zoomOut()" :disabled="zoomLevel <= 50" class="theme-btn" aria-label="Zoom out" style="opacity:0.5" :style="zoomLevel <= 50 ? \'opacity:0.5;cursor:not-allowed\' : \'\'">'
      + '<span class="material-symbols-outlined">zoom_out</span>'
      + '</button>'
      + '<button id="zoom-reset" @click="resetZoom()" class="theme-btn" aria-label="Reset zoom">'
      + '<span class="material-symbols-outlined">zoom_out_map</span>'
      + '</button>'
      + '<span id="zoom-level" x-text="zoomLevel + \'%\'" class="theme-btn" style="font-size:0.7rem;min-width:2.5rem;text-align:center">100%</span>'
      + '<button id="zoom-in" @click="zoomIn()" :disabled="zoomLevel >= 200" class="theme-btn" aria-label="Zoom in" :style="zoomLevel >= 200 ? \'opacity:0.5;cursor:not-allowed\' : \'\'">'
      + '<span class="material-symbols-outlined">zoom_in</span>'
      + '</button>'
      + '</div>';
  }

  /**
   * Injects zoom controls into the page by appending them before the first
   * .theme-picker-group element inside .theme-picker.
   * @param {Element} container Optional container element. Defaults to document.
   */
  function injectZoomControls(container) {
    container = container || document;
    var picker = container.querySelector('.theme-picker');
    if (!picker) return;
    var group = picker.querySelector('.theme-picker-group');
    if (group) {
      group.insertAdjacentHTML('beforebegin', createZoomControlsHTML());
    } else {
      picker.insertAdjacentHTML('beforeend', createZoomControlsHTML());
    }
  }

  window.createZoomControlsHTML = createZoomControlsHTML;
  window.injectZoomControls = injectZoomControls;
})();
