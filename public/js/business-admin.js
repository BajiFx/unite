// ============================================================
//  BUSINESS ADMIN JAVASCRIPT - COMPLETE VERSION
//  Location: public/js/business-admin.js
//
//  B.1 — Product categories come from the database
//  B.3 — Picker shows only categories relevant to the business
//  B.4 — Picker is searchable (with visible match feedback)
//  B.5 — Product category is required before save
//  B.6 — Business admin can request new product categories
//  B.8 — Joined product category name shown on each product
//
//  Section B — missing-category warning
//   Every business admin load now checks /api/auth/my-business
//   for has_business_category. If false, a red banner and a red
//   dot on the Business Profile sidebar item are shown until the
//   admin assigns a category. This catches businesses that
//   registered before Section B and still have no category.
// ============================================================

// Check if running in embedded mode (inside dashboard panel)
const isEmbeddedBA = new URLSearchParams(window.location.search).get('embedded') === '1';

if (isEmbeddedBA) {
  document.addEventListener('DOMContentLoaded', function() {
    const header = document.querySelector('.admin-header');
    if (header) header.style.display = 'none';

    const mainContent = document.querySelector('.admin-main-content');
    if (mainContent) {
      mainContent.style.paddingTop = '10px';
      mainContent.style.maxWidth = '100%';
    }

    const sidebarToggle = document.querySelector('.embedded-sidebar-toggle');
    if (sidebarToggle) sidebarToggle.style.display = 'none';
  });
}

// ============================================================
//  GLOBALS
// ============================================================

let token = 'cookie-auth';
let businessData = null;
let currentSection = 'dashboard';
let ordersData = [];
let productsData = [];
let customersData = [];
let businessCategories = [];
let productCategories = [];
let socket = null;
let statsInterval = null;
let currentFilterStatus = null;
let variantCounter = 0;

function escapeHtml(value) {
    const element = document.createElement('div');
    element.textContent = String(value ?? '');
    return element.innerHTML;
}

// ============================================================
//  ORDER SETTINGS STATE
// ============================================================

let orderSettings = {
    online_orders_enabled: true,
    order_regions: 'Anywhere in Kenya',
    order_cutoff_time: '14:00',
    order_processing_time: '1-2 hours',
    auto_cancel_hours: 24,
    auto_complete_days: 7,
    replacement_hours: 6,
    status_pending: '📋 Your order is being reviewed.',
    status_pending_payment: '⏳ Awaiting payment confirmation.',
    status_confirmed: '✅ Your order is confirmed and being prepared.',
    status_shipped: '🚚 Your order is on the way!',
    status_delivered: '📦 Your order is ready for pickup. Please collect within 7 working days.',
    status_received: '✔️ You have confirmed receipt. Thank you!',
    status_cancelled: '❌ This order has been cancelled.',
    status_completed: '✅ Order completed. Thank you for shopping!',
    return_policy: 'Returns accepted within 14 days of delivery. Products must be in original condition.',
    return_window_days: 14
};

// ============================================================
//  DELIVERY SETTINGS STATE
// ============================================================

let deliverySettings = {
    offered: null,
    free: null,
    free_where: null,
    no_message: '',
    free_message: '',
    paid_message: '',
    days: 'within_3_days',
    fee_type: 'fixed',
    fee_fixed: 0,
    fee_per_km: 0,
    min_order_free: 0,
    max_distance: 50,
    time_slots: [],
    cutoff_time: '14:00',
    estimated_time: 'Same day (orders before 2pm)',
    policy: ''
};

// ============================================================
//  INIT
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('🔐 Business Admin loading...');
    verifyBusinessAccess();
});

// ============================================================
//  AUTH FUNCTIONS
// ============================================================

function showAccessDenied(title, message, buttonLink, buttonText) {
    const authCheck = document.getElementById('authCheck');
    const adminPanel = document.getElementById('businessAdminPanel');
    if (authCheck) authCheck.style.display = 'block';
    if (adminPanel) adminPanel.style.display = 'none';
    if (authCheck) {
        authCheck.innerHTML = `
            <i class="fas fa-exclamation-circle fa-3x" style="color:#ef4444;"></i>
            <h2 style="margin-top:12px;">${title}</h2>
            <p style="color:#64748b;">${message}</p>
            <div style="margin-top:16px; display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
                <a href="${buttonLink || '/'}" class="btn btn-primary" style="padding:10px 24px; border-radius:8px; text-decoration:none; background:#2563eb; color:white; font-weight:600;">
                    <i class="fas fa-arrow-right"></i> ${buttonText || 'Go to Homepage'}
                </a>
            </div>
        `;
    }
}

function showNoBusiness() {
    const authCheck = document.getElementById('authCheck');
    const adminPanel = document.getElementById('businessAdminPanel');
    if (authCheck) authCheck.style.display = 'block';
    if (adminPanel) adminPanel.style.display = 'none';
    if (authCheck) {
        authCheck.innerHTML = `
            <i class="fas fa-store fa-3x" style="color:#94a3b8;"></i>
            <h2 style="margin-top:12px;">No Business Found</h2>
            <p style="color:#64748b;">You don't own any business yet. Register your business to start selling.</p>
            <div style="margin-top:16px; display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
                <a href="/register-business.html" class="btn btn-success" style="padding:10px 24px; border-radius:8px; text-decoration:none; background:#22c55e; color:white; font-weight:600;">
                    <i class="fas fa-plus"></i> Register Your Business
                </a>
                <a href="/" class="btn btn-primary" style="padding:10px 24px; border-radius:8px; text-decoration:none; background:#2563eb; color:white; font-weight:600;">
                    <i class="fas fa-home"></i> Go to Homepage
                </a>
            </div>
        `;
    }
}

async function verifyBusinessAccess() {
    try {
        console.log('🔍 Verifying business access...');

        const res = await fetch('/api/auth/my-business', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        console.log('📡 Response status:', res.status);

        if (res.status === 401) {
            localStorage.removeItem('token');
            localStorage.removeItem('customerToken');
            showAccessDenied('Session Expired', 'Please login again.', '/business-login.html', 'Login');
            return;
        }

        if (!res.ok) {
            throw new Error(`Server returned ${res.status}`);
        }

        const data = await res.json();
        console.log('📦 Business data:', data);

        if (!data.business) {
            showNoBusiness();
            return;
        }

        businessData = data.business;
        document.getElementById('businessNameDisplay').textContent = businessData.business_name;
        document.getElementById('authCheck').style.display = 'none';
        document.getElementById('businessAdminPanel').style.display = 'block';

        const productBadge = document.querySelector('.menu-item[data-section="products"] .badge');
        if (productBadge) productBadge.textContent = businessData.product_count || 0;

        // Section B — warn / prompt if the business has no business category yet.
        // This catches businesses that registered before Section B and never
        // got a category assigned.
        applyCategoryWarning(data.has_business_category === true);

        initSocket();
        // Load business categories (for the multi-select) and product categories
        // (for the searchable picker) in parallel.
        await Promise.all([
            loadBusinessCategories(),
            loadProductCategories()
        ]);

        const section = new URLSearchParams(window.location.search).get('section');
        const validSections = ['dashboard', 'orders', 'customers', 'products', 'productcategories', 'profile', 'payments', 'delivery', 'ordersettings'];
        navigateTo(validSections.includes(section) ? section : 'dashboard');

        console.log('✅ Business admin initialized for:', businessData.business_name);

    } catch (err) {
        console.error('❌ Business access error:', err);
        showAccessDenied('Access Error', err.message || 'Failed to verify business access.', '/register-business.html', 'Register Business');
    }
}

// ============================================================
//  Section B — missing business-category warning
//  Renders a red banner at the top of the panel and a red dot on
//  the Business Profile sidebar item when the business has no
//  business category assigned. Removes both once one is set.
// ============================================================

function applyCategoryWarning(hasCategory) {
    const existing = document.getElementById('missingCategoryBanner');
    const profileItem = document.querySelector('.menu-item[data-section="profile"]');

    if (hasCategory) {
        if (existing) existing.remove();
        if (profileItem) {
            const dot = profileItem.querySelector('.menu-red-dot');
            if (dot) dot.remove();
        }
        return;
    }

    // Red dot on the sidebar "Business Profile" item
    if (profileItem && !profileItem.querySelector('.menu-red-dot')) {
        const dot = document.createElement('span');
        dot.className = 'menu-red-dot';
        dot.title = 'Action required';
        profileItem.appendChild(dot);
    }

    // Banner at the top of the main content
    if (!existing) {
        const banner = document.createElement('div');
        banner.id = 'missingCategoryBanner';
        banner.style.cssText = `
            background: #fef2f2;
            border: 1px solid #fca5a5;
            border-left: 4px solid #ef4444;
            color: #991b1b;
            padding: 14px 18px;
            border-radius: 10px;
            margin: 12px 20px 0;
            display: flex;
            gap: 12px;
            align-items: flex-start;
            font-size: 0.9rem;
        `;
        banner.innerHTML = `
            <span style="font-size:1.3rem; flex-shrink:0;">⚠️</span>
            <div style="flex:1;">
                <strong style="display:block; margin-bottom:4px;">Your business has no category yet</strong>
                <p style="margin:0 0 8px 0; color:#7f1d1d;">
                    Customers can't find your business by category, and your product picker will be empty.
                    Please pick at least one business category to continue.
                </p>
                <button type="button"
                        onclick="navigateTo('profile')"
                        style="background:#ef4444; color:white; border:none; padding:6px 14px; border-radius:6px; font-weight:600; cursor:pointer; font-size:0.8rem;">
                    Fix now
                </button>
            </div>
        `;
        const mainContent = document.getElementById('mainContent');
        if (mainContent) {
            mainContent.insertBefore(banner, mainContent.firstChild);
        }
    }
}

// ============================================================
//  SOCKET
// ============================================================

function initSocket() {
    if (socket) return;
    if (!token) return;

    try {
        socket = io({ auth: { token: token } });
        socket.on('new-order', function(data) {
            if (currentSection === 'dashboard' || currentSection === 'orders') {
                loadDashboard();
                loadOrders();
            }
            updateOrderBadge();
        });
        socket.on('order-status-updated', function(data) {
            if (currentSection === 'dashboard' || currentSection === 'orders') {
                loadDashboard();
                loadOrders();
            }
        });
        socket.on('new-order-chat-message', function(msg) {
            if (currentSection === 'orders') {
                loadOrders();
            }
        });
    } catch (err) {
        console.error('⚠️ Socket init error:', err);
    }
}

// ============================================================
//  SIDEBAR
// ============================================================

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (!sidebar) return;
    const isOpen = sidebar.classList.contains('open') && !sidebar.classList.contains('closed');
    if (isOpen) {
        closeSidebar();
        return;
    }
    sidebar.classList.remove('closed');
    sidebar.classList.add('open');
    if (overlay) overlay.classList.add('active');
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (sidebar) {
        sidebar.classList.remove('open');
        sidebar.classList.add('closed');
    }
    if (overlay) overlay.classList.remove('active');
}

function openMarketplaceMessages() {
    closeSidebar();
    if (window.top !== window && typeof window.top.openDashboardPanel === 'function') {
        window.top.openDashboardPanel('messages');
        return;
    }
    window.location.href = '/?workspace=messages';
}

function openPublicPreview() {
    if (!businessData || !businessData.slug) {
        showToast('Your public store is not ready yet.', 'warning');
        return;
    }
    window.open(`/business/${encodeURIComponent(businessData.slug)}?fromAdmin=1`, '_blank', 'noopener');
}

// ============================================================
//  NAVIGATE TO SECTION
// ============================================================

function navigateTo(section) {
    if (!businessData) {
        console.log('⚠️ No business data, cannot navigate');
        return;
    }

    document.querySelectorAll('.section').forEach(function(el) {
        el.classList.remove('active');
    });

    const target = document.getElementById('section-' + section);
    if (target) target.classList.add('active');

    document.querySelectorAll('.menu-item').forEach(function(el) {
        el.classList.remove('active');
    });

    const menuItem = document.querySelector('.menu-item[data-section="' + section + '"]');
    if (menuItem) menuItem.classList.add('active');

    const titles = {
        dashboard: 'Dashboard',
        orders: 'Orders',
        customers: 'Customers',
        products: 'Products',
        productcategories: 'Product Categories',
        profile: 'Business Profile',
        payments: 'Payment Settings',
        delivery: 'Delivery / Shipping',
        ordersettings: 'Order Settings'
    };

    const headerTitle = document.getElementById('headerTitle');
    if (headerTitle) headerTitle.textContent = titles[section] || 'Dashboard';

    currentSection = section;
    closeSidebar();

    switch (section) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'orders':
            loadOrders();
            break;
        case 'products':
            loadProducts();
            break;
        case 'productcategories':
            loadProductCategorySection();
            break;
        case 'customers':
            loadCustomers();
            break;
        case 'profile':
            loadBusinessProfile();
            break;
        case 'payments':
            loadPaymentSettings();
            break;
        case 'delivery':
            loadDeliverySettings();
            break;
        case 'ordersettings':
            loadOrderSettings();
            break;
    }
}

// ============================================================
//  DASHBOARD
// ============================================================

async function loadDashboard() {
    if (!businessData) {
        console.log('⚠️ No business data, cannot load dashboard');
        return;
    }

    try {
        const res = await fetch('/api/business-admin/analytics', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!res.ok) throw new Error('Failed to load dashboard');
        const data = await res.json();

        renderDashboardStats(data);
        renderRecentOrders(data);
        updateOrderBadge();

    } catch (err) {
        console.error('❌ Dashboard error:', err);
        const statsGrid = document.getElementById('statsGrid');
        if (statsGrid) {
            statsGrid.innerHTML = `
                <p style="color:#ef4444;text-align:center;padding:20px;grid-column:1/-1;">
                    Error loading dashboard: ${err.message}
                </p>
            `;
        }
    }
}

// ============================================================
//  BUSINESS CATEGORIES (multi-select on the business profile form)
// ============================================================

async function loadBusinessCategories() {
    try {
        const response = await fetch('/api/business-admin/categories', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) throw new Error('Unable to load categories');
        businessCategories = await response.json();

        // Fill the business-category picker used by the product-category request form
        const requestCategorySelect = document.getElementById('requestCategoryBusinessCategory');
        if (requestCategorySelect) {
            requestCategorySelect.innerHTML = '<option value="">Leave blank for a generic category</option>' +
                businessCategories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
        }
    } catch (error) {
        console.error('Business category loading error:', error);
    }
}

function populateBusinessCategorySelect(selectedCategories) {
    const select = document.getElementById('businessCategories');
    if (!select || !businessCategories.length) return;
    const selectedIds = new Set((selectedCategories || []).map(category => Number(category.id)));
    select.innerHTML = businessCategories.map(category =>
        `<option value="${category.id}" ${selectedIds.has(Number(category.id)) ? 'selected' : ''}>${escapeHtml(category.name)}</option>`
    ).join('');
}

function filterBusinessCategoryOptions() {
    const query = (document.getElementById('businessCategorySearch')?.value || '').toLowerCase();
    document.querySelectorAll('#businessCategories option').forEach(option => {
        option.hidden = !!query && !option.textContent.toLowerCase().includes(query);
    });
}

// ============================================================
//  PRODUCT CATEGORIES — load, cache, filter, render
//  B.1 / B.3 / B.4
// ============================================================

async function loadProductCategories(forceReload = false) {
    // Reset the cache on force reload.
    if (forceReload) productCategories = [];

    // If we already have the list, just refresh the UI.
    if (productCategories.length > 0) {
        populateProductCategoryPickers();
        renderProductCategoriesList();
        return;
    }

    try {
        const res = await fetch('/api/business-admin/product-categories', {
            headers: { 'Authorization': `Bearer ${token}`, 'Cache-Control': 'no-store' }
        });

        if (!res.ok) throw new Error(`Failed to load product categories (${res.status})`);
        productCategories = await res.json();

        populateProductCategoryPickers();
        renderProductCategoriesList();
    } catch (err) {
        console.error('❌ Product categories error:', err);
        const msg = '<option value="">❌ Categories could not be loaded</option>';
        ['pProductCategory', 'bulkProductCategory'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = msg;
        });
    }
}

function populateProductCategoryPickers() {
    const optionsHtml = '<option value="">Select a product category...</option>' +
        productCategories.map(c => {
            const label = `${c.icon || '📦'} ${c.name}${c.business_category_name ? ` · ${c.business_category_name}` : ''}`;
            return `<option value="${c.id}">${escapeHtml(label)}</option>`;
        }).join('');

    ['pProductCategory', 'bulkProductCategory'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = optionsHtml;
    });
}

/**
 * B.4 — Searchable picker.
 *
 * scope = 'single' (default) filters the single-product picker.
 * scope = 'bulk'             filters the bulk picker.
 *
 * Behaviour:
 *  - Filters productCategories by name / business_category_name / slug.
 *  - Rebuilds the option list in place.
 *  - Shows a status line as the first option while filtering
 *    (e.g. "5 matches — pick one below" or "No categories match your search"),
 *    so the user can SEE that the search is doing something.
 *  - Auto-selects the single match, if exactly one, so a keystroke is actionable.
 *  - Restores the previous value if it survives the filter.
 *  - Updates the helper text under the picker with the match count.
 */
function filterProductCategoryOptions(scope = 'single') {
    const input = scope === 'bulk'
        ? document.getElementById('bulkProductCategorySearch')
        : document.getElementById('pProductCategorySearch');
    const select = scope === 'bulk'
        ? document.getElementById('bulkProductCategory')
        : document.getElementById('pProductCategory');
    if (!input || !select) return;

    const query = input.value.trim().toLowerCase();
    const currentValue = select.value;

    const filtered = (productCategories || []).filter(c => {
        if (!query) return true;
        const haystack = `${c.name || ''} ${c.business_category_name || ''} ${c.slug || ''}`.toLowerCase();
        return haystack.includes(query);
    });

    // Status line for the first <option>. This is what makes the search
    // feel responsive — without it, filtering alone is invisible.
    let statusLabel = 'Select a product category...';
    if (query && filtered.length === 0) {
        statusLabel = 'No categories match your search';
    } else if (query && filtered.length === 1) {
        statusLabel = '1 match — select below';
    } else if (query) {
        statusLabel = `${filtered.length} matches — pick one below`;
    }

    const optionsHtml = `<option value="">${escapeHtml(statusLabel)}</option>` +
        filtered.map(c => {
            const label = `${c.icon || '📦'} ${c.name}${c.business_category_name ? ` · ${c.business_category_name}` : ''}`;
            return `<option value="${c.id}">${escapeHtml(label)}</option>`;
        }).join('');

    select.innerHTML = optionsHtml;

    // If there's exactly one match and the user is searching, auto-select it.
    if (query && filtered.length === 1) {
        select.value = String(filtered[0].id);
    } else if (currentValue && filtered.some(c => String(c.id) === String(currentValue))) {
        select.value = currentValue;
    }

    // Update the helper text under the single-product picker.
    if (scope === 'single') {
        const help = document.getElementById('pProductCategoryHelp');
        if (help) {
            if (query) {
                help.textContent = `${filtered.length} categor${filtered.length === 1 ? 'y' : 'ies'} match "${query}"`;
            } else {
                help.innerHTML = `Pick from the platform's defined product categories. Can't find yours? <a href="#" onclick="navigateTo('productcategories'); return false;">Request a new category</a>.`;
            }
        }
    }
}

function renderProductCategoriesList() {
    const container = document.getElementById('productCategoriesList');
    if (!container) return;

    if (!productCategories.length) {
        container.innerHTML = '<p class="empty-msg">No product categories are available for your business yet.</p>';
        return;
    }

    // Group by business category so the list is easy to scan.
    const groups = new Map();
    productCategories.forEach(cat => {
        const key = cat.business_category_name || 'General';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(cat);
    });

    let html = '';
    for (const [businessCategoryName, cats] of groups) {
        html += `<div style="margin-bottom:14px;">`;
        html += `<h4 style="font-size:0.85rem; font-weight:700; color:#0f172a; margin:0 0 6px 0;">${escapeHtml(businessCategoryName)}</h4>`;
        html += `<div style="display:flex; flex-wrap:wrap; gap:6px;">`;
        cats.forEach(cat => {
            html += `
                <span style="display:inline-flex; align-items:center; gap:6px; padding:4px 12px; background:#f1f5f9; border-radius:20px; font-size:0.75rem; color:#334155;">
                    <span>${escapeHtml(cat.icon || '📦')}</span>
                    <span>${escapeHtml(cat.name)}</span>
                    ${cat.is_requested ? '<span style="background:#fef3c7; color:#92400e; padding:0 8px; border-radius:10px; font-size:0.6rem; font-weight:700;">PENDING</span>' : ''}
                    ${cat.product_count ? `<span style="color:#94a3b8;">· ${cat.product_count}</span>` : ''}
                </span>
            `;
        });
        html += `</div></div>`;
    }
    container.innerHTML = html;
}

/**
 * Called when the user navigates to the Product Categories section.
 * Refreshes the business-category dropdown in the request form and
 * re-renders the list.
 */
function loadProductCategorySection() {
    if (!businessCategories.length) {
        loadBusinessCategories().then(loadProductCategorySection);
        return;
    }
    loadProductCategories().then(() => {
        renderProductCategoriesList();
    });
}

/**
 * B.6 — Submit a new product category request.
 */
async function submitProductCategoryRequest() {
    const nameInput = document.getElementById('requestCategoryName');
    const descriptionInput = document.getElementById('requestCategoryDescription');
    const businessCategorySelect = document.getElementById('requestCategoryBusinessCategory');
    const statusEl = document.getElementById('requestCategoryStatus');

    if (!nameInput) return;

    const name = nameInput.value.trim();
    if (!name || name.length < 2) {
        if (statusEl) {
            statusEl.textContent = '❌ Please enter a category name (at least 2 characters).';
            statusEl.style.color = '#ef4444';
        }
        nameInput.focus();
        return;
    }

    const payload = {
        name,
        description: descriptionInput?.value.trim() || undefined,
        business_category_id: businessCategorySelect?.value ? parseInt(businessCategorySelect.value, 10) : undefined
    };

    if (statusEl) {
        statusEl.textContent = '⏳ Submitting request...';
        statusEl.style.color = '#2563eb';
    }

    try {
        const res = await fetch('/api/business-admin/product-categories/request', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.status === 202) {
            if (statusEl) {
                statusEl.textContent = '⏳ ' + (data.message || 'That category is already awaiting approval.');
                statusEl.style.color = '#f59e0b';
            }
            return;
        }

        if (!res.ok) {
            throw new Error(data.error || 'Failed to submit request');
        }

        if (statusEl) {
            statusEl.textContent = '✅ ' + (data.message || 'Request submitted. It will be available once approved.');
            statusEl.style.color = '#16a34a';
        }
        showToast('✅ Product category request submitted!', 'success');

        nameInput.value = '';
        if (descriptionInput) descriptionInput.value = '';
        if (businessCategorySelect) businessCategorySelect.value = '';

        // Force a fresh fetch so the pending row shows up right away.
        await loadProductCategories(true);
    } catch (err) {
        console.error('❌ Product category request error:', err);
        if (statusEl) {
            statusEl.textContent = '❌ ' + err.message;
            statusEl.style.color = '#ef4444';
        }
        showToast('❌ ' + err.message, 'error');
    }
}

// ============================================================
//  DASHBOARD STATS / RECENT ORDERS / BADGES
// ============================================================

function renderDashboardStats(data) {
    const grid = document.getElementById('statsGrid');
    if (!grid) return;

    const stats = data.stats || {};
    const statuses = data.orderStatuses || [];

    const statusCounts = {};
    statuses.forEach(s => { statusCounts[s.status] = s.count; });

    const items = [
        { key: 'total_orders', label: 'Total Orders', icon: 'fa-shopping-bag', css: 'total' },
        { key: 'total_revenue', label: 'Revenue (Ksh)', icon: 'fa-money-bill-wave', css: 'revenue' },
        { key: 'total_products', label: 'Products', icon: 'fa-tag', css: 'total' },
        { key: 'total_followers', label: 'Followers', icon: 'fa-users', css: 'total' },
        { key: 'average_rating', label: 'Rating', icon: 'fa-star', css: 'total' }
    ];

    const statusItems = [
        { key: 'pending', label: 'Pending', icon: 'fa-clock', css: 'pending' },
        { key: 'pending_payment', label: 'Awaiting Payment', icon: 'fa-hourglass-half', css: 'pending_payment' },
        { key: 'confirmed', label: 'Confirmed', icon: 'fa-check-circle', css: 'confirmed' },
        { key: 'shipped', label: 'Shipped', icon: 'fa-truck', css: 'shipped' },
        { key: 'delivered', label: 'Awaiting Pickup', icon: 'fa-box-open', css: 'delivered' },
        { key: 'received', label: 'Received', icon: 'fa-check-double', css: 'received' },
        { key: 'cancelled', label: 'Cancelled', icon: 'fa-times-circle', css: 'cancelled' }
    ];

    let html = '<div class="stats-grid">';

    items.forEach(function(item) {
        let value = stats[item.key] || 0;
        if (item.key === 'total_revenue') value = 'Ksh ' + parseFloat(value).toFixed(2);
        if (item.key === 'average_rating') value = parseFloat(value).toFixed(1) + ' ⭐';
        html += `
            <div class="stat-link ${item.css}" style="cursor:default;">
                <span class="stat-icon"><i class="fas ${item.icon}"></i></span>
                <span class="stat-content">
                    <span class="stat-value">${value}</span>
                    <span class="stat-label">${item.label}</span>
                </span>
            </div>
        `;
    });

    statusItems.forEach(function(item) {
        const count = statusCounts[item.key] || 0;
        const isPending = ['pending_payment', 'pending', 'delivered'].includes(item.key);
        const blink = (count > 0 && isPending) ? '<span class="stat-blink"></span>' : '<span class="stat-blink hidden"></span>';
        const active = (currentFilterStatus === item.key) ? 'active' : '';
        html += `
            <div class="stat-link ${item.css} ${active}" data-status="${item.key}" onclick="filterOrdersByStatus('${item.key}')" style="cursor:pointer;">
                <span class="stat-icon"><i class="fas ${item.icon}"></i></span>
                <span class="stat-content">
                    <span class="stat-value">${count}</span>
                    <span class="stat-label">${item.label} ${blink}</span>
                </span>
            </div>
        `;
    });

    html += '</div>';
    grid.innerHTML = html;
}

function renderRecentOrders(data) {
    const container = document.getElementById('recentOrdersContainer');
    if (!container) return;

    const revenue = data.revenue || [];
    const recent = revenue.slice(-5).reverse();

    if (!recent || recent.length === 0) {
        container.innerHTML = '<p class="empty-msg">No recent orders.</p>';
        return;
    }

    container.innerHTML = recent.map(order => `
        <div class="order-row">
            <div class="order-header">
                <span class="ref">${order.date || 'N/A'}</span>
                <span class="customer">${order.orders || 0} orders</span>
                <span class="total">Ksh ${parseFloat(order.revenue || 0).toFixed(2)}</span>
            </div>
        </div>
    `).join('');
}

function updateOrderBadge() {
    const badge = document.querySelector('.menu-item[data-section="orders"] .badge');
    if (badge) {
        fetch('/api/business-admin/orders?status=pending', {
            headers: { 'Authorization': `Bearer ${token}` }
        })
        .then(res => res.json())
        .then(orders => { if (Array.isArray(orders)) badge.textContent = orders.length; })
        .catch(() => { badge.textContent = '0'; });
    }
}

// ============================================================
//  FILTER ORDERS BY STATUS
// ============================================================

function filterOrdersByStatus(status) {
    currentFilterStatus = status;

    document.querySelectorAll('#statsGrid .stat-link').forEach(function(link) {
        link.classList.toggle('active', link.dataset.status === status);
    });

    const dropdown = document.getElementById('orderFilterStatus');
    if (dropdown) dropdown.value = status;

    navigateTo('orders');
    loadOrders();
}

// ============================================================
//  ORDERS
// ============================================================

async function loadOrders() {
    if (!businessData) return;

    const container = document.getElementById('ordersListContainer');
    if (container) container.innerHTML = '<p class="empty-msg">Loading orders...</p>';

    try {
        const status = document.getElementById('orderFilterStatus')?.value || 'all';
        const search = document.getElementById('orderFilterSearch')?.value || '';

        let finalStatus = status;
        if (currentFilterStatus && currentFilterStatus !== 'all') {
            finalStatus = currentFilterStatus;
            const dropdown = document.getElementById('orderFilterStatus');
            if (dropdown) dropdown.value = currentFilterStatus;
        }

        let url = '/api/business-admin/orders?';
        if (finalStatus !== 'all') url += `status=${finalStatus}&`;
        if (search) url += `search=${encodeURIComponent(search)}&`;

        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) throw new Error('Failed to load orders');
        const orders = await res.json();
        ordersData = orders;

        if (!orders || orders.length === 0) {
            const statusDisplay = currentFilterStatus ? currentFilterStatus.replace('_', ' ').toUpperCase() : 'All';
            if (container) container.innerHTML = `<p class="empty-msg">No orders with status: ${statusDisplay}</p>`;
            return;
        }

        let html = '';
        orders.forEach(function(order) {
            const actionsHtml = getOrderActions(order);
            const statusClass = order.status || 'pending';
            const statusLabel = order.status.replace('_', ' ').toUpperCase();

            let deliveryInfo = '';
            if (order.delivery_method) {
                const methodLabels = { 'delivery': '🚚 Delivery', 'pickup': '📍 Pickup', 'chat': '💬 Chat' };
                deliveryInfo = `<span style="font-size:0.6rem; color:#64748b; margin-left:8px;">${methodLabels[order.delivery_method] || order.delivery_method}</span>`;
            }

            html += `
                <div class="order-row">
                    <div class="order-header">
                        <span class="ref">${order.order_ref || `#${order.id}`}</span>
                        <span class="customer">${order.customer_name || 'Guest'}</span>
                        <span class="date">${new Date(order.created_at).toLocaleString()}</span>
                        <span class="total">Ksh ${parseFloat(order.total).toFixed(2)}</span>
                        <span class="status-badge status-${statusClass}">${statusLabel}</span>
                        ${deliveryInfo}
                    </div>
                    <div class="order-actions">${actionsHtml}</div>
                </div>
            `;
        });

        if (container) container.innerHTML = html;

    } catch (err) {
        console.error('❌ Orders error:', err);
        if (container) container.innerHTML = `<p class="empty-msg">Error loading orders: ${err.message}</p>`;
    }
}

function getOrderActions(order) {
    let actions = '';
    let statusOptions = '';
    if (order.status === 'pending') statusOptions = `<option value="confirmed">Confirm</option><option value="shipped">Ship</option>`;
    else if (order.status === 'confirmed') statusOptions = `<option value="shipped">Ship</option>`;
    else if (order.status === 'shipped') statusOptions = `<option value="delivered">Deliver</option>`;
    else if (order.status === 'delivered') statusOptions = `<option value="received">Mark Received</option>`;

    if (statusOptions) {
        actions += `
            <select id="statusSelect-${order.id}" style="padding:4px; border:1px solid #d1d5db; border-radius:4px; font-size:0.7rem;">
                <option value="">Update...</option>
                ${statusOptions}
            </select>
            <button class="btn btn-primary btn-sm" onclick="updateOrderStatus(${order.id})">Update</button>
        `;
    }
    if (order.status === 'pending') actions += `<button class="btn btn-confirm btn-sm" onclick="confirmOrder(${order.id})">Confirm</button>`;
    if (order.status === 'delivered') actions += `<button class="btn btn-primary btn-sm" onclick="markReceived(${order.id})">Mark Received</button>`;
    if (['pending', 'confirmed', 'pending_payment'].includes(order.status)) {
        actions += `<button class="btn btn-danger btn-sm" onclick="cancelOrder(${order.id})">Cancel</button>`;
    }
    if (order.refund_status === 'pending') {
        actions += `
            <button class="btn btn-success btn-sm" onclick="handleRefund(${order.id},'approve')">Approve Refund</button>
            <button class="btn btn-danger btn-sm" onclick="handleRefund(${order.id},'reject')">Reject</button>
        `;
    }
    return actions || '<span style="font-size:0.6rem;color:#94a3b8;">No actions</span>';
}

// ============================================================
//  ORDER ACTIONS
// ============================================================

async function updateOrderStatus(orderId) {
    const select = document.getElementById(`statusSelect-${orderId}`);
    if (!select) return;
    const status = select.value;
    if (!status) return;
    if (!confirm(`Update order to ${status.toUpperCase()}?`)) return;

    try {
        const res = await fetch(`/api/business-admin/orders/${orderId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ status })
        });
        const data = await res.json();
        if (data.success) { alert('✅ Order status updated'); loadOrders(); loadDashboard(); }
        else alert('❌ ' + (data.error || 'Failed to update'));
    } catch (err) { alert('❌ Network error'); }
}

async function confirmOrder(orderId) {
    if (!confirm('Confirm this order?')) return;
    try {
        const res = await fetch(`/api/business-admin/orders/${orderId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ status: 'confirmed' })
        });
        const data = await res.json();
        if (data.success) { alert('✅ Order confirmed'); loadOrders(); loadDashboard(); }
        else alert('❌ ' + (data.error || 'Failed to confirm'));
    } catch (err) { alert('❌ Network error'); }
}

async function markReceived(orderId) {
    if (!confirm('Mark this order as received?')) return;
    try {
        const res = await fetch(`/api/business-admin/orders/${orderId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ status: 'received' })
        });
        const data = await res.json();
        if (data.success) { alert('✅ Order marked as received'); loadOrders(); loadDashboard(); }
        else alert('❌ ' + (data.error || 'Failed to update'));
    } catch (err) { alert('❌ Network error'); }
}

async function cancelOrder(orderId) {
    const reason = prompt('Cancellation reason:');
    if (!reason) return;
    if (!confirm('Cancel this order?')) return;
    try {
        const res = await fetch(`/api/business-admin/orders/${orderId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ status: 'cancelled' })
        });
        const data = await res.json();
        if (data.success) { alert('✅ Order cancelled'); loadOrders(); loadDashboard(); }
        else alert('❌ ' + (data.error || 'Failed to cancel'));
    } catch (err) { alert('❌ Network error'); }
}

async function handleRefund(orderId, action) {
    if (!confirm(`${action === 'approve' ? 'Approve' : 'Reject'} refund?`)) return;
    try {
        const res = await fetch(`/api/admin/orders/${orderId}/refund`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ action })
        });
        const data = await res.json();
        if (data.success) { alert(`✅ Refund ${action}d.`); loadOrders(); loadDashboard(); }
        else alert('❌ ' + (data.error || 'Failed to process refund'));
    } catch (err) { alert('❌ Network error'); }
}

function filterOrders() {
    const dropdownStatus = document.getElementById('orderFilterStatus')?.value || 'all';
    if (dropdownStatus === 'all') {
        currentFilterStatus = null;
        document.querySelectorAll('#statsGrid .stat-link').forEach(link => link.classList.remove('active'));
    } else {
        currentFilterStatus = dropdownStatus;
        document.querySelectorAll('#statsGrid .stat-link').forEach(link => {
            link.classList.toggle('active', link.dataset.status === dropdownStatus);
        });
    }
    loadOrders();
}

// ============================================================
//  PRODUCTS
// ============================================================

async function loadProducts() {
    if (!businessData) return;

    const list = document.getElementById('productList');
    if (list) list.innerHTML = '<p style="color:#94a3b8;">Loading products...</p>';

    try {
        const res = await fetch('/api/business-admin/products', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!res.ok) throw new Error('Failed to load products');
        const products = await res.json();
        productsData = products;

        if (!products || products.length === 0) {
            if (list) list.innerHTML = '<p style="color:#94a3b8; padding:10px 0;">No products yet. Add your first product above.</p>';
            return;
        }

        const badge = document.querySelector('.menu-item[data-section="products"] .badge');
        if (badge) badge.textContent = products.length;

        let html = '';
        products.forEach(function(p) {
            const categoryLabel = p.product_category_name
                ? `<span style="font-size:0.6rem; color:#2563eb; background:#eff6ff; padding:1px 8px; border-radius:10px; margin-left:6px;">${escapeHtml(p.product_category_name)}</span>`
                : '';
            html += `
                <div class="product-item">
                    <div class="info">
                        <span class="name">${escapeHtml(p.name)}</span>
                        ${categoryLabel}
                        <span class="price">Ksh ${p.price}</span>
                        ${p.rating ? `<span style="margin-left:8px;">⭐(${p.rating})</span>` : ''}
                        ${p.isFlashSale ? ' <span style="color:#ef4444;">🔥</span>' : ''}
                        ${p.isNewArrival ? ' <span style="color:#48dbfb;">🆕</span>' : ''}
                        <span style="font-size:0.55rem; color:#64748b; margin-left:8px;">Stock: ${p.stock || 0}</span>
                    </div>
                    <div class="actions">
                        <button class="btn-secondary btn-sm" onclick="editProduct(${p.id})">✏️ Edit</button>
                        <button class="btn-danger btn-sm" onclick="deleteProduct(${p.id})">🗑️ Delete</button>
                    </div>
                </div>
            `;
        });
        if (list) list.innerHTML = html;

    } catch (err) {
        console.error('❌ Products error:', err);
        if (list) list.innerHTML = `<p style="color:#ef4444;">Error loading products: ${err.message}</p>`;
    }
}

// ============================================================
//  PRODUCT CRUD
// ============================================================

document.getElementById('productForm')?.addEventListener('submit', async function(e) {
    e.preventDefault();

    // B.5 — Block the save when no product category is selected.
    const categorySelect = document.getElementById('pProductCategory');
    if (!categorySelect || !categorySelect.value) {
        showToast('❌ Please select a product category.', 'error');
        if (categorySelect) categorySelect.focus();
        return;
    }

    const formData = new FormData(this);
    const editId = document.getElementById('editProductId').value;
    const url = editId ? `/api/business-admin/products/${editId}` : '/api/business-admin/products';
    const method = editId ? 'PUT' : 'POST';

    // Send the product_category_id explicitly (the select already carries the name).
    formData.set('product_category_id', categorySelect.value);

    const variants = getVariantData();
    if (variants.length > 0) {
        formData.append('variants', JSON.stringify(variants));
        variants.forEach(function(v) {
            if (v.file) formData.append('variantImages', v.file);
        });
    }

    const submitBtn = document.getElementById('productSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Saving...';

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();

        if (data.success || data.product) {
            alert(editId ? '✅ Product updated!' : '✅ Product added!');
            cancelEditProduct();
            loadProducts();
        } else {
            alert('❌ ' + (data.error || 'Failed to save product'));
        }
    } catch (err) {
        alert('❌ Network error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = editId ? '💾 Update Product' : '➕ Add Product';
    }
});

// ============================================================
//  BATCH PRODUCTS — B.1 / B.5
// ============================================================

async function submitProductBatch() {
    const input = document.getElementById('bulkProductsInput');
    const categorySelect = document.getElementById('bulkProductCategory');

    if (!categorySelect || !categorySelect.value) {
        showToast('❌ Please select a product category for the batch.', 'error');
        if (categorySelect) categorySelect.focus();
        return;
    }

    const productCategoryId = parseInt(categorySelect.value, 10);

    const lines = (input?.value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return showToast('Enter at least one product line.', 'warning');

    let products;
    try {
        products = lines.map((line, index) => {
            // Format: name, price, stock, description
            const [name, price, stock, ...description] = line.split(',').map(value => value.trim());
            if (!name || !price) throw new Error(`Line ${index + 1} needs a name and price.`);
            return {
                name,
                price,
                stock,
                description: description.join(','),
                product_category_id: productCategoryId
            };
        });
    } catch (error) {
        showToast(error.message, 'error');
        return;
    }

    try {
        const response = await fetch('/api/business-admin/products/batch', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ products })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to add products');
        input.value = '';
        showToast(`Added ${data.products.length} products.`, 'success');
        loadProducts();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// ============================================================
//  VARIANT FUNCTIONS
// ============================================================

function addVariantRow(name, price, stock, colorCode) {
    const container = document.getElementById('variantsContainer');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'variant-row';
    row.dataset.index = variantCounter++;
    row.innerHTML = `
        <input type="text" class="variant-name" placeholder="Color name" value="${name || ''}">
        <input type="text" class="variant-price" placeholder="Price (optional)" value="${price || ''}">
        <input type="number" class="variant-stock" placeholder="Stock" value="${stock || ''}">
        <input type="color" class="variant-color-code" value="${colorCode || '#cccccc'}">
        <input type="file" class="variant-image" accept="image/*">
        <button type="button" class="remove-variant" onclick="this.closest('.variant-row').remove()">✕</button>
    `;
    container.appendChild(row);
}

function clearVariants() {
    const container = document.getElementById('variantsContainer');
    if (container) container.innerHTML = '';
    variantCounter = 0;
}

function getVariantData() {
    const variants = [];
    document.querySelectorAll('.variant-row').forEach(function(row) {
        const name = row.querySelector('.variant-name')?.value.trim();
        const price = row.querySelector('.variant-price')?.value.trim();
        const stock = row.querySelector('.variant-stock')?.value.trim();
        const colorCode = row.querySelector('.variant-color-code')?.value || '#cccccc';
        const file = row.querySelector('.variant-image')?.files?.[0] || null;
        if (name) variants.push({ name, price, stock, colorCode, file });
    });
    return variants;
}

async function editProduct(id) {
    try {
        const res = await fetch('/api/products/' + id + '/detail', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        const product = data.product;
        const variants = data.variants || [];

        const fields = {
            editProductId: product.id,
            pName: product.name || '',
            pPrice: product.price || '',
            pOldPrice: product.old_price || '',
            pDiscount: product.discount_percent || '',
            pStock: product.stock || 0,
            pContact: product.contact || '+254700000000',
            pRating: product.rating || '',
            pBadge1: product.badge1 || '',
            pBadge2: product.badge2 || '',
            pShipping: product.shipping || '',
            pDescription: product.description || '',
            pFlashSale: product.isFlashSale || false,
            pNewArrival: product.isNewArrival || false
        };

        Object.keys(fields).forEach(function(key) {
            const el = document.getElementById(key);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = fields[key];
            else el.value = fields[key];
        });

        // B.1 — Preselect the product's category in the searchable picker.
        const categorySelect = document.getElementById('pProductCategory');
        const categorySearch = document.getElementById('pProductCategorySearch');
        if (categorySelect) {
            if (product.product_category_id) {
                categorySelect.value = String(product.product_category_id);
            } else if (product.product_category_name) {
                const match = productCategories.find(c => c.name === product.product_category_name);
                categorySelect.value = match ? String(match.id) : '';
            } else {
                categorySelect.value = '';
            }
        }
        if (categorySearch) categorySearch.value = '';

        clearVariants();
        variants.forEach(function(v) {
            addVariantRow(v.name, v.price || '', v.stock || '', v.color_code || '#cccccc');
        });

        const submitBtn = document.getElementById('productSubmitBtn');
        if (submitBtn) submitBtn.textContent = '💾 Update Product';
        const cancelBtn = document.getElementById('cancelEditBtn');
        if (cancelBtn) cancelBtn.style.display = 'inline-block';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
        alert('Failed to load product details.');
    }
}

function cancelEditProduct() {
    const form = document.getElementById('productForm');
    if (form) form.reset();
    const editIdField = document.getElementById('editProductId');
    if (editIdField) editIdField.value = '';
    const categorySearch = document.getElementById('pProductCategorySearch');
    if (categorySearch) categorySearch.value = '';
    const categorySelect = document.getElementById('pProductCategory');
    if (categorySelect) categorySelect.value = '';
    const submitBtn = document.getElementById('productSubmitBtn');
    if (submitBtn) submitBtn.textContent = '➕ Add Product';
    const cancelBtn = document.getElementById('cancelEditBtn');
    if (cancelBtn) cancelBtn.style.display = 'none';
    clearVariants();
    loadProducts();
}

async function deleteProduct(id) {
    if (!confirm('Delete this product?')) return;
    try {
        const res = await fetch(`/api/business-admin/products/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) { alert('✅ Product deleted'); loadProducts(); }
        else alert('❌ Failed to delete product');
    } catch (err) { alert('❌ Network error'); }
}

// ============================================================
//  CUSTOMERS
// ============================================================

async function loadCustomers() {
    if (!businessData) return;

    const tbody = document.getElementById('customerTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#94a3b8;">Loading customers...</td></tr>';

    try {
        const res = await fetch('/api/business-admin/customers', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to load customers');
        const customers = await res.json();
        customersData = customers;

        if (!customers || customers.length === 0) {
            if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#94a3b8;">No customers yet.</td></tr>';
            return;
        }

        let html = '';
        customers.forEach(function(c) {
            html += `
                <tr>
                    <td><strong>${escapeHtml(c.name)}</strong></td>
                    <td>${escapeHtml(c.email)}</td>
                    <td>${escapeHtml(c.phone || '—')}</td>
                    <td>${c.order_count || 0}</td>
                    <td>Ksh ${parseFloat(c.total_spent || 0).toFixed(2)}</td>
                    <td>${new Date(c.created_at).toLocaleDateString()}</td>
                </tr>
            `;
        });
        if (tbody) tbody.innerHTML = html;

    } catch (err) {
        console.error('❌ Customers error:', err);
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#ef4444;">Error loading customers.</td></tr>';
    }
}

// ============================================================
//  BUSINESS PROFILE
// ============================================================

async function loadBusinessProfile() {
    if (!businessData) return;

    try {
        const res = await fetch('/api/business-admin/profile', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to load profile');
        const data = await res.json();
        const business = data.business;

        const fieldIds = {
            bName: business.business_name || '',
            bLocation: business.location || '',
            bAddress: business.address || '',
            bDescription: business.description || '',
            bMission: business.mission || '',
            bVision: business.vision || '',
            bLatitude: business.latitude || '',
            bLongitude: business.longitude || '',
            bWhatsapp: business.whatsapp || '',
            bTiktok: business.tiktok || '',
            bInstagram: business.instagram || '',
            bFacebook: business.facebook || '',
            bLinkedin: business.linkedin || '',
            bPhone: business.phone || '',
            bPhoneNumbers: Array.isArray(business.phone_numbers) ? business.phone_numbers.join(', ') : '',
            bWebsite: business.website || '',
            bEmail: business.email || '',
            bEmailAddresses: Array.isArray(business.email_addresses) ? business.email_addresses.join(', ') : ''
        };
        Object.keys(fieldIds).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = fieldIds[id];
        });

        const categoriesResponse = await fetch(`/api/businesses/${encodeURIComponent(business.slug)}`);
        const publicBusiness = categoriesResponse.ok ? await categoriesResponse.json() : { categories: [] };
        if (!businessCategories.length) await loadBusinessCategories();
        populateBusinessCategorySelect(publicBusiness.categories);

        const onlineOrdersToggle = document.getElementById('onlineOrdersEnabled');
        if (onlineOrdersToggle) onlineOrdersToggle.checked = business.online_orders_enabled !== false;

        const deliveryToggle = document.getElementById('deliveryEnabled');
        if (deliveryToggle) deliveryToggle.checked = business.delivery_enabled !== false;

    } catch (err) {
        console.error('❌ Profile error:', err);
        alert('Error loading profile');
    }
}

document.getElementById('profileForm')?.addEventListener('submit', async function(e) {
    e.preventDefault();
    const formData = new FormData(this);
    const status = document.getElementById('profileStatus');
    if (status) status.textContent = '⏳ Saving...';

    try {
        const res = await fetch('/api/business-admin/profile', {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();

        if (data.success) {
            const categoryIds = Array.from(document.getElementById('businessCategories').selectedOptions).map(option => Number(option.value));
            const categoriesResponse = await fetch('/api/business-admin/categories', {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ category_ids: categoryIds })
            });
            if (!categoriesResponse.ok) {
                const categoryError = await categoriesResponse.json().catch(() => ({}));
                throw new Error(categoryError.error || 'Profile saved but categories could not be saved');
            }
            if (status) { status.textContent = '✅ Profile updated successfully!'; status.style.color = '#16a34a'; }
            alert('✅ Business profile updated!');
            businessData = data.business;
            document.getElementById('businessNameDisplay').textContent = businessData.business_name;

            // Section B — re-evaluate the missing-category warning. If the
            // admin just assigned a category, the banner and red dot disappear
            // immediately. If they removed all categories, the warning returns.
            const afterSave = await fetch('/api/auth/my-business', {
                headers: { 'Authorization': `Bearer ${token}` }
            }).then(r => r.ok ? r.json() : { has_business_category: false })
              .catch(() => ({ has_business_category: false }));
            applyCategoryWarning(afterSave.has_business_category === true);

            // Business categories changed → the available product categories may have changed too.
            await loadProductCategories(true);
        } else {
            if (status) { status.textContent = '❌ ' + (data.error || 'Failed to update'); status.style.color = '#ef4444'; }
        }
    } catch (err) {
        if (status) { status.textContent = '❌ Network error'; status.style.color = '#ef4444'; }
    }
});

// ============================================================
//  PAYMENT SETTINGS
// ============================================================

async function loadPaymentSettings() {
    if (!businessData) return;
    try {
        const res = await fetch('/api/business-admin/payment-settings', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to load payment settings');
        const settings = await res.json();

        document.getElementById('pMpesaEnabled').checked = settings.mpesa_enabled || false;
        document.getElementById('pMpesaNumber').value = settings.mpesa_number || '';
        document.getElementById('pAirtelEnabled').checked = settings.airtel_enabled || false;
        document.getElementById('pAirtelNumber').value = settings.airtel_number || '';
        document.getElementById('pBankEnabled').checked = settings.bank_enabled || false;
        document.getElementById('pBankName').value = settings.bank_name || '';
        document.getElementById('pBankAccount').value = settings.bank_account || '';
        document.getElementById('pBankHolder').value = settings.bank_account_name || '';
        document.getElementById('pPaypalEnabled').checked = settings.paypal_enabled || false;
        document.getElementById('pPaypalEmail').value = settings.paypal_email || '';
    } catch (err) {
        console.error('❌ Payment settings error:', err);
        alert('Error loading payment settings');
    }
}

document.getElementById('paymentSettingsForm')?.addEventListener('submit', async function(e) {
    e.preventDefault();
    const data = {
        mpesa_enabled: document.getElementById('pMpesaEnabled').checked,
        mpesa_number: document.getElementById('pMpesaNumber').value,
        airtel_enabled: document.getElementById('pAirtelEnabled').checked,
        airtel_number: document.getElementById('pAirtelNumber').value,
        bank_enabled: document.getElementById('pBankEnabled').checked,
        bank_name: document.getElementById('pBankName').value,
        bank_account: document.getElementById('pBankAccount').value,
        bank_account_name: document.getElementById('pBankHolder').value,
        paypal_enabled: document.getElementById('pPaypalEnabled').checked,
        paypal_email: document.getElementById('pPaypalEmail').value
    };
    const status = document.getElementById('paymentStatus');
    if (status) status.textContent = '⏳ Saving...';

    try {
        const res = await fetch('/api/business-admin/payment-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (result.success) {
            if (status) { status.textContent = '✅ Payment settings updated!'; status.style.color = '#16a34a'; }
            alert('✅ Payment settings updated!');
        } else {
            if (status) { status.textContent = '❌ ' + (result.error || 'Failed to update'); status.style.color = '#ef4444'; }
        }
    } catch (err) {
        if (status) { status.textContent = '❌ Network error'; status.style.color = '#ef4444'; }
    }
});

// ============================================================
//  DELIVERY SETTINGS
// ============================================================

function toggleDeliveryOffered(value) {
    deliverySettings.offered = value;
    const noContainer = document.getElementById('deliveryNoContainer');
    const yesContainer = document.getElementById('deliveryYesContainer');
    const previewContainer = document.getElementById('deliveryPreviewContainer');
    const commonContainer = document.getElementById('deliveryCommonContainer');

    if (value === 'no') {
        if (noContainer) noContainer.style.display = 'block';
        if (yesContainer) yesContainer.style.display = 'none';
        if (previewContainer) previewContainer.style.display = 'block';
        if (commonContainer) commonContainer.style.display = 'none';
        updateDeliveryPreview();
    } else if (value === 'yes') {
        if (noContainer) noContainer.style.display = 'none';
        if (yesContainer) yesContainer.style.display = 'block';
        if (previewContainer) previewContainer.style.display = 'block';
        if (commonContainer) commonContainer.style.display = 'block';
        const freeRadios = document.querySelectorAll('input[name="delivery_free"]');
        let freeValue = null;
        freeRadios.forEach(r => { if (r.checked) freeValue = r.value; });
        if (freeValue) toggleDeliveryFree(freeValue);
        updateDeliveryPreview();
    }
}

function toggleDeliveryFree(value) {
    deliverySettings.free = value;
    const freeYesContainer = document.getElementById('deliveryFreeYesContainer');
    const freeNoContainer = document.getElementById('deliveryFreeNoContainer');
    const commonContainer = document.getElementById('deliveryCommonContainer');

    if (value === 'yes') {
        if (freeYesContainer) freeYesContainer.style.display = 'block';
        if (freeNoContainer) freeNoContainer.style.display = 'none';
        if (commonContainer) commonContainer.style.display = 'block';
        const whereRadios = document.querySelectorAll('input[name="delivery_free_where"]');
        let whereValue = null;
        whereRadios.forEach(r => { if (r.checked) whereValue = r.value; });
        if (whereValue) toggleFreeWhere(whereValue);
    } else if (value === 'no') {
        if (freeYesContainer) freeYesContainer.style.display = 'none';
        if (freeNoContainer) freeNoContainer.style.display = 'block';
        if (commonContainer) commonContainer.style.display = 'block';
    }
    updateDeliveryPreview();
}

function toggleFreeWhere(value) {
    deliverySettings.free_where = value;
    const everywhereContainer = document.getElementById('freeEverywhereContainer');
    const specificContainer = document.getElementById('freeSpecificContainer');
    if (value === 'everywhere') {
        if (everywhereContainer) everywhereContainer.style.display = 'block';
        if (specificContainer) specificContainer.style.display = 'none';
    } else if (value === 'specific') {
        if (everywhereContainer) everywhereContainer.style.display = 'none';
        if (specificContainer) specificContainer.style.display = 'block';
    }
    updateDeliveryPreview();
}

function updateDeliveryPreview() {
    const container = document.getElementById('deliveryPreviewContent');
    if (!container) return;

    let html = '';
    const offered = deliverySettings.offered;
    const free = deliverySettings.free;
    const freeWhere = deliverySettings.free_where;
    const noMessage = document.getElementById('deliveryNoMessage')?.value || '';
    const freeMessage = document.getElementById('freeDeliveryMessage')?.value || '';
    const paidMessage = document.getElementById('deliveryPaidMessage')?.value || '';
    const feeType = document.querySelector('input[name="delivery_fee_type"]:checked')?.value || 'fixed';
    const feeFixed = document.getElementById('deliveryFeeFixed')?.value || 0;
    const feePerKm = document.getElementById('deliveryFeePerKm')?.value || 0;
    const minOrderFree = document.getElementById('deliveryMinOrderFree')?.value || 0;
    const estimatedTime = document.getElementById('deliveryEstimatedTime')?.value || 'Same day';
    const policy = document.getElementById('deliveryPolicy')?.value || '';

    let selectedDays = 'Within 3 days';
    document.querySelectorAll('input[name="delivery_days"]').forEach(r => {
        if (r.checked) {
            const labels = {
                'same_day': 'Same day', 'next_day': 'Next day', 'within_2_days': 'Within 2 days',
                'within_3_days': 'Within 3 days', 'within_4_days': 'Within 4 days',
                'within_5_days': 'Within 5 days', 'within_6_days': 'Within 6 days',
                'within_7_days': 'Within 7 days'
            };
            selectedDays = labels[r.value] || 'Within 3 days';
        }
    });

    if (offered === 'no') {
        html = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                <span style="font-size:1.2rem;">📍</span>
                <strong style="font-size:0.9rem;">Pickup Only</strong>
            </div>
            <p style="font-size:0.85rem; color:#475569; margin:0 0 4px 0;">
                ${noMessage || 'Let\'s talk about delivery. Chat with me to arrange how you can get your products.'}
            </p>
            <p style="font-size:0.7rem; color:#94a3b8; margin:0;">
                💬 Chat with seller to arrange pickup or delivery
            </p>
        `;
    } else if (offered === 'yes') {
        html = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                <span style="font-size:1.2rem;">🚚</span>
                <strong style="font-size:0.9rem;">Delivery Available</strong>
                <span style="font-size:0.6rem; background:#2563eb; color:white; padding:2px 10px; border-radius:12px;">${selectedDays}</span>
            </div>
        `;
        if (free === 'yes') {
            html += `
                <div style="background:#dcfce7; padding:8px 12px; border-radius:6px; margin-bottom:6px;">
                    <p style="font-size:0.85rem; color:#166534; margin:0;"><strong>🎁 FREE DELIVERY!</strong></p>
                </div>
            `;
            if (freeWhere === 'everywhere') {
                html += `<p style="font-size:0.85rem; color:#475569; margin:0 0 4px 0;">🌍 I deliver FREE everywhere in Kenya!</p>`;
            } else if (freeWhere === 'specific') {
                html += `<div style="background:#f8fafc; padding:8px 12px; border-radius:6px; border-left:3px solid #f59e0b;"><p style="font-size:0.8rem; color:#475569; margin:0;">${freeMessage || 'I offer free delivery based on your location or order size. Contact me for details.'}</p></div>`;
            }
        } else if (free === 'no') {
            html += `<div style="background:#f8fafc; padding:8px 12px; border-radius:6px; border-left:3px solid #f59e0b;"><p style="font-size:0.8rem; color:#475569; margin:0;">${paidMessage || 'I charge for delivery based on your location or order size. Contact me for details.'}</p></div>`;
        }
        if (feeType === 'fixed' && parseFloat(feeFixed) > 0) {
            html += `<p style="font-size:0.75rem; color:#64748b; margin-top:4px;">💰 Delivery fee: Ksh ${parseFloat(feeFixed).toFixed(2)}</p>`;
        } else if (feeType === 'per_km' && parseFloat(feePerKm) > 0) {
            html += `<p style="font-size:0.75rem; color:#64748b; margin-top:4px;">💰 Delivery fee: Ksh ${parseFloat(feePerKm).toFixed(2)} per km</p>`;
        }
        if (parseFloat(minOrderFree) > 0) {
            html += `<p style="font-size:0.75rem; color:#166534; margin-top:2px;">🎉 Free delivery on orders over Ksh ${parseFloat(minOrderFree).toFixed(2)}</p>`;
        }
        if (policy) html += `<p style="font-size:0.7rem; color:#64748b; margin-top:4px;">📋 ${policy}</p>`;
        html += `<p style="font-size:0.7rem; color:#94a3b8; margin-top:4px;">⏰ Estimated delivery: ${estimatedTime || selectedDays}</p>`;
    }
    container.innerHTML = html;
}

async function loadDeliverySettings() {
    if (!businessData) return;
    try {
        const res = await fetch('/api/business-admin/delivery-settings', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to load delivery settings');
        const data = await res.json();

        if (data) {
            const offered = data.delivery_offered || 'no';
            document.querySelectorAll('input[name="delivery_offered"]').forEach(r => { r.checked = r.value === offered; });
            toggleDeliveryOffered(offered);

            if (data.delivery_no_message) document.getElementById('deliveryNoMessage').value = data.delivery_no_message;

            const free = data.delivery_free || 'no';
            document.querySelectorAll('input[name="delivery_free"]').forEach(r => { r.checked = r.value === free; });
            if (offered === 'yes') toggleDeliveryFree(free);

            const freeWhere = data.delivery_free_where || 'everywhere';
            document.querySelectorAll('input[name="delivery_free_where"]').forEach(r => { r.checked = r.value === freeWhere; });
            if (free === 'yes') toggleFreeWhere(freeWhere);

            if (data.delivery_free_message) document.getElementById('freeDeliveryMessage').value = data.delivery_free_message;
            if (data.delivery_paid_message) document.getElementById('deliveryPaidMessage').value = data.delivery_paid_message;

            const days = data.delivery_days || 'within_3_days';
            document.querySelectorAll('input[name="delivery_days"]').forEach(r => { r.checked = r.value === days; });
            deliverySettings.days = days;

            const feeType = data.delivery_fee_type || 'fixed';
            document.querySelectorAll('input[name="delivery_fee_type"]').forEach(r => { r.checked = r.value === feeType; });
            document.getElementById('deliveryFeeFixed').value = data.delivery_fee_fixed || 0;
            document.getElementById('deliveryFeePerKm').value = data.delivery_fee_per_km || 0;
            document.getElementById('deliveryMinOrderFree').value = data.delivery_min_order_free || 0;
            document.getElementById('deliveryMaxDistance').value = data.delivery_max_distance_km || 50;
            document.getElementById('deliveryEstimatedTime').value = data.delivery_estimated_time || 'Same day';
            document.getElementById('deliveryPolicy').value = data.delivery_policy || '';

            if (data.delivery_time_slots) {
                document.getElementById('deliveryTimeSlots').value = data.delivery_time_slots.join(', ');
            }
            document.getElementById('deliveryCutoffTime').value = data.delivery_cutoff_time || '14:00';

            updateDeliveryPreview();
            loadDeliveryOrders();
        }
    } catch (err) {
        console.error('❌ Delivery settings error:', err);
        const status = document.getElementById('deliveryStatus');
        if (status) { status.textContent = '❌ Error loading delivery settings'; status.style.color = '#ef4444'; }
    }
}

document.getElementById('deliveryForm')?.addEventListener('submit', async function(e) {
    e.preventDefault();
    const offered = document.querySelector('input[name="delivery_offered"]:checked');
    const free = document.querySelector('input[name="delivery_free"]:checked');
    const freeWhere = document.querySelector('input[name="delivery_free_where"]:checked');
    const days = document.querySelector('input[name="delivery_days"]:checked');
    const feeType = document.querySelector('input[name="delivery_fee_type"]:checked');

    const data = {
        delivery_offered: offered ? offered.value : 'no',
        delivery_free: free ? free.value : 'no',
        delivery_free_where: freeWhere ? freeWhere.value : 'everywhere',
        delivery_days: days ? days.value : 'within_3_days',
        delivery_fee_type: feeType ? feeType.value : 'fixed',
        delivery_fee_fixed: parseFloat(document.getElementById('deliveryFeeFixed')?.value) || 0,
        delivery_fee_per_km: parseFloat(document.getElementById('deliveryFeePerKm')?.value) || 0,
        delivery_min_order_free: parseFloat(document.getElementById('deliveryMinOrderFree')?.value) || 0,
        delivery_max_distance_km: parseInt(document.getElementById('deliveryMaxDistance')?.value) || 50,
        delivery_estimated_time: document.getElementById('deliveryEstimatedTime')?.value || 'Same day',
        delivery_policy: document.getElementById('deliveryPolicy')?.value || '',
        delivery_no_message: document.getElementById('deliveryNoMessage')?.value || '',
        delivery_free_message: document.getElementById('freeDeliveryMessage')?.value || '',
        delivery_paid_message: document.getElementById('deliveryPaidMessage')?.value || '',
        delivery_time_slots: document.getElementById('deliveryTimeSlots')?.value?.split(',').map(s => s.trim()).filter(Boolean) || [],
        delivery_cutoff_time: document.getElementById('deliveryCutoffTime')?.value || '14:00'
    };

    const status = document.getElementById('deliveryStatus');
    status.textContent = '⏳ Saving delivery settings...';
    status.style.color = '#2563eb';

    try {
        const res = await fetch('/api/business-admin/delivery-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (result.success) {
            status.textContent = '✅ Delivery settings saved successfully!';
            status.style.color = '#16a34a';
            showToast('✅ Delivery settings saved!', 'success');
            updateDeliveryPreview();
            loadDeliveryOrders();
        } else {
            status.textContent = '❌ ' + (result.error || 'Failed to save');
            status.style.color = '#ef4444';
            showToast('❌ Failed to save delivery settings', 'error');
        }
    } catch (err) {
        status.textContent = '❌ Network error: ' + err.message;
        status.style.color = '#ef4444';
        showToast('❌ Network error', 'error');
    }
});

async function loadDeliveryOrders() {
    const container = document.getElementById('deliveryOrdersContainer');
    if (!container) return;
    try {
        const res = await fetch('/api/business-admin/orders?status=delivered', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to load delivery orders');
        const orders = await res.json();
        if (!orders || orders.length === 0) {
            container.innerHTML = '<p class="empty-msg">No delivery orders yet.</p>';
            return;
        }
        let html = '';
        orders.forEach(order => {
            const methodLabels = { 'delivery': '🚚 Delivery', 'pickup': '📍 Pickup', 'chat': '💬 Chat' };
            const methodLabel = methodLabels[order.delivery_method] || order.delivery_method || 'Pickup';
            html += `
                <div class="order-row" style="border-left-color: #2563eb;">
                    <div class="order-header">
                        <span class="ref">${order.order_ref || `#${order.id}`}</span>
                        <span class="customer">${order.customer_name || 'Guest'}</span>
                        <span class="date">${new Date(order.created_at).toLocaleDateString()}</span>
                        <span class="total">Ksh ${parseFloat(order.total).toFixed(2)}</span>
                        <span style="font-size:0.65rem; color:#2563eb;">${methodLabel}</span>
                        ${order.delivery_fee > 0 ? `<span style="font-size:0.65rem; color:#64748b;">Fee: Ksh ${parseFloat(order.delivery_fee).toFixed(2)}</span>` : ''}
                        <span class="status-badge status-${order.status}">${order.status.replace('_', ' ').toUpperCase()}</span>
                    </div>
                    ${order.delivery_address ? `<div style="font-size:0.7rem; color:#64748b; margin-top:4px;">📍 ${order.delivery_address}</div>` : ''}
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (err) {
        console.error('❌ Delivery orders error:', err);
        container.innerHTML = '<p class="empty-msg">Error loading delivery orders.</p>';
    }
}

// ============================================================
//  ORDER SETTINGS
// ============================================================

async function loadOrderSettings() {
    if (!businessData) return;
    try {
        const res = await fetch('/api/business-admin/order-settings', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to load order settings');
        const settings = await res.json();
        Object.assign(orderSettings, settings);

        document.getElementById('orderOnlineEnabled').checked = settings.online_orders_enabled !== false;
        document.getElementById('onlinePaymentEnabled').checked = settings.online_payment_enabled !== false;
        document.getElementById('paymentOnDeliveryEnabled').checked = settings.payment_on_delivery_enabled === true;
        document.getElementById('requirePodAgreement').checked = settings.require_pod_agreement !== false;
        document.getElementById('podAgreementText').value = settings.pod_agreement_text || '';
        document.getElementById('orderRegions').value = settings.order_regions || 'Anywhere in Kenya';
        document.getElementById('orderCutoffTime').value = settings.order_cutoff_time || '14:00';
        document.getElementById('orderProcessingTime').value = settings.order_processing_time || '1-2 hours';
        document.getElementById('orderAutoCancelHours').value = settings.auto_cancel_hours || 24;
        document.getElementById('orderAutoCompleteDays').value = settings.auto_complete_days || 7;
        document.getElementById('orderReplacementHours').value = settings.replacement_hours || 6;
        document.getElementById('orderStatusPending').value = settings.status_pending || '📋 Your order is being reviewed.';
        document.getElementById('orderStatusPendingPayment').value = settings.status_pending_payment || '⏳ Awaiting payment confirmation.';
        document.getElementById('orderStatusConfirmed').value = settings.status_confirmed || '✅ Your order is confirmed and being prepared.';
        document.getElementById('orderStatusShipped').value = settings.status_shipped || '🚚 Your order is on the way!';
        document.getElementById('orderStatusDelivered').value = settings.status_delivered || '📦 Your order is ready for pickup. Please collect within 7 working days.';
        document.getElementById('orderStatusReceived').value = settings.status_received || '✔️ You have confirmed receipt. Thank you!';
        document.getElementById('orderStatusCancelled').value = settings.status_cancelled || '❌ This order has been cancelled.';
        document.getElementById('orderStatusCompleted').value = settings.status_completed || '✅ Order completed. Thank you for shopping!';
        document.getElementById('orderReturnPolicy').value = settings.return_policy || 'Returns accepted within 14 days of delivery. Products must be in original condition.';
        document.getElementById('orderReturnWindow').value = settings.return_window_days || 14;

        toggleOrderSettingsVisibility(settings.online_orders_enabled !== false);
        updateOrderPreview();
    } catch (err) {
        console.error('❌ Order settings error:', err);
        showToast('Error loading order settings', 'error');
    }
}

function toggleOrderSettingsVisibility(enabled) {
    const container = document.getElementById('orderSettingsContainer');
    const disabledMessage = document.getElementById('orderDisabledMessage');
    if (container) container.style.display = enabled ? 'block' : 'none';
    if (disabledMessage) disabledMessage.style.display = enabled ? 'none' : 'block';
}

function updateOrderPreview() {
    const container = document.getElementById('orderPreviewContent');
    if (!container) return;
    const enabled = document.getElementById('orderOnlineEnabled').checked;
    const regions = document.getElementById('orderRegions').value.trim() || 'Anywhere in Kenya';
    const cutoffTime = document.getElementById('orderCutoffTime').value || '14:00';
    const processingTime = document.getElementById('orderProcessingTime').value.trim() || '1-2 hours';
    const autoCancel = document.getElementById('orderAutoCancelHours').value || 24;
    const autoComplete = document.getElementById('orderAutoCompleteDays').value || 7;
    const replacementHours = document.getElementById('orderReplacementHours').value || 6;
    const returnWindow = document.getElementById('orderReturnWindow').value || 14;

    let html = `
        <div style="background:white; border-radius:8px; padding:16px; border:1px solid #e2e8f0;">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
                <span style="font-size:1.2rem;">${enabled ? '✅' : '❌'}</span>
                <strong style="font-size:0.95rem;">Online Orders: ${enabled ? 'Enabled' : 'Disabled'}</strong>
                ${!enabled ? '<span style="font-size:0.7rem; color:#ef4444;">Customers cannot place orders</span>' : ''}
            </div>
    `;
    if (enabled) {
        html += `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 20px; font-size:0.8rem; color:#475569;">
                <div><strong>📍 Regions:</strong></div><div>${regions}</div>
                <div><strong>⏰ Cutoff Time:</strong></div><div>${cutoffTime}</div>
                <div><strong>⏳ Processing Time:</strong></div><div>${processingTime}</div>
                <div><strong>🔁 Replacement Window:</strong></div><div>${replacementHours} hours</div>
                <div><strong>📦 Return Window:</strong></div><div>${returnWindow} days</div>
                <div><strong>⏰ Auto-Cancel:</strong></div><div>${autoCancel} hours</div>
                <div><strong>✅ Auto-Complete:</strong></div><div>${autoComplete} days after receipt</div>
            </div>
            <div style="margin-top:8px; padding:8px 12px; background:#f8fafc; border-radius:6px; border-left:3px solid #2563eb;">
                <p style="font-size:0.75rem; color:#64748b; margin:0;">
                    <strong>📋 Order Status Messages:</strong><br>
                    • Pending: ${document.getElementById('orderStatusPending').value || 'Your order is being reviewed.'}<br>
                    • Confirmed: ${document.getElementById('orderStatusConfirmed').value || 'Your order is confirmed and being prepared.'}<br>
                    • Shipped: ${document.getElementById('orderStatusShipped').value || 'Your order is on the way!'}<br>
                    • Delivered: ${document.getElementById('orderStatusDelivered').value || 'Your order is ready for pickup.'}
                </p>
            </div>
            <div style="margin-top:8px; padding:8px 12px; background:#f0fdf4; border-radius:6px; border-left:3px solid #22c55e;">
                <p style="font-size:0.75rem; color:#166534; margin:0;">
                    <strong>🔄 Return Policy:</strong><br>
                    ${document.getElementById('orderReturnPolicy').value || 'Returns accepted within 14 days of delivery. Products must be in original condition.'}
                </p>
            </div>
        `;
    } else {
        html += `
            <div style="margin-top:8px; padding:8px 12px; background:#fef2f2; border-radius:6px; border-left:3px solid #ef4444;">
                <p style="font-size:0.8rem; color:#991b1b; margin:0;">
                    <strong>⚠️ Customers will see:</strong><br>
                    "This business is not currently accepting online orders. Please contact the business directly."
                </p>
            </div>
        `;
    }
    html += '</div>';
    container.innerHTML = html;
}

async function saveOrderSettings() {
    const data = {
        online_orders_enabled: document.getElementById('orderOnlineEnabled').checked,
        online_payment_enabled: document.getElementById('onlinePaymentEnabled').checked,
        payment_on_delivery_enabled: document.getElementById('paymentOnDeliveryEnabled').checked,
        require_pod_agreement: document.getElementById('requirePodAgreement').checked,
        pod_agreement_text: document.getElementById('podAgreementText').value.trim(),
        order_regions: document.getElementById('orderRegions').value.trim(),
        order_cutoff_time: document.getElementById('orderCutoffTime').value,
        order_processing_time: document.getElementById('orderProcessingTime').value.trim(),
        auto_cancel_hours: parseInt(document.getElementById('orderAutoCancelHours').value) || 24,
        auto_complete_days: parseInt(document.getElementById('orderAutoCompleteDays').value) || 7,
        replacement_hours: parseInt(document.getElementById('orderReplacementHours').value) || 6,
        status_pending: document.getElementById('orderStatusPending').value.trim(),
        status_pending_payment: document.getElementById('orderStatusPendingPayment').value.trim(),
        status_confirmed: document.getElementById('orderStatusConfirmed').value.trim(),
        status_shipped: document.getElementById('orderStatusShipped').value.trim(),
        status_delivered: document.getElementById('orderStatusDelivered').value.trim(),
        status_received: document.getElementById('orderStatusReceived').value.trim(),
        status_cancelled: document.getElementById('orderStatusCancelled').value.trim(),
        status_completed: document.getElementById('orderStatusCompleted').value.trim(),
        return_policy: document.getElementById('orderReturnPolicy').value.trim(),
        return_window_days: parseInt(document.getElementById('orderReturnWindow').value) || 14
    };

    const status = document.getElementById('orderSettingsStatus');
    if (status) { status.textContent = '⏳ Saving order settings...'; status.style.color = '#2563eb'; }

    try {
        const res = await fetch('/api/business-admin/order-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (result.success) {
            if (status) { status.textContent = '✅ Order settings saved successfully!'; status.style.color = '#16a34a'; }
            showToast('✅ Order settings saved!', 'success');
            businessData.online_orders_enabled = data.online_orders_enabled;
            toggleOrderSettingsVisibility(data.online_orders_enabled);
            updateOrderPreview();
        } else {
            if (status) { status.textContent = '❌ ' + (result.error || 'Failed to save'); status.style.color = '#ef4444'; }
            showToast('❌ Failed to save order settings', 'error');
        }
    } catch (err) {
        if (status) { status.textContent = '❌ Network error: ' + err.message; status.style.color = '#ef4444'; }
        showToast('❌ Network error', 'error');
    }
}

function updateOrderSettingsUI() {
    const enabled = document.getElementById('orderOnlineEnabled').checked;
    toggleOrderSettingsVisibility(enabled);
    updateOrderPreview();
}

// ============================================================
//  DELIVERY RECORDING
// ============================================================

function openDeliveryLog(orderId) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.id = 'deliveryLogModal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-box" style="max-width:600px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h3 style="font-size:1.1rem; font-weight:700;">📦 Delivery Log - Order #${orderId}</h3>
                <button onclick="closeDeliveryLog()" style="background:none; border:none; font-size:1.5rem; cursor:pointer;">✕</button>
            </div>
            <div id="deliveryLogContent"><p style="text-align:center; color:#94a3b8; padding:20px;">Loading delivery log...</p></div>
            <div style="margin-top:16px; display:flex; gap:8px; justify-content:flex-end;">
                <button class="btn btn-secondary" onclick="closeDeliveryLog()">Close</button>
                <button class="btn btn-success" onclick="confirmDelivery(${orderId})"><i class="fas fa-check"></i> Confirm Delivery</button>
                <button class="btn btn-danger" onclick="reportDeliveryIssue(${orderId})"><i class="fas fa-exclamation-triangle"></i> Report Issue</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    loadDeliveryLogData(orderId);
}

function closeDeliveryLog() {
    const modal = document.getElementById('deliveryLogModal');
    if (modal) modal.remove();
}

async function loadDeliveryLogData(orderId) {
    const container = document.getElementById('deliveryLogContent');
    try {
        const res = await fetch(`/api/orders/${orderId}/delivery-record`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!data || Object.keys(data).length === 0) {
            container.innerHTML = `
                <div style="background:#fefce8; padding:16px; border-radius:8px; text-align:center;">
                    <p style="color:#92400e;">No delivery record found for this order.</p>
                    <p style="font-size:0.8rem; color:#64748b; margin-top:4px;">The customer may not have selected a delivery method yet.</p>
                </div>
            `;
            return;
        }
        let html = `
            <div style="background:#f8fafc; border-radius:8px; padding:16px; border:1px solid #e2e8f0;">
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 20px; font-size:0.9rem;">
                    <div><strong>Order:</strong></div><div>${data.order_ref || 'N/A'}</div>
                    <div><strong>Method:</strong></div><div>${data.delivery_method || 'Pickup'}</div>
                    <div><strong>Code:</strong></div><div style="font-weight:700; color:#2563eb;">${data.delivery_code || 'N/A'}</div>
                    <div><strong>Chosen:</strong></div><div>${data.recorded_at ? new Date(data.recorded_at).toLocaleString() : 'N/A'}</div>
                    <div><strong>Status:</strong></div><div>${getDeliveryStatusBadge(data.status)}</div>
        `;
        if (data.delivery_method === 'delivery') {
            html += `
                <div style="grid-column:1/-1; border-top:1px solid #e2e8f0; padding-top:8px; margin-top:4px;">
                    <strong>📍 Delivery Details</strong>
                    <div style="margin-top:4px; font-size:0.85rem;">
                        <div><strong>Recipient:</strong> ${data.delivery_recipient_name || 'N/A'}</div>
                        <div><strong>Phone:</strong> ${data.delivery_phone || 'N/A'}</div>
                        <div><strong>Address:</strong> ${data.delivery_address || 'N/A'}</div>
                        ${data.delivery_instructions ? `<div><strong>Instructions:</strong> ${data.delivery_instructions}</div>` : ''}
                        ${data.delivery_fee ? `<div><strong>Fee:</strong> Ksh ${parseFloat(data.delivery_fee).toFixed(2)}</div>` : ''}
                    </div>
                </div>
            `;
        }
        if (data.delivery_method === 'pickup') {
            html += `
                <div style="grid-column:1/-1; border-top:1px solid #e2e8f0; padding-top:8px; margin-top:4px;">
                    <strong>📍 Pickup Details</strong>
                    <div style="margin-top:4px; font-size:0.85rem;">
                        <div><strong>Name:</strong> ${data.pickup_recipient_name || data.delivery_recipient_name || 'N/A'}</div>
                        <div><strong>Phone:</strong> ${data.pickup_phone || data.delivery_phone || 'N/A'}</div>
                    </div>
                </div>
            `;
        }
        html += `
                    <div style="grid-column:1/-1; border-top:1px solid #e2e8f0; padding-top:8px; margin-top:4px; font-size:0.75rem; color:#64748b;">
                        <div style="display:flex; gap:16px; flex-wrap:wrap;">
                            <span><i class="fas fa-user-check" style="color:#22c55e;"></i> Customer: ${data.confirmed_by_customer ? '✅ Confirmed' : '⏳ Pending'}</span>
                            <span><i class="fas fa-store" style="color:#2563eb;"></i> Seller: ${data.confirmed_by_seller ? '✅ Confirmed' : '⏳ Pending'}</span>
                            ${data.dispute ? '<span style="color:#ef4444;"><i class="fas fa-exclamation-triangle"></i> ⚠️ Dispute Reported</span>' : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `
            <div style="background:#fee2e2; padding:16px; border-radius:8px; text-align:center;">
                <p style="color:#991b1b;">❌ Error loading delivery log</p>
                <p style="font-size:0.8rem; color:#64748b;">${err.message}</p>
            </div>
        `;
    }
}

function getDeliveryStatusBadge(status) {
    const badges = {
        'pending': '<span style="background:#fef3c7; color:#92400e; padding:2px 12px; border-radius:12px; font-size:0.7rem;">⏳ Pending</span>',
        'confirmed': '<span style="background:#dcfce7; color:#166534; padding:2px 12px; border-radius:12px; font-size:0.7rem;">✅ Confirmed</span>',
        'dispute': '<span style="background:#fee2e2; color:#991b1b; padding:2px 12px; border-radius:12px; font-size:0.7rem;">⚠️ Dispute</span>',
        'completed': '<span style="background:#dbeafe; color:#1e40af; padding:2px 12px; border-radius:12px; font-size:0.7rem;">✅ Completed</span>'
    };
    return badges[status] || '<span style="background:#e2e8f0; color:#475569; padding:2px 12px; border-radius:12px; font-size:0.7rem;">Unknown</span>';
}

async function confirmDelivery(orderId) {
    if (!confirm('Confirm delivery for this order?')) return;
    try {
        const res = await fetch(`/api/orders/${orderId}/confirm-delivery`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.success) { showToast('✅ Delivery confirmed!', 'success'); closeDeliveryLog(); loadOrders(); }
        else showToast('❌ ' + (data.error || 'Failed to confirm'), 'error');
    } catch (err) { showToast('❌ Network error', 'error'); }
}

function reportDeliveryIssue(orderId) {
    const reason = prompt('Please describe the issue with this delivery:');
    if (!reason) return;
    if (reason.length < 10) { alert('Please provide more details (at least 10 characters).'); return; }
    if (!confirm('Report this issue? This will notify the customer and admin.')) return;

    fetch(`/api/orders/${orderId}/dispute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ reason })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) { showToast('⚠️ Issue reported. Admin will review.', 'warning'); closeDeliveryLog(); loadOrders(); }
        else showToast('❌ ' + (data.error || 'Failed to report'), 'error');
    })
    .catch(() => showToast('❌ Network error', 'error'));
}

// ============================================================
//  SHOW TOAST
// ============================================================

function showToast(message, type = 'success') {
    const existing = document.querySelector('.toast-container');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.className = 'toast-container';
    container.style.cssText = `position: fixed; top: 20px; right: 20px; z-index: 99999; max-width: 400px; width: 100%;`;

    const toast = document.createElement('div');
    const typeMap = { success: '#22c55e', error: '#ef4444', warning: '#f59e0b', info: '#2563eb' };
    const iconMap = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const bgColor = typeMap[type] || '#2563eb';

    toast.style.cssText = `
        background: ${bgColor}; color: white; padding: 14px 20px; border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.15); font-size: 0.9rem; font-weight: 500;
        display: flex; align-items: center; gap: 12px; animation: slideIn 0.3s ease;
        margin-bottom: 8px; word-break: break-word;
    `;

    const icon = document.createElement('span');
    icon.innerHTML = iconMap[type] || 'ℹ️';
    icon.style.fontSize = '1.2rem';
    icon.style.flexShrink = '0';

    const text = document.createElement('span');
    text.textContent = message;
    text.style.flex = '1';

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = `background: none; border: none; color: white; font-size: 1rem; cursor: pointer; margin-left: auto; opacity: 0.7; transition: opacity 0.2s; flex-shrink: 0;`;
    closeBtn.onclick = () => { toast.style.transform = 'translateX(120%)'; setTimeout(() => container.remove(), 300); };

    toast.appendChild(icon);
    toast.appendChild(text);
    toast.appendChild(closeBtn);
    container.appendChild(toast);
    document.body.appendChild(container);

    setTimeout(() => {
        if (document.body.contains(container)) {
            toast.style.transform = 'translateX(120%)';
            setTimeout(() => container.remove(), 300);
        }
    }, 5000);
}

// ============================================================
//  LOGOUT
// ============================================================

async function logout() {
    if (window.parent !== window) {
        window.parent.logout();
        return;
    }
    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    if (socket) { socket.disconnect(); socket = null; }
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem('businessId');
    localStorage.removeItem('businessName');
    window.location.href = '/';
}

// ============================================================
//  EXPOSE FUNCTIONS
// ============================================================

window.toggleSidebar = toggleSidebar;
window.closeSidebar = closeSidebar;
window.openMarketplaceMessages = openMarketplaceMessages;
window.openPublicPreview = openPublicPreview;
window.navigateTo = navigateTo;
window.loadDashboard = loadDashboard;
window.loadProductCategories = loadProductCategories;
window.filterProductCategoryOptions = filterProductCategoryOptions;
window.submitProductCategoryRequest = submitProductCategoryRequest;
window.loadProductCategorySection = loadProductCategorySection;
window.submitProductBatch = submitProductBatch;
window.filterBusinessCategoryOptions = filterBusinessCategoryOptions;
window.loadOrders = loadOrders;
window.loadProducts = loadProducts;
window.loadCustomers = loadCustomers;
window.loadBusinessProfile = loadBusinessProfile;
window.loadPaymentSettings = loadPaymentSettings;
window.loadDeliverySettings = loadDeliverySettings;
window.loadOrderSettings = loadOrderSettings;
window.saveOrderSettings = saveOrderSettings;
window.updateOrderSettingsUI = updateOrderSettingsUI;
window.updateOrderPreview = updateOrderPreview;
window.toggleOrderSettingsVisibility = toggleOrderSettingsVisibility;
window.updateOrderStatus = updateOrderStatus;
window.confirmOrder = confirmOrder;
window.markReceived = markReceived;
window.cancelOrder = cancelOrder;
window.handleRefund = handleRefund;
window.filterOrders = filterOrders;
window.filterOrdersByStatus = filterOrdersByStatus;
window.logout = logout;
window.toggleDeliveryOffered = toggleDeliveryOffered;
window.toggleDeliveryFree = toggleDeliveryFree;
window.toggleFreeWhere = toggleFreeWhere;
window.updateDeliveryPreview = updateDeliveryPreview;
window.openDeliveryLog = openDeliveryLog;
window.closeDeliveryLog = closeDeliveryLog;
window.confirmDelivery = confirmDelivery;
window.reportDeliveryIssue = reportDeliveryIssue;
window.showToast = showToast;

// Section B — expose the missing-category warning helper
window.applyCategoryWarning = applyCategoryWarning;

console.log('✅ Business Admin JS loaded successfully');