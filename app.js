// =============================================
// app.js — Main app logic, state, UI wiring
// =============================================

// --- Address Autocomplete ---
let autocompleteTimer = null;
const selectedCoords = { start: null, end: null };

function setupAutocomplete(inputId, listId, coordKey) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);

  input.addEventListener('input', () => {
    clearTimeout(autocompleteTimer);
    const query = input.value.trim();

    if (query.length < 3) {
      list.classList.remove('visible');
      return;
    }

    // Debounce: wait 600ms after typing stops (respects Nominatim 1 req/sec)
    autocompleteTimer = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'DriveTrackerPWA/1.0' }
        });
        const results = await resp.json();

        if (!results.length) {
          list.classList.remove('visible');
          return;
        }

        list.innerHTML = '';
        results.forEach(result => {
          const item = document.createElement('div');
          item.className = 'autocomplete-item';

          const mainName = result.display_name.split(',')[0];
          const detail = result.display_name.split(',').slice(1, 4).join(',').trim();

          item.innerHTML = `<div class="addr-main">${mainName}</div><div class="addr-detail">${detail}</div>`;

          item.addEventListener('click', () => {
            input.value = result.display_name;
            selectedCoords[coordKey] = {
              lat: parseFloat(result.lat),
              lng: parseFloat(result.lon)
            };
            list.classList.remove('visible');
          });

          list.appendChild(item);
        });

        list.classList.add('visible');
      } catch (err) {
        console.error('Autocomplete error:', err);
      }
    }, 600);
  });

  // Hide dropdown when clicking elsewhere
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.autocomplete-wrap')) {
      list.classList.remove('visible');
    }
  });
}

// --- Saved Addresses ---
function getSavedAddresses() {
  const saved = localStorage.getItem('saved-addresses');
  return saved ? JSON.parse(saved) : [];
}

function saveSavedAddresses(addresses) {
  localStorage.setItem('saved-addresses', JSON.stringify(addresses));
}

function handleSaveAddress(which) {
  const label = document.getElementById('save-label').value.trim();
  const inputId = which === 'start' ? 'start-address' : 'end-address';
  const address = document.getElementById(inputId).value.trim();
  const coords = selectedCoords[which];

  if (!label) {
    showStatus('route-status', 'Enter a label for the address.', 'error');
    return;
  }
  if (!address || !coords) {
    showStatus('route-status', 'Select an address from autocomplete first.', 'error');
    return;
  }

  const addresses = getSavedAddresses();
  addresses.push({ label, address, lat: coords.lat, lng: coords.lng });
  saveSavedAddresses(addresses);
  document.getElementById('save-label').value = '';
  renderSavedAddresses();
}

function deleteSavedAddress(index) {
  const addresses = getSavedAddresses();
  addresses.splice(index, 1);
  saveSavedAddresses(addresses);
  renderSavedAddresses();
}

function applySavedAddress(entry, which) {
  const inputId = which === 'start' ? 'start-address' : 'end-address';
  document.getElementById(inputId).value = entry.address;
  selectedCoords[which] = { lat: entry.lat, lng: entry.lng };
}

function renderSavedAddresses() {
  const list = document.getElementById('saved-addresses-list');
  const addresses = getSavedAddresses();
  list.innerHTML = '';

  addresses.forEach((entry, i) => {
    const chip = document.createElement('div');
    chip.className = 'saved-chip';
    chip.innerHTML = `<span class="chip-label">${entry.label}</span>`;

    // Click left side = set as start, hold context info
    chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('chip-delete')) return;
      // If start field is empty or focused, fill start. Otherwise fill end.
      const startVal = document.getElementById('start-address').value.trim();
      if (!startVal || document.activeElement === document.getElementById('start-address')) {
        applySavedAddress(entry, 'start');
      } else {
        applySavedAddress(entry, 'end');
      }
    });

    const del = document.createElement('span');
    del.className = 'chip-delete';
    del.textContent = '\u00d7';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSavedAddress(i);
    });

    chip.appendChild(del);
    list.appendChild(chip);
  });
}

// --- App State ---
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

// --- Map Initialization ---
function initMap() {
  state.map = L.map('map', {
    zoomControl: false
  }).setView([39.8283, -98.5795], 4); // Center of US

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(state.map);

  // Zoom control on right side
  L.control.zoom({ position: 'topright' }).addTo(state.map);
}

// --- Panel toggle ---
function togglePanel(panelId) {
  document.getElementById(panelId).classList.toggle('collapsed');
  // Invalidate map size after panel toggle animation
  setTimeout(() => state.map.invalidateSize(), 300);
}

// --- Route handling ---
async function handleGetRoute() {
  const startAddr = document.getElementById('start-address').value.trim();
  const endAddr = document.getElementById('end-address').value.trim();
  const apiKey = document.getElementById('ors-key').value.trim();

  if (!startAddr || !endAddr) {
    showStatus('route-status', 'Please enter both addresses.', 'error');
    return;
  }
  if (!apiKey) {
    showStatus('route-status', 'Please enter your ORS API key.', 'error');
    return;
  }

  // Save API key for next time
  localStorage.setItem('ors-api-key', apiKey);

  const btn = document.getElementById('get-route-btn');
  btn.disabled = true;
  btn.textContent = 'Loading...';

  try {
    let startCoords, endCoords;

    // Use pre-selected coordinates from autocomplete if available
    if (selectedCoords.start) {
      startCoords = selectedCoords.start;
    } else {
      showStatus('route-status', 'Geocoding start address...');
      startCoords = await geocodeAddress(startAddr);
      await sleep(1100);
    }

    if (selectedCoords.end) {
      endCoords = selectedCoords.end;
    } else {
      if (!selectedCoords.start) await sleep(1100); // Respect Nominatim rate limit
      showStatus('route-status', 'Geocoding end address...');
      endCoords = await geocodeAddress(endAddr);
    }

    showStatus('route-status', 'Fetching route...');
    const routeData = await fetchRoute(startCoords, endCoords, apiKey);

    // Decode and process
    const coords = decodePolyline(routeData.geometry);
    const distances = computeCumulativeDistances(coords);

    state.routeCoords = coords;
    state.routeDistances = distances;
    state.totalRouteDistance = routeData.distance;
    state.totalRouteDuration = routeData.duration;

    // Initialize predictor with route data
    state.predictor.initialize(routeData.distance, routeData.duration);

    // Draw on map
    drawRoute(coords, startCoords, endCoords);

    const miles = (routeData.distance / 1609.34).toFixed(1);
    const minutes = Math.round(routeData.duration / 60);
    showStatus('route-status', `Route: ${miles} mi, ~${minutes} min`);

    // Collapse setup panel
    document.getElementById('setup-panel').classList.add('collapsed');

  } catch (err) {
    showStatus('route-status', `Error: ${err.message}`, 'error');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get Route';
  }
}

function drawRoute(coords, startCoords, endCoords) {
  // Clear previous
  if (state.routePolyline) state.map.removeLayer(state.routePolyline);
  if (state.traveledPolyline) state.map.removeLayer(state.traveledPolyline);
  if (state.remainingPolyline) state.map.removeLayer(state.remainingPolyline);
  if (state.startMarker) state.map.removeLayer(state.startMarker);
  if (state.endMarker) state.map.removeLayer(state.endMarker);
  if (state.driverMarker) state.map.removeLayer(state.driverMarker);
  if (state.confirmedMarker) state.map.removeLayer(state.confirmedMarker);

  // Draw route polyline
  state.routePolyline = L.polyline(coords, {
    color: '#4285f4',
    weight: 5,
    opacity: 0.7
  }).addTo(state.map);

  // Start marker
  state.startMarker = L.circleMarker([startCoords.lat, startCoords.lng], {
    radius: 8,
    fillColor: '#4caf50',
    color: 'white',
    weight: 2,
    fillOpacity: 1
  }).addTo(state.map).bindPopup('Start');

  // End marker
  state.endMarker = L.circleMarker([endCoords.lat, endCoords.lng], {
    radius: 8,
    fillColor: '#e94560',
    color: 'white',
    weight: 2,
    fillOpacity: 1
  }).addTo(state.map).bindPopup('End');

  // Fit map to route
  state.map.fitBounds(state.routePolyline.getBounds(), { padding: [30, 30] });
}

// --- Location update handling ---
function processLocationUpdate(lat, lng, timestamp) {
  if (!state.routeCoords.length) {
    showStatus('last-update-info', 'No route loaded. Set up a route first.', 'error');
    return;
  }

  const snap = snapToRoute(lat, lng, state.routeCoords, state.routeDistances);

  // Off-route check
  if (snap.perpendicularDistance > 500) {
    document.getElementById('off-route-banner').classList.remove('hidden');
  }

  // Process in predictor
  state.predictor.processUpdate(snap, timestamp || Date.now());

  // Update confirmed position marker
  updateConfirmedMarker(snap.snappedLat, snap.snappedLng);

  // Ensure driver blip exists
  ensureDriverMarker();

  // Start animation if not running
  if (!state.predictor.animationFrameId) {
    startAnimation();
  }

  // Update info
  updateInfoPanel();

  const time = new Date(timestamp || Date.now()).toLocaleTimeString();
  showStatus('last-update-info', `Last update: ${time} (${(snap.perpendicularDistance).toFixed(0)}m from route)`);
}

function handleManualSubmit() {
  const lat = parseFloat(document.getElementById('manual-lat').value);
  const lng = parseFloat(document.getElementById('manual-lng').value);

  if (isNaN(lat) || isNaN(lng)) {
    showStatus('last-update-info', 'Invalid coordinates.', 'error');
    return;
  }

  processLocationUpdate(lat, lng);
  document.getElementById('manual-lat').value = '';
  document.getElementById('manual-lng').value = '';
}

async function handlePasteSubmit() {
  try {
    const text = await navigator.clipboard.readText();
    const parts = text.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

    if (parts.length >= 2) {
      const lat = parseFloat(parts[0]);
      const lng = parseFloat(parts[1]);

      if (!isNaN(lat) && !isNaN(lng)) {
        processLocationUpdate(lat, lng);
        return;
      }
    }

    showStatus('last-update-info', 'Clipboard doesn\'t contain valid coordinates (expected "lat, lng").', 'error');
  } catch (err) {
    showStatus('last-update-info', 'Clipboard access denied. Use manual input.', 'error');
  }
}

// --- Markers ---
function ensureDriverMarker() {
  if (state.driverMarker) return;

  const blipIcon = L.divIcon({
    className: '',
    html: '<div class="driver-blip"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });

  const pos = state.routeCoords[0];
  state.driverMarker = L.marker(pos, { icon: blipIcon, zIndexOffset: 1000 }).addTo(state.map);
}

function updateConfirmedMarker(lat, lng) {
  if (!state.confirmedMarker) {
    const icon = L.divIcon({
      className: '',
      html: '<div class="confirmed-blip"></div>',
      iconSize: [10, 10],
      iconAnchor: [5, 5]
    });
    state.confirmedMarker = L.marker([lat, lng], { icon: icon, zIndexOffset: 500 }).addTo(state.map);
  } else {
    state.confirmedMarker.setLatLng([lat, lng]);
  }
}

// --- Animation Loop ---
function startAnimation() {
  function animate(timestamp) {
    const distance = state.predictor.tick(timestamp, state.totalRouteDistance);

    if (distance !== null) {
      const pos = distanceToPosition(distance, state.routeCoords, state.routeDistances);
      if (state.driverMarker) {
        state.driverMarker.setLatLng(pos);
      }
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

// --- Route coloring (traveled vs remaining) ---
function updateRouteColors(currentDistance) {
  // Only update every ~30 frames to avoid performance issues
  if (Math.random() > 0.03) return;

  const splitPos = distanceToPosition(currentDistance, state.routeCoords, state.routeDistances);

  // Find the split index
  let splitIdx = 0;
  for (let i = 0; i < state.routeDistances.length; i++) {
    if (state.routeDistances[i] > currentDistance) {
      splitIdx = i;
      break;
    }
  }

  const traveled = state.routeCoords.slice(0, splitIdx);
  traveled.push(splitPos);

  const remaining = [splitPos];
  remaining.push(...state.routeCoords.slice(splitIdx));

  // Remove old split polylines
  if (state.traveledPolyline) state.map.removeLayer(state.traveledPolyline);
  if (state.remainingPolyline) state.map.removeLayer(state.remainingPolyline);
  if (state.routePolyline) state.map.removeLayer(state.routePolyline);
  state.routePolyline = null;

  state.traveledPolyline = L.polyline(traveled, {
    color: '#888',
    weight: 5,
    opacity: 0.5
  }).addTo(state.map);

  state.remainingPolyline = L.polyline(remaining, {
    color: '#4285f4',
    weight: 5,
    opacity: 0.8
  }).addTo(state.map);
}

// --- Info panel ---
function updateInfoPanel() {
  const pred = state.predictor;

  // Speed
  const speedMph = pred.getSpeedMph();
  document.getElementById('info-speed').textContent =
    pred.isTracking ? `${speedMph.toFixed(0)} mph` : '--';

  // ETA
  const etaSec = pred.getETA(state.totalRouteDistance);
  if (etaSec !== null && etaSec > 0) {
    const etaMin = Math.round(etaSec / 60);
    document.getElementById('info-eta').textContent =
      etaMin > 60 ? `${Math.floor(etaMin / 60)}h ${etaMin % 60}m` : `${etaMin} min`;
  } else {
    document.getElementById('info-eta').textContent = '--';
  }

  // Remaining distance
  const remaining = pred.getRemainingDistance(state.totalRouteDistance);
  if (pred.isTracking) {
    const miles = (remaining / 1609.34).toFixed(1);
    document.getElementById('info-remaining').textContent = `${miles} mi`;
  } else {
    document.getElementById('info-remaining').textContent = '--';
  }

  // Prediction error
  if (pred.lastPredictionError !== null) {
    const errMiles = (Math.abs(pred.lastPredictionError) / 1609.34).toFixed(2);
    const direction = pred.lastPredictionError > 0 ? 'ahead' : 'behind';
    document.getElementById('info-error').textContent = `${errMiles} mi ${direction}`;
  } else {
    document.getElementById('info-error').textContent = '--';
  }

  // Paused / arrived status
  if (pred.hasArrived) {
    document.getElementById('info-eta').textContent = 'Arrived!';
  } else if (pred.isPaused) {
    document.getElementById('info-eta').textContent = 'Paused (stale)';
  }
}

// --- Re-route ---
async function handleReroute() {
  dismissBanner();

  if (!state.predictor.updates.length) return;

  const lastUpdate = state.predictor.updates[state.predictor.updates.length - 1];
  const endCoords = {
    lat: state.routeCoords[state.routeCoords.length - 1][0],
    lng: state.routeCoords[state.routeCoords.length - 1][1]
  };
  const startCoords = { lat: lastUpdate.snappedLat, lng: lastUpdate.snappedLng };
  const apiKey = document.getElementById('ors-key').value.trim();

  try {
    showStatus('route-status', 'Re-routing...');
    const routeData = await fetchRoute(startCoords, endCoords, apiKey);
    const coords = decodePolyline(routeData.geometry);
    const distances = computeCumulativeDistances(coords);

    state.routeCoords = coords;
    state.routeDistances = distances;
    state.totalRouteDistance = routeData.distance;
    state.totalRouteDuration = routeData.duration;

    state.predictor.initialize(routeData.distance, routeData.duration);

    drawRoute(coords, startCoords, endCoords);
    showStatus('route-status', 'Re-routed successfully.');
  } catch (err) {
    showStatus('route-status', `Re-route failed: ${err.message}`, 'error');
  }
}

function dismissBanner() {
  document.getElementById('off-route-banner').classList.add('hidden');
}

// --- Utilities ---
function showStatus(elementId, message, type) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.style.color = type === 'error' ? '#e94560' : '#888';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Firebase connection ---
function handleConnectFirebase() {
  const dbUrl = document.getElementById('firebase-url').value.trim();
  const apiKey = document.getElementById('firebase-api-key').value.trim();

  if (!dbUrl) {
    showStatus('route-status', 'Please enter your Firebase Database URL.', 'error');
    return;
  }

  const config = {
    apiKey: apiKey || 'dummy', // Some Firebase projects work without an API key for RTDB
    databaseURL: dbUrl
  };

  saveFirebaseConfig(config);
  initFirebase(config);
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  initMap();

  // Restore saved API key
  const savedKey = localStorage.getItem('ors-api-key');
  if (savedKey) {
    document.getElementById('ors-key').value = savedKey;
  }

  // Restore saved Firebase config
  const savedFirebase = loadFirebaseConfig();
  if (savedFirebase) {
    if (savedFirebase.databaseURL) {
      document.getElementById('firebase-url').value = savedFirebase.databaseURL;
    }
    if (savedFirebase.apiKey && savedFirebase.apiKey !== 'dummy') {
      document.getElementById('firebase-api-key').value = savedFirebase.apiKey;
    }
    // Auto-connect Firebase if config was saved
    initFirebase(savedFirebase);
  }

  // Render saved addresses
  renderSavedAddresses();

  // Set up autocomplete on address fields
  setupAutocomplete('start-address', 'start-suggestions', 'start');
  setupAutocomplete('end-address', 'end-suggestions', 'end');

  // Set up Firebase callback
  setFirebaseUpdateCallback((lat, lng, timestamp) => {
    processLocationUpdate(lat, lng, timestamp);
  });

  // Register service worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.log('SW registration failed:', err);
    });
  }
});
