// =============================================
// route.js — Geocoding, routing, polyline math
// =============================================

const EARTH_RADIUS = 6371000; // meters

// --- Geocoding via Nominatim ---

async function geocodeAddress(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'DriveTrackerPWA/1.0' }
  });
  const data = await resp.json();
  if (!data.length) throw new Error(`Address not found: "${query}"`);
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

// --- Route fetching via OpenRouteService ---

async function fetchRoute(startCoords, endCoords, apiKey) {
  const url = 'https://api.openrouteservice.org/v2/directions/driving-car';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      coordinates: [
        [startCoords.lng, startCoords.lat], // ORS uses [lng, lat]
        [endCoords.lng, endCoords.lat]
      ]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Route request failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const route = data.routes[0];
  return {
    geometry: route.geometry,
    distance: route.summary.distance,  // meters
    duration: route.summary.duration   // seconds
  };
}

// --- Polyline decoding (Google Encoded Polyline Algorithm) ---

function decodePolyline(encoded) {
  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    // Decode latitude
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    // Decode longitude
    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coords.push([lat / 1e5, lng / 1e5]); // [lat, lng] for Leaflet
  }

  return coords;
}

// --- Distance math ---

function toRad(deg) {
  return deg * Math.PI / 180;
}

function haversine(p1, p2) {
  const dLat = toRad(p2[0] - p1[0]);
  const dLng = toRad(p2[1] - p1[1]);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(p1[0])) * Math.cos(toRad(p2[0])) *
            Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
}

function computeCumulativeDistances(coords) {
  const distances = [0];
  for (let i = 1; i < coords.length; i++) {
    distances.push(distances[i - 1] + haversine(coords[i - 1], coords[i]));
  }
  return distances;
}

// --- Convert distance-along-route to [lat, lng] ---

function distanceToPosition(distance, routeCoords, routeDistances) {
  // Clamp
  if (distance <= 0) return routeCoords[0];
  if (distance >= routeDistances[routeDistances.length - 1]) {
    return routeCoords[routeCoords.length - 1];
  }

  // Binary search for the segment
  let lo = 0;
  let hi = routeDistances.length - 1;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (routeDistances[mid] <= distance) lo = mid;
    else hi = mid;
  }

  const segDist = routeDistances[hi] - routeDistances[lo];
  const fraction = segDist > 0 ? (distance - routeDistances[lo]) / segDist : 0;

  return [
    routeCoords[lo][0] + fraction * (routeCoords[hi][0] - routeCoords[lo][0]),
    routeCoords[lo][1] + fraction * (routeCoords[hi][1] - routeCoords[lo][1])
  ];
}

// --- Snap a point to the nearest position on the route ---

function snapToRoute(lat, lng, routeCoords, routeDistances) {
  let bestDist = Infinity;
  let bestIndex = 0;
  let bestFraction = 0;
  let bestClosest = routeCoords[0];

  const cosLat = Math.cos(toRad(lat));

  for (let i = 0; i < routeCoords.length - 1; i++) {
    const ax = routeCoords[i][0];
    const ay = routeCoords[i][1];
    const bx = routeCoords[i + 1][0];
    const by = routeCoords[i + 1][1];

    // Flat-earth approximation for projection (good enough for nearby points)
    const vx = bx - ax;
    const vy = (by - ay) * cosLat;
    const ux = lat - ax;
    const uy = (lng - ay) * cosLat;

    const dot = ux * vx + uy * vy;
    const lenSq = vx * vx + vy * vy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, dot / lenSq)) : 0;

    const closestLat = ax + t * (bx - ax);
    const closestLng = ay + t * (by - ay);

    const dist = haversine([lat, lng], [closestLat, closestLng]);

    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
      bestFraction = t;
      bestClosest = [closestLat, closestLng];
    }
  }

  const distanceAlongRoute = routeDistances[bestIndex] +
    bestFraction * (routeDistances[bestIndex + 1] - routeDistances[bestIndex]);

  return {
    snappedLat: bestClosest[0],
    snappedLng: bestClosest[1],
    distanceAlongRoute: distanceAlongRoute,
    perpendicularDistance: bestDist, // meters from route
    segmentIndex: bestIndex,
    segmentFraction: bestFraction
  };
}
