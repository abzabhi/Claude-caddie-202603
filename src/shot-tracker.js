/* shot-tracker.js — GPS shot-tracker state machine.
   Pure logic; no DOM. Loaded as an ES module before gps-view.js.
   All state lives on window.lrState (managed by live-round.js); persisted via _lrPersist.
   Functions exposed on window to match existing live-round pattern.

   Lie vocabulary used by the existing scoring picker (live-round.js ~1706):
     ['tee','green','fairway','rough','sand','recovery']
   geomLieAtPoint returns:
     'green' | 'tee' | 'fairway' | 'rough' | 'bunker' | 'lateral_water_hazard' | null
   _stMapLie() normalises the latter to the former.
*/

import { geomDistanceYds, geomBearingDeg, geomLieAtPoint, geomPointInPolygon } from './geomap.js';

/* Picker-recognised lies. Update this list (and the mapping below) if the
   live-round.js lie picker ever gains new options (e.g. 'fringe'). */
var ST_PICKER_LIES = ['tee', 'green', 'fairway', 'rough', 'sand', 'recovery'];

/* Normalise a raw lie value (from geomLieAtPoint or unknown source) to a
   value the existing lie picker + sgExpected() can consume. */
function _stMapLie(raw) {
  if (raw === 'fairway')              return 'fairway';
  if (raw === 'green')                return 'green';
  if (raw === 'tee')                  return 'tee';
  if (raw === 'rough')                return 'rough';
  if (raw === 'bunker')               return 'sand';
  if (raw === 'lateral_water_hazard') return 'recovery';
  if (raw === 'water')                return 'recovery';  /* defensive */
  /* null or anything unexpected -> default rough (matches handoff). */
  return 'rough';
}

/* Resolve the green polygon feature for the current hole (for shot_mode auto-detect). */
function _stCurrentGreenFeature() {
  var lr = window.lrState;
  if (!lr || !lr._mapInstance) return null;
  var geo = (typeof lr._mapInstance.getGeometry === 'function')
    ? lr._mapInstance.getGeometry()
    : (lr._mapInstance._geo || null);
  if (!geo || !geo.features) return null;
  var holeN = lr.curHole + 1;
  for (var i = 0; i < geo.features.length; i++) {
    var f = geo.features[i];
    if (!f || !f.properties) continue;
    if (f.properties.golf !== 'green') continue;
    /* Match by ref/hole number if available; else first green is acceptable fallback. */
    var ref = f.properties.ref || f.properties.hole;
    if (ref != null && +ref === holeN) return f;
  }
  /* Fallback: first green if no ref-tagged match. */
  for (var j = 0; j < geo.features.length; j++) {
    if (geo.features[j].properties && geo.features[j].properties.golf === 'green') return geo.features[j];
  }
  return null;
}

/* Resolve a tee position [lon,lat] for the current hole, for shot 1's startLngLat. */
function _stCurrentTeeLngLat() {
  var lr = window.lrState;
  if (!lr) return null;
  /* Prefer user-overridden tee, else the MapView's resolved tee marker location. */
  if (Array.isArray(lr._mapTeeLonLat)) return lr._mapTeeLonLat;
  if (lr._mapInstance && lr._mapInstance._teeOverride) return lr._mapInstance._teeOverride;
  /* Try geometry tee feature. */
  if (lr._mapInstance) {
    var geo = (typeof lr._mapInstance.getGeometry === 'function')
      ? lr._mapInstance.getGeometry()
      : (lr._mapInstance._geo || null);
    if (geo && geo.features) {
      var holeN = lr.curHole + 1;
      for (var i = 0; i < geo.features.length; i++) {
        var f = geo.features[i];
        if (!f || !f.properties || f.properties.golf !== 'tee') continue;
        var ref = f.properties.ref || f.properties.hole;
        if (ref != null && +ref !== holeN) continue;
        if (f.geometry && f.geometry.type === 'Point') return f.geometry.coordinates;
        /* Polygon tee: return centroid-ish (first coord) as approximation. */
        if (f.geometry && f.geometry.type === 'Polygon' && f.geometry.coordinates[0]) {
          return f.geometry.coordinates[0][0];
        }
      }
    }
  }
  return null;
}

/* Compute green-centre [lon,lat] for distanceToHole. */
function _stGreenCenter() {
  var g = _stCurrentGreenFeature();
  if (!g || !g.geometry) return null;
  if (g.geometry.type === 'Point') return g.geometry.coordinates;
  if (g.geometry.type === 'Polygon' && g.geometry.coordinates[0]) {
    var ring = g.geometry.coordinates[0];
    var sx = 0, sy = 0, n = 0;
    for (var i = 0; i < ring.length; i++) { sx += ring[i][0]; sy += ring[i][1]; n++; }
    if (n) return [sx / n, sy / n];
  }
  return null;
}

/* Get most-recent shot record for the current player + hole, or null. */
function _stLastShot() {
  var lr = window.lrState;
  if (!lr) return null;
  var s = lr.players[lr.curPlayer].scores[lr.curHole];
  if (!s || !Array.isArray(s.shots) || !s.shots.length) return null;
  return s.shots[s.shots.length - 1];
}

/* Decompose displacement (end-start) into components along/perpendicular to (aim-start), in yards.
   Returns { dispLong, dispLat } where dispLong is along aim direction, dispLat is right-of-aim positive. */
function _stDecompose(startLL, endLL, aimLL) {
  /* Build a local equirectangular projection in metres around startLL, then convert to yards. */
  var lat0 = startLL[1] * Math.PI / 180;
  var R = 6371000;  /* Earth radius m */
  var toXY = function(p) {
    var dlon = (p[0] - startLL[0]) * Math.PI / 180;
    var dlat = (p[1] - startLL[1]) * Math.PI / 180;
    return { x: dlon * Math.cos(lat0) * R, y: dlat * R };
  };
  var e = toXY(endLL);
  var a = toXY(aimLL);
  var aLen = Math.sqrt(a.x * a.x + a.y * a.y);
  if (aLen < 1e-6) return { dispLong: 0, dispLat: 0 };
  var ux = a.x / aLen, uy = a.y / aLen;       /* unit along aim */
  var rx = uy,         ry = -ux;              /* unit right-perpendicular (clockwise 90°) */
  var alongM = e.x * ux + e.y * uy;
  var lateralM = e.x * rx + e.y * ry;
  var M_TO_YDS = 1.0936133;
  return {
    dispLong: +(alongM * M_TO_YDS).toFixed(2),
    dispLat:  +(lateralM * M_TO_YDS).toFixed(2)
  };
}

/* ───── Exports ───── */

/* Arm a shot. aimLngLat required; club optional; currentLngLat used as fallback start position. */
function stArmShot(aimLngLat, club, currentLngLat) {
  var lr = window.lrState;
  if (!lr) return;
  if (!Array.isArray(aimLngLat) || aimLngLat.length < 2) return;

  var shots = (lr.players[lr.curPlayer].scores[lr.curHole].shots) || [];
  var startLngLat = null;
  if (shots.length === 0) {
    /* Shot 1: tee position. */
    startLngLat = _stCurrentTeeLngLat() || (Array.isArray(currentLngLat) ? currentLngLat : null);
  } else {
    /* Subsequent: previous shot's endLngLat (gps_flight) or current GPS position. */
    var last = shots[shots.length - 1];
    if (last && last.gps_flight && Array.isArray(last.gps_flight.endLngLat)) {
      startLngLat = last.gps_flight.endLngLat;
    } else if (Array.isArray(currentLngLat)) {
      startLngLat = currentLngLat;
    }
  }
  if (!startLngLat) return;  /* can't arm without a start */

  /* Determine shotMode. */
  var shotMode = 'standard';
  var greenFeat = _stCurrentGreenFeature();
  var lastLie = (function(){ var l = _stLastShot(); return l ? l.lie : null; })();
  if (lastLie === 'green') {
    shotMode = 'on_green';
  } else if (greenFeat) {
    try {
      if (geomPointInPolygon(aimLngLat, greenFeat)) shotMode = 'approach';
    } catch (e) { /* ignore; leave as standard */ }
  }

  lr._shotArmed = {
    startLngLat: startLngLat,
    aimLngLat:   aimLngLat,
    club:        club || '',
    armedTs:     Date.now(),
    shotMode:    shotMode
  };
  if (typeof window._lrPersist === 'function') window._lrPersist();
}

/* Close the armed shot, writing a shot record to scores[curHole].shots[]. Returns the new record. */
function stCloseShot(endLngLat) {
  var lr = window.lrState;
  if (!lr || !lr._shotArmed) return null;
  if (!Array.isArray(endLngLat) || endLngLat.length < 2) return null;
  var armed = lr._shotArmed;

  /* Compute geometry-derived fields. */
  var distanceYds = 0;
  try { distanceYds = geomDistanceYds(armed.startLngLat, endLngLat); } catch (e) {}
  /* Lie auto-detect against the polygon set. */
  var rawLie = null;
  try {
    var geo = lr._mapInstance && (typeof lr._mapInstance.getGeometry === 'function'
      ? lr._mapInstance.getGeometry() : lr._mapInstance._geo);
    if (geo) rawLie = geomLieAtPoint(endLngLat, geo);
  } catch (e) {}
  var lie = _stMapLie(rawLie);

  var bearingIntended = 0, bearingActual = 0;
  try { bearingIntended = geomBearingDeg(armed.startLngLat, armed.aimLngLat); } catch (e) {}
  try { bearingActual   = geomBearingDeg(armed.startLngLat, endLngLat);       } catch (e) {}
  var disp = _stDecompose(armed.startLngLat, endLngLat, armed.aimLngLat);

  /* Distance from end to green centre (yards). */
  var distanceToHole = null;
  var gc = _stGreenCenter();
  if (gc) {
    try { distanceToHole = geomDistanceYds(endLngLat, gc); } catch (e) {}
  }

  /* Build shot record matching existing schema. NEW field gps_flight (object),
     coexisting with the existing flight_path string enum (left null here). */
  var rec = {
    clubId:          armed.club || '',
    shot_mode:       armed.shotMode || 'standard',
    lie:             lie,
    radial_ring:     null,
    radial_segment:  null,
    flight_path:     null,                 /* existing string-enum field; user may set via UI */
    gps_flight: {                          /* LR-EXTRAS NEW: GPS-derived geometry */
      startLngLat:     armed.startLngLat,
      endLngLat:       endLngLat,
      aimLngLat:       armed.aimLngLat,
      distanceYds:     distanceYds,
      dispersionLong:  disp.dispLong,
      dispersionLat:   disp.dispLat,
      bearingIntended: +bearingIntended.toFixed(1),
      bearingActual:   +bearingActual.toFixed(1)
    },
    distanceToHole:  distanceToHole,
    is_ob:           false,
    penalty_strokes: 0,
    timestamp:       new Date().toISOString(),
    entryType:       'live'
  };

  /* Push to current player's hole shots[]. */
  var s = lr.players[lr.curPlayer].scores[lr.curHole];
  if (!Array.isArray(s.shots)) s.shots = [];
  s.shots.push(rec);

  lr._shotArmed = null;
  if (typeof window._lrPersist === 'function') window._lrPersist();
  return rec;
}

function stCancel() {
  var lr = window.lrState;
  if (!lr) return;
  if (lr._shotArmed) {
    lr._shotArmed = null;
    if (typeof window._lrPersist === 'function') window._lrPersist();
  }
}

function stApplyPenalty(strokes, isOb) {
  var lr = window.lrState;
  if (!lr) return;
  var last = _stLastShot();
  if (!last) return;
  last.penalty_strokes = Math.max(0, +strokes || 0);
  last.is_ob = !!isOb;
  if (typeof window._lrPersist === 'function') window._lrPersist();
}

function stOverrideLie(newLie) {
  var lr = window.lrState;
  if (!lr) return;
  var last = _stLastShot();
  if (!last) return;
  /* Defensive: only accept picker-recognised values. */
  if (ST_PICKER_LIES.indexOf(newLie) < 0) return;
  last.lie = newLie;
  if (typeof window._lrPersist === 'function') window._lrPersist();
}

/* Putt logging delegates to the existing live-round handler so storage shape
   stays canonical (s.chip_putt_count, propagated to s.putts on hole completion). */
function stLogPutt(delta) {
  if (typeof window.lrAdjChipPutt === 'function') window.lrAdjChipPutt(delta);
}

function stIsArmed() {
  return !!(window.lrState && window.lrState._shotArmed);
}

function stGetActive() {
  return (window.lrState && window.lrState._shotArmed) ? window.lrState._shotArmed : null;
}

/* Alias retained for handoff naming clarity; lrGoHole already calls stCancel via the hook. */
function stCancelOnHoleChange() { stCancel(); }

Object.assign(window, {
  stArmShot, stCloseShot, stCancel, stApplyPenalty, stOverrideLie,
  stLogPutt, stIsArmed, stGetActive, stCancelOnHoleChange
});
