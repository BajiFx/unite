// ============================================================
//  CART PAGE JAVASCRIPT - COMPLETE VERSION WITH BUSINESS SUPPORT
//  Location: public/js/cart.js
//
//  Section I — M-Pesa payment types:
//   I.1 — the M-Pesa entry in the payment modal reflects the
//         business's chosen type (Paybill / Till / Pochi) and
//         shows the correct shortcode / account reference.
//   I.2 — the customer never sees a type selector; the type
//         is fixed by what the business configured.
//   I.5 — processPayment() forwards the chosen type and
//         shortcode so the server stores the correct
//         transaction type on the payment record.
//   I.7 — getMpesaFallbackMessage() returns a clear message and
//         placeOrder() blocks the order when M-Pesa is
//         disabled and no alternative is configured.
//
//  Section H — Cart when the business pauses orders:
//   - loadBusinessSettings() records online_orders_enabled and
//     order_disabled_message for the cart's business.
//   - applyCartPausedState() disables shipping options, promo,
//     and the Place Order button, shows a red banner above the
//     checkout area, and relabels the button to "Orders Paused".
//   - Every action that could push a paused order through
//     (applyPromo, selectShippingTier, processPayment,
//     placeOrder) hard-blocks with a clear message.
//   - Cart items stay visible and editable so the customer can
//     still adjust what they have.
// ============================================================

// Check if running in embedded mode (inside dashboard panel)
// A workspace Cart is always rendered in an iframe.  The frame check prevents
// an accidental redirect to the marketplace if a host/browser strips the
// embedded query string during navigation.
const isEmbeddedCart = new URLSearchParams(window.location.search).get('embedded') === '1' || window.self !== window.top;

// If embedded, hide the header
if (isEmbeddedCart) {
  document.addEventListener('DOMContentLoaded', function() {
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';

    const backLink = document.querySelector('.back-link');
    if (backLink) backLink.style.display = 'none';

    // Adjust cart page padding
    const cartPage = document.querySelector('.cart-page');
    if (cartPage) {
      cartPage.style.paddingTop = '10px';
    }
  });
}

let cartItems = [];
let selectedShippingTier = 'standard';
let shippingCost = 0;
let promoDiscount = 0;
let timerInterval = null;
let reservationTime = 15 * 60;
let pendingOrderId = null;
let paymentTotal = 0;
let selectedPaymentMethod = '';
let allProductsForPreview = [];
let mpesaPollingInterval = null;
let airtelPollingInterval = null;
let selectedDeliveryMethod = 'pickup';
let businessDeliverySettings = null;
let businessPaymentSettings = null;
let currentBusinessId = null;

// Section H — cached order-visibility state for the cart's business.
// Defaults to "enabled" so a missing field never locks the customer
// out of the checkout flow.
let businessPausedState = {
    onlineOrdersEnabled: true,
    orderDisabledMessage: ''
};

const DEFAULT_ORDERS_PAUSED_MESSAGE =
    'This business is not currently accepting online orders. Please contact them directly.';

const FREE_SHIPPING_THRESHOLD = 40000;

const kenyanBanks = [
  "Equity Bank Kenya", "KCB Bank Kenya", "Co-operative Bank of Kenya",
  "NCBA Bank Kenya", "Stanbic Bank Kenya", "Standard Chartered Kenya",
  "Absa Bank Kenya", "Diamond Trust Bank (DTB)", "I&M Bank Kenya",
  "Family Bank", "Guaranty Trust Bank (GTBank)", "Bank of Africa Kenya",
  "Consolidated Bank", "Development Bank of Kenya", "African Banking Corporation (ABC Bank)",
  "Citi Bank Kenya", "National Bank of Kenya", "Prime Bank Kenya",
  "Sidian Bank", "Victoria Commercial Bank", "Credit Bank Kenya",
  "HFC Bank Kenya", "Kingdom Bank", "M-Oriental Bank",
  "Paramount Bank", "First Community Bank", "Chase Bank (in receivership)",
  "Spire Bank", "Gulf African Bank", "HABIB Bank AG Zurich",
  "KASNEB Bank", "NIC Bank (now NCBA)", "Jubilee Bank",
  "Transnational Bank", "Middle East Bank", "Orient Bank",
  "Bank of Baroda Kenya", "Bank of India Kenya", "Ecobank Kenya",
  "United Bank of Africa (UBA)", "Access Bank Kenya", "SBM Bank Kenya"
];

// ============================================================
//  INIT
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    const signedInUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
    if (!isEmbeddedCart && !signedInUser.email) {
        window.location.replace('/?auth=login&next=cart');
        return;
    }
    loadShopProfile();
    loadAllProductsForPreview();
    renderCartPage();
    updateCartBadge();
    loadRecommended();
    startReservationTimer();
    populateBankDropdown();

    const user = window.currentUser;
    if (user) {
        document.getElementById('recipientName').value = user.name || '';
        document.getElementById('recipientPhone').value = user.phone || user.email || '';
    }

    // Get business ID from cart items
    const cart = getCart();
    if (cart && cart.length > 0) {
        const businessIds = [...new Set(cart.map(item => item.business_id))];
        if (businessIds.length === 1) {
            currentBusinessId = businessIds[0];
            loadBusinessSettings(currentBusinessId);
        } else if (businessIds.length > 1) {
            showToast('⚠️ You have items from different shops. Please order from one shop at a time.', 'warning');
        }
    }
});

// ============================================================
//  LOAD BUSINESS SETTINGS
// ============================================================

async function loadBusinessSettings(businessId) {
    try {
        // Load delivery settings
        const deliveryRes = await fetch(`/api/businesses/${businessId}/delivery`);
        if (deliveryRes.ok) {
            businessDeliverySettings = await deliveryRes.json();
            updateDeliveryOptions();
        }

        // Load payment settings
        const paymentRes = await fetch(`/api/businesses/${businessId}/payment-settings`);
        if (paymentRes.ok) {
            businessPaymentSettings = await paymentRes.json();
            updatePaymentMethods();
        }

        // Section H — check whether this business is accepting orders.
        // The /status endpoint already returns online_orders_enabled
        // and order_disabled_message (added in the H round), so we
        // read both here and drive the cart's paused state from them.
        const statusRes = await fetch(`/api/businesses/${businessId}/status`);
        if (statusRes.ok) {
            const status = await statusRes.json();
            businessPausedState.onlineOrdersEnabled = status.online_orders_enabled !== false;
            businessPausedState.orderDisabledMessage = status.order_disabled_message || '';
        }

        // Section H — apply the paused state to the whole checkout
        // section in one shot.
        applyCartPausedState();
    } catch (err) {
        console.error('Error loading business settings:', err);
    }
}

// ============================================================
//  Section H — Cart paused state
// ============================================================

/**
 * Apply the paused / active state to the whole checkout section.
 *
 * When the business is paused:
 *   - a red banner appears above the checkout sections
 *   - the promo input + Apply button are disabled
 *   - every shipping option is greyed out and non-clickable
 *   - the Place Order button is disabled and relabelled
 * When the business is active, everything is restored.
 */
function applyCartPausedState() {
    const paused = businessPausedState.onlineOrdersEnabled === false;

    renderCartPausedBanner(paused);

    const promoInput = document.getElementById('promoInput');
    const promoBtn = promoInput ? promoInput.parentElement?.querySelector('button') : null;
    if (promoInput) promoInput.disabled = paused;
    if (promoBtn) {
        promoBtn.disabled = paused;
        promoBtn.style.opacity = paused ? '0.55' : '';
        promoBtn.style.cursor = paused ? 'not-allowed' : '';
    }

    const shippingContainer = document.getElementById('shippingOptions');
    if (shippingContainer) {
        shippingContainer.querySelectorAll('.shipping-option').forEach(el => {
            el.style.opacity = paused ? '0.55' : '';
            el.style.pointerEvents = paused ? 'none' : '';
        });
    }

    const placeBtn = document.getElementById('placeOrderBtn');
    if (placeBtn) {
        if (paused) {
            placeBtn.disabled = true;
            placeBtn.innerHTML = '<i class="fas fa-store-alt-slash"></i> Orders Paused';
        } else {
            placeBtn.disabled = false;
            placeBtn.innerHTML = '<i class="fas fa-check-circle"></i> Place Order';
        }
    }

    const payBtn = document.getElementById('payNowBtn');
    if (payBtn && paused) {
        payBtn.disabled = true;
        payBtn.style.opacity = '0.55';
        payBtn.style.cursor = 'not-allowed';
    }
}

/**
 * Insert (or remove) the H.4-style banner above the checkout sections.
 */
function renderCartPausedBanner(paused) {
    const checkoutSections = document.getElementById('checkoutSections');
    if (!checkoutSections) return;

    const existing = document.getElementById('cartOrdersPausedBanner');

    if (!paused) {
        if (existing) existing.remove();
        return;
    }

    const message = String(businessPausedState.orderDisabledMessage || '').trim() ||
        DEFAULT_ORDERS_PAUSED_MESSAGE;

    if (existing) {
        const msgEl = existing.querySelector('#cartOrdersPausedMessage');
        if (msgEl) msgEl.textContent = message;
        return;
    }

    const banner = document.createElement('div');
    banner.id = 'cartOrdersPausedBanner';
    banner.style.cssText = [
        'margin:0 0 12px;',
        'padding:16px 20px;',
        'background:#fef2f2;',
        'border-radius:12px;',
        'border-left:5px solid #ef4444;',
        'box-shadow:0 2px 8px rgba(239,68,68,0.08);',
        'display:flex;',
        'align-items:flex-start;',
        'gap:12px;',
        'flex-wrap:wrap;'
    ].join('');

    banner.innerHTML = `
        <span style="font-size:1.6rem; line-height:1;">🔴</span>
        <div style="flex:1; min-width:220px;">
            <strong style="display:block; font-size:0.95rem; color:#991b1b; margin-bottom:4px;">
                This shop is not taking orders right now
            </strong>
            <p id="cartOrdersPausedMessage"
               style="font-size:0.85rem; color:#7f1d1d; margin:0; line-height:1.5; word-break:break-word;"></p>
            <p style="font-size:0.75rem; color:#7f1d1d; margin:6px 0 0 0;">
                You can still see your items and change quantities. When the shop is ready to take orders again, come back and press Place Order.
            </p>
        </div>
    `;

    // Assign through textContent so any user-typed characters are
    // treated as plain text, never HTML.
    const msgEl = banner.querySelector('#cartOrdersPausedMessage');
    if (msgEl) msgEl.textContent = message;

    checkoutSections.parentElement.insertBefore(banner, checkoutSections);
}

// ============================================================
//  Section I — M-Pesa type labels and fallback message
// ============================================================

/**
 * I.1 / I.2 — Build the label that describes the M-Pesa payment
 * entry for the customer. The label reflects the business's chosen
 * type (Paybill / Till / Pochi) and the matching shortcode.
 */
function getMpesaLabel(settings) {
    if (!settings || !settings.mpesa_enabled) return null;

    const type = (settings.mpesa_payment_type || 'paybill').toLowerCase();

    if (type === 'paybill') {
        const number = settings.mpesa_paybill_number || '';
        const account = settings.mpesa_paybill_account || '';
        return {
            type: 'paybill',
            title: 'M-Pesa (Paybill)',
            shortcode: number,
            accountReference: account,
            subtitle: number ? `Paybill: ${number}${account ? ' · A/C: ' + account : ''}` : ''
        };
    }

    if (type === 'till') {
        const number = settings.mpesa_till_number || '';
        return {
            type: 'till',
            title: 'M-Pesa (Till)',
            shortcode: number,
            accountReference: '',
            subtitle: number ? `Till: ${number}` : ''
        };
    }

    if (type === 'pochi') {
        const number = settings.pochi_la_biashara_number || '';
        return {
            type: 'pochi',
            title: 'M-Pesa (Pochi la Biashara)',
            shortcode: number,
            accountReference: '',
            subtitle: number ? `Pochi: ${number}` : ''
        };
    }

    return {
        type,
        title: 'M-Pesa',
        shortcode: '',
        accountReference: '',
        subtitle: ''
    };
}

/**
 * I.7 — Build the fallback message shown to the customer when
 * M-Pesa is disabled for the current business.
 */
function getMpesaFallbackMessage(settings) {
    const hasAlternative = Boolean(
        settings && (
            settings.airtel_enabled ||
            settings.bank_enabled ||
            settings.paypal_enabled
        )
    );

    if (hasAlternative) {
        return 'M-Pesa is not available for this shop. Please pick another way to pay below.';
    }

    return 'This shop has not set up M-Pesa and has no other way to pay online. Please contact the shop directly to arrange payment.';
}

// ============================================================
//  UPDATE PAYMENT METHODS BASED ON BUSINESS SETTINGS
// ============================================================

function updatePaymentMethods() {
    const container = document.getElementById('paymentMethods');
    if (!container || !businessPaymentSettings) return;

    let html = '';
    let hasMethods = false;

    const mpesaLabel = getMpesaLabel(businessPaymentSettings);

    if (mpesaLabel) {
        hasMethods = true;
        html += `
            <div class="method" onclick="selectPaymentMethod('mpesa')">
                <i class="fas fa-mobile-alt" style="color:#4CAF50;"></i> ${mpesaLabel.title}
                ${mpesaLabel.subtitle ? `<span style="font-size:0.6rem; color:#64748b; margin-left:4px;">${mpesaLabel.subtitle}</span>` : ''}
            </div>
        `;
    }

    if (businessPaymentSettings.airtel_enabled) {
        hasMethods = true;
        html += `
            <div class="method" onclick="selectPaymentMethod('airtel')">
                <i class="fas fa-phone" style="color:#FF6600;"></i> Airtel Money
            </div>
        `;
    }

    if (businessPaymentSettings.bank_enabled) {
        hasMethods = true;
        html += `
            <div class="method" onclick="selectPaymentMethod('bank')">
                <i class="fas fa-university" style="color:#2563eb;"></i> Bank Transfer
                ${businessPaymentSettings.bank_name ? `<span style="font-size:0.6rem; color:#64748b; margin-left:4px;">${businessPaymentSettings.bank_name}</span>` : ''}
            </div>
        `;
    }

    if (businessPaymentSettings.paypal_enabled) {
        hasMethods = true;
        html += `
            <div class="method" onclick="selectPaymentMethod('paypal')">
                <i class="fab fa-paypal" style="color:#0070BA;"></i> PayPal
            </div>
        `;
    }

    if (!hasMethods) {
        // I.7 — no payment method at all: show the fallback message
        // so the customer knows exactly what to do next.
        html = `<p style="color:#991b1b; background:#fef2f2; border-left:3px solid #ef4444; padding:10px 12px; border-radius:6px; font-size:0.85rem; margin:0;">${getMpesaFallbackMessage(businessPaymentSettings)}</p>`;
    } else if (!mpesaLabel) {
        // I.7 — M-Pesa is off but there are alternatives: add a soft
        // notice above the methods so the customer is not surprised.
        html = `<p style="color:#92400e; background:#fffbeb; border-left:3px solid #f59e0b; padding:8px 12px; border-radius:6px; font-size:0.75rem; margin:0 0 8px 0;">${getMpesaFallbackMessage(businessPaymentSettings)}</p>` + html;
    }

    container.innerHTML = html;
}

// ============================================================
//  UPDATE DELIVERY OPTIONS
// ============================================================

function updateDeliveryOptions() {
    const container = document.getElementById('shippingOptions');
    if (!container) return;

    const subtotal = calculateSubtotal();
    let html = '';
    let hasOptions = false;

    // Check if delivery is enabled
    if (businessDeliverySettings && businessDeliverySettings.delivery_enabled) {
        hasOptions = true;
        const isFree = businessDeliverySettings.delivery_min_order_free > 0 &&
                      subtotal >= businessDeliverySettings.delivery_min_order_free;

        let fee = 0;
        let feeLabel = 'Free';

        if (!isFree) {
            if (businessDeliverySettings.delivery_fee_type === 'fixed') {
                fee = parseFloat(businessDeliverySettings.delivery_fee_fixed) || 0;
                feeLabel = `Ksh ${fee.toFixed(2)}`;
            } else if (businessDeliverySettings.delivery_fee_type === 'per_km') {
                fee = parseFloat(businessDeliverySettings.delivery_fee_per_km) || 0;
                feeLabel = `Ksh ${fee.toFixed(2)}/km`;
            } else {
                fee = 0;
                feeLabel = 'Free';
            }
        }

        const estimatedTime = businessDeliverySettings.delivery_estimated_time || 'Same day';
        const deliveryMessage = businessDeliverySettings.delivery_no_message || '';

        html += `
            <div class="shipping-option selected" onclick="selectDeliveryMethod('delivery')" style="cursor:pointer;">
                <span class="tier-name">🚚 Delivery (${estimatedTime})</span>
                <span class="tier-price">${isFree ? '🎉 Free' : feeLabel}</span>
            </div>
        `;

        // Show free delivery threshold
        if (businessDeliverySettings.delivery_min_order_free > 0 && !isFree) {
            const remaining = businessDeliverySettings.delivery_min_order_free - subtotal;
            if (remaining > 0) {
                html += `
                    <div style="font-size:0.65rem; color:#f59e0b; margin-top:2px; padding:4px 8px; background:#fffbeb; border-radius:4px;">
                        🎉 Add Ksh ${remaining.toFixed(2)} more for FREE delivery!
                    </div>
                `;
            }
        }

        // Show delivery message if any
        if (deliveryMessage) {
            html += `
                <div style="font-size:0.65rem; color:#64748b; margin-top:2px; padding:4px 8px; background:#f8fafc; border-radius:4px;">
                    📝 ${deliveryMessage}
                </div>
            `;
        }
    }

    // Pickup option (always available)
    html += `
        <div class="shipping-option" onclick="selectDeliveryMethod('pickup')" style="cursor:pointer;">
            <span class="tier-name">📍 Pick up at the shop</span>
            <span class="tier-price">Free</span>
        </div>
    `;

    // Chat to arrange option
    html += `
        <div class="shipping-option" onclick="selectDeliveryMethod('chat')" style="cursor:pointer;">
            <span class="tier-name">💬 Chat to arrange</span>
            <span class="tier-price">Flexible</span>
        </div>
    `;

    container.innerHTML = html;

    // Section H — re-apply the paused state so newly rendered
    // shipping options inherit the correct look.
    if (businessPausedState.onlineOrdersEnabled === false) {
        container.querySelectorAll('.shipping-option').forEach(el => {
            el.style.opacity = '0.55';
            el.style.pointerEvents = 'none';
        });
    }
}

// ============================================================
//  SELECT DELIVERY METHOD
// ============================================================

function selectDeliveryMethod(method) {
    // Section H — refuse to change the method when orders are paused.
    if (businessPausedState.onlineOrdersEnabled === false) return;

    selectedDeliveryMethod = method;
    document.querySelectorAll('.shipping-option').forEach(el => el.classList.remove('selected'));
    const options = document.querySelectorAll('.shipping-option');
    options.forEach(el => {
        if (el.textContent.includes(method === 'delivery' ? '🚚 Delivery' : method === 'pickup' ? '📍 Pick up' : '💬 Chat')) {
            el.classList.add('selected');
        }
    });

    // Show/hide delivery fields
    const deliveryFields = document.getElementById('deliveryFields');
    const pickupFields = document.getElementById('pickupFields');
    const chatFields = document.getElementById('chatFields');

    if (deliveryFields) deliveryFields.style.display = method === 'delivery' ? 'block' : 'none';
    if (pickupFields) pickupFields.style.display = method === 'pickup' ? 'block' : 'none';
    if (chatFields) chatFields.style.display = method === 'chat' ? 'block' : 'none';
}

// ============================================================
//  LOAD ALL PRODUCTS FOR PREVIEW
// ============================================================

function loadAllProductsForPreview() {
    fetch('/api/products')
        .then(res => res.json())
        .then(products => {
            allProductsForPreview = products;
        })
        .catch(err => console.error('Error loading products for preview:', err));
}

// ============================================================
//  PRODUCT PREVIEW MODAL
// ============================================================

function openProductPreview(productId) {
    const modal = document.getElementById('productPreviewModal');
    const content = document.getElementById('previewContent');
    const related = document.getElementById('previewRelated');
    const title = document.getElementById('previewTitle');

    let product = allProductsForPreview.find(p => p.id === productId);
    if (!product) {
        const cartItem = cartItems.find(item => item.id === productId);
        if (cartItem) {
            product = { id: cartItem.id, name: cartItem.name, price: cartItem.price, image: cartItem.image };
        }
    }
    if (!product) {
        content.innerHTML = '<p style="color:#ef4444;">Product not found.</p>';
        return;
    }

    title.textContent = `📦 ${product.name}`;

    const imageHtml = product.image ? `<img src="${product.image}" alt="${product.name}">` : '<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:2rem;">📦</div>';
    const rating = product.rating ? `⭐ ${product.rating}` : '';
    const category = product.category ? `<span class="category">${product.category}</span>` : '';
    const desc = product.description || 'No description available.';

    content.innerHTML = `
        <div class="preview-product">
            <div class="preview-img">${imageHtml}</div>
            <div class="preview-info">
                <div class="name">${product.name}</div>
                <div class="price">${product.price}</div>
                ${rating ? `<div style="font-size:0.75rem; color:#f59e0b;">${rating}</div>` : ''}
                ${category}
                <div class="desc">${desc}</div>
                ${product.stock !== undefined ? `<div style="font-size:0.65rem; color:#64748b;">Stock: ${product.stock}</div>` : ''}
            </div>
        </div>
    `;

    const relatedProducts = allProductsForPreview.filter(p => p.id !== productId).slice(0, 4);
    if (relatedProducts.length > 0) {
        related.innerHTML = relatedProducts.map(p => `
            <div class="related-item" onclick="openProductPreview(${p.id})">
                ${p.image ? `<img src="${p.image}" alt="${p.name}">` : `<div class="no-image">📦</div>`}
                <div class="related-info">
                    <div class="related-name">${p.name}</div>
                    <div class="related-price">${p.price}</div>
                </div>
            </div>
        `).join('');
    } else {
        related.innerHTML = '<p style="font-size:0.75rem; color:#94a3b8;">No related products.</p>';
    }

    modal.classList.add('active');
}

function closeProductPreview() {
    document.getElementById('productPreviewModal').classList.remove('active');
}

// ============================================================
//  REVIEW ALL PRODUCTS MODAL
// ============================================================

function openReviewAllModal() {
    const modal = document.getElementById('reviewAllModal');
    const content = document.getElementById('reviewAllContent');

    const cart = getCart();
    if (!cart || cart.length === 0) {
        content.innerHTML = '<p style="color:#94a3b8;">Your cart is empty.</p>';
        return;
    }

    let html = '';
    cart.forEach(item => {
        const fullProduct = allProductsForPreview.find(p => p.id === item.id);
        const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
        const subtotal = priceNum * item.quantity;
        const imageHtml = item.image ? `<img src="${item.image}" alt="${item.name}">` : '<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#e2e8f0;font-size:1.5rem;">📦</div>';
        const desc = fullProduct?.description || 'No description available.';
        const category = fullProduct?.category ? `<span class="category">${fullProduct.category}</span>` : '';

        html += `
            <div class="preview-product">
                <div class="preview-img">${imageHtml}</div>
                <div class="preview-info">
                    <div class="name">${item.name} ${item.variant_name && item.variant_name !== 'Default' ? `(${item.variant_name})` : ''}</div>
                    <div class="price">${item.price} × ${item.quantity} = <strong style="color:#2563eb;">Ksh ${subtotal.toFixed(2)}</strong></div>
                    ${category}
                    <div class="desc">${desc}</div>
                </div>
            </div>
        `;
    });

    content.innerHTML = html;
    modal.classList.add('active');
}

function closeReviewAll() {
    document.getElementById('reviewAllModal').classList.remove('active');
}

// ============================================================
//  VALIDATE ADDRESS
// ============================================================

function validateAddress() {
    const county = document.getElementById('deliveryCounty').value.trim();
    const subCounty = document.getElementById('deliverySubCounty').value.trim();
    const location = document.getElementById('deliveryAddress').value.trim();

    if (!county) {
        showToast('❌ Please enter your County.', 'error');
        document.getElementById('deliveryCounty').focus();
        return false;
    }
    if (county.length < 2) {
        showToast('❌ Please enter a valid County name.', 'error');
        document.getElementById('deliveryCounty').focus();
        return false;
    }
    if (!subCounty) {
        showToast('❌ Please enter your Sub-County or Constituency.', 'error');
        document.getElementById('deliverySubCounty').focus();
        return false;
    }
    if (subCounty.length < 2) {
        showToast('❌ Please enter a valid Sub-County or Constituency.', 'error');
        document.getElementById('deliverySubCounty').focus();
        return false;
    }
    if (!location) {
        showToast('❌ Please tell us the specific location and directions.', 'error');
        document.getElementById('deliveryAddress').focus();
        return false;
    }
    if (location.length < 5) {
        showToast('❌ Please give more details about your location and directions.', 'error');
        document.getElementById('deliveryAddress').focus();
        return false;
    }
    return true;
}

// ============================================================
//  CART RENDER
// ============================================================

function renderCartPage() {
    const cart = getCart();
    const container = document.getElementById('cartItemsContainer');
    const checkoutSections = document.getElementById('checkoutSections');

    if (!cart || cart.length === 0) {
        container.innerHTML = `<div class="cart-empty"><i class="fas fa-shopping-cart"></i><h2>Your cart is empty</h2><p>Looks like you haven't added any items yet.</p><a href="/" class="btn btn-primary" style="padding:10px 24px; border-radius:8px; background:#2563eb; color:white; text-decoration:none; font-weight:600; display:inline-block;">Start Shopping</a></div>`;
        checkoutSections.style.display = 'none';
        return;
    }

    checkoutSections.style.display = 'block';
    cartItems = cart;

    // Check if all items are from the same business
    const businessIds = [...new Set(cart.map(item => item.business_id))];
    if (businessIds.length > 1) {
        showToast('⚠️ You have items from different shops. Please order from one shop at a time.', 'warning');
        document.getElementById('placeOrderBtn').disabled = true;
        document.getElementById('placeOrderBtn').innerHTML = '<i class="fas fa-exclamation-triangle"></i> Multiple Shops';
    } else if (businessIds.length === 1) {
        document.getElementById('placeOrderBtn').disabled = false;
        document.getElementById('placeOrderBtn').innerHTML = '<i class="fas fa-check-circle"></i> Place Order';
        currentBusinessId = businessIds[0];
        loadBusinessSettings(currentBusinessId);
    }

    let html = '';
    let total = 0;
    cart.forEach(item => {
        const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
        const subtotal = priceNum * item.quantity;
        total += subtotal;
        const variantName = item.variant_name && item.variant_name !== 'Default' ? ` (${item.variant_name})` : '';
        const imageUrl = item.image || '';

        html += `
            <div class="cart-item" data-id="${item.id}">
                <div class="product-image" onclick="openProductPreview(${item.id})">
                    <img src="${imageUrl}" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2280%22 viewBox=%220 0 80 80%22%3E%3Crect width=%2280%22 height=%2280%22 fill=%22%23e2e8f0%22/%3E%3Ctext x=%2240%22 y=%2245%22 font-family=%22sans-serif%22 font-size=%2220%22 text-anchor=%22middle%22 fill=%22%2394a3b8%22%3E📦%3C/text%3E%3C/svg%3E'">
                </div>
                <div class="details">
                    <div class="name" onclick="openProductPreview(${item.id})">${item.name}${variantName}</div>
                    <div class="price">${item.price}</div>
                    ${item.business_id ? `<div style="font-size:0.55rem; color:#94a3b8;">Shop ID: ${item.business_id}</div>` : ''}
                </div>
                <div class="qty-control">
                    <button onclick="updateCartQty(${item.id}, -1)">−</button>
                    <span>${item.quantity}</span>
                    <button onclick="updateCartQty(${item.id}, 1)">+</button>
                </div>
                <div class="subtotal">Ksh ${subtotal.toFixed(2)}</div>
                <button class="remove-btn" onclick="removeItemFromCart(${item.id})"><i class="fas fa-trash"></i></button>
            </div>
        `;
    });
    container.innerHTML = html;
    updateShippingOptions(total);
    applyPromo();
    updateSummary(total);

    // Section H — re-apply the paused state after the cart re-renders
    // so the disabled look survives quantity changes.
    if (businessPausedState.onlineOrdersEnabled === false) {
        applyCartPausedState();
    }
}

function updateSummary(total) {
    const subtotal = total;
    const shipping = shippingCost;
    const discount = promoDiscount;
    const grandTotal = subtotal + shipping - discount;
    document.getElementById('subtotalPrice').textContent = `Ksh ${subtotal.toFixed(2)}`;
    document.getElementById('shippingPrice').textContent = `Ksh ${shipping.toFixed(2)}`;
    document.getElementById('cartTotal').textContent = `Ksh ${grandTotal.toFixed(2)}`;
    if (discount > 0) {
        document.getElementById('discountSummaryRow').style.display = 'flex';
        document.getElementById('discountAmount').textContent = `-Ksh ${discount.toFixed(2)}`;
    } else {
        document.getElementById('discountSummaryRow').style.display = 'none';
    }
    paymentTotal = grandTotal;
}

function calculateSubtotal() {
    let total = 0;
    cartItems.forEach(item => {
        const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
        total += priceNum * item.quantity;
    });
    return total;
}

// ============================================================
//  SHIPPING
// ============================================================

function getShippingTiers(subtotal) {
    let standard, express, overnight;
    if (subtotal >= FREE_SHIPPING_THRESHOLD) {
        standard = 0; express = 250; overnight = 350;
    } else if (subtotal >= 10000) {
        standard = 150; express = 250; overnight = 300;
    } else if (subtotal >= 2000) {
        standard = 120; express = 200; overnight = 250;
    } else if (subtotal >= 500) {
        standard = 80; express = 150; overnight = 200;
    } else {
        standard = 50; express = 100; overnight = 150;
    }
    return { standard, express, overnight };
}

function updateShippingOptions(subtotal) {
    const container = document.getElementById('shippingOptions');
    const banner = document.getElementById('freeShippingBanner');
    const freeShipping = subtotal >= FREE_SHIPPING_THRESHOLD;

    if (freeShipping) {
        banner.style.display = 'block';
        selectedShippingTier = 'standard';
        shippingCost = 0;
    } else {
        banner.style.display = 'none';
    }

    const prices = getShippingTiers(subtotal);
    const tiers = [
        { id: 'standard', label: 'Standard (3-5 days)', price: freeShipping ? 0 : prices.standard },
        { id: 'express', label: 'Express (1-2 days)', price: freeShipping ? 0 : prices.express },
        { id: 'overnight', label: 'Overnight (Next Day)', price: freeShipping ? 0 : prices.overnight }
    ];

    let html = '';
    tiers.forEach(tier => {
        if (freeShipping && tier.id !== 'standard') {
            html += `
                <div class="shipping-option disabled" style="opacity:0.5; cursor:not-allowed;">
                    <span class="tier-name">${tier.label}</span>
                    <span class="tier-price">Free</span>
                </div>
            `;
            return;
        }
        const selected = selectedShippingTier === tier.id ? 'selected' : '';
        const priceDisplay = tier.price === 0 ? 'Free' : `Ksh ${tier.price.toFixed(2)}`;
        html += `
            <div class="shipping-option ${selected}" onclick="selectShippingTier('${tier.id}', ${tier.price})">
                <span class="tier-name">${tier.label}</span>
                <span class="tier-price">${priceDisplay}</span>
            </div>
        `;
    });
    container.innerHTML = html;
}

function selectShippingTier(tier, price) {
    // Section H — refuse to change the tier when orders are paused.
    if (businessPausedState.onlineOrdersEnabled === false) {
        showToast('⚠️ This shop is not taking orders at the moment.', 'warning');
        return;
    }
    selectedShippingTier = tier;
    shippingCost = price;
    updateSummary(calculateSubtotal());
    updateShippingOptions(calculateSubtotal());
}

// ============================================================
//  PROMO CODE
// ============================================================

function applyPromo() {
    // Section H — refuse to apply a promo when orders are paused.
    if (businessPausedState.onlineOrdersEnabled === false) {
        const msgEl = document.getElementById('promoMessage');
        if (msgEl) {
            msgEl.textContent = '⚠️ Orders are paused — promo cannot be used right now.';
            msgEl.style.color = '#f59e0b';
        }
        return;
    }

    const input = document.getElementById('promoInput');
    const code = input.value.trim();
    const msgEl = document.getElementById('promoMessage');
    if (!code) { promoDiscount = 0; msgEl.textContent = ''; updateSummary(calculateSubtotal()); return; }
    fetch('/api/promo/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, subtotal: calculateSubtotal() })
    })
        .then(res => res.json())
        .then(data => {
            if (data.valid) {
                promoDiscount = data.discount;
                msgEl.textContent = '✅ Promo applied!';
                msgEl.style.color = '#16a34a';
            } else {
                promoDiscount = 0;
                msgEl.textContent = '❌ ' + data.message;
                msgEl.style.color = '#ef4444';
            }
            updateSummary(calculateSubtotal());
        })
        .catch(() => {
            promoDiscount = 0;
            msgEl.textContent = 'Error checking the promo code.';
            updateSummary(calculateSubtotal());
        });
}

// ============================================================
//  CART ACTIONS
// ============================================================

function updateCartQty(id, delta) {
    const cart = getCart();
    const item = cart.find(i => i.id === id);
    if (!item) return;
    item.quantity = Math.max(1, item.quantity + delta);
    saveCart(cart);
    renderCartPage();
    updateCartBadge();
}

function removeItemFromCart(id) {
    let cart = getCart();
    cart = cart.filter(i => i.id !== id);
    saveCart(cart);
    renderCartPage();
    updateCartBadge();
}

// ============================================================
//  PLACE ORDER - COMPLETE WITH BUSINESS VALIDATION
// ============================================================

async function placeOrder() {
    if (!isLoggedIn()) {
        showToast('❌ Please login to place an order', 'warning');
        openAuthModal('login');
        return;
    }

    const cart = getCart();
    if (!cart || cart.length === 0) {
        showToast('❌ Your cart is empty', 'error');
        return;
    }

    // Check if all items belong to the same business
    const businessIds = [...new Set(cart.map(item => item.business_id))];
    if (businessIds.length > 1) {
        showToast('❌ Please order from one shop at a time. Items from different shops cannot be combined.', 'error');
        return;
    }

    const businessId = businessIds[0];
    if (!businessId) {
        showToast('❌ Something is wrong with this shop. Please add your items to the cart again.', 'error');
        return;
    }

    // Section H — check if the business is accepting online orders.
    // The response now also carries the custom message, so we refresh
    // the paused state and the UI in one go.
    try {
        const statusRes = await fetch(`/api/businesses/${businessId}/status`);
        if (statusRes.ok) {
            const status = await statusRes.json();
            businessPausedState.onlineOrdersEnabled = status.online_orders_enabled !== false;
            businessPausedState.orderDisabledMessage = status.order_disabled_message || '';

            if (businessPausedState.onlineOrdersEnabled === false) {
                applyCartPausedState();
                const message = String(businessPausedState.orderDisabledMessage || '').trim() ||
                    DEFAULT_ORDERS_PAUSED_MESSAGE;
                showToast('❌ ' + message, 'error');
                return;
            }
        }
    } catch (err) {
        console.error('Error checking business status:', err);
    }

    // Section I.7 — if the business has no payment method configured
    // at all, block the order with a clear message instead of leaving
    // the customer stuck on the payment modal.
    if (
        businessPaymentSettings &&
        !businessPaymentSettings.mpesa_enabled &&
        !businessPaymentSettings.airtel_enabled &&
        !businessPaymentSettings.bank_enabled &&
        !businessPaymentSettings.paypal_enabled
    ) {
        showToast('❌ ' + getMpesaFallbackMessage(businessPaymentSettings), 'error');
        return;
    }

    if (!validateAddress()) return;

    const county = document.getElementById('deliveryCounty').value.trim();
    const subCounty = document.getElementById('deliverySubCounty').value.trim();
    const location = document.getElementById('deliveryAddress').value.trim();
    const fullAddress = `${location}, ${subCounty}, ${county}`;

    let subtotal = 0;
    cart.forEach(item => {
        const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
        subtotal += priceNum * item.quantity;
    });

    // Get delivery settings
    let deliveryFee = 0;
    let deliveryMethod = selectedDeliveryMethod || 'pickup';

    if (businessDeliverySettings && businessDeliverySettings.delivery_enabled && deliveryMethod === 'delivery') {
        const isFree = businessDeliverySettings.delivery_min_order_free > 0 &&
                      subtotal >= businessDeliverySettings.delivery_min_order_free;
        if (!isFree) {
            if (businessDeliverySettings.delivery_fee_type === 'fixed') {
                deliveryFee = parseFloat(businessDeliverySettings.delivery_fee_fixed) || 0;
            } else if (businessDeliverySettings.delivery_fee_type === 'per_km') {
                deliveryFee = parseFloat(businessDeliverySettings.delivery_fee_per_km) || 0;
            }
        }
    }

    const shipping = shippingCost || 0;
    const discount = promoDiscount || 0;
    const grandTotal = subtotal + shipping + deliveryFee - discount;

    if (grandTotal <= 0) {
        showToast('❌ The total amount is not valid. Please check your cart.', 'error');
        return;
    }

    const items = cart.map(item => ({
        productId: item.id,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
        image: item.image || '',
        variant_name: item.variant_name || 'Default',
        variant_id: item.variant_id || null
    }));

    const deliveryInstructions = document.getElementById('deliveryInstructions')?.value?.trim() || '';
    const orderNotes = document.getElementById('orderNotes')?.value?.trim() || '';
    const promoCode = document.getElementById('promoInput')?.value?.trim() || '';
    const user = window.currentUser;
    const recipientName = user?.name || '';
    const recipientPhone = user?.phone || '';
    const token = window.customerToken;

    if (!token) {
        showToast('❌ Please login first', 'error');
        return;
    }

    const btn = document.getElementById('placeOrderBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    fetch('/api/orders', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            items,
            business_id: businessId,
            shipping_tier: selectedShippingTier || 'standard',
            order_notes: orderNotes,
            promo_code: promoCode,
            delivery_address: fullAddress,
            recipient_name: recipientName,
            recipient_phone: recipientPhone,
            delivery_instructions: deliveryInstructions,
            customer_lat: document.getElementById('customerLat')?.value || null,
            customer_lng: document.getElementById('customerLng')?.value || null,
            location_accuracy: document.getElementById('locationAccuracy')?.value || null,
            delivery_method: deliveryMethod,
            delivery_fee: deliveryFee
        }),
        signal: controller.signal
    })
    .then(response => {
        clearTimeout(timeoutId);
        if (!response.ok) {
            return response.json().then(data => {
                throw new Error(data.error || 'Order creation failed');
            });
        }
        return response.json();
    })
    .then(data => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check-circle"></i> Place Order';

        if (data.success) {
            pendingOrderId = data.order.id;
            window.pendingOrderId = data.order.id;
            showToast('✅ Order created! Please complete payment.', 'success');

            openPaymentModal(grandTotal, data.order.id);
            clearCart();
        } else {
            showToast('❌ Could not create the order: ' + (data.error || 'Please try again.'), 'error');
        }
    })
    .catch(error => {
        clearTimeout(timeoutId);
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check-circle"></i> Place Order';
        let errorMsg = error.message || 'Network error. Please try again.';
        if (error.name === 'AbortError') {
            errorMsg = 'The request took too long. Please check your connection and try again.';
        }
        showToast('❌ ' + errorMsg, 'error');
    });
}

// ============================================================
//  PAYMENT - COMPLETE
// ============================================================

function selectPaymentMethod(method) {
    // Section H — refuse to open a payment method when paused.
    if (businessPausedState.onlineOrdersEnabled === false) {
        showToast('⚠️ This shop is not taking orders at the moment.', 'warning');
        return;
    }

    selectedPaymentMethod = method;
    document.querySelectorAll('.method').forEach(el => el.classList.remove('selected'));
    const selectedEl = document.querySelector(`.method[onclick="selectPaymentMethod('${method}')"]`);
    if (selectedEl) selectedEl.classList.add('selected');

    document.getElementById('paymentDetails').style.display = 'block';
    document.getElementById('phoneField').style.display = method === 'mpesa' || method === 'airtel' ? 'block' : 'none';
    document.getElementById('bankField').style.display = method === 'bank' ? 'block' : 'none';
    document.getElementById('paypalField').style.display = method === 'paypal' ? 'block' : 'none';

    const payBtn = document.getElementById('payNowBtn');
    if (payBtn) {
        if (method === 'mpesa') {
            const label = getMpesaLabel(businessPaymentSettings);
            payBtn.textContent = label ? `📱 Pay with ${label.title}` : '📱 Pay with M-Pesa';
            payBtn.onclick = processPayment;
            payBtn.disabled = false;
        } else if (method === 'airtel') {
            payBtn.textContent = '📱 Pay with Airtel Money';
            payBtn.onclick = processPayment;
            payBtn.disabled = false;
        } else if (method === 'paypal') {
            payBtn.textContent = '💳 Pay with PayPal';
            payBtn.onclick = processPayment;
            payBtn.disabled = false;
        } else {
            payBtn.textContent = '💳 Pay Now';
            payBtn.onclick = processPayment;
            payBtn.disabled = false;
        }
    }
}

function openPaymentModal(amount, orderId) {
    paymentTotal = amount;
    pendingOrderId = orderId;
    document.getElementById('paymentTotal').textContent = `Ksh ${amount.toFixed(2)}`;
    document.getElementById('paymentModal').classList.add('active');
    document.getElementById('paymentDetails').style.display = 'block';
    document.getElementById('phoneField').style.display = 'block';
    document.getElementById('bankField').style.display = 'none';
    document.getElementById('paypalField').style.display = 'none';
    document.getElementById('paymentStatus').textContent = '';

    const user = window.currentUser;
    if (user && user.phone) {
        document.getElementById('paymentPhone').value = user.phone;
    }

    const payBtn = document.getElementById('payNowBtn');
    if (payBtn) {
        payBtn.disabled = false;
        const label = getMpesaLabel(businessPaymentSettings);
        payBtn.innerHTML = label ? `📱 Pay with ${label.title}` : '📱 Pay with M-Pesa';
        payBtn.onclick = processPayment;
    }
    selectPaymentMethod('mpesa');
}

function closePaymentModal() {
    document.getElementById('paymentModal').classList.remove('active');
    if (mpesaPollingInterval) {
        clearInterval(mpesaPollingInterval);
        mpesaPollingInterval = null;
    }
    if (airtelPollingInterval) {
        clearInterval(airtelPollingInterval);
        airtelPollingInterval = null;
    }
}

// ============================================================
//  PROCESS PAYMENT - COMPLETE
// ============================================================

function processPayment() {
    // Section H — refuse to process a payment when the business
    // has paused orders.
    if (businessPausedState.onlineOrdersEnabled === false) {
        const statusEl = document.getElementById('paymentStatus');
        if (statusEl) {
            statusEl.className = 'payment-status error';
            statusEl.style.display = 'block';
            statusEl.textContent = '❌ This shop is not taking orders at the moment.';
        }
        showToast('⚠️ This shop is not taking orders at the moment.', 'warning');
        return;
    }

    const method = selectedPaymentMethod;
    if (!method) {
        showToast('❌ Please pick a payment method', 'error');
        return;
    }

    const payBtn = document.getElementById('payNowBtn');
    const statusEl = document.getElementById('paymentStatus');
    statusEl.className = 'payment-status loading';
    statusEl.style.display = 'block';
    statusEl.textContent = '⏳ Processing payment...';
    payBtn.disabled = true;

    if (method === 'mpesa') {
        // Section I.7 — refuse to start a payment that cannot be
        // completed, with a clear message.
        const mpesaLabel = getMpesaLabel(businessPaymentSettings);
        if (!mpesaLabel) {
            statusEl.className = 'payment-status error';
            statusEl.textContent = '❌ ' + getMpesaFallbackMessage(businessPaymentSettings);
            payBtn.disabled = false;
            return;
        }

        const phone = document.getElementById('paymentPhone').value.trim();
        if (!phone) {
            statusEl.className = 'payment-status error';
            statusEl.textContent = '❌ Please enter your phone number.';
            payBtn.disabled = false;
            return;
        }
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        if (cleanPhone.length < 10) {
            statusEl.className = 'payment-status error';
            statusEl.textContent = '❌ Please enter a valid phone number.';
            payBtn.disabled = false;
            return;
        }

        const token = window.customerToken;

        fetch('/api/payments/mpesa/initiate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                phone: cleanPhone,
                amount: paymentTotal,
                orderId: pendingOrderId,
                // Section I.5 — forward the business's chosen type and
                // shortcode so the payment record carries the correct
                // transaction type, shortcode, and account reference.
                payment_type: mpesaLabel.type,
                shortcode: mpesaLabel.shortcode || null,
                account_reference: mpesaLabel.accountReference || null
            })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                statusEl.className = 'payment-status success';
                statusEl.textContent = '📱 STK Push sent! Please check your phone and enter PIN.';
                payBtn.disabled = false;

                if (data.checkoutRequestId && !data.isSimulation) {
                    startMpesaPolling(data.checkoutRequestId);
                } else if (data.isSimulation) {
                    statusEl.textContent = '📱 Test mode: Payment will go through in 10 seconds...';
                    setTimeout(() => {
                        statusEl.className = 'payment-status success';
                        statusEl.textContent = '✅ Payment successful! (Test mode)';
                        setTimeout(() => {
                            closePaymentModal();
                            window.location.href = `/order-tracking.html?id=${pendingOrderId}`;
                        }, 1500);
                    }, 10000);
                }
            } else {
                statusEl.className = 'payment-status error';
                statusEl.textContent = '❌ ' + (data.message || 'Payment could not start. Please try again.');
                payBtn.disabled = false;
            }
        })
        .catch(err => {
            statusEl.className = 'payment-status error';
            statusEl.textContent = '❌ Network error. Please try again.';
            payBtn.disabled = false;
            console.error('M-Pesa initiate error:', err);
        });
    } else if (method === 'airtel') {
        const phone = document.getElementById('paymentPhone').value.trim();
        if (!phone) {
            statusEl.className = 'payment-status error';
            statusEl.textContent = '❌ Please enter your phone number.';
            payBtn.disabled = false;
            return;
        }
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        if (cleanPhone.length < 10) {
            statusEl.className = 'payment-status error';
            statusEl.textContent = '❌ Please enter a valid phone number.';
            payBtn.disabled = false;
            return;
        }

        const token = window.customerToken;

        fetch('/api/payments/airtel/initiate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                phone: cleanPhone,
                amount: paymentTotal,
                orderId: pendingOrderId
            })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                statusEl.className = 'payment-status success';
                statusEl.textContent = '📱 Airtel Money request sent! Please check your phone.';
                payBtn.disabled = false;

                if (data.isSimulation) {
                    setTimeout(() => {
                        statusEl.className = 'payment-status success';
                        statusEl.textContent = '✅ Payment successful! (Test mode)';
                        setTimeout(() => {
                            closePaymentModal();
                            window.location.href = `/order-tracking.html?id=${pendingOrderId}`;
                        }, 1500);
                    }, 10000);
                }
            } else {
                statusEl.className = 'payment-status error';
                statusEl.textContent = '❌ ' + (data.message || 'Payment failed. Please try again.');
                payBtn.disabled = false;
            }
        })
        .catch(err => {
            statusEl.className = 'payment-status error';
            statusEl.textContent = '❌ Network error. Please try again.';
            payBtn.disabled = false;
            console.error('Airtel initiate error:', err);
        });
    } else if (method === 'paypal') {
        const token = window.customerToken;

        fetch('/api/payments/paypal/create-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                amount: paymentTotal,
                orderId: pendingOrderId
            })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                if (data.isSimulation) {
                    statusEl.className = 'payment-status success';
                    statusEl.textContent = '✅ PayPal test payment successful!';
                    payBtn.disabled = false;
                    setTimeout(() => {
                        closePaymentModal();
                        window.location.href = `/order-tracking.html?id=${pendingOrderId}`;
                    }, 2000);
                } else if (data.approvalUrl) {
                    window.location.href = data.approvalUrl;
                }
            } else {
                statusEl.className = 'payment-status error';
                statusEl.textContent = '❌ ' + (data.message || 'Payment failed. Please try again.');
                payBtn.disabled = false;
            }
        })
        .catch(err => {
            statusEl.className = 'payment-status error';
            statusEl.textContent = '❌ Network error. Please try again.';
            payBtn.disabled = false;
            console.error('PayPal error:', err);
        });
    } else if (method === 'bank') {
        statusEl.className = 'payment-status success';
        statusEl.textContent = '💳 Bank transfer details sent! Please complete payment and we will check it.';
        payBtn.disabled = false;

        fetch('/api/shop')
            .then(res => res.json())
            .then(shop => {
                if (shop.bank_enabled && shop.bank_name) {
                    statusEl.textContent += `\n\n🏦 Bank: ${shop.bank_name}\n📋 Account: ${shop.bank_account || 'N/A'}\n👤 Holder: ${shop.bank_account_name || 'N/A'}`;
                }
            })
            .catch(() => {});
    }
}

// ============================================================
//  START MPESA POLLING
// ============================================================

function startMpesaPolling(checkoutRequestId) {
    if (mpesaPollingInterval) {
        clearInterval(mpesaPollingInterval);
        mpesaPollingInterval = null;
    }

    let attempts = 0;
    const maxAttempts = 60;
    const statusEl = document.getElementById('paymentStatus');

    mpesaPollingInterval = setInterval(async () => {
        attempts++;

        try {
            const token = window.customerToken;
            const response = await fetch(`/api/payments/mpesa/status/${checkoutRequestId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await response.json();

            if (data.data && data.data.ResultCode !== undefined) {
                clearInterval(mpesaPollingInterval);
                mpesaPollingInterval = null;

                if (data.data.ResultCode === '0') {
                    statusEl.className = 'payment-status success';
                    statusEl.textContent = '✅ Payment successful! Order confirmed.';
                    showToast('✅ Payment successful! Order confirmed.', 'success');
                    setTimeout(() => {
                        closePaymentModal();
                        window.location.href = `/order-tracking.html?id=${pendingOrderId}`;
                    }, 2000);
                } else {
                    statusEl.className = 'payment-status error';
                    statusEl.textContent = '❌ Payment failed: ' + (data.data.ResultDesc || 'Please try again.');
                    showToast('❌ Payment failed. Please try again.', 'error');
                }
            }

            if (attempts >= maxAttempts) {
                clearInterval(mpesaPollingInterval);
                mpesaPollingInterval = null;
                statusEl.className = 'payment-status warning';
                statusEl.textContent = '⏳ Payment is taking longer than usual. Please check your order status.';
                showToast('⏳ Payment pending. Check your order status.', 'warning');
            }
        } catch (error) {
            console.error('Polling error:', error);
            if (attempts >= maxAttempts) {
                clearInterval(mpesaPollingInterval);
                mpesaPollingInterval = null;
            }
        }
    }, 5000);
}

function startAirtelPolling(transactionId) {
    if (airtelPollingInterval) {
        clearInterval(airtelPollingInterval);
        airtelPollingInterval = null;
    }

    let attempts = 0;
    const maxAttempts = 60;
    const statusEl = document.getElementById('paymentStatus');

    airtelPollingInterval = setInterval(async () => {
        attempts++;

        try {
            const token = window.customerToken;
            const response = await fetch(`/api/payments/airtel/status/${transactionId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await response.json();

            if (data.data && data.data.status) {
                const status = data.data.status;
                if (status === 'success' || status === 'completed' || status === 'SUCCESS' || status === 'APPROVED') {
                    clearInterval(airtelPollingInterval);
                    airtelPollingInterval = null;
                    statusEl.className = 'payment-status success';
                    statusEl.textContent = '✅ Payment successful!';
                    showToast('✅ Payment successful! Order confirmed.', 'success');
                    setTimeout(() => {
                        closePaymentModal();
                        window.location.href = `/order-tracking.html?id=${pendingOrderId}`;
                    }, 2000);
                } else if (status === 'failed' || status === 'FAILED' || status === 'REJECTED') {
                    clearInterval(airtelPollingInterval);
                    airtelPollingInterval = null;
                    statusEl.className = 'payment-status error';
                    statusEl.textContent = '❌ Payment failed. Please try again.';
                    showToast('❌ Payment failed. Please try again.', 'error');
                }
            }
            if (attempts >= maxAttempts) {
                clearInterval(airtelPollingInterval);
                airtelPollingInterval = null;
                statusEl.className = 'payment-status warning';
                statusEl.textContent = '⏳ Payment is taking longer than usual. Please check your order status.';
                showToast('⏳ Payment pending. Check your order status.', 'warning');
            }
        } catch (error) {
            console.error('Polling error:', error);
            if (attempts >= maxAttempts) {
                clearInterval(airtelPollingInterval);
                airtelPollingInterval = null;
            }
        }
    }, 5000);
}

// ============================================================
//  BANK SEARCH
// ============================================================

function populateBankDropdown() {
    const dropdown = document.getElementById('bankDropdown');
    dropdown.innerHTML = kenyanBanks.map(b =>
        `<div class="bank-item" onclick="selectBank('${b}')">${b}</div>`
    ).join('');
}

function filterBanks() {
    const query = document.getElementById('bankSearch').value.toLowerCase();
    const dropdown = document.getElementById('bankDropdown');
    const items = dropdown.querySelectorAll('.bank-item');
    let hasVisible = false;
    items.forEach(el => {
        const name = el.textContent.toLowerCase();
        if (name.includes(query)) {
            el.style.display = 'block';
            hasVisible = true;
        } else {
            el.style.display = 'none';
        }
    });
    dropdown.classList.toggle('show', hasVisible || query.length > 0);
}

function selectBank(bank) {
    document.getElementById('bankSearch').value = bank;
    document.getElementById('selectedBank').value = bank;
    document.getElementById('bankDropdown').classList.remove('show');
}

// ============================================================
//  TIMER
// ============================================================

function startReservationTimer() {
    if (getCart().length === 0) { document.getElementById('stockTimer').style.display = 'none'; return; }
    document.getElementById('stockTimer').style.display = 'inline-block';
    let timeLeft = reservationTime;
    const timerDisplay = document.getElementById('timerDisplay');
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeLeft--;
        const mins = Math.floor(timeLeft / 60);
        const secs = timeLeft % 60;
        timerDisplay.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            showToast('⏳ Your reserved time has ended. Please refresh your cart.', 'warning');
        }
    }, 1000);
}

// ============================================================
//  RECOMMENDED
// ============================================================

function loadProductRecommendationsLegacy() {
    fetch('/api/products?limit=6')
        .then(res => res.json())
        .then(products => {
            const container = document.getElementById('recommendedGrid');
            if (!container) return;
            container.innerHTML = products.slice(0, 6).map(p => `
                <div class="related-item" onclick="location.href='/product-detail.html?id=${p.id}'">
                    ${p.image ? `<img src="${p.image}" alt="${p.name}">` : `<div class="no-image">📦</div>`}
                    <div class="related-info">
                        <div class="related-name">${p.name}</div>
                        <div class="related-price">${p.price}</div>
                    </div>
                </div>
            `).join('');
        })
        .catch(() => {});
}

// The empty cart is a discovery screen. Recommend businesses, not products,
// so a customer explicitly chooses a shop before browsing its catalogue.
function loadRecommended() {
    fetch('/api/businesses?limit=6&sort=popular')
        .then(res => {
            if (!res.ok) throw new Error('Could not load businesses');
            return res.json();
        })
        .then(data => {
            const container = document.getElementById('recommendedGrid');
            if (!container) return;
            const businesses = Array.isArray(data.businesses) ? data.businesses : [];
            if (businesses.length === 0) {
                container.innerHTML = '<p style="color:#64748b;font-size:.8rem;">No shops are available right now.</p>';
                return;
            }
            container.innerHTML = businesses.slice(0, 6).map(business => `
                <a class="business-recommendation-card" href="/business/${encodeURIComponent(business.slug)}">
                    ${business.logo
                        ? `<img src="${business.logo}" alt="${business.business_name}" loading="lazy">`
                        : '<div class="business-recommendation-image">Shop</div>'}
                    <div class="business-recommendation-info">
                        <div class="business-recommendation-name">${business.business_name}</div>
                        <div class="business-recommendation-location">${business.location || 'Kenya'}</div>
                        <div class="business-recommendation-meta">
                            <span>★ ${Number(business.avg_rating || 0).toFixed(1)}</span>
                            <span>${business.product_count || 0} products</span>
                        </div>
                    </div>
                </a>
            `).join('');
        })
        .catch(() => {
            const container = document.getElementById('recommendedGrid');
            if (container) container.innerHTML = '<p style="color:#64748b;font-size:.8rem;">Unable to load shops right now.</p>';
        });
}

// ============================================================
//  LOAD SHOP PROFILE
// ============================================================

async function loadShopProfile() {
    try {
        const res = await fetch('/api/shop');
        if (!res.ok) throw new Error('Failed to load shop');
        const shop = await res.json();
        const nameHeader = document.getElementById('shopNameHeader');
        if (nameHeader) nameHeader.textContent = shop.name || 'Our Business';
    } catch (err) {
        console.error('Error loading shop profile:', err);
    }
}

// ============================================================
//  EXPOSE GLOBALS
// ============================================================

window.renderCartPage = renderCartPage;
window.updateCartQty = updateCartQty;
window.removeItemFromCart = removeItemFromCart;
window.placeOrder = placeOrder;
window.selectShippingTier = selectShippingTier;
window.applyPromo = applyPromo;
window.selectPaymentMethod = selectPaymentMethod;
window.processPayment = processPayment;
window.closePaymentModal = closePaymentModal;
window.filterBanks = filterBanks;
window.selectBank = selectBank;
window.openProductPreview = openProductPreview;
window.closeProductPreview = closeProductPreview;
window.openReviewAllModal = openReviewAllModal;
window.closeReviewAll = closeReviewAll;
window.populateBankDropdown = populateBankDropdown;
window.startMpesaPolling = startMpesaPolling;
window.startAirtelPolling = startAirtelPolling;
window.loadShopProfile = loadShopProfile;
window.selectDeliveryMethod = selectDeliveryMethod;
window.loadBusinessSettings = loadBusinessSettings;

// Section I exposures so any future UI (e.g. tracking page) can
// reuse the same label and fallback logic without duplicating it.
window.getMpesaLabel = getMpesaLabel;
window.getMpesaFallbackMessage = getMpesaFallbackMessage;

// Section H exposure so other surfaces (e.g. tracking) can reuse
// the same paused-state helper.
window.applyCartPausedState = applyCartPausedState;

console.log('✅ Cart page initialized successfully');