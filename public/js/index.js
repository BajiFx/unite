// ============================================================
//  INDEX.JS - COMPLETE FIXED VERSION
//  Location: public/js/index.js
//
//  Section D — Smart customer search
//  D.3 — Find Near Me button requests GPS once and re-runs the
//        search sorted nearest-first.
//  D.4 — distance_km is displayed on each card when an anchor
//        was used.
//  D.5 — When an anchor is used, the server already returns the
//        list sorted nearest-first.
//  D.7 — Location filters (typed search + dropdowns) combine with
//        the free-text business search and category filter.
//  D.8 — Location filters combine with search + category filter.
//  D.10 — Turn off location clears the customer's own coordinates.
//  D.11 — Customer coordinates are sent to the server only as
//        query parameters. Never persisted from the client.
//  D.12 — Find Near Me also acts as refresh when already active.
//
//  Section H — Cart and order visibility
//  H.6 — createBusinessCard() renders a 🟢 / 🔴 status badge
//        that tells customers whether the business is currently
//        accepting online orders.
//
//  Section J — Marketplace hero ad slider (split layout)
//  J.4 — The Featured Businesses grid is replaced by the ad
//        slider. The slider sits at the top of the marketplace,
//        below the hero banner and above the search bar.
//  J.5 — Auto-rotation with pause-on-hover, prev/next buttons,
//        dot indicators, and a thin progress bar. Images default
//        to 6s, videos default to 60s; the per-ad
//        display_duration overrides either default.
//  J.6 — Clicking a slide records the click and then navigates
//        to the ad's target (business profile or a product).
//  J.7 — Each slide fires an impression once per display so the
//        business admin's views/clicks/CTR stay accurate.
//
//  J.5c — Split layout markup note:
//        Slides are inserted into #adsMediaFrame (the square left
//        column), not into #adsSlider. The right column
//        (#adsRightPanel) is a static reserved blue panel and is
//        never touched by this script. Prev/next buttons and the
//        progress bar live inside #adsMediaFrame and are therefore
//        not wiped when slides are re-rendered.
//
//  J.5d — Image liveness:
//        Image slides carry a colourful brand gradient backdrop
//        that fills the whole square frame so nothing looks empty.
//        The gradient pair comes from renderAdSlide() via the
//        --ad-bg-a and --ad-bg-b CSS variables, picked
//        deterministically per ad id from a small vibrant palette.
//        The sharp image on top uses object-fit: contain, so
//        nothing is cropped. Video slides keep their single
//        element and play normally.
//
//  MERGED BAR — Search + location
//        The search input and the location controls have been
//        merged into a single compact row. See:
//          getCombinedSearchText()
//          updateLocationStatusChip()
//          bindLocationControls()
//        #businessSearch is now the only visible input; the old
//        #locationSearchInput is a hidden proxy so existing
//        listeners do not need to be removed.
//
//  Autofill hardening:
//   Chromium (Edge and Chrome) writes autofilled values directly
//   into the input's `value` property using native bindings that
//   bypass the JS prototype setter. The only reliable intercept
//   is an INSTANCE-LEVEL property descriptor installed on each
//   specific input element. clearSpuriousSearchAutofill() below
//   does exactly that — and also guards defaultValue and the
//   `value` attribute path that some Chromium builds take.
//
//  Categories-load hardening:
//   loadCategories() no longer throws when /api/businesses/categories/all
//   returns a non-OK response (e.g. 500 from an upstream DB hiccup).
//   Instead, it logs a warning and leaves the "All categories"
//   dropdown in its default state. This means a single broken
//   endpoint can no longer short-circuit the whole marketplace
//   load and prevent businesses from rendering.
// ============================================================

// ============================================================
//  GLOBALS
// ============================================================

window.customerToken = 'cookie-auth';

let currentPage = 1;
let hasMore = true;
let isLoading = false;
const limit = 12;
let allBusinesses = [];
let currentPanel = null;
let currentUser = null;
let isLoggedIn = false;
let currentLoginType = 'customer';
let currentRegisterType = 'customer';

// Autofill guard flag for the marketplace search input.
let marketplaceSearchWasTyped = false;

// Cache of business categories loaded once from the API.
let businessCategoriesCache = null;

// Section D — per-page customer coordinates. Never persisted.
let marketplaceCustomerCoords = {
  latitude: null,
  longitude: null,
  source: null          // 'ip' | 'gps' | 'account' | null
};

// Has the customer already been asked for GPS on this page?
let gpsUpgradeAttempted = false;

// Cache of distinct location values per field, fetched once per page.
const locationValuesCache = {};

// ------------------------------------------------------------
// Typed location search state (Section D.7)
// ------------------------------------------------------------
let locationSearchText = '';
let locationSearchDebounceTimer = null;
const LOCATION_SEARCH_DEBOUNCE_MS = 350;

// ------------------------------------------------------------
// Section J — Marketplace ad slider state
// ------------------------------------------------------------
const AD_DEFAULTS = Object.freeze({
  imageSeconds: 6,
  videoSeconds: 60
});

/* Palette used for the image-slide backdrop. Each ad deterministically
   picks one pair based on its id, so the same ad always looks the same
   every time the slider loads. All pairs are vibrant and warm, matching
   the BidhaaLink brand — green, gold, teal, coral, violet, etc. */
const AD_BACKDROP_PALETTE = [
  ['#16a34a', '#facc15'],  // green → gold
  ['#0ea5e9', '#22c55e'],  // sky → emerald
  ['#f97316', '#facc15'],  // orange → gold
  ['#8b5cf6', '#ec4899'],  // violet → pink
  ['#0f766e', '#4ade80'],  // deep teal → mint
  ['#e11d48', '#fb923c'],  // rose → orange
  ['#2563eb', '#06b6d4']   // blue → cyan
];

let adsList = [];
let adsCurrentIndex = 0;
let adsTimer = null;
let adsProgressTimer = null;
let adsProgressStart = 0;
let adsCurrentDurationMs = 0;
let adsIsPaused = false;
let adsImpressionFiredFor = new Set();
let adsSliderBound = false;

// ============================================================
//  AUTO-FILL GUARD
// ============================================================

/**
 * Autofill guard.
 *
 * Chromium (Edge and Chrome) writes autofilled values directly to
 * the `value` property of the input via native bindings, bypassing
 * the JS setter on the prototype. The only reliable interception
 * point is an instance-level property descriptor on the specific
 * element.
 */
function clearSpuriousSearchAutofill(inputId, wasTyped = () => false) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const looksLikeEmail = (value) =>
    typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

  const realDescriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value'
  );

  if (!realDescriptor || !realDescriptor.get || !realDescriptor.set) {
    const clearLoop = () => {
      if (!wasTyped() && looksLikeEmail(input.value)) input.value = '';
    };
    clearLoop();
    [50, 150, 350, 700, 1200, 2000].forEach(ms => setTimeout(clearLoop, ms));
    return;
  }

  if (!wasTyped() && looksLikeEmail(input.value)) {
    realDescriptor.set.call(input, '');
  }

  Object.defineProperty(input, 'value', {
    configurable: true,
    get() {
      return realDescriptor.get.call(input);
    },
    set(next) {
      if (!wasTyped() && looksLikeEmail(next)) {
        return;
      }
      realDescriptor.set.call(input, next);
    }
  });

  try {
    const defaultDescriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      'defaultValue'
    );
    if (defaultDescriptor && defaultDescriptor.get && defaultDescriptor.set) {
      Object.defineProperty(input, 'defaultValue', {
        configurable: true,
        get() {
          return defaultDescriptor.get.call(input);
        },
        set(next) {
          if (!wasTyped() && looksLikeEmail(next)) {
            return;
          }
          defaultDescriptor.set.call(input, next);
        }
      });
    }
  } catch (err) {
    // Non-fatal — the value interceptor alone is usually enough.
  }

  try {
    const observer = new MutationObserver(() => {
      if (wasTyped()) return;
      const attrValue = input.getAttribute('value');
      if (looksLikeEmail(attrValue)) {
        input.removeAttribute('value');
        realDescriptor.set.call(input, '');
      }
    });
    observer.observe(input, { attributes: true, attributeFilter: ['value'] });
  } catch (err) {
    // Non-fatal.
  }

  const purgeIfAutofilled = () => {
    if (!wasTyped() && looksLikeEmail(input.value)) {
      realDescriptor.set.call(input, '');
    }
  };

  input.addEventListener('keydown', purgeIfAutofilled);
  input.addEventListener('paste', purgeIfAutofilled);
  input.addEventListener('beforeinput', purgeIfAutofilled);

  let ticks = 0;
  const tick = setInterval(() => {
    ticks += 1;
    purgeIfAutofilled();
    if (ticks >= 20) clearInterval(tick);
  }, 500);
}

// ============================================================
//  SEARCH QUERY HELPERS (Section D)
// ============================================================

function getMarketplaceSearchQuery() {
  const input = document.getElementById('businessSearch');
  const value = input?.value?.trim() || '';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    if (input) input.value = '';
    return '';
  }
  return value;
}

function getLocationSearchQuery() {
  const input = document.getElementById('locationSearchInput');
  const value = input?.value?.trim() || '';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    if (input) input.value = '';
    return '';
  }
  return value;
}

function queryNeedsCustomerLocation(query) {
  if (!query) return false;
  const q = String(query).toLowerCase();

  if (/\bwithin\s+\d+\s*k?m?s?\b/.test(q)) return true;

  if (/\b(near|nearby|nearer|nearest|close|closer|closest)\b/.test(q)) return true;
  if (/\b(near|close|closest|closer)\s+to\s+me\b/.test(q)) return true;
  if (/\bnear\s+me\b/.test(q)) return true;
  if (/\baround\s+me\b/.test(q)) return true;
  if (/\baround\s+here\b/.test(q)) return true;
  if (/\bnear\s+here\b/.test(q)) return true;
  if (/\bin\s+my\s+(area|side)\b/.test(q)) return true;
  if (/\bmy\s+(area|side|location)\b/.test(q)) return true;
  if (/\bnear\s+my\s+(home|shop)\b/.test(q)) return true;
  if (/\bnear\s+home\b/.test(q)) return true;
  if (/\b(next|beside)\s+to\s+me\b/.test(q)) return true;

  if (/\b(karibu|hapa|huku|mtaa|mtaani|kwetu|nyumbani)\b/.test(q)) return true;
  if (/\bkaribu\s+(nami|na\s+mimi|nasi)\b/.test(q)) return true;
  if (/\b(mtaa|area|side)\s+yangu\b/.test(q)) return true;
  if (/\bhapa\s+karibu\b/.test(q)) return true;

  return false;
}

function maybeSuggestNearKeyword(value) {
  const hint = document.getElementById('searchNearHint');
  const input = document.getElementById('businessSearch');
  if (!input) return;
  const v = String(value || '').trim().toLowerCase();

  if (hint) hint.remove();

  if (!v) return;
  if (!/^n(e(a(r)?)?)?$/.test(v)) return;

  const el = document.createElement('div');
  el.id = 'searchNearHint';
  el.className = 'search-near-hint';
  el.innerHTML = `Press <strong>Enter</strong> to search <em>"${v} me"</em>`;
  input.parentElement.appendChild(el);

  setTimeout(() => { if (el.parentElement) el.remove(); }, 2500);
}

function requestCustomerCoordinates() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  });
}

async function fetchApproximateLocationFromIp() {
  try {
    const res = await fetch('/api/location/ip-locate', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!res.ok) return null;
    const data = await res.json();
    const latitude = Number(data?.latitude);
    const longitude = Number(data?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return {
      latitude,
      longitude,
      city: data.city || null,
      region: data.region || null,
      country: data.country || null,
      source: 'ip'
    };
  } catch (err) {
    return null;
  }
}

async function ensureCustomerCoordinates() {
  if (marketplaceCustomerCoords.latitude !== null) return marketplaceCustomerCoords;

  const approx = await fetchApproximateLocationFromIp();
  if (approx) {
    marketplaceCustomerCoords = approx;
    updateLocationStatusChip();
    return marketplaceCustomerCoords;
  }

  const coords = await requestCustomerCoordinates();
  if (coords) {
    marketplaceCustomerCoords = {
      latitude: coords.latitude,
      longitude: coords.longitude,
      accuracy: coords.accuracy,
      source: 'gps'
    };
    updateLocationStatusChip();
  }
  return marketplaceCustomerCoords;
}

function showLocationBanner() {
  const banner = document.getElementById('locationBanner');
  if (banner) banner.hidden = false;
}

function hideLocationBanner() {
  const banner = document.getElementById('locationBanner');
  if (banner) banner.hidden = true;
}

// ============================================================
//  SECTION D — Location status chip + controls wiring
//  (MERGED BAR)
// ============================================================

/* MERGED BAR — updateLocationStatusChip
   The chip is now a compact pill in the merged search bar.
   - Shows 📍 GPS / 📍 Saved / 📍 Approx instead of the long form.
   - The full description is exposed as a tooltip.
   - Find Near Me re-renders with the .loc-pill-label span so the
     responsive CSS can hide the label on very narrow screens. */
function updateLocationStatusChip() {
  const chip = document.getElementById('locationStatusChip');
  const offBtn = document.getElementById('turnOffLocationBtn');
  const findBtn = document.getElementById('findNearMeBtn');
  const hasCoords = marketplaceCustomerCoords.latitude !== null;

  if (chip) {
    if (hasCoords) {
      // Short label so the chip stays compact in the merged bar.
      // The full source is still available as a tooltip.
      const short = marketplaceCustomerCoords.source === 'gps'
        ? { label: 'GPS', title: 'Precise GPS location active' }
        : marketplaceCustomerCoords.source === 'account'
          ? { label: 'Saved', title: 'Location saved to your account' }
          : { label: 'Approx', title: 'Approximate location (estimated from IP)' };

      chip.innerHTML = `<i class="fas fa-map-marker-alt"></i> ${short.label}`;
      chip.title = short.title;
      chip.hidden = false;
    } else {
      chip.hidden = true;
      chip.removeAttribute('title');
    }
  }

  if (offBtn) offBtn.hidden = !hasCoords;

  if (findBtn) {
    // Preserve the label span so the responsive CSS can hide it on
    // narrow screens and show only the icon.
    findBtn.innerHTML = hasCoords
      ? '<i class="fas fa-sync-alt"></i> <span class="loc-pill-label">Refresh</span>'
      : '<i class="fas fa-location-crosshairs"></i> <span class="loc-pill-label">Near Me</span>';
  }
}

/* MERGED BAR — bindLocationControls
   The location controls are now individual pills and buttons
   inside the merged bar. This function wires them:
   - #findNearMeBtn : requests GPS, saves coords, re-runs the search
   - #turnOffLocationBtn : one-tap ✕ next to the chip
   - #locationFiltersToggle : opens #locationFilters row
   - #clearLocationFiltersBtn : clears the dropdowns
   - #locationSearchInput is a hidden proxy — no listeners attached.
   - #locationSearchClearBtn is hidden; also no listeners attached. */
function bindLocationControls() {
  const findBtn = document.getElementById('findNearMeBtn');
  const offBtn = document.getElementById('turnOffLocationBtn');
  const clearFiltersBtn = document.getElementById('clearLocationFiltersBtn');
  const filtersToggle = document.getElementById('locationFiltersToggle');
  const filtersPanel = document.getElementById('locationFilters');

  // ---- D.3 / D.5 / D.12 — Find Near Me / Refresh Near Me ----
  if (findBtn) {
    findBtn.addEventListener('click', async () => {
      const original = findBtn.innerHTML;
      findBtn.disabled = true;
      findBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span class="loc-pill-label">Locating…</span>';

      const coords = await requestCustomerCoordinates();
      findBtn.disabled = false;
      findBtn.innerHTML = original;

      if (!coords) {
        showToast('We could not get your precise location. You can still type a place name, e.g. "in Nairobi".', 'warning');
        return;
      }

      marketplaceCustomerCoords = {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        source: 'gps'
      };
      updateLocationStatusChip();
      hideLocationBanner();

      loadBusinesses(true, { forceNearest: true });
    });
  }

  // ---- D.10 — Turn off location (one-tap ✕) ----
  if (offBtn) {
    offBtn.addEventListener('click', async () => {
      marketplaceCustomerCoords = { latitude: null, longitude: null, source: null };
      gpsUpgradeAttempted = true;
      updateLocationStatusChip();
      showToast('Location sharing is off for this session.', 'info');

      try {
        await fetch('/api/location/customer/deactivate', {
          method: 'POST',
          credentials: 'same-origin'
        });
      } catch (err) {
        // Non-fatal.
      }

      loadBusinesses(true);
    });
  }

  // ---- D.7 — Filters panel toggle (opens the collapsed row) ----
  if (filtersToggle && filtersPanel) {
    filtersToggle.addEventListener('click', () => {
      const expanded = filtersToggle.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      filtersToggle.setAttribute('aria-expanded', String(next));
      filtersPanel.hidden = !next;
    });
  }

  // ---- D.7 — Clear all filters ----
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      document.querySelectorAll('#locationFilters select').forEach(sel => {
        sel.value = '';
      });
      locationSearchText = '';
      clearFiltersBtn.hidden = true;
      updateLocationFiltersCount();
      loadBusinesses(true);
    });
  }

  // ---- D.7 — Dropdown change handlers ----
  document.querySelectorAll('#locationFilters select').forEach(sel => {
    sel.addEventListener('change', () => {
      updateLocationFiltersCount();
      loadBusinesses(true);
    });
  });

  populateLocationFilters();
}

function updateLocationFiltersCount() {
  const countEl = document.getElementById('locationFiltersCount');
  const clearBtn = document.getElementById('clearLocationFiltersBtn');
  const anyDropdown = Array.from(document.querySelectorAll('#locationFilters select'))
    .filter(s => s.value).length;
  const hasText = locationSearchText.length > 0;
  const total = anyDropdown + (hasText ? 1 : 0);

  if (countEl) {
    countEl.textContent = String(total);
    countEl.hidden = total === 0;
  }
  if (clearBtn) clearBtn.hidden = total === 0;
}

/* MERGED BAR — getCombinedSearchText
   The merged bar has a single visible input (#businessSearch), so
   it is now the primary source. The hidden proxy input is still
   read as a fallback in case any legacy code writes into it. */
function getCombinedSearchText() {
  const marketplaceSearch = getMarketplaceSearchQuery();
  const hiddenLocationSearch = getLocationSearchQuery();
  return marketplaceSearch || hiddenLocationSearch;
}

async function populateLocationFilters() {
  const fields = ['continent', 'country', 'county', 'sub_county', 'town', 'ward'];

  for (const field of fields) {
    const select = document.querySelector(`#locationFilters select[data-location-field="${field}"]`);
    if (!select) continue;

    try {
      let values = locationValuesCache[field];
      if (!values) {
        const res = await fetch(`/api/businesses/locations/distinct?field=${encodeURIComponent(field)}`, {
          credentials: 'same-origin',
          cache: 'no-store'
        });
        if (!res.ok) {
          select.disabled = true;
          continue;
        }
        const data = await res.json();
        values = Array.isArray(data.locations) ? data.locations : [];
        locationValuesCache[field] = values;
      }

      if (!values.length) {
        select.innerHTML = `<option value="">No ${field.replace('_', ' ')} data yet</option>`;
        select.disabled = true;
        continue;
      }

      const current = select.value;
      select.innerHTML = `<option value="">All ${field.replace('_', ' ')}s</option>` +
        values.map(v => {
          const raw = String(v.value || '').trim();
          if (!raw) return '';
          return `<option value="${raw.replace(/"/g, '&quot;')}">${raw} (${v.business_count || 0})</option>`;
        }).join('');

      if (current) select.value = current;
      select.disabled = false;
    } catch (err) {
      select.disabled = true;
    }
  }
}

// ============================================================
//  INIT
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
  if (!document.getElementById('businessGrid')) return;
  console.log('📄 Index page loaded');

  clearSpuriousSearchAutofill('businessSearch', () => marketplaceSearchWasTyped);
  // The hidden location proxy is never visible, so autofill cannot
  // reach it. The guard is intentionally omitted.

  const businessSearch = document.getElementById('businessSearch');
  if (businessSearch) {
    businessSearch.value = '';
    businessSearch.defaultValue = '';

    businessSearch.addEventListener('pointerdown', () => {
      marketplaceSearchWasTyped = true;
    }, { once: true });
    businessSearch.addEventListener('keydown', () => {
      marketplaceSearchWasTyped = true;
    }, { once: true });
    businessSearch.addEventListener('paste', () => {
      marketplaceSearchWasTyped = true;
    }, { once: true });
    businessSearch.addEventListener('beforeinput', () => {
      marketplaceSearchWasTyped = true;
    }, { once: true });

    businessSearch.addEventListener('input', event => {
      marketplaceSearchWasTyped ||= ['insertText', 'insertFromPaste'].includes(event.inputType);
    });

    setTimeout(() => {
      if (!marketplaceSearchWasTyped) businessSearch.value = '';
    }, 500);

    businessSearch.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        searchBusinesses();
      }
    });
  }

  bindLocationBanner();
  bindLocationControls();
  updateLocationFiltersCount();
  primeIpLocationOnLoad();
  document.addEventListener('click', upgradeToPreciseLocationOnce, { once: true });

  loadMarketplace();
  checkAuthState();

  const requestedAuth = new URLSearchParams(window.location.search).get('auth');
  if (requestedAuth === 'login' || requestedAuth === 'register') {
    openAuthModal(requestedAuth);
  }

  const hamburger = document.getElementById('hamburgerBtn');
  if (hamburger) {
    hamburger.addEventListener('click', toggleMobileSidebar);
  }

  loadBusinessCategoriesForRegistration();
});

// ============================================================
//  LOCATION BANNER (Section D)
// ============================================================

function bindLocationBanner() {
  const btn = document.getElementById('enableLocationBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Getting location...';
    const coords = await requestCustomerCoordinates();
    btn.disabled = false;
    btn.innerHTML = original;

    if (coords) {
      marketplaceCustomerCoords = {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        source: 'gps'
      };
      updateLocationStatusChip();
      hideLocationBanner();
      searchBusinesses();
    } else {
      showToast('We could not get your location. You can still search by typing a place name, e.g. "in Nairobi".', 'warning');
    }
  });
}

// ============================================================
//  SILENT IP LOCATION + FIRST-CLICK GPS UPGRADE
// ============================================================

async function primeIpLocationOnLoad() {
  if (marketplaceCustomerCoords.latitude !== null) return;

  const approx = await fetchApproximateLocationFromIp();
  if (!approx) return;

  if (marketplaceCustomerCoords.latitude === null) {
    marketplaceCustomerCoords = approx;
    updateLocationStatusChip();
    console.log(`📍 Approximate location ready (${approx.city || approx.country || 'unknown'})`);
  }
}

async function upgradeToPreciseLocationOnce() {
  if (gpsUpgradeAttempted) return;
  gpsUpgradeAttempted = true;

  if (marketplaceCustomerCoords.source === 'gps') return;
  if (!navigator.geolocation) return;

  const coords = await requestCustomerCoordinates();
  if (!coords) return;

  marketplaceCustomerCoords = {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: coords.accuracy,
    source: 'gps'
  };
  updateLocationStatusChip();
  console.log('📍 Upgraded to precise GPS location');

  const activeQuery = getCombinedSearchText();
  if (queryNeedsCustomerLocation(activeQuery)) {
    loadBusinesses(true);
  }
}

// ============================================================
//  LOAD MARKETPLACE
// ============================================================

async function loadMarketplace() {
  try {
    await loadCategories();
    await loadAds();          // J.4 — replaces loadFeaturedBusinesses()
    await loadBusinesses();
    await loadPlatformStats();
    updateCartBadge();
    console.log('✅ Marketplace loaded successfully');
  } catch (err) {
    console.error('❌ Marketplace load error:', err);
    showToast('Error loading marketplace. Please refresh.', 'error');
  }
}

// ============================================================
//  LOAD CATEGORIES (for marketplace filter)
//
//  Hardened: a failing /api/businesses/categories/all response
//  (e.g. 500 from a transient DB error) must not abort the whole
//  marketplace load. We log a warning, keep the default "All
//  categories" option, and let the rest of loadMarketplace()
//  continue so businesses still render.
// ============================================================

async function loadCategories() {
  const select = document.getElementById('businessCategoryFilter');
  const defaultOption = '<option value="all">All categories</option>';

  try {
    const res = await fetch('/api/businesses/categories/all');
    if (!res.ok) {
      console.warn(`⚠️ Categories endpoint returned ${res.status}; using default option.`);
      if (select) select.innerHTML = defaultOption;
      return;
    }

    const categories = await res.json();

    if (!select) return;

    if (!Array.isArray(categories) || categories.length === 0) {
      select.innerHTML = defaultOption;
      return;
    }

    let html = defaultOption;
    categories.forEach(cat => {
      const value = String(cat.id);
      const label = `${cat.icon || '📦'} ${cat.name}`;
      html += `<option value="${value.replace(/"/g, '&quot;')}">${label.replace(/</g, '&lt;')}</option>`;
    });
    select.innerHTML = html;
  } catch (err) {
    console.warn('⚠️ Error loading categories:', err.message);
    if (select) select.innerHTML = defaultOption;
  }
}

// ============================================================
//  SECTION J — MARKETPLACE AD SLIDER (SPLIT LAYOUT)
//
//  J.4 — Replaces the old Featured Businesses grid. The slider
//        sits at the top of the marketplace, below the hero banner
//        and above the search bar.
//  J.5 — Auto-rotation, prev/next, dots, progress bar, pause-on-hover.
//  J.6 — Click → record click, then navigate.
//  J.7 — Impression fired once per slide display.
//
//  J.5c — Split layout: slides are inserted into #adsMediaFrame
//         (the square left column). The blue right column
//         (#adsRightPanel) is a static reserved panel and is
//         never touched by this script. Prev/next buttons and
//         the progress bar also live inside #adsMediaFrame, so
//         they survive a slide re-render.
//
//  J.5d — Image liveness: image slides carry a colourful brand
//         gradient backdrop behind the sharp image. The gradient
//         pair comes from AD_BACKDROP_PALETTE, chosen per ad id,
//         so every slide feels warm and branded instead of grey.
//         The sharp image uses object-fit: contain, so nothing
//         is cropped. Video slides stay single-element.
// ============================================================

async function loadAds() {
  const section = document.getElementById('adsSliderSection');
  const slider = document.getElementById('adsSlider');
  const dots = document.getElementById('adsDots');
  if (!section || !slider || !dots) return;

  try {
    const res = await fetch('/api/businesses/ads', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`Ads request failed (${res.status})`);

    const data = await res.json();
    adsList = Array.isArray(data.ads) ? data.ads.filter(ad => ad && ad.media_url) : [];

    if (adsList.length === 0) {
      // No active ads → the whole section stays hidden so the
      // marketplace simply has no slider today.
      section.hidden = true;
      return;
    }

    renderAdsSlider();
    section.hidden = false;
    bindAdsSliderOnce();
    startAdsRotation();
  } catch (err) {
    console.warn('Ads slider skipped:', err.message);
    section.hidden = true;
  }
}

function renderAdsSlider() {
  const mediaFrame = document.getElementById('adsMediaFrame');
  const dots = document.getElementById('adsDots');
  if (!mediaFrame || !dots) return;

  // Remove any previous slide nodes, but keep the nav buttons and
  // the progress bar (they live in the same media frame and are
  // referenced by id).
  mediaFrame.querySelectorAll('.ads-slide').forEach(node => node.remove());

  // Insert the new slides at the start of the media frame so that
  // the nav buttons and the progress bar keep painting on top.
  mediaFrame.insertAdjacentHTML(
    'afterbegin',
    adsList.map((ad, index) => renderAdSlide(ad, index)).join('')
  );

  dots.innerHTML = adsList.map((ad, index) => {
    const label = ad.title ? escapeAdsText(ad.title) : `Ad ${index + 1}`;
    return `
      <button
        type="button"
        class="ads-dot${index === 0 ? ' is-active' : ''}"
        data-ad-index="${index}"
        role="tab"
        aria-label="${label}"
        aria-selected="${index === 0 ? 'true' : 'false'}"
      ></button>
    `;
  }).join('');

  adsCurrentIndex = 0;
  adsImpressionFiredFor = new Set();
  updateAdsActiveSlide();

  dots.querySelectorAll('.ads-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      const idx = parseInt(dot.dataset.adIndex, 10);
      if (!Number.isInteger(idx)) return;
      goToAd(idx, { userInitiated: true });
    });
  });
}

/* Deterministic backdrop picker: the same ad id always produces the
   same gradient pair, so the slider looks stable across refreshes. */
function pickAdBackdrop(ad) {
  const id = Number(ad && ad.id) || 0;
  return AD_BACKDROP_PALETTE[Math.abs(id) % AD_BACKDROP_PALETTE.length];
}

function renderAdSlide(ad, index) {
  const isVideo = ad.media_type === 'video';
  const title = ad.title ? `<h3 class="ads-title">${escapeAdsText(ad.title)}</h3>` : '';
  const description = ad.description ? `<p class="ads-description">${escapeAdsText(ad.description)}</p>` : '';
  const businessName = ad.business_name ? `<span class="ads-business">${escapeAdsText(ad.business_name)}</span>` : '';

  // J.5d — Image slides get a colourful brand gradient behind the
  // sharp image. The gradient pair is seeded per ad id, so every
  // slide gets its own attractive colours instead of one flat grey.
  // The sharp image on top uses object-fit: contain so the whole
  // picture stays visible and is never cropped.
  //
  // Video slides stay single-element: a <video> already moves, so
  // it does not need the gradient treatment.
  const mediaSrc = escapeAdsAttr(ad.media_url);
  const mediaAlt = escapeAdsAttr(ad.title || ad.business_name || 'Sponsored');
  const [bgA, bgB] = pickAdBackdrop(ad);

  const media = isVideo
    ? `<video class="ads-media" src="${mediaSrc}" muted playsinline preload="metadata"></video>`
    : `
        <div class="ads-media-bg" aria-hidden="true" style="--ad-bg-a:${bgA}; --ad-bg-b:${bgB};"></div>
        <img class="ads-media" src="${mediaSrc}" alt="${mediaAlt}" loading="lazy">
      `;

  const slideClass = `ads-slide${index === 0 ? ' is-active' : ''} ${isVideo ? 'is-video' : 'is-image'}`;

  return `
    <div class="${slideClass}" data-ad-index="${index}" data-ad-id="${ad.id}">
      <div class="ads-media-wrap">
        ${media}
        <div class="ads-overlay"></div>
        <div class="ads-caption">
          ${businessName}
          ${title}
          ${description}
        </div>
      </div>
    </div>
  `;
}

function bindAdsSliderOnce() {
  if (adsSliderBound) return;
  adsSliderBound = true;

  const slider = document.getElementById('adsSlider');
  const prevBtn = document.getElementById('adsPrevBtn');
  const nextBtn = document.getElementById('adsNextBtn');

  if (prevBtn) {
    prevBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      goToAd(adsCurrentIndex - 1, { userInitiated: true });
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      goToAd(adsCurrentIndex + 1, { userInitiated: true });
    });
  }

  if (slider) {
    // J.5 — pause on hover / focus, resume on leave / blur.
    slider.addEventListener('mouseenter', () => { adsIsPaused = true; });
    slider.addEventListener('mouseleave', () => { adsIsPaused = false; });
    slider.addEventListener('focusin', () => { adsIsPaused = true; });
    slider.addEventListener('focusout', () => { adsIsPaused = false; });

    // J.6 — click a slide to open its target.
    slider.addEventListener('click', (event) => {
      // Ignore clicks that land on the nav buttons.
      if (event.target.closest('.ads-nav')) return;
      const slide = event.target.closest('.ads-slide');
      if (!slide) return;
      const idx = parseInt(slide.dataset.adIndex, 10);
      if (Number.isInteger(idx)) handleAdClick(idx);
    });

    // Keyboard navigation.
    slider.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goToAd(adsCurrentIndex - 1, { userInitiated: true });
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goToAd(adsCurrentIndex + 1, { userInitiated: true });
      }
    });
  }
}

function getAdDurationMs(ad) {
  const custom = Number(ad && ad.display_duration);
  if (Number.isFinite(custom) && custom > 0) return custom * 1000;
  return ad && ad.media_type === 'video'
    ? AD_DEFAULTS.videoSeconds * 1000    : AD_DEFAULTS.imageSeconds * 1000;
}

function startAdsRotation() {
  stopAdsRotation();
  if (adsList.length <= 1) {
    // Single ad: still fire an impression and freeze on it.
    if (adsList.length === 1) fireAdImpression(0);
    return;
  }
  scheduleNextAdTick();
}

function stopAdsRotation() {
  if (adsTimer) { clearTimeout(adsTimer); adsTimer = null; }
  if (adsProgressTimer) { clearInterval(adsProgressTimer); adsProgressTimer = null; }
}

function scheduleNextAdTick() {
  if (adsTimer) clearTimeout(adsTimer);
  if (adsProgressTimer) clearInterval(adsProgressTimer);

  const ad = adsList[adsCurrentIndex];
  if (!ad) return;

  adsCurrentDurationMs = getAdDurationMs(ad);
  adsProgressStart = Date.now();

  updateAdsProgressBar(0);

  // Pause loop: we still tick to update the progress bar, but we do
  // not advance the slide while adsIsPaused is true.
  adsProgressTimer = setInterval(() => {
    if (adsIsPaused) {
      // Reset the window so the remaining time is preserved while
      // paused, not consumed.
      adsProgressStart = Date.now() - (adsProgressStart ? 0 : 0);
      return;
    }
    const elapsed = Date.now() - adsProgressStart;
    const pct = Math.min(1, elapsed / adsCurrentDurationMs);
    updateAdsProgressBar(pct);
  }, 100);

  // A single timeout that checks whether we should advance. Because
  // the pause loop is separate, we simply re-arm the timeout each
  // time the slide changes.
  const tick = () => {
    if (adsIsPaused) {
      adsTimer = setTimeout(tick, 250);
      return;
    }
    const elapsed = Date.now() - adsProgressStart;
    if (elapsed >= adsCurrentDurationMs) {
      goToAd(adsCurrentIndex + 1);
    } else {
      adsTimer = setTimeout(tick, Math.max(100, adsCurrentDurationMs - elapsed));
    }
  };
  adsTimer = setTimeout(tick, adsCurrentDurationMs);
}

function updateAdsProgressBar(ratio) {
  const bar = document.getElementById('adsProgress');
  if (!bar) return;
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  bar.style.setProperty('--ads-progress', `${pct}%`);
  bar.style.width = `${pct}%`;
}

function goToAd(index, options = {}) {
  if (adsList.length === 0) return;
  const total = adsList.length;
  const next = ((index % total) + total) % total;

  adsCurrentIndex = next;
  adsImpressionFiredFor.add(next);
  updateAdsActiveSlide();
  fireAdImpression(next);
  scheduleNextAdTick();

  if (options.userInitiated) {
    // Small visual feedback when the user presses prev/next.
    const mediaFrame = document.getElementById('adsMediaFrame');
    if (mediaFrame) {
      mediaFrame.classList.remove('ads-pulse');
      // Force reflow so the animation can replay.
      void mediaFrame.offsetWidth;
      mediaFrame.classList.add('ads-pulse');
      setTimeout(() => mediaFrame.classList.remove('ads-pulse'), 300);
    }
  }
}

function updateAdsActiveSlide() {
  const mediaFrame = document.getElementById('adsMediaFrame');
  if (mediaFrame) {
    mediaFrame.querySelectorAll('.ads-slide').forEach(slide => {
      const idx = parseInt(slide.dataset.adIndex, 10);
      slide.classList.toggle('is-active', idx === adsCurrentIndex);
    });

    // Play the active video (if any) and pause the others.
    mediaFrame.querySelectorAll('.ads-slide').forEach(slide => {
      const idx = parseInt(slide.dataset.adIndex, 10);
      const video = slide.querySelector('video');
      if (!video) return;
      if (idx === adsCurrentIndex) {
        try { video.currentTime = 0; video.play().catch(() => {}); } catch (e) {}
      } else {
        try { video.pause(); } catch (e) {}
      }
    });
  }

  const dots = document.getElementById('adsDots');
  if (dots) {
    dots.querySelectorAll('.ads-dot').forEach(dot => {
      const idx = parseInt(dot.dataset.adIndex, 10);
      const active = idx === adsCurrentIndex;
      dot.classList.toggle('is-active', active);
      dot.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }
}

function fireAdImpression(index) {
  if (!Number.isInteger(index)) return;
  if (adsImpressionFiredFor.has(index)) return;
  adsImpressionFiredFor.add(index);

  const ad = adsList[index];
  if (!ad || !ad.id) return;

  // J.7 — fire-and-forget. The server increments views and
  // recomputes CTR. We never block the UI on this request.
  try {
    fetch(`/api/businesses/ads/${encodeURIComponent(ad.id)}/view`, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true
    }).catch(() => {});
  } catch (err) {
    // Non-fatal.
  }
}

async function handleAdClick(index) {
  if (!Number.isInteger(index)) return;
  const ad = adsList[index];
  if (!ad || !ad.id) return;

  // J.7 — fire-and-forget click tracking. Then navigate.
  let target = null;
  try {
    const res = await fetch(`/api/businesses/ads/${encodeURIComponent(ad.id)}/click`, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ad) target = data.ad;
    }
  } catch (err) {
    // Non-fatal — we still try to navigate using what the slide knows.
  }

  const linkType = (target && target.link_type) || ad.link_type || 'profile';
  const linkTargetId = (target && target.link_target_id) || ad.link_target_id || null;
  const businessSlug = (target && target.business_slug) || ad.business_slug || null;

  if (linkType === 'product' && linkTargetId) {
    const slugParam = businessSlug ? `&business=${encodeURIComponent(businessSlug)}` : '';
    window.location.href = `/product-detail.html?id=${encodeURIComponent(linkTargetId)}${slugParam}`;
    return;
  }

  if (businessSlug) {
    window.location.href = `/business/${encodeURIComponent(businessSlug)}`;
    return;
  }

  // Last resort: no target information at all — do nothing.
  console.warn('Ad has no navigable target:', ad);
}

function escapeAdsText(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function escapeAdsAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================================
//  A.1–A.3  LOAD BUSINESS CATEGORIES FOR REGISTRATION
// ============================================================

async function loadBusinessCategoriesForRegistration(forceReload = false) {
  const primarySelect = document.getElementById('regBusinessPrimaryCategory');
  if (!primarySelect) return;

  if (businessCategoriesCache && !forceReload) {
    populateRegisterCategorySelect(businessCategoriesCache);
    return;
  }

  primarySelect.innerHTML = '<option value="">⏳ Loading categories...</option>';
  primarySelect.disabled = true;
  const helpText = document.getElementById('regBusinessCategoryHelp');
  if (helpText) {
    helpText.style.display = 'block';
    helpText.style.color = '#94a3b8';
    helpText.textContent = 'Loading categories...';
  }
  const errEl = document.getElementById('businessCategoryError');
  if (errEl) errEl.style.display = 'none';

  try {
    const res = await fetch('/api/businesses/categories/all', { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to load categories (${res.status})`);
    const categories = await res.json();

    if (!Array.isArray(categories) || categories.length === 0) {
      throw new Error('No categories returned');
    }

    businessCategoriesCache = categories;
    populateRegisterCategorySelect(categories);
  } catch (err) {
    console.error('Error loading business categories:', err);
    primarySelect.innerHTML = '<option value="">❌ Categories could not be loaded</option>';
    primarySelect.disabled = true;
    if (helpText) {
      helpText.textContent = 'Categories could not be loaded. Please refresh the page and try again.';
      helpText.style.color = '#ef4444';
    }
    const additionalWrap = document.getElementById('regBusinessAdditionalCategoriesWrap');
    if (additionalWrap) additionalWrap.style.display = 'none';
  }
}

function populateRegisterCategorySelect(categories) {
  const primarySelect = document.getElementById('regBusinessPrimaryCategory');
  const additionalWrap = document.getElementById('regBusinessAdditionalCategoriesWrap');
  const additionalList = document.getElementById('regBusinessAdditionalCategories');
  if (!primarySelect) return;

  let html = '<option value="">Select a main category...</option>';
  categories.forEach(cat => {
    const label = `${cat.icon || '📦'} ${cat.name}`;
    html += `<option value="${cat.id}">${label}</option>`;
  });
  primarySelect.innerHTML = html;
  primarySelect.disabled = false;

  if (additionalList && additionalWrap) {
    additionalList.innerHTML = categories.map(cat => {
      const label = `${cat.icon || '📦'} ${cat.name}`;
      return `
        <label style="display:flex; align-items:center; gap:6px; font-size:0.8rem; color:#334155; cursor:pointer;">
          <input type="checkbox" class="reg-additional-category" value="${cat.id}" onchange="handleAdditionalCategoryChange()">
          <span>${label}</span>
        </label>
      `;
    }).join('');
    additionalWrap.style.display = 'block';
  }

  const helpText = document.getElementById('regBusinessCategoryHelp');
  if (helpText) {
    helpText.textContent = 'Pick the category (or categories) that best describe what your business sells.';
    helpText.style.color = '#94a3b8';
  }

  primarySelect.onchange = () => {
    const errEl = document.getElementById('businessCategoryError');
    if (errEl) errEl.style.display = 'none';
    primarySelect.style.borderColor = '#d1d5db';
    syncAdditionalCategoryOptions();
    handleAdditionalCategoryChange();
  };
}

function syncAdditionalCategoryOptions() {
  const primarySelect = document.getElementById('regBusinessPrimaryCategory');
  const primaryId = primarySelect ? primarySelect.value : '';
  document.querySelectorAll('.reg-additional-category').forEach(cb => {
    const matchesPrimary = cb.value === primaryId;
    if (matchesPrimary) {
      cb.checked = false;
      cb.disabled = true;
      cb.parentElement.style.opacity = '0.5';
    } else {
      cb.disabled = false;
      cb.parentElement.style.opacity = '1';
    }
  });
}

function handleAdditionalCategoryChange() {
  const errEl = document.getElementById('businessCategoryError');
  if (errEl) errEl.style.display = 'none';
  const primarySelect = document.getElementById('regBusinessPrimaryCategory');
  if (primarySelect) primarySelect.style.borderColor = '#d1d5db';
}

// ============================================================
//  LOAD BUSINESSES (Section D — smart search)
// ============================================================

async function loadBusinesses(reset = true, options = {}) {
  if (reset) {
    currentPage = 1;
    hasMore = true;
    allBusinesses = [];
  }
  if (isLoading || !hasMore) return;

  if (!marketplaceSearchWasTyped) {
    const bs = document.getElementById('businessSearch');
    if (bs && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bs.value.trim())) {
      bs.value = '';
    }
  }
  // The hidden proxy is never visible, so no autofill check is
  // needed for it.

  isLoading = true;

  const search = getCombinedSearchText();
  const category = document.getElementById('businessCategoryFilter')?.value || 'all';
  let sort = document.getElementById('sortFilter')?.value || 'newest';

  const forceNearest = options.forceNearest === true;

  let coords = marketplaceCustomerCoords;
  if (forceNearest || queryNeedsCustomerLocation(search)) {
    if (coords.latitude === null) {
      coords = await ensureCustomerCoordinates();
    }
    if (coords.latitude === null) {
      showLocationBanner();
    } else {
      hideLocationBanner();
    }
  } else {
    hideLocationBanner();
  }

  const params = new URLSearchParams();
  params.set('page', String(currentPage));
  params.set('limit', String(limit));
  if (search) params.set('search', search);
  if (category && category !== 'all') params.set('category', category);
  if (sort) params.set('sort', sort);

  document.querySelectorAll('#locationFilters select').forEach(sel => {
    const field = sel.dataset.locationField;
    const value = sel.value;
    if (field && value) params.set(field, value);
  });

  const shouldSendCoords = forceNearest || queryNeedsCustomerLocation(search);
  if (shouldSendCoords && coords.latitude !== null && coords.longitude !== null) {
    params.set('latitude', String(coords.latitude));
    params.set('longitude', String(coords.longitude));
  }

  params.set('_', String(Date.now()));

  try {
    const url = `/api/businesses?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to load businesses');
    const data = await res.json();
    const businesses = data.businesses || [];
    hasMore = data.pagination?.page < data.pagination?.pages;

    window.__lastSearchAnchor = data.anchor || null;

    if (reset) {
      allBusinesses = businesses;
      renderBusinesses();
    } else {
      allBusinesses = [...allBusinesses, ...businesses];
      appendBusinesses();
    }
    currentPage++;

    const loadMoreBtn = document.getElementById('loadMoreBtn');
    if (loadMoreBtn) {
      loadMoreBtn.style.display = hasMore ? 'inline-block' : 'none';
    }
  } catch (err) {
    console.error('❌ Error loading businesses:', err);
    showToast('Error loading businesses', 'error');
  } finally {
    isLoading = false;
  }
}

function renderBusinesses() {
  const container = document.getElementById('businessGrid');
  if (!container) return;

  if (!allBusinesses || allBusinesses.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1; text-align:center; padding:40px; color:#94a3b8;">
        <div style="font-size:2rem;">🔍</div>
        <h3 style="margin-top:8px;">No businesses found</h3>
        <p>Try adjusting your search or filters</p>
      </div>
    `;
    return;
  }

  container.innerHTML = allBusinesses.map(business => createBusinessCard(business)).join('');
}

function appendBusinesses() {
  const container = document.getElementById('businessGrid');
  if (!container) return;

  const start = Math.max(0, allBusinesses.length - limit);
  const newBusinesses = allBusinesses.slice(start);
  const newHtml = newBusinesses.map(business => createBusinessCard(business)).join('');
  container.innerHTML += newHtml;
}

// ============================================================
//  BUSINESS CARD (Section D.4 — distance badge)
//  Section H.6 — 🟢 / 🔴 order-status badge
// ============================================================

function getOrderStatusBadge(business) {
  const accepting = !business || business.online_orders_enabled !== false;
  if (accepting) {
    return '<span class="badge accepting-orders" title="This business is accepting online orders">🟢 Accepting Orders</span>';
  }
  return '<span class="badge orders-paused" title="This business is not accepting online orders right now">🔴 Orders Paused</span>';
}

function createBusinessCard(business) {
  let slug = business.slug;
  if (!slug || slug === '' || slug === 'undefined' || slug === 'null') {
    slug = business.business_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (business.id) slug = slug + '-' + business.id;
  }

  const logoHtml = business.logo
    ? `<img src="${business.logo}" alt="${business.business_name}" loading="lazy">`
    : `<div class="no-image">🏪</div>`;

  const rating = parseFloat(business.avg_rating) || 0;
  const ratingStars = rating > 0 ? '⭐'.repeat(Math.round(rating)) : '';
  const ratingDisplay = rating > 0 ? `<span class="rating">${ratingStars} ${rating.toFixed(1)}</span>` : '';

  const badges = [];
  if (business.is_verified) badges.push('<span class="badge verified">✅ Verified</span>');
  if (business.is_featured) badges.push('<span class="badge featured">⭐ Featured</span>');

  badges.push(getOrderStatusBadge(business));

  const description = business.description || '';
  const truncatedDesc = description.length > 100 ? description.substring(0, 100) + '...' : description;
  const productCount = business.product_count || 0;
  const followerCount = business.follower_count || 0;
  const reviewCount = business.review_count || 0;

  const escapedName = business.business_name.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const distanceKm = business.distance_km !== undefined && business.distance_km !== null
    ? Number(business.distance_km)
    : null;
  const distanceBadge = distanceKm !== null && Number.isFinite(distanceKm)
    ? `<div class="business-distance">📍 ${formatDistance(distanceKm)} away</div>`
    : '';

  return `
    <div class="business-card" data-slug="${slug}" data-name="${escapedName}" onclick="window.location.href='/business/${encodeURIComponent(slug)}'">
      <div class="card-image">
        ${logoHtml}
        <div class="card-badges">
          ${badges.join('')}
        </div>
      </div>
      <div class="card-body">
        <div class="business-name">${business.business_name}</div>
        <div class="business-location">📍 ${business.location || 'Kenya'}</div>
        ${distanceBadge}
        ${truncatedDesc ? `<div class="business-description">${truncatedDesc}</div>` : ''}
        <div class="business-stats">
          <span>🛍️ ${productCount} products</span>
          <span>👥 ${followerCount} followers</span>
          ${ratingDisplay}
          ${reviewCount > 0 ? `<span>${reviewCount} reviews</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

function formatDistance(km) {
  if (!Number.isFinite(km)) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

// ============================================================
//  LOAD PLATFORM STATS
// ============================================================

async function loadPlatformStats() {
  try {
    const [statisticsResponse, businessesResponse] = await Promise.all([
      fetch('/api/shop/statistics'),
      fetch('/api/businesses?limit=1&page=1')
    ]);
    if (!statisticsResponse.ok || !businessesResponse.ok) {
      throw new Error('Failed to load public marketplace statistics');
    }

    const [statistics, businesses] = await Promise.all([
      statisticsResponse.json(),
      businessesResponse.json()
    ]);
    const totalBusinesses = document.getElementById('totalBusinesses');
    const totalProducts = document.getElementById('totalProducts');
    const totalCustomers = document.getElementById('totalCustomers');
    if (totalBusinesses) totalBusinesses.textContent = businesses.pagination?.total || 0;
    if (totalProducts) totalProducts.textContent = statistics.totalProducts || 0;
    if (totalCustomers) totalCustomers.textContent = statistics.totalCustomers || 0;
  } catch (err) {
    console.error('Error loading platform stats:', err);
  }
}

// ============================================================
//  SEARCH & FILTER FUNCTIONS
// ============================================================

function searchBusinesses() {
  getMarketplaceSearchQuery();
  loadBusinesses(true);
}

function filterBusinesses() {
  getMarketplaceSearchQuery();
  loadBusinesses(true);
}

function loadMoreBusinesses() {
  loadBusinesses(false);
}

// ============================================================
//  UPDATE CART BADGE
// ============================================================

function updateCartBadge() {
  const cart = typeof getCart === 'function' ? getCart() : [];
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);

  const sidebarBadge = document.getElementById('sidebarCartBadge');
  if (sidebarBadge) {
    if (count > 0) {
      sidebarBadge.textContent = count;
      sidebarBadge.style.display = 'inline';
    } else {
      sidebarBadge.style.display = 'none';
    }
  }
}

// ============================================================
//  AUTH MODAL
// ============================================================

function openAuthModal(tab) {
  const modal = document.getElementById('authModal');
  if (!modal) return;

  const loginBusiness = document.getElementById('loginTypeBusiness');
  const registerBusiness = document.getElementById('registerTypeBusiness');
  const guestCartActions = document.getElementById('guestCartActions');
  if (loginBusiness) loginBusiness.style.display = '';
  if (registerBusiness) registerBusiness.style.display = '';
  if (guestCartActions) guestCartActions.remove();
  modal.classList.add('active');

  if (tab === 'login') {
    document.getElementById('authLoginContainer').style.display = 'block';
    document.getElementById('authRegisterContainer').style.display = 'none';
    document.getElementById('authLoginTitle').textContent = '🔑 Login';
    document.getElementById('loginStatus').textContent = '';
    document.getElementById('loginStatus').className = 'auth-status';
  } else {
    document.getElementById('authLoginContainer').style.display = 'none';
    document.getElementById('authRegisterContainer').style.display = 'block';
    document.getElementById('authRegisterTitle').textContent = '📝 Create Account';
    document.getElementById('customerRegisterStatus').textContent = '';
    document.getElementById('customerRegisterStatus').className = 'auth-status';
    document.getElementById('businessRegisterStatus').textContent = '';
    document.getElementById('businessRegisterStatus').className = 'auth-status';
    selectRegisterType('customer');
  }
}

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  if (!modal) return;
  modal.classList.remove('active');
  modal.style.display = '';
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeAuthModal();
});

document.getElementById('authModal')?.addEventListener('click', (event) => {
  if (event.target.id === 'authModal') closeAuthModal();
});

function switchAuthTab(tab) {
  if (tab === 'login') {
    document.getElementById('authLoginContainer').style.display = 'block';
    document.getElementById('authRegisterContainer').style.display = 'none';
    document.getElementById('authLoginTitle').textContent = '🔑 Login';
  } else {
    document.getElementById('authLoginContainer').style.display = 'none';
    document.getElementById('authRegisterContainer').style.display = 'block';
    document.getElementById('authRegisterTitle').textContent = '📝 Create Account';
    selectRegisterType('customer');
  }
}

function selectLoginType(type) {
  currentLoginType = type;
  const customerBtn = document.getElementById('loginTypeCustomer');
  const businessBtn = document.getElementById('loginTypeBusiness');

  if (type === 'customer') {
    customerBtn.style.background = '#2563eb';
    customerBtn.style.color = 'white';
    businessBtn.style.background = '#e2e8f0';
    businessBtn.style.color = '#1e293b';
  } else {
    businessBtn.style.background = '#22c55e';
    businessBtn.style.color = 'white';
    customerBtn.style.background = '#e2e8f0';
    customerBtn.style.color = '#1e293b';
  }
}

function selectRegisterType(type) {
  currentRegisterType = type;
  const customerBtn = document.getElementById('registerTypeCustomer');
  const businessBtn = document.getElementById('registerTypeBusiness');

  if (type === 'customer') {
    customerBtn.style.background = '#22c55e';
    customerBtn.style.color = 'white';
    businessBtn.style.background = '#e2e8f0';
    businessBtn.style.color = '#1e293b';
    document.getElementById('customerRegisterForm').style.display = 'block';
    document.getElementById('businessRegisterForm').style.display = 'none';
  } else {
    businessBtn.style.background = '#f59e0b';
    businessBtn.style.color = 'white';
    customerBtn.style.background = '#e2e8f0';
    customerBtn.style.color = '#1e293b';
    document.getElementById('customerRegisterForm').style.display = 'none';
    document.getElementById('businessRegisterForm').style.display = 'block';

    loadBusinessCategoriesForRegistration();
  }
}

function togglePwd(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const icon = btn.querySelector('i');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'fas fa-eye-slash';
  } else {
    input.type = 'password';
    icon.className = 'fas fa-eye';
  }
}

// ============================================================
//  CHECK USERNAME AVAILABILITY
// ============================================================

async function checkUsernameAvailability(username, type) {
  if (!username || username.length < 3) {
    const statusEl = type === 'customer'
      ? document.getElementById('customerUsernameStatus')
      : document.getElementById('businessUsernameStatus');
    if (statusEl) {
      statusEl.textContent = 'Username must be at least 3 characters';
      statusEl.style.color = '#94a3b8';
    }
    return false;
  }

  try {
    const res = await fetch(`/api/auth/check-username?username=${encodeURIComponent(username)}`);
    const data = await res.json();
    const statusEl = type === 'customer'
      ? document.getElementById('customerUsernameStatus')
      : document.getElementById('businessUsernameStatus');
    const suggestionsEl = type === 'customer'
      ? document.getElementById('customerUsernameSuggestions')
      : document.getElementById('businessUsernameSuggestions');

    if (data.available) {
      if (statusEl) {
        statusEl.textContent = '✅ Username available';
        statusEl.style.color = '#22c55e';
      }
      if (suggestionsEl) suggestionsEl.style.display = 'none';
      return true;
    } else {
      if (statusEl) {
        statusEl.textContent = '❌ Username already taken. Try one of the suggestions below:';
        statusEl.style.color = '#ef4444';
      }
      generateUsernameSuggestions(username, type);
      return false;
    }
  } catch (err) {
    console.error('Username check error:', err);
    return false;
  }
}

function generateUsernameSuggestions(base, type) {
  const suggestionsEl = type === 'customer'
    ? document.getElementById('customerUsernameSuggestions')
    : document.getElementById('businessUsernameSuggestions');

  if (!suggestionsEl) return;

  const suggestions = [
    base + Math.floor(Math.random() * 100),
    base + '_' + Math.floor(Math.random() * 1000),
    base + Math.floor(Math.random() * 1000),
    base + '_shop',
    base + '_store',
    'my_' + base,
    base + '_' + new Date().getFullYear()
  ];

  suggestionsEl.style.display = 'block';
  suggestionsEl.innerHTML = `
    <strong>Suggestions:</strong>
    ${suggestions.map(s =>
      `<span onclick="fillUsername('${s}', '${type}')" style="cursor:pointer; color:#2563eb; margin:0 4px; padding:2px 8px; background:white; border-radius:4px; border:1px solid #e2e8f0; display:inline-block; margin-bottom:4px;">${s}</span>`
    ).join('')}
  `;
}

function fillUsername(username, type) {
  const inputId = type === 'customer' ? 'regCustomerUsername' : 'regBusinessUsername';
  const input = document.getElementById(inputId);
  if (input) {
    input.value = username;
    checkUsernameAvailability(username, type);
  }
}

// ============================================================
//  HANDLE LOGIN
// ============================================================

async function handleLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const status = document.getElementById('loginStatus');
  if (!status) return;
  status.textContent = '';
  status.className = 'auth-status';

  if (!username || !password) {
    status.textContent = '❌ Username/Email and password are required.';
    status.className = 'auth-status error';
    return;
  }

  status.textContent = '⏳ Logging in...';
  status.className = 'auth-status';
  status.style.color = '#2563eb';

  try {
    let res, data;

    if (currentLoginType === 'business') {
      res = await fetch('/api/auth/business/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      data = await res.json();
    } else {
      res = await fetch('/api/auth/customer/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      data = await res.json();
    }

    if (res.ok && data.success) {
      status.textContent = '✅ Login successful!';
      status.className = 'auth-status success';
      window.customerToken = 'cookie-auth';

      if (data.role === 'business_admin' || data.business_id) {
        localStorage.setItem('businessId', data.business_id);
        localStorage.setItem('businessName', data.business_name);
        localStorage.setItem('businessSlug', data.slug || '');
        localStorage.setItem('currentUser', JSON.stringify({
          name: data.business_name,
          email: data.email,
          role: 'business_admin',
          business_id: data.business_id
        }));

        closeAuthModal();
        showToast('✅ Welcome back, ' + (data.business_name || 'Business') + '!', 'success');
        checkAuthState();
      } else {
        localStorage.setItem('currentUser', JSON.stringify(data.customer || { name: data.name, email: data.email }));
        const loginDestination = new URLSearchParams(window.location.search).get('next');
        if (loginDestination === 'cart') localStorage.setItem('postLoginDestination', 'cart');

        closeAuthModal();
        showToast('✅ Welcome back, ' + (data.customer?.name || data.name || 'User') + '!', 'success');
        checkAuthState();
        if (localStorage.getItem('postLoginDestination') === 'cart') {
          localStorage.removeItem('postLoginDestination');
          window.location.assign('/cart.html');
        }
      }
    } else {
      status.textContent = '❌ ' + (data.error || 'Invalid credentials. Please try again.');
      status.className = 'auth-status error';
    }
  } catch (err) {
    status.textContent = '❌ Network error. Please try again.';
    status.className = 'auth-status error';
    console.error('Login error:', err);
  }
}

// ============================================================
//  HANDLE CUSTOMER REGISTER
// ============================================================

async function handleCustomerRegister() {
  const username = document.getElementById('regCustomerUsername').value.trim();
  const name = document.getElementById('regCustomerName').value.trim();
  const email = document.getElementById('regCustomerEmail').value.trim();
  const phone = document.getElementById('regCustomerPhone').value.trim();
  const password = document.getElementById('regCustomerPassword').value;
  const confirm = document.getElementById('regCustomerConfirm').value;
  const status = document.getElementById('customerRegisterStatus');
  if (!status) return;
  status.textContent = '';
  status.className = 'auth-status';

  if (!username || !name || !email || !phone || !password || !confirm) {
    status.textContent = '❌ All fields are required.';
    status.className = 'auth-status error';
    return;
  }

  if (username.length < 3) {
    status.textContent = '❌ Username must be at least 3 characters.';
    status.className = 'auth-status error';
    return;
  }

  const phoneRegex = /^[0-9]{10,15}$/;
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  if (!phoneRegex.test(cleanPhone)) {
    status.textContent = '❌ Please enter a valid phone number (10-15 digits).';
    status.className = 'auth-status error';
    return;
  }

  if (password.length < 6) {
    status.textContent = '❌ Password must be at least 6 characters.';
    status.className = 'auth-status error';
    return;
  }
  if (password !== confirm) {
    status.textContent = '❌ Passwords do not match.';
    status.className = 'auth-status error';
    return;
  }

  const isAvailable = await checkUsernameAvailability(username, 'customer');
  if (!isAvailable) {
    status.textContent = '❌ Username already taken. Please choose another.';
    status.className = 'auth-status error';
    return;
  }

  status.textContent = '⏳ Creating account...';
  status.className = 'auth-status';
  status.style.color = '#2563eb';

  try {
    const res = await fetch('/api/auth/customer/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, name, email, phone: cleanPhone, password })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      status.textContent = '✅ Account created!';
      status.className = 'auth-status success';

      window.customerToken = 'cookie-auth';
      localStorage.setItem('currentUser', JSON.stringify(data.customer));
      currentUser = data.customer;

      closeAuthModal();
      showToast('✅ Welcome, ' + (data.customer.name || 'User') + '!', 'success');
      checkAuthState();
    } else {
      status.textContent = '❌ ' + (data.error || 'Registration failed');
      status.className = 'auth-status error';
    }
  } catch (err) {
    status.textContent = '❌ Network error. Please try again.';
    status.className = 'auth-status error';
    console.error('Register error:', err);
  }
}

// ============================================================
//  HANDLE BUSINESS REGISTER
// ============================================================

async function handleBusinessRegister() {
  const username = document.getElementById('regBusinessUsername').value.trim();
  const businessName = document.getElementById('regBusinessName').value.trim();
  const primarySelect = document.getElementById('regBusinessPrimaryCategory');
  const primaryCategory = primarySelect ? primarySelect.value : '';
  const email = document.getElementById('regBusinessEmail').value.trim();
  const phone = document.getElementById('regBusinessPhone').value.trim();
  const location = document.getElementById('regBusinessLocation').value.trim();
  const description = document.getElementById('regBusinessDescription').value.trim();
  const password = document.getElementById('regBusinessPassword').value;
  const confirm = document.getElementById('regBusinessConfirm').value;
  const status = document.getElementById('businessRegisterStatus');
  const categoryError = document.getElementById('businessCategoryError');

  if (!status) return;
  status.textContent = '';
  status.className = 'auth-status';

  if (categoryError) categoryError.style.display = 'none';
  if (primarySelect) primarySelect.style.borderColor = '#d1d5db';

  const additionalCategories = [];
  document.querySelectorAll('.reg-additional-category:checked').forEach(cb => {
    if (cb.value !== primaryCategory) additionalCategories.push(cb.value);
  });

  const hasAnyCategory = Boolean(primaryCategory) || additionalCategories.length > 0;
  if (!hasAnyCategory) {
    if (categoryError) categoryError.style.display = 'block';
    if (primarySelect) {
      primarySelect.style.borderColor = '#ef4444';
      primarySelect.focus();
    }
    status.textContent = '❌ Please select a business category.';
    status.className = 'auth-status error';
    return;
  }

  let finalPrimary = primaryCategory;
  if (!finalPrimary && additionalCategories.length > 0) {
    finalPrimary = additionalCategories.shift();
  }

  if (primarySelect && primarySelect.disabled && !finalPrimary) {
    status.textContent = '❌ Categories are still loading. Please wait a moment and try again.';
    status.className = 'auth-status error';
    return;
  }

  if (!username || !businessName || !email || !phone || !location || !password || !confirm) {
    status.textContent = '❌ All fields are required.';
    status.className = 'auth-status error';
    return;
  }

  if (username.length < 3) {
    status.textContent = '❌ Username must be at least 3 characters.';
    status.className = 'auth-status error';
    return;
  }

  const phoneRegex = /^[0-9]{10,15}$/;
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  if (!phoneRegex.test(cleanPhone)) {
    status.textContent = '❌ Please enter a valid phone number (10-15 digits).';
    status.className = 'auth-status error';
    return;
  }

  if (password.length < 8) {
    status.textContent = '❌ Password must be at least 8 characters.';
    status.className = 'auth-status error';
    return;
  }
  if (password !== confirm) {
    status.textContent = '❌ Passwords do not match.';
    status.className = 'auth-status error';
    return;
  }

  const isAvailable = await checkUsernameAvailability(username, 'business');
  if (!isAvailable) {
    status.textContent = '❌ Username already taken. Please choose another.';
    status.className = 'auth-status error';
    return;
  }

  status.textContent = '⏳ Creating business account...';
  status.className = 'auth-status';
  status.style.color = '#2563eb';

  const formData = new FormData();
  formData.append('business_name', businessName);
  formData.append('email', email);
  formData.append('phone', cleanPhone);
  formData.append('location', location);
  formData.append('description', description || '');
  formData.append('password', password);
  formData.append('username', username);

  formData.append('category', finalPrimary);
  if (additionalCategories.length > 0) {
    formData.append('additional_categories', additionalCategories.join(','));
  }

  formData.append('mpesa_enabled', 'false');
  formData.append('airtel_enabled', 'false');
  formData.append('bank_enabled', 'true');
  formData.append('paypal_enabled', 'false');

  try {
    const res = await fetch('/api/auth/business/register', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (res.ok && data.success) {
      status.textContent = '✅ Business account created!';
      status.className = 'auth-status success';
      window.customerToken = 'cookie-auth';

      localStorage.setItem('businessId', data.business_id);
      localStorage.setItem('businessName', data.business.business_name);
      localStorage.setItem('businessSlug', data.business.slug || '');
      localStorage.setItem('currentUser', JSON.stringify({
        name: businessName,
        email: email,
        role: 'business_admin',
        business_id: data.business_id
      }));

      businessCategoriesCache = null;

      if (primarySelect) {
        primarySelect.value = '';
        primarySelect.style.borderColor = '#d1d5db';
      }
      document.querySelectorAll('.reg-additional-category:checked').forEach(cb => { cb.checked = false; });
      if (categoryError) categoryError.style.display = 'none';

      closeAuthModal();
      showToast('✅ Welcome, ' + businessName + '! Business created.', 'success');
      checkAuthState();
    } else {
      status.textContent = '❌ ' + (data.error || 'Registration failed');
      status.className = 'auth-status error';
    }
  } catch (err) {
    status.textContent = '❌ Network error. Please try again.';
    status.className = 'auth-status error';
    console.error('Business register error:', err);
  }
}

// ============================================================
//  SHOW TOAST
// ============================================================

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const existing = container.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  const typeMap = {
    success: '#22c55e',
    error: '#ef4444',
    warning: '#f59e0b',
    info: '#2563eb'
  };
  const iconMap = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  };
  const bgColor = typeMap[type] || '#2563eb';

  toast.className = `toast ${type}`;
  toast.style.cssText = `
    background: ${bgColor};
    color: white;
    padding: 14px 20px;
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.15);
    font-size: 0.9rem;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 12px;
    animation: slideIn 0.3s ease;
    margin-bottom: 8px;
    transform: translateX(0);
    transition: transform 0.3s;
    word-break: break-word;
  `;

  const icon = document.createElement('span');
  icon.innerHTML = iconMap[type] || 'ℹ️';
  icon.style.fontSize = '1.2rem';
  icon.style.flexShrink = '0';

  const text = document.createElement('span');
  text.textContent = message;
  text.style.flex = '1';

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.style.cssText = `
    background: none;
    border: none;
    color: white;
    font-size: 1rem;
    cursor: pointer;
    margin-left: auto;
    opacity: 0.7;
    transition: opacity 0.2s;
    flex-shrink: 0;
  `;
  closeBtn.onclick = () => {
    toast.style.transform = 'translateX(120%)';
    setTimeout(() => toast.remove(), 300);
  };

  toast.appendChild(icon);
  toast.appendChild(text);
  toast.appendChild(closeBtn);
  container.appendChild(toast);

  setTimeout(() => {
    if (container.contains(toast)) {
      toast.style.transform = 'translateX(120%)';
      setTimeout(() => toast.remove(), 300);
    }
  }, 5000);
}

// ============================================================
//  EXPOSE FUNCTIONS GLOBALLY
// ============================================================

window.loadMarketplace = loadMarketplace;
window.searchBusinesses = searchBusinesses;
window.filterBusinesses = filterBusinesses;
window.loadMoreBusinesses = loadMoreBusinesses;
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.switchAuthTab = switchAuthTab;
window.selectLoginType = selectLoginType;
window.selectRegisterType = selectRegisterType;
window.togglePwd = togglePwd;
window.handleLogin = handleLogin;
window.handleCustomerRegister = handleCustomerRegister;
window.handleBusinessRegister = handleBusinessRegister;
window.checkUsernameAvailability = checkUsernameAvailability;
window.generateUsernameSuggestions = generateUsernameSuggestions;
window.fillUsername = fillUsername;
window.showToast = showToast;
window.loadBusinessCategoriesForRegistration = loadBusinessCategoriesForRegistration;
window.syncAdditionalCategoryOptions = syncAdditionalCategoryOptions;
window.handleAdditionalCategoryChange = handleAdditionalCategoryChange;
window.maybeSuggestNearKeyword = maybeSuggestNearKeyword;

window.getOrderStatusBadge = getOrderStatusBadge;

// Section J exposures — so any future surface (e.g. the account page)
// can reuse the same helpers without duplicating logic.
window.loadAds = loadAds;
window.goToAd = goToAd;
window.handleAdClick = handleAdClick;

// ============================================================
//  CENTRAL MARKETPLACE WORKSPACE
// ============================================================

const MARKETPLACE_WORKSPACE = Object.freeze({
  customer: {
    kicker: 'Your BidhaaLink space',
    tabs: [
      { id: 'dashboard', label: 'Dashboard', icon: 'fa-chart-pie' },
      { id: 'profile', label: 'My Profile', icon: 'fa-user' },
      { id: 'orders', label: 'My Orders', icon: 'fa-box' },
      { id: 'addresses', label: 'Addresses', icon: 'fa-map-marker-alt' },
      { id: 'payments', label: 'Payments', icon: 'fa-credit-card' },
      { id: 'cart', label: 'Cart', icon: 'fa-shopping-cart' },
      { id: 'messages', label: 'Messages', icon: 'fa-comment' }
    ],
    bottom: []
  },
  business: {
    kicker: 'Your business command center',
    tabs: [
      { id: 'dashboard', label: 'Dashboard', icon: 'fa-chart-pie' },
      { id: 'orders', label: 'Orders', icon: 'fa-box' },
      { id: 'products', label: 'Products', icon: 'fa-tags' },
      { id: 'ads', label: 'Manage Ads', icon: 'fa-bullhorn' },
      { id: 'customers', label: 'Customers', icon: 'fa-users' },
      { id: 'messages', label: 'Messages', icon: 'fa-comment' },
      { id: 'settings', label: 'Settings', icon: 'fa-sliders-h' },
      { id: 'preview', label: 'Preview', icon: 'fa-eye' }
    ],
    bottom: []
  }
});

const BUSINESS_SETTINGS_TABS = Object.freeze([
  { id: 'profile', label: 'Business Profile' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'payments', label: 'Payments' },
  { id: 'ordersettings', label: 'Order Settings' }
]);

let workspaceSection = 'dashboard';
let workspaceSubsection = null;

function getStoredMarketplaceUser() {
  try {
    const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
    return user && typeof user === 'object' ? user : {};
  } catch (err) {
    return {};
  }
}

function isBusinessMarketplaceUser(user) {
  return user?.role === 'business_admin' || Boolean(user?.business_id);
}

function getWorkspaceRole(user) {
  return isBusinessMarketplaceUser(user) ? 'business' : 'customer';
}

async function checkAuthState() {
  const user = getStoredMarketplaceUser();
  const requestedWorkspace = new URLSearchParams(window.location.search).get('workspace');

  if (!user.email) {
    isLoggedIn = false;
    currentUser = null;
    showGuestState();
    return false;
  }

  try {
    const response = await fetch('/api/auth/verify');
    if (response.status === 401 || response.status === 403) {
      localStorage.removeItem('currentUser');
      isLoggedIn = false;
      currentUser = null;
      showGuestState();
      return false;
    }

    if (response.ok) {
      const verified = await response.json();
      if (verified.role && !user.role) {
        user.role = verified.role;
        localStorage.setItem('currentUser', JSON.stringify(user));
      }
    }
  } catch (err) {
    // Keep an existing session usable when verification is temporarily unavailable.
  }

  isLoggedIn = true;
  currentUser = user;
  showLoggedInState(user);
  if (requestedWorkspace) openDashboardPanel(requestedWorkspace);

  hydrateLocationFromAccount();
  return true;
}

async function hydrateLocationFromAccount() {
  if (!currentUser?.email) return;
  if (isBusinessMarketplaceUser(currentUser)) return;
  if (marketplaceCustomerCoords.source === 'gps') return;

  try {
    const res = await fetch('/api/location/customer/location', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.activated && Number.isFinite(Number(data.latitude)) && Number.isFinite(Number(data.longitude))) {
      marketplaceCustomerCoords = {
        latitude: Number(data.latitude),
        longitude: Number(data.longitude),
        accuracy: data.accuracy ? Number(data.accuracy) : null,
        source: 'account'
      };
      updateLocationStatusChip();
    }
  } catch (err) {
    // Non-fatal.
  }
}

function showLoggedInState(user) {
  const publicNav = document.getElementById('publicNavTop');
  const loggedInNav = document.getElementById('loggedInNavTop');
  const userBadge = document.getElementById('userBadge');

  if (publicNav) publicNav.style.display = 'none';
  if (loggedInNav) loggedInNav.style.display = 'flex';
  if (userBadge) userBadge.textContent = '';

  const role = getWorkspaceRole(user);
  renderWorkspaceNavigation(role);
  const workspace = document.getElementById('integratedWorkspace');
  const divider = document.getElementById('marketplaceDivider');
  if (workspace) workspace.hidden = false;
  if (divider) divider.hidden = true;
  closeDashboardPanel({ preserveWorkspace: true });
}

function showGuestState() {
  const publicNav = document.getElementById('publicNavTop');
  const loggedInNav = document.getElementById('loggedInNavTop');
  const workspace = document.getElementById('integratedWorkspace');
  const bottomNav = document.getElementById('marketplaceBottomNav');
  const divider = document.getElementById('marketplaceDivider');
  const frame = document.getElementById('workspaceFrame');

  if (publicNav) publicNav.style.display = 'flex';
  if (loggedInNav) loggedInNav.style.display = 'none';
  if (workspace) workspace.hidden = true;
  if (bottomNav) bottomNav.hidden = true;
  if (divider) divider.hidden = true;
  if (frame) {
    frame.removeAttribute('src');
    delete frame.dataset.workspaceSource;
  }
  document.body.classList.remove('workspace-active');
  closeMobileSidebar();
}

function renderWorkspaceNavigation(role) {
  const config = MARKETPLACE_WORKSPACE[role];
  const tabs = document.getElementById('workspaceTabs');
  const bottomNav = document.getElementById('marketplaceBottomNav');
  const toggle = document.getElementById('workspaceMenuToggle');

  if (!config || !tabs || !bottomNav) return;

  tabs.replaceChildren();
  config.tabs.forEach(tab => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-tab';
    button.dataset.section = tab.id;
    button.innerHTML = `<i class="fas ${tab.icon}"></i> ${tab.label}`;
    button.addEventListener('click', () => toggleDashboardPanel(tab.id));
    tabs.appendChild(button);
  });

  bottomNav.replaceChildren();
  bottomNav.hidden = true;

  if (toggle && !toggle.dataset.bound) {
    toggle.dataset.bound = 'true';
    toggle.addEventListener('click', () => {
      const expanded = tabs.classList.toggle('is-expanded');
      toggle.setAttribute('aria-expanded', String(expanded));
    });
  }
}

function getWorkspaceTarget(role, requestedSection) {
  const config = MARKETPLACE_WORKSPACE[role];
  let section = requestedSection || 'dashboard';
  let subsection = null;

  if (role === 'business' && BUSINESS_SETTINGS_TABS.some(tab => tab.id === section)) {
    subsection = section;
    section = 'settings';
  }

  if (!config.tabs.some(tab => tab.id === section)) {
    section = 'dashboard';
  }

  if (role === 'business' && section === 'settings') {
    subsection = subsection || workspaceSubsection || 'profile';
  }

  return { section, subsection };
}

async function getWorkspaceSource(role, section, subsection) {
  if (role === 'customer') {
    if (section === 'cart') return '/cart.html?embedded=1';
    return `/account.html?embedded=1&section=${encodeURIComponent(section)}`;
  }

  if (section === 'messages') return '/seller-chat.html?embedded=1';

  if (section === 'preview') {
    let slug = localStorage.getItem('businessSlug');
    if (!slug) {
      try {
        const response = await fetch('/api/auth/my-business');
        const data = await response.json();
        slug = data.business?.slug || '';
        if (slug) localStorage.setItem('businessSlug', slug);
      } catch (err) {
        slug = '';
      }
    }
    return `/business-profile.html?embedded=1&slug=${encodeURIComponent(slug || '')}`;
  }

  const childSection = section === 'settings' ? subsection || 'profile' : section;
  return `/business-admin.html?embedded=1&section=${encodeURIComponent(childSection)}`;
}

function updateWorkspacePresentation(role, section, subsection) {
  const config = MARKETPLACE_WORKSPACE[role];
  const workspace = document.getElementById('integratedWorkspace');
  const kicker = document.getElementById('workspaceKicker');
  const title = document.getElementById('workspaceTitle');
  const divider = document.getElementById('marketplaceDivider');
  const tabs = document.getElementById('workspaceTabs');
  const subtabs = document.getElementById('workspaceSubtabs');
  const menuToggle = document.getElementById('workspaceMenuToggle');
  const activeTab = config.tabs.find(tab => tab.id === section) || config.tabs[0];

  if (workspace) workspace.hidden = false;
  if (divider) divider.hidden = true;
  if (kicker) kicker.textContent = config.kicker;
  if (title) title.textContent = activeTab.label;
  document.body.classList.add('workspace-active');

  if (tabs) {
    tabs.querySelectorAll('.workspace-tab').forEach(button => {
      const active = button.dataset.section === section;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    tabs.classList.remove('is-expanded');
  }
  if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');

  document.querySelectorAll('#marketplaceBottomNav button').forEach(button => {
    button.classList.toggle('is-active', button.dataset.section === section);
  });

  if (!subtabs) return;
  subtabs.replaceChildren();
  if (role !== 'business' || section !== 'settings') {
    subtabs.hidden = true;
    return;
  }

  BUSINESS_SETTINGS_TABS.forEach(tab => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-subtab';
    button.textContent = tab.label;
    button.classList.toggle('is-active', tab.id === subsection);
    button.addEventListener('click', () => toggleDashboardPanel(tab.id));
    subtabs.appendChild(button);
  });
  subtabs.hidden = false;
}

async function openDashboardPanel(requestedSection) {
  const user = currentUser?.email ? currentUser : getStoredMarketplaceUser();
  if (!user.email) {
    openAuthModal('login');
    return;
  }

  const role = getWorkspaceRole(user);
  const target = getWorkspaceTarget(role, requestedSection);
  const frame = document.getElementById('workspaceFrame');

  workspaceSection = target.section;
  workspaceSubsection = target.subsection;
  currentPanel = target.section;
  updateWorkspacePresentation(role, target.section, target.subsection);
  const workspace = document.getElementById('integratedWorkspace');
  if (workspace) workspace.classList.add('is-open');
  const closeButton = document.getElementById('workspaceClose');
  if (closeButton) closeButton.hidden = false;

  if (!frame) return;
  const source = await getWorkspaceSource(role, target.section, target.subsection);
  if (frame.dataset.workspaceSource !== source) {
    frame.dataset.workspaceSource = source;
    frame.src = source;
  }

  const url = new URL(window.location.href);
  url.searchParams.set('workspace', target.section === 'settings' ? target.subsection : target.section);
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function toggleDashboardPanel(requestedSection) {
  const workspace = document.getElementById('integratedWorkspace');
  const user = currentUser?.email ? currentUser : getStoredMarketplaceUser();
  const role = getWorkspaceRole(user);
  const target = getWorkspaceTarget(role, requestedSection);
  if (workspace?.classList.contains('is-open') && currentPanel === target.section && workspaceSubsection === target.subsection) {
    closeDashboardPanel();
    return;
  }
  openDashboardPanel(requestedSection);
}

function closeDashboardPanel(options = {}) {
  const workspace = document.getElementById('integratedWorkspace');
  if (workspace) {
    workspace.classList.remove('is-open');
    if (!options.preserveWorkspace) workspace.hidden = false;
  }
  const closeButton = document.getElementById('workspaceClose');
  if (closeButton) closeButton.hidden = true;
  document.body.classList.remove('workspace-active');
  currentPanel = null;
  workspaceSection = 'dashboard';
  workspaceSubsection = null;

  const url = new URL(window.location.href);
  url.searchParams.delete('workspace');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function toggleMobileSidebar() {
  const tabs = document.getElementById('workspaceTabs');
  const toggle = document.getElementById('workspaceMenuToggle');
  if (!tabs || !toggle) return;
  const expanded = tabs.classList.toggle('is-expanded');
  toggle.setAttribute('aria-expanded', String(expanded));
}

function closeMobileSidebar() {
  const tabs = document.getElementById('workspaceTabs');
  const toggle = document.getElementById('workspaceMenuToggle');
  if (tabs) tabs.classList.remove('is-expanded');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

function openBusinessPreview() {
  openDashboardPanel('preview');
}

window.addEventListener('message', event => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === 'shop-kenya-open-workspace' && event.data.section) {
    openDashboardPanel(event.data.section);
  }
});

async function handleLogout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('token');
  localStorage.removeItem('customerToken');
  localStorage.removeItem('businessId');
  localStorage.removeItem('businessName');
  localStorage.removeItem('businessSlug');
  localStorage.removeItem('currentUser');
  currentUser = null;
  isLoggedIn = false;
  workspaceSection = 'dashboard';
  workspaceSubsection = null;
  businessCategoriesCache = null;

  marketplaceCustomerCoords = { latitude: null, longitude: null, source: null };
  gpsUpgradeAttempted = false;
  locationSearchText = '';
  marketplaceSearchWasTyped = false;
  hideLocationBanner();
  updateLocationStatusChip();
  updateLocationFiltersCount();

  showGuestState();

  const url = new URL(window.location.href);
  url.searchParams.delete('workspace');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  showToast('You have been logged out.', 'info');
}

window.checkAuthState = checkAuthState;
window.openDashboardPanel = openDashboardPanel;
window.closeDashboardPanel = closeDashboardPanel;
window.toggleMobileSidebar = toggleMobileSidebar;
window.closeMobileSidebar = closeMobileSidebar;
window.openBusinessPreview = openBusinessPreview;
window.handleLogout = handleLogout;
window.updateCartBadge = updateCartBadge;

console.log('✅ Index.js loaded successfully');