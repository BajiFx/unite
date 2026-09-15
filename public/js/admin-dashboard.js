const adminMetricDefinitions = [
  ['pending', 'pending', 'Pending Orders', 'fa-hourglass-half'],
  ['confirmed', 'confirmed', 'Confirmed', 'fa-check'],
  ['shipped', 'shipped', 'Shipped', 'fa-truck'],
  ['delivered', 'delivered', 'Delivered', 'fa-box-open'],
  ['received', 'received', 'Received', 'fa-handshake'],
  ['cancelled', 'cancelled', 'Cancelled', 'fa-ban'],
  ['pending_payment', 'pending_payment', 'Pending Payment', 'fa-credit-card'],
  ['replacements_pending', 'replacements', 'Replacements Pending', 'fa-retweet'],
  ['refunds_pending', 'refunds', 'Refunds Pending', 'fa-money-bill-wave'],
  ['returns_pending', 'returns', 'Returns Pending', 'fa-rotate-left'],
  ['urgent', 'urgent', 'Urgent Deliveries', 'fa-bolt'],
  ['total_orders', 'all', 'Total Orders', 'fa-list']
];

async function loadAdminDashboard() {
  const grid = document.getElementById('adminStatsGrid');
  const status = document.getElementById('dashboardStatus');
  if (!grid) return;
  grid.innerHTML = '<p>Loading live statistics...</p>';
  try {
    const response = await fetch('/api/admin/dashboard');
    if (response.status === 401 || response.status === 403) {
      window.location.href = '/admin.html';
      return;
    }
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const stats = await response.json();
    grid.innerHTML = adminMetricDefinitions.map(([dataKey, filterKey, label, icon]) => `
      <a class="admin-stat-card" href="/admin-orders.html?status=${filterKey}">
        <i class="fas ${icon}"></i><strong>${Number(stats[dataKey] || 0).toLocaleString()}</strong><span>${label}</span>
      </a>
    `).join('') + `
      <div class="admin-stat-card revenue"><i class="fas fa-coins"></i><strong>Ksh ${Number(stats.total_revenue || 0).toLocaleString()}</strong><span>Total Revenue</span></div>
      <div class="admin-stat-card"><i class="fas fa-users"></i><strong>${Number(stats.total_customers || 0).toLocaleString()}</strong><span>Customers</span></div>
      <div class="admin-stat-card"><i class="fas fa-tags"></i><strong>${Number(stats.total_products || 0).toLocaleString()}</strong><span>Products</span></div>
    `;
    status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    status.className = 'status-message success';
  } catch (error) {
    grid.innerHTML = '<p class="error-text">Unable to load dashboard statistics.</p>';
    status.textContent = error.message;
    status.className = 'status-message error';
  }
}

async function logoutAdmin() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/admin.html';
}

window.addEventListener('DOMContentLoaded', loadAdminDashboard);

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
