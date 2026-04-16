// =============================================
// predictor.js — Speed estimation, prediction, correction
// =============================================

const SPEED_ALPHA = 0.6;        // Exponential smoothing weight toward new observation
const MIN_SPEED = 0;            // m/s (stopped)
const MAX_SPEED = 40;           // m/s (~90 mph)
const OUTLIER_FACTOR = 3;       // Ignore speeds more than 3x current estimate
const CORRECTION_DURATION = 2000; // ms to ease from prediction to real position
const MAX_DT = 60;              // Max seconds per animation frame (handles screen-off resume)
const ARRIVAL_THRESHOLD = 500;  // meters from end to consider arrived
const STALE_THRESHOLD = 20 * 60 * 1000; // 20 minutes in ms

function createPredictor() {
  return {
    estimatedSpeedMps: 0,
    currentDistanceAlongRoute: 0,
    isTracking: false,
    isPaused: false,
    hasArrived: false,

    // Correction easing state
    correctionActive: false,
    correctionStartDistance: 0,
    correctionTargetDistance: 0,
    correctionStartTime: 0,

    // Animation
    animationFrameId: null,
    lastAnimationTimestamp: null,

    // For prediction error display
    lastPredictionError: null,

    // Updates history
    updates: [],

    initialize(totalDistance, totalDuration) {
      this.estimatedSpeedMps = totalDistance / totalDuration;
      this.currentDistanceAlongRoute = 0;
      this.isTracking = false;
      this.isPaused = false;
      this.hasArrived = false;
      this.updates = [];
      this.lastPredictionError = null;
      this.correctionActive = false;
    },

    processUpdate(snappedResult, timestamp) {
      const update = {
        ...snappedResult,
        timestamp: timestamp || Date.now()
      };

      // Record prediction error before correcting
      if (this.isTracking) {
        this.lastPredictionError = this.currentDistanceAlongRoute - update.distanceAlongRoute;
      }

      this.updates.push(update);

      // Update speed estimate if we have 2+ updates
      if (this.updates.length >= 2) {
        const prev = this.updates[this.updates.length - 2];
        const timeDelta = (update.timestamp - prev.timestamp) / 1000;

        if (timeDelta > 0) {
          const distDelta = update.distanceAlongRoute - prev.distanceAlongRoute;
          let observedSpeed = distDelta / timeDelta;

          // Clamp outliers before blending
          if (this.estimatedSpeedMps > 0 && Math.abs(observedSpeed) > this.estimatedSpeedMps * OUTLIER_FACTOR) {
            observedSpeed = Math.sign(observedSpeed) * this.estimatedSpeedMps * OUTLIER_FACTOR;
          }

          observedSpeed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, observedSpeed));

          this.estimatedSpeedMps = SPEED_ALPHA * observedSpeed + (1 - SPEED_ALPHA) * this.estimatedSpeedMps;
          this.estimatedSpeedMps = Math.max(MIN_SPEED, Math.min(MAX_SPEED, this.estimatedSpeedMps));
        }
      }

      // Start smooth correction instead of teleporting
      if (this.isTracking && Math.abs(this.currentDistanceAlongRoute - update.distanceAlongRoute) > 10) {
        this.correctionActive = true;
        this.correctionStartDistance = this.currentDistanceAlongRoute;
        this.correctionTargetDistance = update.distanceAlongRoute;
        this.correctionStartTime = performance.now();
      } else {
        this.currentDistanceAlongRoute = update.distanceAlongRoute;
      }

      // Start tracking after first update
      if (!this.isTracking) {
        this.currentDistanceAlongRoute = update.distanceAlongRoute;
        this.isTracking = true;
      }

      this.isPaused = false;

      return update;
    },

    // Returns the position to display, accounting for correction easing
    tick(timestamp, totalRouteDistance) {
      if (!this.isTracking || this.hasArrived) return null;

      // Check for stale updates
      if (this.updates.length > 0) {
        const lastUpdate = this.updates[this.updates.length - 1];
        if (Date.now() - lastUpdate.timestamp > STALE_THRESHOLD) {
          this.isPaused = true;
        }
      }

      if (this.lastAnimationTimestamp === null) {
        this.lastAnimationTimestamp = timestamp;
        return this.currentDistanceAlongRoute;
      }

      let dt = (timestamp - this.lastAnimationTimestamp) / 1000;
      dt = Math.min(dt, MAX_DT);
      this.lastAnimationTimestamp = timestamp;

      if (this.correctionActive) {
        // Smooth easing toward corrected position
        const elapsed = timestamp - this.correctionStartTime;
        if (elapsed < CORRECTION_DURATION) {
          let t = elapsed / CORRECTION_DURATION;
          t = t * t * (3 - 2 * t); // smoothstep
          this.currentDistanceAlongRoute =
            this.correctionStartDistance + t * (this.correctionTargetDistance - this.correctionStartDistance);
        } else {
          this.currentDistanceAlongRoute = this.correctionTargetDistance;
          this.correctionActive = false;
        }
      } else if (!this.isPaused) {
        // Normal speed-based prediction
        this.currentDistanceAlongRoute += this.estimatedSpeedMps * dt;
      }

      // Clamp to route
      this.currentDistanceAlongRoute = Math.max(0, Math.min(this.currentDistanceAlongRoute, totalRouteDistance));

      // Check arrival
      if (totalRouteDistance - this.currentDistanceAlongRoute < ARRIVAL_THRESHOLD) {
        this.hasArrived = true;
      }

      return this.currentDistanceAlongRoute;
    },

    getSpeedMph() {
      return this.estimatedSpeedMps * 2.237; // m/s to mph
    },

    getETA(totalRouteDistance) {
      const remaining = totalRouteDistance - this.currentDistanceAlongRoute;
      if (this.estimatedSpeedMps <= 0.5) return null;
      return remaining / this.estimatedSpeedMps; // seconds
    },

    getRemainingDistance(totalRouteDistance) {
      return totalRouteDistance - this.currentDistanceAlongRoute;
    }
  };
}
