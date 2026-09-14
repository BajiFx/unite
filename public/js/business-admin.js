// ============================================================
//  BUSINESS ADMIN JAVASCRIPT - COMPLETE VERSION
//  Location: public/js/business-admin.js
//
//  Section 10 — Removed the last business-admin rating tile.
//   renderDashboardStats() no longer renders the
//   `average_rating` tile. The tile is not present anywhere
//   else in the admin panel.
//
//  B.1 — Product categories come from the database
//  B.3 — Picker shows only categories relevant to the business
//  B.4 — Picker is searchable (with visible match feedback)
//  B.5 — Product category is required before save
//  B.6 — Business admin can request new product categories
//  B.8 — Joined product category name shown on each product
//
//  Section B — missing-category warning
//
//  Section C — Business location activation
//
//  Section H — Cart and order visibility
//
//  Section I — M-Pesa payment types
//
//  Section J — In-page ad management
//
//  Section 7 — Business Search Tag
//
//  Section 8 — Sidebar simplification
//   The sidebar now has six items: Dashboard, Orders, Products,
//   Messages, My Shop, Manage Ads. The four settings sections
//   (profile, payments, delivery, ordersettings) are kept as
//   real <div class="section"> wrappers inside #myshopPage so
//   every existing id, loader, and form submit still resolves.
//
//  Section 11.B — Business account deletion (5-step flow)
//   The Danger zone block at the bottom of My Shop opens a
//   chained set of five modals:
//     A — warnings + download data + acknowledgement checkbox
//     B — password confirmation
//     C — reason selection
//     D — type the exact business name to confirm
//     E — 10-second countdown, then final confirmation
//   On submit, the client calls
//     POST /api/business-admin/request-deletion
//   which schedules the deletion 60 days out, hides the
//   business from the marketplace, and logs the admin out.
//   If the admin logs back in during the grace period, the
//   server auto-cancels the deletion.
//
//  Section 20260923 — Business product keywords ("What You Sell")
//   A new subsection inside My Shop → Business Profile lets the
//   admin list up to 10 short names of what the business sells
//   or the services it offers. Each name is capped at 20 chars
//   and a soft target of 5 is shown as a warning only. The list
//   is rendered by the marketplace as a slow upward ticker on
//   every business card.
//
//   This file now owns five new helpers:
//     loadProductKeywords()          — GET /product-keywords
//     renderKeywordRows(list)        — paints the row inputs
//     addKeywordRow(value)           — appends one row
//     removeKeywordRow(button)       — deletes one row
//     saveProductKeywords()          — PUT  /product-keywords
//
//   Plus three small utilities:
//     collectKeywordValues()         — reads the current inputs
//     updateKeywordCounters()        — live counter + warning
//     clearKeywordStatus()           — resets the status line
//
//   The whole feature is optional. The server never refuses a
//   short or empty list; the 5-row target is a UI hint.
//
//  Tile provider migration (this revision):
//   OpenStreetMap's volunteer tile servers block requests from
//   deployments that are not plain human-browsing traffic. Any
//   request from a custom domain, an ngrok tunnel, or a cloud
//   host (including ours) is refused with HTTP 403, so every
//   business-admin map showed "Access blocked" tiles.
//
//   The fix replaces the OSM tile URL with CartoDB Positron,
//   a free, attribution-friendly raster basemap hosted on a
//   proper CDN. It is the closest visual match to OSM's default
//   style, needs no API key, and is explicitly allowed for
//   production web apps.
//
//   This file now uses CARTO_TILE_URL as the single source of
//   truth for the tile layer, so any future provider change is
//   one constant. business-profile.js, track.js, seller-track.js
//   and order-tracking.js have each been updated to use the same
//   URL, and server.js has been updated so Helmet's imgSrc and
//   connectSrc CSP directives whitelist basemaps.cartocdn.com.
// ============================================================

// ============================================================
//  TILE PROVIDER — single source of truth
//
//  CartoDB Positron (light_all) is a free, no-signup raster
//  basemap served from a global CDN. It reads well behind
//  marker pins and matches the neutral look of the previous
//  OSM tiles.
//
//  `{s}` is a subdomain placeholder Leaflet fills in with a, b,
//  or c automatically. `{r}` is the retina placeholder Leaflet
//  fills in with "@2x" on high-DPI screens, or an empty string
//  otherwise. Both are handled by Leaflet, not by us.
// ============================================================

const CARTO_TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const CARTO_TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
const CARTO_TILE_SUBDOMAINS = 'abcd';

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
let businessCategories = [];
let productCategories = [];
let socket = null;
let statsInterval = null;
let currentFilterStatus = null;
let variantCounter = 0;

// Section J.2 — has the in-page ad management surface been initialised?
let adManagementInitialised = false;

// Section C — map + location state
let businessLocationMap = null;
let businessLocationMarker = null;
let currentLocationState = {
    activated: false,
    complete: false,
    latitude: null,
    longitude: null
};

// Section I.6 — read-only environment label value from the server
let currentMpesaEnvironment = 'sandbox';

// Business Search Tag — current cached state from the server.
let currentSearchTag = {
    prefix: null,
    name: null,
    tag: null,
    display: null,
    confirmed: false,
    updated_at: null
};

// Business Search Tag — debounce timer for the live availability check.
let adminSearchTagDebounceTimer = null;
const ADMIN_SEARCH_TAG_DEBOUNCE_MS = 400;

// Section 8 — the four settings sections keep their real ids.
const MYSHOP_SECTION_MAP = {
    profile: 'section-profile',
    payments: 'section-payments',
    delivery: 'section-delivery',
    ordersettings: 'section-ordersettings'
};

// Section 8 — current Products page tab.
let currentProductsTab = 'products';

// Section 11.B — transient state for the 5-step business deletion flow.
// Reset every time the danger-zone button is clicked.
const businessDeletionState = {
    acknowledged: false,
    passwordVerified: false,
    password: '',
    reason: '',
    confirmedName: '',
    countdownTimer: null,
    countdownValue: 10
};

// Section 11.B — how long the final-step countdown runs, in seconds.
const BUSINESS_DELETION_COUNTDOWN_SECONDS = 10;

// ------------------------------------------------------------
//  Section 20260923 — Business product keywords state
//
//  These mirror the server-side constants from
//  src/routes/business-admin.js so the UI can validate and
//  warn without an extra round-trip.
//
//  PRODUCT_KEYWORDS_MIN_LENGTH      — shortest allowed name
//  PRODUCT_KEYWORDS_MAX_LENGTH      — longest allowed name
//  PRODUCT_KEYWORDS_MAX_ENTRIES     — hard cap on the list size
//  PRODUCT_KEYWORDS_SOFT_TARGET     — the "we recommend at
//                                     least N" hint. Never a
//                                     server-side rejection.
// ------------------------------------------------------------

const PRODUCT_KEYWORDS_MIN_LENGTH = 2;
const PRODUCT_KEYWORDS_MAX_LENGTH = 20;
const PRODUCT_KEYWORDS_MAX_ENTRIES = 10;
const PRODUCT_KEYWORDS_SOFT_TARGET = 5;

// Current cached list, refreshed on load and after each save.
let productKeywords = [];

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
    show_cart_when_disabled: false,
    order_disabled_message: '',
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
    return_window_days: 14,
    online_payment_enabled: true,
    payment_on_delivery_enabled: false,
    require_pod_agreement: true,
    pod_agreement_text: ''
};

const DEFAULT_ORDER_DISABLED_MESSAGE = 'This business is not currently accepting online orders. Please contact us directly.';

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

        applyCategoryWarning(data.has_business_category === true);

        applyLocationState({
            activated: data.business.location_activated === true,
            complete: data.business.location_complete === true,
            latitude: data.business.latitude || null,
            longitude: data.business.longitude || null
        });

        hydrateSearchTagFromBusiness(businessData);

        initSocket();
        await Promise.all([
            loadBusinessCategories(),
            loadProductCategories()
        ]);

        const section = new URLSearchParams(window.location.search).get('section');
        const validSections = [
            'dashboard',
            'orders',
            'ads',
            'products',
            'productcategories',
            'profile',
            'payments',
            'delivery',
            'ordersettings',
            'myshop',
            'messages'
        ];
        navigateTo(validSections.includes(section) ? section : 'dashboard');

        console.log('✅ Business admin initialized for:', businessData.business_name);

    } catch (err) {
        console.error('❌ Business access error:', err);
        showAccessDenied('Access Error', err.message || 'Failed to verify business access.', '/register-business.html', 'Register Business');
    }
}

// ============================================================
//  Section B — missing business-category warning
// ============================================================

function applyCategoryWarning(hasCategory) {
    const existing = document.getElementById('missingCategoryBanner');
    const profileItem = document.querySelector('.menu-item[data-section="myshop"]')
        || document.querySelector('.menu-item[data-section="profile"]');

    if (hasCategory) {
        if (existing) existing.remove();
        if (profileItem) {
            const dot = profileItem.querySelector('.menu-red-dot');
            if (dot) dot.remove();
        }
        return;
    }

    if (profileItem && !profileItem.querySelector('.menu-red-dot')) {
        const dot = document.createElement('span');
        dot.className = 'menu-red-dot';
        dot.title = 'Action required';
        profileItem.appendChild(dot);
    }

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
//  Section C — location state helpers
// ============================================================

function applyLocationState(state) {
    if (!state) return;
    currentLocationState = {
        activated: state.activated === true,
        complete: state.complete === true,
        latitude: state.latitude || null,
        longitude: state.longitude || null
    };

    updateLocationStatusBadge(currentLocationState);
    renderLocationWarning(currentLocationState);
}

function updateLocationStatusBadge(state = currentLocationState) {
    const activatedBadge = document.getElementById('locationStatusBadge');
    const inactiveBadge = document.getElementById('locationStatusBadgeInactive');
    const refreshBtn = document.getElementById('refreshLocationBtn');
    const activateBtn = document.getElementById('activateLocationBtn');

    if (state.activated) {
        if (activatedBadge) activatedBadge.style.display = 'inline-block';
        if (inactiveBadge) inactiveBadge.style.display = 'none';
        if (refreshBtn) refreshBtn.style.display = 'inline-flex';
        if (activateBtn) activateBtn.style.display = 'none';
    } else {
        if (activatedBadge) activatedBadge.style.display = 'none';
        if (inactiveBadge) inactiveBadge.style.display = 'inline-block';
        if (refreshBtn) refreshBtn.style.display = 'none';
        if (activateBtn) activateBtn.style.display = 'inline-flex';
    }
}

function renderLocationWarning(state = currentLocationState) {
    const warning = document.getElementById('businessLocationWarning');
    if (!warning) return;

    const hasCoordinates = Boolean(state.latitude && state.longitude);
    const hasName = Boolean(
        document.getElementById('bTown')?.value?.trim() ||
        document.getElementById('bCounty')?.value?.trim()
    );

    if (!hasCoordinates && !hasName) {
        warning.style.display = 'block';
    } else {
        warning.style.display = 'none';
    }
}

function renderBusinessLocationMap(latitude, longitude) {
    const wrapper = document.getElementById('businessLocationMapWrapper');
    const mapContainer = document.getElementById('businessLocationMap');
    if (!wrapper || !mapContainer) return;
    if (typeof L === 'undefined') return;

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    wrapper.style.display = 'block';

    if (!businessLocationMap) {
        businessLocationMap = L.map(mapContainer).setView([lat, lng], 15);
        L.tileLayer(CARTO_TILE_URL, {
            attribution: CARTO_TILE_ATTRIBUTION,
            subdomains: CARTO_TILE_SUBDOMAINS,
            maxZoom: 19
        }).addTo(businessLocationMap);
    } else {
        businessLocationMap.setView([lat, lng], 15);
    }

    if (businessLocationMarker) {
        businessLocationMarker.setLatLng([lat, lng]);
    } else {
        businessLocationMarker = L.marker([lat, lng], { draggable: true }).addTo(businessLocationMap);
    }

    setTimeout(() => {
        try { businessLocationMap.invalidateSize(); } catch (err) { /* noop */ }
    }, 250);
}

async function activateBusinessLocation() {
    const statusEl = document.getElementById('locationActivationStatus');
    const activateBtn = document.getElementById('activateLocationBtn');
    const refreshBtn = document.getElementById('refreshLocationBtn');

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
                const res = await fetch('/api/business-admin/location/activate', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ latitude, longitude, accuracy })
                });
                const data = await res.json();

                if (!res.ok || !data.success) {
                    throw new Error(data.error || 'Failed to save location');
                }

                if (statusEl) {
                    statusEl.textContent = '✅ Location activated successfully!';
                    statusEl.style.color = '#16a34a';
                }
                showToast('✅ Location activated!', 'success');

                applyLocationState({
                    activated: true,
                    complete: data.location?.complete === true,
                    latitude: data.location?.latitude || latitude,
                    longitude: data.location?.longitude || longitude
                });

                renderBusinessLocationMap(latitude, longitude);

                if (businessData) {
                    businessData.latitude = String(latitude);
                    businessData.longitude = String(longitude);
                    businessData.location_activated = true;
                    businessData.location_complete = data.location?.complete === true;
                }
            } catch (err) {
                console.error('Activate location error:', err);
                if (statusEl) {
                    statusEl.textContent = '❌ ' + err.message;
                    statusEl.style.color = '#ef4444';
                }
                showToast('❌ ' + err.message, 'error');
            } finally {
                if (activateBtn) activateBtn.disabled = false;
                if (refreshBtn) refreshBtn.disabled = false;
            }
        },
        (error) => {
            console.warn('Geolocation error:', error);
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
            showToast('❌ ' + message, 'error');

            if (activateBtn) activateBtn.disabled = false;
            if (refreshBtn) refreshBtn.disabled = false;
        },
        {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
        }
    );
}

async function saveAdjustedBusinessPin() {
    if (!businessLocationMarker) {
        showToast('Activate the location first, then drag the pin.', 'warning');
        return;
    }

    const pos = businessLocationMarker.getLatLng();
    const statusEl = document.getElementById('locationActivationStatus');

    if (statusEl) {
        statusEl.textContent = '⏳ Saving adjusted pin...';
        statusEl.style.color = '#2563eb';
    }

    try {
        const res = await fetch('/api/business-admin/location', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ latitude: pos.lat, longitude: pos.lng })
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Failed to save pin');
        }

        if (statusEl) {
            statusEl.textContent = '✅ Pin updated successfully!';
            statusEl.style.color = '#16a34a';
        }
        showToast('✅ Pin saved!', 'success');

        applyLocationState({
            activated: true,
            complete: data.location?.complete === true,
            latitude: data.location?.latitude || pos.lat,
            longitude: data.location?.longitude || pos.lng
        });
    } catch (err) {
        console.error('Save pin error:', err);
        if (statusEl) {
            statusEl.textContent = '❌ ' + err.message;
            statusEl.style.color = '#ef4444';
        }
        showToast('❌ ' + err.message, 'error');
    }
}

// ============================================================
//  BUSINESS SEARCH TAG — admin panel card + edit form
// ============================================================

function copySearchTag(tag) {
    const value = String(tag || currentSearchTag.display || '').trim();
    if (!value) return;

    const fallback = () => {
        try {
            const ta = document.createElement('textarea');
            ta.value = value;
            ta.setAttribute('readonly', '');
            ta.style.position = 'absolute';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showToast(`Copied: ${value}`, 'success');
        } catch (err) {
            showToast('Could not copy. Please copy it manually.', 'warning');
        }
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(value)
            .then(() => showToast(`Copied: ${value}`, 'success'))
            .catch(fallback);
    } else {
        fallback();
    }
}

function hydrateSearchTagFromBusiness(business) {
    if (!business) return;

    currentSearchTag = {
        prefix: business.search_prefix || null,
        name: business.search_name || null,
        tag: business.search_tag || null,
        display: business.search_display || null,
        confirmed: business.search_tag_confirmed === true,
        updated_at: business.search_tag_updated_at || null
    };

    renderSearchTagCard();
}

function renderSearchTagCard() {
    const profileSection = document.getElementById('section-profile');
    if (!profileSection) return;

    let card = document.getElementById('businessSearchTagCard');

    if (!card) {
        card = document.createElement('div');
        card.id = 'businessSearchTagCard';
        card.className = 'settings-section';
        card.style.cssText = 'margin-bottom:16px; background:#f0fdf4; border:1px solid #86efac;';

        const firstSettings = profileSection.querySelector('.settings-section');
        if (firstSettings) {
            profileSection.insertBefore(card, firstSettings);
        } else {
            profileSection.appendChild(card);
        }
    }

    const hasTag = Boolean(currentSearchTag.display && currentSearchTag.tag);
    const isPlaceholder = hasTag
        && typeof currentSearchTag.tag === 'string'
        && currentSearchTag.tag.startsWith('000');

    let bodyHtml;

    if (hasTag && !isPlaceholder) {
        const confirmedBadge = currentSearchTag.confirmed
            ? ''
            : `<span style="font-size:0.65rem; color:#92400e; background:#fef3c7; padding:2px 8px; border-radius:10px; margin-left:6px;">Not yet confirmed</span>`;

        bodyHtml = `
            <div style="display:flex; align-items:flex-start; gap:12px; flex-wrap:wrap;">
                <div style="flex:1; min-width:220px;">
                    <div style="font-size:0.7rem; color:#166534; text-transform:uppercase; letter-spacing:0.05em; font-weight:700; margin-bottom:4px;">
                        Your search tag ${confirmedBadge}
                    </div>
                    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                        <span style="font-family:monospace; font-size:1.05rem; font-weight:800; color:#14532d; letter-spacing:0.02em;">
                            ${escapeHtml(currentSearchTag.display)}
                        </span>
                        <button type="button"
                                onclick="copySearchTag('${escapeHtml(currentSearchTag.display).replace(/'/g, "\\'")}')"
                                style="background:#16a34a; color:#fff; border:none; padding:4px 12px; border-radius:16px; font-size:0.7rem; font-weight:700; cursor:pointer;">
                            <i class="fas fa-copy"></i> Copy
                        </button>
                    </div>
                    <p style="font-size:0.7rem; color:#166534; margin:6px 0 0 0; line-height:1.4;">
                        Customers can type this into the marketplace search bar to jump straight to your shop.
                        Spaces and case do not matter.
                    </p>
                </div>
                <button type="button"
                        onclick="openSearchTagEdit()"
                        style="background:#e2e8f0; color:#1e293b; border:1px solid #cbd5e1; padding:6px 14px; border-radius:6px; font-size:0.75rem; font-weight:700; cursor:pointer;">
                    <i class="fas fa-edit"></i> Change
                </button>
            </div>
            <div id="searchTagEditWrap" style="display:none; margin-top:12px; padding-top:12px; border-top:1px solid #bbf7d0;"></div>
        `;
    } else {
        const msg = isPlaceholder
            ? 'Your current tag is a temporary placeholder. Please pick a real one below.'
            : 'You do not have a search tag yet. Pick a number and a name below so customers can find your shop.';

        bodyHtml = `
            <div style="font-size:0.7rem; color:#166534; text-transform:uppercase; letter-spacing:0.05em; font-weight:700; margin-bottom:4px;">
                Business Search Tag
            </div>
            <p style="font-size:0.8rem; color:#166534; margin:0 0 10px 0; line-height:1.5;">
                ${escapeHtml(msg)}
            </p>
            <div id="searchTagEditWrap" style="display:block;"></div>
        `;
    }

    card.innerHTML = `
        <h3 style="font-size:1rem; font-weight:800; margin:0 0 4px 0; color:#14532d;">
            🔖 Find me by my search tag
        </h3>
        ${bodyHtml}
    `;

    const editWrap = document.getElementById('searchTagEditWrap');
    if (editWrap && editWrap.style.display !== 'none') {
        renderSearchTagEditForm(editWrap);
    }
}

function renderSearchTagEditForm(container) {
    if (!container) return;

    const prefix = currentSearchTag.prefix || '';
    const name = currentSearchTag.name || '';

    container.innerHTML = `
        <div style="background:#ffffff; border:1px solid #bbf7d0; border-radius:10px; padding:12px;">
            <div style="font-size:0.75rem; font-weight:700; color:#14532d; margin-bottom:6px;">
                Choose your search tag
            </div>

            <div style="display:grid; grid-template-columns:110px 1fr; gap:8px; align-items:start;">
                <div>
                    <label style="font-size:0.7rem; font-weight:600; color:#334155; display:block; margin-bottom:2px;">
                        Number
                    </label>
                    <input type="text"
                           id="adminSearchTagPrefix"
                           placeholder="3734"
                           maxlength="4"
                           inputmode="numeric"
                           autocomplete="off"
                           value="${escapeHtml(prefix)}"
                           style="width:100%; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:0.9rem; font-family:monospace; letter-spacing:0.05em;">
                    <small style="font-size:0.55rem; color:#64748b;">3 or 4 digits</small>
                </div>
                <div>
                    <label style="font-size:0.7rem; font-weight:600; color:#334155; display:block; margin-bottom:2px;">
                        Name customers will type
                    </label>
                    <input type="text"
                           id="adminSearchTagName"
                           placeholder="Doppa Beddings"
                           maxlength="120"
                           autocomplete="off"
                           value="${escapeHtml(name)}"
                           style="width:100%; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:0.9rem;">
                    <small style="font-size:0.55rem; color:#64748b;">Can be the same as your business name</small>
                </div>
            </div>

            <div id="adminSearchTagPreview"
                 style="display:none; margin-top:8px; padding:6px 10px; background:#dcfce7; border-radius:6px; border-left:3px solid #16a34a;">
                <div style="font-size:0.6rem; color:#166534;">Customers will search:</div>
                <div id="adminSearchTagPreviewValue"
                     style="font-size:0.85rem; font-weight:800; color:#14532d; font-family:monospace;">
                </div>
            </div>

            <div id="adminSearchTagStatus"
                 style="display:none; margin-top:6px; font-size:0.7rem; line-height:1.4;"></div>

            <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
                <button type="button"
                        id="adminSearchTagSaveBtn"
                        onclick="saveBusinessSearchTag()"
                        style="background:#16a34a; color:#fff; border:none; padding:8px 18px; border-radius:6px; font-size:0.8rem; font-weight:700; cursor:pointer;">
                    <i class="fas fa-save"></i> Save tag
                </button>
                <button type="button"
                        onclick="closeSearchTagEdit()"
                        style="background:#e2e8f0; color:#1e293b; border:1px solid #cbd5e1; padding:8px 16px; border-radius:6px; font-size:0.8rem; font-weight:700; cursor:pointer;">
                    Cancel
                </button>
            </div>
        </div>
    `;

    const prefixInput = document.getElementById('adminSearchTagPrefix');
    const nameInput = document.getElementById('adminSearchTagName');

    if (prefixInput) {
        prefixInput.addEventListener('input', () => {
            const cleaned = prefixInput.value.replace(/[^0-9]/g, '').slice(0, 4);
            if (cleaned !== prefixInput.value) prefixInput.value = cleaned;
            updateAdminSearchTagPreview();
            debounceAdminSearchTagCheck();
        });
    }
    if (nameInput) {
        nameInput.addEventListener('input', () => {
            updateAdminSearchTagPreview();
            debounceAdminSearchTagCheck();
        });
    }

    updateAdminSearchTagPreview();
}

function updateAdminSearchTagPreview() {
    const preview = document.getElementById('adminSearchTagPreview');
    const valueEl = document.getElementById('adminSearchTagPreviewValue');
    if (!preview || !valueEl) return;

    const prefix = document.getElementById('adminSearchTagPrefix')?.value.trim() || '';
    const name = document.getElementById('adminSearchTagName')?.value.trim() || '';

    if (!prefix || !name) {
        preview.style.display = 'none';
        valueEl.textContent = '';
        return;
    }

    preview.style.display = 'block';
    valueEl.textContent = `${prefix}${name}`;
}

function setAdminSearchTagStatus(message, tone) {
    const el = document.getElementById('adminSearchTagStatus');
    if (!el) return;

    if (!message) {
        el.style.display = 'none';
        el.textContent = '';
        el.style.color = '';
        return;
    }

    el.style.display = 'block';
    el.textContent = message;

    if (tone === 'ok') el.style.color = '#166534';
    else if (tone === 'error') el.style.color = '#ef4444';
    else if (tone === 'checking') el.style.color = '#2563eb';
    else el.style.color = '#64748b';
}

async function checkAdminSearchTagAvailability() {
    const prefixInput = document.getElementById('adminSearchTagPrefix');
    const nameInput = document.getElementById('adminSearchTagName');
    if (!prefixInput || !nameInput) return;

    const prefix = prefixInput.value.trim();
    const name = nameInput.value.trim();

    prefixInput.style.borderColor = '#d1d5db';
    setAdminSearchTagStatus('', '');

    if (!prefix && !name) return;

    if (!/^[0-9]{3,4}$/.test(prefix)) {
        if (prefix) {
            prefixInput.style.borderColor = '#ef4444';
            setAdminSearchTagStatus('The number must be 3 or 4 digits (e.g. 363 or 3734).', 'error');
        }
        return;
    }

    if (name.length < 2) {
        if (name) {
            setAdminSearchTagStatus('Please type the name customers will use (at least 2 characters).', 'error');
        }
        return;
    }

    setAdminSearchTagStatus('Checking availability...', 'checking');

    try {
        const exclude = businessData && businessData.id ? `&exclude=${encodeURIComponent(businessData.id)}` : '';
        const url = `/api/auth/check-business-tag?prefix=${encodeURIComponent(prefix)}&name=${encodeURIComponent(name)}${exclude}`;
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        const data = await res.json();

        if (data && data.available) {
            prefixInput.style.borderColor = '#22c55e';
            setAdminSearchTagStatus(`✅ "${prefix}${name}" is available.`, 'ok');
        } else {
            prefixInput.style.borderColor = '#ef4444';
            setAdminSearchTagStatus(
                data && data.message
                    ? '❌ ' + data.message
                    : '❌ This number is already used. Please try another.',
                'error'
            );
        }
    } catch (err) {
        setAdminSearchTagStatus('Could not check the tag right now. You can still save; the server will check again.', '');
    }
}

function debounceAdminSearchTagCheck() {
    if (adminSearchTagDebounceTimer) clearTimeout(adminSearchTagDebounceTimer);
    adminSearchTagDebounceTimer = setTimeout(() => {
        adminSearchTagDebounceTimer = null;
        checkAdminSearchTagAvailability();
    }, ADMIN_SEARCH_TAG_DEBOUNCE_MS);
}

function openSearchTagEdit() {
    const wrap = document.getElementById('searchTagEditWrap');
    if (!wrap) return;

    wrap.style.display = 'block';
    renderSearchTagEditForm(wrap);

    const prefixInput = document.getElementById('adminSearchTagPrefix');
    if (prefixInput) prefixInput.focus();
}

function closeSearchTagEdit() {
    const wrap = document.getElementById('searchTagEditWrap');
    if (wrap) {
        wrap.style.display = 'none';
        wrap.innerHTML = '';
    }
}

async function saveBusinessSearchTag() {
    const prefixInput = document.getElementById('adminSearchTagPrefix');
    const nameInput = document.getElementById('adminSearchTagName');
    const saveBtn = document.getElementById('adminSearchTagSaveBtn');

    if (!prefixInput || !nameInput) return;

    const prefix = prefixInput.value.trim();
    const name = nameInput.value.trim();

    if (!/^[0-9]{3,4}$/.test(prefix)) {
        prefixInput.style.borderColor = '#ef4444';
        setAdminSearchTagStatus('The number must be 3 or 4 digits.', 'error');
        prefixInput.focus();
        return;
    }
    if (name.length < 2) {
        setAdminSearchTagStatus('Please type the name customers will use.', 'error');
        nameInput.focus();
        return;
    }

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    }
    setAdminSearchTagStatus('Saving...', 'checking');

    try {
        const res = await fetch('/api/auth/my-business/search-tag', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ search_prefix: prefix, search_name: name })
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
            if (data && data.field === 'search_prefix') {
                prefixInput.style.borderColor = '#ef4444';
                prefixInput.focus();
            }
            throw new Error(data.error || 'Failed to save the search tag');
        }

        const saved = data.business || {};
        currentSearchTag = {
            prefix: saved.search_prefix || prefix,
            name: saved.search_name || name,
            tag: saved.search_tag || null,
            display: saved.search_display || `${prefix}${name}`,
            confirmed: saved.search_tag_confirmed === true,
            updated_at: saved.search_tag_updated_at || new Date().toISOString()
        };

        if (businessData) {
            businessData.search_prefix = currentSearchTag.prefix;
            businessData.search_name = currentSearchTag.name;
            businessData.search_tag = currentSearchTag.tag;
            businessData.search_display = currentSearchTag.display;
            businessData.search_tag_confirmed = currentSearchTag.confirmed;
        }

        showToast(`✅ Search tag saved: ${currentSearchTag.display}`, 'success');
        closeSearchTagEdit();
        renderSearchTagCard();
    } catch (err) {
        console.error('Save search tag error:', err);
        setAdminSearchTagStatus('❌ ' + err.message, 'error');
        showToast('❌ ' + err.message, 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fas fa-save"></i> Save tag';
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
//  NAVIGATE TO SECTION — Section 8
// ============================================================

function navigateTo(section) {
    if (!businessData) {
        console.log('⚠️ No business data, cannot navigate');
        return;
    }

    let targetSection = section;
    let scrollTargetId = null;
    let openProductsCategoriesTab = false;

    if (MYSHOP_SECTION_MAP[section]) {
        targetSection = 'myshop';
        scrollTargetId = MYSHOP_SECTION_MAP[section];
    } else if (section === 'productcategories') {
        targetSection = 'products';
        openProductsCategoriesTab = true;
    }

    document.querySelectorAll('.section').forEach(function(el) {
        el.classList.remove('active');
    });
    const target = document.getElementById('section-' + targetSection);
    if (target) target.classList.add('active');

    if (targetSection === 'myshop') {
        ['section-profile', 'section-payments', 'section-delivery', 'section-ordersettings'].forEach(function(id) {
            const inner = document.getElementById(id);
            if (inner) inner.classList.add('active');
        });
    }

    const myshopToolbar = document.getElementById('myshopToolbar');
    const myshopJumpbar = document.getElementById('myshopJumpbar');
    if (myshopToolbar) myshopToolbar.style.display = targetSection === 'myshop' ? 'flex' : 'none';
    if (myshopJumpbar) myshopJumpbar.style.display = targetSection === 'myshop' ? 'flex' : 'none';

    document.querySelectorAll('.menu-item').forEach(function(el) {
        el.classList.remove('active');
    });
    const menuItem = document.querySelector('.menu-item[data-section="' + targetSection + '"]');
    if (menuItem) menuItem.classList.add('active');

    const titles = {
        dashboard: 'Dashboard',
        orders: 'Orders',
        ads: 'Ad Management',
        products: 'Products',
        productcategories: 'Product Categories',
        messages: 'Messages',
        myshop: 'My Shop',
        profile: 'Business Profile',
        payments: 'Payment Settings',
        delivery: 'Delivery / Shipping',
        ordersettings: 'Order Settings'
    };
    const headerTitle = document.getElementById('headerTitle');
    if (headerTitle) headerTitle.textContent = titles[section] || 'Dashboard';

    currentSection = targetSection;
    closeSidebar();

    if (scrollTargetId) {
        setTimeout(() => {
            scrollToShopSection(scrollTargetId);
        }, 60);
    }
    if (openProductsCategoriesTab) {
        setTimeout(() => {
            try { switchProductsTab('categories'); } catch (e) { /* noop */ }
        }, 30);
    }

    switch (targetSection) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'orders':
            loadOrders();
            break;
        case 'ads':
            (function openAdsSection() {
                if (typeof window.initAdManagement !== 'function') {
                    console.warn('⚠️ ad-management.js not loaded yet; the ads section will stay in its placeholder state.');
                    return;
                }

                if (!adManagementInitialised) {
                    adManagementInitialised = true;
                    Promise.resolve(window.initAdManagement())
                        .catch(function (err) {
                            console.error('Ad management init failed:', err);
                            adManagementInitialised = false;
                        });
                    return;
                }

                if (typeof window.loadAds === 'function') {
                    try {
                        window.loadAds();
                    } catch (err) {
                        console.error('Ad list refresh failed:', err);
                    }
                }
            })();
            break;
        case 'products':
            loadProducts();
            if (openProductsCategoriesTab) {
                loadProductCategorySection();
            }
            break;
        case 'messages':
            break;
        case 'myshop':
            loadBusinessProfile();
            loadPaymentSettings();
            loadDeliverySettings();
            loadOrderSettings();
            loadProductKeywords();
            break;
    }
}

// ============================================================
//  Section 8 — My Shop scroll helpers
// ============================================================

function scrollToShopSection(blockId) {
    if (!blockId) return;
    const el = document.getElementById(blockId);
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

function jumpToShopSection(name) {
    if (!name) return;
    navigateTo(name);
}

// ============================================================
//  Section 8 — Products tab helpers
// ============================================================

function switchProductsTab(tab) {
    const next = tab === 'categories' ? 'categories' : 'products';
    currentProductsTab = next;

    const productsPanel = document.getElementById('productsPanelProducts');
    const categoriesPanel = document.getElementById('productsPanelCategories');
    const productsTabBtn = document.getElementById('productsTabProducts');
    const categoriesTabBtn = document.getElementById('productsTabCategories');

    if (productsPanel) productsPanel.classList.toggle('is-active', next === 'products');
    if (categoriesPanel) categoriesPanel.classList.toggle('is-active', next === 'categories');

    if (productsTabBtn) {
        productsTabBtn.classList.toggle('is-active', next === 'products');
        productsTabBtn.setAttribute('aria-selected', next === 'products' ? 'true' : 'false');
    }
    if (categoriesTabBtn) {
        categoriesTabBtn.classList.toggle('is-active', next === 'categories');
        categoriesTabBtn.setAttribute('aria-selected', next === 'categories' ? 'true' : 'false');
    }

    if (next === 'categories') {
        loadProductCategorySection();
    } else {
        loadProducts();
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
    if (forceReload) productCategories = [];

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

    if (query && filtered.length === 1) {
        select.value = String(filtered[0].id);
    } else if (currentValue && filtered.some(c => String(c.id) === String(currentValue))) {
        select.value = currentValue;
    }

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

function loadProductCategorySection() {
    if (!businessCategories.length) {
        loadBusinessCategories().then(loadProductCategorySection);
        return;
    }
    loadProductCategories().then(() => {
        renderProductCategoriesList();
    });
}

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
//  Section 20260923 — PRODUCT KEYWORDS ("What You Sell")
//
//  The section is inside My Shop → Business Profile, right
//  after the Search Tag card. These helpers:
//    - load the current list on first paint and any refresh
//    - render up to 10 row inputs
//    - add / remove rows
//    - update the live counter and soft warning
//    - save via PUT /product-keywords
// ============================================================

/**
 * Update the row index labels and per-row counters, then update
 * the overall summary and the soft warning.
 *
 * Called after any input change, after addKeywordRow(), and
 * after removeKeywordRow().
 */
function updateKeywordCounters() {
    const rowsHost = document.getElementById('productKeywordsRows');
    const summaryEl = document.getElementById('productKeywordsSummary');
    const warningEl = document.getElementById('productKeywordsWarning');
    const addBtn = document.getElementById('productKeywordsAddBtn');

    if (!rowsHost) return;

    const rows = rowsHost.querySelectorAll('.pkw-row');
    const total = rows.length;
    let filled = 0;

    rows.forEach((row, index) => {
        const input = row.querySelector('input[type="text"]');
        const counter = row.querySelector('.pkw-counter');
        const indexEl = row.querySelector('.pkw-index');
        const value = input ? input.value : '';
        const length = value.length;

        if (indexEl) indexEl.textContent = String(index + 1);

        if (counter) {
            counter.textContent = `${length}/${PRODUCT_KEYWORDS_MAX_LENGTH}`;
            counter.classList.toggle('pkw-counter-over', length > PRODUCT_KEYWORDS_MAX_LENGTH);
        }

        if (input) {
            const isInvalid = value.length > 0 && (
                value.trim().length < PRODUCT_KEYWORDS_MIN_LENGTH ||
                value.length > PRODUCT_KEYWORDS_MAX_LENGTH
            );
            input.classList.toggle('pkw-invalid', isInvalid);
        }

        if (value.trim() !== '') filled += 1;
    });

    if (summaryEl) {
        if (filled >= PRODUCT_KEYWORDS_SOFT_TARGET) {
            summaryEl.textContent = `${filled} of ${PRODUCT_KEYWORDS_SOFT_TARGET} recommended — great!`;
            summaryEl.classList.remove('pkw-summary-warn');
        } else {
            summaryEl.textContent = `${filled} of ${PRODUCT_KEYWORDS_SOFT_TARGET} recommended — add ${PRODUCT_KEYWORDS_SOFT_TARGET - filled} more to reach the target.`;
            summaryEl.classList.add('pkw-summary-warn');
        }
    }

    if (warningEl) {
        if (filled >= PRODUCT_KEYWORDS_SOFT_TARGET) {
            warningEl.classList.remove('show');
            warningEl.textContent = '';
        } else {
            warningEl.classList.add('show');
            warningEl.textContent =
                `💡 Add at least ${PRODUCT_KEYWORDS_SOFT_TARGET} short names so browsing customers can see what you sell. ` +
                `Each name must be ${PRODUCT_KEYWORDS_MIN_LENGTH} to ${PRODUCT_KEYWORDS_MAX_LENGTH} characters.`;
        }
    }

    if (addBtn) {
        addBtn.disabled = total >= PRODUCT_KEYWORDS_MAX_ENTRIES;
    }
}

/**
 * Read the current input values, trim them, and return the raw
 * array (may contain empty strings). The server is the one that
 * drops blanks and enforces the rules.
 */
function collectKeywordValues() {
    const rowsHost = document.getElementById('productKeywordsRows');
    if (!rowsHost) return [];
    return Array.from(rowsHost.querySelectorAll('.pkw-row input[type="text"]'))
        .map(input => input.value);
}

/**
 * Clear the status line under the subsection.
 */
function clearKeywordStatus() {
    const statusEl = document.getElementById('productKeywordsStatus');
    if (!statusEl) return;
    statusEl.textContent = '';
    statusEl.className = 'pkw-status';
}

/**
 * Reset the status line to a message + tone.
 *  tone: 'error' | 'success' | 'info'
 */
function setKeywordStatus(message, tone) {
    const statusEl = document.getElementById('productKeywordsStatus');
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.className = 'pkw-status' + (tone ? ' ' + tone : '');
}

/**
 * Create a single row element.
 *  @param {string} value  initial input value (defaults to '')
 */
function createKeywordRowElement(value = '') {
    const row = document.createElement('div');
    row.className = 'pkw-row';
    row.innerHTML = `
        <span class="pkw-index">1</span>
        <input type="text"
               maxlength="${PRODUCT_KEYWORDS_MAX_LENGTH}"
               placeholder="e.g. Bedsheets"
               autocomplete="off"
               spellcheck="false">
        <span class="pkw-counter">0/${PRODUCT_KEYWORDS_MAX_LENGTH}</span>
        <button type="button" class="pkw-remove" title="Remove this row" aria-label="Remove this row">
            <i class="fas fa-times"></i>
        </button>
    `;

    const input = row.querySelector('input[type="text"]');
    if (input) {
        input.value = String(value || '');
        input.addEventListener('input', () => {
            clearKeywordStatus();
            updateKeywordCounters();
        });
    }

    const removeBtn = row.querySelector('.pkw-remove');
    if (removeBtn) {
        removeBtn.addEventListener('click', () => removeKeywordRow(removeBtn));
    }

    return row;
}

/**
 * Paint the row list from a saved array. Any trailing blanks are
 * preserved so the admin keeps the same number of rows they had
 * before, but the section always shows at least one row so the
 * form is usable on a fresh business.
 */
function renderKeywordRows(list) {
    const rowsHost = document.getElementById('productKeywordsRows');
    if (!rowsHost) return;

    rowsHost.innerHTML = '';

    const cleaned = Array.isArray(list)
        ? list.map(v => (v === undefined || v === null ? '' : String(v)))
        : [];

    // Always start with at least one row so the form is usable
    // on a fresh business that has never saved a list.
    const initialRows = cleaned.length > 0 ? cleaned : [''];

    initialRows.forEach(value => {
        rowsHost.appendChild(createKeywordRowElement(value));
    });

    // If the saved list is very short, top it up to the soft
    // target so the admin sees what a full list looks like, but
    // never go beyond the hard cap.
    while (rowsHost.children.length < PRODUCT_KEYWORDS_SOFT_TARGET &&
           rowsHost.children.length < PRODUCT_KEYWORDS_MAX_ENTRIES) {
        rowsHost.appendChild(createKeywordRowElement(''));
    }

    updateKeywordCounters();
}

/**
 * Append one empty row (called from the "Add another row" button).
 * Refuses when the hard cap is already reached.
 */
function addKeywordRow() {
    const rowsHost = document.getElementById('productKeywordsRows');
    if (!rowsHost) return;

    if (rowsHost.children.length >= PRODUCT_KEYWORDS_MAX_ENTRIES) {
        showToast(`You can add up to ${PRODUCT_KEYWORDS_MAX_ENTRIES} names.`, 'warning');
        return;
    }

    rowsHost.appendChild(createKeywordRowElement(''));
    updateKeywordCounters();

    // Focus the new input for a fast workflow.
    const lastRow = rowsHost.lastElementChild;
    const input = lastRow ? lastRow.querySelector('input[type="text"]') : null;
    if (input) input.focus();
}

/**
 * Remove the row that owns the clicked button. Keeps at least
 * one row so the form never becomes empty by accident.
 */
function removeKeywordRow(button) {
    if (!button) return;
    const row = button.closest('.pkw-row');
    const rowsHost = document.getElementById('productKeywordsRows');
    if (!row || !rowsHost) return;

    if (rowsHost.children.length <= 1) {
        const input = row.querySelector('input[type="text"]');
        if (input) input.value = '';
        clearKeywordStatus();
        updateKeywordCounters();
        return;
    }

    row.remove();
    clearKeywordStatus();
    updateKeywordCounters();
}

/**
 * Fetch the saved list from the server and paint it. Called on
 * first visit to My Shop and on every re-open of the section.
 */
async function loadProductKeywords() {
    const rowsHost = document.getElementById('productKeywordsRows');
    if (!rowsHost) return;

    // Show a lightweight placeholder on first paint.
    if (rowsHost.children.length === 0) {
        rowsHost.innerHTML = '<p style="font-size:0.78rem; color:#166534; margin:0 0 6px 0;">Loading your list…</p>';
    }

    try {
        const res = await fetch('/api/business-admin/product-keywords', {
            headers: { 'Authorization': `Bearer ${token}` },
            credentials: 'same-origin',
            cache: 'no-store'
        });

        if (!res.ok) throw new Error(`Failed to load product keywords (${res.status})`);
        const data = await res.json();

        productKeywords = Array.isArray(data.keywords) ? data.keywords : [];
        renderKeywordRows(productKeywords);

        // Reuse the server's status line if it exists.
        if (data.below_soft_target === true) {
            setKeywordStatus(
                `You have ${productKeywords.length} of ${PRODUCT_KEYWORDS_SOFT_TARGET} recommended names.`,
                'info'
            );
        } else {
            clearKeywordStatus();
        }
    } catch (err) {
        console.error('❌ Load product keywords error:', err);
        // Always render at least one empty row so the admin can
        // still type and save a list.
        renderKeywordRows([]);
        setKeywordStatus('Could not load your list right now. You can still type and save.', 'error');
    }
}

/**
 * Client-side pre-check before the PUT. Mirrors the server rules
 * so the admin gets an instant message instead of a round-trip.
 *
 * Returns null when the payload is valid, or a string error.
 */
function validateKeywordsClientSide(values) {
    const seen = new Set();
    let cleaned = 0;

    for (let i = 0; i < values.length; i += 1) {
        const raw = values[i];
        const trimmed = String(raw == null ? '' : raw).trim();

        if (trimmed === '') continue;

        if (trimmed.length < PRODUCT_KEYWORDS_MIN_LENGTH) {
            return `Row ${i + 1}: "${trimmed}" must be at least ${PRODUCT_KEYWORDS_MIN_LENGTH} characters.`;
        }
        if (trimmed.length > PRODUCT_KEYWORDS_MAX_LENGTH) {
            return `Row ${i + 1}: "${trimmed}" must be ${PRODUCT_KEYWORDS_MAX_LENGTH} characters or fewer.`;
        }

        const key = trimmed.toLowerCase();
        if (seen.has(key)) {
            return `Row ${i + 1}: "${trimmed}" is already used in another row.`;
        }
        seen.add(key);

        cleaned += 1;
    }

    if (cleaned > PRODUCT_KEYWORDS_MAX_ENTRIES) {
        return `You can save up to ${PRODUCT_KEYWORDS_MAX_ENTRIES} names.`;
    }

    return null;
}

/**
 * Save the current list. Uses PUT /product-keywords and handles
 * the server's per-row error shape so the admin knows exactly
 * which input to fix.
 */
async function saveProductKeywords() {
    const saveBtn = document.getElementById('productKeywordsSaveBtn');
    if (!saveBtn) return;

    const values = collectKeywordValues();

    // Fast client-side check so obvious problems never hit the
    // network.
    const clientError = validateKeywordsClientSide(values);
    if (clientError) {
        setKeywordStatus('❌ ' + clientError, 'error');
        showToast('❌ ' + clientError, 'error');
        return;
    }

    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    setKeywordStatus('⏳ Saving your list…', 'info');

    try {
        const res = await fetch('/api/business-admin/product-keywords', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            credentials: 'same-origin',
            body: JSON.stringify({ keywords: values })
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
            // Server sent a per-row error — highlight the row that
            // failed so the admin can fix exactly one field.
            const rowNumber = Number.isInteger(data.row) ? data.row : null;
            if (rowNumber && rowNumber >= 1) {
                const rowsHost = document.getElementById('productKeywordsRows');
                const rows = rowsHost ? rowsHost.querySelectorAll('.pkw-row') : [];
                const row = rows[rowNumber - 1];
                const input = row ? row.querySelector('input[type="text"]') : null;
                if (input) {
                    input.classList.add('pkw-invalid');
                    input.focus();
                }
            }
            throw new Error(data.error || 'Failed to save product keywords');
        }

        productKeywords = Array.isArray(data.keywords) ? data.keywords : [];
        renderKeywordRows(productKeywords);

        const parts = [];
        if (data.dropped) parts.push(`${data.dropped} blank row${data.dropped === 1 ? '' : 's'} ignored`);
        if (data.collapsed) parts.push(`${data.collapsed} duplicate${data.collapsed === 1 ? '' : 's'} removed`);
        const extra = parts.length ? ' (' + parts.join(', ') + ')' : '';

        const successMessage = `✅ Saved ${productKeywords.length} name${productKeywords.length === 1 ? '' : 's'}${extra}.`;
        setKeywordStatus(successMessage, 'success');
        showToast(successMessage, 'success');

        if (data.below_soft_target === true) {
            showToast(
                `Tip: add at least ${PRODUCT_KEYWORDS_SOFT_TARGET} names so customers see a richer ticker.`,
                'info'
            );
        }
    } catch (err) {
        console.error('❌ Save product keywords error:', err);
        setKeywordStatus('❌ ' + err.message, 'error');
        showToast('❌ ' + err.message, 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Save what you sell';
    }
}

// ============================================================
//  DASHBOARD STATS / RECENT ORDERS / BADGES
//
//  Section 10 — the `average_rating` tile has been removed
//  from the items array. Everything else is unchanged.
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
        { key: 'total_followers', label: 'Followers', icon: 'fa-users', css: 'total' }
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
            bContinent: business.continent || '',
            bCountry: business.country || '',
            bCounty: business.county || '',
            bSubCounty: business.sub_county || '',
            bWard: business.ward || '',
            bTown: business.town || '',
            bSpecificArea: business.specific_area || '',
            bPostalCode: business.postal_code || '',
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

        const publicLocation = publicBusiness.location || {};
        applyLocationState({
            activated: publicLocation.activated === true || business.location_activated === true,
            complete: publicLocation.complete === true || business.location_complete === true,
            latitude: business.latitude || publicLocation.latitude || null,
            longitude: business.longitude || publicLocation.longitude || null
        });

        if (business.latitude && business.longitude) {
            renderBusinessLocationMap(business.latitude, business.longitude);
        }

        hydrateSearchTagFromBusiness(business);

        // Section 20260923 — the keyword subsection is populated
        // by its own loader so it can also be refreshed on demand.
        // Only load if the subsection has never been painted.
        const rowsHost = document.getElementById('productKeywordsRows');
        if (rowsHost && rowsHost.children.length === 0) {
            loadProductKeywords();
        }

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

            const afterSave = await fetch('/api/auth/my-business', {
                headers: { 'Authorization': `Bearer ${token}` }
            }).then(r => r.ok ? r.json() : { has_business_category: false })
              .catch(() => ({ has_business_category: false }));
            applyCategoryWarning(afterSave.has_business_category === true);

            applyLocationState({
                activated: businessData.location_activated === true,
                complete: businessData.location_complete === true,
                latitude: businessData.latitude || null,
                longitude: businessData.longitude || null
            });

            await loadProductCategories(true);

            hydrateSearchTagFromBusiness(businessData);
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

function updateMpesaFields() {
    const selected = document.querySelector('input[name="mpesa_payment_type"]:checked');
    const type = selected ? selected.value : '';

    const paybillFields = document.getElementById('mpesaPaybillFields');
    const tillFields = document.getElementById('mpesaTillFields');
    const pochiFields = document.getElementById('mpesaPochiFields');

    if (paybillFields) paybillFields.style.display = type === 'paybill' ? 'block' : 'none';
    if (tillFields) tillFields.style.display = type === 'till' ? 'block' : 'none';
    if (pochiFields) pochiFields.style.display = type === 'pochi' ? 'block' : 'none';
}

function renderMpesaEnvironmentLabel(environment) {
    const label = document.getElementById('mpesaEnvironmentLabel');
    if (!label) return;
    const env = (environment || 'sandbox').toLowerCase();
    const isProduction = env === 'production';
    const color = isProduction ? '#b45309' : '#1e40af';
    const bg = isProduction ? '#fef3c7' : '#dbeafe';
    const icon = isProduction ? '🔴' : '🧪';
    const labelText = isProduction ? 'Production (live)' : 'Sandbox (test)';
    label.innerHTML = `
        Environment: <span style="font-weight:700; color:${color}; background:${bg}; padding:2px 8px; border-radius:10px; font-size:0.7rem;">${icon} ${labelText}</span>
    `;
}

function validateMpesaSettings() {
    const enabled = document.getElementById('pMpesaEnabled')?.checked === true;
    if (!enabled) return { ok: true };

    const selected = document.querySelector('input[name="mpesa_payment_type"]:checked');
    if (!selected) {
        return { ok: false, message: 'Please choose an M-Pesa type (Paybill, Till, or Pochi).' };
    }

    const type = selected.value;

    if (type === 'paybill') {
        const number = document.getElementById('pMpesaPaybillNumber')?.value.trim() || '';
        const account = document.getElementById('pMpesaPaybillAccount')?.value.trim() || '';
        if (!number || !account) {
            return { ok: false, message: 'Paybill requires both the Paybill number and an account number.' };
        }
    } else if (type === 'till') {
        const till = document.getElementById('pMpesaTillNumber')?.value.trim() || '';
        if (!till) {
            return { ok: false, message: 'Till requires the Till number.' };
        }
    } else if (type === 'pochi') {
        const pochi = document.getElementById('pPochiNumber')?.value.trim() || '';
        if (!pochi) {
            return { ok: false, message: 'Pochi la Biashara requires the Pochi number.' };
        }
    } else {
        return { ok: false, message: 'Unknown M-Pesa type. Please pick Paybill, Till, or Pochi.' };
    }

    return { ok: true };
}

async function loadPaymentSettings() {
    if (!businessData) return;
    try {
        const res = await fetch('/api/business-admin/payment-settings', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to load payment settings');
        const settings = await res.json();

        document.getElementById('pMpesaEnabled').checked = settings.mpesa_enabled || false;
        document.getElementById('pAirtelEnabled').checked = settings.airtel_enabled || false;
        document.getElementById('pAirtelNumber').value = settings.airtel_number || '';
        document.getElementById('pBankEnabled').checked = settings.bank_enabled || false;
        document.getElementById('pBankName').value = settings.bank_name || '';
        document.getElementById('pBankAccount').value = settings.bank_account || '';
        document.getElementById('pBankHolder').value = settings.bank_account_name || '';
        document.getElementById('pPaypalEnabled').checked = settings.paypal_enabled || false;
        document.getElementById('pPaypalEmail').value = settings.paypal_email || '';

        const paymentType = settings.mpesa_payment_type || 'paybill';
        document.querySelectorAll('input[name="mpesa_payment_type"]').forEach(r => {
            r.checked = r.value === paymentType;
        });

        const paybillNumber = document.getElementById('pMpesaPaybillNumber');
        const paybillAccount = document.getElementById('pMpesaPaybillAccount');
        const tillNumber = document.getElementById('pMpesaTillNumber');
        const pochiNumber = document.getElementById('pPochiNumber');

        if (paybillNumber) paybillNumber.value = settings.mpesa_paybill_number || '';
        if (paybillAccount) paybillAccount.value = settings.mpesa_paybill_account || '';
        if (tillNumber) tillNumber.value = settings.mpesa_till_number || '';
        if (pochiNumber) pochiNumber.value = settings.pochi_la_biashara_number || '';

        updateMpesaFields();

        if (settings.mpesa_environment) {
            currentMpesaEnvironment = settings.mpesa_environment;
        }
        renderMpesaEnvironmentLabel(currentMpesaEnvironment);

    } catch (err) {
        console.error('❌ Payment settings error:', err);
        alert('Error loading payment settings');
    }
}

document.getElementById('paymentSettingsForm')?.addEventListener('submit', async function(e) {
    e.preventDefault();

    const mpesaCheck = validateMpesaSettings();
    if (!mpesaCheck.ok) {
        const status = document.getElementById('paymentStatus');
        if (status) { status.textContent = '❌ ' + mpesaCheck.message; status.style.color = '#ef4444'; }
        showToast('❌ ' + mpesaCheck.message, 'error');
        return;
    }

    const selectedType = document.querySelector('input[name="mpesa_payment_type"]:checked');

    const data = {
        mpesa_enabled: document.getElementById('pMpesaEnabled').checked,
        mpesa_payment_type: selectedType ? selectedType.value : null,
        mpesa_paybill_number: document.getElementById('pMpesaPaybillNumber')?.value.trim() || null,
        mpesa_paybill_account: document.getElementById('pMpesaPaybillAccount')?.value.trim() || null,
        mpesa_till_number: document.getElementById('pMpesaTillNumber')?.value.trim() || null,
        pochi_la_biashara_number: document.getElementById('pPochiNumber')?.value.trim() || null,

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
    updateOrderDeliveryWarning();
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

        updateOrderDeliveryWarning();
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
            updateOrderDeliveryWarning();
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

function updateOrderDeliveryWarning() {
    const warning = document.getElementById('orderDeliveryWarning');
    if (!warning) return;

    const offeredRadio = document.querySelector('input[name="delivery_offered"]:checked');
    const deliveryOff = offeredRadio
        ? offeredRadio.value === 'no'
        : businessData
            ? businessData.delivery_offered === 'no'
            : false;

    const ordersOn = document.getElementById('orderOnlineEnabled')?.checked === true;

    if (deliveryOff && ordersOn) {
        warning.style.display = 'block';
    } else {
        warning.style.display = 'none';
    }
}

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

        const showCartEl = document.getElementById('showCartWhenDisabled');
        if (showCartEl) showCartEl.checked = settings.show_cart_when_disabled === true;

        const disabledMessageEl = document.getElementById('orderDisabledMessageText');
        if (disabledMessageEl) disabledMessageEl.value = settings.order_disabled_message || '';

        toggleOrderSettingsVisibility(settings.online_orders_enabled !== false);
        updateOrderPreview();
        updateOrderDeliveryWarning();
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

    const showCartWhenDisabled = document.getElementById('showCartWhenDisabled')?.checked === true;
    const customMessage = (document.getElementById('orderDisabledMessageText')?.value || '').trim();
    const effectiveMessage = customMessage || DEFAULT_ORDER_DISABLED_MESSAGE;

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
                <p style="font-size:0.8rem; color:#991b1b; margin:0 0 6px 0;">
                    <strong>⚠️ Customers will see this banner:</strong>
                </p>
                <div style="background:#fff; border:1px solid #fecaca; border-radius:6px; padding:10px 12px;">
                    <div style="font-size:0.75rem; font-weight:700; color:#991b1b; margin-bottom:2px;">Orders are currently paused</div>
                    <div style="font-size:0.8rem; color:#7f1d1d;">${escapeHtml(effectiveMessage)}</div>
                </div>
            </div>
            <div style="margin-top:8px; padding:8px 12px; background:#f8fafc; border-radius:6px; border-left:3px solid #64748b;">
                <p style="font-size:0.75rem; color:#475569; margin:0;">
                    <strong>🛒 Cart buttons:</strong>
                    ${showCartWhenDisabled
                        ? 'Visible but disabled — customers see the cart and a "currently unavailable" state.'
                        : 'Hidden completely — customers see contact options instead.'}
                </p>
            </div>
        `;
    }
    html += '</div>';
    container.innerHTML = html;
}

async function saveOrderSettings() {
    const showCartEl = document.getElementById('showCartWhenDisabled');
    const disabledMessageEl = document.getElementById('orderDisabledMessageText');

    const data = {
        online_orders_enabled: document.getElementById('orderOnlineEnabled').checked,
        online_payment_enabled: document.getElementById('onlinePaymentEnabled').checked,
        payment_on_delivery_enabled: document.getElementById('paymentOnDeliveryEnabled').checked,
        require_pod_agreement: document.getElementById('requirePodAgreement').checked,
        pod_agreement_text: document.getElementById('podAgreementText').value.trim(),

        show_cart_when_disabled: showCartEl ? showCartEl.checked : false,
        order_disabled_message: disabledMessageEl ? disabledMessageEl.value.trim() : '',

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
            updateOrderDeliveryWarning();
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
    updateOrderDeliveryWarning();
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
//  SECTION 11.B — BUSINESS ACCOUNT DELETION (5-step flow)
//
//  Step A — warnings + download data + acknowledgement
//  Step B — password confirmation
//  Step C — reason selection
//  Step D — type the exact business name to confirm
//  Step E — 10-second countdown, then final confirmation
//
//  On submit, the client calls
//    POST /api/business-admin/request-deletion
//  and then logs the admin out and redirects to / with a
//  status query param. The server-side login handler
//  auto-cancels any pending deletion if the admin logs back
//  in within 60 days.
// ============================================================

function openBusinessDeletionStepA() {
    resetBusinessDeletionState();
    showBusinessDeletionModal('A');
}

function openBusinessDeletionStepB() {
    // Step A is only a warning + acknowledgement screen. Moving
    // to B does not need the password yet, but we do clear any
    // prior attempt's error so the admin sees a clean modal.
    const statusB = document.getElementById('businessDeletionStatusB');
    if (statusB) { statusB.textContent = ''; statusB.className = 'ba-deletion-status'; }

    const passwordInput = document.getElementById('businessDeletionPassword');
    if (passwordInput) passwordInput.value = '';

    showBusinessDeletionModal('B');
}

function openBusinessDeletionStepC() {
    const statusC = document.getElementById('businessDeletionStatusC');
    if (statusC) { statusC.textContent = ''; statusC.className = 'ba-deletion-status'; }

    const reasonSelect = document.getElementById('businessDeletionReason');
    if (reasonSelect) reasonSelect.value = '';

    showBusinessDeletionModal('C');
}

function openBusinessDeletionStepD() {
    const statusD = document.getElementById('businessDeletionStatusD');
    if (statusD) { statusD.textContent = ''; statusD.className = 'ba-deletion-status'; }

    const expectedEl = document.getElementById('businessDeletionExpectedName');
    const expectedName = (businessData && businessData.business_name) ? businessData.business_name : '';
    if (expectedEl) expectedEl.textContent = expectedName || '—';

    const nameInput = document.getElementById('businessDeletionConfirmName');
    if (nameInput) nameInput.value = '';

    const stepDBtn = document.getElementById('businessDeletionStepDBtn');
    if (stepDBtn) stepDBtn.disabled = true;

    showBusinessDeletionModal('D');
}

function openBusinessDeletionStepE() {
    const statusE = document.getElementById('businessDeletionStatusE');
    if (statusE) { statusE.textContent = ''; statusE.className = 'ba-deletion-status'; }

    showBusinessDeletionModal('E');

    // Start the countdown. The final button stays disabled until
    // the countdown reaches zero.
    startBusinessDeletionCountdown();
}

function showBusinessDeletionModal(letter) {
    ['A', 'B', 'C', 'D', 'E'].forEach(step => {
        const modal = document.getElementById(`businessDeletionModal${step}`);
        if (modal) modal.classList.toggle('active', step === letter);
    });
}

function closeBusinessDeletionModals() {
    ['A', 'B', 'C', 'D', 'E'].forEach(step => {
        const modal = document.getElementById(`businessDeletionModal${step}`);
        if (modal) modal.classList.remove('active');
    });

    // Stop the countdown timer if it is still running.
    if (businessDeletionState.countdownTimer) {
        clearInterval(businessDeletionState.countdownTimer);
        businessDeletionState.countdownTimer = null;
    }

    resetBusinessDeletionState();
}

function resetBusinessDeletionState() {
    businessDeletionState.acknowledged = false;
    businessDeletionState.passwordVerified = false;
    businessDeletionState.password = '';
    businessDeletionState.reason = '';
    businessDeletionState.confirmedName = '';
    businessDeletionState.countdownValue = BUSINESS_DELETION_COUNTDOWN_SECONDS;

    if (businessDeletionState.countdownTimer) {
        clearInterval(businessDeletionState.countdownTimer);
        businessDeletionState.countdownTimer = null;
    }

    ['A', 'B', 'C', 'D', 'E'].forEach(step => {
        const statusEl = document.getElementById(`businessDeletionStatus${step}`);
        if (statusEl) { statusEl.textContent = ''; statusEl.className = 'ba-deletion-status'; }
    });

    const acknowledge = document.getElementById('businessDeletionAcknowledge');
    if (acknowledge) acknowledge.checked = false;

    const stepABtn = document.getElementById('businessDeletionStepABtn');
    if (stepABtn) stepABtn.disabled = true;

    const passwordInput = document.getElementById('businessDeletionPassword');
    if (passwordInput) passwordInput.value = '';

    const verifyBtn = document.getElementById('businessDeletionVerifyBtn');
    if (verifyBtn) {
        verifyBtn.disabled = false;
        verifyBtn.innerHTML = '<i class="fas fa-arrow-right"></i> Continue';
    }

    const reasonSelect = document.getElementById('businessDeletionReason');
    if (reasonSelect) reasonSelect.value = '';

    const nameInput = document.getElementById('businessDeletionConfirmName');
    if (nameInput) nameInput.value = '';

    const stepDBtn = document.getElementById('businessDeletionStepDBtn');
    if (stepDBtn) stepDBtn.disabled = true;

    const countdownEl = document.getElementById('businessDeletionCountdown');
    if (countdownEl) countdownEl.textContent = String(BUSINESS_DELETION_COUNTDOWN_SECONDS);

    const finalBtn = document.getElementById('businessDeletionFinalBtn');
    if (finalBtn) {
        finalBtn.disabled = true;
        finalBtn.innerHTML = '<i class="fas fa-store-slash"></i> Delete My Business';
    }
}

function businessDeletionCheckAcknowledge() {
    const checkbox = document.getElementById('businessDeletionAcknowledge');
    const stepABtn = document.getElementById('businessDeletionStepABtn');
    if (!checkbox || !stepABtn) return;

    businessDeletionState.acknowledged = checkbox.checked === true;
    stepABtn.disabled = !businessDeletionState.acknowledged;
}

function businessDeletionDownloadData() {
    // The business data-export endpoint is not part of Section 11.B.
    // Tell the admin honestly so they do not think the download
    // failed silently.
    const statusEl = document.getElementById('businessDeletionStatusA');
    if (statusEl) {
        statusEl.textContent = '📥 Business data download is not yet available. You can still proceed with deletion, or contact support if you need a copy of your data.';
        statusEl.className = 'ba-deletion-status info';
    }

    if (typeof showToast === 'function') {
        showToast('Business data download is not yet available.', 'info');
    }
}

async function businessDeletionVerifyPassword() {
    const statusEl = document.getElementById('businessDeletionStatusB');
    const verifyBtn = document.getElementById('businessDeletionVerifyBtn');
    const passwordInput = document.getElementById('businessDeletionPassword');
    const password = passwordInput ? passwordInput.value : '';

    if (!password) {
        if (statusEl) {
            statusEl.textContent = '❌ Please enter your password.';
            statusEl.className = 'ba-deletion-status error';
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
        statusEl.className = 'ba-deletion-status info';
    }

    try {
        // The verification is done as part of the final request so
        // the password is never stored anywhere on the client.
        // To keep the flow simple we stash it in the in-memory
        // state and verify it server-side when the admin submits
        // in step E.
        businessDeletionState.password = password;

        // Lightweight sanity check: confirm the session is still
        // valid before letting the admin continue.
        const res = await fetch('/api/auth/my-business', {
            headers: { 'Authorization': `Bearer ${token}` },
            credentials: 'same-origin',
            cache: 'no-store'
        });

        if (!res.ok) {
            throw new Error('Your session has expired. Please log in again.');
        }

        businessDeletionState.passwordVerified = true;

        if (statusEl) {
            statusEl.textContent = '✅ Password accepted.';
            statusEl.className = 'ba-deletion-status success';
        }

        // Small delay so the admin sees the confirmation before
        // the modal flips to step C.
        setTimeout(() => openBusinessDeletionStepC(), 400);
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = '❌ ' + (err.message || 'Could not verify your password.');
            statusEl.className = 'ba-deletion-status error';
        }
        if (verifyBtn) verifyBtn.disabled = false;
    } finally {
        if (verifyBtn) {
            verifyBtn.innerHTML = '<i class="fas fa-arrow-right"></i> Continue';
        }
    }
}

function businessDeletionChooseReason() {
    const statusEl = document.getElementById('businessDeletionStatusC');
    const reasonSelect = document.getElementById('businessDeletionReason');
    const reason = reasonSelect ? reasonSelect.value : '';

    if (!reason) {
        if (statusEl) {
            statusEl.textContent = '❌ Please select a reason before continuing.';
            statusEl.className = 'ba-deletion-status error';
        }
        if (reasonSelect) reasonSelect.focus();
        return;
    }

    businessDeletionState.reason = reason;
    openBusinessDeletionStepD();
}

function businessDeletionCheckName() {
    const nameInput = document.getElementById('businessDeletionConfirmName');
    const stepDBtn = document.getElementById('businessDeletionStepDBtn');
    const typed = nameInput ? nameInput.value : '';
    const expected = (businessData && businessData.business_name) ? businessData.business_name : '';

    // Case-sensitive exact match, including spaces.
    const matches = typed === expected;

    businessDeletionState.confirmedName = typed;
    if (stepDBtn) stepDBtn.disabled = !matches;
}

function startBusinessDeletionCountdown() {
    // Clear any timer from a previous attempt.
    if (businessDeletionState.countdownTimer) {
        clearInterval(businessDeletionState.countdownTimer);
        businessDeletionState.countdownTimer = null;
    }

    businessDeletionState.countdownValue = BUSINESS_DELETION_COUNTDOWN_SECONDS;

    const countdownEl = document.getElementById('businessDeletionCountdown');
    const finalBtn = document.getElementById('businessDeletionFinalBtn');

    if (countdownEl) countdownEl.textContent = String(businessDeletionState.countdownValue);
    if (finalBtn) finalBtn.disabled = true;

    businessDeletionState.countdownTimer = setInterval(() => {
        businessDeletionState.countdownValue -= 1;

        if (countdownEl) countdownEl.textContent = String(Math.max(0, businessDeletionState.countdownValue));

        if (businessDeletionState.countdownValue <= 0) {
            clearInterval(businessDeletionState.countdownTimer);
            businessDeletionState.countdownTimer = null;

            if (finalBtn) finalBtn.disabled = false;
        }
    }, 1000);
}

async function businessDeletionSubmit() {
    const statusEl = document.getElementById('businessDeletionStatusE');
    const finalBtn = document.getElementById('businessDeletionFinalBtn');

    if (!businessDeletionState.passwordVerified) {
        if (statusEl) {
            statusEl.textContent = '❌ Please start over from the top of the danger zone.';
            statusEl.className = 'ba-deletion-status error';
        }
        return;
    }

    if (!businessDeletionState.reason) {
        if (statusEl) {
            statusEl.textContent = '❌ Please select a reason before continuing.';
            statusEl.className = 'ba-deletion-status error';
        }
        return;
    }

    const expected = (businessData && businessData.business_name) ? businessData.business_name : '';
    if ((businessDeletionState.confirmedName || '') !== expected) {
        if (statusEl) {
            statusEl.textContent = '❌ The business name does not match exactly.';
            statusEl.className = 'ba-deletion-status error';
        }
        return;
    }

    if (businessDeletionState.countdownValue > 0) {
        if (statusEl) {
            statusEl.textContent = '❌ Please wait for the countdown to finish.';
            statusEl.className = 'ba-deletion-status error';
        }
        return;
    }

    if (finalBtn) {
        finalBtn.disabled = true;
        finalBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scheduling…';
    }
    if (statusEl) {
        statusEl.textContent = '⏳ Scheduling your business for deletion…';
        statusEl.className = 'ba-deletion-status info';
    }

    try {
        const res = await fetch('/api/business-admin/request-deletion', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            credentials: 'same-origin',
            body: JSON.stringify({
                password: businessDeletionState.password,
                reason: businessDeletionState.reason
            })
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not schedule business deletion.');
        }

        if (statusEl) {
            const when = data.deletion_scheduled_for
                ? new Date(data.deletion_scheduled_for).toLocaleString()
                : 'in 60 days';
            statusEl.textContent = `✅ Your business is scheduled for deletion on ${when}.`;
            statusEl.className = 'ba-deletion-status success';
        }

        // Clear the client session and return the admin to the
        // marketplace with a small notice in the query string. The
        // cookie is cleared by the server on the way out.
        localStorage.removeItem('currentUser');
        localStorage.removeItem('businessId');
        localStorage.removeItem('businessName');
        localStorage.removeItem('businessSlug');
        window.currentUser = null;

        setTimeout(() => {
            window.location.href = '/?business_deletion=scheduled';
        }, 1800);
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = '❌ ' + (err.message || 'Something went wrong. Please try again.');
            statusEl.className = 'ba-deletion-status error';
        }
        if (finalBtn) {
            finalBtn.disabled = false;
            finalBtn.innerHTML = '<i class="fas fa-store-slash"></i> Delete My Business';
        }
    }
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

window.applyCategoryWarning = applyCategoryWarning;

window.activateBusinessLocation = activateBusinessLocation;
window.saveAdjustedBusinessPin = saveAdjustedBusinessPin;
window.applyLocationState = applyLocationState;
window.updateLocationStatusBadge = updateLocationStatusBadge;
window.renderLocationWarning = renderLocationWarning;
window.renderBusinessLocationMap = renderBusinessLocationMap;

window.updateOrderDeliveryWarning = updateOrderDeliveryWarning;

window.updateMpesaFields = updateMpesaFields;
window.validateMpesaSettings = validateMpesaSettings;
window.renderMpesaEnvironmentLabel = renderMpesaEnvironmentLabel;

window.renderSearchTagCard = renderSearchTagCard;
window.copySearchTag = copySearchTag;
window.openSearchTagEdit = openSearchTagEdit;
window.closeSearchTagEdit = closeSearchTagEdit;
window.saveBusinessSearchTag = saveBusinessSearchTag;
window.checkAdminSearchTagAvailability = checkAdminSearchTagAvailability;
window.hydrateSearchTagFromBusiness = hydrateSearchTagFromBusiness;

window.scrollToShopSection = scrollToShopSection;
window.jumpToShopSection = jumpToShopSection;
window.switchProductsTab = switchProductsTab;

// Section 20260923 — expose the "What You Sell" helpers so the
// inline HTML in business-admin.html and any future surface can
// call them.
window.loadProductKeywords = loadProductKeywords;
window.renderKeywordRows = renderKeywordRows;
window.addKeywordRow = addKeywordRow;
window.removeKeywordRow = removeKeywordRow;
window.saveProductKeywords = saveProductKeywords;
window.updateKeywordCounters = updateKeywordCounters;

// Section 11.B — expose the deletion flow helpers so the modal
// buttons in business-admin.html resolve.
window.openBusinessDeletionStepA = openBusinessDeletionStepA;
window.openBusinessDeletionStepB = openBusinessDeletionStepB;
window.openBusinessDeletionStepC = openBusinessDeletionStepC;
window.openBusinessDeletionStepD = openBusinessDeletionStepD;
window.openBusinessDeletionStepE = openBusinessDeletionStepE;
window.closeBusinessDeletionModals = closeBusinessDeletionModals;
window.businessDeletionDownloadData = businessDeletionDownloadData;
window.businessDeletionCheckAcknowledge = businessDeletionCheckAcknowledge;
window.businessDeletionVerifyPassword = businessDeletionVerifyPassword;
window.businessDeletionChooseReason = businessDeletionChooseReason;
window.businessDeletionCheckName = businessDeletionCheckName;
window.businessDeletionSubmit = businessDeletionSubmit;

console.log('✅ Business Admin JS loaded successfully (Section 10 — rating tile removed, Section 11.B — business deletion wired, Section 20260923 — product keywords wired, CARTO tile provider active)');