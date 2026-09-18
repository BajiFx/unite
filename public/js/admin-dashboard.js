// ============================================================
//  SUPER ADMIN DASHBOARD
//  Location: public/js/admin-dashboard.js
//
//  Loaded by admin-dashboard.html, right after admin.js.
//
//  admin.js is the gatekeeper: it verifies the super admin
//  session and reveals #adminPanel. This file is the renderer:
//  it fills the compact stat grid, the attention row, the
//  customers table, the businesses table, the violations table,
//  the complaints inbox, and the collapsible sections, and it
//  wires the Suspend / Activate / Delete buttons on every row
//  plus the "Record Violation" form and the "Reply / Escalate"
//  flow on every complaint.
//
//  Endpoints used:
//    GET    /api/admin/dashboard
//    GET    /api/admin/customers
//    GET    /api/admin/businesses
//    GET    /api/admin/violations
//    GET    /api/admin/violations/for/:type/:id
//    GET    /api/admin/violations/:id
//    POST   /api/admin/violations
//    PUT    /api/admin/violations/:id
//    DELETE /api/admin/violations/:id
//    GET    /api/admin/messages/counts
//    GET    /api/admin/messages
//    GET    /api/admin/messages/:id
//    PUT    /api/admin/messages/:id/read
//    POST   /api/admin/messages/:id/reply
//    POST   /api/admin/messages/:id/escalate
//    PUT    /api/admin/messages/:id/close
//    DELETE /api/admin/messages/:id
//    PUT    /api/admin/customers/:id/status     { is_active }
//    PUT    /api/admin/businesses/:id/status    { is_active }
//    DELETE /api/admin/customers/:id
//    DELETE /api/admin/businesses/:id
//
//  All requests use credentials: 'same-origin' so the HttpOnly
//  auth cookie is sent. There is no token in JavaScript.
// ============================================================

(function () {
    'use strict';

    // ============================================================
    //  STATE
    // ============================================================

    var adminCustomers  = [];
    var adminBusinesses = [];
    var adminViolations = [];
    var adminMessages   = [];

    var violationFilters = {
        kind: '',
        subject_type: '',
        status: '',
        severity: '',
        search: ''
    };

    var messageFilters = {
        status: '',
        sender_type: '',
        search: ''
    };

    var openSection = null;
    var openComplaintId = null;

    // ============================================================
    //  SMALL HELPERS
    // ============================================================

    function escapeHtml(value) {
        var div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    function escapeAttr(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function formatDate(value) {
        if (!value) return '—';
        var d = new Date(value);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatNumber(value) {
        var n = Number(value);
        if (!isFinite(n)) return '0';
        return n.toLocaleString();
    }

    function formatMoney(value) {
        var n = Number(value);
        if (!isFinite(n)) return 'Ksh 0';
        return 'Ksh ' + n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    }

    function setDashboardStatus(message, tone) {
        var el = document.getElementById('dashboardStatus');
        if (!el) return;
        el.textContent = message || '';
        el.className = 'status-message' + (tone ? ' ' + tone : '');
    }

    function severityClass(severity) {
        var s = String(severity || 'medium').toLowerCase();
        if (s === 'critical') return 'severity-critical';
        if (s === 'high')     return 'severity-high';
        if (s === 'low')      return 'severity-low';
        return 'severity-medium';
    }

    function statusClass(status) {
        var s = String(status || 'pending').toLowerCase();
        if (s === 'resolved')     return 'state-pill active';
        if (s === 'dismissed')    return 'state-pill suspended';
        if (s === 'under_review') return 'state-pill warning';
        if (s === 'escalated')    return 'state-pill critical';
        return 'state-pill pending';
    }

    function messageStatusClass(status) {
        var s = String(status || 'unread').toLowerCase();
        if (s === 'unread')   return 'state-pill pending';
        if (s === 'read')     return 'state-pill warning';
        if (s === 'replied')  return 'state-pill active';
        if (s === 'escalated')return 'state-pill critical';
        if (s === 'closed')   return 'state-pill suspended';
        return 'state-pill';
    }

    // ============================================================
    //  COMPACT STAT GRID (Top row)
    // ============================================================

    function renderTopStats(stats) {
        var grid = document.getElementById('adminStatsGrid');
        if (!grid) return;

        var top = stats.top || {};
        var attention = stats.attention || {};

        var cards = [
            {
                key: 'businesses_active',
                label: 'Businesses',
                icon: 'fa-store',
                value: formatNumber(top.businesses_active || 0),
                cls: 'compact-stat',
                filter: 'all'
            },
            {
                key: 'customers_active',
                label: 'Customers',
                icon: 'fa-users',
                value: formatNumber(top.customers_active || 0),
                cls: 'compact-stat',
                filter: 'all'
            },
            {
                key: 'products_active',
                label: 'Products',
                icon: 'fa-tags',
                value: formatNumber(top.products_active || 0),
                cls: 'compact-stat',
                filter: 'all'
            },
            {
                key: 'orders_this_month',
                label: 'Orders (mo)',
                icon: 'fa-shopping-bag',
                value: formatNumber(top.orders_this_month || 0),
                cls: 'compact-stat',
                filter: 'all'
            },
            {
                key: 'revenue_this_month',
                label: 'Revenue (mo)',
                icon: 'fa-coins',
                value: formatMoney(top.revenue_this_month || 0),
                cls: 'compact-stat revenue'
            },
            {
                key: 'pending_violations',
                label: 'Violations',
                icon: 'fa-exclamation-triangle',
                value: formatNumber(top.pending_violations || 0),
                cls: 'compact-stat attention',
                section: 'violations'
            },
            {
                key: 'pending_claims',
                label: 'Claims',
                icon: 'fa-gavel',
                value: formatNumber(attention.pending_claims || 0),
                cls: 'compact-stat attention',
                section: 'violations'
            },
            {
                key: 'scheduled_deletions',
                label: 'Deletions',
                icon: 'fa-user-times',
                value: formatNumber(attention.scheduled_deletions || 0),
                cls: 'compact-stat attention'
            },
            {
                key: 'pending_category_requests',
                label: 'Category Req',
                icon: 'fa-list-alt',
                value: formatNumber(attention.pending_category_requests || 0),
                cls: 'compact-stat attention'
            },
            {
                key: 'pending_returns',
                label: 'Returns',
                icon: 'fa-rotate-left',
                value: formatNumber(attention.pending_returns || 0),
                cls: 'compact-stat attention'
            },
            {
                key: 'failed_payments_7d',
                label: 'Failed Pay (7d)',
                icon: 'fa-credit-card',
                value: formatNumber(attention.failed_payments_7d || 0),
                cls: 'compact-stat attention'
            }
        ];

        grid.innerHTML = cards.map(function (card) {
            var clickable = card.section ? 'data-section="' + escapeAttr(card.section) + '" style="cursor:pointer;"' : '';
            return ''
                + '<div class="' + card.cls + '" ' + clickable + '>'
                    + '<i class="fas ' + card.icon + '"></i>'
                    + '<div class="compact-stat-text">'
                        + '<strong>' + card.value + '</strong>'
                        + '<span>' + escapeHtml(card.label) + '</span>'
                    + '</div>'
                + '</div>';
        }).join('');

        grid.querySelectorAll('[data-section]').forEach(function (el) {
            el.addEventListener('click', function () {
                toggleAdminSection(el.getAttribute('data-section'));
            });
        });

        // Badges block (unread complaints, totals)
        var badges = stats.badges || {};
        var badgeHost = document.getElementById('adminBadges');
        if (badgeHost) {
            badgeHost.innerHTML = ''
                + '<span class="admin-badge">'
                    + '<i class="fas fa-envelope"></i> '
                    + formatNumber(badges.unread_complaints || 0) + ' unread'
                + '</span>'
                + '<span class="admin-badge">'
                    + '<i class="fas fa-users"></i> '
                    + formatNumber(badges.total_customers || 0) + ' customers'
                + '</span>'
                + '<span class="admin-badge">'
                    + '<i class="fas fa-store"></i> '
                    + formatNumber(badges.total_businesses || 0) + ' businesses'
                + '</span>'
                + '<span class="admin-badge">'
                    + '<i class="fas fa-exclamation-triangle"></i> '
                    + formatNumber(badges.total_violations || 0) + ' violations'
                + '</span>';
        }
    }

    // ============================================================
    //  SECTION TOGGLE (collapsible panels)
    // ============================================================

    function toggleAdminSection(name) {
        if (!name) return;

        if (openSection === name) {
            closeAllAdminSections();
            return;
        }

        closeAllAdminSections();
        openSection = name;

        var section = document.getElementById(name + 'Section');
        if (section) {
            section.hidden = false;
            section.classList.add('is-open');

            var header = section.querySelector('.superadmin-list-header');
            if (header) {
                var btn = header.querySelector('[data-toggle]');
                if (btn) btn.setAttribute('aria-expanded', 'true');
            }
        }

        if (name === 'customers')  loadAdminCustomers();
        if (name === 'businesses') loadAdminBusinesses();
        if (name === 'violations') loadAdminViolations();
        if (name === 'messages')   loadAdminMessages();
    }

    function closeAllAdminSections() {
        openSection = null;
        ['customers', 'businesses', 'violations', 'messages'].forEach(function (name) {
            var section = document.getElementById(name + 'Section');
            if (section) {
                section.hidden = true;
                section.classList.remove('is-open');
                var btn = section.querySelector('[data-toggle]');
                if (btn) btn.setAttribute('aria-expanded', 'false');
            }
        });
    }

    function wireSectionToggles() {
        document.querySelectorAll('[data-toggle]').forEach(function (btn) {
            if (btn.dataset.wired === 'true') return;
            btn.dataset.wired = 'true';
            btn.addEventListener('click', function () {
                toggleAdminSection(btn.getAttribute('data-toggle'));
            });
        });
    }

    // ============================================================
    //  MAIN ENTRY POINT
    // ============================================================

    async function loadAdminDashboard() {
        setDashboardStatus('', '');
        var grid = document.getElementById('adminStatsGrid');
        if (grid) {
            grid.innerHTML = '<p style="grid-column:1/-1; color:#94a3b8;">Loading live statistics...</p>';
        }

        try {
            var response = await fetch('/api/admin/dashboard', {
                credentials: 'same-origin',
                cache: 'no-store'
            });

            if (response.status === 401 || response.status === 403) {
                window.location.replace('/admin.html');
                return;
            }
            if (!response.ok) {
                throw new Error('Request failed (' + response.status + ')');
            }

            var stats = await response.json();
            renderTopStats(stats);
            setDashboardStatus('Updated ' + new Date().toLocaleTimeString(), 'success');
        } catch (error) {
            console.error('Dashboard stats error:', error);
            if (grid) {
                grid.innerHTML = '<p class="error-text" style="grid-column:1/-1;">Unable to load dashboard statistics.</p>';
            }
            setDashboardStatus(error.message, 'error');
        }

        wireSectionToggles();
        wireSearchInputs();

        // Preload the two most used sections so their counts land
        // on the collapsible card headers.
        await Promise.all([
            loadAdminCustomers(),
            loadAdminBusinesses()
        ]);
    }

    // ============================================================
    //  CUSTOMERS
    // ============================================================

    async function loadAdminCustomers() {
        var tbody = document.getElementById('customersTableBody');
        var badge = document.getElementById('customersCountBadge');
        if (!tbody) return;

        tbody.innerHTML = '' +
            '<tr><td colspan="6"><div class="superadmin-empty">' +
                '<i class="fas fa-spinner fa-spin"></i> Loading customers...' +
            '</div></td></tr>';

        try {
            var response = await fetch('/api/admin/customers', {
                credentials: 'same-origin',
                cache: 'no-store'
            });

            if (response.status === 401 || response.status === 403) {
                window.location.replace('/admin.html');
                return;
            }
            if (!response.ok) throw new Error('Failed to load customers (' + response.status + ')');

            var list = await response.json();
            adminCustomers = Array.isArray(list) ? list : [];

            renderCustomers(adminCustomers);

            if (badge) badge.textContent = String(adminCustomers.length);
        } catch (error) {
            console.error('Load customers error:', error);
            tbody.innerHTML = '' +
                '<tr><td colspan="6"><div class="superadmin-error">' +
                    'Unable to load customers: ' + escapeHtml(error.message) +
                '</div></td></tr>';
            if (badge) badge.textContent = '0';
        }
    }

    function renderCustomers(list) {
        var tbody = document.getElementById('customersTableBody');
        if (!tbody) return;

        var search = (document.getElementById('customersSearch')?.value || '').trim().toLowerCase();
        var filtered = list;

        if (search) {
            filtered = list.filter(function (c) {
                var haystack = (
                    String(c.name || '') + ' ' +
                    String(c.email || '') + ' ' +
                    String(c.phone || '')
                ).toLowerCase();
                return haystack.indexOf(search) !== -1;
            });
        }

        if (filtered.length === 0) {
            tbody.innerHTML = '' +
                '<tr><td colspan="6"><div class="superadmin-empty">' +
                    '<i class="fas fa-users"></i>' +
                    (list.length === 0 ? 'No customers yet.' : 'No customers match your search.') +
                '</div></td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(function (c) {
            var isActive = c.is_active !== false;
            var rowClass = isActive ? '' : 'is-inactive';
            var statePill = isActive
                ? '<span class="state-pill active">● Active</span>'
                : '<span class="state-pill suspended">● Suspended</span>';

            var violationsCount = Number(c.pending_violations || 0);
            var violationsHint = violationsCount > 0
                ? '<span class="state-pill warning" style="margin-left:6px;" title="Pending violations">⚠️ ' + violationsCount + '</span>'
                : '';

            return '' +
                '<tr class="' + rowClass + '">' +
                    '<td>' +
                        '<span class="row-name">' + escapeHtml(c.name || 'Unnamed customer') + '</span>' +
                        '<span class="row-sub">ID: ' + escapeHtml(c.id) + '</span>' +
                    '</td>' +
                    '<td>' +
                        escapeHtml(c.email || '—') +
                        '<span class="row-sub">' + escapeHtml(c.phone || '—') + '</span>' +
                    '</td>' +
                    '<td>' + formatNumber(c.order_count || 0) + '</td>' +
                    '<td>' + statePill + violationsHint + '</td>' +
                    '<td>' + escapeHtml(formatDate(c.created_at)) + '</td>' +
                    '<td>' +
                        '<div class="row-actions">' +
                            '<button type="button" class="btn-view" onclick="viewCustomerViolations(' + c.id + ')"><i class="fas fa-eye"></i> Violations</button>' +
                            (isActive
                                ? '<button type="button" class="btn-suspend" onclick="suspendCustomer(' + c.id + ')"><i class="fas fa-pause"></i> Suspend</button>'
                                : '<button type="button" class="btn-activate" onclick="activateCustomer(' + c.id + ')"><i class="fas fa-play"></i> Activate</button>') +
                            '<button type="button" class="btn-delete" onclick="deleteCustomer(' + c.id + ', \'' + escapeAttr(c.name || '') + '\')"><i class="fas fa-trash"></i> Delete</button>' +
                        '</div>' +
                    '</td>' +
                '</tr>';
        }).join('');
    }

    async function fetchPendingViolationsFor(type, id) {
        try {
            var response = await fetch(
                '/api/admin/violations/for/' + encodeURIComponent(type) + '/' + encodeURIComponent(id),
                { credentials: 'same-origin', cache: 'no-store' }
            );
            if (!response.ok) return [];
            var data = await response.json();
            var list = Array.isArray(data.violations) ? data.violations : [];
            return list.filter(function (v) {
                return v.status === 'pending' || v.status === 'under_review';
            });
        } catch (err) {
            return [];
        }
    }

    async function suspendCustomer(id) {
        var pending = await fetchPendingViolationsFor('customer', id);

        var confirmMessage = 'Suspend this customer? They will not be able to log in until you activate them again.';
        if (pending.length > 0) {
            confirmMessage = 'This customer has ' + pending.length + ' pending violation(s):\n\n'
                + pending.slice(0, 5).map(function (v) {
                    return '• ' + (v.title || v.category || 'Violation') + ' (' + (v.severity || 'medium') + ')';
                }).join('\n')
                + '\n\nSuspend anyway?';
        }

        if (!confirm(confirmMessage)) return;

        try {
            var response = await fetch('/api/admin/customers/' + encodeURIComponent(id) + '/status', {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_active: false })
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ('Request failed (' + response.status + ')'));
            }
            await loadAdminCustomers();
        } catch (error) {
            console.error('Suspend customer error:', error);
            alert('Could not suspend this customer: ' + error.message);
        }
    }

    async function activateCustomer(id) {
        try {
            var response = await fetch('/api/admin/customers/' + encodeURIComponent(id) + '/status', {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_active: true })
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ('Request failed (' + response.status + ')'));
            }
            await loadAdminCustomers();
        } catch (error) {
            console.error('Activate customer error:', error);
            alert('Could not activate this customer: ' + error.message);
        }
    }

    async function deleteCustomer(id, name) {
        var label = name ? ('"' + name + '"') : ('customer #' + id);
        var pending = await fetchPendingViolationsFor('customer', id);

        var confirmMessage = 'Permanently delete ' + label + '?\n\n'
            + 'This removes the customer, their cart, wishlist, addresses, reviews, '
            + 'returns, payments, notifications, and location requests. '
            + 'Their past orders will be deleted as well.\n\n'
            + 'This cannot be undone.';

        if (pending.length > 0) {
            confirmMessage = 'WARNING: This customer has ' + pending.length + ' pending violation(s):\n\n'
                + pending.slice(0, 5).map(function (v) {
                    return '• ' + (v.title || v.category || 'Violation') + ' (' + (v.severity || 'medium') + ')';
                }).join('\n')
                + '\n\n' + confirmMessage;
        }

        if (!confirm(confirmMessage)) return;

        try {
            var response = await fetch('/api/admin/customers/' + encodeURIComponent(id), {
                method: 'DELETE',
                credentials: 'same-origin'
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ('Request failed (' + response.status + ')'));
            }
            await loadAdminCustomers();
        } catch (error) {
            console.error('Delete customer error:', error);
            alert('Could not delete this customer: ' + error.message);
        }
    }

    async function viewCustomerViolations(id) {
        try {
            var response = await fetch(
                '/api/admin/violations/for/customer/' + encodeURIComponent(id),
                { credentials: 'same-origin', cache: 'no-store' }
            );
            if (!response.ok) throw new Error('Failed to load violations');
            var data = await response.json();
            var list = Array.isArray(data.violations) ? data.violations : [];

            if (list.length === 0) {
                alert('No violations recorded for this customer.');
                return;
            }

            var text = list.map(function (v) {
                return '• [' + (v.severity || 'medium').toUpperCase() + '] '
                    + (v.title || v.category || 'Violation')
                    + ' — ' + (v.status || 'pending')
                    + '\n  ' + (v.description || '').slice(0, 120);
            }).join('\n\n');

            alert('Violations for customer #' + id + ':\n\n' + text);
        } catch (err) {
            alert('Could not load violations: ' + err.message);
        }
    }

    // ============================================================
    //  BUSINESSES
    // ============================================================

    async function loadAdminBusinesses() {
        var tbody = document.getElementById('businessesTableBody');
        var badge = document.getElementById('businessesCountBadge');
        if (!tbody) return;

        tbody.innerHTML = '' +
            '<tr><td colspan="6"><div class="superadmin-empty">' +
                '<i class="fas fa-spinner fa-spin"></i> Loading businesses...' +
            '</div></td></tr>';

        try {
            var response = await fetch('/api/admin/businesses', {
                credentials: 'same-origin',
                cache: 'no-store'
            });

            if (response.status === 401 || response.status === 403) {
                window.location.replace('/admin.html');
                return;
            }
            if (!response.ok) throw new Error('Failed to load businesses (' + response.status + ')');

            var list = await response.json();
            adminBusinesses = Array.isArray(list) ? list : [];

            renderBusinesses(adminBusinesses);

            if (badge) badge.textContent = String(adminBusinesses.length);
        } catch (error) {
            console.error('Load businesses error:', error);
            tbody.innerHTML = '' +
                '<tr><td colspan="6"><div class="superadmin-error">' +
                    'Unable to load businesses: ' + escapeHtml(error.message) +
                '</div></td></tr>';
            if (badge) badge.textContent = '0';
        }
    }

    function renderBusinesses(list) {
        var tbody = document.getElementById('businessesTableBody');
        if (!tbody) return;

        var search = (document.getElementById('businessesSearch')?.value || '').trim().toLowerCase();
        var filtered = list;

        if (search) {
            filtered = list.filter(function (b) {
                var haystack = (
                    String(b.business_name || '') + ' ' +
                    String(b.email || '') + ' ' +
                    String(b.owner_email || '') + ' ' +
                    String(b.slug || '')
                ).toLowerCase();
                return haystack.indexOf(search) !== -1;
            });
        }

        if (filtered.length === 0) {
            tbody.innerHTML = '' +
                '<tr><td colspan="6"><div class="superadmin-empty">' +
                    '<i class="fas fa-store"></i>' +
                    (list.length === 0 ? 'No businesses yet.' : 'No businesses match your search.') +
                '</div></td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(function (b) {
            var isActive = b.is_active !== false;
            var rowClass = isActive ? '' : 'is-inactive';
            var statePill = isActive
                ? '<span class="state-pill active">● Active</span>'
                : '<span class="state-pill suspended">● Suspended</span>';

            var violationsCount = Number(b.pending_violations || 0);
            var violationsHint = violationsCount > 0
                ? '<span class="state-pill warning" style="margin-left:6px;" title="Pending violations">⚠️ ' + violationsCount + '</span>'
                : '';

            return '' +
                '<tr class="' + rowClass + '">' +
                    '<td>' +
                        '<span class="row-name">' + escapeHtml(b.business_name || 'Unnamed business') + '</span>' +
                        '<span class="row-sub">/' + escapeHtml(b.slug || '') + '</span>' +
                    '</td>' +
                    '<td>' +
                        escapeHtml(b.owner_email || b.email || '—') +
                        '<span class="row-sub">' + escapeHtml(b.phone || '—') + '</span>' +
                    '</td>' +
                    '<td>' + formatNumber(b.product_count || 0) + '</td>' +
                    '<td>' + statePill + violationsHint + '</td>' +
                    '<td>' + escapeHtml(formatDate(b.created_at)) + '</td>' +
                    '<td>' +
                        '<div class="row-actions">' +
                            '<button type="button" class="btn-view" onclick="viewBusinessViolations(' + b.id + ')"><i class="fas fa-eye"></i> Violations</button>' +
                            (isActive
                                ? '<button type="button" class="btn-suspend" onclick="suspendBusiness(' + b.id + ')"><i class="fas fa-pause"></i> Suspend</button>'
                                : '<button type="button" class="btn-activate" onclick="activateBusiness(' + b.id + ')"><i class="fas fa-play"></i> Activate</button>') +
                            '<button type="button" class="btn-delete" onclick="deleteBusiness(' + b.id + ', \'' + escapeAttr(b.business_name || '') + '\')"><i class="fas fa-trash"></i> Delete</button>' +
                        '</div>' +
                    '</td>' +
                '</tr>';
        }).join('');
    }

    async function suspendBusiness(id) {
        var pending = await fetchPendingViolationsFor('business', id);

        var confirmMessage = 'Suspend this business? It will be hidden from the marketplace until you activate it again.';
        if (pending.length > 0) {
            confirmMessage = 'This business has ' + pending.length + ' pending violation(s):\n\n'
                + pending.slice(0, 5).map(function (v) {
                    return '• ' + (v.title || v.category || 'Violation') + ' (' + (v.severity || 'medium') + ')';
                }).join('\n')
                + '\n\nSuspend anyway?';
        }

        if (!confirm(confirmMessage)) return;

        try {
            var response = await fetch('/api/admin/businesses/' + encodeURIComponent(id) + '/status', {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_active: false })
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ('Request failed (' + response.status + ')'));
            }
            await loadAdminBusinesses();
        } catch (error) {
            console.error('Suspend business error:', error);
            alert('Could not suspend this business: ' + error.message);
        }
    }

    async function activateBusiness(id) {
        try {
            var response = await fetch('/api/admin/businesses/' + encodeURIComponent(id) + '/status', {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_active: true })
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ('Request failed (' + response.status + ')'));
            }
            await loadAdminBusinesses();
        } catch (error) {
            console.error('Activate business error:', error);
            alert('Could not activate this business: ' + error.message);
        }
    }

    async function deleteBusiness(id, name) {
        var label = name ? ('"' + name + '"') : ('business #' + id);
        var pending = await fetchPendingViolationsFor('business', id);

        var confirmMessage = 'Permanently delete ' + label + '?\n\n'
            + 'This removes the business, its products, ads, orders, and '
            + 'associated data. The owner admin account will be detached.\n\n'
            + 'This cannot be undone.';

        if (pending.length > 0) {
            confirmMessage = 'WARNING: This business has ' + pending.length + ' pending violation(s):\n\n'
                + pending.slice(0, 5).map(function (v) {
                    return '• ' + (v.title || v.category || 'Violation') + ' (' + (v.severity || 'medium') + ')';
                }).join('\n')
                + '\n\n' + confirmMessage;
        }

        if (!confirm(confirmMessage)) return;

        try {
            var response = await fetch('/api/admin/businesses/' + encodeURIComponent(id), {
                method: 'DELETE',
                credentials: 'same-origin'
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ('Request failed (' + response.status + ')'));
            }
            await loadAdminBusinesses();
        } catch (error) {
            console.error('Delete business error:', error);
            alert('Could not delete this business: ' + error.message);
        }
    }

    async function viewBusinessViolations(id) {
        try {
            var response = await fetch(
                '/api/admin/violations/for/business/' + encodeURIComponent(id),
                { credentials: 'same-origin', cache: 'no-store' }
            );
            if (!response.ok) throw new Error('Failed to load violations');
            var data = await response.json();
            var list = Array.isArray(data.violations) ? data.violations : [];

            if (list.length === 0) {
                alert('No violations recorded for this business.');
                return;
            }

            var text = list.map(function (v) {
                return '• [' + (v.severity || 'medium').toUpperCase() + '] '
                    + (v.title || v.category || 'Violation')
                    + ' — ' + (v.status || 'pending')
                    + '\n  ' + (v.description || '').slice(0, 120);
            }).join('\n\n');

            alert('Violations for business #' + id + ':\n\n' + text);
        } catch (err) {
            alert('Could not load violations: ' + err.message);
        }
    }

    // ============================================================
    //  VIOLATIONS
    // ============================================================

    async function loadAdminViolations() {
        var tbody = document.getElementById('violationsTableBody');
        var badge = document.getElementById('violationsCountBadge');
        if (!tbody) return;

        tbody.innerHTML = '' +
            '<tr><td colspan="7"><div class="superadmin-empty">' +
                '<i class="fas fa-spinner fa-spin"></i> Loading violations...' +
            '</div></td></tr>';

        try {
            var params = new URLSearchParams();
            if (violationFilters.kind)         params.set('kind', violationFilters.kind);
            if (violationFilters.subject_type) params.set('subject_type', violationFilters.subject_type);
            if (violationFilters.status)       params.set('status', violationFilters.status);
            if (violationFilters.severity)     params.set('severity', violationFilters.severity);
            if (violationFilters.search)       params.set('search', violationFilters.search);

            var response = await fetch('/api/admin/violations?' + params.toString(), {
                credentials: 'same-origin',
                cache: 'no-store'
            });

            if (!response.ok) throw new Error('Failed to load violations (' + response.status + ')');

            var data = await response.json();
            var list = Array.isArray(data.violations) ? data.violations : [];
            adminViolations = list;

            renderViolations(list);

            if (badge) badge.textContent = String(data.total || list.length);
        } catch (error) {
            console.error('Load violations error:', error);
            tbody.innerHTML = '' +
                '<tr><td colspan="7"><div class="superadmin-error">' +
                    'Unable to load violations: ' + escapeHtml(error.message) +
                '</div></td></tr>';
            if (badge) badge.textContent = '0';
        }
    }

    function renderViolations(list) {
        var tbody = document.getElementById('violationsTableBody');
        if (!tbody) return;

        if (!list || list.length === 0) {
            tbody.innerHTML = '' +
                '<tr><td colspan="7"><div class="superadmin-empty">' +
                    '<i class="fas fa-check-circle"></i>' +
                    'No violations recorded.' +
                '</div></td></tr>';
            return;
        }

        tbody.innerHTML = list.map(function (v) {
            var subjectLabel = v.subject_label
                || (v.subject_type === 'customer' ? ('Customer #' + v.subject_id) : ('Business #' + v.subject_id));

            var kindPill = v.kind === 'claim'
                ? '<span class="state-pill critical">CLAIM</span>'
                : '<span class="state-pill warning">VIOLATION</span>';

            var subjectPill = v.subject_type === 'business'
                ? '<span class="state-pill">🏪 Business</span>'
                : '<span class="state-pill">👤 Customer</span>';

            return '' +
                '<tr>' +
                    '<td>' + kindPill + '</td>' +
                    '<td>' + subjectPill + '<span class="row-sub">' + escapeHtml(subjectLabel) + '</span></td>' +
                    '<td>' +
                        '<span class="row-name">' + escapeHtml(v.title || 'Untitled') + '</span>' +
                        '<span class="row-sub">' + escapeHtml(v.category || '—') + '</span>' +
                    '</td>' +
                    '<td><span class="severity-pill ' + severityClass(v.severity) + '">' + escapeHtml((v.severity || 'medium').toUpperCase()) + '</span></td>' +
                    '<td><span class="' + statusClass(v.status) + '">' + escapeHtml((v.status || 'pending').replace('_', ' ').toUpperCase()) + '</span></td>' +
                    '<td>' + escapeHtml(formatDate(v.created_at)) + '</td>' +
                    '<td>' +
                        '<div class="row-actions">' +
                            '<button type="button" class="btn-view" onclick="viewViolation(' + v.id + ')"><i class="fas fa-eye"></i></button>' +
                            '<button type="button" class="btn-suspend" onclick="updateViolationStatus(' + v.id + ', \'resolved\')"><i class="fas fa-check"></i></button>' +
                            '<button type="button" class="btn-delete" onclick="deleteViolation(' + v.id + ')"><i class="fas fa-trash"></i></button>' +
                        '</div>' +
                    '</td>' +
                '</tr>';
        }).join('');
    }

    function wireViolationFilters() {
        ['violationKindFilter', 'violationSubjectFilter', 'violationStatusFilter', 'violationSeverityFilter'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el || el.dataset.wired === 'true') return;
            el.dataset.wired = 'true';
            el.addEventListener('change', function () {
                violationFilters.kind         = document.getElementById('violationKindFilter')?.value || '';
                violationFilters.subject_type = document.getElementById('violationSubjectFilter')?.value || '';
                violationFilters.status       = document.getElementById('violationStatusFilter')?.value || '';
                violationFilters.severity     = document.getElementById('violationSeverityFilter')?.value || '';
                loadAdminViolations();
            });
        });

        var search = document.getElementById('violationsSearch');
        if (search && search.dataset.wired !== 'true') {
            search.dataset.wired = 'true';
            var timer = null;
            search.addEventListener('input', function () {
                clearTimeout(timer);
                timer = setTimeout(function () {
                    violationFilters.search = search.value.trim();
                    loadAdminViolations();
                }, 250);
            });
        }
    }

    async function viewViolation(id) {
        try {
            var response = await fetch('/api/admin/violations/' + encodeURIComponent(id), {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            if (!response.ok) throw new Error('Failed to load violation');
            var data = await response.json();
            var v = data.violation;
            if (!v) return;

            var subjectText = data.subject
                ? JSON.stringify(data.subject, null, 2)
                : '(not found)';

            alert(
                'Violation #' + v.id + '\n\n'
                + 'Kind: ' + (v.kind || 'violation') + '\n'
                + 'Subject: ' + (v.subject_type || '') + ' #' + (v.subject_id || '') + '\n'
                + 'Title: ' + (v.title || '') + '\n'
                + 'Severity: ' + (v.severity || '') + '\n'
                + 'Status: ' + (v.status || '') + '\n\n'
                + 'Description:\n' + (v.description || '(none)') + '\n\n'
                + 'Subject snapshot:\n' + subjectText
            );
        } catch (err) {
            alert('Could not load violation: ' + err.message);
        }
    }

    async function updateViolationStatus(id, newStatus) {
        var note = prompt('Optional note for the new status (' + newStatus + '):') || '';

        try {
            var response = await fetch('/api/admin/violations/' + encodeURIComponent(id), {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus, action_note: note })
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ('Request failed (' + response.status + ')'));
            }
            await loadAdminViolations();
            await loadAdminDashboard();
        } catch (err) {
            alert('Could not update violation: ' + err.message);
        }
    }

    async function deleteViolation(id) {
        if (!confirm('Delete this violation record permanently?')) return;
        try {
            var response = await fetch('/api/admin/violations/' + encodeURIComponent(id), {
                method: 'DELETE',
                credentials: 'same-origin'
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ('Request failed (' + response.status + ')'));
            }
            await loadAdminViolations();
        } catch (err) {
            alert('Could not delete violation: ' + err.message);
        }
    }

    // ============================================================
    //  RECORD VIOLATION FORM
    // ============================================================

    function wireRecordViolationForm() {
        var form = document.getElementById('recordViolationForm');
        if (!form || form.dataset.wired === 'true') return;
        form.dataset.wired = 'true';

        form.addEventListener('submit', async function (e) {
            e.preventDefault();

            var payload = {
                kind: document.getElementById('rvKind').value || 'violation',
                subject_type: document.getElementById('rvSubjectType').value,
                subject_id: parseInt(document.getElementById('rvSubjectId').value, 10),
                subject_label: document.getElementById('rvSubjectLabel').value.trim() || null,
                category: document.getElementById('rvCategory').value.trim() || null,
                title: document.getElementById('rvTitle').value.trim(),
                description: document.getElementById('rvDescription').value.trim() || null,
                evidence_url: document.getElementById('rvEvidence').value.trim() || null,
                severity: document.getElementById('rvSeverity').value || 'medium',
                reported_by_type: 'admin',
                reported_by_id: null,
                reporter_label: 'Super Admin'
            };

            if (!payload.subject_type || !Number.isInteger(payload.subject_id) || !payload.title) {
                alert('Subject type, subject ID, and title are required.');
                return;
            }

            try {
                var response = await fetch('/api/admin/violations', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                var data = await response.json().catch(function () { return {}; });
                if (!response.ok || data.success === false) {
                    throw new Error(data.error || ('Request failed (' + response.status + ')'));
                }

                form.reset();
                await loadAdminViolations();
                await loadAdminDashboard();
                alert('Violation recorded.');
            } catch (err) {
                alert('Could not record violation: ' + err.message);
            }
        });
    }

    // ============================================================
    //  COMPLAINTS INBOX (admin_messages)
    // ============================================================

    async function loadAdminMessages() {
        var tbody = document.getElementById('messagesTableBody');
        var badge = document.getElementById('messagesCountBadge');
        if (!tbody) return;

        tbody.innerHTML = '' +
            '<tr><td colspan="6"><div class="superadmin-empty">' +
                '<i class="fas fa-spinner fa-spin"></i> Loading messages...' +
            '</div></td></tr>';

        try {
            var params = new URLSearchParams();
            if (messageFilters.status)      params.set('status', messageFilters.status);
            if (messageFilters.sender_type) params.set('sender_type', messageFilters.sender_type);
            if (messageFilters.search)      params.set('search', messageFilters.search);

            var response = await fetch('/api/admin/messages?' + params.toString(), {
                credentials: 'same-origin',
                cache: 'no-store'
            });

            if (!response.ok) throw new Error('Failed to load messages (' + response.status + ')');

            var data = await response.json();
            var list = Array.isArray(data.messages) ? data.messages : [];
            adminMessages = list;

            renderMessages(list);

            if (badge) badge.textContent = String(data.total || list.length);

            await updateUnreadMessagesBadge();
        } catch (error) {
            console.error('Load messages error:', error);
            tbody.innerHTML = '' +
                '<tr><td colspan="6"><div class="superadmin-error">' +
                    'Unable to load messages: ' + escapeHtml(error.message) +
                '</div></td></tr>';
            if (badge) badge.textContent = '0';
        }
    }

    async function updateUnreadMessagesBadge() {
        try {
            var response = await fetch('/api/admin/messages/counts', {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            if (!response.ok) return;
            var data = await response.json();
            var badge = document.getElementById('unreadMessagesBadge');
            if (badge) {
                var n = Number(data.unread || 0);
                badge.textContent = String(n);
                badge.hidden = n === 0;
            }
        } catch (err) {
            // non-fatal
        }
    }

    function renderMessages(list) {
        var tbody = document.getElementById('messagesTableBody');
        if (!tbody) return;

        if (!list || list.length === 0) {
            tbody.innerHTML = '' +
                '<tr><td colspan="6"><div class="superadmin-empty">' +
                    '<i class="fas fa-envelope-open-text"></i>' +
                    'No messages in the inbox.' +
                '</div></td></tr>';
            return;
        }

        tbody.innerHTML = list.map(function (m) {
            var senderPill = m.sender_type === 'business'
                ? '<span class="state-pill">🏪 Business</span>'
                : '<span class="state-pill">👤 Customer</span>';

            return '' +
                '<tr>' +
                    '<td>' + senderPill + '<span class="row-sub">' + escapeHtml(m.sender_label || ('#' + m.sender_id)) + '</span></td>' +
                    '<td><span class="row-name">' + escapeHtml(m.subject || 'Untitled') + '</span><span class="row-sub">' + escapeHtml(m.category || '—') + '</span></td>' +
                    '<td><span class="' + messageStatusClass(m.status) + '">' + escapeHtml((m.status || 'unread').toUpperCase()) + '</span></td>' +
                    '<td>' + escapeHtml(formatDate(m.created_at)) + '</td>' +
                    '<td>' + (m.admin_reply ? '<span class="state-pill active">Yes</span>' : '<span class="state-pill">No</span>') + '</td>' +
                    '<td>' +
                        '<div class="row-actions">' +
                            '<button type="button" class="btn-view" onclick="openComplaint(' + m.id + ')"><i class="fas fa-eye"></i> Open</button>' +
                            '<button type="button" class="btn-delete" onclick="deleteAdminMessage(' + m.id + ')"><i class="fas fa-trash"></i></button>' +
                        '</div>' +
                    '</td>' +
                '</tr>';
        }).join('');
    }

    function wireMessageFilters() {
        ['messageStatusFilter', 'messageSenderFilter'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el || el.dataset.wired === 'true') return;
            el.dataset.wired = 'true';
            el.addEventListener('change', function () {
                messageFilters.status      = document.getElementById('messageStatusFilter')?.value || '';
                messageFilters.sender_type = document.getElementById('messageSenderFilter')?.value || '';
                loadAdminMessages();
            });
        });

        var search = document.getElementById('messagesSearch');
        if (search && search.dataset.wired !== 'true') {
            search.dataset.wired = 'true';
            var timer = null;
            search.addEventListener('input', function () {
                clearTimeout(timer);
                timer = setTimeout(function () {
                    messageFilters.search = search.value.trim();
                    loadAdminMessages();
                }, 250);
            });
        }
    }

    async function openComplaint(id) {
        try {
            var response = await fetch('/api/admin/messages/' + encodeURIComponent(id), {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            if (!response.ok) throw new Error('Failed to load message');
            var data = await response.json();

            openComplaintId = id;

            var panel = document.getElementById('complaintThreadPanel');
            var body = document.getElementById('complaintThreadBody');
            var title = document.getElementById('complaintThreadTitle');
            if (!panel || !body) return;

            var m = data.message || {};

            if (title) {
                title.textContent = 'Complaint #' + m.id + ' — ' + (m.subject || 'Untitled');
            }

            var related = '';
            if (data.related_order) {
                related += '<div class="row-sub">Order: ' + escapeHtml(data.related_order.order_ref || data.related_order.id) + '</div>';
            }
            if (data.related_business) {
                related += '<div class="row-sub">Business: ' + escapeHtml(data.related_business.business_name || '') + '</div>';
            }

            var senderInfo = '';
            if (data.sender) {
                senderInfo = ''
                    + '<div class="row-sub">From: ' + escapeHtml(data.sender.name || data.sender.business_name || '') + '</div>'
                    + '<div class="row-sub">Email: ' + escapeHtml(data.sender.email || '—') + '</div>'
                    + '<div class="row-sub">Phone: ' + escapeHtml(data.sender.phone || '—') + '</div>';
            }

            body.innerHTML = ''
                + '<div class="complaint-meta">'
                    + '<span class="state-pill">' + escapeHtml((m.sender_type || 'customer').toUpperCase()) + '</span> '
                    + '<span class="' + messageStatusClass(m.status) + '">' + escapeHtml((m.status || 'unread').toUpperCase()) + '</span>'
                    + '<span class="row-sub">' + escapeHtml(formatDate(m.created_at)) + '</span>'
                + '</div>'
                + senderInfo
                + related
                + '<div class="complaint-body">' + escapeHtml(m.body || '').replace(/\n/g, '<br>') + '</div>'
                + (m.attachment_url ? '<div><a href="' + escapeAttr(m.attachment_url) + '" target="_blank">View attachment</a></div>' : '')
                + (m.admin_reply
                    ? '<div class="complaint-reply"><strong>Admin reply:</strong><br>' + escapeHtml(m.admin_reply).replace(/\n/g, '<br>') + '</div>'
                    : '')
                + '<div class="complaint-actions">'
                    + '<textarea id="complaintReplyText" rows="3" placeholder="Type your reply..." style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-family:inherit;"></textarea>'
                    + '<div class="row-actions" style="margin-top:8px;">'
                        + '<button type="button" class="btn-activate" onclick="replyToComplaint(' + id + ')"><i class="fas fa-reply"></i> Reply</button>'
                        + '<button type="button" class="btn-suspend" onclick="escalateComplaint(' + id + ')"><i class="fas fa-gavel"></i> Escalate</button>'
                        + '<button type="button" class="btn-delete" onclick="closeComplaint(' + id + ')"><i class="fas fa-times"></i> Close</button>'
                    + '</div>'
                + '</div>';

            panel.hidden = false;

            // Mark read
            await fetch('/api/admin/messages/' + encodeURIComponent(id) + '/read', {
                method: 'PUT',
                credentials: 'same-origin'
            });
            await updateUnreadMessagesBadge();
        } catch (err) {
            alert('Could not open complaint: ' + err.message);
        }
    }

    async function replyToComplaint(id) {
        var textarea = document.getElementById('complaintReplyText');
        var reply = textarea ? textarea.value.trim() : '';
        if (!reply) {
            alert('Please type a reply first.');
            return;
        }

        try {
            var response = await fetch('/api/admin/messages/' + encodeURIComponent(id) + '/reply', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reply: reply })
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ('Request failed (' + response.status + ')'));
            }
            await loadAdminMessages();
            await openComplaint(id);
        } catch (err) {
            alert('Could not send reply: ' + err.message);
        }
    }

    async function escalateComplaint(id) {
        var subjectType = prompt('Escalate to a claim about: customer or business?', 'business');
        if (!subjectType) return;
        subjectType = subjectType.toLowerCase();
        if (subjectType !== 'customer' && subjectType !== 'business') {
            alert('Subject type must be "customer" or "business".');
            return;
        }

        var subjectIdRaw = prompt('Enter the ' + subjectType + ' id:');
        var subjectId = parseInt(subjectIdRaw, 10);
        if (!Number.isInteger(subjectId)) {
            alert('Invalid id.');
            return;
        }

        var severity = prompt('Severity? low / medium / high / critical', 'medium') || 'medium';
        severity = severity.toLowerCase();
        if (['low', 'medium', 'high', 'critical'].indexOf(severity) === -1) {
            severity = 'medium';
        }

        try {
            var response = await fetch('/api/admin/messages/' + encodeURIComponent(id) + '/escalate', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    subject_type: subjectType,
                    subject_id: subjectId,
                    severity: severity
                })
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ('Request failed (' + response.status + ')'));
            }
            alert('Complaint escalated into a claim (violation #' + (data.violation && data.violation.id) + ').');
            await loadAdminMessages();
            await loadAdminViolations();
        } catch (err) {
            alert('Could not escalate complaint: ' + err.message);
        }
    }

    async function closeComplaint(id) {
        if (!confirm('Close this complaint without a reply?')) return;
        try {
            var response = await fetch('/api/admin/messages/' + encodeURIComponent(id) + '/close', {
                method: 'PUT',
                credentials: 'same-origin'
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ('Request failed (' + response.status + ')'));
            }
            await loadAdminMessages();
            var panel = document.getElementById('complaintThreadPanel');
            if (panel) panel.hidden = true;
        } catch (err) {
            alert('Could not close complaint: ' + err.message);
        }
    }

    async function deleteAdminMessage(id) {
        if (!confirm('Delete this message from the inbox?')) return;
        try {
            var response = await fetch('/api/admin/messages/' + encodeURIComponent(id), {
                method: 'DELETE',
                credentials: 'same-origin'
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ('Request failed (' + response.status + ')'));
            }
            await loadAdminMessages();
            var panel = document.getElementById('complaintThreadPanel');
            if (panel) panel.hidden = true;
        } catch (err) {
            alert('Could not delete message: ' + err.message);
        }
    }

    // ============================================================
    //  LOGOUT
    // ============================================================

    async function logoutAdmin() {
        try {
            await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } catch (err) {
            // Non-fatal.
        }
        window.location.replace('/admin.html');
    }

    // ============================================================
    //  SEARCH INPUT WIRING
    // ============================================================

    function wireSearchInputs() {
        var customersSearch = document.getElementById('customersSearch');
        if (customersSearch && !customersSearch.dataset.wired) {
            customersSearch.dataset.wired = 'true';
            var custTimer = null;
            customersSearch.addEventListener('input', function () {
                clearTimeout(custTimer);
                custTimer = setTimeout(function () {
                    renderCustomers(adminCustomers);
                }, 200);
            });
        }

        var businessesSearch = document.getElementById('businessesSearch');
        if (businessesSearch && !businessesSearch.dataset.wired) {
            businessesSearch.dataset.wired = 'true';
            var bizTimer = null;
            businessesSearch.addEventListener('input', function () {
                clearTimeout(bizTimer);
                bizTimer = setTimeout(function () {
                    renderBusinesses(adminBusinesses);
                }, 200);
            });
        }
    }

    // ============================================================
    //  SOCKET.IO — live updates for complaints and violations
    // ============================================================

    function wireSocket() {
        if (typeof io !== 'function') return;

        try {
            var socket = io({ withCredentials: true });

            socket.on('admin-message-received', function () {
                updateUnreadMessagesBadge();
                if (openSection === 'messages') loadAdminMessages();
            });

            socket.on('admin-message-updated', function () {
                updateUnreadMessagesBadge();
                if (openSection === 'messages') loadAdminMessages();
            });
        } catch (err) {
            // socket.io not present on this page — non-fatal
        }
    }

    // ============================================================
    //  GLOBAL EXPORTS
    // ============================================================

    window.loadAdminDashboard    = loadAdminDashboard;
    window.loadAdminCustomers    = loadAdminCustomers;
    window.loadAdminBusinesses   = loadAdminBusinesses;
    window.loadAdminViolations   = loadAdminViolations;
    window.loadAdminMessages     = loadAdminMessages;

    window.toggleAdminSection    = toggleAdminSection;
    window.closeAllAdminSections = closeAllAdminSections;

    window.suspendCustomer       = suspendCustomer;
    window.activateCustomer      = activateCustomer;
    window.deleteCustomer        = deleteCustomer;
    window.viewCustomerViolations = viewCustomerViolations;

    window.suspendBusiness       = suspendBusiness;
    window.activateBusiness      = activateBusiness;
    window.deleteBusiness        = deleteBusiness;
    window.viewBusinessViolations = viewBusinessViolations;

    window.viewViolation         = viewViolation;
    window.updateViolationStatus = updateViolationStatus;
    window.deleteViolation       = deleteViolation;

    window.openComplaint         = openComplaint;
    window.replyToComplaint      = replyToComplaint;
    window.escalateComplaint     = escalateComplaint;
    window.closeComplaint        = closeComplaint;
    window.deleteAdminMessage    = deleteAdminMessage;

    window.logoutAdmin           = logoutAdmin;

    // ============================================================
    //  AUTO-BOOT WHEN LOADED
    // ============================================================

    function boot() {
        wireSearchInputs();
        wireSectionToggles();
        wireViolationFilters();
        wireMessageFilters();
        wireRecordViolationForm();
        wireSocket();
        updateUnreadMessagesBadge();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    console.log('✅ admin-dashboard.js loaded (compact stats + attention row + collapsible sections + violations + complaints inbox + record violation + complaint thread + escalate to claim)');
})();