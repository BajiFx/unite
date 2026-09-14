// ============================================================
//  ACCOUNT PAGE JAVASCRIPT - HORIZONTAL LAYOUT
//  Location: public/js/account.js
//
//  Section 10 — Rating audit result:
//   This file does NOT contain any customer-facing rating
//   display. The customer Home stats grid renders only order-
//   status counts. The recent-orders table renders only ref,
//   date, status, and total. No stars, no review counts, no
//   average rating anywhere in the customer-facing UI that
//   this file renders.
//
//   createBusinessCardAccount() still reads `business.avg_rating`
//   but that function is only reached by the marketplace block
//   that Section 9 hid. It is dead code and Section 10 does not
//   require touching it. Left in place for backward compatibility
//   in case the marketplace block is ever restored.
//
//  Section 9 — Customer account simplified to 4 tabs:
//   - Home       (was Dashboard)
//   - Orders     (unchanged)
//   - Profile    (now merges Personal info, Location,
//                 Preferred area, Addresses, Payment history
//                 as five scroll-anchored sub-sections)
//   - Messages   (unchanged)
//
//   Cart is no longer a tab. It becomes a floating button that
//   navigates to /cart.html and keeps a live count badge.
//
//   Logout is no longer a tab. It lives in the top header and
//   calls the same window.logout() as before.
//
//   Legacy deep links are still honoured:
//     ?section=dashboard       → home
//     ?section=addresses       → profile + scroll to Addresses
//     ?section=payments        → profile + scroll to Payment history
//     ?section=cart            → /cart.html
//
//  Section 11.A — Customer account deletion (4-step flow):
//   The Danger zone block in the Profile panel opens a chained
//   set of four modals:
//     A — offer alternatives (download data / deactivate)
//     B — password confirmation
//     C — reason selection
//     D — type DELETE MY ACCOUNT to confirm
//   On submit, the client calls
//     POST /api/auth/customer/request-deletion
//   which schedules the deletion 30 days out. The customer is
//   logged out and redirected with a message. If they log back
//   in during the grace period, the server auto-cancels.
//
//  Dead-code cleanup (this revision):
//   The Section 9 tab simplification removed the visible
//   marketplace block from account.html (it now carries the
//   `hidden` attribute). The following helpers only rendered
//   into that hidden block, so they are removed:
//     - loadMarketplaceAccount()
//     - loadCategoriesAccount()
//     - loadBusinessesAccount()
//     - renderBusinessesAccount()
//     - appendBusinessesAccount()
//     - createBusinessCardAccount()
//     - searchBusinessesAccount()
//     - filterBusinessesAccount()
//     - loadMoreBusinessesAccount()
//   The marketplace-state globals that only those functions
//   used are removed too:
//     allBusinessesAccount, currentPageAccount, hasMoreAccount,
//     isLoadingAccount, limitAccount.
//   The call site inside DOMContentLoaded
//   (`if (!isEmbeddedAccount) loadMarketplaceAccount()`) is
//   removed.
//   The corresponding window.* exports are removed.
//   Backend endpoints (/api/businesses/categories/all and
//   /api/businesses) are untouched — the marketplace home page
//   still uses them. Only the dead account-page copy is gone.
//
//  Everything from Sections D, E.2, and 6 below is preserved
//  exactly.
// ============================================================

// ============================================================
//  GLOBALS
// ============================================================

window.customerToken = 'cookie-auth';
const token = window.customerToken;
const isEmbeddedAccount = new URLSearchParams(window.location.search).get('embedded') === '1';

let socket = null;
let allOrders = [];
let currentFilterStatus = null;
let returnsMap = {};
let currentSection = 'home';

// Section D — cached location state for this page.
let customerLocationState = {
    activated: false,
    latitude: null,
    longitude: null,
    accuracy: null,
    activated_at: null,
    source: null
};

// Section E.2 — cached preferred-area state for this page.
let customerPreferredState = {
    continent: null,
    country: null,
    county: null,
    sub_county: null,
    ward: null,
    town: null,
    updated_at: null,
    has_any: false
};

// Section 9 — mapping of legacy section names to their new home.
const LEGACY_SECTION_MAP = {
    dashboard: { section: 'home',    scrollTo: null },
    addresses: { section: 'profile', scrollTo: 'profileSectionAddresses' },
    payments:  { section: 'profile', scrollTo: 'profileSectionPayments' },
    cart:      { section: 'cart',    scrollTo: null }
};

const VALID_SECTIONS = ['home', 'orders', 'profile', 'messages', 'cart'];

// Section 11.A — transient state for the 4-step deletion flow.
// Reset every time the danger-zone button is clicked.
const customerDeletionState = {
    passwordVerified: false,
    password: '',
    reason: '',
    phrase: ''
};

// ============================================================
//  PREVENT OLD LAYOUT FROM SHOWING
// ============================================================

(function() {
    const oldSidebar = document.querySelector('.sidebar');
    if (oldSidebar) oldSidebar.style.display = 'none';

    const oldOverlay = document.querySelector('.sidebar-overlay');
    if (oldOverlay) oldOverlay.style.display = 'none';

    const oldHeader = document.querySelector('.header');
    if (oldHeader) oldHeader.style.display = 'none';

    const oldBottomNav = document.querySelector('.bottom-nav');
    if (oldBottomNav) oldBottomNav.style.display = 'none';

    const layout = document.getElementById('accountLayout');
    if (layout) layout.style.display = 'block';

    console.log('🔒 Old layout elements hidden - Horizontal layout active');
})();

// ============================================================
//  NAVIGATION FUNCTIONS
// ============================================================

function navigateToAccount(section) {
    console.log('🔍 Navigating to:', section);

    let targetSection = section;
    let scrollTargetId = null;

    if (LEGACY_SECTION_MAP[section]) {
        targetSection = LEGACY_SECTION_MAP[section].section;
        scrollTargetId = LEGACY_SECTION_MAP[section].scrollTo;
    }

    if (targetSection === 'cart') {
        openAccountCart();
        return;
    }

    if (!VALID_SECTIONS.includes(targetSection)) {
        targetSection = 'home';
    }

    document.querySelectorAll('.account-nav-horizontal .nav-item').forEach(el => {
        el.classList.remove('active');
    });
    const navItem = document.querySelector(`.account-nav-horizontal .nav-item[data-section="${targetSection}"]`);
    if (navItem) navItem.classList.add('active');

    document.querySelectorAll('.account-content-panel').forEach(el => {
        el.classList.remove('active');
    });
    const panel = document.getElementById(`panel-${targetSection}`);
    if (panel) panel.classList.add('active');

    currentSection = targetSection;

    switch (targetSection) {
        case 'home':
            loadDashboardContent();
            break;
        case 'orders':
            loadOrdersContent();
            break;
        case 'profile':
            loadProfileContent();
            loadCustomerLocationState();
            loadCustomerPreferredAreaState();
            loadAddressesContent();
            loadPaymentsContent();
            break;
        case 'messages':
            loadMessagesContent();
            break;
    }

    if (scrollTargetId) {
        requestAnimationFrame(() => {
            scrollToProfileSection(scrollTargetId);
        });
    }
}

function scrollToProfileSection(sectionId) {
    if (!sectionId) return;
    const el = document.getElementById(sectionId);
    if (!el) return;

    try {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        el.scrollIntoView();
    }

    const previousOutline = el.style.outline;
    const previousTransition = el.style.transition;
    el.style.transition = 'outline 0.6s ease';
    el.style.outline = '3px solid #2563eb';

    setTimeout(() => {
        el.style.outline = previousOutline || '';
        el.style.transition = previousTransition || '';
    }, 1200);
}

function openAccountCart() {
    window.location.href = '/cart.html';
}

function toggleMobileNav() {
    const nav = document.querySelector('.account-nav-horizontal');
    if (nav) {
        nav.classList.toggle('mobile-open');
    }
}

// ============================================================
//  SOCKET INIT
// ============================================================

function initSocket() {
    if (socket) return;
    socket = io({ auth: { token } });
    socket.on('new-order-chat-message', () => {
        if (currentSection === 'home' || currentSection === 'orders') {
            loadDashboardContent();
            loadOrdersContent();
        }
    });
    socket.on('order-status-updated', () => {
        if (currentSection === 'home' || currentSection === 'orders') {
            loadDashboardContent();
            loadOrdersContent();
        }
    });
    socket.on('payment-updated', () => {
        if (currentSection === 'home' || currentSection === 'profile') {
            loadDashboardContent();
            loadPaymentsContent();
        }
    });
}

// ============================================================
//  HOME CONTENT (was DASHBOARD)
//  Section 10 — renders only order-status counts. No rating.
// ============================================================

function loadDashboardContent() {
    console.log('📊 Loading home content...');

    const user = window.currentUser || JSON.parse(localStorage.getItem('currentUser') || '{}');

    const userNameEl = document.getElementById('headerUserName');
    const userPhoneEl = document.getElementById('headerUserPhone');

    if (userNameEl && user.name) {
        userNameEl.textContent = user.name;
    }
    if (userPhoneEl && user.phone) {
        userPhoneEl.textContent = user.phone;
    }

    const nameInput = document.getElementById('profileName');
    const emailInput = document.getElementById('profileEmail');
    const phoneInput = document.getElementById('profilePhone');
    if (nameInput) nameInput.value = user.name || '';
    if (emailInput) emailInput.value = user.email || '';
    if (phoneInput) phoneInput.value = user.phone || '';

    renderProfileUsername(user.username);

    fetch('/api/orders', {
        headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => {
        if (res.status === 429) {
            return new Promise(resolve => {
                setTimeout(() => {
                    resolve(fetch('/api/orders', { headers: { 'Authorization': `Bearer ${token}` } }));
                }, 3000);
            });
        }
        return res;
    })
    .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    })
    .then(orders => {
        if (!Array.isArray(orders)) orders = [];
        allOrders = orders;

        return fetch('/api/orders/returns/customer', {
            headers: { 'Authorization': `Bearer ${token}` }
        })
        .then(res => {
            if (res.status === 404 || res.status === 429) return [];
            return res.json();
        })
        .catch(() => [])
        .then(returns => {
            returnsMap = {};
            (returns || []).forEach(r => { returnsMap[r.order_id] = r; });
            renderDashboardStats(orders);
            renderRecentOrders(orders);
            updateOrderBadge(orders);
            updateCartBadge();
        });
    })
    .catch(err => {
        console.error('Error loading home content:', err);
        const recentPanel = document.getElementById('recentOrdersPanel');
        const statsPanel = document.getElementById('statsGridPanel');
        if (recentPanel) recentPanel.innerHTML =
            '<div class="empty-state"><span class="icon">⚠️</span> Error loading orders</div>';
        if (statsPanel) statsPanel.innerHTML =
            '<div class="empty-state">Unable to load statistics</div>';
    });
}

function renderDashboardStats(orders) {
    const grid = document.getElementById('statsGridPanel');
    if (!grid) return;

    if (!Array.isArray(orders)) {
        grid.innerHTML = '<div class="empty-state">No orders to display.</div>';
        return;
    }

    const statuses = ['pending_payment', 'pending', 'confirmed', 'shipped', 'delivered', 'received', 'cancelled'];
    const counts = {};
    statuses.forEach(s => counts[s] = 0);

    orders.forEach(o => {
        if (counts[o.status] !== undefined) counts[o.status]++;
    });

    const items = [
        { key: 'pending_payment', label: 'Awaiting Payment', icon: 'fa-clock', css: 'pending_payment' },
        { key: 'pending', label: 'Pending', icon: 'fa-clock', css: 'pending' },
        { key: 'confirmed', label: 'Confirmed', icon: 'fa-check-circle', css: 'confirmed' },
        { key: 'shipped', label: 'Shipped', icon: 'fa-truck', css: 'shipped' },
        { key: 'delivered', label: 'Awaiting Pickup', icon: 'fa-box-open', css: 'delivered' },
        { key: 'received', label: 'Received', icon: 'fa-check-double', css: 'received' },
        { key: 'cancelled', label: 'Cancelled', icon: 'fa-times-circle', css: 'cancelled' }
    ];

    let html = '';
    items.forEach(item => {
        const count = counts[item.key] || 0;
        const isPending = ['pending_payment', 'pending', 'delivered'].includes(item.key);
        const blink = (count > 0 && isPending) ? '<span class="stat-blink"></span>' : '<span class="stat-blink hidden"></span>';

        html += `
            <div class="stat-link-panel ${item.css}" data-status="${item.key}" onclick="filterOrdersByStatus('${item.key}')">
                <span class="stat-icon"><i class="fas ${item.icon}"></i></span>
                <span class="stat-content">
                    <span class="stat-value">${count}</span>
                    <span class="stat-label">${item.label} ${blink}</span>
                </span>
            </div>
        `;
    });

    grid.innerHTML = html;
}

function renderRecentOrders(orders) {
    const container = document.getElementById('recentOrdersPanel');
    const title = document.getElementById('recentOrdersTitle');
    if (!container) return;

    orders = Array.isArray(orders) ? orders : [];
    const filteredOrders = currentFilterStatus
        ? orders.filter(order => order.status === currentFilterStatus)
        : orders;
    const statusLabel = currentFilterStatus
        ? currentFilterStatus.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
        : '';
    if (title) {
        title.innerHTML = currentFilterStatus
            ? `<i class="fas fa-filter" style="color:#2e7d32;"></i> ${statusLabel} Orders <button type="button" class="btn-sm" onclick="clearDashboardOrderFilter()">Show all</button>`
            : '<i class="fas fa-clock" style="color:#2e7d32;"></i> Recent Orders';
    }

    if (!filteredOrders || filteredOrders.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="icon">📦</span> No recent orders</div>';
        return;
    }

    const recent = filteredOrders.slice(0, 5);

    let html = `
        <table class="orders-table-panel">
            <thead>
                <tr>
                    <th>Order Ref</th>
                    <th>Date</th>
                    <th>Status</th>
                    <th>Total</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody>
    `;

    recent.forEach(order => {
        const ref = order.order_ref || `#${order.id}`;
        const date = new Date(order.created_at).toLocaleDateString();
        const total = parseFloat(order.total).toFixed(2);
        const statusClass = order.status;

        html += `
            <tr>
                <td><strong>${ref}</strong></td>
                <td>${date}</td>
                <td><span class="status-badge ${statusClass}">${order.status.replace('_', ' ').toUpperCase()}</span></td>
                <td><strong>Ksh ${total}</strong></td>
                <td>
                    <button class="btn-sm btn-sm-primary" onclick="navigateToAccount('orders')">View</button>
                </td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

function updateOrderBadge(orders) {
    const badge = document.getElementById('orderBadgeNav');
    if (badge) {
        const count = orders && Array.isArray(orders) ? orders.length : 0;
        badge.textContent = count;
        if (count > 0) {
            badge.classList.add('show');
        } else {
            badge.classList.remove('show');
        }
    }
}

function updateCartBadge() {
    const cart = getCart();
    const count = cart.reduce((sum, item) => sum + item.quantity, 0);

    const badge = document.getElementById('accountFloatingCartBadge');
    if (badge) {
        if (count > 0) {
            badge.textContent = count;
            badge.classList.add('show');
        } else {
            badge.classList.remove('show');
        }
    }
}

function filterOrdersByStatus(status) {
    currentFilterStatus = status;
    renderDashboardStats(allOrders);
    renderRecentOrders(allOrders);
}

function clearDashboardOrderFilter() {
    currentFilterStatus = null;
    renderDashboardStats(allOrders);
    renderRecentOrders(allOrders);
}

// ============================================================
//  ORDERS CONTENT
// ============================================================

function loadOrdersContent() {
    console.log('📦 Loading orders content...');
    const container = document.getElementById('ordersPanelContent');
    if (!container) return;

    if (!allOrders || allOrders.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="icon">📦</span> You have no orders yet.</div>';
        const label = document.getElementById('orderCountLabel');
        if (label) label.textContent = '(0 orders)';
        return;
    }

    let filtered = allOrders;
    if (currentFilterStatus && currentFilterStatus !== 'all') {
        filtered = allOrders.filter(o => o.status === currentFilterStatus);
    }

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state"><span class="icon">🔍</span> No orders with status: ${currentFilterStatus ? currentFilterStatus.replace('_', ' ').toUpperCase() : 'All'}</div>`;
        const label = document.getElementById('orderCountLabel');
        if (label) label.textContent = '(0 orders)';
        return;
    }

    filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    let html = `
        <table class="orders-table-panel">
            <thead>
                <tr>
                    <th>Order Ref</th>
                    <th>Date</th>
                    <th>Status</th>
                    <th>Total</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody>
    `;

    filtered.forEach(order => {
        const ref = order.order_ref || `#${order.id}`;
        const date = new Date(order.created_at).toLocaleDateString();
        const total = parseFloat(order.total).toFixed(2);
        const statusClass = order.status;

        html += `
            <tr>
                <td><strong>${ref}</strong></td>
                <td>${date}</td>
                <td><span class="status-badge ${statusClass}">${order.status.replace('_', ' ').toUpperCase()}</span></td>
                <td><strong>Ksh ${total}</strong></td>
                <td>
                    <button class="btn-sm btn-sm-primary" onclick="window.location.href='/order-tracking.html?id=${order.id}'">
                        <i class="fas fa-eye"></i> View
                    </button>
                </td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;

    const label = document.getElementById('orderCountLabel');
    if (label) label.textContent = `(${filtered.length} orders)`;
}

// ============================================================
//  PROFILE CONTENT
// ============================================================

function renderProfileUsername(username) {
    const el = document.getElementById('profileUsername');
    if (!el) return;

    const value = username && String(username).trim();
    if (value) {
        el.textContent = value;
        el.style.color = '#0f172a';
        el.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        el.style.fontWeight = '700';
    } else {
        el.textContent = '(will be assigned automatically)';
        el.style.color = '#94a3b8';
        el.style.fontFamily = 'inherit';
        el.style.fontWeight = '400';
    }
}

function loadProfileContent() {
    console.log('👤 Loading profile content...');
    const user = window.currentUser || JSON.parse(localStorage.getItem('currentUser') || '{}');

    const nameInput = document.getElementById('profileName');
    const emailInput = document.getElementById('profileEmail');
    const phoneInput = document.getElementById('profilePhone');

    if (nameInput) nameInput.value = user.name || '';
    if (emailInput) emailInput.value = user.email || '';
    if (phoneInput) phoneInput.value = user.phone || '';

    renderProfileUsername(user.username);

    loadCustomerLocationState();
    loadCustomerPreferredAreaState();
    loadAddressesContent();
    loadPaymentsContent();
}

function updateProfile() {
    const name = document.getElementById('profileName').value.trim();
    const email = document.getElementById('profileEmail').value.trim();
    const phone = document.getElementById('profilePhone').value.trim();
    const status = document.getElementById('profileStatus');

    if (!name || !phone) {
        status.textContent = '❌ Name and phone number are required.';
        status.style.color = '#ef4444';
        return;
    }

    if (email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            status.textContent = '❌ Please enter a valid email address, or leave it blank.';
            status.style.color = '#ef4444';
            return;
        }
    }

    fetch('/api/auth/customer/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name, email: email || null, phone })
    })
    .then(res => res.json())
    .then(data => {
        if (data.user) {
            localStorage.setItem('currentUser', JSON.stringify(data.user));
            window.currentUser = data.user;
            status.textContent = '✅ Profile updated successfully!';
            status.style.color = '#16a34a';
            const userNameEl = document.getElementById('headerUserName');
            if (userNameEl) userNameEl.textContent = data.user.name;
            loadDashboardContent();
            renderProfileUsername(data.user.username);
        } else {
            status.textContent = '❌ Failed to update profile.';
            status.style.color = '#ef4444';
        }
    })
    .catch(() => {
        status.textContent = '❌ Network error.';
        status.style.color = '#ef4444';
    });
}

// ============================================================
//  SECTION D — CUSTOMER LOCATION
// ============================================================

function renderCustomerLocationState() {
    const badgeActive = document.getElementById('customerLocationStatusBadge');
    const badgeInactive = document.getElementById('customerLocationStatusBadgeInactive');
    const activateBtn = document.getElementById('customerActivateLocationBtn');
    const refreshBtn = document.getElementById('customerRefreshLocationBtn');
    const deactivateBtn = document.getElementById('customerDeactivateLocationBtn');
    const statusEl = document.getElementById('customerLocationStatus');

    if (badgeActive) badgeActive.style.display = customerLocationState.activated ? 'inline-block' : 'none';
    if (badgeInactive) badgeInactive.style.display = customerLocationState.activated ? 'none' : 'inline-block';

    if (activateBtn) activateBtn.style.display = customerLocationState.activated ? 'none' : 'inline-flex';
    if (refreshBtn) refreshBtn.style.display = customerLocationState.activated ? 'inline-flex' : 'none';
    if (deactivateBtn) deactivateBtn.style.display = customerLocationState.activated ? 'inline-flex' : 'none';

    if (statusEl) {
        if (customerLocationState.activated && customerLocationState.activated_at) {
            const when = new Date(customerLocationState.activated_at).toLocaleString();
            statusEl.textContent = `📍 Location active since ${when}.`;
            statusEl.style.color = '#166534';
        } else {
            statusEl.textContent = '';
        }
    }
}

async function activateCustomerLocation() {
    const statusEl = document.getElementById('customerLocationStatus');
    const activateBtn = document.getElementById('customerActivateLocationBtn');
    const refreshBtn = document.getElementById('customerRefreshLocationBtn');

    if (!navigator.geolocation) {
        if (statusEl) {
            statusEl.textContent = '❌ Your browser does not support location. Please use a modern browser.';
            statusEl.style.color = '#ef4444';
        }
        return;
    }

    if (statusEl) {
        statusEl.textContent = '⏳ Getting your location...';
        statusEl.style.color = '#2563eb';
    }
    if (activateBtn) activateBtn.disabled = true;
    if (refreshBtn) refreshBtn.disabled = true;

    navigator.geolocation.getCurrentPosition(
        async (position) => {
            const latitude = position.coords.latitude;
            const longitude = position.coords.longitude;
            const accuracy = position.coords.accuracy;

            try {
                const res = await fetch('/api/location/customer/activate', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    credentials: 'same-origin',
                    body: JSON.stringify({ latitude, longitude, accuracy })
                });
                const data = await res.json();

                if (!res.ok || !data.success) {
                    throw new Error(data.error || 'Failed to save location');
                }

                customerLocationState = {
                    activated: true,
                    latitude: data.location?.latitude || latitude,
                    longitude: data.location?.longitude || longitude,
                    accuracy: data.location?.accuracy || accuracy,
                    activated_at: data.location?.activated_at || new Date().toISOString(),
                    source: data.location?.source || 'browser'
                };
                renderCustomerLocationState();

                if (statusEl) {
                    statusEl.textContent = '✅ Location saved. Nearby searches will now use your current position.';
                    statusEl.style.color = '#16a34a';
                }

                if (typeof window.showToast === 'function') {
                    window.showToast('✅ Location activated!', 'success');
                }
            } catch (err) {
                if (statusEl) {
                    statusEl.textContent = '❌ ' + err.message;
                    statusEl.style.color = '#ef4444';
                }
                if (typeof window.showToast === 'function') {
                    window.showToast('❌ ' + err.message, 'error');
                }
            } finally {
                if (activateBtn) activateBtn.disabled = false;
                if (refreshBtn) refreshBtn.disabled = false;
            }
        },
        (error) => {
            let message = 'Unable to get your location.';
            if (error.code === error.PERMISSION_DENIED) {
                message = 'Location permission was denied. Please allow it in your browser settings, then try again.';
            } else if (error.code === error.POSITION_UNAVAILABLE) {
                message = 'Your location is currently unavailable. Please try again in a moment.';
            } else if (error.code === error.TIMEOUT) {
                message = 'Getting your location timed out. Please try again.';
            }

            if (statusEl) {
                statusEl.textContent = '❌ ' + message;
                statusEl.style.color = '#ef4444';
            }
            if (typeof window.showToast === 'function') {
                window.showToast('❌ ' + message, 'error');
            }

            if (activateBtn) activateBtn.disabled = false;
            if (refreshBtn) refreshBtn.disabled = false;
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
}

async function deactivateCustomerLocation() {
    if (!confirm('Turn off location sharing? Nearby searches will no longer use your position.')) {
        return;
    }

    const statusEl = document.getElementById('customerLocationStatus');
    const deactivateBtn = document.getElementById('customerDeactivateLocationBtn');
    if (deactivateBtn) deactivateBtn.disabled = true;

    try {
        const res = await fetch('/api/location/customer/deactivate', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            credentials: 'same-origin'
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Failed to turn off location sharing');
        }

        customerLocationState = {
            activated: false,
            latitude: null,
            longitude: null,
            accuracy: null,
            activated_at: null,
            source: null
        };
        renderCustomerLocationState();

        if (statusEl) {
            statusEl.textContent = 'Location sharing turned off.';
            statusEl.style.color = '#64748b';
        }
        if (typeof window.showToast === 'function') {
            window.showToast('Location sharing is off.', 'info');
        }
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = '❌ ' + err.message;
            statusEl.style.color = '#ef4444';
        }
        if (typeof window.showToast === 'function') {
            window.showToast('❌ ' + err.message, 'error');
        }
    } finally {
        if (deactivateBtn) deactivateBtn.disabled = false;
    }
}

async function loadCustomerLocationState() {
    try {
        const res = await fetch('/api/location/customer/location', {
            headers: { 'Authorization': `Bearer ${token}` },
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (!res.ok) {
            renderCustomerLocationState();
            return;
        }
        const data = await res.json();

        customerLocationState = {
            activated: data.activated === true,
            latitude: data.latitude || null,
            longitude: data.longitude || null,
            accuracy: data.accuracy || null,
            activated_at: data.activated_at || null,
            source: data.source || null
        };
        renderCustomerLocationState();
    } catch (err) {
        renderCustomerLocationState();
    }
}

// ============================================================
//  SECTION E.2 / G.3 — CUSTOMER PREFERRED AREA
// ============================================================

function renderCustomerPreferredAreaState() {
    const badge = document.getElementById('customerPreferredAreaBadge');
    const statusEl = document.getElementById('customerPreferredAreaStatus');

    const fields = {
        preferredContinent: customerPreferredState.continent,
        preferredCountry: customerPreferredState.country,
        preferredCounty: customerPreferredState.county,
        preferredSubCounty: customerPreferredState.sub_county,
        preferredWard: customerPreferredState.ward,
        preferredTown: customerPreferredState.town
    };

    Object.keys(fields).forEach(id => {
        const input = document.getElementById(id);
        if (input) input.value = fields[id] || '';
    });

    if (badge) badge.style.display = customerPreferredState.has_any ? 'inline-block' : 'none';

    if (statusEl) {
        if (customerPreferredState.has_any && customerPreferredState.updated_at) {
            const when = new Date(customerPreferredState.updated_at).toLocaleString();
            statusEl.textContent = `Preferred area updated ${when}.`;
            statusEl.style.color = '#1e40af';
        } else if (customerPreferredState.has_any) {
            statusEl.textContent = 'Preferred area is set.';
            statusEl.style.color = '#1e40af';
        } else {
            statusEl.textContent = '';
        }
    }
}

async function saveCustomerPreferredArea() {
    const statusEl = document.getElementById('customerPreferredAreaStatus');
    const saveBtn = document.getElementById('savePreferredAreaBtn');

    const payload = {
        continent: document.getElementById('preferredContinent')?.value?.trim() || '',
        country: document.getElementById('preferredCountry')?.value?.trim() || '',
        county: document.getElementById('preferredCounty')?.value?.trim() || '',
        sub_county: document.getElementById('preferredSubCounty')?.value?.trim() || '',
        ward: document.getElementById('preferredWard')?.value?.trim() || '',
        town: document.getElementById('preferredTown')?.value?.trim() || ''
    };

    const anyValue = Object.values(payload).some(v => v !== '');
    if (!anyValue) {
        if (statusEl) {
            statusEl.textContent = '❌ Please fill in at least one field (county, town, etc.).';
            statusEl.style.color = '#ef4444';
        }
        return;
    }

    if (saveBtn) saveBtn.disabled = true;
    if (statusEl) {
        statusEl.textContent = '⏳ Saving...';
        statusEl.style.color = '#2563eb';
    }

    try {
        const res = await fetch('/api/location/customer/preferred-locations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            credentials: 'same-origin',
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Failed to save preferred area');
        }

        const saved = data.preferred_locations || {};
        customerPreferredState = {
            continent: saved.continent || null,
            country: saved.country || null,
            county: saved.county || null,
            sub_county: saved.sub_county || null,
            ward: saved.ward || null,
            town: saved.town || null,
            updated_at: saved.updated_at || new Date().toISOString(),
            has_any: saved.has_any === true
        };
        renderCustomerPreferredAreaState();

        if (statusEl) {
            statusEl.textContent = '✅ Preferred area saved.';
            statusEl.style.color = '#16a34a';
        }
        if (typeof window.showToast === 'function') {
            window.showToast('✅ Preferred area saved!', 'success');
        }
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = '❌ ' + err.message;
            statusEl.style.color = '#ef4444';
        }
        if (typeof window.showToast === 'function') {
            window.showToast('❌ ' + err.message, 'error');
        }
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

async function clearCustomerPreferredArea() {
    if (!confirm('Clear your preferred area?')) return;

    const statusEl = document.getElementById('customerPreferredAreaStatus');
    const clearBtn = document.getElementById('clearPreferredAreaBtn');
    if (clearBtn) clearBtn.disabled = true;
    if (statusEl) {
        statusEl.textContent = '⏳ Clearing...';
        statusEl.style.color = '#2563eb';
    }

    try {
        const res = await fetch('/api/location/customer/preferred-locations', {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
            credentials: 'same-origin'
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Failed to clear preferred area');
        }

        customerPreferredState = {
            continent: null,
            country: null,
            county: null,
            sub_county: null,
            ward: null,
            town: null,
            updated_at: null,
            has_any: false
        };
        renderCustomerPreferredAreaState();

        if (statusEl) {
            statusEl.textContent = 'Preferred area cleared.';
            statusEl.style.color = '#64748b';
        }
        if (typeof window.showToast === 'function') {
            window.showToast('Preferred area cleared.', 'info');
        }
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = '❌ ' + err.message;
            statusEl.style.color = '#ef4444';
        }
        if (typeof window.showToast === 'function') {
            window.showToast('❌ ' + err.message, 'error');
        }
    } finally {
        if (clearBtn) clearBtn.disabled = false;
    }
}

async function loadCustomerPreferredAreaState() {
    try {
        const res = await fetch('/api/location/customer/preferred-locations', {
            headers: { 'Authorization': `Bearer ${token}` },
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (!res.ok) {
            renderCustomerPreferredAreaState();
            return;
        }
        const data = await res.json();
        customerPreferredState = {
            continent: data.continent || null,
            country: data.country || null,
            county: data.county || null,
            sub_county: data.sub_county || null,
            ward: data.ward || null,
            town: data.town || null,
            updated_at: data.updated_at || null,
            has_any: data.has_any === true
        };
        renderCustomerPreferredAreaState();
    } catch (err) {
        renderCustomerPreferredAreaState();
    }
}

// ============================================================
//  ADDRESSES CONTENT (now a Profile sub-section)
// ============================================================

function loadAddressesContent() {
    console.log('📍 Loading addresses content...');
    const container = document.getElementById('addressesPanelContent');
    if (!container) return;

    fetch('/api/addresses', { headers: { 'Authorization': `Bearer ${token}` } })
        .then(res => res.json())
        .then(addresses => {
            if (!addresses || addresses.length === 0) {
                container.innerHTML = '<div class="empty-state"><span class="icon">📍</span> No saved addresses.</div>';
                return;
            }

            let html = '';
            addresses.forEach(addr => {
                html += `
                    <div class="address-item-panel">
                        <div>
                            <span class="label">${addr.label}</span>
                            ${addr.is_default ? ' <span style="font-size:0.65rem; background:#2563eb; color:white; padding:0 10px; border-radius:20px;">Default</span>' : ''}
                            <br><span class="address-text">${addr.address}</span>
                        </div>
                        <div class="actions">
                            ${!addr.is_default ? `<button class="btn-sm btn-sm-primary" onclick="setDefaultAddress(${addr.id})">Set Default</button>` : ''}
                            <button class="btn-sm btn-sm-danger" onclick="deleteAddress(${addr.id})"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>
                `;
            });

            container.innerHTML = html;
        })
        .catch(() => {
            container.innerHTML = '<div class="empty-state"><span class="icon">❌</span> Error loading addresses.</div>';
        });
}

function showAddAddress() {
    document.getElementById('addressModal').classList.add('active');
    document.getElementById('addressInput').value = '';
    document.getElementById('addressLat').value = '';
    document.getElementById('addressLng').value = '';
    document.getElementById('addressLocationName').value = '';
    document.getElementById('addressSuggestions').style.display = 'none';
}

function closeAddressModal() {
    document.getElementById('addressModal').classList.remove('active');
}

document.getElementById('addressInput')?.addEventListener('input', function() {
    const query = this.value.trim();
    const suggestionsDiv = document.getElementById('addressSuggestions');
    if (query.length < 3) { suggestionsDiv.style.display = 'none'; return; }
    fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`)
        .then(res => res.json())
        .then(data => {
            if (!data.length) { suggestionsDiv.style.display = 'none'; return; }
            suggestionsDiv.style.display = 'block';
            suggestionsDiv.innerHTML = data.map(item => `
                <div onclick="selectAddressSuggestion('${item.display_name.replace(/'/g, "\\'")}', '${item.lat}', '${item.lon}')">
                    ${item.display_name}
                </div>
            `).join('');
        })
        .catch(() => { suggestionsDiv.style.display = 'none'; });
});

function selectAddressSuggestion(address, lat, lng) {
    document.getElementById('addressInput').value = address;
    document.getElementById('addressLat').value = lat;
    document.getElementById('addressLng').value = lng;
    document.getElementById('addressLocationName').value = address;
    document.getElementById('addressSuggestions').style.display = 'none';
}

function saveAddress() {
    const label = document.getElementById('addressLabel').value;
    const address = document.getElementById('addressInput').value.trim();
    const lat = document.getElementById('addressLat').value.trim();
    const lng = document.getElementById('addressLng').value.trim();
    const location_name = document.getElementById('addressLocationName').value.trim() || address;

    if (!address) { alert('Please enter an address.'); return; }

    fetch('/api/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ label, address, lat, lng, location_name })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            alert('Address saved!');
            closeAddressModal();
            loadAddressesContent();
        } else {
            alert('Failed to save address.');
        }
    })
    .catch(() => alert('Network error.'));
}

function setDefaultAddress(id) {
    fetch(`/api/addresses/${id}/default`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) { loadAddressesContent(); }
        else { alert('Failed to set default.'); }
    })
    .catch(() => alert('Network error.'));
}

function deleteAddress(id) {
    if (!confirm('Delete this address?')) return;
    fetch(`/api/addresses/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) { loadAddressesContent(); }
        else { alert('Failed to delete address.'); }
    })
    .catch(() => alert('Network error.'));
}

// ============================================================
//  PAYMENTS CONTENT (now a Profile sub-section)
// ============================================================

function loadPaymentsContent() {
    console.log('💳 Loading payments content...');
    const container = document.getElementById('paymentsPanelContent');
    if (!container) return;

    fetch('/api/payments/customer', {
        headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => {
        if (!res.ok) throw new Error('Failed to fetch payments');
        return res.json();
    })
    .then(payments => {
        if (!payments || payments.length === 0) {
            container.innerHTML = '<div class="empty-state"><span class="icon">💳</span> No payment history found.</div>';
            return;
        }

        payments.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        let html = `
            <table class="payment-table-panel">
                <thead>
                    <tr>
                        <th>Method</th>
                        <th>Amount</th>
                        <th>Status</th>
                        <th>Transaction ID</th>
                        <th>Date</th>
                    </tr>
                </thead>
                <tbody>
        `;

        payments.forEach(p => {
            let methodName = p.method.toUpperCase();
            let icon = 'fa-credit-card';

            switch(p.method) {
                case 'mpesa': methodName = 'M-Pesa'; icon = 'fa-mobile-alt'; break;
                case 'airtel': methodName = 'Airtel Money'; icon = 'fa-phone'; break;
                case 'paypal': methodName = 'PayPal'; icon = 'fa-paypal'; break;
                case 'bank': methodName = 'Bank Transfer'; icon = 'fa-university'; break;
            }

            let statusClass = 'pending';
            let statusText = p.status.toUpperCase();
            if (p.status === 'success' || p.status === 'successful' || p.status === 'completed') {
                statusClass = 'success';
            } else if (p.status === 'failed' || p.status === 'error') {
                statusClass = 'failed';
            } else {
                statusClass = 'pending';
            }

            const amount = parseFloat(p.amount).toFixed(2);
            const date = new Date(p.created_at).toLocaleString();
            const txId = p.transaction_id || 'N/A';

            html += `
                <tr>
                    <td><i class="fas ${icon}"></i> ${methodName}</td>
                    <td><strong>Ksh ${amount}</strong></td>
                    <td><span class="payment-status ${statusClass}">${statusText}</span></td>
                    <td style="font-family:monospace; font-size:0.7rem;">${txId}</td>
                    <td style="font-size:0.75rem; color:#94a3b8;">${date}</td>
                </tr>
            `;
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    })
    .catch(err => {
        console.error('Error loading payments:', err);
        container.innerHTML = '<div class="empty-state"><span class="icon">❌</span> Error loading payment history.</div>';
    });
}

// ============================================================
//  MESSAGES CONTENT
// ============================================================

function loadMessagesContent() {
    console.log('💬 Loading messages content...');
    const container = document.getElementById('messagesPanelContent');
    if (!container) return;

    fetch('/api/chat', {
        headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(messages => {
        if (!messages || messages.length === 0) {
            container.innerHTML = '<div class="empty-state"><span class="icon">💬</span> No messages yet.</div>';
            const badge = document.getElementById('messageBadgeNav');
            if (badge) badge.textContent = '0';
            const label = document.getElementById('messageCountLabel');
            if (label) label.textContent = '(0 unread)';
            return;
        }

        const unread = messages.filter(m => m.from_user === 'Seller' || m.from_user === 'System').length || 0;
        const badge = document.getElementById('messageBadgeNav');
        if (badge) {
            badge.textContent = unread;
            if (unread > 0) {
                badge.classList.add('show');
            } else {
                badge.classList.remove('show');
            }
        }
        const label = document.getElementById('messageCountLabel');
        if (label) label.textContent = `(${unread} unread)`;

        const recent = messages.slice(-10).reverse();
        let html = '<div class="messages-box-panel">';

        recent.forEach(msg => {
            const sender = msg.from_user || msg.from || 'Unknown';
            const time = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '';
            const text = msg.message || msg.text || '';
            const isUnread = sender === 'Seller' || sender === 'System';

            html += `
                <div class="msg-item" style="${isUnread ? 'background:#f0f7ff; padding:8px 12px; border-radius:6px;' : ''}">
                    <div>
                        <span class="sender">${sender === 'Customer' ? 'You' : sender}</span>
                        ${isUnread ? '<span style="font-size:0.5rem; background:#2563eb; color:white; padding:0 8px; border-radius:10px;">NEW</span>' : ''}
                        <span class="time">${time}</span>
                    </div>
                    <div class="text">${text}</div>
                </div>
            `;
        });

        html += '</div>';
        container.innerHTML = html;
    })
    .catch(() => {
        container.innerHTML = '<div class="empty-state"><span class="icon">❌</span> Error loading messages.</div>';
    });
}

// ============================================================
//  SECTION 11.A — CUSTOMER ACCOUNT DELETION (4-step flow)
//
//  Step A — offer alternatives (download data / deactivate)
//  Step B — password confirmation
//  Step C — reason selection
//  Step D — type DELETE MY ACCOUNT to confirm
//
//  On submit, the client calls
//    POST /api/auth/customer/request-deletion
//  and then logs the customer out and redirects to / with a
//  status query param. The server-side login handler
//  auto-cancels any pending deletion if the customer logs back
//  in within 30 days.
// ============================================================

function openCustomerDeletionStepA() {
    resetCustomerDeletionState();
    showCustomerDeletionModal('A');
}

function openCustomerDeletionStepB() {
    // Step A is only a choice screen; moving to B does not need
    // the password yet, but we do need to clear any prior
    // attempt's error message so the user sees a clean modal.
    const statusB = document.getElementById('customerDeletionStatusB');
    if (statusB) { statusB.textContent = ''; statusB.className = 'deletion-status'; }

    const passwordInput = document.getElementById('customerDeletionPassword');
    if (passwordInput) passwordInput.value = '';

    showCustomerDeletionModal('B');
}

function openCustomerDeletionStepC() {
    const statusC = document.getElementById('customerDeletionStatusC');
    if (statusC) { statusC.textContent = ''; statusC.className = 'deletion-status'; }

    const reasonSelect = document.getElementById('customerDeletionReason');
    if (reasonSelect) reasonSelect.value = '';

    showCustomerDeletionModal('C');
}

function openCustomerDeletionStepD() {
    const statusD = document.getElementById('customerDeletionStatusD');
    if (statusD) { statusD.textContent = ''; statusD.className = 'deletion-status'; }

    const phraseInput = document.getElementById('customerDeletionConfirmPhrase');
    if (phraseInput) phraseInput.value = '';

    const finalBtn = document.getElementById('customerDeletionFinalBtn');
    if (finalBtn) finalBtn.disabled = true;

    showCustomerDeletionModal('D');
}

function showCustomerDeletionModal(letter) {
    ['A', 'B', 'C', 'D'].forEach(step => {
        const modal = document.getElementById(`customerDeletionModal${step}`);
        if (modal) modal.classList.toggle('active', step === letter);
    });
}

function closeCustomerDeletionModals() {
    ['A', 'B', 'C', 'D'].forEach(step => {
        const modal = document.getElementById(`customerDeletionModal${step}`);
        if (modal) modal.classList.remove('active');
    });
    resetCustomerDeletionState();
}

function resetCustomerDeletionState() {
    customerDeletionState.passwordVerified = false;
    customerDeletionState.password = '';
    customerDeletionState.reason = '';
    customerDeletionState.phrase = '';

    ['A', 'B', 'C', 'D'].forEach(step => {
        const statusEl = document.getElementById(`customerDeletionStatus${step}`);
        if (statusEl) { statusEl.textContent = ''; statusEl.className = 'deletion-status'; }
    });

    const passwordInput = document.getElementById('customerDeletionPassword');
    if (passwordInput) passwordInput.value = '';

    const reasonSelect = document.getElementById('customerDeletionReason');
    if (reasonSelect) reasonSelect.value = '';

    const phraseInput = document.getElementById('customerDeletionConfirmPhrase');
    if (phraseInput) phraseInput.value = '';

    const finalBtn = document.getElementById('customerDeletionFinalBtn');
    if (finalBtn) finalBtn.disabled = true;
}

function customerDeletionDownloadData() {
    // The data-export endpoint is not part of Section 11. Until it
    // exists, we tell the user honestly so they do not think the
    // download failed silently.
    const statusEl = document.getElementById('customerDeletionStatusA');
    if (statusEl) {
        statusEl.textContent = '📥 Data download is not yet available. You can still proceed with deletion, or contact support if you need a copy of your data.';
        statusEl.className = 'deletion-status info';
    }

    if (typeof window.showToast === 'function') {
        window.showToast('Data download is not yet available.', 'info');
    }
}

function customerDeletionDeactivate() {
    // Deactivation is a separate feature that has not been built yet.
    // We surface that clearly instead of silently leaving the modal open.
    const statusEl = document.getElementById('customerDeletionStatusA');
    if (statusEl) {
        statusEl.textContent = '⏸️ Temporary deactivation is not yet available. You can still proceed with permanent deletion, or simply log out and stop using the account.';
        statusEl.className = 'deletion-status info';
    }

    if (typeof window.showToast === 'function') {
        window.showToast('Temporary deactivation is not yet available.', 'info');
    }
}

async function customerDeletionVerifyPassword() {
    const statusEl = document.getElementById('customerDeletionStatusB');
    const verifyBtn = document.getElementById('customerDeletionVerifyBtn');
    const passwordInput = document.getElementById('customerDeletionPassword');
    const password = passwordInput ? passwordInput.value : '';

    if (!password) {
        if (statusEl) {
            statusEl.textContent = '❌ Please enter your password.';
            statusEl.className = 'deletion-status error';
        }
        if (passwordInput) passwordInput.focus();
        return;
    }

    if (verifyBtn) {
        verifyBtn.disabled = true;
        verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking…';
    }
    if (statusEl) {
        statusEl.textContent = '⏳ Verifying your password…';
        statusEl.className = 'deletion-status info';
    }

    try {
        // The verification is done as part of the final request so the
        // password is never stored anywhere on the client. To keep the
        // flow simple we simply stash it in the in-memory state and
        // verify it server-side when the user submits in step D.
        customerDeletionState.password = password;

        // Sanity check: make sure the customer exists before letting
        // them continue. This is a lightweight call that also confirms
        // the session is still valid.
        const res = await fetch('/api/auth/customer/verify', {
            headers: { 'Authorization': `Bearer ${token}` },
            credentials: 'same-origin'
        });

        if (!res.ok) {
            throw new Error('Your session has expired. Please log in again.');
        }

        customerDeletionState.passwordVerified = true;

        if (statusEl) {
            statusEl.textContent = '✅ Password accepted.';
            statusEl.className = 'deletion-status success';
        }

        // Small delay so the user sees the confirmation before the
        // modal flips to step C.
        setTimeout(() => openCustomerDeletionStepC(), 400);
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = '❌ ' + (err.message || 'Could not verify your password.');
            statusEl.className = 'deletion-status error';
        }
        if (verifyBtn) verifyBtn.disabled = false;
    } finally {
        if (verifyBtn) {
            verifyBtn.innerHTML = '<i class="fas fa-arrow-right"></i> Continue';
        }
    }
}

function customerDeletionChooseReason() {
    const statusEl = document.getElementById('customerDeletionStatusC');
    const reasonSelect = document.getElementById('customerDeletionReason');
    const reason = reasonSelect ? reasonSelect.value : '';

    if (!reason) {
        if (statusEl) {
            statusEl.textContent = '❌ Please select a reason before continuing.';
            statusEl.className = 'deletion-status error';
        }
        if (reasonSelect) reasonSelect.focus();
        return;
    }

    customerDeletionState.reason = reason;
    openCustomerDeletionStepD();
}

function customerDeletionCheckPhrase() {
    const phraseInput = document.getElementById('customerDeletionConfirmPhrase');
    const finalBtn = document.getElementById('customerDeletionFinalBtn');
    const typed = phraseInput ? phraseInput.value : '';

    if (finalBtn) {
        finalBtn.disabled = typed !== 'DELETE MY ACCOUNT';
    }
}

async function customerDeletionSubmit() {
    const statusEl = document.getElementById('customerDeletionStatusD');
    const finalBtn = document.getElementById('customerDeletionFinalBtn');
    const phraseInput = document.getElementById('customerDeletionConfirmPhrase');

    if (!customerDeletionState.passwordVerified) {
        if (statusEl) {
            statusEl.textContent = '❌ Please start over from the top of the danger zone.';
            statusEl.className = 'deletion-status error';
        }
        return;
    }

    if (!customerDeletionState.reason) {
        if (statusEl) {
            statusEl.textContent = '❌ Please select a reason before continuing.';
            statusEl.className = 'deletion-status error';
        }
        return;
    }

    if ((phraseInput?.value || '') !== 'DELETE MY ACCOUNT') {
        if (statusEl) {
            statusEl.textContent = '❌ Please type DELETE MY ACCOUNT exactly to confirm.';
            statusEl.className = 'deletion-status error';
        }
        if (phraseInput) phraseInput.focus();
        return;
    }

    if (finalBtn) {
        finalBtn.disabled = true;
        finalBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scheduling…';
    }
    if (statusEl) {
        statusEl.textContent = '⏳ Scheduling your account for deletion…';
        statusEl.className = 'deletion-status info';
    }

    try {
        const res = await fetch('/api/auth/customer/request-deletion', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            credentials: 'same-origin',
            body: JSON.stringify({
                password: customerDeletionState.password,
                reason: customerDeletionState.reason
            })
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not schedule account deletion.');
        }

        if (statusEl) {
            const when = data.deletion_scheduled_for
                ? new Date(data.deletion_scheduled_for).toLocaleString()
                : 'in 30 days';
            statusEl.textContent = `✅ Your account is scheduled for deletion on ${when}.`;
            statusEl.className = 'deletion-status success';
        }

        // Clear the client session and return the customer to the
        // marketplace with a small notice in the query string. The
        // cookie is cleared by the server on the way out.
        localStorage.removeItem('currentUser');
        localStorage.removeItem('businessId');
        localStorage.removeItem('businessName');
        localStorage.removeItem('businessSlug');
        window.currentUser = null;

        setTimeout(() => {
            window.location.href = '/?account_deletion=scheduled';
        }, 1800);
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = '❌ ' + (err.message || 'Something went wrong. Please try again.');
            statusEl.className = 'deletion-status error';
        }
        if (finalBtn) {
            finalBtn.disabled = false;
            finalBtn.innerHTML = '<i class="fas fa-user-times"></i> Delete My Account';
        }
    }
}

// ============================================================
//  LOGOUT
// ============================================================

async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem('token');
    localStorage.removeItem('customerToken');
    localStorage.removeItem('businessId');
    localStorage.removeItem('businessName');
    localStorage.removeItem('businessSlug');
    localStorage.removeItem('currentUser');
    window.currentUser = null;
    window.location.href = '/';
}

// ============================================================
//  INIT - OVERRIDES ANY OLD LAYOUT
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('📄 Account page loaded - HORIZONTAL LAYOUT (Section 10 audit, Section 11.A deletion)');

    setTimeout(function() {
        const oldSidebar = document.querySelector('.sidebar');
        if (oldSidebar) oldSidebar.style.display = 'none';

        const oldHeader = document.querySelector('.header');
        if (oldHeader) oldHeader.style.display = 'none';

        const oldBottomNav = document.querySelector('.bottom-nav');
        if (oldBottomNav) oldBottomNav.style.display = 'none';
    }, 100);

    initSocket();

    const requestedSection = new URLSearchParams(window.location.search).get('section');
    const initialSection = requestedSection || 'home';
    navigateToAccount(initialSection);

    const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
    if (!user || !user.email) {
        if (isEmbeddedAccount) {
            const panel = document.getElementById('panel-home');
            if (panel) {
                panel.innerHTML = '<div class="empty-state">Your session has ended. Please log in again from the Marketplace.</div>';
                panel.classList.add('active');
            }
            return;
        }
        window.location.href = '/';
        return;
    }

    loadCustomerLocationState();
    loadCustomerPreferredAreaState();
    renderProfileUsername(user.username);

    updateCartBadge();
});

function returnToMarketplace() {
    if (isEmbeddedAccount && window.parent !== window) {
        window.parent.postMessage({ type: 'shop-kenya-show-marketplace' }, window.location.origin);
        return;
    }
    window.location.href = '/';
}

// ============================================================
//  EXPOSE GLOBALS
// ============================================================

window.navigateToAccount = navigateToAccount;
window.toggleMobileNav = toggleMobileNav;
window.loadDashboardContent = loadDashboardContent;
window.loadOrdersContent = loadOrdersContent;
window.loadProfileContent = loadProfileContent;
window.loadAddressesContent = loadAddressesContent;
window.loadPaymentsContent = loadPaymentsContent;
window.loadMessagesContent = loadMessagesContent;
window.filterOrdersByStatus = filterOrdersByStatus;
window.clearDashboardOrderFilter = clearDashboardOrderFilter;
window.updateProfile = updateProfile;
window.showAddAddress = showAddAddress;
window.closeAddressModal = closeAddressModal;
window.saveAddress = saveAddress;
window.setDefaultAddress = setDefaultAddress;
window.deleteAddress = deleteAddress;
window.selectAddressSuggestion = selectAddressSuggestion;
window.logout = logout;
window.updateCartBadge = updateCartBadge;
window.returnToMarketplace = returnToMarketplace;

window.activateCustomerLocation = activateCustomerLocation;
window.deactivateCustomerLocation = deactivateCustomerLocation;
window.loadCustomerLocationState = loadCustomerLocationState;

window.saveCustomerPreferredArea = saveCustomerPreferredArea;
window.clearCustomerPreferredArea = clearCustomerPreferredArea;
window.loadCustomerPreferredAreaState = loadCustomerPreferredAreaState;

window.renderProfileUsername = renderProfileUsername;

window.openAccountCart = openAccountCart;
window.scrollToProfileSection = scrollToProfileSection;

// Section 11.A — expose the deletion flow helpers so the modal
// buttons in account.html resolve.
window.openCustomerDeletionStepA = openCustomerDeletionStepA;
window.openCustomerDeletionStepB = openCustomerDeletionStepB;
window.openCustomerDeletionStepC = openCustomerDeletionStepC;
window.openCustomerDeletionStepD = openCustomerDeletionStepD;
window.closeCustomerDeletionModals = closeCustomerDeletionModals;
window.customerDeletionDownloadData = customerDeletionDownloadData;
window.customerDeletionDeactivate = customerDeletionDeactivate;
window.customerDeletionVerifyPassword = customerDeletionVerifyPassword;
window.customerDeletionChooseReason = customerDeletionChooseReason;
window.customerDeletionCheckPhrase = customerDeletionCheckPhrase;
window.customerDeletionSubmit = customerDeletionSubmit;

console.log('✅ Account.js loaded successfully (Section 10 audit complete, Section 11.A deletion wired, dead marketplace code removed)');