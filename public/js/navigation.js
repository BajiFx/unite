// ============================================================
//  NAVIGATION.JS - Complete Navigation Logic
//  Location: public/js/navigation.js
// ============================================================

// ============================================================
//  NAVIGATION ITEMS DEFINITION
// ============================================================

const NAV_ITEMS = {
    HOME: { id: 'navHome', icon: 'fa-home', label: 'Home' },
    CATEGORY: { id: 'navCategory', icon: 'fa-th-large', label: 'Category' },
    MESSAGES: { id: 'navMessages', icon: 'fa-envelope', label: 'Messages' },
    CART: { id: 'navCart', icon: 'fa-shopping-cart', label: 'Cart' },
    CART_GUEST: { id: 'navCartGuest', icon: 'fa-shopping-cart', label: 'Cart' },
    ORDERS: { id: 'navOrders', icon: 'fa-box', label: 'Orders' },
    PUBLIC_PREVIEW: { id: 'navPublicPreview', icon: 'fa-eye', label: 'Preview' },
    ADMIN: { id: 'navAdmin', icon: 'fa-cog', label: 'Admin' },
    BACK_TO_MARKETPLACE: { id: 'navBackToMarketplace', icon: 'fa-arrow-left', label: 'Back' },
    LOGOUT: { id: 'navLogout', icon: 'fa-sign-out-alt', label: 'Logout' },
};

// ============================================================
//  STATE DETECTION FUNCTIONS
// ============================================================

function getUserState() {
    const token = window.customerToken;
    const user = JSON.parse(localStorage.getItem('currentUser') || '{}');

    if (!user || !user.email) {
        return { isLoggedIn: false, role: null, userId: null, businessId: null };
    }

    const role = user.role || 'customer';
    const businessId = user.business_id || localStorage.getItem('businessId');

    return {
        isLoggedIn: true,
        role: role,
        userId: user.id || null,
        businessId: businessId || null,
        user: user
    };
}

function getCurrentPage() {
    const path = window.location.pathname;

    if (path.includes('/business/')) {
        return 'business_profile';
    }

    if (path.includes('/business-profile.html')) {
        return 'business_profile';
    }

    if (path.includes('/account.html') ||
        path.includes('/cart.html') ||
        path.includes('/order-tracking.html')) {
        return 'account_page';
    }

    return 'marketplace';
}

function isViewingOwnBusiness() {
    const state = getUserState();
    if (!state.isLoggedIn || state.role !== 'business_admin') return false;

    const path = window.location.pathname;
    const slug = path.split('/business/')[1] || '';
    const userBusinessSlug = localStorage.getItem('businessSlug');

    return slug && userBusinessSlug && slug === userBusinessSlug;
}

// ============================================================
//  UPDATE HEADER AUTH BUTTONS
// ============================================================

function updateHeaderAuth(state) {
    const publicNav = document.getElementById('publicNav');
    const loggedInNav = document.getElementById('loggedInNav');
    const userDisplay = document.getElementById('userDisplay');
    const logoutBtn = document.getElementById('logoutBtn');

    if (!state.isLoggedIn) {
        if (publicNav) publicNav.style.display = 'flex';
        if (loggedInNav) loggedInNav.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'none';
    } else {
        if (publicNav) publicNav.style.display = 'none';
        if (loggedInNav) loggedInNav.style.display = 'flex';
        if (logoutBtn) logoutBtn.style.display = 'inline-flex';

        if (userDisplay) {
            const name = state.user?.name || state.user?.businessName || 'User';
            userDisplay.textContent = state.role === 'business_admin' ? `🏪 ${name}` : `👤 ${name}`;
        }
    }
}

// ============================================================
//  UPDATE BOTTOM NAVIGATION
// ============================================================

function updateBottomNav(state, page, isOwnBusiness) {
    const bottomNav = document.getElementById('bottomNav');
    const navHome = document.getElementById('navHome');
    const navCategory = document.getElementById('navCategory');
    const navMessages = document.getElementById('navMessages');
    const navCart = document.getElementById('navCart');
    const navCartGuest = document.getElementById('navCartGuest');
    const navOrders = document.getElementById('navOrders');
    const navCustomers = document.getElementById('navCustomers');
    const navPublicPreview = document.getElementById('navPublicPreview');
    const navAdmin = document.getElementById('navAdmin');
    const navBackToMarketplace = document.getElementById('navBackToMarketplace');
    const navLogout = document.getElementById('navLogout');

    const allNav = [navHome, navCategory, navMessages, navCart, navCartGuest,
                    navOrders, navCustomers, navPublicPreview, navAdmin, navBackToMarketplace, navLogout,
                    document.getElementById('navBackToDashboard')];
    allNav.forEach(el => { if (el) el.style.display = 'none'; });

    if (!state.isLoggedIn && page === 'marketplace') {
        if (bottomNav) bottomNav.style.display = 'none';
        return;
    }

    if (bottomNav) bottomNav.style.display = 'flex';

    // ============================================================
    // GUEST (Not Logged In)
    // ============================================================
    if (!state.isLoggedIn) {
        if (page === 'business_profile') {
            if (navHome) navHome.style.display = 'flex';
            if (navBackToMarketplace) navBackToMarketplace.style.display = 'flex';
            if (navCartGuest) navCartGuest.style.display = 'flex';
        }
        return;
    }

    // ============================================================
    // CUSTOMER (Logged In)
    // ============================================================
    if (state.role === 'customer') {
        if (page === 'business_profile') {
            if (navHome) navHome.style.display = 'flex';
            if (navMessages) navMessages.style.display = 'flex';
            if (navCart) navCart.style.display = 'flex';
            if (navBackToMarketplace) navBackToMarketplace.style.display = 'flex';
        } else {
            if (navMessages) navMessages.style.display = 'flex';
            if (navCart) navCart.style.display = 'flex';
        }
        return;
    }

    // ============================================================
    // BUSINESS ADMIN (Logged In)
    // ============================================================
    if (state.role === 'business_admin') {
        if (page === 'business_profile') {
            if (navHome) navHome.style.display = 'flex';
            if (navBackToMarketplace) navBackToMarketplace.style.display = 'flex';
            if (isOwnBusiness && document.getElementById('navBackToDashboard')) {
                document.getElementById('navBackToDashboard').style.display = 'flex';
            }
        } else {
            // Keep every signed-in action inside the Marketplace workspace.
            // The click handlers in index.html select the appropriate panel.
            if (navMessages) navMessages.href = '#integratedWorkspace';
            if (navOrders) navOrders.href = '#integratedWorkspace';
            if (navCustomers) navCustomers.href = '#integratedWorkspace';
            if (navMessages) navMessages.style.display = 'flex';
            if (navOrders) navOrders.style.display = 'flex';
            if (navCustomers) navCustomers.style.display = 'flex';
            if (navPublicPreview) navPublicPreview.style.display = 'flex';
        }
        return;
    }
}

// ============================================================
//  BUSINESS PROFILE SPECIFIC NAVIGATION
//  This function does NOT call updateNavigation() to avoid loops
// ============================================================

function updateBusinessProfileNav() {
    updateNavigation();
}

// ============================================================
//  MAIN NAVIGATION UPDATE FUNCTION (FIXED)
//  REMOVED: updateBusinessProfileNav() call to prevent infinite loop
// ============================================================

function updateNavigation() {
    console.log('🔄 Updating navigation...');

    const state = getUserState();
    const page = getCurrentPage();
    const isOwnBusiness = isViewingOwnBusiness();

    updateHeaderAuth(state);
    updateBottomNav(state, page, isOwnBusiness);

    // FIXED: Removed the line that called updateBusinessProfileNav()
    // This was causing the infinite loop

    if (typeof updateCartBadge === 'function') {
        updateCartBadge();
    }

    console.log('✅ Navigation updated - State:', state.isLoggedIn ? 'Logged In' : 'Guest', 'Role:', state.role);
}

// ============================================================
//  EXPOSE FUNCTIONS GLOBALLY
// ============================================================

window.updateNavigation = updateNavigation;
window.updateBusinessProfileNav = updateBusinessProfileNav;
window.getUserState = getUserState;
window.getCurrentPage = getCurrentPage;
window.isViewingOwnBusiness = isViewingOwnBusiness;

console.log('✅ Navigation.js loaded successfully');
