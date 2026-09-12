// ============================================================
//  WELCOME SPLASH
//  Location: public/js/welcome.js
//
//  Behaviour:
//   1. On load, check sessionStorage for the "welcomed" flag.
//      - If already set, redirect straight to /index.html so a
//        refresh or a back-navigation does not replay the splash.
//      - Otherwise, keep the visitor on this page.
//   2. When the visitor clicks "Continue to Platform" (or presses
//      Enter/Space anywhere on the page):
//      - Set the flag in sessionStorage.
//      - Navigate to /index.html.
//   3. Reset the flag automatically when the browser session ends,
//      because sessionStorage is cleared when the tab is closed.
// ============================================================

(function () {
  'use strict';

  var WELCOMED_KEY = 'bidhaalink_welcomed';
  var DESTINATION  = '/index.html';

  // ----------------------------------------------------------
  //  1. Skip the splash if the visitor already saw it this session
  // ----------------------------------------------------------
  try {
    if (sessionStorage.getItem(WELCOMED_KEY) === '1') {
      window.location.replace(DESTINATION);
      return;
    }
  } catch (err) {
    // sessionStorage can be blocked (private mode, strict cookies).
    // In that case, we simply show the splash normally.
  }

  // ----------------------------------------------------------
  //  2. Wire the Continue button
  // ----------------------------------------------------------
  function continueToPlatform() {
    try {
      sessionStorage.setItem(WELCOMED_KEY, '1');
    } catch (err) {
      // Non-fatal — the visitor will just see the splash again next time.
    }
    window.location.href = DESTINATION;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('continueBtn');
    if (btn) {
      btn.addEventListener('click', continueToPlatform);
      // Autofocus so pressing Enter works immediately.
      try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); }
    }

    // Enter or Space anywhere on the page also continues.
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        // Do not hijack the spacebar if the user is typing into a field.
        var tag = (document.activeElement && document.activeElement.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        event.preventDefault();
        continueToPlatform();
      }
    });
  });
})();