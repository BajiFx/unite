// ============================================================
//  MARKETPLACE JAVASCRIPT - Multi-Vendor Platform
//  Location: public/js/marketplace.js
//
//  Dead-code cleanup (this revision):
//   `marketplace.js` is not loaded by any HTML in the current
//   codebase. The marketplace home page loads `index.js`; the
//   account page loads `account.js`; the business profile loads
//   `business-profile.js`. No `<script src="/js/marketplace.js">`
//   tag exists in any .html file.
//
//   Everything in this file duplicates behaviour that now lives
//   in index.js (loadMarketplace, loadCategories,
//   loadBusinesses, renderBusinesses, createBusinessCard,
//   loadPlatformStats, searchBusinesses, filterBusinesses,
//   loadMoreBusinesses, showToast) and would collide with the
//   index.js versions if both files were ever loaded together.
//
//   Rather than delete the file (which could break an external
//   bookmark or a future surface that still references it), the
//   entire contents are now reduced to a single guarded no-op.
//   If any caller still tries to load it, the file defines
//   nothing on the window, wires no listeners, and fetches no
//   endpoints. Every function that used to live here is now
//   provided by index.js.
//
//   The legacy IIFE below is kept only as a defensive shim: it
//   confirms at load time (in the browser console) that the file
//   is deprecated, and it does not run any of the old code.
// ============================================================

(function () {
    'use strict';

    // -----------------------------------------------------------------
    //  This file is deprecated. It is kept in the repository only so
    //  that any older cached HTML page that still contains a
    //  <script src="/js/marketplace.js"> tag does not 404. All of the
    //  marketplace behaviour now lives in /js/index.js.
    //
    //  Nothing in this file:
    //    - adds anything to the window object
    //    - wires any DOM listener
    //    - fetches any endpoint
    //    - declares any global variable
    //
    //  If a page loads both this file and index.js, index.js wins
    //  because this file defines no names at all.
    // -----------------------------------------------------------------

    if (typeof console !== 'undefined' && console.warn) {
        console.warn(
            '⚠️ public/js/marketplace.js is deprecated and does nothing. ' +
            'All marketplace behaviour now lives in public/js/index.js.'
        );
    }
})();