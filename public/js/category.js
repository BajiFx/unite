// ============================================================
//  CATEGORY PAGE JAVASCRIPT - Business Categories Only
//  Location: public/js/category.js
// ============================================================

// ============================================================
//  TOAST
// ============================================================
function showToast(message, type) {
    const existing = document.querySelector('.toast-container');
    if (existing) existing.remove();
    const container = document.createElement('div');
    container.className = 'toast-container';
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = document.createElement('span');
    icon.innerHTML = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
    icon.style.fontSize = '1.2rem';
    const text = document.createElement('span');
    text.textContent = message;
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = 'background:none;border:none;color:white;font-size:1rem;cursor:pointer;margin-left:auto;opacity:0.7;';
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
    }, 4000);
}

// ============================================================
//  LOAD BUSINESS CATEGORIES (Not Product Categories)
// ============================================================

async function loadBusinessCategories() {
    const container = document.getElementById('categoryGrid');
    if (!container) return;

    try {
        const res = await fetch('/api/businesses/categories/all');
        if (!res.ok) throw new Error('Failed to load categories');
        const categories = await res.json();

        if (!categories || categories.length === 0) {
            container.innerHTML = `
                <p class="no-categories-msg" style="grid-column:1/-1; color:#94a3b8; text-align:center; padding:20px;">
                    No business categories available yet.
                </p>
            `;
            return;
        }

        // Icons for different business categories
        const icons = ['🏪', '👗', '🔧', '📱', '🍕', '🏠', '💊', '💄', '📚', '⚽', '🚗', '🛠️', '📦'];

        container.innerHTML = categories.map((cat, i) => {
            const icon = cat.icon || icons[i % icons.length] || '🏪';
            // Get count of businesses in this category
            const count = cat.business_count || 0;
            return `
                <div class="category-card" onclick="navigateToBusinessesByCategory('${cat.id}')">
                    <div class="icon">${icon}</div>
                    <div class="name">${cat.name}</div>
                    <div class="count">${count} business${count !== 1 ? 'es' : ''}</div>
                </div>
            `;
        }).join('');

    } catch (err) {
        console.error('❌ Error loading business categories:', err);
        container.innerHTML = `
            <p class="no-categories-msg" style="grid-column:1/-1; color:#ef4444; text-align:center; padding:20px;">
                Error loading categories: ${err.message}
            </p>
        `;
        showToast('Failed to load categories', 'error');
    }
}

// ============================================================
//  NAVIGATE TO BUSINESSES BY CATEGORY
// ============================================================

function navigateToBusinessesByCategory(categoryId) {
    // Redirect to marketplace with category filter
    window.location.href = `/?category=${categoryId}`;
}

// ============================================================
//  AUTH FUNCTIONS
// ============================================================

function openAuthModal(tab = 'login') {
    const modal = document.getElementById('authModal');
    if (!modal) return;
    modal.classList.add('active');
    switchAuthTab(tab);
}
window.openAuthModal = openAuthModal;

function closeAuthModal() {
    const modal = document.getElementById('authModal');
    if (!modal) return;
    modal.classList.remove('active');
}
window.closeAuthModal = closeAuthModal;

function switchAuthTab(tab) {
    const loginForm = document.getElementById('authLoginForm');
    const registerForm = document.getElementById('authRegisterForm');
    const title = document.getElementById('authModalTitle');
    if (!loginForm || !registerForm || !title) return;
    if (tab === 'login') {
        loginForm.style.display = 'block';
        registerForm.style.display = 'none';
        title.textContent = '🔑 Login';
    } else {
        loginForm.style.display = 'none';
        registerForm.style.display = 'block';
        title.textContent = '📝 Create Account';
    }
}
window.switchAuthTab = switchAuthTab;

function toggleAuthPwd(inputId, btn) {
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
window.toggleAuthPwd = toggleAuthPwd;

// ============================================================
//  HANDLE AUTH LOGIN
// ============================================================

async function handleAuthLogin() {
    const email = document.getElementById('authLoginEmail').value.trim();
    const password = document.getElementById('authLoginPassword').value;
    const status = document.getElementById('authLoginStatus');
    if (!status) return;
    status.textContent = '';

    if (!email || !password) {
        status.textContent = '❌ Email and password are required.';
        status.style.color = '#ef4444';
        return;
    }

    status.textContent = '⏳ Logging in...';
    status.style.color = '#2563eb';

    try {
        const res = await fetch('/api/auth/customer/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();

        if (res.ok) {
            status.textContent = '✅ Logged in! Redirecting...';
            status.style.color = '#16a34a';

            window.customerToken = 'cookie-auth';
            localStorage.setItem('currentUser', JSON.stringify(data.customer));
            window.currentUser = data.customer;

            closeAuthModal();

            if (typeof showToast === 'function') {
                showToast('✅ Welcome back, ' + (data.customer.name || 'User') + '!', 'success');
            }

            setTimeout(() => {
                window.location.href = '/account.html';
            }, 1000);

        } else {
            status.textContent = '❌ ' + (data.error || 'Login failed');
            status.style.color = '#ef4444';
        }
    } catch (err) {
        status.textContent = '❌ Network error. Please try again.';
        status.style.color = '#ef4444';
        console.error('Login error:', err);
    }
}
window.handleAuthLogin = handleAuthLogin;

// ============================================================
//  HANDLE AUTH REGISTER
// ============================================================

async function handleAuthRegister() {
    const name = document.getElementById('authRegName').value.trim();
    const email = document.getElementById('authRegEmail').value.trim();
    const phone = document.getElementById('authRegPhone').value.trim();
    const password = document.getElementById('authRegPassword').value;
    const confirm = document.getElementById('authRegConfirm').value;
    const status = document.getElementById('authRegisterStatus');
    if (!status) return;
    status.textContent = '';

    if (!name || !email || !phone || !password || !confirm) {
        status.textContent = '❌ All fields are required.';
        status.style.color = '#ef4444';
        return;
    }

    const phoneRegex = /^[0-9]{10,15}$/;
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    if (!phoneRegex.test(cleanPhone)) {
        status.textContent = '❌ Please enter a valid phone number (10-15 digits).';
        status.style.color = '#ef4444';
        return;
    }

    if (password.length < 6) {
        status.textContent = '❌ Password must be at least 6 characters.';
        status.style.color = '#ef4444';
        return;
    }
    if (password !== confirm) {
        status.textContent = '❌ Passwords do not match.';
        status.style.color = '#ef4444';
        return;
    }

    status.textContent = '⏳ Creating account...';
    status.style.color = '#2563eb';

    try {
        const res = await fetch('/api/auth/customer/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, phone: cleanPhone, password })
        });
        const data = await res.json();

        if (res.ok) {
            status.textContent = '✅ Account created! Logging in...';
            status.style.color = '#16a34a';

            window.customerToken = 'cookie-auth';
            localStorage.setItem('currentUser', JSON.stringify(data.customer));
            window.currentUser = data.customer;

            closeAuthModal();

            if (typeof showToast === 'function') {
                showToast('✅ Welcome, ' + (data.customer.name || 'User') + '! Account created.', 'success');
            }

            setTimeout(() => {
                window.location.href = '/account.html';
            }, 1500);

        } else {
            status.textContent = '❌ ' + (data.error || 'Registration failed');
            status.style.color = '#ef4444';
        }
    } catch (err) {
        status.textContent = '❌ Network error. Please try again.';
        status.style.color = '#ef4444';
        console.error('Register error:', err);
    }
}
window.handleAuthRegister = handleAuthRegister;

// ============================================================
//  INIT
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('📄 Category page loaded - Business Categories only');
    loadBusinessCategories();

    // Load shop name
    const nameHeader = document.getElementById('shopNameHeader');
    if (nameHeader) {
        fetch('/api/shop')
            .then(res => res.json())
            .then(shop => {
                nameHeader.textContent = shop.name || 'Shop Kenya';
            })
            .catch(() => {});
    }
});

console.log('✅ Category.js loaded successfully');

// ============================================================
//  OFFSET THE PINNED FOOTER ABOVE THE BOTTOM NAV
//  On pages that carry a `.bottom-nav`, lift the pinned footer
//  so it sits above the nav, and increase the body padding so
//  page content is not covered.
// ============================================================
(function () {
  function offsetFooterAboveBottomNav() {
    var footer = document.querySelector('footer.bidhaa-legal-footer');
    var bottomNav = document.querySelector('.bottom-nav');
    if (!footer || !bottomNav) return;

    // Skip if the bottom nav is hidden (e.g. in embedded mode).
    var navStyle = window.getComputedStyle(bottomNav);
    if (navStyle.display === 'none' || navStyle.visibility === 'hidden') return;

    var navHeight = bottomNav.getBoundingClientRect().height || 64;

    footer.style.bottom = navHeight + 'px';
    document.body.style.paddingBottom = (navHeight + 64) + 'px';
  }

  document.addEventListener('DOMContentLoaded', offsetFooterAboveBottomNav);
  window.addEventListener('resize', offsetFooterAboveBottomNav);
  window.addEventListener('orientationchange', offsetFooterAboveBottomNav);
  [300, 1200, 2000].forEach(function (ms) {
    setTimeout(offsetFooterAboveBottomNav, ms);
  });
})();

// ============================================================
//  FORCE THE PINNED FOOTER
//  Overrides any old inline footer stylesheet on this page so
//  the footer is pinned, sits above the bottom nav, and lays
//  out as three cells (brand | thank-you | legal links).
// ============================================================
(function () {
  function forcePinnedFooter() {
    var footer = document.querySelector('footer.bidhaa-legal-footer');
    if (!footer) return;

    var navHeight = 0;
    var bottomNav = document.querySelector('.bottom-nav');
    if (bottomNav) {
      var navStyle = window.getComputedStyle(bottomNav);
      if (navStyle.display !== 'none' && navStyle.visibility !== 'hidden') {
        navHeight = bottomNav.getBoundingClientRect().height || 0;
      }
    }

    footer.style.position = 'fixed';
    footer.style.left = '0';
    footer.style.right = '0';
    footer.style.bottom = navHeight + 'px';
    footer.style.zIndex = '1100';
    footer.style.margin = '0';
    footer.style.padding = '0';
    footer.style.background = '#0f172a';
    footer.style.color = '#94a3b8';
    footer.style.borderTop = '1px solid rgba(148, 163, 184, 0.18)';
    footer.style.boxShadow = '0 -6px 18px rgba(15, 23, 42, 0.18)';

    var inner = footer.querySelector('.bidhaa-legal-footer-inner');
    if (inner) {
      inner.style.maxWidth = '1400px';
      inner.style.margin = '0 auto';
      inner.style.padding = '8px 20px';
      inner.style.display = 'grid';
      inner.style.gridTemplateColumns = 'auto 1fr auto';
      inner.style.alignItems = 'center';
      inner.style.gap = '20px';
      inner.style.minHeight = '56px';
      inner.style.flexWrap = 'nowrap';
    }

    var brand = footer.querySelector('.bidhaa-legal-footer-brand');
    if (brand) {
      brand.style.display = 'flex';
      brand.style.flexDirection = 'column';
      brand.style.gap = '1px';
      brand.style.whiteSpace = 'nowrap';
    }

    var links = footer.querySelector('.bidhaa-legal-footer-links');
    if (links) {
      links.style.display = 'flex';
      links.style.gap = '16px';
      links.style.flexWrap = 'nowrap';
      links.style.whiteSpace = 'nowrap';
    }

    document.body.style.paddingBottom = (navHeight + 72) + 'px';
  }

  document.addEventListener('DOMContentLoaded', forcePinnedFooter);
  window.addEventListener('resize', forcePinnedFooter);
  window.addEventListener('orientationchange', forcePinnedFooter);
  [300, 900, 2000, 4000].forEach(function (ms) {
    setTimeout(forcePinnedFooter, ms);
  });
})();