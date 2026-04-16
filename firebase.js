// =============================================
// firebase.js — Firebase Realtime Database connection
// =============================================

let firebaseConnected = false;
let firebaseOnUpdate = null;
let firebaseDb = null;

function setFirebaseUpdateCallback(callback) {
  firebaseOnUpdate = callback;
}

function isFirebaseConnected() {
  return firebaseConnected;
}

function initFirebase(config) {
  // config = { apiKey, databaseURL, projectId }
  // Firebase is loaded from CDN in index.html

  if (typeof firebase === 'undefined') {
    console.error('Firebase SDK not loaded');
    updateFirebaseStatusUI(false);
    return;
  }

  try {
    // Initialize Firebase (if not already initialized)
    if (!firebase.apps.length) {
      firebase.initializeApp(config);
    }

    firebaseDb = firebase.database();

    // Listen for new location updates
    const updatesRef = firebaseDb.ref('updates');

    // Only listen for NEW entries (not existing ones on first load)
    // Use limitToLast(1) and track if it's the initial load
    let initialLoadDone = false;

    updatesRef.orderByChild('timestamp').limitToLast(1).on('value', () => {
      initialLoadDone = true;
    });

    updatesRef.on('child_added', async (snapshot) => {
      if (!initialLoadDone) return; // Skip entries that existed before we connected

      const data = snapshot.val();
      if (!data) return;
      const timestamp = data.timestamp || Date.now();
      console.log('Firebase update received:', data);

      // Handle direct lat/lng updates
      if (data.lat !== undefined && data.lng !== undefined) {
        if (firebaseOnUpdate) {
          firebaseOnUpdate(parseFloat(data.lat), parseFloat(data.lng), timestamp);
        }
        return;
      }

      // Handle street name updates (from OCR shortcut) — geocode on the fly
      if (data.street) {
        try {
          const chicagoViewbox = '&viewbox=-88.0,42.1,-87.5,41.6&bounded=1';
          const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(data.street)}&format=json&limit=1${chicagoViewbox}`;
          const resp = await fetch(url, { headers: { 'User-Agent': 'DriveTrackerPWA/1.0' } });
          const results = await resp.json();
          if (results.length && firebaseOnUpdate) {
            firebaseOnUpdate(parseFloat(results[0].lat), parseFloat(results[0].lon), timestamp);
          }
        } catch (err) {
          console.error('Failed to geocode street from Firebase:', err);
        }
      }
    });

    // Monitor connection state
    firebaseDb.ref('.info/connected').on('value', (snap) => {
      firebaseConnected = snap.val() === true;
      updateFirebaseStatusUI(firebaseConnected);
    });

  } catch (err) {
    console.error('Firebase init error:', err);
    updateFirebaseStatusUI(false);
  }
}

function updateFirebaseStatusUI(connected) {
  const el = document.getElementById('firebase-status');
  if (connected) {
    el.innerHTML = '<span class="status-dot online"></span> Listening for updates...';
  } else {
    el.innerHTML = '<span class="status-dot offline"></span> Firebase not connected';
  }
}

// Save Firebase config to localStorage so user doesn't have to re-enter
function saveFirebaseConfig(config) {
  localStorage.setItem('firebase-config', JSON.stringify(config));
}

function loadFirebaseConfig() {
  const saved = localStorage.getItem('firebase-config');
  return saved ? JSON.parse(saved) : null;
}
