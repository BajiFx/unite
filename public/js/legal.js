// ============================================================
//  LEGAL PAGES SCRIPT
//  Location: public/js/legal.js
//
//  Loaded by /terms.html and /privacy.html only.
//  Also safe to load on other pages if you later decide to add the
//  cookie banner to the whole site.
//
//  Responsibilities:
//   1. Highlight the current section in the table of contents
//      as the reader scrolls.
//   2. Show a "back to top" button after the reader has scrolled
//      past the hero.
//   3. Add an active target highlight when the reader jumps to a
//      section by anchor link, so they can see where they landed.
//   4. Show the cookie notice banner once per browser, on any
//      page that loads this script.
// ============================================================

(function () {
  'use strict';

  const COOKIE_ACK_KEY = 'bidhaalink_legal_notice_ack';

  // ============================================================
  //  1. TOC HIGHLIGHT
  // ============================================================

  function initTocHighlight() {
    const tocLinks = Array.from(document.querySelectorAll('.legal-toc-list a[href^="#"]'));
    const sections = tocLinks
      .map(link => document.getElementById(link.getAttribute('href').slice(1)))
      .filter(Boolean);

    if (sections.length === 0 || typeof IntersectionObserver !== 'function') return;

    const linkBySectionId = new Map();
    tocLinks.forEach(link => {
      linkBySectionId.set(link.getAttribute('href').slice(1), link);
    });

    const visible = new Map();

    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const id = entry.target.id;
        if (entry.isIntersecting) {
          visible.set(id, entry.intersectionRatio);
        } else {
          visible.delete(id);
        }
      });

      let bestId = null;
      let bestRatio = -1;
      visible.forEach((ratio, id) => {
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestId = id;
        }
      });

      tocLinks.forEach(link => link.classList.remove('is-current'));
      if (bestId && linkBySectionId.has(bestId)) {
        linkBySectionId.get(bestId).classList.add('is-current');
      }
    }, {
      rootMargin: '-84px 0px -60% 0px',
      threshold: [0, 0.15, 0.35, 0.6, 0.9]
    });

    sections.forEach(section => observer.observe(section));
  }

  // ============================================================
  //  2. BACK TO TOP
  // ============================================================

  function initBackToTop() {
    const button = document.getElementById('legalBackToTop');
    if (!button) return;

    let ticking = false;

    const update = () => {
      ticking = false;
      const y = window.scrollY || document.documentElement.scrollTop;
      button.classList.toggle('is-visible', y > 400);
    };

    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }, { passive: true });

    button.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    update();
  }

  // ============================================================
  //  3. ANCHOR LANDING HIGHLIGHT
  // ============================================================

  function initAnchorHighlight() {
    if (!window.location.hash) return;

    const id = window.location.hash.slice(1);
    const target = document.getElementById(id);
    if (!target) return;

    // Give the browser a moment to scroll to the anchor first.
    setTimeout(() => {
      target.style.transition = 'background-color 0.6s ease';
      const previous = target.style.backgroundColor;
      target.style.backgroundColor = '#eff6ff';
      setTimeout(() => {
        target.style.backgroundColor = previous || '';
      }, 1800);
    }, 250);
  }

  // ============================================================
  //  4. COOKIE BANNER
  //
  //  Shown once per browser. The reader sees it on the first page
  //  that loads this script. Clicking "Accept" sets a cookie and a
  //  localStorage flag so the banner is not shown again.
  // ============================================================

  function hasAcknowledgedNotice() {
    try {
      if (localStorage.getItem(COOKIE_ACK_KEY) === '1') return true;
    } catch (err) { /* storage can be blocked */ }

    return document.cookie
      .split(';')
      .map(v => v.trim())
      .some(v => v.startsWith('legal_notice_ack='));
  }

  function persistAcknowledgedNotice() {
    try { localStorage.setItem(COOKIE_ACK_KEY, '1'); } catch (err) { /* no-op */ }

    // One year.
    const oneYearSeconds = 60 * 60 * 24 * 365;
    document.cookie =
      'legal_notice_ack=1; Max-Age=' + oneYearSeconds + '; Path=/; SameSite=Lax' +
      (window.location.protocol === 'https:' ? '; Secure' : '');
  }

  function initCookieBanner() {
    if (hasAcknowledgedNotice()) return;

    const banner = document.createElement('div');
    banner.className = 'legal-cookie-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie and legal notice');

    banner.innerHTML = [
      '<p>',
      'We use a small number of strictly necessary cookies to keep you logged in, ',
      'to protect against CSRF, and to remember that you have dismissed the welcome splash. ',
      'We do not use advertising or tracking cookies. ',
      'Read the <a href="/privacy.html#cookies">Cookie Notice</a> in the Privacy Policy, and the ',
      '<a href="/terms.html#payments">Terms and Conditions</a>.',
      '</p>',
      '<button type="button" id="legalCookieAccept">Accept</button>'
    ].join('');

    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('is-visible'));

    const accept = banner.querySelector('#legalCookieAccept');
    if (accept) {
      accept.addEventListener('click', () => {
        persistAcknowledgedNotice();
        banner.classList.remove('is-visible');
        setTimeout(() => banner.remove(), 250);
      });
    }
  }

  // ============================================================
  //  BOOT
  // ============================================================

  document.addEventListener('DOMContentLoaded', () => {
    initTocHighlight();
    initBackToTop();
    initAnchorHighlight();
    initCookieBanner();
  });
})();