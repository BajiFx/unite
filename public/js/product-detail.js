// ============================================================
//  PRODUCT DETAIL JAVASCRIPT
//
//  Section B (B.7) additions:
//   - Related products are scoped to the same product_category_id.
//   - The product's defined category is rendered as a chip.
//   - The related filter dropdown now surfaces defined product
//     categories alongside the legacy free-text categories.
//
//  Reviews removal (this revision):
//   The customer-facing write-a-review form and the reviews list
//   have been removed from the page. A warm thank-you band takes
//   their place. The band's business name is injected here by
//   renderThankYouBand() so it feels personal. The review tables
//   and routes remain in the backend, untouched; only the
//   customer-facing surface is gone.
//
//   The aggregate star rating in the product info section is a
//   different feature and is intentionally kept.
// ============================================================

const urlParams = new URLSearchParams(window.location.search);
const productId = urlParams.get('id');
if (!productId) {
  document.getElementById('detailContent').innerHTML = '<p style="color:#ef4444;">Product ID missing.</p>';
}

let detailQty = 1;
let currentVariantId = null;
let currentMediaIndex = 0;
let currentProduct = null;
let allVariants = [];

function fallbackMediaUrl(product) {
  if (product.image) return product.image;
  const label = String(product.name || 'Product').slice(0, 32).replace(/[<>&]/g, '');
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#e2e8f0"/><text x="50%" y="46%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="34" fill="#475569">Product image</text><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="24" fill="#64748b">${label}</text></svg>`)}`;
}

// ============================================================
//  FETCH SHOP DATA
// ============================================================
async function fetchShopData() {
  try {
    const res = await fetch('/api/shop');
    if (!res.ok) throw new Error('Failed to load shop');
    shopData = await res.json();
  } catch (err) {
    console.error('Error loading shop:', err);
    shopData = {};
  }
}

// ============================================================
//  GET AUTO SOCIAL LINKS
// ============================================================
function getAutoSocialLinks(product) {
  const shop = product || {};
  const productName = product.name || 'this product';
  const productPrice = product.price ? ` (${product.price})` : '';
  const message = `Hi, I'm interested in "${productName}"${productPrice}. Could I get more information about this product?`;
  const encodedMessage = encodeURIComponent(message);
  const whatsappNumber = shop.business_whatsapp || '';
  const instagramUser = shop.business_instagram || '';
  const facebookUser = shop.business_facebook || '';
  const tiktokUser = shop.business_tiktok || '';
  const phone = shop.business_phone || '';
  const cleanedWhatsapp = whatsappNumber.replace(/[^0-9]/g, '');
  return {
    whatsapp: cleanedWhatsapp ? `https://wa.me/${cleanedWhatsapp}?text=${encodedMessage}` : '#',
    instagram: instagramUser ? `https://www.instagram.com/${instagramUser.replace('@', '').trim()}/` : '#',
    messenger: facebookUser ? `https://m.me/${facebookUser.replace('@', '').trim()}?text=${encodedMessage}` : '#',
    tiktok: tiktokUser ? `https://www.tiktok.com/@${tiktokUser.replace('@', '').trim()}` : '#',
    phone: phone ? `tel:${phone}` : '#'
  };
}

// ============================================================
//  LOAD PRODUCT DETAIL
// ============================================================
async function loadProductDetail() {
  try {
    const res = await fetch(`/api/products/${productId}/detail`);
    if (!res.ok) throw new Error('Product not found');
    const data = await res.json();
    currentProduct = data.product;
    allVariants = data.variants || [];

    if (allVariants.length === 0) {
      allVariants = [{
        id: null,
        name: 'Default',
        price: data.product.price,
        stock: 999,
        image: data.product.image || ''
      }];
    }

    currentVariantId = allVariants[0].id;

    // B.7 — when this product has a defined category, prefer related products
    // from the same category so the customer sees "more like this".
    let related = data.related || [];
    const sameCategoryId = data.product && data.product.product_category_id;
    if (sameCategoryId) {
      const filtered = related.filter(r => r.product_category_id === sameCategoryId);
      if (filtered.length > 0) related = filtered;
    }

    renderDetail(data.product, related);
  } catch (err) {
    document.getElementById('detailContent').innerHTML = `<p style="color:#ef4444;">Error: ${err.message}</p>`;
  }
}

// ============================================================
//  RENDER DETAIL
// ============================================================
function renderDetail(product, related) {
  const container = document.getElementById('detailContent');

  let variant = allVariants.find(v => v.id === currentVariantId) || allVariants[0];
  let media = [];
  if (variant.image) {
    media.push({ id: null, type: 'image', url: variant.image });
  }
  const productImages = Array.isArray(product.images) ? product.images : [];
  const productVideos = Array.isArray(product.videos) ? product.videos : [];
  if (product.image && !productImages.includes(product.image)) productImages.unshift(product.image);
  productImages.forEach(url => media.push({ id: null, type: 'image', url }));
  if (product.video && !productVideos.includes(product.video)) productVideos.unshift(product.video);
  productVideos.forEach(url => media.push({ id: null, type: 'video', url }));
  if (!media.length) media.push({ id: null, type: 'image', url: fallbackMediaUrl(product) });
  if (currentMediaIndex >= media.length) currentMediaIndex = 0;

  // Color Variants
  let variantHtml = '';
  if (allVariants.length > 1) {
    variantHtml = `<div class="variant-selector"><span class="label">Color:</span>`;
    allVariants.forEach(v => {
      const active = v.id === currentVariantId ? 'active' : '';
      const colorCode = v.color_code || '#cccccc';
      const bgImage = v.image ? `url(${v.image})` : '';
      const isInStock = v.stock > 0;
      variantHtml += `
        <button class="variant-btn ${active}" onclick="selectVariant(${v.id})" title="${v.name}">
          ${v.image ? `<span class="color-swatch" style="background-image:${bgImage};"></span>` :
            `<span class="color-swatch" style="background:${colorCode};"></span>`}
          ${!isInStock ? `<span class="stock-badge">✕</span>` : ''}
        </button>
      `;
    });
    variantHtml += '</div>';
  } else {
    variantHtml = `<div class="variant-selector"><span class="label">Color:</span> <span style="font-weight:500;">${allVariants[0].name}</span></div>`;
  }

  // Thumbnails
  let thumbHtml = '';
  media.forEach((m, idx) => {
    const active = idx === currentMediaIndex ? 'active' : '';
    thumbHtml += `<div class="thumb ${active}" onclick="selectMedia(${idx})"><img src="${m.url}" alt="Media"></div>`;
  });

  // Main media
  let mainMediaHtml = '';
  if (media.length > 0 && media[currentMediaIndex]) {
    mainMediaHtml = media[currentMediaIndex].type === 'video'
      ? `<video src="${media[currentMediaIndex].url}" controls preload="metadata">Your browser cannot play this video.</video>`
      : `<img src="${media[currentMediaIndex].url}" alt="${product.name}" onerror="this.src=fallbackMediaUrl({name:this.alt})">`;
  } else {
    mainMediaHtml = '<div class="no-image">📦</div>';
  }

  // Price
  const currentPrice = variant.price || product.price;
  const oldPrice = product.old_price || '';
  const discountPercent = product.discount_percent || '';
  let priceHtml = `
    <div class="price-section">
      <span class="current-price">Ksh ${parseFloat(currentPrice).toFixed(2)}</span>
  `;
  if (oldPrice && parseFloat(oldPrice) > parseFloat(currentPrice)) {
    priceHtml += `<span class="old-price">Ksh ${parseFloat(oldPrice).toFixed(2)}</span>`;
    if (discountPercent) {
      priceHtml += `<span class="discount-badge">-${discountPercent}%</span>`;
    }
  }
  priceHtml += `</div>`;

  // Stock
  const stockDisplay = variant.stock !== undefined ? variant.stock : 999;
  const stockHtml = `
    <div class="stock-info">
      ${stockDisplay > 0 ?
        `<span class="in-stock">✓ In Stock (${stockDisplay} available)</span>` :
        `<span class="out-of-stock">✕ Out of Stock</span>`}
    </div>
  `;

  // Rating (aggregate only — no write-a-review form and no reviews list)
  const ratingValue = parseFloat(product.rating) || 0;
  const fullStars = Math.round(ratingValue);
  let ratingHtml = '';
  if (ratingValue > 0) {
    ratingHtml = `
      <div class="rating-section">
        <span class="stars">${'⭐'.repeat(Math.min(fullStars, 5))}</span>
        <span class="rating-text">${ratingValue.toFixed(1)}</span>
        <span class="review-count">(${product.review_count || 0} reviews)</span>
      </div>
    `;
  }

  // B.7 — Defined product category chip (from the product_categories table).
  const categoryChipHtml = product.product_category_name
    ? `<div class="product-category-chip" title="${product.product_category_name}">${product.product_category_icon || '📦'} ${product.product_category_name}</div>`
    : '';

  // Badges
  let badgesHtml = '';
  if (product.badge1) badgesHtml += `<span class="badge badge-green">${product.badge1}</span>`;
  if (product.badge2) badgesHtml += `<span class="badge badge-blue">${product.badge2}</span>`;
  if (product.isFlashSale) badgesHtml += `<span class="badge tag-flash">🔥 Flash Sale</span>`;
  if (product.isNewArrival) badgesHtml += `<span class="badge tag-new">🆕 New</span>`;
  if (badgesHtml) badgesHtml = `<div class="badges">${badgesHtml}</div>`;

  // Description
  const descriptionHtml = `<div class="description">${product.description || 'No description available for this product.'}</div>`;

  // Services
  let servicesHtml = '';
  if (product.shipping) {
    servicesHtml = `<div class="services"><span>Delivery Information:</span> ${product.shipping}</div>`;
  }

  // Return Policy
  const returnDays = product.return_window_days || 14;
  const restockingFee = product.restocking_fee_percent || 0;
  const returnCondition = product.return_condition || 'unopened';
  const returnEnabled = product.return_enabled !== false;

  let returnPolicyHtml = '';
  if (returnEnabled) {
    returnPolicyHtml = `
      <div class="return-policy">
        <strong>🔄 Return Policy:</strong>
        Returns accepted within ${returnDays} days of delivery.
        ${restockingFee > 0 ? `Restocking fee: ${restockingFee}%. ` : ''}
        Products must be in ${returnCondition} condition.
      </div>
    `;
  } else {
    returnPolicyHtml = `
      <div class="return-policy" style="background:linear-gradient(145deg, #fef2f2, #fee2e2); border-left-color:#ef4444; color:#991b1b;">
        <strong>❌ Non-Returnable:</strong> This item is final sale and cannot be returned.
      </div>
    `;
  }

  // Contact Us
  const socialLinks = getAutoSocialLinks(product);
  let contactRatingHtml = '';
  if (ratingValue > 0) {
    contactRatingHtml = `
      <div class="product-rating-display">
        <span class="stars">${'⭐'.repeat(Math.min(fullStars, 5))}</span>
        <span class="rating-value">${ratingValue.toFixed(1)}</span>
        <span class="review-count">(${product.review_count || 0} reviews)</span>
      </div>
    `;
  } else {
    contactRatingHtml = `
      <div class="product-rating-display">
        <span style="color:#94a3b8; font-size:0.8rem;">No ratings yet. Be the first to rate!</span>
      </div>
    `;
  }

  let contactHtml = `
    <div class="contact-us-section">
      <h4>📞 Contact Us</h4>
      ${contactRatingHtml}
      <div class="social-icons" style="margin-top:6px;">
        <a href="${socialLinks.whatsapp}" target="_blank" class="whatsapp"><i class="fab fa-whatsapp"></i> WhatsApp</a>
        <a href="${socialLinks.instagram}" target="_blank" class="instagram"><i class="fab fa-instagram"></i> Instagram</a>
        <a href="${socialLinks.messenger}" target="_blank" class="messenger"><i class="fab fa-facebook-messenger"></i> Messenger</a>
        <a href="${socialLinks.tiktok}" target="_blank" class="tiktok"><i class="fab fa-tiktok"></i> TikTok</a>
        <a href="${socialLinks.phone}" class="phone"><i class="fas fa-phone"></i> Call</a>
      </div>
    </div>
  `;

  // Related
  let relatedHtml = '';
  // A product without an uploaded photo still receives a deterministic visual
  // card instead of the blank/emoji placeholder.
  (related || []).forEach(item => { item.image = fallbackMediaUrl(item); });
  if (related && related.length > 0) {
    relatedHtml = related.slice(0, 4).map(p => `
      <div class="related-item"
           data-name="${(p.name || '').toLowerCase()}"
           data-category="${(p.category || '').toLowerCase()}"
           data-category-id="${p.product_category_id || ''}"
           onclick="location.href='/product-detail.html?id=${p.id}&business=${encodeURIComponent(product.business_slug || '')}'">
        ${p.image ? `<img src="${p.image}" alt="${p.name}">` : `<div class="no-image">📦</div>`}
        <div class="related-info">
          <div class="related-name">${p.name}</div>
          <div class="related-price">${p.price}</div>
        </div>
      </div>
    `).join('');
  }

  // Related filter dropdown — combine the defined product categories with the
  // legacy free-text categories so the customer can narrow by either.
  const definedCategoryOptions = [...new Map(
    (related || [])
      .filter(item => item.product_category_id && item.product_category_name)
      .map(item => [String(item.product_category_id), item.product_category_name])
  ).entries()].sort((a, b) => a[1].localeCompare(b[1]));

  const legacyCategoryOptions = [...new Set(
    (related || []).map(item => item.category).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  let relatedFilterOptions = '<option value="all">All product categories</option>';
  if (definedCategoryOptions.length > 0) {
    relatedFilterOptions += `<optgroup label="Defined categories">${definedCategoryOptions
      .map(([id, name]) => `<option value="id:${id}">${name}</option>`)
      .join('')}</optgroup>`;
  }
  if (legacyCategoryOptions.length > 0) {
    relatedFilterOptions += `<optgroup label="Other categories">${legacyCategoryOptions
      .map(category => `<option value="name:${category.toLowerCase()}">${category}</option>`)
      .join('')}</optgroup>`;
  }

  // Cart button
  const isInCart = getCart().some(item => item.id === product.id && item.variant_id === currentVariantId);
  const btnText = isInCart ? 'Add More' : 'Add to Cart';
  const btnClass = isInCart ? 'in-cart' : '';

  // Render everything
  container.innerHTML = `
    <div class="detail-container">
      <div class="detail-media">
        <div class="detail-main-media">${mainMediaHtml}</div>
        ${thumbHtml ? `<div class="media-thumbnails">${thumbHtml}</div>` : ''}
      </div>

      <div class="detail-info">
        <div class="name">${product.name}</div>
        ${categoryChipHtml}
        ${ratingHtml}
        ${priceHtml}
        ${stockHtml}
        ${badgesHtml}
        ${descriptionHtml}
        ${servicesHtml}
        ${returnPolicyHtml}
        ${variantHtml}

        <div class="qty-section">
          <span class="qty-label">Quantity:</span>
          <div class="qty-control">
            <button onclick="changeDetailQty(-1)">−</button>
            <span id="detailQty">${detailQty}</span>
            <button onclick="changeDetailQty(1)">+</button>
          </div>
        </div>

        <div class="button-group">
          <button class="btn-add-large ${btnClass}" onclick="addVariantToCart()">🛒 ${btnText}</button>
          <button class="btn-buy-now" onclick="buyNow()">Buy Now</button>
        </div>

        ${contactHtml}
      </div>
    </div>

    <div class="related-products">
      <h3>You may also like</h3>
      <div class="products-filters related-filters">
        <input id="relatedProductSearch" type="search" placeholder="Search this business's products" oninput="filterRelatedProducts()">
        <select id="relatedProductCategory" onchange="filterRelatedProducts()">${relatedFilterOptions}</select>
      </div>
      <div class="related-grid">${relatedHtml}</div>
    </div>
  `;

  // Thank-you band — replace the old write-a-review form and reviews
  // list with a warm, personalised closing band. The business name is
  // injected here.
  renderThankYouBand(product);
}

// ============================================================
//  THANK-YOU BAND
//
//  Replaces the old reviews section. The band is a static DOM
//  block in public/html/product-detail.html; this function only
//  injects the business name into it so the band feels personal.
//
//  The band is always visible once the product is loaded.
// ============================================================

function renderThankYouBand(product) {
  const band = document.getElementById('thankYouBand');
  const nameEl = document.getElementById('thankYouBusinessName');
  if (!band) return;

  const name = product && product.business_name
    ? String(product.business_name).trim()
    : 'our business';
  if (nameEl) nameEl.textContent = name;

  band.style.display = '';
}

// ============================================================
//  VARIANT & MEDIA FUNCTIONS
// ============================================================
function selectVariant(variantId) {
  currentVariantId = variantId;
  currentMediaIndex = 0;
  loadProductDetail();
}

function selectMedia(index) {
  currentMediaIndex = index;
  loadProductDetail();
}

// Related filter now understands both encoded option formats:
//   id:<product_category_id>   — defined product categories
//   name:<legacy category>     — legacy free-text categories
function filterRelatedProducts() {
  const query = (document.getElementById('relatedProductSearch')?.value || '').trim().toLowerCase();
  const selection = document.getElementById('relatedProductCategory')?.value || 'all';

  let mode = 'all';
  let target = '';
  if (selection.startsWith('id:')) { mode = 'id'; target = selection.slice(3); }
  else if (selection.startsWith('name:')) { mode = 'name'; target = selection.slice(5); }

  document.querySelectorAll('.related-products .related-item').forEach(item => {
    const matchesQuery = !query || (item.dataset.name || '').includes(query);
    let matchesCategory = true;
    if (mode === 'id') {
      matchesCategory = String(item.dataset.categoryId || '') === target;
    } else if (mode === 'name') {
      matchesCategory = (item.dataset.category || '') === target;
    }
    item.style.display = (matchesQuery && matchesCategory) ? '' : 'none';
  });
}

function changeDetailQty(delta) {
  detailQty = Math.max(1, detailQty + delta);
  const span = document.getElementById('detailQty');
  if (span) span.textContent = detailQty;
}

// ============================================================
//  ADD TO CART
// ============================================================
function addVariantToCart() {
  if (!currentProduct) return;
  const variant = allVariants.find(v => v.id === currentVariantId) || allVariants[0];
  const price = variant.price || currentProduct.price;
  const variantId = variant.id;
  const variantName = variant.name || 'Default';
  const image = variant.image || currentProduct.image;

  let cart = getCart();
  const existing = cart.find(item => item.id === currentProduct.id && item.variant_id === variantId);
  if (existing) {
    existing.quantity += detailQty;
  } else {
    cart.push({
      id: currentProduct.id,
      variant_id: variantId,
      name: currentProduct.name,
      price: price,
      image: image || '',
      quantity: detailQty,
      variant_name: variantName
    });
  }
  saveCart(cart);
  updateCartBadge();
  showToast(`✅ Added ${detailQty} "${currentProduct.name}" to cart!`, 'success');
  detailQty = 1;
  const span = document.getElementById('detailQty');
  if (span) span.textContent = '1';
  loadProductDetail();
}

function buyNow() {
  addVariantToCart();
  window.location.href = '/cart.html';
}

// ============================================================
//  INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  const businessSlug = urlParams.get('business');
  if (businessSlug) {
    ['productBusinessHome', 'productBusinessHomeNav'].forEach(id => {
      const link = document.getElementById(id);
      if (link) link.href = `/business/${encodeURIComponent(businessSlug)}`;
    });
  }
  const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
  const isLoggedIn = Boolean(user.email);
  ['productNavCategory', 'productNavMessages', 'productNavAccount'].forEach(id => {
    const item = document.getElementById(id);
    if (item) item.style.display = isLoggedIn ? 'flex' : 'none';
  });
  if (!isLoggedIn) {
    ['productHeaderCart', 'productNavCart'].forEach(id => {
      const item = document.getElementById(id);
      if (item) item.href = '/?auth=login&next=cart';
    });
  }
  loadProductDetail();
  updateCartBadge();
  updateNavCartBadge();
});

// Expose globals
window.selectVariant = selectVariant;
window.selectMedia = selectMedia;
window.changeDetailQty = changeDetailQty;
window.addVariantToCart = addVariantToCart;
window.buyNow = buyNow;
window.loadProductDetail = loadProductDetail;
window.fallbackMediaUrl = fallbackMediaUrl;
window.filterRelatedProducts = filterRelatedProducts;
window.renderThankYouBand = renderThankYouBand;