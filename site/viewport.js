/*
 * Keeps the controls clear of the browser's own bars on phones.
 *
 * iPhone Safari draws its address/tab bar over the bottom of the page, on top of any buttons placed
 * there, and swallows taps near it. So on iPhone browsers (not an installed home-screen app) the
 * page reserves extra space below the buttons (the CSS variable --bar-gap, used by style.css). That
 * space shrinks the playfield rather than covering the controls.
 *
 * The app's height also follows the visible area as measured by the browser (--app-h), which
 * changes as the bar slides in and out, instead of relying on 100vh/100dvh alone.
 *
 * Loads in the browser (installs itself) and in Node via require() for the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PentoViewport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** iPhone (or iPod) in a browser tab: the cases where the browser's bottom bar can cover the page. */
  function needsBarGap(userAgent, standalone) {
    return /iPhone|iPod/.test(String(userAgent || '')) && !standalone;
  }

  /** The height to lay out in: the visible viewport, unless the page is pinch-zoomed. */
  function visibleHeight(win, last) {
    const vv = win.visualViewport;
    if (vv && vv.scale && vv.scale > 1.01) return last || win.innerHeight; // zoomed in: don't re-layout
    return Math.round((vv && vv.height) || win.innerHeight);
  }

  function install(win, doc) {
    const el = doc.documentElement;
    const nav = win.navigator || {};
    if (needsBarGap(nav.userAgent, nav.standalone)) el.classList.add('ios-browser');
    let last = 0;
    const update = () => {
      last = visibleHeight(win, last);
      el.style.setProperty('--app-h', last + 'px');
    };
    update();
    win.addEventListener('resize', update);
    win.addEventListener('orientationchange', () => setTimeout(update, 250));
    if (win.visualViewport) {
      win.visualViewport.addEventListener('resize', update);
      win.visualViewport.addEventListener('scroll', update);
    }
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    try {
      install(window, document);
    } catch (e) {
      /* the CSS falls back to 100dvh */
    }
  }

  return { needsBarGap, visibleHeight, install };
});
