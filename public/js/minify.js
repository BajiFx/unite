// ============================================================
//  MINIFY PAGE JAVASCRIPT
// ============================================================

async function loadStats() {
    try {
        const response = await fetch('/api/admin/assets/stats', {
            headers: { 'Authorization': `Bearer ${window.customerToken}` }
        });
        const data = await response.json();
        if (data.success) {
            document.getElementById('jsCount').textContent = data.jsCount;
            document.getElementById('cssCount').textContent = data.cssCount;
            document.getElementById('totalSize').textContent = data.totalSize;
        }
    } catch (err) {
        console.error('Stats error:', err);
    }
}

async function minifyAssets() {
    const btn = document.getElementById('minifyBtn');
    const output = document.getElementById('output');

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Minifying...';

    output.className = 'output show';
    output.innerHTML = `
        <div class="icon">⏳</div>
        <div class="title">Minifying assets...</div>
        <div class="details">Please wait, this may take a moment.</div>
    `;

    try {
        const response = await fetch('/api/admin/minify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${window.customerToken}`
            }
        });

        const data = await response.json();

        if (data.success) {
            let filesHtml = data.files.map(f => `
                <div class="file">
                    <span>${f}</span>
                    <span style="color:#16a34a;">✅</span>
                </div>
            `).join('');

            output.className = 'output show success';
            output.innerHTML = `
                <div class="icon">✅</div>
                <div class="title">${data.message}</div>
                <div class="details">
                    <p><strong>Files Minified:</strong> ${data.files.length}</p>
                    <p><strong>Total Reduction:</strong> ${data.totalReduction}</p>
                    <div style="margin-top:8px;"><strong>Files:</strong></div>
                    ${filesHtml}
                </div>
            `;
            loadStats();
        } else {
            output.className = 'output show error';
            output.innerHTML = `
                <div class="icon">❌</div>
                <div class="title">Failed to minify assets</div>
                <div class="details">${data.error || 'Unknown error'}</div>
            `;
        }
    } catch (err) {
        output.className = 'output show error';
        output.innerHTML = `
            <div class="icon">❌</div>
            <div class="title">Network Error</div>
            <div class="details">${err.message}</div>
        `;
    }

    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-compress"></i> Minify Assets';
}

document.addEventListener('DOMContentLoaded', loadStats);

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