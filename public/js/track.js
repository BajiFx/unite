// ============================================================
//  CUSTOMER TRACK JAVASCRIPT
//  Location: public/js/track.js
//
//  Tile provider migration (this revision):
//   OpenStreetMap's volunteer tile servers block requests from
//   deployments that are not plain human-browsing traffic. Any
//   request from a custom domain, an ngrok tunnel, or a cloud
//   host is refused with HTTP 403, so the live-tracking map was
//   showing "Access blocked" tiles.
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
//   seller-track.js and order-tracking.js have each been
//   updated to use the same URL, and server.js has been updated
//   so Helmet's imgSrc and connectSrc CSP directives whitelist
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

let map, userMarker, shopMarker, routeLine;
let shopLat, shopLng;
let socket = null;
let watchId = null;
let isSharing = false;
let prevDist = null;

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
        document.getElementById('statusMsg').innerHTML = '❌ Shop location not set.';
        return false;
    }
    return true;
}

// ============================================================
//  MAP INIT
// ============================================================

function initMap(userLat, userLng) {
    map = L.map('map').setView([userLat, userLng], 15);
    L.tileLayer(CARTO_TILE_URL, {
        attribution: CARTO_TILE_ATTRIBUTION,
        subdomains: CARTO_TILE_SUBDOMAINS,
        maxZoom: 19
    }).addTo(map);

    if (shopLat && shopLng) {
        shopMarker = L.marker([shopLat, shopLng], {
            icon: L.divIcon({ className: 'shop-marker', html: '📍', iconSize: [30, 30] })
        }).addTo(map).bindPopup('🏪 Shop');
        L.circle([shopLat, shopLng], { radius: 1000, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.08 }).addTo(map);
    }

    const userIcon = L.divIcon({ className: 'user-marker', html: '🧑‍🦯', iconSize: [30, 30] });
    userMarker = L.marker([userLat, userLng], { icon: userIcon }).addTo(map).bindPopup('You are here');
    map.setView([userLat, userLng], 15);

    updateInfo(userLat, userLng);
    drawRoute(userLat, userLng);
}

function drawRoute(userLat, userLng) {
    if (routeLine) map.removeLayer(routeLine);
    routeLine = L.polyline([[userLat, userLng], [shopLat, shopLng]], {
        color: '#2563eb',
        weight: 3,
        dashArray: '8, 6',
        opacity: 0.7
    }).addTo(map);
}

// ============================================================
//  INFO PANEL
// ============================================================

function updateInfo(lat, lng) {
    if (!shopLat || !shopLng) return;
    const dist = getDistance(lat, lng, shopLat, shopLng);
    const speed = 1.4;
    const timeSec = dist / speed;
    let directionText = '';
    if (prevDist !== null) {
        const diff = dist - prevDist;
        if (diff < -2) directionText = '⬆️ Getting closer!';
        else if (diff > 2) directionText = '⬇️ Moving away';
        else directionText = '⟷ Steady';
    }
    prevDist = dist;
    document.getElementById('distValue').textContent = formatDistance(dist);
    document.getElementById('timeValue').textContent = formatTime(timeSec);
    document.getElementById('dirValue').textContent = directionText;
    document.getElementById('statusMsg').innerHTML = '<span class="dot active"></span> Live tracking active';
}

// ============================================================
//  GEOLOCATION WATCH
// ============================================================

function startTracking() {
    if (!navigator.geolocation) {
        alert('Geolocation not supported');
        return;
    }
    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            if (userMarker) {
                userMarker.setLatLng([lat, lng]);
                map.setView([lat, lng], 15);
                drawRoute(lat, lng);
            } else {
                initMap(lat, lng);
            }
            updateInfo(lat, lng);
            if (isSharing && socket) {
                socket.emit('customer-location', { lat, lng, name: 'Customer' });
            }
        },
        (err) => {
            document.getElementById('statusMsg').innerHTML = '❌ GPS error: ' + err.message;
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ============================================================
//  SHARE TOGGLE
// ============================================================

function toggleSharing() {
    if (!socket) {
        socket = io();
        socket.on('connect', () => {
            document.getElementById('statusMsg').innerHTML = '<span class="dot active"></span> Connected. Sharing location...';
        });
    }
    isSharing = !isSharing;
    const btn = document.getElementById('shareBtn');
    const text = document.getElementById('shareText');
    if (isSharing) {
        btn.classList.add('sharing');
        text.textContent = 'Stop Sharing';
        navigator.geolocation.getCurrentPosition((pos) => {
            socket.emit('customer-location', { lat: pos.coords.latitude, lng: pos.coords.longitude, name: 'Customer' });
        });
        document.getElementById('statusMsg').innerHTML = '<span class="dot active"></span> 🔄 Sharing your live location with the seller...';
    } else {
        btn.classList.remove('sharing');
        text.textContent = 'Share Location';
        document.getElementById('statusMsg').innerHTML = '<span class="dot active"></span> 📍 Sharing stopped. You are still tracking yourself.';
    }
}

// ============================================================
//  INIT
// ============================================================

(async function() {
    const ok = await getShopLocation();
    if (!ok) return;
    startTracking();
    socket = io();
    socket.on('connect', () => console.log('Socket connected'));
})();