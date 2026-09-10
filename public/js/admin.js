// ============================================================
//  ADMIN PANEL - FIXED REDIRECT
//  Location: public/js/admin.js
// ============================================================

(function() {
    console.log('🔐 Admin panel loading...');

    // Verify the HttpOnly auth cookie is valid.
    const token = '';
    fetch('/api/auth/verify', {
        headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => {
        if (res.status === 401) {
            window.location.href = '/admin.html';
            return;
        }
        if (!res.ok) throw new Error('Verification failed');
        return res.json();
    })
    .then(data => {
        if (data && data.authenticated) {
            console.log('✅ Admin authenticated, redirecting to dashboard...');
            // Redirect to admin-orders page (which is working)
            window.location.href = '/admin-orders.html';
        } else {
            window.location.href = '/admin.html';
        }
    })
    .catch(() => {
        window.location.href = '/admin.html';
    });
})();