// ============================================================
//  INDEX.JS - COMPLETE FIXED VERSION
//  Location: public/js/index.js
// ============================================================

// ============================================================
//  GLOBALS
// ============================================================

window.customerToken = 'cookie-auth';

let currentPage = 1;
let hasMore = true;
let isLoading = false;
const limit = 12;
let allBusinesses = [];
let featuredBusinesses = [];
let currentPanel = null;
let currentUser = null;
let isLoggedIn = false;
let currentLoginType = 'customer';
let currentRegisterType = 'customer';
let marketplaceSearchWasTyped = false;

// Cache of business categories loaded once from the API.
// Set to null after a successful registration so the next visit refetches.
let businessCategoriesCache = null;

function getMarketplaceSearchQuery() {
  const input = document.getElementById('businessSearch');
  const value = input?.value?.trim() || '';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    if (input) input.value = '';
    return '';
  }
  return value;
}

// ============================================================
//  INIT
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
  // This file also supplies the shared auth modal on business-profile pages.
  // Do not initialize marketplace-only state when that shell is absent.
  if (!document.getElementById('businessGrid')) return;
  console.log('📄 Index page loaded');

  // Never use browser/password-manager autofill as a marketplace query.
  const businessSearch = document.getElementById('businessSearch');
  if (businessSearch) {
    businessSearch.value = '';
    businessSearch.defaultValue = '';
    businessSearch.addEventListener('input', event => {
      marketplaceSearchWasTyped ||= ['insertText', 'insertFromPaste'].includes(event.inputType);
    });
    setTimeout(() => {
      if (!marketplaceSearchWasTyped) businessSearch.value = '';
    }, 500);
  }

  // Load marketplace data
  loadMarketplace();

  // Check auth state
  checkAuthState();

  const requestedAuth = new URLSearchParams(window.location.search).get('auth');
  if (requestedAuth === 'login' || requestedAuth === 'register') {
    openAuthModal(requestedAuth);
  }

  // Setup hamburger menu (workspace-aware)
  const hamburger = document.getElementById('hamburgerBtn');
  if (hamburger) {
    hamburger.addEventListener('click', toggleMobileSidebar);
  }

  // A.1 — Load categories for the registration form on page load.
  // The function is a no-op if the registration form is not in the DOM.
  loadBusinessCategoriesForRegistration();
});

// ============================================================
//  LOAD MARKETPLACE
// ============================================================

async function loadMarketplace() {
  try {
    await loadCategories();
    await loadFeaturedBusinesses();
    await loadBusinesses();
    await loadPlatformStats();
    updateCartBadge();
    console.log('✅ Marketplace loaded successfully');
  } catch (err) {
    console.error('❌ Marketplace load error:', err);
    showToast('Error loading marketplace. Please refresh.', 'error');
  }
}

// ============================================================
//  LOAD CATEGORIES (for marketplace filter)
// ============================================================

async function loadCategories() {
  try {
    const res = await fetch('/api/businesses/categories/all');
    if (!res.ok) throw new Error('Failed to load categories');
    const categories = await res.json();

    const select = document.getElementById('businessCategoryFilter');
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

// ============================================================
//  A.1–A.3  LOAD BUSINESS CATEGORIES FOR REGISTRATION
//  Uses a cached list. Populates the register dropdown with
//  proper loading, success, and error states.
//  Pass forceReload = true to bypass the cache (A.7).
// ============================================================

async function loadBusinessCategoriesForRegistration(forceReload = false) {
  const primarySelect = document.getElementById('regBusinessPrimaryCategory');
  if (!primarySelect) return;

  // If we already have a cached list and don't need to reload, use it
  if (businessCategoriesCache && !forceReload) {
    populateRegisterCategorySelect(businessCategoriesCache);
    return;
  }

  // A.1 — Show loading state before the options are loaded
  primarySelect.innerHTML = '<option value="">⏳ Loading categories...</option>';
  primarySelect.disabled = true;
  const helpText = document.getElementById('regBusinessCategoryHelp');
  if (helpText) {
    helpText.style.display = 'block';
    helpText.style.color = '#94a3b8';
    helpText.textContent = 'Loading categories...';
  }
  const errEl = document.getElementById('businessCategoryError');
  if (errEl) errEl.style.display = 'none';

  try {
    const res = await fetch('/api/businesses/categories/all', { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to load categories (${res.status})`);
    const categories = await res.json();

    if (!Array.isArray(categories) || categories.length === 0) {
      throw new Error('No categories returned');
    }

    businessCategoriesCache = categories;
    populateRegisterCategorySelect(categories);
  } catch (err) {
    console.error('Error loading business categories:', err);
    // A.2 — Handle load failure gracefully
    primarySelect.innerHTML = '<option value="">❌ Categories could not be loaded</option>';
    primarySelect.disabled = true;
    if (helpText) {
      helpText.textContent = 'Categories could not be loaded. Please refresh the page and try again.';
      helpText.style.color = '#ef4444';
    }
    const additionalWrap = document.getElementById('regBusinessAdditionalCategoriesWrap');
    if (additionalWrap) additionalWrap.style.display = 'none';
  }
}

// ============================================================
//  POPULATE THE REGISTER CATEGORY DROPDOWN + ADDITIONAL LIST
//  A.3 — User can select. A.6 — Primary + additional categories.
// ============================================================

function populateRegisterCategorySelect(categories) {
  const primarySelect = document.getElementById('regBusinessPrimaryCategory');
  const additionalWrap = document.getElementById('regBusinessAdditionalCategoriesWrap');
  const additionalList = document.getElementById('regBusinessAdditionalCategories');
  if (!primarySelect) return;

  // Build the options for the primary select — first option is a placeholder
  let html = '<option value="">Select a primary category...</option>';
  categories.forEach(cat => {
    const label = `${cat.icon || '📦'} ${cat.name}`;
    html += `<option value="${cat.id}">${label}</option>`;
  });
  primarySelect.innerHTML = html;
  primarySelect.disabled = false;

  // Build the additional categories checkbox list
  if (additionalList && additionalWrap) {
    additionalList.innerHTML = categories.map(cat => {
      const label = `${cat.icon || '📦'} ${cat.name}`;
      return `
        <label style="display:flex; align-items:center; gap:6px; font-size:0.8rem; color:#334155; cursor:pointer;">
          <input type="checkbox" class="reg-additional-category" value="${cat.id}" onchange="handleAdditionalCategoryChange()">
          <span>${label}</span>
        </label>
      `;
    }).join('');
    additionalWrap.style.display = 'block';
  }

  // Restore help text
  const helpText = document.getElementById('regBusinessCategoryHelp');
  if (helpText) {
    helpText.textContent = 'Choose the category (or categories) that best describe what your business sells.';
    helpText.style.color = '#94a3b8';
  }

  // Clear any previous selection error as soon as the user picks something
  primarySelect.onchange = () => {
    const errEl = document.getElementById('businessCategoryError');
    if (errEl) errEl.style.display = 'none';
    primarySelect.style.borderColor = '#d1d5db';
    syncAdditionalCategoryOptions();
    handleAdditionalCategoryChange();
  };
}

// ============================================================
//  SYNC ADDITIONAL CATEGORY OPTIONS
//  Disable whichever category is chosen as the primary one
//  so the same category is not selected twice.
// ============================================================

function syncAdditionalCategoryOptions() {
  const primarySelect = document.getElementById('regBusinessPrimaryCategory');
  const primaryId = primarySelect ? primarySelect.value : '';
  document.querySelectorAll('.reg-additional-category').forEach(cb => {
    const matchesPrimary = cb.value === primaryId;
    if (matchesPrimary) {
      cb.checked = false;
      cb.disabled = true;
      cb.parentElement.style.opacity = '0.5';
    } else {
      cb.disabled = false;
      cb.parentElement.style.opacity = '1';
    }
  });
}

// ============================================================
//  HANDLE ADDITIONAL CATEGORY CHANGES
//  Clears the category error as soon as any category is picked.
// ============================================================

function handleAdditionalCategoryChange() {
  const errEl = document.getElementById('businessCategoryError');
  if (errEl) errEl.style.display = 'none';
  const primarySelect = document.getElementById('regBusinessPrimaryCategory');
  if (primarySelect) primarySelect.style.borderColor = '#d1d5db';
}

// ============================================================
//  LOAD FEATURED BUSINESSES
// ============================================================

async function loadFeaturedBusinesses() {
  try {
    const res = await fetch('/api/businesses?featured=true&limit=6&_=' + Date.now());
    if (!res.ok) throw new Error('Failed to load featured businesses');
    const data = await res.json();
    featuredBusinesses = data.businesses || [];
    renderFeaturedBusinesses();
  } catch (err) {
    console.error('Error loading featured businesses:', err);
    const container = document.getElementById('featuredGrid');
    if (container) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1; text-align:center; padding:40px; color:#94a3b8;">
          <div style="font-size:2rem;">🏪</div>
          <h3 style="margin-top:8px;">No featured businesses</h3>
          <p>Check back soon for featured businesses</p>
        </div>
      `;
    }
  }
}

function renderFeaturedBusinesses() {
  const container = document.getElementById('featuredGrid');
  if (!container) return;

  if (!featuredBusinesses || featuredBusinesses.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1; text-align:center; padding:40px; color:#94a3b8;">
        <div style="font-size:2rem;">🏪</div>
        <h3 style="margin-top:8px;">No featured businesses</h3>
        <p>Check back soon for featured businesses</p>
      </div>
    `;
    return;
  }

  container.innerHTML = featuredBusinesses.map(business => createBusinessCard(business)).join('');
}

// ============================================================
//  LOAD BUSINESSES
// ============================================================

async function loadBusinesses(reset = true) {
  if (reset) {
    currentPage = 1;
    hasMore = true;
    allBusinesses = [];
  }
  if (isLoading || !hasMore) return;
  isLoading = true;

  const search = getMarketplaceSearchQuery();
  const category = document.getElementById('businessCategoryFilter')?.value || 'all';
  const sort = document.getElementById('sortFilter')?.value || 'newest';

  const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';

  try {
    const url = `/api/businesses?page=${currentPage}&limit=${limit}${searchParam}&category=${category}&sort=${sort}&_=${Date.now()}`;
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

    const loadMoreBtn = document.getElementById('loadMoreBtn');
    if (loadMoreBtn) {
      loadMoreBtn.style.display = hasMore ? 'inline-block' : 'none';
    }
  } catch (err) {
    console.error('❌ Error loading businesses:', err);
    showToast('Error loading businesses', 'error');
  } finally {
    isLoading = false;
  }
}

function renderBusinesses() {
  const container = document.getElementById('businessGrid');
  if (!container) return;

  if (!allBusinesses || allBusinesses.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1; text-align:center; padding:40px; color:#94a3b8;">
        <div style="font-size:2rem;">🔍</div>
        <h3 style="margin-top:8px;">No businesses found</h3>
        <p>Try adjusting your search or filters</p>
      </div>
    `;
    return;
  }

  container.innerHTML = allBusinesses.map(business => createBusinessCard(business)).join('');
}

function appendBusinesses() {
  const container = document.getElementById('businessGrid');
  if (!container) return;

  const start = Math.max(0, allBusinesses.length - limit);
  const newBusinesses = allBusinesses.slice(start);
  const newHtml = newBusinesses.map(business => createBusinessCard(business)).join('');
  container.innerHTML += newHtml;
}

function createBusinessCard(business) {
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
  const ratingDisplay = rating > 0 ? `<span class="rating">${ratingStars} ${rating.toFixed(1)}</span>` : '';

  const badges = [];
  if (business.is_verified) badges.push('<span class="badge verified">✅ Verified</span>');
  if (business.is_featured) badges.push('<span class="badge featured">⭐ Featured</span>');

  const description = business.description || '';
  const truncatedDesc = description.length > 100 ? description.substring(0, 100) + '...' : description;
  const productCount = business.product_count || 0;
  const followerCount = business.follower_count || 0;
  const reviewCount = business.review_count || 0;

  const escapedName = business.business_name.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  return `
    <div class="business-card" data-slug="${slug}" data-name="${escapedName}" onclick="window.location.href='/business/${encodeURIComponent(slug)}'">
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
  getMarketplaceSearchQuery();
  loadBusinesses(true);
}

function filterBusinesses() {
  getMarketplaceSearchQuery();
  loadBusinesses(true);
}

function loadMoreBusinesses() {
  loadBusinesses(false);
}

// ============================================================
//  UPDATE CART BADGE
// ============================================================

function updateCartBadge() {
  const cart = typeof getCart === 'function' ? getCart() : [];
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);

  // Update sidebar badge
  const sidebarBadge = document.getElementById('sidebarCartBadge');
  if (sidebarBadge) {
    if (count > 0) {
      sidebarBadge.textContent = count;
      sidebarBadge.style.display = 'inline';
    } else {
      sidebarBadge.style.display = 'none';
    }
  }
}

// ============================================================
//  AUTH MODAL
// ============================================================

function openAuthModal(tab) {
  const modal = document.getElementById('authModal');
  if (!modal) return;

  // Restore the normal role selector after a customer-only guest-cart prompt.
  const loginBusiness = document.getElementById('loginTypeBusiness');
  const registerBusiness = document.getElementById('registerTypeBusiness');
  const guestCartActions = document.getElementById('guestCartActions');
  if (loginBusiness) loginBusiness.style.display = '';
  if (registerBusiness) registerBusiness.style.display = '';
  if (guestCartActions) guestCartActions.remove();
  modal.classList.add('active');

  if (tab === 'login') {
    document.getElementById('authLoginContainer').style.display = 'block';
    document.getElementById('authRegisterContainer').style.display = 'none';
    document.getElementById('authLoginTitle').textContent = '🔑 Login';
    document.getElementById('loginStatus').textContent = '';
    document.getElementById('loginStatus').className = 'auth-status';
  } else {
    document.getElementById('authLoginContainer').style.display = 'none';
    document.getElementById('authRegisterContainer').style.display = 'block';
    document.getElementById('authRegisterTitle').textContent = '📝 Create Account';
    document.getElementById('customerRegisterStatus').textContent = '';
    document.getElementById('customerRegisterStatus').className = 'auth-status';
    document.getElementById('businessRegisterStatus').textContent = '';
    document.getElementById('businessRegisterStatus').className = 'auth-status';
    selectRegisterType('customer');
  }
}

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  if (!modal) return;
  modal.classList.remove('active');
  modal.style.display = '';
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeAuthModal();
});

document.getElementById('authModal')?.addEventListener('click', (event) => {
  if (event.target.id === 'authModal') closeAuthModal();
});

function switchAuthTab(tab) {
  if (tab === 'login') {
    document.getElementById('authLoginContainer').style.display = 'block';
    document.getElementById('authRegisterContainer').style.display = 'none';
    document.getElementById('authLoginTitle').textContent = '🔑 Login';
  } else {
    document.getElementById('authLoginContainer').style.display = 'none';
    document.getElementById('authRegisterContainer').style.display = 'block';
    document.getElementById('authRegisterTitle').textContent = '📝 Create Account';
    selectRegisterType('customer');
  }
}

function selectLoginType(type) {
  currentLoginType = type;
  const customerBtn = document.getElementById('loginTypeCustomer');
  const businessBtn = document.getElementById('loginTypeBusiness');

  if (type === 'customer') {
    customerBtn.style.background = '#2563eb';
    customerBtn.style.color = 'white';
    businessBtn.style.background = '#e2e8f0';
    businessBtn.style.color = '#1e293b';
  } else {
    businessBtn.style.background = '#22c55e';
    businessBtn.style.color = 'white';
    customerBtn.style.background = '#e2e8f0';
    customerBtn.style.color = '#1e293b';
  }
}

function selectRegisterType(type) {
  currentRegisterType = type;
  const customerBtn = document.getElementById('registerTypeCustomer');
  const businessBtn = document.getElementById('registerTypeBusiness');

  if (type === 'customer') {
    customerBtn.style.background = '#22c55e';
    customerBtn.style.color = 'white';
    businessBtn.style.background = '#e2e8f0';
    businessBtn.style.color = '#1e293b';
    document.getElementById('customerRegisterForm').style.display = 'block';
    document.getElementById('businessRegisterForm').style.display = 'none';
  } else {
    businessBtn.style.background = '#f59e0b';
    businessBtn.style.color = 'white';
    customerBtn.style.background = '#e2e8f0';
    customerBtn.style.color = '#1e293b';
    document.getElementById('customerRegisterForm').style.display = 'none';
    document.getElementById('businessRegisterForm').style.display = 'block';

    // A.1 — Make sure categories are loaded when the business form is shown
    loadBusinessCategoriesForRegistration();
  }
}

function togglePwd(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const icon = btn.querySelector('i');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'fas fa-eye-slash';
  } else {
    input.type = 'password';
    icon.className = 'fas fa-eye';
  }
}

// ============================================================
//  CHECK USERNAME AVAILABILITY
// ============================================================

async function checkUsernameAvailability(username, type) {
  if (!username || username.length < 3) {
    const statusEl = type === 'customer'
      ? document.getElementById('customerUsernameStatus')
      : document.getElementById('businessUsernameStatus');
    if (statusEl) {
      statusEl.textContent = 'Username must be at least 3 characters';
      statusEl.style.color = '#94a3b8';
    }
    return false;
  }

  try {
    const res = await fetch(`/api/auth/check-username?username=${encodeURIComponent(username)}`);
    const data = await res.json();
    const statusEl = type === 'customer'
      ? document.getElementById('customerUsernameStatus')
      : document.getElementById('businessUsernameStatus');
    const suggestionsEl = type === 'customer'
      ? document.getElementById('customerUsernameSuggestions')
      : document.getElementById('businessUsernameSuggestions');

    if (data.available) {
      if (statusEl) {
        statusEl.textContent = '✅ Username available';
        statusEl.style.color = '#22c55e';
      }
      if (suggestionsEl) suggestionsEl.style.display = 'none';
      return true;
    } else {
      if (statusEl) {
        statusEl.textContent = '❌ Username already taken. Try one of the suggestions below:';
        statusEl.style.color = '#ef4444';
      }
      generateUsernameSuggestions(username, type);
      return false;
    }
  } catch (err) {
    console.error('Username check error:', err);
    return false;
  }
}

function generateUsernameSuggestions(base, type) {
  const suggestionsEl = type === 'customer'
    ? document.getElementById('customerUsernameSuggestions')
    : document.getElementById('businessUsernameSuggestions');

  if (!suggestionsEl) return;

  const suggestions = [
    base + Math.floor(Math.random() * 100),
    base + '_' + Math.floor(Math.random() * 1000),
    base + Math.floor(Math.random() * 1000),
    base + '_shop',
    base + '_store',
    'my_' + base,
    base + '_' + new Date().getFullYear()
  ];

  suggestionsEl.style.display = 'block';
  suggestionsEl.innerHTML = `
    <strong>Suggestions:</strong>
    ${suggestions.map(s =>
      `<span onclick="fillUsername('${s}', '${type}')" style="cursor:pointer; color:#2563eb; margin:0 4px; padding:2px 8px; background:white; border-radius:4px; border:1px solid #e2e8f0; display:inline-block; margin-bottom:4px;">${s}</span>`
    ).join('')}
  `;
}

function fillUsername(username, type) {
  const inputId = type === 'customer' ? 'regCustomerUsername' : 'regBusinessUsername';
  const input = document.getElementById(inputId);
  if (input) {
    input.value = username;
    checkUsernameAvailability(username, type);
  }
}

// ============================================================
//  HANDLE LOGIN
// ============================================================

async function handleLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const status = document.getElementById('loginStatus');
  if (!status) return;
  status.textContent = '';
  status.className = 'auth-status';

  if (!username || !password) {
    status.textContent = '❌ Username/Email and password are required.';
    status.className = 'auth-status error';
    return;
  }

  status.textContent = '⏳ Logging in...';
  status.className = 'auth-status';
  status.style.color = '#2563eb';

  try {
    let res, data;

    if (currentLoginType === 'business') {
      res = await fetch('/api/auth/business/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      data = await res.json();
    } else {
      res = await fetch('/api/auth/customer/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      data = await res.json();
    }

    if (res.ok && data.success) {
      status.textContent = '✅ Login successful!';
      status.className = 'auth-status success';
      window.customerToken = 'cookie-auth';

      if (data.role === 'business_admin' || data.business_id) {
        localStorage.setItem('businessId', data.business_id);
        localStorage.setItem('businessName', data.business_name);
        localStorage.setItem('businessSlug', data.slug || '');
        localStorage.setItem('currentUser', JSON.stringify({
          name: data.business_name,
          email: data.email,
          role: 'business_admin',
          business_id: data.business_id
        }));

        closeAuthModal();
        showToast('✅ Welcome back, ' + (data.business_name || 'Business') + '!', 'success');
        checkAuthState();
      } else {
        localStorage.setItem('currentUser', JSON.stringify(data.customer || { name: data.name, email: data.email }));
        const loginDestination = new URLSearchParams(window.location.search).get('next');
        if (loginDestination === 'cart') localStorage.setItem('postLoginDestination', 'cart');

        closeAuthModal();
        showToast('✅ Welcome back, ' + (data.customer?.name || data.name || 'User') + '!', 'success');
        checkAuthState();
        if (localStorage.getItem('postLoginDestination') === 'cart') {
          localStorage.removeItem('postLoginDestination');
          window.location.assign('/cart.html');
        }
      }
    } else {
      status.textContent = '❌ ' + (data.error || 'Invalid credentials. Please try again.');
      status.className = 'auth-status error';
    }
  } catch (err) {
    status.textContent = '❌ Network error. Please try again.';
    status.className = 'auth-status error';
    console.error('Login error:', err);
  }
}

// ============================================================
//  HANDLE CUSTOMER REGISTER
// ============================================================

async function handleCustomerRegister() {
  const username = document.getElementById('regCustomerUsername').value.trim();
  const name = document.getElementById('regCustomerName').value.trim();
  const email = document.getElementById('regCustomerEmail').value.trim();
  const phone = document.getElementById('regCustomerPhone').value.trim();
  const password = document.getElementById('regCustomerPassword').value;
  const confirm = document.getElementById('regCustomerConfirm').value;
  const status = document.getElementById('customerRegisterStatus');
  if (!status) return;
  status.textContent = '';
  status.className = 'auth-status';

  if (!username || !name || !email || !phone || !password || !confirm) {
    status.textContent = '❌ All fields are required.';
    status.className = 'auth-status error';
    return;
  }

  if (username.length < 3) {
    status.textContent = '❌ Username must be at least 3 characters.';
    status.className = 'auth-status error';
    return;
  }

  const phoneRegex = /^[0-9]{10,15}$/;
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  if (!phoneRegex.test(cleanPhone)) {
    status.textContent = '❌ Please enter a valid phone number (10-15 digits).';
    status.className = 'auth-status error';
    return;
  }

  if (password.length < 6) {
    status.textContent = '❌ Password must be at least 6 characters.';
    status.className = 'auth-status error';
    return;
  }
  if (password !== confirm) {
    status.textContent = '❌ Passwords do not match.';
    status.className = 'auth-status error';
    return;
  }

  const isAvailable = await checkUsernameAvailability(username, 'customer');
  if (!isAvailable) {
    status.textContent = '❌ Username already taken. Please choose another.';
    status.className = 'auth-status error';
    return;
  }

  status.textContent = '⏳ Creating account...';
  status.className = 'auth-status';
  status.style.color = '#2563eb';

  try {
    const res = await fetch('/api/auth/customer/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, name, email, phone: cleanPhone, password })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      status.textContent = '✅ Account created!';
      status.className = 'auth-status success';

      window.customerToken = 'cookie-auth';
      localStorage.setItem('currentUser', JSON.stringify(data.customer));
      currentUser = data.customer;

      closeAuthModal();
      showToast('✅ Welcome, ' + (data.customer.name || 'User') + '!', 'success');
      checkAuthState();
    } else {
      status.textContent = '❌ ' + (data.error || 'Registration failed');
      status.className = 'auth-status error';
    }
  } catch (err) {
    status.textContent = '❌ Network error. Please try again.';
    status.className = 'auth-status error';
    console.error('Register error:', err);
  }
}

// ============================================================
//  HANDLE BUSINESS REGISTER
//  A.4 — Validates at least one category
//  A.5 — Sends primary + additional categories to the backend
//  A.6 — Supports primary + additional categories
//  A.7 — Invalidates the cached category list on success
// ============================================================

async function handleBusinessRegister() {
  const username = document.getElementById('regBusinessUsername').value.trim();
  const businessName = document.getElementById('regBusinessName').value.trim();
  const primarySelect = document.getElementById('regBusinessPrimaryCategory');
  const primaryCategory = primarySelect ? primarySelect.value : '';
  const email = document.getElementById('regBusinessEmail').value.trim();
  const phone = document.getElementById('regBusinessPhone').value.trim();
  const location = document.getElementById('regBusinessLocation').value.trim();
  const description = document.getElementById('regBusinessDescription').value.trim();
  const password = document.getElementById('regBusinessPassword').value;
  const confirm = document.getElementById('regBusinessConfirm').value;
  const status = document.getElementById('businessRegisterStatus');
  const categoryError = document.getElementById('businessCategoryError');

  if (!status) return;
  status.textContent = '';
  status.className = 'auth-status';

  // Clear previous category error
  if (categoryError) categoryError.style.display = 'none';
  if (primarySelect) primarySelect.style.borderColor = '#d1d5db';

  // Collect additional categories (anything checked that isn't the primary)
  const additionalCategories = [];
  document.querySelectorAll('.reg-additional-category:checked').forEach(cb => {
    if (cb.value !== primaryCategory) additionalCategories.push(cb.value);
  });

  // A.4 — Category validation FIRST.
  // At least one category must be selected — either primary OR an additional one.
  const hasAnyCategory = Boolean(primaryCategory) || additionalCategories.length > 0;
  if (!hasAnyCategory) {
    if (categoryError) categoryError.style.display = 'block';
    if (primarySelect) {
      primarySelect.style.borderColor = '#ef4444';
      primarySelect.focus();
    }
    status.textContent = '❌ Please select a business category.';
    status.className = 'auth-status error';
    return;
  }

  // If the user only checked additional categories but did not pick a primary,
  // promote the first checked one to primary so the backend always gets one.
  let finalPrimary = primaryCategory;
  if (!finalPrimary && additionalCategories.length > 0) {
    finalPrimary = additionalCategories.shift();
  }

  // Check that the dropdown is actually usable (not still loading / errored)
  if (primarySelect && primarySelect.disabled && !finalPrimary) {
    status.textContent = '❌ Categories are still loading. Please wait a moment and try again.';
    status.className = 'auth-status error';
    return;
  }

  if (!username || !businessName || !email || !phone || !location || !password || !confirm) {
    status.textContent = '❌ All fields are required.';
    status.className = 'auth-status error';
    return;
  }

  if (username.length < 3) {
    status.textContent = '❌ Username must be at least 3 characters.';
    status.className = 'auth-status error';
    return;
  }

  const phoneRegex = /^[0-9]{10,15}$/;
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  if (!phoneRegex.test(cleanPhone)) {
    status.textContent = '❌ Please enter a valid phone number (10-15 digits).';
    status.className = 'auth-status error';
    return;
  }

  if (password.length < 8) {
    status.textContent = '❌ Password must be at least 8 characters.';
    status.className = 'auth-status error';
    return;
  }
  if (password !== confirm) {
    status.textContent = '❌ Passwords do not match.';
    status.className = 'auth-status error';
    return;
  }

  const isAvailable = await checkUsernameAvailability(username, 'business');
  if (!isAvailable) {
    status.textContent = '❌ Username already taken. Please choose another.';
    status.className = 'auth-status error';
    return;
  }

  status.textContent = '⏳ Creating business account...';
  status.className = 'auth-status';
  status.style.color = '#2563eb';

  const formData = new FormData();
  formData.append('business_name', businessName);
  formData.append('email', email);
  formData.append('phone', cleanPhone);
  formData.append('location', location);
  formData.append('description', description || '');
  formData.append('password', password);
  formData.append('username', username);

  // A.5 — Send the primary category and additional categories
  formData.append('category', finalPrimary);
  if (additionalCategories.length > 0) {
    formData.append('additional_categories', additionalCategories.join(','));
  }

  formData.append('mpesa_enabled', 'false');
  formData.append('airtel_enabled', 'false');
  formData.append('bank_enabled', 'true');
  formData.append('paypal_enabled', 'false');

  try {
    const res = await fetch('/api/auth/business/register', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (res.ok && data.success) {
      status.textContent = '✅ Business account created!';
      status.className = 'auth-status success';
      window.customerToken = 'cookie-auth';

      localStorage.setItem('businessId', data.business_id);
      localStorage.setItem('businessName', data.business.business_name);
      localStorage.setItem('businessSlug', data.business.slug || '');
      localStorage.setItem('currentUser', JSON.stringify({
        name: businessName,
        email: email,
        role: 'business_admin',
        business_id: data.business_id
      }));

      // A.7 — Invalidate the cached category list so the next time the form is
      // opened we refetch from the server instead of using a stale cache.
      businessCategoriesCache = null;

      // Reset the dropdowns so the next visit shows a fresh loading state.
      if (primarySelect) {
        primarySelect.value = '';
        primarySelect.style.borderColor = '#d1d5db';
      }
      document.querySelectorAll('.reg-additional-category:checked').forEach(cb => { cb.checked = false; });
      if (categoryError) categoryError.style.display = 'none';

      closeAuthModal();
      showToast('✅ Welcome, ' + businessName + '! Business created.', 'success');
      checkAuthState();
    } else {
      status.textContent = '❌ ' + (data.error || 'Registration failed');
      status.className = 'auth-status error';
    }
  } catch (err) {
    status.textContent = '❌ Network error. Please try again.';
    status.className = 'auth-status error';
    console.error('Business register error:', err);
  }
}

// ============================================================
//  SHOW TOAST
// ============================================================

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const existing = container.querySelector('.toast');
  if (existing) existing.remove();

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
  closeBtn.onclick = () => {
    toast.style.transform = 'translateX(120%)';
    setTimeout(() => toast.remove(), 300);
  };

  toast.appendChild(icon);
  toast.appendChild(text);
  toast.appendChild(closeBtn);
  container.appendChild(toast);

  setTimeout(() => {
    if (container.contains(toast)) {
      toast.style.transform = 'translateX(120%)';
      setTimeout(() => toast.remove(), 300);
    }
  }, 5000);
}

// ============================================================
//  EXPOSE FUNCTIONS GLOBALLY
// ============================================================

window.loadMarketplace = loadMarketplace;
window.searchBusinesses = searchBusinesses;
window.filterBusinesses = filterBusinesses;
window.loadMoreBusinesses = loadMoreBusinesses;
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.switchAuthTab = switchAuthTab;
window.selectLoginType = selectLoginType;
window.selectRegisterType = selectRegisterType;
window.togglePwd = togglePwd;
window.handleLogin = handleLogin;
window.handleCustomerRegister = handleCustomerRegister;
window.handleBusinessRegister = handleBusinessRegister;
window.checkUsernameAvailability = checkUsernameAvailability;
window.generateUsernameSuggestions = generateUsernameSuggestions;
window.fillUsername = fillUsername;
window.showToast = showToast;
window.loadBusinessCategoriesForRegistration = loadBusinessCategoriesForRegistration;
window.syncAdditionalCategoryOptions = syncAdditionalCategoryOptions;
window.handleAdditionalCategoryChange = handleAdditionalCategoryChange;

// ============================================================
//  CENTRAL MARKETPLACE WORKSPACE
//  Signed-in views stay on this page and are loaded as embedded panels.
// ============================================================

const MARKETPLACE_WORKSPACE = Object.freeze({
  customer: {
    kicker: 'Your BidhaaLink space',
    tabs: [
      { id: 'dashboard', label: 'Dashboard', icon: 'fa-chart-pie' },
      { id: 'profile', label: 'My Profile', icon: 'fa-user' },
      { id: 'orders', label: 'My Orders', icon: 'fa-box' },
      { id: 'addresses', label: 'Addresses', icon: 'fa-map-marker-alt' },
      { id: 'payments', label: 'Payments', icon: 'fa-credit-card' },
      { id: 'cart', label: 'Cart', icon: 'fa-shopping-cart' },
      { id: 'messages', label: 'Messages', icon: 'fa-comment' }
    ],
    bottom: []
  },
  business: {
    kicker: 'Your business command center',
    tabs: [
      { id: 'dashboard', label: 'Dashboard', icon: 'fa-chart-pie' },
      { id: 'orders', label: 'Orders', icon: 'fa-box' },
      { id: 'products', label: 'Products', icon: 'fa-tags' },
      { id: 'customers', label: 'Customers', icon: 'fa-users' },
      { id: 'messages', label: 'Messages', icon: 'fa-comment' },
      { id: 'settings', label: 'Settings', icon: 'fa-sliders-h' },
      { id: 'preview', label: 'Preview', icon: 'fa-eye' }
    ],
    bottom: []
  }
});

const BUSINESS_SETTINGS_TABS = Object.freeze([
  { id: 'profile', label: 'Business Profile' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'payments', label: 'Payments' },
  { id: 'ordersettings', label: 'Order Settings' }
]);

let workspaceSection = 'dashboard';
let workspaceSubsection = null;

function getStoredMarketplaceUser() {
  try {
    const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
    return user && typeof user === 'object' ? user : {};
  } catch (err) {
    return {};
  }
}

function isBusinessMarketplaceUser(user) {
  return user?.role === 'business_admin' || Boolean(user?.business_id);
}

function getWorkspaceRole(user) {
  return isBusinessMarketplaceUser(user) ? 'business' : 'customer';
}

async function checkAuthState() {
  const user = getStoredMarketplaceUser();
  const requestedWorkspace = new URLSearchParams(window.location.search).get('workspace');

  if (!user.email) {
    isLoggedIn = false;
    currentUser = null;
    showGuestState();
    return false;
  }

  try {
    const response = await fetch('/api/auth/verify');
    if (response.status === 401 || response.status === 403) {
      localStorage.removeItem('currentUser');
      isLoggedIn = false;
      currentUser = null;
      showGuestState();
      return false;
    }

    if (response.ok) {
      const verified = await response.json();
      if (verified.role && !user.role) {
        user.role = verified.role;
        localStorage.setItem('currentUser', JSON.stringify(user));
      }
    }
  } catch (err) {
    // Keep an existing session usable when the verification request is temporarily unavailable.
  }

  isLoggedIn = true;
  currentUser = user;
  showLoggedInState(user);
  if (requestedWorkspace) openDashboardPanel(requestedWorkspace);
  return true;
}

function showLoggedInState(user) {
  const publicNav = document.getElementById('publicNavTop');
  const loggedInNav = document.getElementById('loggedInNavTop');
  const userBadge = document.getElementById('userBadge');

  if (publicNav) publicNav.style.display = 'none';
  if (loggedInNav) loggedInNav.style.display = 'flex';
  if (userBadge) userBadge.textContent = '';

  const role = getWorkspaceRole(user);
  renderWorkspaceNavigation(role);
  const workspace = document.getElementById('integratedWorkspace');
  const divider = document.getElementById('marketplaceDivider');
  if (workspace) workspace.hidden = false;
  if (divider) divider.hidden = true;
  closeDashboardPanel({ preserveWorkspace: true });
}

function showGuestState() {
  const publicNav = document.getElementById('publicNavTop');
  const loggedInNav = document.getElementById('loggedInNavTop');
  const workspace = document.getElementById('integratedWorkspace');
  const bottomNav = document.getElementById('marketplaceBottomNav');
  const divider = document.getElementById('marketplaceDivider');
  const frame = document.getElementById('workspaceFrame');

  if (publicNav) publicNav.style.display = 'flex';
  if (loggedInNav) loggedInNav.style.display = 'none';
  if (workspace) workspace.hidden = true;
  if (bottomNav) bottomNav.hidden = true;
  if (divider) divider.hidden = true;
  if (frame) {
    frame.removeAttribute('src');
    delete frame.dataset.workspaceSource;
  }
  document.body.classList.remove('workspace-active');
  closeMobileSidebar();
}

function renderWorkspaceNavigation(role) {
  const config = MARKETPLACE_WORKSPACE[role];
  const tabs = document.getElementById('workspaceTabs');
  const bottomNav = document.getElementById('marketplaceBottomNav');
  const toggle = document.getElementById('workspaceMenuToggle');

  if (!config || !tabs || !bottomNav) return;

  tabs.replaceChildren();
  config.tabs.forEach(tab => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-tab';
    button.dataset.section = tab.id;
    button.innerHTML = `<i class="fas ${tab.icon}"></i> ${tab.label}`;
    button.addEventListener('click', () => toggleDashboardPanel(tab.id));
    tabs.appendChild(button);
  });

  bottomNav.replaceChildren();
  bottomNav.hidden = true;

  if (toggle && !toggle.dataset.bound) {
    toggle.dataset.bound = 'true';
    toggle.addEventListener('click', () => {
      const expanded = tabs.classList.toggle('is-expanded');
      toggle.setAttribute('aria-expanded', String(expanded));
    });
  }
}

function getWorkspaceTarget(role, requestedSection) {
  const config = MARKETPLACE_WORKSPACE[role];
  let section = requestedSection || 'dashboard';
  let subsection = null;

  if (role === 'business' && BUSINESS_SETTINGS_TABS.some(tab => tab.id === section)) {
    subsection = section;
    section = 'settings';
  }

  if (!config.tabs.some(tab => tab.id === section)) {
    section = 'dashboard';
  }

  if (role === 'business' && section === 'settings') {
    subsection = subsection || workspaceSubsection || 'profile';
  }

  return { section, subsection };
}

async function getWorkspaceSource(role, section, subsection) {
  if (role === 'customer') {
    if (section === 'cart') return '/cart.html?embedded=1';
    return `/account.html?embedded=1&section=${encodeURIComponent(section)}`;
  }

  if (section === 'messages') return '/seller-chat.html?embedded=1';

  if (section === 'preview') {
    let slug = localStorage.getItem('businessSlug');
    if (!slug) {
      try {
        const response = await fetch('/api/auth/my-business');
        const data = await response.json();
        slug = data.business?.slug || '';
        if (slug) localStorage.setItem('businessSlug', slug);
      } catch (err) {
        slug = '';
      }
    }
    return `/business-profile.html?embedded=1&slug=${encodeURIComponent(slug || '')}`;
  }

  const childSection = section === 'settings' ? subsection || 'profile' : section;
  return `/business-admin.html?embedded=1&section=${encodeURIComponent(childSection)}`;
}

function updateWorkspacePresentation(role, section, subsection) {
  const config = MARKETPLACE_WORKSPACE[role];
  const workspace = document.getElementById('integratedWorkspace');
  const kicker = document.getElementById('workspaceKicker');
  const title = document.getElementById('workspaceTitle');
  const divider = document.getElementById('marketplaceDivider');
  const tabs = document.getElementById('workspaceTabs');
  const subtabs = document.getElementById('workspaceSubtabs');
  const menuToggle = document.getElementById('workspaceMenuToggle');
  const activeTab = config.tabs.find(tab => tab.id === section) || config.tabs[0];

  if (workspace) workspace.hidden = false;
  if (divider) divider.hidden = true;
  if (kicker) kicker.textContent = config.kicker;
  if (title) title.textContent = activeTab.label;
  document.body.classList.add('workspace-active');

  if (tabs) {
    tabs.querySelectorAll('.workspace-tab').forEach(button => {
      const active = button.dataset.section === section;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    tabs.classList.remove('is-expanded');
  }
  if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');

  document.querySelectorAll('#marketplaceBottomNav button').forEach(button => {
    button.classList.toggle('is-active', button.dataset.section === section);
  });

  if (!subtabs) return;
  subtabs.replaceChildren();
  if (role !== 'business' || section !== 'settings') {
    subtabs.hidden = true;
    return;
  }

  BUSINESS_SETTINGS_TABS.forEach(tab => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-subtab';
    button.textContent = tab.label;
    button.classList.toggle('is-active', tab.id === subsection);
    button.addEventListener('click', () => toggleDashboardPanel(tab.id));
    subtabs.appendChild(button);
  });
  subtabs.hidden = false;
}

async function openDashboardPanel(requestedSection) {
  const user = currentUser?.email ? currentUser : getStoredMarketplaceUser();
  if (!user.email) {
    openAuthModal('login');
    return;
  }

  const role = getWorkspaceRole(user);
  const target = getWorkspaceTarget(role, requestedSection);
  const frame = document.getElementById('workspaceFrame');

  workspaceSection = target.section;
  workspaceSubsection = target.subsection;
  currentPanel = target.section;
  updateWorkspacePresentation(role, target.section, target.subsection);
  const workspace = document.getElementById('integratedWorkspace');
  if (workspace) workspace.classList.add('is-open');
  const closeButton = document.getElementById('workspaceClose');
  if (closeButton) closeButton.hidden = false;

  if (!frame) return;
  const source = await getWorkspaceSource(role, target.section, target.subsection);
  if (frame.dataset.workspaceSource !== source) {
    frame.dataset.workspaceSource = source;
    frame.src = source;
  }

  const url = new URL(window.location.href);
  url.searchParams.set('workspace', target.section === 'settings' ? target.subsection : target.section);
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function toggleDashboardPanel(requestedSection) {
  const workspace = document.getElementById('integratedWorkspace');
  const user = currentUser?.email ? currentUser : getStoredMarketplaceUser();
  const role = getWorkspaceRole(user);
  const target = getWorkspaceTarget(role, requestedSection);
  if (workspace?.classList.contains('is-open') && currentPanel === target.section && workspaceSubsection === target.subsection) {
    closeDashboardPanel();
    return;
  }
  openDashboardPanel(requestedSection);
}

function closeDashboardPanel(options = {}) {
  const workspace = document.getElementById('integratedWorkspace');
  if (workspace) {
    workspace.classList.remove('is-open');
    if (!options.preserveWorkspace) workspace.hidden = false;
  }
  const closeButton = document.getElementById('workspaceClose');
  if (closeButton) closeButton.hidden = true;
  document.body.classList.remove('workspace-active');
  currentPanel = null;
  workspaceSection = 'dashboard';
  workspaceSubsection = null;

  const url = new URL(window.location.href);
  url.searchParams.delete('workspace');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function toggleMobileSidebar() {
  const tabs = document.getElementById('workspaceTabs');
  const toggle = document.getElementById('workspaceMenuToggle');
  if (!tabs || !toggle) return;
  const expanded = tabs.classList.toggle('is-expanded');
  toggle.setAttribute('aria-expanded', String(expanded));
}

function closeMobileSidebar() {
  const tabs = document.getElementById('workspaceTabs');
  const toggle = document.getElementById('workspaceMenuToggle');
  if (tabs) tabs.classList.remove('is-expanded');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

function openBusinessPreview() {
  openDashboardPanel('preview');
}

window.addEventListener('message', event => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === 'shop-kenya-open-workspace' && event.data.section) {
    openDashboardPanel(event.data.section);
  }
});

async function handleLogout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('token');
  localStorage.removeItem('customerToken');
  localStorage.removeItem('businessId');
  localStorage.removeItem('businessName');
  localStorage.removeItem('businessSlug');
  localStorage.removeItem('currentUser');
  currentUser = null;
  isLoggedIn = false;
  workspaceSection = 'dashboard';
  workspaceSubsection = null;
  businessCategoriesCache = null;
  showGuestState();

  const url = new URL(window.location.href);
  url.searchParams.delete('workspace');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  showToast('You have been logged out.', 'info');
}

window.checkAuthState = checkAuthState;
window.openDashboardPanel = openDashboardPanel;
window.closeDashboardPanel = closeDashboardPanel;
window.toggleMobileSidebar = toggleMobileSidebar;
window.closeMobileSidebar = closeMobileSidebar;
window.openBusinessPreview = openBusinessPreview;
window.handleLogout = handleLogout;
window.updateCartBadge = updateCartBadge;

console.log('✅ Index.js loaded successfully');