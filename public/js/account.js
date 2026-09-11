// ============================================================
//  ACCOUNT PAGE JAVASCRIPT - HORIZONTAL LAYOUT
//  Location: public/js/account.js
//
//  Section D — Customer location:
//   D.1  — "Activate your location to find businesses near you"
//          section lives in the profile panel; handlers here.
//   D.2  — Coordinates are saved against the customer's own row.
//   D.10 — "Turn off location sharing" clears coordinates.
//   D.12 — "Refresh Location" re-activates with the current GPS.
//
//  Section E.2 / G.3 — Preferred area:
//   A customer who chooses not to share GPS can set a preferred
//   area instead. The block lives in the profile panel, next to
//   the location card. These names are used by the search handler
//   as a soft anchor (E.4) and are never shared with any business.
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
let currentSection = 'dashboard';
let allBusinessesAccount = [];
let featuredBusinessesAccount = [];
let currentPageAccount = 1;
let hasMoreAccount = true;
let isLoadingAccount = false;
const limitAccount = 6;

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

    document.querySelectorAll('.account-nav-horizontal .nav-item').forEach(el => {
        el.classList.remove('active');
    });
    const navItem = document.querySelector(`.account-nav-horizontal .nav-item[data-section="${section}"]`);
    if (navItem) navItem.classList.add('active');

    document.querySelectorAll('.account-content-panel').forEach(el => {
        el.classList.remove('active');
    });
    const panel = document.getElementById(`panel-${section}`);
    if (panel) panel.classList.add('active');

    currentSection = section;

    switch(section) {
        case 'dashboard':
            loadDashboardContent();
            break;
        case 'orders':
            loadOrdersContent();
            break;
        case 'profile':
            loadProfileContent();
            loadCustomerLocationState();
            loadCustomerPreferredAreaState();
            break;
        case 'addresses':
            loadAddressesContent();
            break;
        case 'payments':
            loadPaymentsContent();
            break;
        case 'cart':
            loadCartContent();
            break;
        case 'messages':
            loadMessagesContent();
            break;
    }
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
        if (currentSection === 'dashboard' || currentSection === 'orders') {
            loadDashboardContent();
            loadOrdersContent();
        }
    });
    socket.on('order-status-updated', () => {
        if (currentSection === 'dashboard' || currentSection === 'orders') {
            loadDashboardContent();
            loadOrdersContent();
        }
    });
    socket.on('payment-updated', () => {
        if (currentSection === 'dashboard' || currentSection === 'payments') {
            loadDashboardContent();
            loadPaymentsContent();
        }
    });
}

// ============================================================
//  DASHBOARD CONTENT
// ============================================================

function loadDashboardContent() {
    console.log('📊 Loading dashboard content...');

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
        console.error('Error loading dashboard:', err);
        document.getElementById('recentOrdersPanel').innerHTML =
            '<div class="empty-state"><span class="icon">⚠️</span> Error loading orders</div>';
        document.getElementById('statsGridPanel').innerHTML =
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

    const badge = document.getElementById('cartBadgeNav');
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
        document.getElementById('orderCountLabel').textContent = '(0 orders)';
        return;
    }

    let filtered = allOrders;
    if (currentFilterStatus && currentFilterStatus !== 'all') {
        filtered = allOrders.filter(o => o.status === currentFilterStatus);
    }

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state"><span class="icon">🔍</span> No orders with status: ${currentFilterStatus ? currentFilterStatus.replace('_', ' ').toUpperCase() : 'All'}</div>`;
        document.getElementById('orderCountLabel').textContent = '(0 orders)';
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

    document.getElementById('orderCountLabel').textContent = `(${filtered.length} orders)`;
}

// ============================================================
//  PROFILE CONTENT
// ============================================================

function loadProfileContent() {
    console.log('👤 Loading profile content...');
    const user = window.currentUser || JSON.parse(localStorage.getItem('currentUser') || '{}');

    const nameInput = document.getElementById('profileName');
    const emailInput = document.getElementById('profileEmail');
    const phoneInput = document.getElementById('profilePhone');

    if (nameInput) nameInput.value = user.name || '';
    if (emailInput) emailInput.value = user.email || '';
    if (phoneInput) phoneInput.value = user.phone || '';

    // Section D — refresh the customer location card state.
    loadCustomerLocationState();

    // Section E.2 — refresh the preferred-area card state.
    loadCustomerPreferredAreaState();
}

function updateProfile() {
    const name = document.getElementById('profileName').value.trim();
    const email = document.getElementById('profileEmail').value.trim();
    const phone = document.getElementById('profilePhone').value.trim();
    const status = document.getElementById('profileStatus');

    if (!name || !email || !phone) {
        status.textContent = '❌ All fields are required.';
        status.style.color = '#ef4444';
        return;
    }

    fetch('/api/auth/customer/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name, email, phone })
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

/**
 * Render the current activation state on the profile card:
 *   - green badge when active, amber when inactive
 *   - swap between "Activate" and "Refresh" / "Turn off" buttons
 */
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

/**
 * D.1 / D.2 / D.12 — Ask the browser for precise GPS and save the
 * coordinates against the customer's own row.
 *
 * Used for both "Activate" and "Refresh" — the server treats the
 * second call as a refresh.
 */
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

/**
 * D.10 — Turn off location sharing.
 * Clears coordinates on the server and updates the card.
 *
 * Deliberately leaves the preferred area (E.2) untouched.
 */
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

/**
 * Load the customer's own activation state from the server and
 * render it. Safe to call on page load and on every profile visit.
 */
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
        // Silent — leaving the card in its default state is fine.
        renderCustomerLocationState();
    }
}

// ============================================================
//  SECTION E.2 / G.3 — CUSTOMER PREFERRED AREA
// ============================================================

/**
 * Render the preferred-area card.
 *  - Blue "Preferred area set" badge when at least one field is
 *    populated.
 *  - Inputs are populated from customerPreferredState.
 *  - Status message shows the last updated timestamp.
 */
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

/**
 * E.2 — Save the preferred-area names.
 * Reads the six inputs, posts them, and re-renders from the server
 * response so the UI always reflects what is actually stored.
 */
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

/**
 * E.2 — Clear the preferred-area names on the server and reset the
 * card.
 */
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

/**
 * E.2 — Load the customer's own preferred area from the server.
 * Safe to call on page load and on every profile visit.
 */
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
        // Silent — leaving the card in its default state is fine.
        renderCustomerPreferredAreaState();
    }
}

// ============================================================
//  ADDRESSES CONTENT
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
//  PAYMENTS CONTENT
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
//  CART CONTENT
// ============================================================

function loadCartContent() {
    console.log('🛒 Loading cart content...');
    const container = document.getElementById('cartPanelContent');
    if (!container) return;

    const cart = getCart();

    if (!cart || cart.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="icon">🛒</span> Your cart is empty.</div>';
        document.getElementById('cartCountLabel').textContent = '(0 items)';
        return;
    }

    let total = 0;
    let html = '';

    cart.forEach(item => {
        const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
        const subtotal = priceNum * item.quantity;
        total += subtotal;
        const variantName = item.variant_name && item.variant_name !== 'Default' ? ` (${item.variant_name})` : '';
        const imageUrl = item.image || '';

        html += `
            <div class="cart-item-panel">
                <div class="product-image">
                    <img src="${imageUrl}" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2280%22 viewBox=%220 0 80 80%22%3E%3Crect width=%2280%22 height=%2280%22 fill=%22%23e2e8f0%22/%3E%3Ctext x=%2240%22 y=%2245%22 font-family=%22sans-serif%22 font-size=%2220%22 text-anchor=%22middle%22 fill=%22%2394a3b8%22%3E📦%3C/text%3E%3C/svg%3E'">
                </div>
                <div class="details">
                    <div class="name">${item.name}${variantName}</div>
                    <div class="price">${item.price}</div>
                </div>
                <div class="qty">Qty: ${item.quantity}</div>
                <div style="font-weight:700; color:#2563eb;">Ksh ${subtotal.toFixed(2)}</div>
            </div>
        `;
    });

    html += `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-top:2px solid #e2e8f0; margin-top:8px;">
            <strong style="font-size:1.1rem;">Total: Ksh ${total.toFixed(2)}</strong>
            <button class="btn-quick primary" onclick="window.location.href='/cart.html'">
                <i class="fas fa-arrow-right"></i> Go to Cart
            </button>
        </div>
    `;

    container.innerHTML = html;
    document.getElementById('cartCountLabel').textContent = `(${cart.length} items)`;
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
            document.getElementById('messageBadgeNav').textContent = '0';
            document.getElementById('messageCountLabel').textContent = '(0 unread)';
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
        document.getElementById('messageCountLabel').textContent = `(${unread} unread)`;

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
//  MARKETPLACE FUNCTIONS INSIDE ACCOUNT
// ============================================================

async function loadMarketplaceAccount() {
    console.log('🏪 Loading marketplace in account...');
    await loadCategoriesAccount();
    await loadFeaturedBusinessesAccount();
    await loadBusinessesAccount(true);
}

async function loadCategoriesAccount() {
    try {
        const res = await fetch('/api/businesses/categories/all');
        if (!res.ok) throw new Error('Failed to load categories');
        const categories = await res.json();

        const select = document.getElementById('businessCategoryFilterAccount');
        if (select && categories.length > 0) {
            select.innerHTML = '<option value="all">All Business Categories</option>';
            categories.forEach(cat => {
                const option = document.createElement('option');
                option.value = cat.id;
                option.textContent = `${cat.icon || '📦'} ${cat.name}`;
                select.appendChild(option);
            });
        }
    } catch (err) {
        console.error('Error loading categories:', err);
    }
}

async function loadFeaturedBusinessesAccount() {
    try {
        const res = await fetch('/api/businesses?featured=true&limit=6&_=' + Date.now());
        if (!res.ok) throw new Error('Failed to load featured businesses');
        const data = await res.json();
        featuredBusinessesAccount = data.businesses || [];
        renderFeaturedBusinessesAccount();
    } catch (err) {
        console.error('Error loading featured businesses:', err);
        document.getElementById('featuredGridAccount').innerHTML =
            '<div class="empty-state" style="grid-column:1/-1;"><span class="icon">🏪</span> No featured businesses</div>';
    }
}

function renderFeaturedBusinessesAccount() {
    const container = document.getElementById('featuredGridAccount');
    if (!container) return;

    if (!featuredBusinessesAccount || featuredBusinessesAccount.length === 0) {
        container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><span class="icon">🏪</span> No featured businesses</div>';
        return;
    }

    container.innerHTML = featuredBusinessesAccount.map(b => createBusinessCardAccount(b)).join('');
}

async function loadBusinessesAccount(reset = true) {
    if (reset) {
        currentPageAccount = 1;
        hasMoreAccount = true;
        allBusinessesAccount = [];
    }
    if (isLoadingAccount || !hasMoreAccount) return;
    isLoadingAccount = true;

    const searchInput = document.getElementById('businessSearchAccount');
    let search = searchInput?.value?.trim() || '';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(search)) {
        search = '';
        if (searchInput) searchInput.value = '';
    }
    const category = document.getElementById('businessCategoryFilterAccount')?.value || 'all';
    const sort = document.getElementById('sortFilterAccount')?.value || 'newest';
    const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';

    try {
        const url = `/api/businesses?page=${currentPageAccount}&limit=${limitAccount}${searchParam}&category=${category}&sort=${sort}&_=${Date.now()}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to load businesses');
        const data = await res.json();
        const businesses = data.businesses || [];
        hasMoreAccount = data.pagination?.page < data.pagination?.pages;

        if (reset) {
            allBusinessesAccount = businesses;
            renderBusinessesAccount();
        } else {
            allBusinessesAccount = [...allBusinessesAccount, ...businesses];
            appendBusinessesAccount();
        }
        currentPageAccount++;

        const loadMoreBtn = document.getElementById('loadMoreBtnAccount');
        if (loadMoreBtn) {
            loadMoreBtn.style.display = hasMoreAccount ? 'inline-flex' : 'none';
        }
    } catch (err) {
        console.error('Error loading businesses:', err);
    } finally {
        isLoadingAccount = false;
    }
}

function renderBusinessesAccount() {
    const container = document.getElementById('businessGridAccount');
    if (!container) return;

    if (!allBusinessesAccount || allBusinessesAccount.length === 0) {
        container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><span class="icon">🔍</span> No businesses found</div>';
        return;
    }

    container.innerHTML = allBusinessesAccount.map(b => createBusinessCardAccount(b)).join('');
}

function appendBusinessesAccount() {
    const container = document.getElementById('businessGridAccount');
    if (!container) return;

    const start = Math.max(0, allBusinessesAccount.length - limitAccount);
    const newBusinesses = allBusinessesAccount.slice(start);
    const newHtml = newBusinesses.map(b => createBusinessCardAccount(b)).join('');
    container.innerHTML += newHtml;
}

function createBusinessCardAccount(business) {
    let slug = business.slug;
    if (!slug || slug === '' || slug === 'undefined' || slug === 'null') {
        slug = business.business_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if (business.id) slug = slug + '-' + business.id;
    }

    const logoHtml = business.logo
        ? `<img src="${business.logo}" alt="${business.business_name}" loading="lazy">`
        : `<div class="no-image">🏪</div>`;

    const rating = parseFloat(business.avg_rating) || 0;
    const ratingStars = rating > 0 ? '⭐'.repeat(Math.round(rating)) : '';
    const ratingDisplay = rating > 0 ? `<span>⭐ ${rating.toFixed(1)}</span>` : '';

    const badges = [];
    if (business.is_verified) badges.push('<span class="badge verified">✅ Verified</span>');
    if (business.is_featured) badges.push('<span class="badge featured">⭐ Featured</span>');

    const productCount = business.product_count || 0;
    const followerCount = business.follower_count || 0;

    return `
        <div class="business-card-account" onclick="window.location.href='/business/${encodeURIComponent(slug)}'">
            <div class="card-image">
                ${logoHtml}
                <div class="card-badges" style="position:absolute;top:8px;right:8px;display:flex;gap:4px;flex-wrap:wrap;">
                    ${badges.join('')}
                </div>
            </div>
            <div class="card-body">
                <div class="business-name">${business.business_name}</div>
                <div class="business-location">📍 ${business.location || 'Kenya'}</div>
                <div class="business-stats">
                    <span>🛍️ ${productCount}</span>
                    <span>👥 ${followerCount}</span>
                    ${ratingDisplay}
                </div>
            </div>
        </div>
    `;
}

function searchBusinessesAccount() {
    loadBusinessesAccount(true);
}

function filterBusinessesAccount() {
    loadBusinessesAccount(true);
}

function loadMoreBusinessesAccount() {
    loadBusinessesAccount(false);
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
    console.log('📄 Account page loaded - HORIZONTAL LAYOUT');

    setTimeout(function() {
        const oldSidebar = document.querySelector('.sidebar');
        if (oldSidebar) oldSidebar.style.display = 'none';

        const oldHeader = document.querySelector('.header');
        if (oldHeader) oldHeader.style.display = 'none';

        const oldBottomNav = document.querySelector('.bottom-nav');
        if (oldBottomNav) oldBottomNav.style.display = 'none';
    }, 100);

    initSocket();
    const marketplaceSearch = document.getElementById('businessSearchAccount');
    if (marketplaceSearch) {
        marketplaceSearch.value = '';
        marketplaceSearch.defaultValue = '';
        setTimeout(() => { marketplaceSearch.value = ''; }, 500);
    }
    document.getElementById('businessCategoryFilterAccount')?.addEventListener('change', filterBusinessesAccount);
    document.getElementById('sortFilterAccount')?.addEventListener('change', filterBusinessesAccount);

    // Load default section
    const section = new URLSearchParams(window.location.search).get('section');
    const validSections = ['dashboard', 'profile', 'orders', 'addresses', 'payments', 'cart', 'messages'];
    navigateToAccount(validSections.includes(section) ? section : 'dashboard');

    // Check auth
    const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
    if (!user || !user.email) {
        if (isEmbeddedAccount) {
            const panel = document.getElementById('panel-dashboard');
            if (panel) {
                panel.innerHTML = '<div class="empty-state">Your session has ended. Please log in again from the Marketplace.</div>';
                panel.classList.add('active');
            }
            return;
        }
        window.location.href = '/';
        return;
    }

    // Section D — prime the customer's location card state.
    loadCustomerLocationState();

    // Section E.2 — prime the preferred-area card state.
    loadCustomerPreferredAreaState();

    // The outer Marketplace remains the only business discovery surface in embedded mode.
    if (!isEmbeddedAccount) loadMarketplaceAccount();

    // Update cart badge
    updateCartBadge();
});

function returnToMarketplace() {
    if (isEmbeddedAccount && window.parent !== window) {
        window.parent.postMessage({ type: 'shop-kenya-show-marketplace' }, window.location.origin);
        return;
    }
    window.location.href = '/';
}

// Expose globals
window.navigateToAccount = navigateToAccount;
window.toggleMobileNav = toggleMobileNav;
window.loadDashboardContent = loadDashboardContent;
window.loadOrdersContent = loadOrdersContent;
window.loadProfileContent = loadProfileContent;
window.loadAddressesContent = loadAddressesContent;
window.loadPaymentsContent = loadPaymentsContent;
window.loadCartContent = loadCartContent;
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
window.searchBusinessesAccount = searchBusinessesAccount;
window.filterBusinessesAccount = filterBusinessesAccount;
window.loadMoreBusinessesAccount = loadMoreBusinessesAccount;
window.logout = logout;
window.updateCartBadge = updateCartBadge;
window.returnToMarketplace = returnToMarketplace;

// Section D — expose location handlers so the HTML buttons can call them.
window.activateCustomerLocation = activateCustomerLocation;
window.deactivateCustomerLocation = deactivateCustomerLocation;
window.loadCustomerLocationState = loadCustomerLocationState;

// Section E.2 — expose preferred-area handlers so the HTML buttons can call them.
window.saveCustomerPreferredArea = saveCustomerPreferredArea;
window.clearCustomerPreferredArea = clearCustomerPreferredArea;
window.loadCustomerPreferredAreaState = loadCustomerPreferredAreaState;

console.log('✅ Account.js loaded with horizontal layout');