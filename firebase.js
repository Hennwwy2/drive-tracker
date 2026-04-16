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

    updatesRef.on('child_added', (snapshot) => {
      if (!initialLoadDone) return; // Skip entries that existed before we connected

      const data = snapshot.val();
      if (data && data.lat !== undefined && data.lng !== undefined) {
        const timestamp = data.timestamp || Date.now();
        console.log('Firebase update received:', data);

        if (firebaseOnUpdate) {
          firebaseOnUpdate(parseFloat(data.lat), parseFloat(data.lng), timestamp);
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
