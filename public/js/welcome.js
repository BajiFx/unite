// ============================================================
//  WELCOME SPLASH
//  Location: public/js/welcome.js
//
//  Behaviour:
//   1. On load, check localStorage, sessionStorage, and the
//      server cookie for the "welcomed" flag.
//      - If any of them says the visitor has already seen the
//        splash, redirect straight to /marketplace.
//      - Otherwise, keep the visitor on this page.
//   2. When the visitor clicks "Continue to Marketplace" (or
//      presses Enter/Space anywhere on the page):
//      - Set the flag in localStorage and sessionStorage.
//      - Ask the server to set a cookie so the splash is
//        skipped on this browser for a full year.
//      - Navigate to /marketplace.
//   3. If JavaScript fails entirely, the <noscript> meta-refresh
//      inside welcome.html moves the visitor forward after 5
//      seconds.
//
//  Why three storage layers?
//   - localStorage   → primary, survives across tabs and sessions.
//   - sessionStorage → fallback when localStorage is blocked.
//   - cookie         → server-side, so a returning visitor is
//                       redirected on the very first request,
//                       before any HTML is sent.
//
//  Why /marketplace instead of /index.html?
//   The server serves the splash at '/'. Redirecting to '/'
//   after acknowledging the splash would re-serve the splash,
//   which is the loop this file previously caused. A dedicated
//   '/marketplace' route is unambiguous and cannot loop.
// ============================================================

(function () {
  'use strict';

  var WELCOMED_KEY = 'bidhaalink_welcomed';
  var DESTINATION  = '/marketplace';

  // ----------------------------------------------------------
  //  Helper — has the visitor already seen the splash?
  //  Check localStorage first, then sessionStorage. The server
  //  cookie is checked by the server itself before it serves
  //  welcome.html, so if this file runs at all, the cookie was
  //  absent at request time.
  // ----------------------------------------------------------
  function alreadyWelcomed() {
    try {
      if (localStorage.getItem(WELCOMED_KEY) === '1') return true;
    } catch (err) {
      // localStorage can be blocked (private mode, strict cookies).
      // Fall through to sessionStorage.
    }

    try {
      if (sessionStorage.getItem(WELCOMED_KEY) === '1') return true;
    } catch (err) {
      // sessionStorage can also be blocked. Fall through.
    }

    return false;
  }

  // ----------------------------------------------------------
  //  Helper — persist the "welcomed" flag as best we can.
  //  Writes to both localStorage and sessionStorage, then asks
  //  the server to set the long-lived cookie. The server call is
  //  fire-and-forget: we never block navigation on it.
  // ----------------------------------------------------------
  function persistWelcomed() {
    try { localStorage.setItem(WELCOMED_KEY, '1'); } catch (err) { /* no-op */ }
    try { sessionStorage.setItem(WELCOMED_KEY, '1'); } catch (err) { /* no-op */ }

    try {
      fetch('/api/welcome/ack', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true
      }).catch(function () {
        // Non-fatal. The client-side flags already do their job.
      });
    } catch (err) {
      // fetch unavailable — non-fatal.
    }
  }

  // ----------------------------------------------------------
  //  1. Skip the splash if the visitor already saw it
  // ----------------------------------------------------------
  if (alreadyWelcomed()) {
    window.location.replace(DESTINATION);
    return;
  }

  // ----------------------------------------------------------
  //  2. Wire the Continue button and Enter/Space handler
  // ----------------------------------------------------------
  function continueToMarketplace() {
    persistWelcomed();
    window.location.href = DESTINATION;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('continueBtn');
    if (btn) {
      btn.addEventListener('click', continueToMarketplace);
      // Autofocus so pressing Enter works immediately.
      try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); }
    }

    // Enter or Space anywhere on the page also continues.
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;

      // Do not hijack the spacebar if the user is typing into a field.
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      event.preventDefault();
      continueToMarketplace();
    });
  });
})();