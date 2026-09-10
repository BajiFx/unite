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
