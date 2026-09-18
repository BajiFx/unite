// ============================================================
//  SUPER ADMIN BOOTSTRAP
//  Location: public/js/admin.js
//
//  Purpose:
//   This file is loaded by admin-dashboard.html. It runs before
//   admin-dashboard.js and does exactly one job: confirm the
//   visitor is a super admin.
//
//   - If the visitor is NOT authenticated, redirect to
//     /admin.html (the login page).
//   - If the visitor IS authenticated but is NOT a super admin
//     (customer or business_admin), redirect to /admin.html.
//   - If the visitor IS a super admin, reveal #adminPanel and
//     call window.loadAdminDashboard() so the dashboard starts
//     loading immediately.
//
//  Auth state comes from the HttpOnly cookie set by
//  /api/auth/login. The server is the source of truth; this
//  file only reacts to what the server says.
// ============================================================

(function () {
    'use strict';

    console.log('🔐 Super admin bootstrap starting...');

    fetch('/api/auth/verify', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store'
    })
        .then(function (response) {
            if (response.status === 401 || response.status === 403) {
                console.warn('❌ Not authenticated. Redirecting to login.');
                window.location.replace('/admin.html');
                return null;
            }
            if (!response.ok) {
                throw new Error('Verification failed with status ' + response.status);
            }
            return response.json();
        })
        .then(function (data) {
            if (!data) return; // already redirected

            if (!data.authenticated) {
                console.warn('❌ Session not authenticated. Redirecting to login.');
                window.location.replace('/admin.html');
                return;
            }

            var role = data.role || null;
            if (role !== 'super_admin') {
                console.warn('❌ Role "' + role + '" is not super_admin. Redirecting to login.');
                window.location.replace('/admin.html');
                return;
            }

            console.log('✅ Super admin verified. Revealing dashboard.');

            var panel = document.getElementById('adminPanel');
            if (panel) {
                panel.classList.add('visible');
            }

            function startDashboard() {
                if (typeof window.loadAdminDashboard === 'function') {
                    window.loadAdminDashboard();
                } else {
                    console.warn('⚠️ loadAdminDashboard() not ready yet; waiting for DOMContentLoaded.');
                    document.addEventListener('DOMContentLoaded', function () {
                        if (typeof window.loadAdminDashboard === 'function') {
                            window.loadAdminDashboard();
                        } else {
                            console.error('❌ loadAdminDashboard() is still not available. Check that admin-dashboard.js is loaded after this file.');
                        }
                    }, { once: true });
                }
            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', startDashboard, { once: true });
            } else {
                startDashboard();
            }
        })
        .catch(function (err) {
            console.error('❌ Bootstrap error:', err);
            window.location.replace('/admin.html');
        });
})();