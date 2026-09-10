// ============================================================
//  BUSINESS PROFILE JAVASCRIPT - COMPLETE VERSION (FIXED)
//  Location: public/js/business-profile.js
// ============================================================

// ============================================================
//  GLOBALS - Make sure no duplicate declarations with app.js
// ============================================================

// Check if already declared in app.js, if not then declare
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
if (typeof window.reviewRating === 'undefined') {
    window.reviewRating = 0;
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
let reviewRating = window.reviewRating;
let isFollowing = window.isFollowing;
let customerLocation = window.customerLocation;
let isOwnBusiness = window.isOwnBusiness;

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
    if (title) title.textContent = 'Please Login or Register to access your cart';
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
        showError('No business specified', 'Please return to the marketplace and select a business.');
        return;
    }

    // FIXED: Call updateNavigation directly instead of updateBusinessProfileNav
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
                showError('Business not found', 'The business you are looking for does not exist.');
                return;
            }
            throw new Error(`Failed to load business: ${res.status}`);
        }

        const data = await res.json();
        console.log('📦 Business data received:', data);

        window.businessData = data.business;
        businessData = window.businessData;

        if (!businessData) {
            showError('Business not found', 'The business you are looking for does not exist.');
            return;
        }

        console.log('✅ Business loaded:', businessData.business_name);

        checkIfOwnBusiness();

        // FIXED: Call updateNavigation directly instead of updateBusinessProfileNav
        if (typeof updateNavigation === 'function') {
            updateNavigation();
        }

        if (loadingEl) loadingEl.style.display = 'none';
        if (contentEl) contentEl.style.display = 'block';

        renderBusinessProfile();
        await loadBusinessProducts();
        buildBusinessSlider();
        loadBusinessReviews();
        checkFollowStatus();
        checkLocationStatus();

        document.title = `${businessData.business_name} - Shop Kenya`;
        window.businessProfileLoaded = true;
        businessProfileLoaded = window.businessProfileLoaded;

        console.log('✅ Business profile loaded successfully for:', businessData.business_name);

    } catch (err) {
        console.error('❌ Business profile error:', err);
        showError('Error loading business', err.message);
    }
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
    const heroSection = document.getElementById('heroSection');

    if (heroTitle) heroTitle.textContent = business.business_name || 'Welcome';
    if (heroLocation) heroLocation.textContent = business.location ? `📍 ${business.location}` : '';
    if (heroAddress) heroAddress.textContent = business.address ? `🏠 ${business.address}` : '';

    const productCount = business.product_count || 0;
    const avgRating = parseFloat(business.avg_rating) || 0;
    const followerCount = business.follower_count || 0;

    document.getElementById('productCount').textContent = productCount;
    document.getElementById('avgRating').textContent = avgRating.toFixed(1);
    document.getElementById('followerCount').textContent = followerCount;

    if (heroLogo) {
        if (business.logo && business.logo !== '') {
            heroLogo.src = business.logo;
            heroLogo.style.display = 'block';
        } else {
            heroLogo.style.display = 'none';
        }
    }

    if (heroSection) {
        const heroImage = business.heroImage || business.heroimage;
        if (heroImage) {
            heroSection.style.backgroundImage = `url(${heroImage})`;
            heroSection.style.backgroundSize = 'cover';
            heroSection.style.backgroundPosition = 'center';
        } else {
            heroSection.style.backgroundImage = 'linear-gradient(135deg, #1e293b, #0f172a)';
        }
    }

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
        populateBusinessProductCategories();
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
//  RENDER BUSINESS GRID
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

function renderBusinessGrid() {
    const grid = document.getElementById('productGrid');
    if (!grid) return;

    const products = businessProductList || [];

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

        let imageHtml = '';
        if (p.image) {
            imageHtml = `<img src="${p.image}" alt="${p.name}" loading="lazy" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<div style=\\'display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:2rem;\\'>📦</div>'">`;
        } else {
            imageHtml = `<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:2rem;">📦</div>`;
        }

        const ratingHtml = p.rating ? `<div class="rating"><span>⭐</span>(${p.rating})</div>` : '';

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
                    <div class="price">${p.price}</div>
                    ${ratingHtml}
                    <div class="actions">
                        <div class="qty-control">
                            <button onclick="changeBusinessCardQty(${p.id}, -1)" ${disabled}>−</button>
                            <span id="${qtyId}">1</span>
                            <button onclick="changeBusinessCardQty(${p.id}, 1)" ${disabled}>+</button>
                        </div>
                        <button class="btn-add ${btnClass}" onclick="addBusinessCardToCart(${p.id})" ${disabled}>
                            <i class="fas fa-cart-plus"></i> ${onlineOrdersEnabled ? btnText : 'Unavailable'}
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
        showToast('❌ This business is not accepting online orders at the moment.', 'error');
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
// ============================================================

function filterBusinessProducts() {
    const searchInput = document.getElementById('businessSearchInput');
    const grid = document.getElementById('productGrid');

    if (!grid || !businessProductList) return;

    const query = searchInput?.value?.trim().toLowerCase() || '';
    const category = document.getElementById('businessProductCategoryFilter')?.value || 'all';

    let products = businessProductList || [];

    if (query) {
        products = products.filter(p =>
            p.name.toLowerCase().includes(query) ||
            (p.description && p.description.toLowerCase().includes(query))
        );
    }
    if (category !== 'all') products = products.filter(product => product.category === category);

    if (products.length === 0) {
        grid.innerHTML = `<p style="text-align:center;padding:40px;color:#94a3b8;">No products found for "<strong>${query}</strong>"</p>`;
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

        let imageHtml = '';
        if (p.image) {
            imageHtml = `<img src="${p.image}" alt="${p.name}" loading="lazy" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<div style=\\'display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:2rem;\\'>📦</div>'">`;
        } else {
            imageHtml = `<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:2rem;">📦</div>`;
        }

        const ratingHtml = p.rating ? `<div class="rating"><span>⭐</span>(${p.rating})</div>` : '';

        return `
            <div class="product-card">
                <div class="media-wrap" onclick="location.href='/product-detail.html?id=${p.id}&business=${businessSlug}'">
                    ${imageHtml}
                    <div class="quick-view-icon"><i class="fas fa-eye"></i></div>
                    ${p.isFlashSale ? `<div class="flash-badge">🔥</div>` : ''}
                    ${p.isNewArrival ? `<div class="new-badge">🆕</div>` : ''}
                </div>
                <div class="info">
                    <div class="name">${p.name} ${inCart ? '<span class="green-tick">✔</span>' : ''}</div>
                    <div class="price">${p.price}</div>
                    ${ratingHtml}
                    <div class="actions">
                        <div class="qty-control">
                            <button onclick="changeBusinessCardQty(${p.id}, -1)" ${disabled}>−</button>
                            <span id="${qtyId}">1</span>
                            <button onclick="changeBusinessCardQty(${p.id}, 1)" ${disabled}>+</button>
                        </div>
                        <button class="btn-add ${btnClass}" onclick="addBusinessCardToCart(${p.id})" ${disabled}>
                            <i class="fas fa-cart-plus"></i> ${onlineOrdersEnabled ? btnText : 'Unavailable'}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// ============================================================
//  WISHLIST TOGGLE
// ============================================================

async function toggleBusinessWishlist(productId) {
    if (!window.customerToken) {
        if (typeof openAuthModal === 'function') openAuthModal('login');
        return;
    }
    try {
        const res = await fetch('/api/wishlist', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${window.customerToken}`
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
//  LOAD BUSINESS REVIEWS
// ============================================================

async function loadBusinessReviews() {
    try {
        const res = await fetch(`/api/businesses/${businessSlug}/reviews?limit=20`);
        if (!res.ok) throw new Error('Failed to load reviews');
        const reviews = await res.json();

        const container = document.getElementById('reviewsList');
        if (!container) return;

        if (!reviews || reviews.length === 0) {
            container.innerHTML = '<p style="color:#94a3b8;">No reviews yet. Be the first to review!</p>';
            return;
        }

        container.innerHTML = reviews.map(r => `
            <div class="review-item">
                <div class="review-rating">${'⭐'.repeat(Math.min(r.rating, 5))}</div>
                <div class="review-text">${r.review_text || ''}</div>
                <div class="review-meta">
                    <span class="reviewer">${r.customer_name || 'Anonymous'}</span>
                    <span>${new Date(r.created_at).toLocaleDateString()}</span>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('❌ Reviews error:', err);
        const container = document.getElementById('reviewsList');
        if (container) {
            container.innerHTML = '<p style="color:#ef4444;">Error loading reviews.</p>';
        }
    }
}

// ============================================================
//  SET RATING
// ============================================================

function setRating(rating) {
    window.reviewRating = rating;
    reviewRating = window.reviewRating;
    const stars = document.querySelectorAll('#reviewStars span');
    stars.forEach((star, index) => {
        star.style.color = index < rating ? '#f59e0b' : '#d1d5db';
    });
}

// ============================================================
//  SUBMIT BUSINESS REVIEW
// ============================================================

async function submitBusinessReview() {
    if (!window.customerToken) {
        if (typeof openAuthModal === 'function') openAuthModal('login');
        return;
    }

    const text = document.getElementById('reviewText').value.trim();
    if (!reviewRating) {
        alert('Please select a rating.');
        return;
    }
    if (!text) {
        alert('Please write a review.');
        return;
    }

    try {
        const res = await fetch(`/api/businesses/${businessSlug}/review`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${window.customerToken}`
            },
            body: JSON.stringify({ rating: reviewRating, review_text: text })
        });
        const data = await res.json();
        if (data.success) {
            if (typeof showToast === 'function') {
                showToast('✅ Review submitted!', 'success');
            }
            document.getElementById('reviewText').value = '';
            setRating(0);
            loadBusinessReviews();
            loadBusinessProfile();
        } else {
            alert('❌ ' + (data.error || 'Failed to submit review'));
        }
    } catch (err) {
        alert('❌ Network error');
    }
}

// ============================================================
//  FOLLOW/UNFOLLOW BUSINESS
// ============================================================

async function checkFollowStatus() {
    const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
    if (!user.email) return;

    try {
        const res = await fetch(`/api/businesses/${businessSlug}/follow-status`, {
            headers: { 'Authorization': `Bearer ${window.customerToken}` }
        });
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
    const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
    if (!user.email) {
        if (typeof openAuthModal === 'function') openAuthModal('login');
        return;
    }

    try {
        const res = await fetch(`/api/businesses/${businessSlug}/follow`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${window.customerToken}` }
        });
        const data = await res.json();
        if (data.success) {
            window.isFollowing = data.action === 'followed';
            isFollowing = window.isFollowing;
            updateFollowButton();
            if (typeof showToast === 'function') {
                showToast(isFollowing ? '✅ Following business!' : '✅ Unfollowed business', 'success');
            }
            loadBusinessProfile();
        }
    } catch (err) {
        console.error('Follow error:', err);
        alert('Error updating follow status');
    }
}

// ============================================================
//  LOCATION REQUEST
// ============================================================

async function checkLocationStatus() {
    const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
    if (!user.email) return false;

    try {
        const res = await fetch('/api/location/customer/status', {
            headers: { 'Authorization': `Bearer ${window.customerToken}` }
        });
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
                if (distEl) distEl.textContent = '📍 Enable GPS to see distance';
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
    if (typeof window.showToast === 'function') {
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

window.changeBusinessCardQty = changeBusinessCardQty;
window.addBusinessCardToCart = addBusinessCardToCart;
window.goToMarketplaceCart = goToMarketplaceCart;
window.changeBusinessSlide = changeBusinessSlide;
window.loadBusinessProfile = loadBusinessProfile;
window.toggleBusinessWishlist = toggleBusinessWishlist;
window.setRating = setRating;
window.submitBusinessReview = submitBusinessReview;
window.toggleFollow = toggleFollow;
window.filterBusinessProducts = filterBusinessProducts;
window.showToast = showToast;
window.checkIfOwnBusiness = checkIfOwnBusiness;

console.log('✅ Business Profile JS loaded successfully (FIXED - No circular dependency)');
