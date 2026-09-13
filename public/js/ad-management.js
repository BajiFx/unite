// ============================================================
//  AD MANAGEMENT JAVASCRIPT - Section J / N
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
//  Section N — Fixed ad slots:
//  N.1 — Each business has exactly three ad slots: 1, 2, 3.
//  N.2 — A new ad is placed in the smallest free slot by the
//        server. The frontend only reads that decision; it never
//        invents a slot number.
//  N.3 — Editing an ad never changes its slot. The form is kept
//        usable while editing even when all three slots are
//        taken, because editing does not consume a slot.
//  N.4 — Deleting an ad frees its slot. The list is re-rendered
//        in slot order; the frontend never re-sorts by time.
//  N.5 — When all three slots are taken, the create form is
//        disabled and the server's 409 message ("Delete or edit
//        an existing ad to free a slot.") is surfaced verbatim.
//  N.6 — The slot-usage badge ("Ad X of 3") and the "N slots
//        free" hint are driven by the server's `slot_usage`
//        object. No `created_at` ordering anywhere.
//
//  Section 2D — Ad duration caps:
//   AD_DEFAULT_IMAGE_DURATION = 4   (image cap / default)
//   AD_DEFAULT_VIDEO_DURATION = 20  (video cap / default)
//   The clamp is applied again in onFormSubmit() so a
//   misbehaving client cannot submit a duration above the cap.
//   The server is the final source of truth and clamps once
//   more on POST /ads and PUT /ads/:id.
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

  // N.1 — mirror of the server-side cap. Used only as a fallback
  // when the server does not return `slot_usage` (older backend).
  if (typeof window.AD_MAX_SLOTS_PER_BUSINESS === 'undefined') window.AD_MAX_SLOTS_PER_BUSINESS = 3;

  // Section 2D — per-ad duration defaults AND caps.
  //
  // These two values serve two purposes:
  //   1. The default shown when an ad has no stored duration.
  //   2. The client-side cap applied before the FormData is built.
  //
  // The server clamps again in business-admin.js, so the value
  // that reaches the database is always within range.
  if (typeof window.AD_DEFAULT_IMAGE_DURATION === 'undefined') window.AD_DEFAULT_IMAGE_DURATION = 4;
  if (typeof window.AD_DEFAULT_VIDEO_DURATION === 'undefined') window.AD_DEFAULT_VIDEO_DURATION = 20;

  var DEFAULT_IMAGE_DURATION = window.AD_DEFAULT_IMAGE_DURATION;
  var DEFAULT_VIDEO_DURATION = window.AD_DEFAULT_VIDEO_DURATION;
  var MAX_SLOTS = window.AD_MAX_SLOTS_PER_BUSINESS;

  // Whether the form + list have already been wired once. Prevents
  // duplicate event listeners if initAdManagement() is called again.
  var adFormWired = false;

  // N.6 — the latest slot-usage picture returned by the server.
  // Shape: { max, count, used: [1,2], free: [3], isFull: false }
  // When the server is older and does not return it, this stays
  // null and the UI degrades to "count only".
  var slotUsage = null;

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
  //  SECTION 2D — Duration clamp
  //  Kept next to the constants so the logic and the numbers live
  //  together. Returns null when the caller did not supply a
  //  value, so the "leave blank for defaults" behaviour is kept.
  // ============================================================

  function clampDurationForMedia(mediaType, rawValue) {
    var str = (rawValue === undefined || rawValue === null) ? '' : String(rawValue).trim();
    if (!str) return null;
    var parsed = parseInt(str, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return null;
    var cap = mediaType === 'video' ? DEFAULT_VIDEO_DURATION : DEFAULT_IMAGE_DURATION;
    return Math.min(parsed, cap);
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
  //  N — SLOT USAGE BADGE + FORM CAP
  // ============================================================

  /**
   * N.6 — Render the slot-usage block just above the form.
   *
   * The block shows:
   *   - "Ad 2 of 3" (or the equivalent count)
   *   - the list of free slot numbers, or an explicit "no slots free"
   *     warning when the cap is reached
   *
   * The block is created lazily on first use and lives at the top
   * of #adForm's parent settings-section so it never interferes
   * with the form's own markup.
   */
  function renderSlotUsage() {
    var form = byId('adForm');
    if (!form) return;

    var host = form.closest('.settings-section') || form.parentElement;
    if (!host) return;

    var block = byId('adSlotUsageBlock');
    if (!block) {
      block = document.createElement('div');
      block.id = 'adSlotUsageBlock';
      block.style.cssText =
        'margin:0 0 14px 0; padding:10px 14px; border-radius:10px;' +
        'display:flex; align-items:center; gap:12px; flex-wrap:wrap;' +
        'font-size:0.85rem; line-height:1.4;';
      host.insertBefore(block, form);
    }

    // Fall back to a count-only view when the server did not send
    // `slot_usage` (older backend). We still want the admin to see
    // how many ads they have.
    var used = slotUsage && Array.isArray(slotUsage.used) ? slotUsage.used : [];
    var free = slotUsage && Array.isArray(slotUsage.free) ? slotUsage.free : [];
    var max = slotUsage && Number.isFinite(slotUsage.max) ? slotUsage.max : MAX_SLOTS;
    var count = slotUsage && Number.isFinite(slotUsage.count) ? slotUsage.count : used.length;
    var isFull = slotUsage && slotUsage.isFull === true;

    var isEditing = Boolean(window.editingAdId);

    var bg = isFull && !isEditing
      ? '#fef2f2'
      : '#eff6ff';
    var border = isFull && !isEditing
      ? '1px solid #fca5a5'
      : '1px solid #bfdbfe';
    var color = isFull && !isEditing
      ? '#991b1b'
      : '#1e40af';

    block.style.background = bg;
    block.style.border = border;
    block.style.color = color;

    var slotWord = count === 1 ? 'slot' : 'slots';
    var badgeText = 'Ad ' + count + ' of ' + max;

    var tail;
    if (isFull && !isEditing) {
      tail =
        '<span style="font-weight:700;">All ' + max + ' slots are in use.</span>' +
        ' Delete or edit an existing ad below to free a slot.';
    } else if (isFull && isEditing) {
      tail =
        'Editing an existing ad. Slot ' + (used.length ? used.join(', ') : '—') +
        ' stays where it is — editing never moves an ad in the rotation.';
    } else {
      var freeList = free.length ? free.join(', ') : '—';
      tail =
        'You have <strong>' + free.length + '</strong> ' +
        (free.length === 1 ? 'slot' : 'slots') +
        ' free (slot ' + freeList + '). A new ad will be placed in the smallest free slot.';
    }

    block.innerHTML =
      '<span style="display:inline-flex; align-items:center; gap:6px;' +
        'padding:3px 12px; border-radius:20px; background:#fff;' +
        'font-weight:700; font-size:0.75rem; border:1px solid rgba(0,0,0,0.06);">' +
        '<i class="fas fa-layer-group"></i> ' + escapeHtml(badgeText) +
      '</span>' +
      '<span style="flex:1; min-width:180px;">' + tail + '</span>';
  }

  /**
   * N.5 — Disable the create form when the cap is reached.
   *
   * `editing: true` keeps the form usable even when the cap is
   * full, because editing an existing ad does not consume a slot.
   */
  function applySlotCapToForm(options) {
    options = options || {};
    var isEditing = options.editing === true;

    var form = byId('adForm');
    if (!form) return;

    var isFull = slotUsage && slotUsage.isFull === true;
    var shouldDisable = isFull && !isEditing;

    // Disable every input/select/textarea/button inside the form
    // (except the cancel-edit button, which must always work).
    var controls = form.querySelectorAll('input, select, textarea, button[type="submit"]');
    controls.forEach(function (el) {
      if (el.id === 'adCancelBtn') return;
      el.disabled = shouldDisable;
    });

    // Show a small inline note when the form is disabled by the cap.
    var note = byId('adFormCapNote');
    if (shouldDisable) {
      if (!note) {
        note = document.createElement('p');
        note.id = 'adFormCapNote';
        note.style.cssText =
          'margin:8px 0 0 0; padding:8px 12px; border-radius:8px;' +
          'background:#fef2f2; color:#991b1b; font-size:0.8rem;' +
          'border-left:3px solid #ef4444;';
        note.textContent =
          'You have reached the maximum of ' + MAX_SLOTS +
          ' ads. Delete or edit an existing ad below to free a slot.';
        form.appendChild(note);
      }
      note.style.display = 'block';
    } else if (note) {
      note.style.display = 'none';
    }

    renderSlotUsage();
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
        if (input.disabled) return;
        input.click();
      });
      drop.addEventListener('dragover', function (e) {
        e.preventDefault();
        if (input.disabled) return;
        drop.classList.add('dragging');
      });
      drop.addEventListener('dragleave', function () {
        drop.classList.remove('dragging');
      });
      drop.addEventListener('drop', function (e) {
        e.preventDefault();
        drop.classList.remove('dragging');
        if (input.disabled) return;
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

    // N.5 — refuse early on create when all slots are taken. The
    // server also enforces this, but a local check gives an
    // instant message without a round-trip.
    if (!isEdit && slotUsage && slotUsage.isFull === true) {
      showFormStatus(
        '❌ All ' + MAX_SLOTS + ' slots are taken. Delete or edit an existing ad first.',
        'error'
      );
      return;
    }

    if (linkType === 'product' && !linkTargetId) {
      showFormStatus('❌ Please choose which product this ad should open.', 'error');
      return;
    }

    // Section 2D — determine the effective media type for the clamp.
    //   - On create: the type of the file the admin just selected.
    //   - On edit without a new file: fall back to the stored ad
    //     type so the clamp uses the right cap. We don't have the
    //     ad object in scope here, so we read the media badge in
    //     the preview if one is present, and otherwise let the
    //     server-side clamp do the final enforcement.
    //     If the admin uploaded a new file, selectedMediaType is set.
    var effectiveMediaType = window.selectedMediaType || null;
    if (!effectiveMediaType && isEdit) {
      // Look at the preview to see whether the existing media is a
      // video (the preview element type is "VIDEO") or an image.
      var previewEl = byId('mediaPreview');
      var videoInPreview = previewEl ? previewEl.querySelector('video') : null;
      effectiveMediaType = videoInPreview ? 'video' : 'image';
    }
    if (!effectiveMediaType) effectiveMediaType = 'image';

    // Build payload
    var formData = new FormData();
    if (window.selectedMediaFile) formData.append('media', window.selectedMediaFile);
    if (title) formData.append('title', title);
    if (description) formData.append('description', description);
    formData.append('link_type', linkType);
    if (linkType === 'product') formData.append('link_target_id', linkTargetId);

    // Section 2D — clamp the duration before sending. The server
    // clamps again, so this is purely a UX improvement: the admin
    // sees the correct value saved, not a silently rewritten one.
    var clamped = clampDurationForMedia(effectiveMediaType, displayDuration);
    if (clamped !== null) formData.append('display_duration', String(clamped));

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
        // N.5 — the server's 409 message is the canonical one
        // ("You have reached the maximum of 3 ads. Delete or edit
        // an existing ad to free a slot."). Surface it verbatim.
        throw new Error(data.error || 'Failed to save ad');
      }

      // N.6 — pick up the slot-usage update the server just sent
      // so the badge and form cap refresh without a second call.
      if (data.slot_usage) {
        slotUsage = data.slot_usage;
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

    // N.5 — after reset we are back to "create" mode, so re-apply
    // the slot cap if the business is full.
    applySlotCapToForm({ editing: false });
  }

  function cancelEdit() {
    resetForm();
  }

  // ============================================================
  //  N — LOAD ADS LIST
  //
  //  N.6 — The server returns { ads, slot_usage }. The list is
  //  already ordered by slot ascending; we never re-sort it.
  //  slot_usage is cached so the badge and form cap stay in sync.
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
      var payload = await res.json();

      // Backward-compatible: accept either { ads, slot_usage }
      // (new) or a bare array (old server).
      var ads;
      if (Array.isArray(payload)) {
        ads = payload;
        slotUsage = null;
      } else {
        ads = Array.isArray(payload.ads) ? payload.ads : [];
        slotUsage = payload.slot_usage || null;
      }

      if (badge) badge.textContent = String(ads.length);

      // N.5 / N.6 — refresh the badge and the form cap from the
      // latest slot usage.
      renderSlotUsage();
      applySlotCapToForm({ editing: Boolean(window.editingAdId) });

      if (!ads || ads.length === 0) {
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
  //  N — AD CARD
  //
  //  Each card shows the ad's slot number so the admin can see at
  //  a glance that the position is stable across edits.
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

    // N.6 — slot pill. Falls back to "—" when the server has not
    // sent a slot (older backend).
    var slotNumber = Number.isInteger(Number(ad.slot)) ? Number(ad.slot) : null;
    var slotPill = slotNumber !== null
      ? '<span class="status-pill" style="background:#e0e7ff; color:#3730a3;">' +
          '<i class="fas fa-layer-group"></i> Slot ' + slotNumber +
        '</span>'
      : '';

    // Target label
    var targetLabel = '<span class="target-label"><i class="fas fa-store"></i> Business profile</span>';
    if (ad.link_type === 'product') {
      var productName = ad.product_name || ('Product #' + (ad.link_target_id || ''));
      targetLabel = '<span class="target-label"><i class="fas fa-tag"></i> ' + escapeHtml(productName) + '</span>';
    }

    // Duration label — Section 2D uses the new 4s / 20s defaults.
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
      '<div class="ad-card ' + (ad.is_active ? '' : 'is-paused') + '" data-id="' + ad.id + '" data-slot="' + (slotNumber || '') + '">' +
        '<div class="ad-card-media">' +
          mediaThumb +
          mediaBadge +
        '</div>' +
        '<div class="ad-card-body">' +
          '<div class="ad-card-header">' +
            '<h3 class="ad-card-title">' + (ad.title ? escapeHtml(ad.title) : '<em>Untitled ad</em>') + '</h3>' +
            '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
              slotPill +
              statusPill +
            '</div>' +
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
      var payload = await res.json();
      var ads = Array.isArray(payload) ? payload : (payload.ads || []);

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
      if (formTitle) {
        var slotNote = Number.isInteger(Number(ad.slot)) ? ' (slot ' + ad.slot + ')' : '';
        formTitle.innerHTML = '<i class="fas fa-edit"></i> Edit Ad' + slotNote;
      }

      var submitBtn = byId('adSubmitBtn');
      if (submitBtn) submitBtn.innerHTML = '<i class="fas fa-check"></i> Save Changes';

      var cancelBtn = byId('adCancelBtn');
      if (cancelBtn) cancelBtn.style.display = 'inline-flex';

      // N.3 — editing never consumes a slot, so keep the form
      // usable even when all three slots are taken.
      applySlotCapToForm({ editing: true });

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

      if (data.slot_usage) slotUsage = data.slot_usage;

      showToast(data.ad && data.ad.is_active ? '✅ Ad activated.' : '⏸️ Ad paused.', 'success');
      await loadAds();
    } catch (err) {
      console.error('Toggle ad error:', err);
      showToast('❌ ' + err.message, 'error');
    }
  }

  async function deleteAd(adId) {
    if (!confirm('Delete this ad permanently? This cannot be undone. Its slot will be freed for a new ad.')) return;

    try {
      var res = await fetch('/api/business-admin/ads/' + adId, {
        method: 'DELETE',
        credentials: 'same-origin'
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete ad');

      // N.4 — the freed slot is reported back so we can update the
      // badge immediately even before loadAds() re-fetches.
      if (data.slot_usage) slotUsage = data.slot_usage;

      var freed = Number.isInteger(Number(data.freed_slot)) ? ' Slot ' + data.freed_slot + ' is now free.' : '';
      showToast('✅ Ad deleted.' + freed, 'success');
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

  // N.5 / N.6 — expose the slot helpers so business-admin.js can
  // re-apply them if it ever needs to. Names are stable.
  window.renderAdSlotUsage  = renderSlotUsage;
  window.applyAdSlotCapToForm = applySlotCapToForm;

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

  console.log('✅ Ad Management JS loaded (Section J.2 / N / 2D — slot-based rotation, capped durations)');
})();