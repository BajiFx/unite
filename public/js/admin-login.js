// ============================================================
//  SUPER ADMIN LOGIN / REGISTER PAGE
//  Location: public/js/admin-login.js
//
//  Behaviour:
//   1. Ask /api/auth/admin-exists.
//   2. If no super admin exists, show the Register tab first
//      so the operator can create the very first account.
//   3. If a super admin already exists, show the Login tab
//      and hide Register entirely.
//   4. On successful register or login, redirect to
//      /admin-dashboard.html.
//
//  No password is ever stored client-side.
// ============================================================

(function () {
  'use strict';

  var hasSuperAdmin = false;

  function byId(id) { return document.getElementById(id); }

  function setStatus(el, message, tone) {
    if (!el) return;
    el.textContent = message || '';
    el.className = 'status' + (tone ? ' ' + tone : '');
  }

  function togglePassword(inputId, btn) {
    var input = byId(inputId);
    if (!input) return;
    var icon = btn.querySelector('i');
    if (input.type === 'password') {
      input.type = 'text';
      icon.className = 'fas fa-eye-slash';
    } else {
      input.type = 'password';
      icon.className = 'fas fa-eye';
    }
  }
  window.togglePassword = togglePassword;

  function showTab(tab) {
    var tabLogin = byId('tabLogin');
    var tabRegister = byId('tabRegister');
    var loginForm = byId('loginForm');
    var registerForm = byId('registerForm');
    var tabs = byId('authTabs');

    if (!tabLogin || !tabRegister || !loginForm || !registerForm || !tabs) return;

    if (tab === 'register' && !hasSuperAdmin) {
      tabLogin.classList.remove('active');
      tabRegister.classList.add('active');
      loginForm.style.display = 'none';
      registerForm.style.display = 'block';
    } else {
      tabLogin.classList.add('active');
      tabRegister.classList.remove('active');
      loginForm.style.display = 'block';
      registerForm.style.display = 'none';
    }
  }
  window.showTab = showTab;

  async function checkExists() {
    var title = byId('pageTitle');
    var sub = byId('pageSub');
    var tabs = byId('authTabs');
    var loginForm = byId('loginForm');
    var registerForm = byId('registerForm');
    var tabRegister = byId('tabRegister');

    try {
      var res = await fetch('/api/auth/admin-exists', { credentials: 'same-origin', cache: 'no-store' });
      var data = await res.json();
      hasSuperAdmin = data && data.exists === true;
    } catch (err) {
      hasSuperAdmin = true; // fail closed: show login, hide register
    }

    if (hasSuperAdmin) {
      if (title) title.textContent = 'Super Admin Login';
      if (sub) sub.textContent = 'Platform administrators only';
      if (tabs) tabs.style.display = 'none';
      if (registerForm) registerForm.style.display = 'none';
      if (loginForm) loginForm.style.display = 'block';
      if (tabRegister) tabRegister.style.display = 'none';
    } else {
      if (title) title.textContent = 'Create Super Admin';
      if (sub) sub.textContent = 'First-time setup — this tab is removed once an account exists.';
      if (tabs) tabs.style.display = 'flex';
      if (tabRegister) tabRegister.style.display = 'inline-flex';
      showTab('register');
    }
  }

  async function handleRegister() {
    var email = (byId('regEmail') || {}).value || '';
    var password = (byId('regPassword') || {}).value || '';
    var confirm = (byId('regConfirm') || {}).value || '';
    var status = byId('registerStatus');
    var btn = byId('registerBtn');

    email = email.trim();

    if (!email || !password || !confirm) {
      setStatus(status, '❌ All fields are required.', 'error');
      return;
    }
    if (password.length < 6) {
      setStatus(status, '❌ Password must be at least 6 characters.', 'error');
      return;
    }
    if (password !== confirm) {
      setStatus(status, '❌ Passwords do not match.', 'error');
      return;
    }

    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Creating…'; }
    setStatus(status, '⏳ Creating super admin…', 'loading');

    try {
      var res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: email, password: password })
      });
      var data = await res.json();

      if (res.ok && data && data.success) {
        setStatus(status, '✅ Super admin created. Redirecting to dashboard…', 'success');
        setTimeout(function () {
          window.location.href = '/admin-dashboard.html';
        }, 900);
      } else {
        setStatus(status, '❌ ' + (data && data.error ? data.error : 'Registration failed.'), 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = 'Create Super Admin'; }
      }
    } catch (err) {
      setStatus(status, '❌ Network error. Please try again.', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = 'Create Super Admin'; }
    }
  }
  window.handleRegister = handleRegister;

  async function handleLogin() {
    var email = (byId('loginEmail') || {}).value || '';
    var password = (byId('loginPassword') || {}).value || '';
    var status = byId('loginStatus');
    var btn = byId('loginBtn');

    email = email.trim();

    if (!email || !password) {
      setStatus(status, '❌ Email and password are required.', 'error');
      return;
    }

    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Logging in…'; }
    setStatus(status, '⏳ Verifying credentials…', 'loading');

    try {
      var res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: email, password: password })
      });
      var data = await res.json();

      if (res.ok && data && data.success && data.role === 'super_admin') {
        setStatus(status, '✅ Login successful. Redirecting…', 'success');
        setTimeout(function () {
          window.location.href = '/admin-dashboard.html';
        }, 700);
      } else {
        setStatus(status, '❌ ' + (data && data.error ? data.error : 'Invalid credentials.'), 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = 'Login'; }
      }
    } catch (err) {
      setStatus(status, '❌ Network error. Please try again.', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = 'Login'; }
    }
  }
  window.handleLogin = handleLogin;

  // Enter key support
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var active = document.activeElement;
    if (!active || !active.tagName || active.tagName !== 'INPUT') return;
    var id = active.id || '';
    if (id === 'loginEmail' || id === 'loginPassword') {
      e.preventDefault();
      handleLogin();
    } else if (id === 'regEmail' || id === 'regPassword' || id === 'regConfirm') {
      e.preventDefault();
      handleRegister();
    }
  });

  document.addEventListener('DOMContentLoaded', checkExists);
  if (document.readyState !== 'loading') checkExists();
})();