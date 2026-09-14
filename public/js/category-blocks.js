// ============================================================
//  CATEGORY BLOCKS — marketplace listing view
//  Location: public/js/category-blocks.js
//
//  Purpose:
//   Renders the marketplace's business listing as a sequence of
//   category blocks instead of one flat grid. Each category block
//   shows up to 210 businesses of that category in ONE horizontal
//   row of up to 210 cards. That row is swipeable / arrow-
//   steppable on both desktop and mobile.
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
//      category's row, so Health's highest-rated business is
//      still inside Health, not jumping above Education.
//    - Empty categories are skipped silently.
//
//  Row mechanics:
//    - ROWS_PER_CATEGORY  = 1
//    - CARDS_PER_ROW      = 210
//    - BUSINESSES_PER_CATEGORY = 1 × 210 = 210
//    - A single left/right arrow pair steps one card width per
//      click.
//    - Arrow buttons hide when there is nothing more to scroll
//      in that direction.
//    - On phones the arrows remain but the customer can also
//      swipe the row naturally because the scroller is a real
//      overflow-x:auto container with scroll-snap.
//
//  Row-count revision (this revision):
//   The previous revision split each category into THREE rows of
//   70 cards each (3 × 70 = 210). This revision combines them
//   into ONE row of 210 cards. The per-category cap is unchanged
//   at 210. The visible effect is a single long horizontal
//   scroller per category instead of three shorter ones. Every
//   other behaviour — the append-only Load more, the arrow step,
//   the resize observer, the alphabetical category order, the
//   sort-inside-row, the empty-category skip, and the shared card
//   renderer delegation — is preserved exactly as it was.
//
//   Only two constants changed:
//     ROWS_PER_CATEGORY  3 → 1
//     CARDS_PER_ROW     70 → 210
//   BUSINESSES_PER_CATEGORY stays at 210 because it is still
//   ROWS_PER_CATEGORY * CARDS_PER_ROW.
//
//  Section 20260923 — Shared card renderer delegation
//
//   The block card used to be rendered by a local
//   renderBlockCard() function that had drifted from the flat
//   grid card in index.js. It was missing the search-tag chip,
//   the order-status badge, the full stats row, and the
//   description block. It also had its own image fallback that
//   diverged from the flat card.
//
//   This file delegates to window.renderBusinessCardShared()
//   defined in index.js:
//
//     window.renderBusinessCardShared(business, { size: 'block' })
//
//   The shared renderer:
//     - shows every field the flat grid card shows, at the
//       block-card size
//     - shows the new "What You Sell" ticker (Section 20260923)
//       when the business has product_keywords or, failing that,
//       the first 5 real product names
//     - prints the VERIFIED badge as a full word with a slow
//       blink (Verified badge revision)
//
//   If index.js has not yet defined window.renderBusinessCardShared
//   (e.g. category-blocks.js loaded first on some page), the
//   local renderBlockCardFallback() runs instead. The fallback
//   renders the same information set with locally-scoped markup
//   so a customer never sees an empty card.
// ============================================================

(function () {
    'use strict';

    // ============================================================
    //  CONFIGURATION
    //
    //  ONE row per category, up to 210 cards in that row.
    //  The per-category cap is unchanged at 210; only the way
    //  those 210 are laid out has changed (one row instead of
    //  three).
    // ============================================================

    const ROWS_PER_CATEGORY = 1;
    const CARDS_PER_ROW = 210;
    const BUSINESSES_PER_CATEGORY = ROWS_PER_CATEGORY * CARDS_PER_ROW; // still 210

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

        // ONE row per category. The loop below runs exactly once
        // because ROWS_PER_CATEGORY is 1. It is kept as a loop so
        // the file continues to support a multi-row layout if the
        // constant is ever raised again.
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
    //
    //  Section 20260923 — the block card is now rendered by the
    //  shared renderer in index.js so the two card types can never
    //  drift apart again. If the shared renderer is not available
    //  (e.g. category-blocks.js loaded before index.js on some
    //  page), renderBlockCardFallback() runs instead and renders
    //  the same information set with locally-scoped markup.
    // ============================================================

    function renderBlockCard(business) {
        if (!business || !business.business_name) return '';

        // Prefer the shared renderer so the block card matches the
        // flat grid card field-for-field.
        if (typeof window.renderBusinessCardShared === 'function') {
            try {
                const html = window.renderBusinessCardShared(business, { size: 'block' });
                if (html) return html;
            } catch (err) {
                console.warn('Shared card renderer failed; using local fallback.', err);
            }
        }

        return renderBlockCardFallback(business);
    }

    /**
     * Local fallback used only when index.js has not yet defined
     * the shared renderer. Renders the same information set that
     * the shared renderer does, using markup that mirrors it.
     */
    function renderBlockCardFallback(business) {
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

        // ---- Badges ---------------------------------------------
        const badges = [];
        if (business.is_verified) {
            badges.push('<span class="badge verified badge-verified-blink">✅ VERIFIED</span>');
        }
        if (business.is_featured) {
            badges.push('<span class="badge featured">⭐ FEATURED</span>');
        }

        const accepting = business.online_orders_enabled !== false;
        if (accepting) {
            badges.push('<span class="badge accepting-orders" title="This business is accepting online orders">🟢 Accepting Orders</span>');
        } else {
            badges.push('<span class="badge orders-paused" title="This business is not accepting online orders right now">🔴 Orders Paused</span>');
        }

        // ---- Search tag chip ------------------------------------
        const searchTagDisplay = business.search_display || '';
        const searchTagChip = (searchTagDisplay && business.search_tag_confirmed === true)
            ? `<button
                 type="button"
                 class="business-search-tag-chip"
                 data-search-tag="${escapeAttr(searchTagDisplay)}"
                 onclick="event.stopPropagation(); window.copyBusinessSearchTag(this)"
                 title="Click to copy this shop's search tag"
               >🔖 ${escapeHtml(searchTagDisplay)}</button>`
            : '';

        // ---- Description / ticker -------------------------------
        const tickerNames = Array.isArray(business.product_keywords)
            ? business.product_keywords.map(v => String(v || '').trim()).filter(Boolean)
            : [];

        let tickerHtml = '';
        if (tickerNames.length > 0) {
            const lines = tickerNames
                .map(name => `<span class="business-ticker-name">${escapeHtml(name)}</span>`)
                .join('');
            tickerHtml = `
                <div class="business-ticker" title="What this shop sells">
                    <div class="business-ticker-track">
                        ${lines}
                        ${lines}
                    </div>
                </div>
            `;
        }

        const description = business.description || '';
        const truncatedDesc = description.length > 100 ? description.substring(0, 100) + '...' : description;

        const descriptionOrTicker = tickerNames.length > 0
            ? tickerHtml
            : (truncatedDesc ? `<div class="business-description">${escapeHtml(truncatedDesc)}</div>` : '');

        // ---- Stats ----------------------------------------------
        const productCountRaw = parseInt(business.product_count, 10);
        const productCount = Number.isFinite(productCountRaw) ? productCountRaw : 0;

        const followerCountRaw = parseInt(business.follower_count, 10);
        const followerCount = Number.isFinite(followerCountRaw) ? followerCountRaw : 0;

        const reviewCountRaw = parseInt(business.review_count, 10);
        const reviewCount = Number.isFinite(reviewCountRaw) ? reviewCountRaw : 0;

        const ratingNum = parseFloat(business.avg_rating);
        const rating = Number.isFinite(ratingNum) ? ratingNum : 0;
        const ratingStars = rating > 0 ? '⭐'.repeat(Math.round(rating)) : '';
        const ratingDisplay = rating > 0
            ? `<span class="block-card-rating">${ratingStars} ${rating.toFixed(1)}</span>`
            : '';

        const location = business.location || 'Kenya';

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
                    ${searchTagChip}
                    <div class="block-card-location">📍 ${escapeHtml(location)}</div>
                    ${descriptionOrTicker}
                    <div class="block-card-meta">
                        <span>🛍️ ${productCount}</span>
                        <span>👥 ${followerCount}</span>
                        ${ratingDisplay}
                        ${reviewCount > 0 ? `<span>${reviewCount} reviews</span>` : ''}
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

    console.log('✅ Category blocks JS loaded (1 row × 210 cards per category, 210 per category per pass, alphabetical fixed order, sort inside row, append-only Load more, shared card renderer with "What You Sell" ticker)');
})();