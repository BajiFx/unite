// ============================================================
//  BUSINESS PROFILE JAVASCRIPT - COMPLETE VERSION (FIXED)
//  Location: public/js/business-profile.js
//
//  Section 10 — Removed the last remaining business rating
//  reference:
//   - renderBusinessProfile() no longer writes to #avgRating.
//   - The avgRating local was dropped because nothing else used
//     it. Product count and follower count remain.
//   - The reviews list, the write-a-review form, and the review
//     counters on cards were already removed in earlier rounds.
//   - Backend review routes and the aggregate rating on the
//     product detail page are left in place, as Section 10
//     requires.
//
//  Dead-code cleanup (this revision):
//   - loadBusinessReviews() removed. It fetched
//     /api/businesses/:slug/reviews and wrote to a non-existent
//     #reviewsList. The call site inside loadBusinessProfile()
//     was the source of a wasted network round-trip on every
//     profile load.
//   - setRating() removed. Wrote to #reviewStars, which no
//     longer exists.
//   - submitBusinessReview() removed. Wrote to #reviewText and
//     #reviewsList, neither of which exists.
//   - The reviewRating global was dropped; only those two
//     functions used it.
//   - The exported globals for those three functions were
//     dropped from the bottom of the file.
//   The backend review endpoints are untouched — the frontend
//   simply no longer calls them.
//
//  Section B (Product Categories) additions:
//   - Defined product-category filter (B.7) alongside the legacy one.
//   - Single render path for product cards (B.8, no drift).
//   - Category chip on each product card (B.7).
//   - Deterministic SVG fallback image, matching product-detail.js.
//
//  Section H (Cart and order visibility) additions:
//   H.4 — renderOrdersPausedBanner() shows a clear banner on the
//         business profile when the business is not accepting
//         online orders, using the business's own
//         order_disabled_message (fallback to a safe default).
//   H.5 — renderOrdersPausedContactBlock() shows a contact-only
//         block in place of the cart flow, reusing the same
//         social links the page already renders.
//   The single entry point is applyOrderVisibilityState(), which
//   is called from renderBusinessProfile() so both blocks are in
//   the correct state as soon as the business data is available.
//
//  Hero redesign:
//   The hero is a three-column band on desktop:
//     LEFT   — small column, logo only, plain background.
//     MIDDLE — info panel: name, location, address, stats,
//              Shop Now, Follow, Verified badge.
//     RIGHT  — media panel: one image OR one video.
//              The description block now sits ON TOP of the
//              media and scrolls slowly upward when the text
//              is longer than the frame.
//   On phones the CSS reorders the three columns to
//     logo → media → info.
//
//  About card:
//   The About card is now a full-width Mission + Vision band.
//   The description block that used to live beside it has been
//   removed from the About card and moved into the hero media
//   overlay.
//
//  Reviews removal:
//   The reviews section and its write-a-review block have been
//   removed from the customer-facing page. A warm thank-you band
//   takes their place. The band's business name is injected here
//   by renderThankYouBand() so it feels personal. The review
//   tables and routes remain in the backend, untouched; only the
//   customer-facing surface is gone.
//
//  Search tag chip:
//   A small click-to-copy chip is rendered in the hero info
//   panel so a customer who lands on a shop can copy its search
//   tag and paste it back into the marketplace search bar
//   later. The chip is hidden when the business has no
//   confirmed tag.
//
//  Hardening:
//   - businessFallbackImage() strips unpaired surrogates and control
//     characters before encodeURIComponent, so a corrupted product
//     name can no longer throw "URIError: URI malformed".
//
//  Role-scoping fixes:
//   - The header of business-profile.html calls logout() inline.
//     This file now defines and exposes it, so the header no longer
//     throws "logout is not defined" on a business-admin session.
//   - checkFollowStatus() and checkLocationStatus() call endpoints
//     that are customer-only. When the viewer is a business admin
//     (own business or another business's profile), those calls are
//     skipped and the Follow button is hidden, so the page no longer
//     receives 403 responses in the console.
//   - getViewerRole() is the single source of truth for "who is
//     looking at this page". Every role-scoped behaviour reads it.
// ============================================================

// ============================================================
//  GLOBALS - Make sure no duplicate declarations with app.js
// ============================================================

if (typeof window.businessSlug === 'undefined') {
    window.businessSlug = null;
}
if (typeof window.businessData === 'undefined') {
    window.businessData = null;
}
if (typeof window.businessProductList === 'undefined') {
    window.businessProductList = [];
}
if (typeof window.businessSlideIndex === 'undefined') {
    window.businessSlideIndex = 0;
}
if (typeof window.businessSlideTimer === 'undefined') {
    window.businessSlideTimer = null;
}
if (typeof window.businessMap === 'undefined') {
    window.businessMap = null;
}
if (typeof window.businessLiveMap === 'undefined') {
    window.businessLiveMap = null;
}
if (typeof window.businessLiveMarker === 'undefined') {
    window.businessLiveMarker = null;
}
if (typeof window.businessLiveRoute === 'undefined') {
    window.businessLiveRoute = null;
}
if (typeof window.businessProfileLoaded === 'undefined') {
    window.businessProfileLoaded = false;
}
if (typeof window.isFollowing === 'undefined') {
    window.isFollowing = false;
}
if (typeof window.customerLocation === 'undefined') {
    window.customerLocation = null;
}
if (typeof window.isOwnBusiness === 'undefined') {
    window.isOwnBusiness = false;
}

// Product loading pagination state (reserved for a future Load-More button).
if (typeof window.nextProductPage === 'undefined') {
    window.nextProductPage = 1;
}
if (typeof window.hasMoreProducts === 'undefined') {
    window.hasMoreProducts = true;
}

// Section H — safe default when the business has not customised
// the orders-paused message yet.
const DEFAULT_ORDERS_PAUSED_MESSAGE = 'This business is not currently accepting online orders. Please contact them directly.';

// Use window-scoped variables to avoid conflicts
let businessSlug = window.businessSlug;
let businessData = window.businessData;
let businessProductList = window.businessProductList;
let businessSlideIndex = window.businessSlideIndex;
let businessSlideTimer = window.businessSlideTimer;
let businessMap = window.businessMap;
let businessLiveMap = window.businessLiveMap;
let businessLiveMarker = window.businessLiveMarker;
let businessLiveRoute = window.businessLiveRoute;
let businessProfileLoaded = window.businessProfileLoaded;
let isFollowing = window.isFollowing;
let customerLocation = window.customerLocation;
let isOwnBusiness = window.isOwnBusiness;

// ============================================================
//  VIEWER ROLE HELPERS
// ============================================================

function getViewerRole() {
    try {
        const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
        if (!user || !user.email) return 'guest';

        const role = user.role || 'customer';
        if (role === 'business_admin') return 'business_admin';
        if (role === 'super_admin' || role === 'admin') return 'super_admin';
        return 'customer';
    } catch (err) {
        return 'guest';
    }
}

function isCustomerViewer() {
    return getViewerRole() === 'customer';
}

function isBusinessAdminViewer() {
    const role = getViewerRole();
    return role === 'business_admin' || role === 'super_admin';
}

// ============================================================
//  LOGOUT
// ============================================================

async function logout() {
    try {
        if (typeof window.fetch === 'function') {
            await window.fetch('/api/auth/logout', { method: 'POST' });
        }
    } catch (err) {
        console.warn('Logout request failed:', err);
    } finally {
        localStorage.removeItem('token');
        localStorage.removeItem('customerToken');
        localStorage.removeItem('businessId');
        localStorage.removeItem('businessName');
        localStorage.removeItem('businessSlug');
        localStorage.removeItem('currentUser');
        window.currentUser = null;
        window.customerToken = null;
        window.location.href = '/';
    }
}

function openGuestCartPrompt() {
    const modal = document.getElementById('authModal');
    const login = document.getElementById('authLoginContainer');
    const register = document.getElementById('authRegisterContainer');
    if (!modal || !login || !register) return;

    sessionStorage.setItem('authReturnPath', window.location.pathname + window.location.search);
    modal.classList.add('active');
    login.style.display = 'block';
    register.style.display = 'none';
    const title = document.getElementById('authLoginTitle');
    if (title) title.textContent = 'Please login or register to use your cart';
    const loginBusiness = document.getElementById('loginTypeBusiness');
    const registerBusiness = document.getElementById('registerTypeBusiness');
    if (loginBusiness) loginBusiness.style.display = 'none';
    if (registerBusiness) registerBusiness.style.display = 'none';
    if (typeof selectLoginType === 'function') selectLoginType('customer');

    let actions = document.getElementById('guestCartActions');
    if (!actions) {
        actions = document.createElement('div');
        actions.id = 'guestCartActions';
        actions.style.cssText = 'display:flex;gap:8px;margin:0 0 14px;';
        login.insertBefore(actions, login.querySelector('#loginForm'));
    }
    actions.innerHTML = `
        <button type="button" class="btn btn-primary" style="flex:1" onclick="selectLoginType('customer')">Login as Customer</button>
        <button type="button" class="btn btn-success" style="flex:1" onclick="switchAuthTab('register'); selectRegisterType('customer')">Register as Customer</button>`;
}

function openChatTab() {
    window.location.assign('/?workspace=messages');
}

function goToMarketplaceCart() {
    if (window.parent !== window) {
        window.parent.postMessage({ type: 'shop-kenya-open-workspace', section: 'cart' }, window.location.origin);
        return;
    }
    window.location.assign('/?workspace=cart');
}

// ============================================================
//  INIT - GET SLUG FROM URL
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('📄 Business profile page loaded');

    const path = window.location.pathname;
    const parts = path.replace(/^\//, '').split('/');

    if (parts.length >= 2 && parts[0] === 'business') {
        window.businessSlug = parts[1];
        businessSlug = window.businessSlug;
    } else {
        const params = new URLSearchParams(window.location.search);
        window.businessSlug = params.get('slug');
        businessSlug = window.businessSlug;
    }

    console.log('📍 Business slug:', businessSlug);

    if (!businessSlug) {
        showError('No business specified', 'Please go back to the marketplace and pick a business.');
        return;
    }

    if (typeof updateNavigation === 'function') {
        updateNavigation();
    }

    loadBusinessProfile();
    updateCartBadge();
    updateNavCartBadge();
});

// ============================================================
//  CHECK IF VIEWING OWN BUSINESS
// ============================================================

function checkIfOwnBusiness() {
    const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
    const userBusinessId = user.business_id || localStorage.getItem('businessId');
    const userBusinessSlug = localStorage.getItem('businessSlug');

    if (user.role === 'business_admin' && userBusinessSlug) {
        window.isOwnBusiness = businessSlug === userBusinessSlug;
        isOwnBusiness = window.isOwnBusiness;
        console.log('🔍 Is own business?', isOwnBusiness);
    }

    if (businessData && userBusinessId) {
        window.isOwnBusiness = businessData.id === parseInt(userBusinessId);
        isOwnBusiness = window.isOwnBusiness;
    }
}

// ============================================================
//  SHOW ERROR
// ============================================================

function showError(title, message) {
    const loadingEl = document.getElementById('loadingState');
    if (loadingEl) {
        loadingEl.innerHTML = `
            <div style="color:#ef4444; text-align:center; padding:40px;">
                <i class="fas fa-exclamation-circle fa-3x"></i>
                <h3 style="margin-top:12px;">${title}</h3>
                <p style="margin-top:8px; color:#64748b;">${message}</p>
                <a href="/" class="btn btn-primary" style="margin-top:16px; display:inline-block;">
                    <i class="fas fa-arrow-left"></i> Return to Marketplace
                </a>
            </div>
        `;
    }
}

// ============================================================
//  LOAD BUSINESS PROFILE
// ============================================================

async function loadBusinessProfile() {
    if (businessProfileLoaded) {
        console.log('⚠️ Profile already loaded');
        return;
    }

    try {
        console.log('📦 Loading business profile for slug:', businessSlug);

        const loadingEl = document.getElementById('loadingState');
        const contentEl = document.getElementById('businessContent');

        if (loadingEl) loadingEl.style.display = 'block';
        if (contentEl) contentEl.style.display = 'none';

        const apiUrl = `/api/businesses/${businessSlug}`;
        console.log('📡 Fetching from:', apiUrl);

        const res = await fetch(apiUrl);

        if (!res.ok) {
            if (res.status === 404) {
                showError('Business not found', 'We could not find that business.');
                return;
            }
            throw new Error(`Failed to load business: ${res.status}`);
        }

        const data = await res.json();
        console.log('📦 Business data received:', data);

        window.businessData = data.business;
        businessData = window.businessData;

        if (!businessData) {
            showError('Business not found', 'We could not find that business.');
            return;
        }

        console.log('✅ Business loaded:', businessData.business_name);

        checkIfOwnBusiness();

        if (typeof updateNavigation === 'function') {
            updateNavigation();
        }

        if (loadingEl) loadingEl.style.display = 'none';
        if (contentEl) contentEl.style.display = 'block';

        renderBusinessProfile();
        await loadBusinessProducts();
        buildBusinessSlider();

        if (isCustomerViewer()) {
            checkFollowStatus();
            checkLocationStatus();
        } else {
            hideFollowButtonForNonCustomer();
        }

        document.title = `${businessData.business_name} - Shop Kenya`;
        window.businessProfileLoaded = true;
        businessProfileLoaded = window.businessProfileLoaded;

        console.log('✅ Business profile loaded successfully for:', businessData.business_name);

    } catch (err) {
        console.error('❌ Business profile error:', err);
        showError('Error loading business', err.message);
    }
}

/**
 * Hide the Follow button when the viewer is not a customer. The
 * button itself is rendered in the hero actions of the page; we
 * simply set it to display:none. This is idempotent.
 */
function hideFollowButtonForNonCustomer() {
    const followBtn = document.getElementById('followBtn');
    if (followBtn) followBtn.style.display = 'none';
}

// ============================================================
//  RENDER BUSINESS PROFILE
// ============================================================

function renderBusinessProfile() {
    const business = businessData;
    if (!business) {
        console.error('❌ No business data to render');
        return;
    }

    console.log('🎨 Rendering business profile for:', business.business_name);

    const heroTitle = document.getElementById('heroTitle');
    const heroLocation = document.getElementById('heroLocation');
    const heroAddress = document.getElementById('heroAddress');
    const heroLogo = document.getElementById('heroLogo');

    if (heroTitle) heroTitle.textContent = business.business_name || 'Welcome';
    if (heroLocation) heroLocation.textContent = business.location ? `📍 ${business.location}` : '';
    if (heroAddress) heroAddress.textContent = business.address ? `🏠 ${business.address}` : '';

    // Section 10 — the average rating line has been removed from
    // the hero. We only render the counts that still exist.
    const productCount = business.product_count || 0;
    const followerCount = business.follower_count || 0;

    const productCountEl = document.getElementById('productCount');
    const followerCountEl = document.getElementById('followerCount');
    if (productCountEl) productCountEl.textContent = productCount;
    if (followerCountEl) followerCountEl.textContent = followerCount;

    if (heroLogo) {
        if (business.logo && business.logo !== '') {
            heroLogo.src = business.logo;
            heroLogo.style.display = 'block';
        } else {
            heroLogo.style.display = 'none';
        }
    }

    // Fill the media column with a single image or a single video,
    // then overlay the description block on top of it.
    renderHeroMedia(business);
    renderHeroDescriptionOverlay(business);

    // Search tag chip — click to copy. Hidden when the business has
    // no confirmed tag.
    renderHeroSearchTagChip(business);

    const verifiedBadge = document.getElementById('verifiedBadge');
    if (verifiedBadge) {
        verifiedBadge.style.display = business.is_verified ? 'block' : 'none';
    }

    const missionEl = document.getElementById('businessMission');
    const visionEl = document.getElementById('businessVision');
    const descEl = document.getElementById('businessDescription');

    if (missionEl) missionEl.textContent = business.mission || 'To provide quality products with care.';
    if (visionEl) visionEl.textContent = business.vision || 'To be the most trusted shop in the community.';
    if (descEl) descEl.textContent = business.description || 'No description provided.';

    renderSocialLinks(business);
    renderMap(business);

    if (!isCustomerViewer()) {
        hideFollowButtonForNonCustomer();
    }

    applyOrderVisibilityState();

    renderThankYouBand(business);
}

// ============================================================
//  HERO SEARCH TAG CHIP
// ============================================================

function renderHeroSearchTagChip(business) {
    const chip = document.getElementById('heroSearchTagChip');
    const valueEl = document.getElementById('heroSearchTagValue');
    const btn = document.getElementById('heroSearchTagBtn');
    if (!chip || !valueEl) return;

    const display = business && business.search_display ? String(business.search_display).trim() : '';
    const confirmed = business && business.search_tag_confirmed === true;

    if (!display || !confirmed) {
        chip.style.display = 'none';
        valueEl.textContent = '';
        return;
    }

    chip.style.display = 'block';
    valueEl.textContent = display;

    if (btn && !btn.dataset.wired) {
        btn.dataset.wired = 'true';
        btn.addEventListener('click', () => {
            const tag = valueEl.textContent || '';
            if (!tag) return;

            const fallback = () => {
                try {
                    const ta = document.createElement('textarea');
                    ta.value = tag;
                    ta.setAttribute('readonly', '');
                    ta.style.position = 'absolute';
                    ta.style.left = '-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    if (typeof showToast === 'function') showToast(`Copied: ${tag}`, 'success');
                } catch (err) {
                    if (typeof showToast === 'function') showToast('Could not copy. Please copy it manually.', 'warning');
                }
            };

            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(tag)
                    .then(() => { if (typeof showToast === 'function') showToast(`Copied: ${tag}`, 'success'); })
                    .catch(fallback);
            } else {
                fallback();
            }
        });
    }
}

// ============================================================
//  THANK-YOU BAND
// ============================================================

function renderThankYouBand(business) {
    const band = document.getElementById('thankYouBand');
    const nameEl = document.getElementById('thankYouBusinessName');
    if (!band) return;

    const name = business && business.business_name ? String(business.business_name).trim() : 'our business';
    if (nameEl) nameEl.textContent = name;

    band.style.display = '';
}

// ============================================================
//  HERO MEDIA — single image OR single video, no text on top
// ============================================================

function isVideoUrl(url) {
    if (!url) return false;
    return /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(String(url));
}

function renderHeroMedia(business) {
    const slot = document.getElementById('heroMediaSlot');
    if (!slot) return;

    slot.innerHTML = '';

    const coverUrl = business && (business.heroImage || business.heroimage);
    if (!coverUrl) return;

    if (isVideoUrl(coverUrl)) {
        const video = document.createElement('video');
        video.className = 'hero-media-video';
        video.src = coverUrl;
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('muted', '');
        video.preload = 'metadata';
        slot.appendChild(video);
        return;
    }

    const img = document.createElement('img');
    img.className = 'hero-media-image';
    img.src = coverUrl;
    img.alt = (business.business_name || 'Business') + ' cover';
    img.loading = 'lazy';
    img.onerror = function () {
        this.remove();
    };
    slot.appendChild(img);
}

// ============================================================
//  HERO DESCRIPTION OVERLAY
// ============================================================

function renderHeroDescriptionOverlay(business) {
    const overlay = document.getElementById('heroDescriptionOverlay');
    const track = document.getElementById('heroDescriptionTrack');
    if (!overlay || !track) return;

    overlay.classList.remove('is-scrolling');
    track.style.animationDuration = '';
    track.style.removeProperty('--hero-desc-scroll');
    track.innerHTML = '';

    if (!business) {
        overlay.style.display = 'none';
        return;
    }

    const name = String(business.business_name || 'Business');
    const tagline = business.description ? String(business.description).trim() : '';

    const locationParts = [];
    if (business.town) locationParts.push(business.town);
    if (business.county) locationParts.push(business.county);
    if (locationParts.length === 0 && business.location) locationParts.push(business.location);
    const locationText = locationParts.length > 0 ? locationParts.join(', ') : 'Kenya';

    const safe = (value) => {
        const div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    };

    const titleHtml = `<span class="hero-desc-title">🏡✨ ${safe(name)} – Quality for Every Home</span>`;
    const taglineHtml = tagline
        ? `<span class="hero-desc-tagline">${safe(tagline)}</span>`
        : '';
    const bulletsHtml = `
        <ul class="hero-desc-bullets">
            <li>✅ Quality &amp; Affordable</li>
            <li>🌈 Wide Variety</li>
            <li>📦 Retail &amp; Wholesale</li>
            <li>🚚 Delivery Across Kenya</li>
        </ul>
    `;
    const metaHtml = `
        <span class="hero-desc-meta">📍 ${safe(locationText)}</span>
        <span class="hero-desc-meta">📞 Contact us today!</span>
    `;

    track.innerHTML = titleHtml + taglineHtml + bulletsHtml + metaHtml;

    overlay.style.display = '';

    requestAnimationFrame(() => {
        const overlayHeight = overlay.clientHeight;
        const trackHeight = track.scrollHeight;

        if (trackHeight <= overlayHeight - 4) {
            return;
        }

        const overflow = trackHeight - overlayHeight;

        track.style.setProperty('--hero-desc-scroll', `-${overflow}px`);

        const durationSeconds = Math.min(90, Math.max(20, overflow / 40));
        track.style.animationDuration = `${durationSeconds}s`;

        overlay.classList.add('is-scrolling');
    });
}

// ============================================================
//  Section H — ORDER VISIBILITY (H.4 banner + H.5 contact-only)
// ============================================================

function applyOrderVisibilityState() {
    if (!businessData) return;

    const ordersEnabled = businessData.online_orders_enabled !== false;

    const banner = document.getElementById('ordersPausedBanner');
    const contactBlock = document.getElementById('ordersPausedContactBlock');

    if (ordersEnabled) {
        if (banner) banner.style.display = 'none';
        if (contactBlock) contactBlock.style.display = 'none';
        return;
    }

    renderOrdersPausedBanner();
    renderOrdersPausedContactBlock();
}

function renderOrdersPausedBanner() {
    const banner = document.getElementById('ordersPausedBanner');
    const messageEl = document.getElementById('ordersPausedMessage');
    if (!banner || !messageEl) return;

    const custom = (businessData && businessData.order_disabled_message) ? String(businessData.order_disabled_message).trim() : '';
    messageEl.textContent = custom || DEFAULT_ORDERS_PAUSED_MESSAGE;

    banner.style.display = 'block';
}

function renderOrdersPausedContactBlock() {
    const block = document.getElementById('ordersPausedContactBlock');
    const iconsContainer = document.getElementById('ordersPausedContactIcons');
    const emptyHint = document.getElementById('ordersPausedContactEmpty');
    if (!block || !iconsContainer) return;

    const iconDefs = [];

    if (businessData && businessData.whatsapp) {
        const cleaned = String(businessData.whatsapp).replace(/[^0-9]/g, '');
        iconDefs.push({
            href: `https://wa.me/${cleaned}`,
            className: 'whatsapp',
            label: 'WhatsApp',
            iconClass: 'fab fa-whatsapp',
            color: '#25D366'
        });
    }

    if (businessData && businessData.tiktok) {
        const handle = String(businessData.tiktok).replace('@', '').trim();
        iconDefs.push({
            href: `https://tiktok.com/@${handle}`,
            className: 'tiktok',
            label: 'TikTok',
            iconClass: 'fab fa-tiktok',
            color: '#000000'
        });
    }

    if (businessData && businessData.instagram) {
        const handle = String(businessData.instagram).replace('@', '').trim();
        iconDefs.push({
            href: `https://instagram.com/${handle}`,
            className: 'instagram',
            label: 'Instagram',
            iconClass: 'fab fa-instagram',
            color: '#E4405F'
        });
    }

    if (businessData && businessData.facebook) {
        const handle = String(businessData.facebook).replace('@', '').trim();
        iconDefs.push({
            href: `https://facebook.com/messages/t/${handle}`,
            className: 'messenger',
            label: 'Messenger',
            iconClass: 'fab fa-facebook-messenger',
            color: '#1877F2'
        });
    }

    if (businessData && businessData.phone) {
        iconDefs.push({
            href: `tel:${businessData.phone}`,
            className: 'phone',
            label: 'Call',
            iconClass: 'fas fa-phone',
            color: '#2563eb'
        });
    }

    if (iconDefs.length === 0) {
        iconsContainer.innerHTML = '';
        if (emptyHint) emptyHint.style.display = 'block';
    } else {
        iconsContainer.innerHTML = iconDefs.map(icon => `
            <a href="${icon.href}"
               target="_blank"
               rel="noopener"
               class="${icon.className}"
               style="display:inline-flex; align-items:center; gap:6px; padding:8px 16px; border-radius:30px; background:${icon.color}; color:white; font-size:0.8rem; font-weight:600; text-decoration:none;">
                <i class="${icon.iconClass}"></i> ${icon.label}
            </a>
        `).join('');
        if (emptyHint) emptyHint.style.display = 'none';
    }

    block.style.display = 'block';
}

// ============================================================
//  RENDER SOCIAL LINKS
// ============================================================

function renderSocialLinks(business) {
    const iconWhatsapp = document.getElementById('iconWhatsapp');
    const iconTiktok = document.getElementById('iconTiktok');
    const iconInstagram = document.getElementById('iconInstagram');
    const iconFacebook = document.getElementById('iconFacebook');
    const iconPhone = document.getElementById('iconPhone');

    if (iconWhatsapp) {
        if (business.whatsapp) {
            const cleaned = business.whatsapp.replace(/[^0-9]/g, '');
            iconWhatsapp.href = `https://wa.me/${cleaned}`;
            iconWhatsapp.style.display = 'inline-flex';
        } else {
            iconWhatsapp.style.display = 'none';
        }
    }

    if (iconTiktok) {
        if (business.tiktok) {
            iconTiktok.href = `https://tiktok.com/@${business.tiktok.replace('@','')}`;
            iconTiktok.style.display = 'inline-flex';
        } else {
            iconTiktok.style.display = 'none';
        }
    }

    if (iconInstagram) {
        if (business.instagram) {
            iconInstagram.href = `https://instagram.com/${business.instagram.replace('@','')}`;
            iconInstagram.style.display = 'inline-flex';
        } else {
            iconInstagram.style.display = 'none';
        }
    }

    if (iconFacebook) {
        if (business.facebook) {
            iconFacebook.href = `https://facebook.com/messages/t/${business.facebook.replace('@','')}`;
            iconFacebook.style.display = 'inline-flex';
        } else {
            iconFacebook.style.display = 'none';
        }
    }

    if (iconPhone) {
        if (business.phone) {
            iconPhone.href = `tel:${business.phone}`;
            iconPhone.style.display = 'inline-flex';
        } else {
            iconPhone.style.display = 'none';
        }
    }
}

// ============================================================
//  RENDER MAP
// ============================================================

function renderMap(business) {
    const mapContainer = document.getElementById('shopMap');
    const lat = parseFloat(business.latitude);
    const lng = parseFloat(business.longitude);
    const address = business.address || '';

    if (mapContainer && typeof L !== 'undefined') {
        if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
            if (businessMap) businessMap.remove();
            window.businessMap = L.map('shopMap').setView([lat, lng], 15);
            businessMap = window.businessMap;
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; OpenStreetMap'
            }).addTo(businessMap);
            L.marker([lat, lng]).addTo(businessMap)
                .bindPopup(`<strong>${business.business_name}</strong><br>${address || business.location || ''}`);
            const mapAddressEl = document.getElementById('mapAddress');
            if (mapAddressEl) mapAddressEl.textContent = address ? `📍 ${address}` : '';
            const staticMapSection = document.getElementById('staticMapSection');
            if (staticMapSection) staticMapSection.style.display = 'block';
        }
    }
}

// ============================================================
//  BUILD BUSINESS SLIDER
// ============================================================

function buildBusinessSlider() {
    const wrapper = document.getElementById('sliderWrapper');
    if (!wrapper) return;

    const images = [];
    const heroImage = businessData.heroImage || businessData.heroimage;
    if (heroImage) images.push(heroImage);
    if (businessData.logo) images.push(businessData.logo);

    businessProductList.forEach(p => {
        if (p.image && !images.includes(p.image)) {
            images.push(p.image);
        }
    });

    if (images.length === 0) {
        wrapper.innerHTML = `<div class="slide">📸 No images available</div>`;
        return;
    }

    wrapper.innerHTML = images.map(img => `
        <div class="slide">
            <img src="${img}" alt="Business image" onerror="this.parentElement.innerHTML='<div>🖼️</div>'">
        </div>
    `).join('');

    window.businessSlideIndex = 0;
    businessSlideIndex = window.businessSlideIndex;
    updateBusinessSlider();
    clearInterval(businessSlideTimer);
    window.businessSlideTimer = setInterval(() => changeBusinessSlide(1), 4000);
    businessSlideTimer = window.businessSlideTimer;
}

function updateBusinessSlider() {
    const wrapper = document.getElementById('sliderWrapper');
    if (!wrapper) return;
    const total = wrapper.children.length || 1;
    wrapper.style.transform = `translateX(-${businessSlideIndex * 100}%)`;
}

function changeBusinessSlide(direction) {
    const wrapper = document.getElementById('sliderWrapper');
    if (!wrapper) return;
    const total = wrapper.children.length || 1;
    window.businessSlideIndex = (businessSlideIndex + direction + total) % total;
    businessSlideIndex = window.businessSlideIndex;
    updateBusinessSlider();
}

// ============================================================
//  LOAD BUSINESS PRODUCTS
// ============================================================

async function loadBusinessProducts() {
    try {
        const url = `/api/businesses/${encodeURIComponent(businessSlug)}/products?limit=100&page=1`;
        console.log('📡 Fetching products from:', url);

        const res = await fetch(url);
        if (!res.ok) {
            console.error('❌ Products API error:', res.status);
            throw new Error('Failed to load products');
        }
        const data = await res.json();
        const allProducts = data.products || [];
        const totalPages = data.pagination?.pages || 1;

        for (let page = 2; page <= totalPages; page += 1) {
            const nextRes = await fetch(`/api/businesses/${encodeURIComponent(businessSlug)}/products?limit=100&page=${page}`);
            if (!nextRes.ok) throw new Error(`Failed to load products (${nextRes.status})`);
            const nextData = await nextRes.json();
            allProducts.push(...(nextData.products || []));
        }

        window.businessProductList = allProducts;
        businessProductList = window.businessProductList;
        window.nextProductPage = totalPages + 1;
        window.hasMoreProducts = false;

        populateBusinessProductCategories();
        populateDefinedProductCategories();

        console.log(`📦 Loaded ${businessProductList.length} products for ${businessData.business_name}`);

        renderBusinessGrid();
    } catch (err) {
        console.error('❌ Products error:', err);
        const grid = document.getElementById('productGrid');
        if (grid) {
            grid.innerHTML = `<p style="text-align:center;padding:40px;color:#94a3b8;">No products available yet.</p>`;
        }
    }
}

// ============================================================
//  FALLBACK IMAGE — deterministic SVG, matches product-detail.js
// ============================================================

function businessFallbackImage(product) {
    const rawLabel = String((product && product.name) || 'Product').slice(0, 32);
    const safeLabel = rawLabel.replace(/[\u0000-\u001F\u007F\uD800-\uDFFF\uFFFE\uFFFF]/g, '');

    let encoded;
    try {
        encoded = encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#e2e8f0"/><text x="50%" y="46%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="34" fill="#475569">Product image</text><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="24" fill="#64748b">${safeLabel}</text></svg>`
        );
    } catch (err) {
        encoded = encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#e2e8f0"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="34" fill="#475569">Product image</text></svg>`
        );
    }

    return `data:image/svg+xml;charset=UTF-8,${encoded}`;
}

// ============================================================
//  POPULATE PRODUCT-CATEGORY FILTERS
// ============================================================

function populateBusinessProductCategories() {
    const select = document.getElementById('businessProductCategoryFilter');
    if (!select) return;
    const selected = select.value || 'all';
    const categories = [...new Set((businessProductList || []).map(product => product.category).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="all">All product categories</option>';
    categories.forEach(category => {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category;
        select.appendChild(option);
    });
    select.value = categories.includes(selected) ? selected : 'all';
}

function populateDefinedProductCategories() {
    const select = document.getElementById('businessProductCategoryIdFilter');
    if (!select) return;
    const selected = select.value || 'all';

    const map = new Map();
    (businessProductList || []).forEach(product => {
        if (!product.product_category_id) return;
        const id = String(product.product_category_id);
        if (!map.has(id)) {
            map.set(id, {
                id,
                name: product.product_category_name || 'Uncategorised',
                icon: product.product_category_icon || '📦'
            });
        }
    });

    const categories = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));

    select.innerHTML = '<option value="all">All defined categories</option>';
    categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat.id;
        option.textContent = `${cat.icon} ${cat.name}`;
        select.appendChild(option);
    });

    select.value = categories.some(c => c.id === selected) ? selected : 'all';
}

// ============================================================
//  RENDER BUSINESS GRID — single source of truth for card markup
// ============================================================

function renderBusinessGrid() {
    renderBusinessProductGrid(businessProductList || []);
}

function renderBusinessProductGrid(products) {
    const grid = document.getElementById('productGrid');
    if (!grid) return;

    if (!products || products.length === 0) {
        grid.innerHTML = `<p style="text-align:center;padding:40px;color:#94a3b8;">No products available yet.</p>`;
        return;
    }

    const cart = typeof getCart === 'function' ? getCart() : [];
    const onlineOrdersEnabled = businessData.online_orders_enabled !== false;

    grid.innerHTML = products.map(p => {
        const inCart = cart.some(item => item.id === p.id);
        const btnText = inCart ? 'Add More' : 'Add to Cart';
        const btnClass = inCart ? 'in-cart' : '';
        const qtyId = `bqty-${p.id}`;
        const disabled = !onlineOrdersEnabled ? 'disabled' : '';

        const imageSrc = p.image || businessFallbackImage(p);
        const fallbackForThisProduct = businessFallbackImage(p).replace(/'/g, "\\'");
        const imageHtml = `<img src="${imageSrc}" alt="${p.name}" loading="lazy" onerror="this.onerror=null;this.src='${fallbackForThisProduct}'">`;

        const ratingHtml = p.rating ? `<div class="rating"><span>⭐</span>(${p.rating})</div>` : '';
        const categoryHtml = p.product_category_name
            ? `<div class="product-category-chip" title="${p.product_category_name}">${p.product_category_icon || '📦'} ${p.product_category_name}</div>`
            : '';

        return `
            <div class="product-card">
                <div class="media-wrap" onclick="location.href='/product-detail.html?id=${p.id}&business=${businessSlug}'">
                    ${imageHtml}
                    <div class="quick-view-icon"><i class="fas fa-eye"></i></div>
                    ${p.isFlashSale ? `<div class="flash-badge">🔥</div>` : ''}
                    ${p.isNewArrival ? `<div class="new-badge">🆕</div>` : ''}
                    <i id="bwishlist-icon-${p.id}" class="far fa-heart" onclick="event.stopPropagation(); toggleBusinessWishlist(${p.id})" style="position:absolute; top:8px; left:8px; font-size:1.2rem; background:white; padding:4px; border-radius:50%; cursor:pointer; z-index:10;"></i>
                </div>
                <div class="info">
                    <div class="name">${p.name} ${inCart ? '<span class="green-tick">✔</span>' : ''}</div>
                    ${categoryHtml}
                    <div class="price">${p.price}</div>
                    ${ratingHtml}
                    <div class="actions">
                        <div class="qty-control">
                            <button onclick="changeBusinessCardQty(${p.id}, -1)" ${disabled}>−</button>
                            <span id="${qtyId}">1</span>
                            <button onclick="changeBusinessCardQty(${p.id}, 1)" ${disabled}>+</button>
                        </div>
                        <button class="btn-add ${btnClass}" onclick="addBusinessCardToCart(${p.id})" ${disabled}>
                            <i class="fas fa-cart-plus"></i> ${onlineOrdersEnabled ? btnText : 'Not available'}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function changeBusinessCardQty(productId, delta) {
    const qtySpan = document.getElementById(`bqty-${productId}`);
    if (!qtySpan) return;
    let current = parseInt(qtySpan.textContent) || 1;
    current = Math.max(1, current + delta);
    qtySpan.textContent = current;
}

function addBusinessCardToCart(productId) {
    if (businessData && businessData.online_orders_enabled === false) {
        showToast('❌ This shop is not taking orders at the moment.', 'error');
        return;
    }

    const qtySpan = document.getElementById(`bqty-${productId}`);
    const qty = qtySpan ? parseInt(qtySpan.textContent) || 1 : 1;
    if (typeof addToCart === 'function') {
        addToCart(productId, qty);
    }
    if (qtySpan) qtySpan.textContent = '1';
}

// ============================================================
//  FILTER BUSINESS PRODUCTS
//  Cumulative: search AND defined category AND legacy category.
// ============================================================

function filterBusinessProducts() {
    const grid = document.getElementById('productGrid');
    if (!grid) return;

    const query = (document.getElementById('businessSearchInput')?.value || '').trim().toLowerCase();
    const definedCategoryId = document.getElementById('businessProductCategoryIdFilter')?.value || 'all';
    const legacyCategory = document.getElementById('businessProductCategoryFilter')?.value || 'all';

    let products = (businessProductList || []).slice();

    if (query) {
        products = products.filter(p =>
            (p.name || '').toLowerCase().includes(query) ||
            (p.description && p.description.toLowerCase().includes(query))
        );
    }

    if (definedCategoryId !== 'all') {
        products = products.filter(p => String(p.product_category_id || '') === definedCategoryId);
    }

    if (legacyCategory !== 'all') {
        products = products.filter(p => p.category === legacyCategory);
    }

    if (products.length === 0) {
        grid.innerHTML = `<p style="text-align:center;padding:40px;color:#94a3b8;">No products match your filters.</p>`;
        return;
    }

    renderBusinessProductGrid(products);
}

// ============================================================
//  WISHLIST TOGGLE
// ============================================================

async function toggleBusinessWishlist(productId) {
    if (!isCustomerViewer()) {
        if (typeof openAuthModal === 'function') openAuthModal('login');
        return;
    }

    try {
        const res = await fetch('/api/wishlist', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ product_id: productId })
        });
        const data = await res.json();
        if (data.success) {
            const icon = document.getElementById(`bwishlist-icon-${productId}`);
            if (icon) {
                if (data.action === 'added') {
                    icon.className = 'fas fa-heart';
                    icon.style.color = '#ef4444';
                } else {
                    icon.className = 'far fa-heart';
                    icon.style.color = '';
                }
            }
            if (typeof showToast === 'function') {
                showToast(data.action === 'added' ? '❤️ Added to wishlist' : '💔 Removed from wishlist', 'success');
            }
        }
    } catch (err) {
        console.error('Wishlist error:', err);
    }
}

// ============================================================
//  FOLLOW/UNFOLLOW BUSINESS
// ============================================================

async function checkFollowStatus() {
    if (!isCustomerViewer()) return;

    try {
        const res = await fetch(`/api/businesses/${businessSlug}/follow-status`);
        if (!res.ok) {
            return;
        }
        const data = await res.json();
        window.isFollowing = data.isFollowing || false;
        isFollowing = window.isFollowing;
        updateFollowButton();
    } catch (err) {
        console.error('Check follow error:', err);
    }
}

function updateFollowButton() {
    const followText = document.getElementById('followText');
    const followBtn = document.getElementById('followBtn');
    if (!followText || !followBtn) return;

    if (isFollowing) {
        followText.textContent = 'Following';
        followBtn.className = 'btn btn-following';
    } else {
        followText.textContent = 'Follow';
        followBtn.className = 'btn btn-primary';
    }
}

async function toggleFollow() {
    if (!isCustomerViewer()) {
        if (typeof openAuthModal === 'function') openAuthModal('login');
        return;
    }

    try {
        const res = await fetch(`/api/businesses/${businessSlug}/follow`, {
            method: 'POST'
        });
        const data = await res.json();
        if (data.success) {
            window.isFollowing = data.action === 'followed';
            isFollowing = window.isFollowing;
            updateFollowButton();
            if (typeof showToast === 'function') {
                showToast(isFollowing ? '✅ Now following this business!' : '✅ Unfollowed this business', 'success');
            }
            loadBusinessProfile();
        }
    } catch (err) {
        console.error('Follow error:', err);
        alert('Could not update follow status. Please try again.');
    }
}

// ============================================================
//  LOCATION REQUEST
// ============================================================

async function checkLocationStatus() {
    if (!isCustomerViewer()) return false;

    try {
        const res = await fetch('/api/location/customer/status');
        if (!res.ok) return false;
        const data = await res.json();

        if (data.status === 'approved') {
            const liveSection = document.getElementById('liveLocationSection');
            if (liveSection) liveSection.style.display = 'block';
            initBusinessLiveMap();
            return true;
        }
        return false;
    } catch (err) {
        console.error('Location error:', err);
        return false;
    }
}

function initBusinessLiveMap() {
    if (typeof L === 'undefined' || !businessData) return;

    const container = document.getElementById('liveMap');
    if (!container) return;

    const lat = parseFloat(businessData.admin_lat) || parseFloat(businessData.latitude);
    const lng = parseFloat(businessData.admin_lng) || parseFloat(businessData.longitude);

    if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;

    if (businessLiveMap) businessLiveMap.remove();
    window.businessLiveMap = L.map(container).setView([lat, lng], 14);
    businessLiveMap = window.businessLiveMap;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap'
    }).addTo(businessLiveMap);

    window.businessLiveMarker = L.marker([lat, lng], {
        icon: L.divIcon({ className: 'admin-live-marker', html: '📍', iconSize: [30, 30] })
    }).addTo(businessLiveMap);
    businessLiveMarker = window.businessLiveMarker;

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const userLat = pos.coords.latitude;
                const userLng = pos.coords.longitude;
                const dist = getBusinessDistance(userLat, userLng, lat, lng);
                const distEl = document.getElementById('liveDistance');
                if (distEl) distEl.textContent = `📍 Distance: ${formatBusinessDistance(dist)}`;

                if (businessLiveRoute) businessLiveMap.removeLayer(businessLiveRoute);
                window.businessLiveRoute = L.polyline([[userLat, userLng], [lat, lng]], {
                    color: '#2563eb',
                    weight: 3,
                    dashArray: '8, 5'
                }).addTo(businessLiveMap);
                businessLiveRoute = window.businessLiveRoute;

                window.customerLocation = { lat: userLat, lng: userLng };
                customerLocation = window.customerLocation;
            },
            () => {
                const distEl = document.getElementById('liveDistance');
                if (distEl) distEl.textContent = '📍 Turn on GPS to see distance';
            }
        );
    }
}

function getBusinessDistance(lat1, lng1, lat2, lng2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatBusinessDistance(meters) {
    if (meters < 1000) return Math.round(meters) + ' m';
    return (meters/1000).toFixed(1) + ' km';
}

// ============================================================
//  UPDATE CART BADGE
// ============================================================

function updateCartBadge() {
    const cart = typeof getCart === 'function' ? getCart() : [];
    const count = cart.reduce((sum, item) => sum + item.quantity, 0);

    const badges = document.querySelectorAll('#cartBadge, #navCartBadge, #navCartBadgeBP');
    badges.forEach(badge => {
        if (badge) {
            if (count > 0) {
                badge.textContent = count;
                badge.classList.add('show');
            } else {
                badge.classList.remove('show');
            }
        }
    });
}

function updateNavCartBadge() {
    updateCartBadge();
}

// ============================================================
//  SHOW TOAST
// ============================================================

function showToast(message, type = 'success') {
    if (typeof window.showToast === 'function' && window.showToast !== showToast) {
        window.showToast(message, type);
        return;
    }

    const existing = document.querySelector('.toast-container');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.className = 'toast-container';
    container.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 99999;
        max-width: 400px;
        width: 100%;
    `;

    const toast = document.createElement('div');
    const typeMap = {
        success: '#22c55e',
        error: '#ef4444',
        warning: '#f59e0b',
        info: '#2563eb'
    };
    const iconMap = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };
    const bgColor = typeMap[type] || '#2563eb';

    toast.className = `toast ${type}`;
    toast.style.cssText = `
        background: ${bgColor};
        color: white;
        padding: 14px 20px;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.15);
        font-size: 0.9rem;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 12px;
        animation: slideIn 0.3s ease;
        margin-bottom: 8px;
        transform: translateX(0);
        transition: transform 0.3s;
        word-break: break-word;
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
    closeBtn.style.cssText = `
        background: none;
        border: none;
        color: white;
        font-size: 1rem;
        cursor: pointer;
        margin-left: auto;
        opacity: 0.7;
        transition: opacity 0.2s;
        flex-shrink: 0;
    `;

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
//  EXPOSE FUNCTIONS
// ============================================================

window.logout = logout;

window.changeBusinessCardQty = changeBusinessCardQty;
window.addBusinessCardToCart = addBusinessCardToCart;
window.goToMarketplaceCart = goToMarketplaceCart;
window.changeBusinessSlide = changeBusinessSlide;
window.loadBusinessProfile = loadBusinessProfile;
window.toggleBusinessWishlist = toggleBusinessWishlist;
window.toggleFollow = toggleFollow;
window.filterBusinessProducts = filterBusinessProducts;
window.showToast = showToast;
window.checkIfOwnBusiness = checkIfOwnBusiness;

window.getViewerRole = getViewerRole;
window.isCustomerViewer = isCustomerViewer;
window.isBusinessAdminViewer = isBusinessAdminViewer;

window.renderBusinessProductGrid = renderBusinessProductGrid;
window.populateDefinedProductCategories = populateDefinedProductCategories;
window.businessFallbackImage = businessFallbackImage;

window.applyOrderVisibilityState = applyOrderVisibilityState;
window.renderOrdersPausedBanner = renderOrdersPausedBanner;
window.renderOrdersPausedContactBlock = renderOrdersPausedContactBlock;

window.renderHeroMedia = renderHeroMedia;
window.renderHeroDescriptionOverlay = renderHeroDescriptionOverlay;

window.renderThankYouBand = renderThankYouBand;
window.renderHeroSearchTagChip = renderHeroSearchTagChip;

console.log('✅ Business Profile JS loaded successfully (Section 10 — business rating reference removed, dead review code removed)');