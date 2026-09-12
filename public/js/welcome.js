// ============================================================
//  WELCOME SPLASH
//  Location: public/js/welcome.js
//
//  Behaviour:
//   1. On load, check localStorage for the "welcomed" flag.
//      - If already set, redirect straight to / so a refresh
//        or a back-navigation does not replay the splash.
//      - Otherwise, keep the visitor on this page.
//   2. When the visitor clicks "Continue to Platform" (or presses
//      Enter/Space anywhere on the page):
//      - Set the flag in localStorage.
//      - Navigate to /.
//   3. localStorage is used instead of sessionStorage so the
//      welcome screen shows once per browser, not once per tab.
// ============================================================

(function () {
  'use strict';

  var WELCOMED_KEY = 'bidhaalink_welcomed';
  var DESTINATION  = '/';

  // ----------------------------------------------------------
  //  1. Skip the splash if the visitor already saw it
  // ----------------------------------------------------------
  try {
    if (localStorage.getItem(WELCOMED_KEY) === '1') {
      window.location.replace(DESTINATION);
      return;
    }
  } catch (err) {
    // localStorage can be blocked (private mode, strict cookies,
    // tracking prevention). In that case, we simply show the
    // splash normally.
  }

  // ----------------------------------------------------------
  //  2. Wire the Continue button
  // ----------------------------------------------------------
  function continueToPlatform() {
    try {
      localStorage.setItem(WELCOMED_KEY, '1');
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