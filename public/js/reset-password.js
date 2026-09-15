// ============================================================
//  RESET PASSWORD JAVASCRIPT
// ============================================================

const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get('token');

if (token) {
    document.getElementById('step1').style.display = 'none';
    document.getElementById('step2').style.display = 'block';
    document.getElementById('pageSub').textContent = 'Enter your new password.';
}

async function requestReset() {
    const email = document.getElementById('resetEmail').value.trim();
    const status = document.getElementById('status');
    if (!email) {
        status.className = 'status error';
        status.textContent = '❌ Please enter your email address.';
        return;
    }

    status.className = 'status';
    status.textContent = '⏳ Sending reset link...';

    try {
        const res = await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (data.success) {
            status.className = 'status success';
            status.textContent = '✅ If your email is registered, you will receive a reset link.';
            document.getElementById('resetEmail').value = '';
        } else {
            status.className = 'status error';
            status.textContent = '❌ ' + (data.error || 'Something went wrong.');
        }
    } catch (err) {
        status.className = 'status error';
        status.textContent = '❌ Network error. Please try again.';
    }
}

async function resetPassword() {
    const password = document.getElementById('newPassword').value;
    const confirm = document.getElementById('confirmPassword').value;
    const status = document.getElementById('status');

    if (!password || password.length < 6) {
        status.className = 'status error';
        status.textContent = '❌ Password must be at least 6 characters.';
        return;
    }
    if (password !== confirm) {
        status.className = 'status error';
        status.textContent = '❌ Passwords do not match.';
        return;
    }

    status.className = 'status';
    status.textContent = '⏳ Resetting password...';

    try {
        const res = await fetch('/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, password })
        });
        const data = await res.json();
        if (data.success) {
            status.className = 'status success';
            status.textContent = '✅ ' + data.message + ' Redirecting...';
            setTimeout(() => {
                window.location.href = '/';
            }, 2000);
        } else {
            status.className = 'status error';
            status.textContent = '❌ ' + (data.error || 'Reset failed.');
        }
    } catch (err) {
        status.className = 'status error';
        status.textContent = '❌ Network error. Please try again.';
    }
}

// ============================================================
//  FORCE THE PINNED FOOTER
//  Overrides any old inline footer stylesheet on this page so
//  the footer is pinned, sits above the bottom nav, and lays
//  out as three cells (brand | thank-you | legal links).
// ============================================================
(function () {
  function forcePinnedFooter() {
    var footer = document.querySelector('footer.bidhaa-legal-footer');
    if (!footer) return;

    var navHeight = 0;
    var bottomNav = document.querySelector('.bottom-nav');
    if (bottomNav) {
      var navStyle = window.getComputedStyle(bottomNav);
      if (navStyle.display !== 'none' && navStyle.visibility !== 'hidden') {
        navHeight = bottomNav.getBoundingClientRect().height || 0;
      }
    }

    footer.style.position = 'fixed';
    footer.style.left = '0';
    footer.style.right = '0';
    footer.style.bottom = navHeight + 'px';
    footer.style.zIndex = '1100';
    footer.style.margin = '0';
    footer.style.padding = '0';
    footer.style.background = '#0f172a';
    footer.style.color = '#94a3b8';
    footer.style.borderTop = '1px solid rgba(148, 163, 184, 0.18)';
    footer.style.boxShadow = '0 -6px 18px rgba(15, 23, 42, 0.18)';

    var inner = footer.querySelector('.bidhaa-legal-footer-inner');
    if (inner) {
      inner.style.maxWidth = '1400px';
      inner.style.margin = '0 auto';
      inner.style.padding = '8px 20px';
      inner.style.display = 'grid';
      inner.style.gridTemplateColumns = 'auto 1fr auto';
      inner.style.alignItems = 'center';
      inner.style.gap = '20px';
      inner.style.minHeight = '56px';
      inner.style.flexWrap = 'nowrap';
    }

    var brand = footer.querySelector('.bidhaa-legal-footer-brand');
    if (brand) {
      brand.style.display = 'flex';
      brand.style.flexDirection = 'column';
      brand.style.gap = '1px';
      brand.style.whiteSpace = 'nowrap';
    }

    var links = footer.querySelector('.bidhaa-legal-footer-links');
    if (links) {
      links.style.display = 'flex';
      links.style.gap = '16px';
      links.style.flexWrap = 'nowrap';
      links.style.whiteSpace = 'nowrap';
    }

    document.body.style.paddingBottom = (navHeight + 72) + 'px';
  }

  document.addEventListener('DOMContentLoaded', forcePinnedFooter);
  window.addEventListener('resize', forcePinnedFooter);
  window.addEventListener('orientationchange', forcePinnedFooter);
  [300, 900, 2000, 4000].forEach(function (ms) {
    setTimeout(forcePinnedFooter, ms);
  });
})();