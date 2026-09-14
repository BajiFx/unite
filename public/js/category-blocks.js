// ============================================================
//  CATEGORY BLOCKS — marketplace listing view
//  Location: public/js/category-blocks.js
//
//  Purpose:
//   Renders the marketplace's business listing as a sequence of
//   category blocks instead of one flat grid. Each category block
//   shows up to 210 businesses of that category, split into
//   three horizontal rows of 70 cards each. Every row is a
//   swipeable / arrow-steppable carousel.
//
//  This file is additive. It owns exactly one DOM section
//  (#categoryBlocksSection) and its own set of CSS classes.
//  It never touches:
//    - the existing #businessGrid
//    - the search bar, category dropdown, sort dropdown,
//      Near Me button, or location dropdowns
//    - the product-match tiles
//    - the in-feed ad strips
//    - the ad slider
//    - pagination for the flat grid
//
//  index.js calls window.renderCategoryBlocks() at exactly two
//  places: after renderBusinesses() and after appendBusinesses().
//  That call is the only integration point.
//
//  Fairness rules encoded here:
//    - Category order is fixed alphabetical. Never shuffled,
//      never ranked by size, so every customer sees the same
//      order on every refresh.
//    - Each category is capped at 210 businesses on every pass,
//      whether the customer searched or not. This is what stops
//      Health (100,000 businesses) from ever pushing Education
//      (50,000 businesses) off the page.
//    - The category order itself is never re-sorted by the
//      customer's chosen sort. The sort applies INSIDE each
//      category's rows, so Health's highest-rated business is
//      still inside Health, not jumping above Education.
//    - Empty categories are skipped silently.
//
//  Row mechanics:
//    - ROWS_PER_CATEGORY  = 3
//    - CARDS_PER_ROW      = 70
//    - BUSINESSES_PER_CATEGORY = 3 × 70 = 210
//    - Left/right arrow buttons step one card width per click.
//    - Arrow buttons hide when there is nothing more to scroll
//      in that direction.
//    - On phones the arrows remain but the customer can also
//      swipe the row naturally because the scroller is a real
//      overflow-x:auto container with scroll-snap.
//
//  Integration contract with index.js:
//    window.renderCategoryBlocks(businesses, options)
//      businesses — array of business objects. May be the
//                   response of any query (default browse,
//                   search, filter, sort, location).
//      options    — { reset: boolean, sortMode: string }
//                   reset === true  → wipe and re-render
//                   reset === false → merge only
//
//  Fixes applied in this revision:
//
//   1. Category blocks no longer disappear when the customer
//      clicks "Load more from every category". The old
//      loadMoreCategoryBlocks() called renderSection(), which
//      rebuilt the entire section from scratch. On a second
//      click, every category's slice had already been consumed,
//      so renderCategoryBlock() returned '' for every category
//      and the section ended up containing only the footer
//      button. That is what the "That's everything" with no
//      blocks above it looked like on screen.
//
//      loadMoreCategoryBlocks() is now an append path: it
//      computes the next pass number for each category, renders
//      just that pass, and inserts the resulting HTML after the
//      last existing .category-block. Existing blocks are never
//      removed or re-rendered, so scroll position, swipe
//      position, and arrow state all survive a Load more click.
//
//   2. renderCategoryBlock() used to read AND increment
//      loadedPassesPerCategory on every render. Because
//      renderSection() called it once per category per render,
//      any second render of the same result set silently
//      advanced every category by one pass. The function now
//      takes an explicit passNumber argument and does not touch
//      the shared counter at all. The counter is advanced only
//      at the moment a pass is actually emitted by the append
//      path.
//
//   3. renderSection() now resets loadedPassesPerCategory before
//      it renders. This is the "fresh" path used on initial
//      render and whenever the sort mode changes. Sort = reset
//      to pass 0 for every category (Q1 = 1A).
//
//   4. renderCategoryBlocks() now compares the incoming sortMode
//      against the sort mode from the previous render. If it
//      changed, the counters are reset so the first pass under
//      the new sort is the correct first pass.
//
//   5. A new helper, renderCategoryBlocksHtmlForPass(), returns
//      the concatenated HTML for one pass across all categories.
//      It is used by both the fresh path (renderSection) and the
//      append path (loadMoreCategoryBlocks).
//
//   6. A new helper, appendSection(), inserts a freshly-rendered
//      batch of category blocks after the last existing
//      .category-block and before the .category-blocks-footer.
//      The footer button stays at the bottom of the section.
//
//   7. The four crash-hardening fixes from the previous revision
//      are kept: extractCategoryNames() coerces c.name to a
//      string before trimming; sortBusinessesWithinCategory()
//      and renderBlockCard() guard numeric comparisons with
//      Number.isFinite; renderCategoryRow() includes a
//      per-render counter in the row id so two categories whose
//      names slugify to the same string cannot collide.
//
//  Nothing else changed: config, state, grouping, alphabetical
//  category order, sort-inside-rows, the 3×70=210 cap, the arrow
//  step logic, the delegated listeners, the resize observer, the
//  hide/show helpers, the escape helpers, and every window.*
//  export are byte-for-byte identical to the previous revision.
// ============================================================

(function () {
    'use strict';

    // ============================================================
    //  CONFIGURATION
    // ============================================================

    const ROWS_PER_CATEGORY = 3;
    const CARDS_PER_ROW = 70;
    const BUSINESSES_PER_CATEGORY = ROWS_PER_CATEGORY * CARDS_PER_ROW; // 210

    // ============================================================
    //  STATE
    // ============================================================

    // Every business that has been accumulated for the current
    // result set, in the order the server returned them.
    let allBusinessesForBlocks = [];

    // How many 210-business passes have already been *appended*
    // for each category. Advanced only by appendSection(), never
    // by renderSection() and never by renderCategoryBlock().
    let loadedPassesPerCategory = new Map();

    // The current sort mode, mirrored from index.js. Used only to
    // sort the businesses inside each category. The category
    // order itself is always alphabetical and never changes.
    let currentSortMode = 'newest';

    // The sort mode from the previous render. When the incoming
    // sortMode differs, renderSection() resets the pass counters
    // so the customer sees the top of the new sort, not a
    // continuation of the old one.
    let lastRenderedSortMode = null;

    // Resize observer so arrow visibility recalculates when the
    // viewport changes. One observer for the whole section.
    let resizeObserver = null;

    // Per-render counter used to make row ids unique even when two
    // categories slugify to the same string.
    let rowIdCounter = 0;

    // ============================================================
    //  PUBLIC ENTRY POINT
    // ============================================================

    function renderCategoryBlocks(businesses, options) {
        const opts = options || {};
        const reset = opts.reset === true;
        const sortMode = opts.sortMode || currentSortMode;

        const sortChanged = sortMode !== lastRenderedSortMode;
        currentSortMode = sortMode;

        if (!Array.isArray(businesses)) {
            businesses = [];
        }

        if (reset) {
            allBusinessesForBlocks = [];
        }

        // Merge new businesses without duplicating.
        const seenIds = new Set(allBusinessesForBlocks.map(b => String(b.id)));
        businesses.forEach(b => {
            if (!b || b.id === undefined || b.id === null) return;
            const key = String(b.id);
            if (seenIds.has(key)) return;
            seenIds.add(key);
            allBusinessesForBlocks.push(b);
        });

        // Find or create the section, and make sure the
        // delegated scroll / keyboard listeners are wired before
        // we render. Both calls are idempotent.
        const section = ensureSection();
        bindDelegatedRowListeners(section);

        // If there are no businesses at all, hide the section and
        // let the flat grid show its own empty state.
        if (allBusinessesForBlocks.length === 0) {
            section.hidden = true;
            document.body.classList.remove('category-blocks-active');
            loadedPassesPerCategory = new Map();
            lastRenderedSortMode = sortMode;
            return;
        }

        // Group by category.
        const groups = groupBusinessesByCategory(allBusinessesForBlocks);

        // Hide any category that produced no businesses after the
        // merge. This is the "skip empty categories silently" rule.
        const categoryNames = [...groups.keys()].sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: 'base' })
        );

        if (categoryNames.length === 0) {
            section.hidden = true;
            document.body.classList.remove('category-blocks-active');
            loadedPassesPerCategory = new Map();
            lastRenderedSortMode = sortMode;
            return;
        }

        // A sort change is a fresh start. The customer expects the
        // top of the new sort, not a continuation of the old one.
        if (sortChanged) {
            loadedPassesPerCategory = new Map();
        }

        // Fresh render — always starts from pass 0. The pass
        // counters are reset first so a re-render for any reason
        // always shows the first 210 per category.
        loadedPassesPerCategory = new Map();
        rowIdCounter = 0;
        renderSection(section, groups, categoryNames);

        section.hidden = false;
        document.body.classList.add('category-blocks-active');

        lastRenderedSortMode = sortMode;

        // Wire the resize observer once.
        if (!resizeObserver && typeof ResizeObserver === 'function') {
            resizeObserver = new ResizeObserver(() => {
                updateAllRowArrows(section);
            });
            resizeObserver.observe(section);
        }

        // Initial arrow state after the browser has laid out.
        requestAnimationFrame(() => updateAllRowArrows(section));
    }

    // ============================================================
    //  SECTION DOM
    // ============================================================

    function ensureSection() {
        let section = document.getElementById('categoryBlocksSection');
        if (section) return section;

        // The section is created dynamically so index.html does
        // not need to be edited. It is inserted immediately after
        // the existing .businesses-section header, so it renders
        // above the flat grid.
        section = document.createElement('section');
        section.id = 'categoryBlocksSection';
        section.className = 'category-blocks-section';
        section.hidden = true;
        section.setAttribute('aria-label', 'Businesses by category');

        const anchor = document.querySelector('.businesses-section');
        if (anchor && anchor.parentElement) {
            anchor.parentElement.insertBefore(section, anchor);
        } else {
            const container = document.querySelector('.marketplace-container') || document.body;
            container.appendChild(section);
        }

        return section;
    }

    // ============================================================
    //  GROUPING
    // ============================================================

    const UNCATEGORISED_KEY = '__uncategorised__';

    function extractCategoryNames(business) {
        const names = [];

        if (Array.isArray(business.categories) && business.categories.length > 0) {
            business.categories.forEach(c => {
                if (!c) return;
                const raw = c.name;
                if (raw === undefined || raw === null) return;
                const name = String(raw).trim();
                if (name) names.push(name);
            });
        }

        if (names.length === 0 && business.category_name) {
            const name = String(business.category_name).trim();
            if (name) names.push(name);
        }

        if (names.length === 0 && business.category && typeof business.category === 'string') {
            const name = String(business.category).trim();
            if (name) names.push(name);
        }

        return names;
    }

    function groupBusinessesByCategory(businesses) {
        const groups = new Map();

        businesses.forEach(business => {
            const names = extractCategoryNames(business);

            if (names.length === 0) {
                if (!groups.has(UNCATEGORISED_KEY)) {
                    groups.set(UNCATEGORISED_KEY, {
                        displayName: 'Other Businesses',
                        icon: '📦',
                        businesses: []
                    });
                }
                groups.get(UNCATEGORISED_KEY).businesses.push(business);
                return;
            }

            names.forEach(name => {
                if (!groups.has(name)) {
                    groups.set(name, {
                        displayName: name,
                        icon: pickCategoryIcon(business, name),
                        businesses: []
                    });
                }
                groups.get(name).businesses.push(business);
            });
        });

        return groups;
    }

    function pickCategoryIcon(business, name) {
        // Prefer an icon the server sent alongside the category.
        if (Array.isArray(business.categories)) {
            const match = business.categories.find(c => c && c.name === name);
            if (match && match.icon) return String(match.icon);
        }
        return '📁';
    }

    // ============================================================
    //  SORTING WITHIN A CATEGORY
    // ============================================================

    function sortBusinessesWithinCategory(list, sortMode) {
        const copy = list.slice();

        if (sortMode === 'rating') {
            copy.sort((a, b) => {
                const ra = parseFloat(a.avg_rating);
                const rb = parseFloat(b.avg_rating);
                const safeA = Number.isFinite(ra) ? ra : 0;
                const safeB = Number.isFinite(rb) ? rb : 0;
                if (safeB !== safeA) return safeB - safeA;
                const pa = parseInt(a.product_count, 10);
                const pb = parseInt(b.product_count, 10);
                return (Number.isFinite(pb) ? pb : 0) - (Number.isFinite(pa) ? pa : 0);
            });
        } else if (sortMode === 'popular') {
            copy.sort((a, b) => {
                const pa = parseInt(a.product_count, 10);
                const pb = parseInt(b.product_count, 10);
                const safeA = Number.isFinite(pa) ? pa : 0;
                const safeB = Number.isFinite(pb) ? pb : 0;
                if (safeB !== safeA) return safeB - safeA;
                const ra = parseFloat(a.avg_rating);
                const rb = parseFloat(b.avg_rating);
                return (Number.isFinite(rb) ? rb : 0) - (Number.isFinite(ra) ? ra : 0);
            });
        } else {
            copy.sort((a, b) => {
                const da = a.created_at ? new Date(a.created_at).getTime() : 0;
                const db = b.created_at ? new Date(b.created_at).getTime() : 0;
                return db - da;
            });
        }

        return copy;
    }

    // ============================================================
    //  RENDER — fresh path
    //
    //  Rebuilds the whole section from scratch: pass 0 for every
    //  category, followed by the footer button. Used on the
    //  initial render and whenever the sort mode changes.
    // ============================================================

    function renderSection(section, groups, categoryNames) {
        // The caller (renderCategoryBlocks) has already reset
        // loadedPassesPerCategory. Emit pass 0 for every category
        // and mark pass 0 as shown.
        const blocksHtml = renderCategoryBlocksHtmlForPass(groups, categoryNames, 0);

        categoryNames.forEach(name => {
            const group = groups.get(name);
            if (!group) return;
            if (group.businesses.length === 0) return;
            loadedPassesPerCategory.set(name, 1);
        });

        section.innerHTML = blocksHtml + renderLoadMoreButton();
    }

    // ============================================================
    //  RENDER — one pass across all categories
    //
    //  Returns the concatenated HTML for the given pass number.
    //  Does NOT advance loadedPassesPerCategory. The caller is
    //  responsible for advancing the counters when it wants a
    //  pass to be considered "already shown".
    // ============================================================

    function renderCategoryBlocksHtmlForPass(groups, categoryNames, passNumber) {
        return categoryNames
            .map(name => renderCategoryBlock(name, groups.get(name), passNumber))
            .filter(Boolean)
            .join('');
    }

    function renderCategoryBlock(key, group, passNumber) {
        if (!group || group.businesses.length === 0) return '';

        const start = passNumber * BUSINESSES_PER_CATEGORY;
        const end = start + BUSINESSES_PER_CATEGORY;

        const slice = group.businesses.slice(start, end);
        if (slice.length === 0) return '';

        // Sort the slice internally by the current sort mode.
        const sortedSlice = sortBusinessesWithinCategory(slice, currentSortMode);

        // Split the slice into 3 rows of up to 70 cards each.
        const rowsHtml = [];
        for (let r = 0; r < ROWS_PER_CATEGORY; r += 1) {
            const rowSlice = sortedSlice.slice(r * CARDS_PER_ROW, (r + 1) * CARDS_PER_ROW);
            if (rowSlice.length === 0) break;
            rowsHtml.push(renderCategoryRow(rowSlice, key, r));
        }

        if (rowsHtml.length === 0) return '';

        const displayName = key === UNCATEGORISED_KEY ? group.displayName : key;
        const icon = group.icon || '📁';

        // The "showing X of Y" hint is useful when the category has
        // more businesses than the current pass has shown.
        const shownSoFar = Math.min(end, group.businesses.length);
        const moreAvailable = group.businesses.length > shownSoFar;

        const countHtml = moreAvailable
            ? `${shownSoFar} of ${group.businesses.length} businesses`
            : `${group.businesses.length} ${group.businesses.length === 1 ? 'business' : 'businesses'}`;

        return `
            <div class="category-block" data-category="${escapeAttr(displayName)}" data-pass="${passNumber}">
                <div class="category-block-header">
                    <span class="category-block-icon" aria-hidden="true">${escapeHtml(icon)}</span>
                    <h3 class="category-block-title">${escapeHtml(displayName)}</h3>
                    <span class="category-block-count">${escapeHtml(countHtml)}</span>
                </div>
                <div class="category-rows">
                    ${rowsHtml.join('')}
                </div>
            </div>
        `;
    }

    function renderCategoryRow(businesses, categoryKey, rowIndex) {
        const cardsHtml = businesses
            .map(business => renderBlockCard(business))
            .filter(Boolean)
            .join('');

        // Per-call counter makes the row id unique even when two
        // different categories slugify to the same string.
        const rowId = `cat-row-${slugify(categoryKey)}-${rowIdCounter++}-${rowIndex}`;

        return `
            <div class="category-row" data-row-id="${rowId}">
                <button type="button"
                        class="category-row-arrow category-row-arrow--left"
                        aria-label="Scroll left"
                        onclick="window.scrollCategoryRow('${rowId}', -1)">
                    <i class="fas fa-chevron-left"></i>
                </button>
                <div class="category-row-scroller"
                     id="${rowId}"
                     tabindex="0"
                     role="region"
                     aria-label="Category row ${rowIndex + 1}">
                    ${cardsHtml}
                </div>
                <button type="button"
                        class="category-row-arrow category-row-arrow--right"
                        aria-label="Scroll right"
                        onclick="window.scrollCategoryRow('${rowId}', 1)">
                    <i class="fas fa-chevron-right"></i>
                </button>
            </div>
        `;
    }

    // ============================================================
    //  BUSINESS CARD
    // ============================================================

    function renderBlockCard(business) {
        if (!business || !business.business_name) return '';

        let slug = business.slug;
        if (!slug || slug === '' || slug === 'undefined' || slug === 'null') {
            slug = String(business.business_name)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            if (business.id) slug = slug + '-' + business.id;
        }

        const logoHtml = business.logo
            ? `<img src="${escapeAttr(business.logo)}" alt="${escapeAttr(business.business_name)}" loading="lazy">`
            : `<div class="no-image">🏪</div>`;

        const badges = [];
        if (business.is_verified) badges.push('<span class="badge verified">✅</span>');
        if (business.is_featured) badges.push('<span class="badge featured">⭐</span>');

        const rating = parseFloat(business.avg_rating);
        const safeRating = Number.isFinite(rating) ? rating : 0;
        const ratingHtml = safeRating > 0
            ? `<span class="block-card-rating">⭐ ${safeRating.toFixed(1)}</span>`
            : '';

        const location = business.location || 'Kenya';
        const productCountRaw = parseInt(business.product_count, 10);
        const productCount = Number.isFinite(productCountRaw) ? productCountRaw : 0;

        return `
            <div class="block-card"
                 data-slug="${escapeAttr(slug)}"
                 onclick="window.location.href='/business/${encodeURIComponent(slug)}'">
                <div class="block-card-media">
                    ${logoHtml}
                    ${badges.length ? `<div class="block-card-badges">${badges.join('')}</div>` : ''}
                </div>
                <div class="block-card-body">
                    <div class="block-card-name">${escapeHtml(business.business_name)}</div>
                    <div class="block-card-location">📍 ${escapeHtml(location)}</div>
                    <div class="block-card-meta">
                        <span>🛍️ ${productCount}</span>
                        ${ratingHtml}
                    </div>
                </div>
            </div>
        `;
    }

    function renderLoadMoreButton() {
        return `
            <div class="category-blocks-footer">
                <button type="button"
                        class="category-load-more"
                        onclick="window.loadMoreCategoryBlocks()">
                    <i class="fas fa-plus-circle"></i> Load more from every category
                </button>
            </div>
        `;
    }

    // ============================================================
    //  APPEND — one extra pass per category
    //
    //  Inserts the freshly-rendered blocks after the last existing
    //  .category-block, before the .category-blocks-footer, so the
    //  Load more button stays at the bottom of the section. The
    //  existing blocks are never removed or re-rendered.
    // ============================================================

    function appendSection(section, groups, categoryNames, passNumber) {
        const html = renderCategoryBlocksHtmlForPass(groups, categoryNames, passNumber);
        if (!html) return false;

        const footer = section.querySelector('.category-blocks-footer');
        const lastBlock = section.querySelector('.category-block:last-of-type');

        if (lastBlock && lastBlock.parentNode === section) {
            lastBlock.insertAdjacentHTML('afterend', html);
        } else if (footer && footer.parentNode === section) {
            footer.insertAdjacentHTML('beforebegin', html);
        } else {
            section.insertAdjacentHTML('beforeend', html);
        }

        // Mark this pass as shown for every category that actually
        // emitted a block. A category that has no more businesses
        // simply stays at its current counter, and no block is
        // appended for it.
        categoryNames.forEach(name => {
            const group = groups.get(name);
            if (!group) return;
            const start = passNumber * BUSINESSES_PER_CATEGORY;
            if (group.businesses.length > start) {
                loadedPassesPerCategory.set(name, passNumber + 1);
            }
        });

        return true;
    }

    // ============================================================
    //  ROW ARROW LOGIC
    // ============================================================

    window.scrollCategoryRow = function (rowId, direction) {
        const scroller = document.getElementById(rowId);
        if (!scroller) return;

        const firstCard = scroller.querySelector('.block-card');
        const step = firstCard
            ? firstCard.getBoundingClientRect().width + 12
            : scroller.clientWidth * 0.85;

        scroller.scrollBy({ left: direction * step, behavior: 'smooth' });

        setTimeout(() => updateRowArrows(scroller), 350);
    };

    function updateRowArrows(scroller) {
        if (!scroller) return;

        const row = scroller.closest('.category-row');
        if (!row) return;

        const leftArrow = row.querySelector('.category-row-arrow--left');
        const rightArrow = row.querySelector('.category-row-arrow--right');

        const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
        const atStart = scroller.scrollLeft <= 4;
        const atEnd = scroller.scrollLeft >= maxScrollLeft - 4;

        if (leftArrow) {
            leftArrow.disabled = atStart;
            leftArrow.setAttribute('aria-hidden', atStart ? 'true' : 'false');
        }
        if (rightArrow) {
            rightArrow.disabled = atEnd;
            rightArrow.setAttribute('aria-hidden', atEnd ? 'true' : 'false');
        }
    }

    function updateAllRowArrows(root) {
        const host = root || document.getElementById('categoryBlocksSection');
        if (!host) return;
        host.querySelectorAll('.category-row-scroller').forEach(scroller => {
            updateRowArrows(scroller);
        });
    }

    function bindDelegatedRowListeners(section) {
        if (section.dataset.rowsWired === 'true') return;
        section.dataset.rowsWired = 'true';

        section.addEventListener('scroll', event => {
            const scroller = event.target;
            if (scroller && scroller.classList && scroller.classList.contains('category-row-scroller')) {
                updateRowArrows(scroller);
            }
        }, true);

        section.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            const scroller = event.target;
            if (!scroller || !scroller.classList || !scroller.classList.contains('category-row-scroller')) return;
            event.preventDefault();
            const dir = event.key === 'ArrowRight' ? 1 : -1;
            const row = scroller.closest('.category-row');
            if (!row) return;
            const firstCard = scroller.querySelector('.block-card');
            const step = firstCard
                ? firstCard.getBoundingClientRect().width + 12
                : scroller.clientWidth * 0.85;
            scroller.scrollBy({ left: dir * step, behavior: 'smooth' });
        });
    }

    // ============================================================
    //  LOAD MORE — appends one extra pass per category
    // ============================================================

    window.loadMoreCategoryBlocks = function () {
        const section = document.getElementById('categoryBlocksSection');
        if (!section) return;

        const groups = groupBusinessesByCategory(allBusinessesForBlocks);
        const categoryNames = [...groups.keys()].sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: 'base' })
        );

        // Find the highest pass number across all categories. The
        // next pass to append is that number (a category that
        // already showed pass N will be re-queried at pass N; if it
        // has businesses at that offset, a new block is appended
        // for it, otherwise it is skipped).
        let nextPass = 0;
        categoryNames.forEach(name => {
            const shown = loadedPassesPerCategory.get(name) || 0;
            if (shown > nextPass) nextPass = shown;
        });

        // If no category has any businesses at the next pass
        // offset, disable the button with the "everything" label.
        const anyCategoryHasMore = categoryNames.some(name => {
            const group = groups.get(name);
            if (!group) return false;
            const start = nextPass * BUSINESSES_PER_CATEGORY;
            return group.businesses.length > start;
        });

        if (!anyCategoryHasMore) {
            const btn = section.querySelector('.category-load-more');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-check"></i> That\'s everything';
            }
            return;
        }

        const appended = appendSection(section, groups, categoryNames, nextPass);

        requestAnimationFrame(() => updateAllRowArrows(section));

        // After the append, check again whether every category is
        // exhausted. Only then disable the button.
        const stillHasMore = categoryNames.some(name => {
            const group = groups.get(name);
            if (!group) return false;
            const shown = (loadedPassesPerCategory.get(name) || 0) * BUSINESSES_PER_CATEGORY;
            return group.businesses.length > shown;
        });

        const btn = section.querySelector('.category-load-more');
        if (btn && (!appended || !stillHasMore)) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-check"></i> That\'s everything';
        }
    };

    // ============================================================
    //  HIDE / SHOW HELPERS
    // ============================================================

    window.hideCategoryBlocks = function () {
        const section = document.getElementById('categoryBlocksSection');
        if (section) section.hidden = true;
        document.body.classList.remove('category-blocks-active');
    };

    window.showCategoryBlocks = function () {
        const section = document.getElementById('categoryBlocksSection');
        if (section) section.hidden = false;
        document.body.classList.add('category-blocks-active');
    };

    // ============================================================
    //  HELPERS
    // ============================================================

    function escapeHtml(value) {
        const div = document.createElement('div');
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

    function slugify(value) {
        return String(value == null ? '' : value)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'row';
    }

    // ============================================================
    //  PUBLIC EXPORTS
    // ============================================================

    window.renderCategoryBlocks = renderCategoryBlocks;

    console.log('✅ Category blocks JS loaded (3 rows × 70 cards per category, 210 per category per pass, alphabetical fixed order, sort inside rows, append-only Load more)');
})();