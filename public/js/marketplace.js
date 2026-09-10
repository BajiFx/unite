// ============================================================
//  MARKETPLACE JAVASCRIPT - Multi-Vendor Platform
//  Location: public/js/marketplace.js
// ============================================================

// ============================================================
//  GLOBALS
// ============================================================

let allBusinesses = [];
let featuredBusinesses = [];
let currentPage = 1;
let hasMore = true;
let isLoading = false;
const limit = 12;

// ============================================================
//  LOAD MARKETPLACE DATA
// ============================================================

async function loadMarketplace() {
    try {
        // Load categories first
        await loadCategories();

        // Load featured businesses
        await loadFeaturedBusinesses();

        // Load all businesses
        await loadBusinesses();

        // Load platform stats
        await loadPlatformStats();

        // Update user UI
        if (typeof updateUserUI === 'function') {
            updateUserUI();
        }

        // Update cart badge
        if (typeof updateCartBadge === 'function') {
            updateCartBadge();
        }
        if (typeof updateNavCartBadge === 'function') {
            updateNavCartBadge();
        }

        console.log('✅ Marketplace loaded successfully');
    } catch (err) {
        console.error('❌ Marketplace load error:', err);
        showToast('Error loading marketplace. Please refresh.', 'error');
    }
}

// ============================================================
//  LOAD CATEGORIES
// ============================================================

async function loadCategories() {
    try {
        const res = await fetch('/api/businesses/categories/all');
        if (!res.ok) throw new Error('Failed to load categories');
        const categories = await res.json();

        const select = document.getElementById('categoryFilter');
        if (select && categories.length > 0) {
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

// ============================================================
//  LOAD FEATURED BUSINESSES
// ============================================================

async function loadFeaturedBusinesses() {
    try {
        const res = await fetch('/api/businesses?featured=true&limit=6');
        if (!res.ok) throw new Error('Failed to load featured businesses');
        const data = await res.json();
        featuredBusinesses = data.businesses || [];
        renderFeaturedBusinesses();
    } catch (err) {
        console.error('Error loading featured businesses:', err);
        document.getElementById('featuredGrid').innerHTML = `
            <div class="empty-state">
                <div class="icon">🏪</div>
                <h3>No featured businesses</h3>
                <p>Check back soon for featured businesses</p>
            </div>
        `;
    }
}

// ============================================================
//  RENDER FEATURED BUSINESSES
// ============================================================

function renderFeaturedBusinesses() {
    const container = document.getElementById('featuredGrid');

    if (!featuredBusinesses || featuredBusinesses.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="grid-column:1/-1;">
                <div class="icon">🏪</div>
                <h3>No featured businesses</h3>
                <p>Check back soon for featured businesses</p>
            </div>
        `;
        return;
    }

    container.innerHTML = featuredBusinesses.map(business =>
        createBusinessCard(business)
    ).join('');
}

// ============================================================
//  LOAD BUSINESSES
// ============================================================

async function loadBusinesses(reset = true) {
    if (reset) {
        currentPage = 1;
        allBusinesses = [];
        hasMore = true;
    }

    if (isLoading || !hasMore) return;
    isLoading = true;

    const search = document.getElementById('businessSearch')?.value || '';
    const category = document.getElementById('categoryFilter')?.value || 'all';
    const sort = document.getElementById('sortFilter')?.value || 'newest';

    try {
        const url = `/api/businesses?page=${currentPage}&limit=${limit}&search=${encodeURIComponent(search)}&category=${category}&sort=${sort}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to load businesses');
        const data = await res.json();

        const businesses = data.businesses || [];
        hasMore = data.pagination?.page < data.pagination?.pages;

        if (reset) {
            allBusinesses = businesses;
            renderBusinesses();
        } else {
            allBusinesses = [...allBusinesses, ...businesses];
            appendBusinesses();
        }

        currentPage++;

        // Show/hide load more button
        const loadMoreBtn = document.getElementById('loadMoreBtn');
        if (loadMoreBtn) {
            loadMoreBtn.style.display = hasMore ? 'inline-block' : 'none';
        }

    } catch (err) {
        console.error('Error loading businesses:', err);
        showToast('Error loading businesses', 'error');
    } finally {
        isLoading = false;
    }
}

// ============================================================
//  RENDER BUSINESSES
// ============================================================

function renderBusinesses() {
    const container = document.getElementById('businessGrid');

    if (!allBusinesses || allBusinesses.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="grid-column:1/-1;">
                <div class="icon">🔍</div>
                <h3>No businesses found</h3>
                <p>Try adjusting your search or filters</p>
            </div>
        `;
        return;
    }

    container.innerHTML = allBusinesses.map(business =>
        createBusinessCard(business)
    ).join('');
}

// ============================================================
//  APPEND BUSINESSES (Load More)
// ============================================================

function appendBusinesses() {
    const container = document.getElementById('businessGrid');

    if (!allBusinesses || allBusinesses.length === 0) return;

    const newHtml = allBusinesses.slice(-limit).map(business =>
        createBusinessCard(business)
    ).join('');

    container.innerHTML += newHtml;
}

// ============================================================
//  CREATE BUSINESS CARD
// ============================================================

function createBusinessCard(business) {
    const logoHtml = business.logo
        ? `<img src="${business.logo}" alt="${business.business_name}">`
        : `<div class="no-image">🏪</div>`;

    const rating = parseFloat(business.avg_rating) || 0;
    const ratingStars = rating > 0 ? '⭐'.repeat(Math.round(rating)) : '';
    const ratingDisplay = rating > 0 ? `<span class="rating">${ratingStars} ${rating.toFixed(1)}</span>` : '';

    const badges = [];
    if (business.is_verified) {
        badges.push('<span class="badge verified">✅ Verified</span>');
    }
    if (business.is_featured) {
        badges.push('<span class="badge featured">⭐ Featured</span>');
    }

    const description = business.description || '';
    const truncatedDesc = description.length > 100
        ? description.substring(0, 100) + '...'
        : description;

    const productCount = business.product_count || 0;
    const followerCount = business.follower_count || 0;
    const reviewCount = business.review_count || 0;

    return `
        <div class="business-card" onclick="window.location.href='/business/${business.slug}'">
            <div class="card-image">
                ${logoHtml}
                <div class="card-badges">
                    ${badges.join('')}
                </div>
            </div>
            <div class="card-body">
                <div class="business-name">${business.business_name}</div>
                <div class="business-location">📍 ${business.location || 'Kenya'}</div>
                ${truncatedDesc ? `<div class="business-description">${truncatedDesc}</div>` : ''}
                <div class="business-stats">
                    <span>🛍️ ${productCount} products</span>
                    <span>👥 ${followerCount} followers</span>
                    ${ratingDisplay}
                    ${reviewCount > 0 ? `<span>${reviewCount} reviews</span>` : ''}
                </div>
            </div>
        </div>
    `;
}

// ============================================================
//  LOAD PLATFORM STATS
// ============================================================

async function loadPlatformStats() {
    try {
        const [statisticsResponse, businessesResponse] = await Promise.all([
            fetch('/api/shop/statistics'),
            fetch('/api/businesses?limit=1&page=1')
        ]);
        if (!statisticsResponse.ok || !businessesResponse.ok) {
            throw new Error('Failed to load public marketplace statistics');
        }

        const [statistics, businesses] = await Promise.all([
            statisticsResponse.json(),
            businessesResponse.json()
        ]);
        const totalBusinesses = document.getElementById('totalBusinesses');
        const totalProducts = document.getElementById('totalProducts');
        const totalCustomers = document.getElementById('totalCustomers');
        if (totalBusinesses) totalBusinesses.textContent = businesses.pagination?.total || 0;
        if (totalProducts) totalProducts.textContent = statistics.totalProducts || 0;
        if (totalCustomers) totalCustomers.textContent = statistics.totalCustomers || 0;
    } catch (err) {
        console.error('Error loading platform stats:', err);
    }
}

// ============================================================
//  SEARCH & FILTER FUNCTIONS
// ============================================================

function searchBusinesses() {
    loadBusinesses(true);
}

function filterBusinesses() {
    loadBusinesses(true);
}

function loadMoreBusinesses() {
    loadBusinesses(false);
}

// ============================================================
//  TOAST FUNCTION (if not already defined)
// ============================================================

function showToast(message, type = 'success') {
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
    closeBtn.onmouseover = () => closeBtn.style.opacity = '1';
    closeBtn.onclick = () => {
        toast.style.transform = 'translateX(120%)';
        setTimeout(() => container.remove(), 300);
    };

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

window.searchBusinesses = searchBusinesses;
window.filterBusinesses = filterBusinesses;
window.loadMoreBusinesses = loadMoreBusinesses;
window.loadMarketplace = loadMarketplace;

// ============================================================
//  INIT
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('📄 Marketplace page loaded');

    // Load marketplace data
    loadMarketplace();

    // Check authentication
    if (typeof fetchCurrentUser === 'function') {
        fetchCurrentUser();
    }

    // Load cart from server if logged in
    if (window.customerToken && typeof loadCartFromServer === 'function') {
        loadCartFromServer();
    }
});

console.log('✅ Marketplace JS loaded successfully');
