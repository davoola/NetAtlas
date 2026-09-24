/**
 * NetAtlas theme-toggle.js
 * Load synchronously in <head> AFTER the inline FOUC bootstrap, or at end of body.
 * Storage key: "theme" = "light" | "dark"
 */
(function (w, d) {
  'use strict';
  var KEY = 'theme';
  var LEGACY = 'netatlas-theme';

  function read() {
    try {
      var t = localStorage.getItem(KEY) || localStorage.getItem(LEGACY);
      if (t === 'dark' || t === 'light') return t;
    } catch (e) {}
    try {
      return w.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e2) {
      return 'light';
    }
  }

  function apply(theme, animate) {
    var t = theme === 'dark' ? 'dark' : 'light';
    var root = d.documentElement;
    if (animate) {
      root.classList.add('theme-animating');
      w.setTimeout(function () { root.classList.remove('theme-animating'); }, 220);
    }
    root.setAttribute('data-theme', t);
    root.style.colorScheme = t;
    try {
      localStorage.setItem(KEY, t);
      localStorage.setItem(LEGACY, t);
    } catch (e) {}
    return t;
  }

  function current() {
    var a = d.documentElement.getAttribute('data-theme');
    return (a === 'dark' || a === 'light') ? a : read();
  }

  function toggle() {
    return apply(current() === 'dark' ? 'light' : 'dark', true);
  }

  function bind() {
    var nodes = d.querySelectorAll('[data-theme-toggle], #themeToggle, #loginThemeToggle');
    for (var i = 0; i < nodes.length; i++) {
      (function (btn) {
        if (btn.__themeBound) return;
        btn.__themeBound = true;
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          toggle();
        });
      })(nodes[i]);
    }
  }

  // Expose API
  w.NetAtlasTheme = {
    apply: function (t) { return apply(t, false); },
    toggle: toggle,
    current: current,
    bind: bind
  };

  // Ensure applied (idempotent with FOUC script)
  apply(read(), false);

  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})(window, document);
