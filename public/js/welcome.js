// ============================================================
//  WELCOME SPLASH
//  Location: public/js/welcome.js
//
//  Behaviour:
//   1. On load, if the visitor has already seen the splash AND
//      already accepted the legal notice, redirect to
//      /marketplace.
//   2. The Continue button is disabled until the acceptance
//      checkbox is ticked. The button stays disabled if the
//      visitor tries to continue without ticking it.
//   3. When the visitor ticks the box and presses Continue:
//      - the acceptance is persisted client-side (localStorage
//        + sessionStorage + cookie) together with the version
//        and the timestamp,
//      - the server cookie is set via /api/welcome/ack,
//      - the visitor is navigated to /marketplace.
//   4. If JavaScript fails entirely, the <noscript> meta-refresh
//      inside welcome.html moves the visitor forward after 5
//      seconds.
//
//  Note on the acceptance:
//   This is the guest-level acceptance. It has no account yet, so
//   the record is stored client-side. When the visitor later
//   registers a customer or a business account, the register form
//   asks again and the server writes a row into
//   terms_acceptances with the timestamp, version, IP, and
//   user-agent. That is the durable proof.
// ============================================================

(function () {
  'use strict';

  var WELCOMED_KEY = 'bidhaalink_welcomed';
  var ACCEPT_KEY   = 'bidhaalink_terms_accepted';
  var VERSION      = '1.0';
  var DESTINATION  = '/marketplace';

  // ----------------------------------------------------------
  //  Storage helpers
  // ----------------------------------------------------------

  function safeGet(storage, key) {
    try { return storage.getItem(key); } catch (err) { return null; }
  }

  function safeSet(storage, key, value) {
    try { storage.setItem(key, value); } catch (err) { /* no-op */ }
  }

  function readCookie(name) {
    return document.cookie
      .split(';')
      .map(function (v) { return v.trim(); })
      .filter(function (v) { return v.indexOf(name + '=') === 0; })
      .map(function (v) { return decodeURIComponent(v.slice(name.length + 1)); })
      .shift() || null;
  }

  // ----------------------------------------------------------
  //  Acceptance predicate
  // ----------------------------------------------------------

  function alreadyWelcomed() {
    if (safeGet(localStorage, WELCOMED_KEY) === '1') return true;
    if (safeGet(sessionStorage, WELCOMED_KEY) === '1') return true;
    return false;
  }

  function alreadyAcceptedLegal() {
    var stored = safeGet(localStorage, ACCEPT_KEY);
    if (stored && stored.length > 0) {
      try {
        var parsed = JSON.parse(stored);
        if (parsed && parsed.version === VERSION) return true;
      } catch (err) { /* corrupt entry, treat as not accepted */ }
    }

    var cookie = readCookie('legal_notice_ack');
    if (cookie === '1') return true;

    return false;
  }

  // ----------------------------------------------------------
  //  Acceptance persistence
  // ----------------------------------------------------------

  function persistAcceptance() {
    var payload = {
      version: VERSION,
      accepted_at: new Date().toISOString(),
      source: 'welcome_splash'
    };
    var serialized = JSON.stringify(payload);

    safeSet(localStorage, ACCEPT_KEY, serialized);
    safeSet(sessionStorage, ACCEPT_KEY, serialized);

    // One year, SameSite=Lax, Secure when the page is HTTPS.
    var oneYear = 60 * 60 * 24 * 365;
    document.cookie =
      'legal_notice_ack=1; Max-Age=' + oneYear + '; Path=/; SameSite=Lax' +
      (window.location.protocol === 'https:' ? '; Secure' : '');
  }

  function persistWelcomed() {
    safeSet(localStorage, WELCOMED_KEY, '1');
    safeSet(sessionStorage, WELCOMED_KEY, '1');

    try {
      fetch('/api/welcome/ack', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true
      }).catch(function () { /* non-fatal */ });
    } catch (err) { /* fetch unavailable, non-fatal */ }
  }

  // ----------------------------------------------------------
  //  1. Skip if already welcomed
  // ----------------------------------------------------------

  if (alreadyWelcomed()) {
    window.location.replace(DESTINATION);
    return;
  }

  // ----------------------------------------------------------
  //  2. Boot once DOM is ready
  // ----------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    var checkbox = document.getElementById('welcomeLegalAccept');
    var continueBtn = document.getElementById('continueBtn');
    var status = document.getElementById('welcomeLegalStatus');

    if (!checkbox || !continueBtn) {
      // Non-splash use of this script; nothing to do.
      return;
    }

    // If the visitor already accepted on this browser in a
    // previous session, honour that: pre-tick the box and enable
    // the button immediately.
    if (alreadyAcceptedLegal()) {
      checkbox.checked = true;
      continueBtn.disabled = false;
    }

    function refreshButtonState() {
      if (checkbox.checked) {
        continueBtn.disabled = false;
        if (status) status.style.display = 'none';
      } else {
        continueBtn.disabled = true;
      }
    }

    checkbox.addEventListener('change', refreshButtonState);
    refreshButtonState();

    function continueToMarketplace() {
      if (!checkbox.checked) {
        if (status) {
          status.textContent =
            'Please tick the box above to accept the Terms and Conditions and the Privacy Policy before continuing.';
          status.style.display = 'block';
        }
        // Light shake to draw the eye.
        checkbox.focus();
        return;
      }

      persistAcceptance();
      persistWelcomed();
      window.location.href = DESTINATION;
    }

    continueBtn.addEventListener('click', continueToMarketplace);

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;

      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        // Space while focused on the checkbox already toggles it;
        // let the browser handle that.
        if (event.key === ' ' && document.activeElement === checkbox) return;
      }

      event.preventDefault();
      continueToMarketplace();
    });
  });
})();