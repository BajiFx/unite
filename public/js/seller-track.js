// ============================================================
//  SELLER TRACK JAVASCRIPT
//  Location: public/js/seller-track.js
//
//  Tile provider migration (this revision):
//   OpenStreetMap's volunteer tile servers block requests from
//   deployments that are not plain human-browsing traffic. Any
//   request from a custom domain, an ngrok tunnel, or a cloud
//   host is refused with HTTP 403, so the seller's live-customer
//   map was showing "Access blocked" tiles.
//
//   The fix replaces the OSM tile URL with CartoDB Positron,
//   a free, attribution-friendly raster basemap hosted on a
//   proper CDN. It is the closest visual match to OSM's default
//   style, needs no API key, and is explicitly allowed for
//   production web apps.
//
//   This file now uses CARTO_TILE_URL as the single source of
//   truth for the tile layer, so any future provider change is
//   one constant. business-admin.js, business-profile.js,
//   track.js and order-tracking.js have each been updated to use
//   the same URL, and server.js has been updated so Helmet's
//   imgSrc and connectSrc CSP directives whitelist
//   basemaps.cartocdn.com.
// ============================================================

// ============================================================
//  TILE PROVIDER — single source of truth
//
//  CartoDB Positron (light_all) is a free, no-signup raster
//  basemap served from a global CDN. It reads well behind
//  marker pins and matches the neutral look of the previous
//  OSM tiles.
//
//  `{s}` is a subdomain placeholder Leaflet fills in with a, b,
//  c or d automatically. `{r}` is the retina placeholder Leaflet
//  fills in with "@2x" on high-DPI screens, or an empty string
//  otherwise. Both are handled by Leaflet, not by us.
// ============================================================

const CARTO_TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const CARTO_TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
const CARTO_TILE_SUBDOMAINS = 'abcd';

// ============================================================
//  GLOBALS
// ============================================================

let map, shopMarker;
let customerMarkers = {};
let shopLat, shopLng;
let socket;

// ============================================================
//  DISTANCE + TIME HELPERS
// ============================================================

function getDistance(lat1, lng1, lat2, lng2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lng2-lng1) * Math.PI/180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDistance(meters) {
    if (meters < 1000) return Math.round(meters) + ' m';
    return (meters/1000).toFixed(1) + ' km';
}

function formatTime(seconds) {
    if (seconds < 60) return Math.round(seconds) + ' sec';
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return mins + ' min ' + (secs > 0 ? secs + ' sec' : '');
}

// ============================================================
//  SHOP LOCATION
// ============================================================

async function getShopLocation() {
    const res = await fetch('/api/shop');
    const shop = await res.json();
    shopLat = parseFloat(shop.latitude);
    shopLng = parseFloat(shop.longitude);
    if (!shopLat || !shopLng) {
        alert('Shop location not set. Please set it in admin panel.');
        return false;
    }
    return true;
}

// ============================================================
//  MAP INIT
// ============================================================

function initMap() {
    map = L.map('map').setView([shopLat, shopLng], 14);
    L.tileLayer(CARTO_TILE_URL, {
        attribution: CARTO_TILE_ATTRIBUTION,
        subdomains: CARTO_TILE_SUBDOMAINS,
        maxZoom: 19
    }).addTo(map);

    shopMarker = L.marker([shopLat, shopLng], {
        icon: L.divIcon({ className: 'shop-marker', html: '📍', iconSize: [30, 30] })
    }).addTo(map).bindPopup('🏪 Your Shop');

    L.circle([shopLat, shopLng], {
        radius: 1000,
        color: '#2563eb',
        fillColor: '#2563eb',
        fillOpacity: 0.08
    }).addTo(map);
}

// ============================================================
//  CUSTOMER MARKERS
// ============================================================

function updateCustomerOnMap(customer) {
    const { socketId, lat, lng, name } = customer;
    if (!lat || !lng) return;
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (isNaN(latNum) || isNaN(lngNum)) return;

    const dist = getDistance(shopLat, shopLng, latNum, lngNum);
    const timeSec = dist / 1.4;
    const distStr = formatDistance(dist);
    const timeStr = formatTime(timeSec);

    if (customerMarkers[socketId]) {
        customerMarkers[socketId].setLatLng([latNum, lngNum]);
        customerMarkers[socketId].setPopupContent(
            `🧑 ${name || 'Customer'}<br>Distance: ${distStr}<br>~ ${timeStr} walk`
        );
    } else {
        const icon = L.divIcon({ className: 'custom-div-icon', html: '🧑‍🦯', iconSize: [30, 30] });
        const marker = L.marker([latNum, lngNum], { icon }).addTo(map)
            .bindPopup(`🧑 ${name || 'Customer'}<br>Distance: ${distStr}<br>~ ${timeStr} walk`);
        customerMarkers[socketId] = marker;
    }
    updateCustomerList();
}

function removeCustomer(socketId) {
    if (customerMarkers[socketId]) {
        map.removeLayer(customerMarkers[socketId]);
        delete customerMarkers[socketId];
    }
    updateCustomerList();
}

function updateCustomerList() {
    const container = document.getElementById('customerItems');
    const ids = Object.keys(customerMarkers);
    if (ids.length === 0) {
        container.innerHTML = '<p class="empty-customers">No active customers</p>';
        document.getElementById('info').innerHTML = '<i class="fas fa-users"></i> Customers online: 0';
        return;
    }
    let html = '';
    ids.forEach(id => {
        const marker = customerMarkers[id];
        const popup = marker.getPopup();
        const content = popup ? popup.getContent() : '';
        const distMatch = content.match(/Distance: ([\d.]+ [km]+)/);
        const timeMatch = content.match(/~ ([\d.]+ [a-z]+)/);
        const distStr = distMatch ? distMatch[1] : '?';
        const timeStr = timeMatch ? timeMatch[1] : '?';
        html += `
            <div class="customer-item">
                <span class="name">🧑 ${id.slice(0,6)}</span>
                <span>
                    <span class="dist">${distStr}</span>
                    <span class="time">${timeStr}</span>
                </span>
            </div>
        `;
    });
    container.innerHTML = html;
    document.getElementById('info').innerHTML = `<i class="fas fa-users"></i> Customers online: ${ids.length}`;
}

// ============================================================
//  INIT
// ============================================================

async function init() {
    const ok = await getShopLocation();
    if (!ok) return;
    initMap();

    socket = io();
    socket.on('connect', () => {
        console.log('Seller tracking connected');
        socket.emit('get-customers');
    });

    socket.on('customer-list', (customers) => {
        customers.forEach(c => updateCustomerOnMap(c));
    });

    socket.on('customer-update', (data) => {
        updateCustomerOnMap(data);
    });

    socket.on('customer-left', (socketId) => {
        removeCustomer(socketId);
    });
}

init();