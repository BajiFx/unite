// ============================================================
//  PHASE 1 — BUSINESS ADMIN COLOUR ROWS
//  Location: public/js/business-admin-variants.js
//
//  Purpose:
//   Own the "Add different colour of the similar product"
//   section inside the business admin product form. This file:
//     - renders the additional colour rows
//     - lets the admin add, remove, and reorder rows
//     - shows a live preview of each row's image and video
//     - keeps a hidden payload in sync with the DOM, so the
//       existing product submit handler can read the colours
//       with a single call
//     - validates the rows client-side so the admin sees an
//       inline error instead of a server round-trip
//     - warns softly after ten rows
//
//  Meaning (this revision):
//   Each row here is an ADDITIONAL colour, after the primary
//   colour that the admin declares in the parent product form's
//   own `Color` field. The customer page shows the primary
//   colour first, then every colour from these rows.
//
//  Layout (unchanged):
//   Three rows of two columns, reading top-to-bottom:
//
//     Row 1:  [ Colour name ]  [ Stock override ]
//     Row 2:  [ Price override ]  [ Old price ]
//     Row 3:  [ Image upload ]  [ Video upload ]
//
//   The remove button floats on the top-right of the row.
//   There is no colour-code picker and no discount field.
//
//  Starting state:
//   mount() starts with ONE blank row whose name is empty.
//   The admin types the additional colour name themselves.
//
//  Server safety net:
//   If the admin leaves the whole section empty on save, the
//   server's saveVariantsForProduct() still creates the
//   implicit Default variant. That server behaviour is
//   unchanged.
//
//  What this file does NOT do:
//     - It does not render the parent Color field. That field
//       lives in the parent product form and is written by
//       business-admin.js.
//     - It does not submit the form. The existing product
//       submit handler in business-admin.js does that.
//     - It does not upload media. The form's normal multipart
//       submit carries the files to the server.
//     - It does not touch the parent's image or video fields.
//     - It does not know about the customer-facing surfaces.
//
//  How it integrates:
//     The script exposes a small global object,
//     window.BusinessAdminVariants, with these functions:
//       - mount(containerSelector)
//       - readPayload()
//       - validate()
//       - loadFromVariants(variants)
//       - clear()
//       - addRow(initial)
//       - removeRow(row)
//       - updateRowNumbers()
//       - showSectionStatus(message, tone)
//       - clearSectionStatus()
//     business-admin.js calls mount() once on DOMContentLoaded,
//     calls loadFromVariants() when editing an existing product,
//     and calls readPayload() right before it builds the
//     FormData for the submit.
// ============================================================

(function () {
    'use strict';

    // ------------------------------------------------------------
    //  CONSTANTS
    // ------------------------------------------------------------

    // Soft hint threshold. After this many rows, a small note
    // appears encouraging the admin to keep the list short.
    var SOFT_ROW_HINT = 10;

    // Hard cap mirrors the server's MAX_VARIANTS_PER_PRODUCT.
    var HARD_ROW_CAP = 60;

    // Field name prefixes used when the row media files are
    // sent with the form.
    var VARIANT_IMAGE_FIELD_PREFIX = 'variant_image_';
    var VARIANT_VIDEO_FIELD_PREFIX = 'variant_video_';

    // ------------------------------------------------------------
    //  MODULE STATE
    // ------------------------------------------------------------

    var container = null;
    var rowCounter = 0;

    // ------------------------------------------------------------
    //  UTILITIES
    // ------------------------------------------------------------

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

    function nextRowId() {
        rowCounter += 1;
        return 'variant-row-' + rowCounter;
    }

    // ------------------------------------------------------------
    //  DOM BUILDING
    // ------------------------------------------------------------

    function buildRowElement(initial) {
        var data = initial || {};
        var rowId = nextRowId();

        var row = document.createElement('div');
        row.className = 'ba-variant-row';
        row.dataset.rowId = rowId;
        row.setAttribute('draggable', 'false');

        row.innerHTML =
            '<div class="ba-variant-drag" title="Drag to reorder">' +
                '<i class="fas fa-grip-vertical"></i>' +
            '</div>' +

            '<div class="ba-variant-fields">' +

                // ---- Row 1: colour name + stock ------------------
                '<div class="ba-variant-field ba-variant-field--name">' +
                    '<label>Colour name *</label>' +
                    '<input type="text" class="ba-variant-name" ' +
                        'placeholder="e.g. Navy Blue" maxlength="80" ' +
                        'autocomplete="off" spellcheck="false" ' +
                        'value="' + escapeAttr(data.name || '') + '">' +
                '</div>' +

                '<div class="ba-variant-field ba-variant-field--stock">' +
                    '<label>Stock override</label>' +
                    '<input type="number" min="0" step="1" class="ba-variant-stock" ' +
                        'placeholder="e.g. 288" ' +
                        'value="' + escapeAttr(data.stock != null ? data.stock : '') + '">' +
                '</div>' +

                // ---- Row 2: price + old price --------------------
                '<div class="ba-variant-field ba-variant-field--price">' +
                    '<label>Price override</label>' +
                    '<input type="number" min="0" step="0.01" class="ba-variant-price" ' +
                        'placeholder="e.g. 100" ' +
                        'value="' + escapeAttr(data.price || '') + '">' +
                '</div>' +

                '<div class="ba-variant-field ba-variant-field--old-price">' +
                    '<label>Old price</label>' +
                    '<input type="number" min="0" step="0.01" class="ba-variant-old-price" ' +
                        'placeholder="e.g. 150" ' +
                        'value="' + escapeAttr(data.old_price || '') + '">' +
                '</div>' +

                // ---- Row 3: image + video ------------------------
                '<div class="ba-variant-field ba-variant-field--image">' +
                    '<label>Image (optional)</label>' +
                    '<input type="file" class="ba-variant-image" ' +
                        'accept="image/jpeg,image/png,image/webp">' +
                    '<div class="ba-variant-preview ba-variant-preview--image" ' +
                        'data-preview-for="image"></div>' +
                '</div>' +

                '<div class="ba-variant-field ba-variant-field--video">' +
                    '<label>Video (optional)</label>' +
                    '<input type="file" class="ba-variant-video" ' +
                        'accept="video/mp4,video/webm">' +
                    '<div class="ba-variant-preview ba-variant-preview--video" ' +
                        'data-preview-for="video"></div>' +
                '</div>' +

            '</div>' +

            '<div class="ba-variant-actions">' +
                '<button type="button" class="ba-variant-remove" ' +
                    'title="Remove this colour">' +
                    '<i class="fas fa-trash"></i>' +
                '</button>' +
            '</div>' +

            '<input type="hidden" class="ba-variant-id" ' +
                'value="' + escapeAttr(data.id != null ? data.id : '') + '">' +
            '<input type="hidden" class="ba-variant-existing-image" ' +
                'value="' + escapeAttr(data.image || '') + '">' +
            '<input type="hidden" class="ba-variant-existing-video" ' +
                'value="' + escapeAttr(data.video || '') + '">' +
            '<input type="hidden" class="ba-variant-existing-poster" ' +
                'value="' + escapeAttr(data.video_poster_url || '') + '">';

        wireRowEvents(row, data);
        renderExistingPreview(row, data);

        return row;
    }

    function wireRowEvents(row, initial) {
        var nameInput = row.querySelector('.ba-variant-name');
        var imageInput = row.querySelector('.ba-variant-image');
        var videoInput = row.querySelector('.ba-variant-video');
        var removeBtn = row.querySelector('.ba-variant-remove');
        var dragHandle = row.querySelector('.ba-variant-drag');

        if (nameInput) {
            nameInput.addEventListener('input', function () {
                clearRowError(row);
            });
        }

        if (imageInput) {
            imageInput.addEventListener('change', function () {
                var file = imageInput.files && imageInput.files[0];
                renderFilePreview(row, 'image', file);
            });
        }

        if (videoInput) {
            videoInput.addEventListener('change', function () {
                var file = videoInput.files && videoInput.files[0];
                renderFilePreview(row, 'video', file);
            });
        }

        if (removeBtn) {
            removeBtn.addEventListener('click', function () {
                removeRow(row);
            });
        }

        if (dragHandle) {
            dragHandle.addEventListener('mousedown', function () {
                row.setAttribute('draggable', 'true');
            });
            dragHandle.addEventListener('touchstart', function () {
                row.setAttribute('draggable', 'true');
            }, { passive: true });

            row.addEventListener('dragend', function () {
                row.setAttribute('draggable', 'false');
            });
            row.addEventListener('mouseup', function () {
                row.setAttribute('draggable', 'false');
            });
            row.addEventListener('touchend', function () {
                row.setAttribute('draggable', 'false');
            });
        }

        wireDragAndDrop(row);
    }

    function renderFilePreview(row, kind, file) {
        var previewHost = row.querySelector(
            '.ba-variant-preview--' + kind
        );
        if (!previewHost) return;

        previewHost.innerHTML = '';

        if (!file) {
            var existingUrl = row.querySelector(
                kind === 'image'
                    ? '.ba-variant-existing-image'
                    : '.ba-variant-existing-video'
            );
            if (existingUrl && existingUrl.value) {
                appendPreviewElement(previewHost, kind, existingUrl.value, false);
            }
            return;
        }

        var objectUrl = URL.createObjectURL(file);
        appendPreviewElement(previewHost, kind, objectUrl, true, file.name);
    }

    function renderExistingPreview(row, data) {
        if (data.image) {
            var imageHost = row.querySelector('.ba-variant-preview--image');
            if (imageHost) {
                appendPreviewElement(imageHost, 'image', data.image, false);
            }
        }
        if (data.video) {
            var videoHost = row.querySelector('.ba-variant-preview--video');
            if (videoHost) {
                appendPreviewElement(
                    videoHost,
                    'video',
                    data.video_poster_url || data.video,
                    false
                );
            }
        }
    }

    function appendPreviewElement(host, kind, url, isNew, fileName) {
        if (!host || !url) return;

        var wrapper = document.createElement('div');
        wrapper.className = 'ba-variant-preview-item' +
            (isNew ? ' ba-variant-preview-item--new' : '');

        var img = document.createElement('img');
        img.src = url;
        img.alt = kind === 'video' ? 'Video preview' : 'Image preview';
        img.loading = 'lazy';
        img.onerror = function () {
            wrapper.classList.add('ba-variant-preview-item--broken');
        };
        wrapper.appendChild(img);

        if (kind === 'video') {
            var badge = document.createElement('span');
            badge.className = 'ba-variant-preview-badge';
            badge.innerHTML = '<i class="fas fa-play"></i> Video';
            wrapper.appendChild(badge);
        }

        if (isNew && fileName) {
            var label = document.createElement('span');
            label.className = 'ba-variant-preview-filename';
            label.textContent = fileName;
            wrapper.appendChild(label);
        }

        host.appendChild(wrapper);
    }

    // ------------------------------------------------------------
    //  ROW MANAGEMENT
    // ------------------------------------------------------------

    function addRow(initial) {
        if (!container) return null;

        var currentCount = container.querySelectorAll('.ba-variant-row').length;
        if (currentCount >= HARD_ROW_CAP) {
            showSectionStatus(
                'You have reached the maximum number of colours for one product.',
                'error'
            );
            return null;
        }

        var row = buildRowElement(initial);
        container.appendChild(row);

        var nameInput = row.querySelector('.ba-variant-name');
        if (nameInput) {
            try { nameInput.focus(); } catch (err) { /* no-op */ }
        }

        updateRowNumbers();
        updateAddButtonState();
        updateSoftHint();

        return row;
    }

    function removeRow(row) {
        if (!container || !row) return;

        var rows = container.querySelectorAll('.ba-variant-row');
        if (rows.length <= 1) {
            var nameInput = row.querySelector('.ba-variant-name');
            var priceInput = row.querySelector('.ba-variant-price');
            var oldPriceInput = row.querySelector('.ba-variant-old-price');
            var stockInput = row.querySelector('.ba-variant-stock');
            var imageInput = row.querySelector('.ba-variant-image');
            var videoInput = row.querySelector('.ba-variant-video');
            var idInput = row.querySelector('.ba-variant-id');
            var existingImage = row.querySelector('.ba-variant-existing-image');
            var existingVideo = row.querySelector('.ba-variant-existing-video');
            var existingPoster = row.querySelector('.ba-variant-existing-poster');

            if (nameInput) nameInput.value = '';
            if (priceInput) priceInput.value = '';
            if (oldPriceInput) oldPriceInput.value = '';
            if (stockInput) stockInput.value = '';
            if (imageInput) imageInput.value = '';
            if (videoInput) videoInput.value = '';
            if (idInput) idInput.value = '';
            if (existingImage) existingImage.value = '';
            if (existingVideo) existingVideo.value = '';
            if (existingPoster) existingPoster.value = '';

            var imagePreview = row.querySelector('.ba-variant-preview--image');
            var videoPreview = row.querySelector('.ba-variant-preview--video');
            if (imagePreview) imagePreview.innerHTML = '';
            if (videoPreview) videoPreview.innerHTML = '';

            clearRowError(row);
            return;
        }

        row.remove();
        updateRowNumbers();
        updateAddButtonState();
        updateSoftHint();
    }

    function updateRowNumbers() {
        if (!container) return;
        var rows = container.querySelectorAll('.ba-variant-row');
        rows.forEach(function (row, index) {
            row.dataset.index = String(index);

            var numberBadge = row.querySelector('.ba-variant-number');
            if (numberBadge) {
                numberBadge.textContent = String(index + 1);
            }

            var imageInput = row.querySelector('.ba-variant-image');
            var videoInput = row.querySelector('.ba-variant-video');
            if (imageInput) {
                imageInput.name = VARIANT_IMAGE_FIELD_PREFIX + index;
            }
            if (videoInput) {
                videoInput.name = VARIANT_VIDEO_FIELD_PREFIX + index;
            }
        });
    }

    function updateAddButtonState() {
        if (!container) return;
        var addBtn = document.getElementById('baVariantsAddBtn');
        if (!addBtn) return;
        var count = container.querySelectorAll('.ba-variant-row').length;
        addBtn.disabled = count >= HARD_ROW_CAP;
    }

    function updateSoftHint() {
        if (!container) return;
        var hint = document.getElementById('baVariantsSoftHint');
        if (!hint) return;
        var count = container.querySelectorAll('.ba-variant-row').length;
        if (count >= SOFT_ROW_HINT) {
            hint.style.display = 'block';
        } else {
            hint.style.display = 'none';
        }
    }

    // ------------------------------------------------------------
    //  DRAG AND DROP REORDERING
    // ------------------------------------------------------------

    var dragSourceRow = null;

    function wireDragAndDrop(row) {
        row.addEventListener('dragstart', function (event) {
            dragSourceRow = row;
            row.classList.add('ba-variant-row--dragging');
            try {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', row.dataset.rowId || '');
            } catch (err) { /* no-op */ }
        });

        row.addEventListener('dragend', function () {
            row.classList.remove('ba-variant-row--dragging');
            dragSourceRow = null;
            document.querySelectorAll('.ba-variant-row--drop-target')
                .forEach(function (el) {
                    el.classList.remove('ba-variant-row--drop-target');
                });
        });

        row.addEventListener('dragover', function (event) {
            if (!dragSourceRow || dragSourceRow === row) return;
            event.preventDefault();
            row.classList.add('ba-variant-row--drop-target');
        });

        row.addEventListener('dragleave', function () {
            row.classList.remove('ba-variant-row--drop-target');
        });

        row.addEventListener('drop', function (event) {
            if (!dragSourceRow || dragSourceRow === row) return;
            event.preventDefault();
            row.classList.remove('ba-variant-row--drop-target');

            var rect = row.getBoundingClientRect();
            var isAfter = event.clientY > rect.top + rect.height / 2;
            if (isAfter) {
                row.parentNode.insertBefore(dragSourceRow, row.nextSibling);
            } else {
                row.parentNode.insertBefore(dragSourceRow, row);
            }

            updateRowNumbers();
        });
    }

    // ------------------------------------------------------------
    //  VALIDATION AND READ
    // ------------------------------------------------------------

    function clearRowError(row) {
        if (!row) return;
        row.classList.remove('ba-variant-row--error');
        var nameInput = row.querySelector('.ba-variant-name');
        if (nameInput) nameInput.classList.remove('ba-variant-input--error');
    }

    function markRowError(row, message) {
        if (!row) return;
        row.classList.add('ba-variant-row--error');
        var nameInput = row.querySelector('.ba-variant-name');
        if (nameInput) nameInput.classList.add('ba-variant-input--error');

        if (message) {
            showSectionStatus(message, 'error');
        }
    }

    function clearSectionStatus() {
        var statusEl = document.getElementById('baVariantsStatus');
        if (!statusEl) return;
        statusEl.textContent = '';
        statusEl.className = 'ba-variants-status';
    }

    function showSectionStatus(message, tone) {
        var statusEl = document.getElementById('baVariantsStatus');
        if (!statusEl) return;
        statusEl.textContent = message || '';
        statusEl.className = 'ba-variants-status' +
            (tone ? ' ba-variants-status--' + tone : '');
    }

    function readPayload() {
        if (!container) return [];
        var rows = container.querySelectorAll('.ba-variant-row');
        var payload = [];

        rows.forEach(function (row) {
            var idInput = row.querySelector('.ba-variant-id');
            var nameInput = row.querySelector('.ba-variant-name');
            var priceInput = row.querySelector('.ba-variant-price');
            var oldPriceInput = row.querySelector('.ba-variant-old-price');
            var stockInput = row.querySelector('.ba-variant-stock');
            var existingImage = row.querySelector('.ba-variant-existing-image');
            var existingVideo = row.querySelector('.ba-variant-existing-video');
            var existingPoster = row.querySelector('.ba-variant-existing-poster');

            payload.push({
                id: idInput && idInput.value ? Number(idInput.value) : null,
                name: nameInput ? nameInput.value.trim() : '',
                color_code: '',
                price: priceInput ? priceInput.value.trim() : '',
                old_price: oldPriceInput ? oldPriceInput.value.trim() : '',
                discount_percent: '',
                stock: stockInput ? stockInput.value.trim() : '',
                image: existingImage ? existingImage.value : '',
                video: existingVideo ? existingVideo.value : '',
                video_poster_url: existingPoster ? existingPoster.value : ''
            });
        });

        return payload;
    }

    function validate() {
        if (!container) return { ok: true };
        var rows = container.querySelectorAll('.ba-variant-row');
        var seenNames = new Map();

        for (var i = 0; i < rows.length; i += 1) {
            var row = rows[i];
            var nameInput = row.querySelector('.ba-variant-name');
            var name = nameInput ? nameInput.value.trim() : '';

            var priceInput = row.querySelector('.ba-variant-price');
            var oldPriceInput = row.querySelector('.ba-variant-old-price');
            var stockInput = row.querySelector('.ba-variant-stock');
            var price = priceInput ? priceInput.value.trim() : '';
            var oldPrice = oldPriceInput ? oldPriceInput.value.trim() : '';
            var stock = stockInput ? stockInput.value.trim() : '';

            clearRowError(row);

            var rowHasAnyInput = Boolean(
                name || price || oldPrice || stock
            );

            if (!rowHasAnyInput) {
                continue;
            }

            if (!name) {
                return {
                    ok: false,
                    row: row,
                    message: 'Colour ' + (i + 1) + ': please give this colour a name.'
                };
            }
            if (name.length > 80) {
                return {
                    ok: false,
                    row: row,
                    message: 'Colour ' + (i + 1) + ': the name must be 80 characters or fewer.'
                };
            }

            var key = name.toLowerCase();
            if (seenNames.has(key)) {
                return {
                    ok: false,
                    row: row,
                    message: 'Colour ' + (i + 1) + ': the name "' + name +
                        '" is used by colour ' + (seenNames.get(key) + 1) + '.'
                };
            }
            seenNames.set(key, i);

            if (price !== '' && (Number(price) < 0 || !Number.isFinite(Number(price)))) {
                return {
                    ok: false,
                    row: row,
                    message: 'Colour ' + (i + 1) + ': the price must be a positive number.'
                };
            }

            if (oldPrice !== '' && (Number(oldPrice) < 0 || !Number.isFinite(Number(oldPrice)))) {
                return {
                    ok: false,
                    row: row,
                    message: 'Colour ' + (i + 1) + ': the old price must be a positive number.'
                };
            }

            if (stock !== '' && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) {
                return {
                    ok: false,
                    row: row,
                    message: 'Colour ' + (i + 1) + ': the stock must be a whole number, zero or more.'
                };
            }
        }

        return { ok: true };
    }

    // ------------------------------------------------------------
    //  PUBLIC MOUNT AND LOAD
    // ------------------------------------------------------------

    function mount(containerSelector) {
        container = document.querySelector(
            containerSelector || '#baVariantsRows'
        );

        if (!container) {
            console.warn(
                'BusinessAdminVariants: container not found. ' +
                'The colour section will not be available.'
            );
            return;
        }

        var addBtn = document.getElementById('baVariantsAddBtn');
        if (addBtn && !addBtn.dataset.wired) {
            addBtn.dataset.wired = 'true';
            addBtn.addEventListener('click', function () {
                clearSectionStatus();
                addRow({});
            });
        }

        if (container.querySelectorAll('.ba-variant-row').length === 0) {
            addRow({ name: '' });
        }

        updateRowNumbers();
        updateAddButtonState();
        updateSoftHint();
    }

    function loadFromVariants(variants) {
        if (!container) return;
        container.innerHTML = '';

        var list = Array.isArray(variants) ? variants : [];
        if (list.length === 0) {
            addRow({ name: '' });
            return;
        }

        list.forEach(function (variant) {
            addRow({
                id: variant.id,
                name: variant.name || '',
                price: variant.price || '',
                old_price: variant.old_price || '',
                stock: variant.stock != null ? variant.stock : '',
                image: variant.image || '',
                video: variant.video || '',
                video_poster_url: variant.video_poster_url || ''
            });
        });

        updateRowNumbers();
        updateAddButtonState();
        updateSoftHint();
    }

    function clear() {
        if (!container) return;
        container.innerHTML = '';
        clearSectionStatus();
        addRow({ name: '' });
    }

    // ------------------------------------------------------------
    //  EXPORTS
    // ------------------------------------------------------------

    window.BusinessAdminVariants = {
        mount: mount,
        loadFromVariants: loadFromVariants,
        readPayload: readPayload,
        validate: validate,
        clear: clear,
        addRow: addRow,
        removeRow: removeRow,
        updateRowNumbers: updateRowNumbers,
        showSectionStatus: showSectionStatus,
        clearSectionStatus: clearSectionStatus
    };

    console.log('✅ BusinessAdminVariants loaded (additional colours after the primary colour)');
})();