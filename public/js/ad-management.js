// ============================================================
//  AD MANAGEMENT JAVASCRIPT - Section J
//  Location: public/js/ad-management.js
//
//  J.2 — Business admins upload image or video, set title /
//        description, choose a link target (profile or product),
//        set the display duration, and toggle the ad active.
//  J.3 — The list renders views, clicks, and CTR per ad.
//  J.6 — When the admin picks "product", only that business's
//        own active products are offered. The server validates
//        this again on save.
//
//  Section J.2 — in-page integration notes:
//
//   Ad Management now lives inside business-admin.html as the
//   #section-ads block, alongside Dashboard / Orders / Customers /
//   Messages in the Main sidebar group. This file is loaded by
//   business-admin.html (not by a standalone page anymore), so it
//   must NOT auto-init on DOMContentLoaded.
//
//   Initialization is driven by business-admin.js through the
//   global window.initAdManagement() function, which is called
//   the first time the admin opens the "Manage Ads" section.
//   Subsequent visits reuse the already-loaded data and only
//   refresh the ad list when the section is re-opened.
//
//   All globals are declared once and guarded against being
//   redeclared by another script on the same page.
// ============================================================

(function () {
  'use strict';

  // ============================================================
  //  GLOBALS (idempotent — safe if the file is ever loaded twice)
  // ============================================================

  if (typeof window.adBusinessData === 'undefined') window.adBusinessData = null;
  if (typeof window.adProductList === 'undefined') window.adProductList = [];
  if (typeof window.editingAdId === 'undefined') window.editingAdId = null;
  if (typeof window.selectedMediaFile === 'undefined') window.selectedMediaFile = null;
  if (typeof window.selectedMediaType === 'undefined') window.selectedMediaType = null;

  // Per-ad display defaults (Section J.5) — exposed so business-admin.js
  // can reuse them when it renders the placeholder values in the form.
  if (typeof window.AD_DEFAULT_IMAGE_DURATION === 'undefined') window.AD_DEFAULT_IMAGE_DURATION = 10;
  if (typeof window.AD_DEFAULT_VIDEO_DURATION === 'undefined') window.AD_DEFAULT_VIDEO_DURATION = 120;

  var DEFAULT_IMAGE_DURATION = window.AD_DEFAULT_IMAGE_DURATION;
  var DEFAULT_VIDEO_DURATION = window.AD_DEFAULT_VIDEO_DURATION;

  // Whether the form + list have already been wired once. Prevents
  // duplicate event listeners if initAdManagement() is called again.
  var adFormWired = false;

  // ============================================================
  //  SECTION LOOKUP HELPERS
  //  Everything below works whether ad-management.js is loaded
  //  by business-admin.html (in-page #section-ads) or by any
  //  future surface that keeps the same ids.
  // ============================================================

  function sectionRoot() {
    return document.getElementById('section-ads') || document;
  }

  function byId(id) {
    var root = sectionRoot();
    return root.querySelector('#' + id) || document.getElementById(id);
  }

  // ============================================================
  //  INIT
  //
  //  Called explicitly by business-admin.js the first time the
  //  admin navigates to the "Manage Ads" section. It is NOT called
  //  automatically here — auto-init would run on the standalone
  //  ad-management.html shell (which now only redirects) and on
  //  every business-admin page load, wasting a /my-business call.
  // ============================================================

  async function initAdManagement(options) {
    options = options || {};
    var force = options.force === true;

    try {
      // Skip the /my-business call if we already have business data
      // and the caller did not force a refresh.
      if (!force && window.adBusinessData) {
        wireFormEventsOnce();
        await loadProductsForTarget();
        await loadAds();
        return;
      }

      var res = await fetch('/api/auth/my-business', {
        credentials: 'same-origin',
        cache: 'no-store'
      });

      if (res.status === 401) {
        // The business-admin shell handles session expiry itself;
        // here we only surface an inline message inside section-ads.
        showSectionMessage('Please log in to manage ads.', 'error');
        return;
      }

      if (!res.ok) {
        showSectionMessage('Unable to verify your session. Please refresh and try again.', 'error');
        return;
      }

      var data = await res.json();
      if (!data.business) {
        showSectionMessage('No business is linked to this account.', 'error');
        return;
      }

      window.adBusinessData = data.business;

      // The business name is already displayed by business-admin.html
      // in the header (#businessNameDisplay). We only fill it here
      // when this file is being used on a surface that owns that
      // element itself (the standalone shell).
      var nameDisplay = document.getElementById('businessNameDisplay');
      if (nameDisplay && !nameDisplay.textContent) {
        nameDisplay.textContent = window.adBusinessData.business_name || '';
      }

      wireFormEventsOnce();
      await loadProductsForTarget();
      await loadAds();
    } catch (err) {
      console.error('Ad management init error:', err);
      showSectionMessage('Network error. Please refresh and try again.', 'error');
    }
  }

  /**
   * Inline message inside #section-ads when something fails before
   * the form can render. Falls back to a toast if the section
   * container is missing.
   */
  function showSectionMessage(message, type) {
    var root = sectionRoot();
    var container = root.querySelector('#adsList');
    if (container) {
      container.innerHTML =
        '<p class="empty-msg ' + (type === 'error' ? 'error' : '') + '">' +
        escapeHtml(message) +
        '</p>';
      return;
    }
    showToast(message, type === 'error' ? 'error' : 'info');
  }

  // ============================================================
  //  PRODUCT PICKER (for link_type = 'product')
  // ============================================================

  async function loadProductsForTarget() {
    var select = byId('adLinkTargetId');
    if (!select) return;

    try {
      var res = await fetch('/api/business-admin/products?limit=200', {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (!res.ok) throw new Error('Failed to load products');
      var products = await res.json();
      window.adProductList = Array.isArray(products) ? products : [];

      if (window.adProductList.length === 0) {
        select.innerHTML = '<option value="">No products yet — add a product first</option>';
        select.disabled = true;
        var help = byId('productTargetHelp');
        if (help) {
          help.textContent = 'You need at least one active product to create a product-targeted ad.';
          help.style.color = '#f59e0b';
        }
        return;
      }

      renderProductOptions(window.adProductList);
    } catch (err) {
      console.error('Product load error:', err);
      select.innerHTML = '<option value="">Failed to load products</option>';
      select.disabled = true;
    }
  }

  function renderProductOptions(list) {
    var select = byId('adLinkTargetId');
    if (!select) return;
    select.disabled = false;

    if (!list.length) {
      select.innerHTML = '<option value="">No matching products</option>';
      return;
    }

    select.innerHTML = '<option value="">Select a product…</option>' +
      list.map(function (p) {
        var price = p.price ? ' — Ksh ' + p.price : '';
        return '<option value="' + p.id + '">' + escapeHtml(p.name) + escapeHtml(price) + '</option>';
      }).join('');
  }

  function filterProductOptions() {
    var input = byId('adProductSearch');
    var query = (input && input.value ? input.value : '').trim().toLowerCase();
    if (!query) {
      renderProductOptions(window.adProductList);
      return;
    }
    var filtered = window.adProductList.filter(function (p) {
      return String(p.name || '').toLowerCase().indexOf(query) !== -1;
    });
    renderProductOptions(filtered);
  }

  function updateLinkTargetField() {
    var typeEl = byId('adLinkType');
    var type = typeEl ? typeEl.value : 'profile';
    var wrap = byId('productTargetWrap');
    if (wrap) wrap.style.display = type === 'product' ? 'block' : 'none';
  }

  // ============================================================
  //  MEDIA PREVIEW + FORM WIRING
  // ============================================================

  function wireFormEventsOnce() {
    if (adFormWired) return;
    adFormWired = true;

    var drop = byId('mediaDrop');
    var input = byId('adMedia');
    if (drop && input) {
      drop.addEventListener('click', function (e) {
        // Let clicks on the inner remove button bubble without opening the picker.
        if (e.target.closest('.media-remove')) return;
        input.click();
      });
      drop.addEventListener('dragover', function (e) {
        e.preventDefault();
        drop.classList.add('dragging');
      });
      drop.addEventListener('dragleave', function () {
        drop.classList.remove('dragging');
      });
      drop.addEventListener('drop', function (e) {
        e.preventDefault();
        drop.classList.remove('dragging');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          handleMediaSelection(e.dataTransfer.files[0]);
        }
      });

      input.addEventListener('change', function () {
        if (input.files && input.files[0]) {
          handleMediaSelection(input.files[0]);
        }
      });
    }

    var form = byId('adForm');
    if (form) form.addEventListener('submit', onFormSubmit);
  }

  function handleMediaSelection(file) {
    var mime = String(file.type || file.mimetype || '').toLowerCase();
    var isVideo = mime.indexOf('video/') === 0;
    var isImage = mime.indexOf('image/') === 0;

    if (!isVideo && !isImage) {
      showFormStatus('❌ Only image or video files are allowed.', 'error');
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      showFormStatus('❌ File is too large. Maximum size is 50MB.', 'error');
      return;
    }

    window.selectedMediaFile = file;
    window.selectedMediaType = isVideo ? 'video' : 'image';

    renderMediaPreview(file, window.selectedMediaType);
    showFormStatus('', '');
  }

  function renderMediaPreview(file, type) {
    var placeholder = byId('mediaPlaceholder');
    var preview = byId('mediaPreview');
    if (!preview || !placeholder) return;

    var url = URL.createObjectURL(file);

    if (type === 'video') {
      preview.innerHTML =
        '<video src="' + url + '" controls muted playsinline></video>' +
        '<div class="media-meta">' +
          '<span class="media-badge video"><i class="fas fa-video"></i> Video</span>' +
          '<span class="media-filename">' + escapeHtml(file.name) + '</span>' +
          '<button type="button" class="media-remove" onclick="clearMediaSelection()" title="Remove">' +
            '<i class="fas fa-times"></i>' +
          '</button>' +
        '</div>';
    } else {
      preview.innerHTML =
        '<img src="' + url + '" alt="Ad preview">' +
        '<div class="media-meta">' +
          '<span class="media-badge image"><i class="fas fa-image"></i> Image</span>' +
          '<span class="media-filename">' + escapeHtml(file.name) + '</span>' +
          '<button type="button" class="media-remove" onclick="clearMediaSelection()" title="Remove">' +
            '<i class="fas fa-times"></i>' +
          '</button>' +
        '</div>';
    }

    placeholder.style.display = 'none';
    preview.style.display = 'block';
  }

  function clearMediaSelection() {
    window.selectedMediaFile = null;
    window.selectedMediaType = null;

    var input = byId('adMedia');
    if (input) input.value = '';

    var placeholder = byId('mediaPlaceholder');
    var preview = byId('mediaPreview');
    if (placeholder) placeholder.style.display = 'block';
    if (preview) {
      preview.style.display = 'none';
      preview.innerHTML = '';
    }
  }

  // ============================================================
  //  FORM SUBMIT (Create / Update)
  // ============================================================

  async function onFormSubmit(e) {
    e.preventDefault();

    var titleEl = byId('adTitle');
    var descEl = byId('adDescription');
    var linkTypeEl = byId('adLinkType');
    var linkTargetEl = byId('adLinkTargetId');
    var durationEl = byId('adDuration');
    var activeEl = byId('adIsActive');

    var title = titleEl ? titleEl.value.trim() : '';
    var description = descEl ? descEl.value.trim() : '';
    var linkType = linkTypeEl ? linkTypeEl.value : 'profile';
    var linkTargetId = linkTargetEl ? linkTargetEl.value : '';
    var displayDuration = durationEl ? durationEl.value.trim() : '';
    var isActive = activeEl ? activeEl.checked : true;

    // J.2 validation
    var isEdit = Boolean(window.editingAdId);
    if (!isEdit && !window.selectedMediaFile) {
      showFormStatus('❌ Please upload an image or video for this ad.', 'error');
      return;
    }

    if (linkType === 'product' && !linkTargetId) {
      showFormStatus('❌ Please choose which product this ad should open.', 'error');
      return;
    }

    // Build payload
    var formData = new FormData();
    if (window.selectedMediaFile) formData.append('media', window.selectedMediaFile);
    if (title) formData.append('title', title);
    if (description) formData.append('description', description);
    formData.append('link_type', linkType);
    if (linkType === 'product') formData.append('link_target_id', linkTargetId);
    if (displayDuration) formData.append('display_duration', displayDuration);
    formData.append('is_active', isActive ? 'true' : 'false');

    var submitBtn = byId('adSubmitBtn');
    var originalText = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    }
    showFormStatus('⏳ Saving your ad...', 'info');

    try {
      var url = isEdit
        ? '/api/business-admin/ads/' + window.editingAdId
        : '/api/business-admin/ads';
      var method = isEdit ? 'PUT' : 'POST';

      var res = await fetch(url, {
        method: method,
        credentials: 'same-origin',
        body: formData
      });

      var data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to save ad');
      }

      showFormStatus(isEdit ? '✅ Ad updated successfully!' : '✅ Ad created successfully!', 'success');
      showToast(isEdit ? 'Ad updated.' : 'Ad created.', 'success');

      // Reset then reload
      resetForm();
      await loadAds();
    } catch (err) {
      console.error('Save ad error:', err);
      showFormStatus('❌ ' + err.message, 'error');
      showToast('❌ ' + err.message, 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = window.editingAdId
          ? '<i class="fas fa-check"></i> Save Changes'
          : '<i class="fas fa-check"></i> Create Ad';
      }
    }
  }

  function resetForm() {
    window.editingAdId = null;
    clearMediaSelection();

    var form = byId('adForm');
    if (form) form.reset();

    var titleEl = byId('adTitle');         if (titleEl) titleEl.value = '';
    var descEl = byId('adDescription');    if (descEl) descEl.value = '';
    var linkEl = byId('adLinkType');       if (linkEl) linkEl.value = 'profile';
    var durEl = byId('adDuration');        if (durEl) durEl.value = '';
    var activeEl = byId('adIsActive');     if (activeEl) activeEl.checked = true;
    var searchEl = byId('adProductSearch'); if (searchEl) searchEl.value = '';

    updateLinkTargetField();

    var title = byId('formTitle');
    if (title) title.innerHTML = '<i class="fas fa-plus-circle"></i> Create New Ad';

    var submitBtn = byId('adSubmitBtn');
    if (submitBtn) submitBtn.innerHTML = '<i class="fas fa-check"></i> Create Ad';

    var cancelBtn = byId('adCancelBtn');
    if (cancelBtn) cancelBtn.style.display = 'none';

    showFormStatus('', '');
  }

  function cancelEdit() {
    resetForm();
  }

  // ============================================================
  //  LOAD ADS LIST
  // ============================================================

  async function loadAds() {
    var container = byId('adsList');
    var badge = byId('adsCountBadge');
    if (!container) return;

    container.innerHTML = '<p class="empty-msg">Loading your ads...</p>';

    try {
      var res = await fetch('/api/business-admin/ads', {
        credentials: 'same-origin',
        cache: 'no-store'
      });

      if (!res.ok) throw new Error('Failed to load ads');
      var ads = await res.json();

      if (badge) badge.textContent = String(Array.isArray(ads) ? ads.length : 0);

      if (!Array.isArray(ads) || ads.length === 0) {
        container.innerHTML =
          '<div class="empty-msg">' +
            '<i class="fas fa-bullhorn"></i>' +
            '<p>You haven\'t created any ads yet.</p>' +
            '<small>Use the form above to create your first ad.</small>' +
          '</div>';
        return;
      }

      container.innerHTML = ads.map(renderAdCard).join('');
    } catch (err) {
      console.error('Load ads error:', err);
      container.innerHTML =
        '<p class="empty-msg error">Unable to load ads: ' + escapeHtml(err.message) + '</p>';
    }
  }

  // ============================================================
  //  AD CARD
  // ============================================================

  function renderAdCard(ad) {
    var ctr = Number(ad.click_through_rate) || 0;
    var views = Number(ad.views) || 0;
    var clicks = Number(ad.clicks) || 0;

    var mediaType = ad.media_type === 'video' ? 'video' : 'image';
    var mediaBadge = mediaType === 'video'
      ? '<span class="media-badge video"><i class="fas fa-video"></i> Video</span>'
      : '<span class="media-badge image"><i class="fas fa-image"></i> Image</span>';

    var statusPill = ad.is_active
      ? '<span class="status-pill active">● Active</span>'
      : '<span class="status-pill paused">● Paused</span>';

    // Target label
    var targetLabel = '<span class="target-label"><i class="fas fa-store"></i> Business profile</span>';
    if (ad.link_type === 'product') {
      var productName = ad.product_name || ('Product #' + (ad.link_target_id || ''));
      targetLabel = '<span class="target-label"><i class="fas fa-tag"></i> ' + escapeHtml(productName) + '</span>';
    }

    // Duration label
    var durationLabel;
    if (ad.display_duration) {
      durationLabel = '<span class="duration-label"><i class="fas fa-clock"></i> ' + ad.display_duration + 's</span>';
    } else {
      var fallback = mediaType === 'video' ? DEFAULT_VIDEO_DURATION : DEFAULT_IMAGE_DURATION;
      durationLabel = '<span class="duration-label muted"><i class="fas fa-clock"></i> ' + fallback + 's (default)</span>';
    }

    // Media thumbnail
    var mediaThumb;
    if (mediaType === 'video') {
      mediaThumb = '<video src="' + escapeAttr(ad.media_url) + '" muted playsinline preload="metadata"></video>';
    } else {
      mediaThumb = '<img src="' + escapeAttr(ad.media_url) + '" alt="Ad media">';
    }

    return '' +
      '<div class="ad-card ' + (ad.is_active ? '' : 'is-paused') + '" data-id="' + ad.id + '">' +
        '<div class="ad-card-media">' +
          mediaThumb +
          mediaBadge +
        '</div>' +
        '<div class="ad-card-body">' +
          '<div class="ad-card-header">' +
            '<h3 class="ad-card-title">' + (ad.title ? escapeHtml(ad.title) : '<em>Untitled ad</em>') + '</h3>' +
            statusPill +
          '</div>' +
          (ad.description ? '<p class="ad-card-desc">' + escapeHtml(ad.description) + '</p>' : '') +
          '<div class="ad-card-meta">' +
            targetLabel +
            durationLabel +
          '</div>' +
          '<div class="ad-card-stats">' +
            '<div class="stat">' +
              '<span class="stat-value">' + views.toLocaleString() + '</span>' +
              '<span class="stat-label">Views</span>' +
            '</div>' +
            '<div class="stat">' +
              '<span class="stat-value">' + clicks.toLocaleString() + '</span>' +
              '<span class="stat-label">Clicks</span>' +
            '</div>' +
            '<div class="stat">' +
              '<span class="stat-value">' + ctr.toFixed(2) + '%</span>' +
              '<span class="stat-label">CTR</span>' +
            '</div>' +
          '</div>' +
          '<div class="ad-card-actions">' +
            '<button class="btn-action" onclick="editAd(' + ad.id + ')" title="Edit">' +
              '<i class="fas fa-edit"></i> Edit' +
            '</button>' +
            '<button class="btn-action" onclick="toggleAdActive(' + ad.id + ')" title="' + (ad.is_active ? 'Pause' : 'Activate') + '">' +
              '<i class="fas fa-' + (ad.is_active ? 'pause' : 'play') + '"></i>' +
              (ad.is_active ? 'Pause' : 'Activate') +
            '</button>' +
            '<button class="btn-action danger" onclick="deleteAd(' + ad.id + ')" title="Delete">' +
              '<i class="fas fa-trash"></i> Delete' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  // ============================================================
  //  AD CARD ACTIONS
  // ============================================================

  async function editAd(adId) {
    try {
      var res = await fetch('/api/business-admin/ads', {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (!res.ok) throw new Error('Failed to load ad');
      var ads = await res.json();
      var ad = ads.find(function (a) { return Number(a.id) === Number(adId); });
      if (!ad) throw new Error('Ad not found');

      window.editingAdId = ad.id;

      var titleEl = byId('adTitle');       if (titleEl) titleEl.value = ad.title || '';
      var descEl = byId('adDescription');  if (descEl) descEl.value = ad.description || '';
      var linkEl = byId('adLinkType');     if (linkEl) linkEl.value = ad.link_type === 'product' ? 'product' : 'profile';
      var durEl = byId('adDuration');      if (durEl) durEl.value = ad.display_duration || '';
      var activeEl = byId('adIsActive');   if (activeEl) activeEl.checked = ad.is_active === true;

      updateLinkTargetField();

      if (ad.link_type === 'product' && ad.link_target_id) {
        await new Promise(function (r) { setTimeout(r, 0); });
        var select = byId('adLinkTargetId');
        if (select) {
          var exists = Array.prototype.slice.call(select.options).some(function (o) {
            return String(o.value) === String(ad.link_target_id);
          });
          if (!exists && ad.product_name) {
            var opt = document.createElement('option');
            opt.value = ad.link_target_id;
            opt.textContent = ad.product_name;
            select.appendChild(opt);
          }
          select.value = String(ad.link_target_id);
        }
      }

      // Show existing media in preview (read-only, replaced only if the admin uploads a new file)
      clearMediaSelection();
      var preview = byId('mediaPreview');
      var placeholder = byId('mediaPlaceholder');
      if (preview && placeholder) {
        var isVideo = ad.media_type === 'video';
        preview.innerHTML =
          (isVideo
            ? '<video src="' + escapeAttr(ad.media_url) + '" controls muted playsinline></video>'
            : '<img src="' + escapeAttr(ad.media_url) + '" alt="Current ad media">') +
          '<div class="media-meta">' +
            '<span class="media-badge ' + (isVideo ? 'video' : 'image') + '">' +
              '<i class="fas fa-' + (isVideo ? 'video' : 'image') + '"></i> ' + (isVideo ? 'Video' : 'Image') +
            '</span>' +
            '<span class="media-filename">Current media — upload a new file to replace it</span>' +
          '</div>';
        placeholder.style.display = 'none';
        preview.style.display = 'block';
      }

      var formTitle = byId('formTitle');
      if (formTitle) formTitle.innerHTML = '<i class="fas fa-edit"></i> Edit Ad';

      var submitBtn = byId('adSubmitBtn');
      if (submitBtn) submitBtn.innerHTML = '<i class="fas fa-check"></i> Save Changes';

      var cancelBtn = byId('adCancelBtn');
      if (cancelBtn) cancelBtn.style.display = 'inline-flex';

      // Scroll the ad form into view. The business-admin shell owns
      // the scroll container, so we target the section itself.
      var root = sectionRoot();
      if (root && typeof root.scrollIntoView === 'function') {
        root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }

      showFormStatus('Editing existing ad. Upload a new file to replace the media.', 'info');
    } catch (err) {
      console.error('Edit ad error:', err);
      showToast('❌ ' + err.message, 'error');
    }
  }

  async function toggleAdActive(adId) {
    try {
      var res = await fetch('/api/business-admin/ads/' + adId + '/toggle', {
        method: 'POST',
        credentials: 'same-origin'
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to toggle ad');
      showToast(data.ad && data.ad.is_active ? '✅ Ad activated.' : '⏸️ Ad paused.', 'success');
      await loadAds();
    } catch (err) {
      console.error('Toggle ad error:', err);
      showToast('❌ ' + err.message, 'error');
    }
  }

  async function deleteAd(adId) {
    if (!confirm('Delete this ad permanently? This cannot be undone.')) return;

    try {
      var res = await fetch('/api/business-admin/ads/' + adId, {
        method: 'DELETE',
        credentials: 'same-origin'
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete ad');
      showToast('✅ Ad deleted.', 'success');
      await loadAds();
    } catch (err) {
      console.error('Delete ad error:', err);
      showToast('❌ ' + err.message, 'error');
    }
  }

  // ============================================================
  //  STATUS + TOAST
  // ============================================================

  function showFormStatus(message, type) {
    var el = byId('adFormStatus');
    if (!el) return;
    el.textContent = message || '';
    el.className = 'form-status' + (type ? ' ' + type : '');
  }

  function showToast(message, type) {
    type = type || 'success';

    // business-admin.js already exposes a shared showToast. Reuse it
    // so the in-page ad section never stacks two toast containers.
    if (typeof window.showToast === 'function' && window.showToast !== showToast) {
      // Deliberately forward to the shared toast. business-admin.js
      // handles dedupe and animation.
      try {
        window.showToast(message, type);
        return;
      } catch (err) {
        // Fall through to the local implementation.
      }
    }

    var existing = document.querySelector('.toast-container');
    if (existing) existing.remove();

    var container = document.createElement('div');
    container.className = 'toast-container';

    var toast = document.createElement('div');
    var typeMap = { success: '#22c55e', error: '#ef4444', warning: '#f59e0b', info: '#2563eb' };
    var iconMap = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    var bg = typeMap[type] || typeMap.info;

    toast.style.cssText =
      'background:' + bg + '; color:#fff; padding:14px 20px; border-radius:12px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,0.15); font-size:0.9rem; font-weight:500;' +
      'display:flex; align-items:center; gap:12px; margin-bottom:8px;' +
      'animation:slideIn 0.3s ease; word-break:break-word;';

    var icon = document.createElement('span');
    icon.textContent = iconMap[type] || 'ℹ️';
    icon.style.fontSize = '1.2rem';

    var text = document.createElement('span');
    text.textContent = message;
    text.style.flex = '1';

    var close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'background:none;border:none;color:#fff;font-size:1rem;cursor:pointer;opacity:0.7;';
    close.onclick = function () {
      toast.style.transform = 'translateX(120%)';
      setTimeout(function () { container.remove(); }, 300);
    };

    toast.appendChild(icon);
    toast.appendChild(text);
    toast.appendChild(close);
    container.appendChild(toast);
    document.body.appendChild(container);

    setTimeout(function () {
      if (document.body.contains(container)) {
        toast.style.transform = 'translateX(120%)';
        setTimeout(function () { container.remove(); }, 300);
      }
    }, 5000);
  }

  // ============================================================
  //  HELPERS
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

  // ============================================================
  //  GLOBAL EXPOSURE
  //
  //  These are the hooks business-admin.js uses to drive the
  //  in-page ad management section. Keep the names stable.
  // ============================================================

  window.initAdManagement   = initAdManagement;
  window.loadAds            = loadAds;
  window.editAd             = editAd;
  window.toggleAdActive     = toggleAdActive;
  window.deleteAd           = deleteAd;
  window.cancelEdit         = cancelEdit;
  window.resetAdForm        = resetForm;
  window.updateLinkTargetField = updateLinkTargetField;
  window.filterProductOptions  = filterProductOptions;
  window.clearMediaSelection   = clearMediaSelection;

  // The legacy standalone shell used to call these from inline HTML.
  // Keep them defined so any stale markup still works, but they are
  // not required for the in-page section.
  window.goBack = function () {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '/business-admin.html';
    }
  };

  window.logout = window.logout || function () {
    fetch('/api/auth/logout', { method: 'POST' }).catch(function () {});
    localStorage.removeItem('businessId');
    localStorage.removeItem('businessName');
    localStorage.removeItem('businessSlug');
    localStorage.removeItem('currentUser');
    window.location.href = '/';
  };

  console.log('✅ Ad Management JS loaded (Section J.2 in-page mode)');
})();