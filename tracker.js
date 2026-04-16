// =============================================
// tracker.js — Map, prediction, animation, updates
// =============================================

const state = {
  routeCoords: [],
  routeDistances: [],
  totalRouteDistance: 0,
  totalRouteDuration: 0,
  routePolyline: null,
  traveledPolyline: null,
  remainingPolyline: null,
  startMarker: null,
  endMarker: null,
  driverMarker: null,
  confirmedMarker: null,
  predictor: createPredictor(),
  map: null
};

// --- Quick Search ---
let quickSearchTimer = null;

function setupQuickSearch() {
  const input = document.getElementById('quick-search-input');
  const list = document.getElementById('quick-suggestions');

  input.addEventListener('input', () => {
    clearTimeout(quickSearchTimer);
    const query = input.value.trim();
    if (query.length < 2) { list.classList.remove('visible'); return; }

    quickSearchTimer = setTimeout(async () => {
      try {
        const chicagoViewbox = '&viewbox=-88.0,42.1,-87.5,41.6&bounded=1';
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5${chicagoViewbox}`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'DriveTrackerPWA/1.0' } });
        const results = await resp.json();
        if (!results.length) { list.classList.remove('visible'); return; }

        list.innerHTML = '';
        results.forEach(result => {
          const item = document.createElement('div');
          item.className = 'autocomplete-item';
          const mainName = result.display_name.split(',')[0];
          const detail = result.display_name.split(',').slice(1, 3).join(',').trim();
          item.innerHTML = `<div class="addr-main">${mainName}</div><div class="addr-detail">${detail}</div>`;
          item.addEventListener('click', () => {
            processLocationUpdate(parseFloat(result.lat), parseFloat(result.lon));
            input.value = '';
            list.classList.remove('visible');
            showStatus('last-update-info', `Updated: ${mainName}`);
          });
          list.appendChild(item);
        });
        list.classList.add('visible');
      } catch (err) { console.error('Quick search error:', err); }
    }, 500);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleQuickSearch(); }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#quick-search')) {
      document.getElementById('quick-suggestions').classList.remove('visible');
    }
  });
}

async function handleQuickSearch() {
  const input = document.getElementById('quick-search-input');
  const query = input.value.trim();
  if (!query) return;
  try {
    const chicagoViewbox = '&viewbox=-88.0,42.1,-87.5,41.6&bounded=1';
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1${chicagoViewbox}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'DriveTrackerPWA/1.0' } });
    const results = await resp.json();
    if (results.length) {
      processLocationUpdate(parseFloat(results[0].lat), parseFloat(results[0].lon));
      input.value = '';
      document.getElementById('quick-suggestions').classList.remove('visible');
      showStatus('last-update-info', `Updated: ${results[0].display_name.split(',')[0]}`);
    } else {
      showStatus('last-update-info', 'Not found. Try a more specific name.', true);
    }
  } catch (err) { showStatus('last-update-info', 'Search failed.', true); }
}

// --- Tap on Map ---
let tapModeActive = false;
let tapMarker = null;

function toggleTapMode() {
  tapModeActive = !tapModeActive;
  const btn = document.getElementById('tap-map-btn');
  if (tapModeActive) {
    btn.textContent = 'TAP MAP NOW';
    btn.classList.add('active');
    state.map.getContainer().style.cursor = 'crosshair';
  } else {
    btn.textContent = 'Tap Map to Update';
    btn.classList.remove('active');
    state.map.getContainer().style.cursor = '';
    if (tapMarker) { state.map.removeLayer(tapMarker); tapMarker = null; }
  }
}

function handleMapTap(e) {
  if (!tapModeActive) return;
  if (tapMarker) state.map.removeLayer(tapMarker);
  tapMarker = L.circleMarker([e.latlng.lat, e.latlng.lng], {
    radius: 8, fillColor: '#ff6b35', color: 'white', weight: 2, fillOpacity: 0.8
  }).addTo(state.map);
  processLocationUpdate(e.latlng.lat, e.latlng.lng);
  toggleTapMode();
}

// --- Paste Coords ---
async function handlePasteSubmit() {
  try {
    const text = await navigator.clipboard.readText();
    const parts = text.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const lat = parseFloat(parts[0]);
      const lng = parseFloat(parts[1]);
      if (!isNaN(lat) && !isNaN(lng)) {
        processLocationUpdate(lat, lng);
        showStatus('last-update-info', `Pasted: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
        return;
      }
    }
    showStatus('last-update-info', 'Clipboard doesn\'t have valid coords.', true);
  } catch (err) {
    showStatus('last-update-info', 'Clipboard access denied.', true);
  }
}

// --- Map Init ---
function initMap() {
  state.map = L.map('map', { zoomControl: false }).setView([41.8781, -87.6298], 11); // Chicago
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(state.map);
  L.control.zoom({ position: 'topright' }).addTo(state.map);
  state.map.on('click', handleMapTap);
}

// --- Load route from localStorage ---
function loadRoute() {
  const saved = localStorage.getItem('active-route');
  if (!saved) {
    document.getElementById('no-route-msg').classList.remove('hidden');
    return false;
  }

  const r = JSON.parse(saved);
  state.routeCoords = r.coords;
  state.routeDistances = r.distances;
  state.totalRouteDistance = r.totalDistance;
  state.totalRouteDuration = r.totalDuration;
  state.predictor.initialize(r.totalDistance, r.totalDuration);

  drawRoute(r.coords, r.startCoords, r.endCoords);
  return true;
}

function drawRoute(coords, startCoords, endCoords) {
  if (state.routePolyline) state.map.removeLayer(state.routePolyline);
  if (state.traveledPolyline) state.map.removeLayer(state.traveledPolyline);
  if (state.remainingPolyline) state.map.removeLayer(state.remainingPolyline);
  if (state.startMarker) state.map.removeLayer(state.startMarker);
  if (state.endMarker) state.map.removeLayer(state.endMarker);
  if (state.driverMarker) state.map.removeLayer(state.driverMarker);
  if (state.confirmedMarker) state.map.removeLayer(state.confirmedMarker);

  state.routePolyline = L.polyline(coords, { color: '#4285f4', weight: 5, opacity: 0.7 }).addTo(state.map);
  state.startMarker = L.circleMarker([startCoords.lat, startCoords.lng], {
    radius: 8, fillColor: '#4caf50', color: 'white', weight: 2, fillOpacity: 1
  }).addTo(state.map).bindPopup('Start');
  state.endMarker = L.circleMarker([endCoords.lat, endCoords.lng], {
    radius: 8, fillColor: '#e94560', color: 'white', weight: 2, fillOpacity: 1
  }).addTo(state.map).bindPopup('End');
  state.map.fitBounds(state.routePolyline.getBounds(), { padding: [30, 30] });
}

// --- Location Updates ---
function processLocationUpdate(lat, lng, timestamp) {
  if (!state.routeCoords.length) {
    showStatus('last-update-info', 'No route loaded. Set one up first.', true);
    return;
  }
  const snap = snapToRoute(lat, lng, state.routeCoords, state.routeDistances);
  if (snap.perpendicularDistance > 500) {
    document.getElementById('off-route-banner').classList.remove('hidden');
  }
  state.predictor.processUpdate(snap, timestamp || Date.now());
  updateConfirmedMarker(snap.snappedLat, snap.snappedLng);
  ensureDriverMarker();
  if (!state.predictor.animationFrameId) startAnimation();
  updateInfoPanel();
  const time = new Date(timestamp || Date.now()).toLocaleTimeString();
  showStatus('last-update-info', `Last: ${time} (${snap.perpendicularDistance.toFixed(0)}m from route)`);
}

function ensureDriverMarker() {
  if (state.driverMarker) return;
  const icon = L.divIcon({ className: '', html: '<div class="driver-blip"></div>', iconSize: [16,16], iconAnchor: [8,8] });
  state.driverMarker = L.marker(state.routeCoords[0], { icon, zIndexOffset: 1000 }).addTo(state.map);
}

function updateConfirmedMarker(lat, lng) {
  if (!state.confirmedMarker) {
    const icon = L.divIcon({ className: '', html: '<div class="confirmed-blip"></div>', iconSize: [10,10], iconAnchor: [5,5] });
    state.confirmedMarker = L.marker([lat, lng], { icon, zIndexOffset: 500 }).addTo(state.map);
  } else {
    state.confirmedMarker.setLatLng([lat, lng]);
  }
}

// --- Animation ---
function startAnimation() {
  function animate(timestamp) {
    const distance = state.predictor.tick(timestamp, state.totalRouteDistance);
    if (distance !== null) {
      const pos = distanceToPosition(distance, state.routeCoords, state.routeDistances);
      if (state.driverMarker) state.driverMarker.setLatLng(pos);
      updateRouteColors(distance);
      updateInfoPanel();
    }
    if (state.predictor.hasArrived) {
      showStatus('last-update-info', 'Driver has arrived!');
      state.predictor.animationFrameId = null;
      return;
    }
    state.predictor.animationFrameId = requestAnimationFrame(animate);
  }
  state.predictor.animationFrameId = requestAnimationFrame(animate);
}

function updateRouteColors(currentDistance) {
  if (Math.random() > 0.03) return;
  const splitPos = distanceToPosition(currentDistance, state.routeCoords, state.routeDistances);
  let splitIdx = 0;
  for (let i = 0; i < state.routeDistances.length; i++) {
    if (state.routeDistances[i] > currentDistance) { splitIdx = i; break; }
  }
  const traveled = state.routeCoords.slice(0, splitIdx);
  traveled.push(splitPos);
  const remaining = [splitPos, ...state.routeCoords.slice(splitIdx)];

  if (state.traveledPolyline) state.map.removeLayer(state.traveledPolyline);
  if (state.remainingPolyline) state.map.removeLayer(state.remainingPolyline);
  if (state.routePolyline) { state.map.removeLayer(state.routePolyline); state.routePolyline = null; }

  state.traveledPolyline = L.polyline(traveled, { color: '#888', weight: 5, opacity: 0.5 }).addTo(state.map);
  state.remainingPolyline = L.polyline(remaining, { color: '#4285f4', weight: 5, opacity: 0.8 }).addTo(state.map);
}

// --- Info Panel ---
function updateInfoPanel() {
  const p = state.predictor;
  document.getElementById('info-speed').textContent = p.isTracking ? `${p.getSpeedMph().toFixed(0)} mph` : '--';

  const eta = p.getETA(state.totalRouteDistance);
  if (eta !== null && eta > 0) {
    const m = Math.round(eta / 60);
    document.getElementById('info-eta').textContent = m > 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m} min`;
  } else {
    document.getElementById('info-eta').textContent = '--';
  }

  if (p.isTracking) {
    document.getElementById('info-remaining').textContent = `${(p.getRemainingDistance(state.totalRouteDistance) / 1609.34).toFixed(1)} mi`;
  } else {
    document.getElementById('info-remaining').textContent = '--';
  }

  if (p.lastPredictionError !== null) {
    const err = Math.abs(p.lastPredictionError) / 1609.34;
    document.getElementById('info-error').textContent = `${err.toFixed(2)} mi ${p.lastPredictionError > 0 ? 'ahead' : 'behind'}`;
  } else {
    document.getElementById('info-error').textContent = '--';
  }

  if (p.hasArrived) document.getElementById('info-eta').textContent = 'Arrived!';
  else if (p.isPaused) document.getElementById('info-eta').textContent = 'Paused (stale)';
}

// --- Re-route ---
async function handleReroute() {
  document.getElementById('off-route-banner').classList.add('hidden');
  if (!state.predictor.updates.length) return;
  const last = state.predictor.updates[state.predictor.updates.length - 1];
  const endCoords = { lat: state.routeCoords[state.routeCoords.length-1][0], lng: state.routeCoords[state.routeCoords.length-1][1] };
  const startCoords = { lat: last.snappedLat, lng: last.snappedLng };
  const apiKey = localStorage.getItem('ors-api-key');
  try {
    const routeData = await fetchRoute(startCoords, endCoords, apiKey);
    const coords = decodePolyline(routeData.geometry);
    const distances = computeCumulativeDistances(coords);
    state.routeCoords = coords;
    state.routeDistances = distances;
    state.totalRouteDistance = routeData.distance;
    state.totalRouteDuration = routeData.duration;
    state.predictor.initialize(routeData.distance, routeData.duration);
    drawRoute(coords, startCoords, endCoords);
    // Save updated route
    localStorage.setItem('active-route', JSON.stringify({ coords, distances, totalDistance: routeData.distance, totalDuration: routeData.duration, startCoords, endCoords }));
    showStatus('last-update-info', 'Re-routed!');
  } catch (err) {
    showStatus('last-update-info', `Re-route failed: ${err.message}`, true);
  }
}

// --- Firebase ---
function connectFirebase() {
  const saved = localStorage.getItem('firebase-config');
  if (!saved) return;
  const config = JSON.parse(saved);
  initFirebase(config);
  setFirebaseUpdateCallback((lat, lng, timestamp) => {
    processLocationUpdate(lat, lng, timestamp);
  });
}

// --- Utility ---
function showStatus(id, msg, isError) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#e94560' : '#888';
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadRoute();
  setupQuickSearch();
  connectFirebase();
});
