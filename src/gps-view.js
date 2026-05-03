/* gps-view.js — Live Round GPS view (additive).
   Loaded as an ES module after live-round.js, mapview.js, geomap.js, shot-tracker.js.
   No new persistence: all state lives on window.lrState (managed by live-round.js).
   localStorage keys used: 'gordy:compass' (iOS DeviceOrientation permission cache).

   This module renders inside the existing #gpsViewScreen div (defined in index.html).
   The minimap is pure SVG drawn from lrState._mapInstance's geometry.

   NOTE on map modes: The handoff specifies a satellite/no-map toggle. This iteration
   always renders the SVG minimap inside #gpsMapWrap (no MapLibre tear-down on entry).
   The toggle is wired to flip lrState._mapInstance.setStyleMode() which takes effect
   when the user returns to the live-round map screen. A future iteration could move
   the live MapLibre instance into #gpsMapWrap; that requires reparenting work in
   MapView.mount and is out of scope here.
*/

import { geomDistanceYds, geomBearingDeg, geomLieAtPoint, geomPointInPolygon,
         geomStartGpsWatch, geomStopGpsWatch } from './geomap.js';

/* Hazard classification table — extensible. Add a row here to surface a new
   hazard type in the GPS view's "in play" list. No other code change needed. */
var GPS_HAZARDS = {
  bunker:                { label: 'Bunker', icon: '\u26F1', color: '#d4a017' },
  water:                 { label: 'Water',  icon: '\uD83D\uDCA7', color: '#3b82f6' },
  lateral_water_hazard:  { label: 'Water',  icon: '\uD83D\uDCA7', color: '#3b82f6' },
  water_hazard:          { label: 'Water',  icon: '\uD83D\uDCA7', color: '#3b82f6' },  /* LR-EXTRAS: CDN schema name */
  woods:                 { label: 'Woods',  icon: '\uD83C\uDF32', color: '#3b6d11' }
};

/* Geometry data-access helpers (shape: {holes:{key:{ref,tee,green,line,bounds}}, polygons:FC}). */
function _gvGetGeo() {
  var lr = window.lrState;
  if (!lr || !lr._mapInstance) return null;
  return (typeof lr._mapInstance.getGeometry === 'function')
    ? lr._mapInstance.getGeometry()
    : (lr._mapInstance._geo || null);
}
function _gvHoleEntry(geo) {
  var lr = window.lrState;
  if (!geo || !geo.holes || !lr) return null;
  var want = String(lr.curHole + 1);
  for (var key in geo.holes) {
    if (String(geo.holes[key].ref) === want) return geo.holes[key];
  }
  return null;
}
function _gvPolyCentroid(f) {
  if (!f || !f.geometry || f.geometry.type !== 'Polygon') return null;
  var ring = f.geometry.coordinates[0];
  if (!ring || !ring.length) return null;
  var sx = 0, sy = 0, n = 0;
  for (var i = 0; i < ring.length; i++) { sx += ring[i][0]; sy += ring[i][1]; n++; }
  return n ? [sx / n, sy / n] : null;
}
/* Find the green polygon closest to the hole's anchor green coord. */
function _gvHoleGreenPoly(geo, holeEntry) {
  if (!geo || !geo.polygons || !geo.polygons.features) return null;
  var greens = geo.polygons.features.filter(function(f){ return f && f.properties && f.properties.golf === 'green'; });
  if (!greens.length) return null;
  var anchor = holeEntry && Array.isArray(holeEntry.green) ? holeEntry.green : null;
  if (!anchor) return greens[0];
  var best = null, bestD = Infinity;
  for (var i = 0; i < greens.length; i++) {
    var c = _gvPolyCentroid(greens[i]);
    if (!c) continue;
    var dx = c[0] - anchor[0], dy = c[1] - anchor[1];
    var d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = greens[i]; }
  }
  return best || greens[0];
}

/* Module-local state (not persisted; rebuilt on open). */
var _gpsWatchId    = null;
var _gpsLast       = null;     /* [lon,lat,acc] from latest tick */
var _gpsLastTickTs = 0;        /* ms epoch */
var _gpsLostFlag   = false;
var _renderTimer   = null;
var _lastRenderLL  = null;     /* [lon,lat] at last full render — for movement throttle */
var _lastHeading   = null;     /* compass deg, last applied */
var _puttMode      = false;    /* on-green prompt accepted; show putt bar */
var _onGreenPromptShown = false; /* once-per-hole guard */
/* LR-EXTRAS: compass chevron + aim-callback wrap (restored from earlier round). */
var _gvOriginalAimCb = null;   /* pristine MapView.onAimChange to restore on close */
/* LR-EXTRAS: GPS-tick wrap. Without this, gps-view's _gpsLast goes stale because
   MapView owns the GPS watch and gps-view never receives ticks unless it wraps. */
var _gvOriginalGpsTickCb = null;
/* LR-EXTRAS: map-click wrap. Used to detect LANDING taps when a shot is armed
   (aim is locked, so onAimChange does not fire — the click surfaces here only). */
var _gvOriginalMapClickCb = null;
/* LR-EXTRAS: transient toast guard so the same tap that arms a shot does not
   immediately also land it (onAimChange and onMapClick both fire on a single
   unlocked tap; we record arm timestamp and reject landing within 250ms). */
var _gvJustArmedTs = 0;
var _gvChevronInjected = false; /* did we attach our SVG to _userMarker.getElement() */
var _holeNAtPrompt = -1;

/* ─────────────────────────────────────────────────────────
   LR-EXTRAS: lightweight toast for shot-tracker feedback
   ─────────────────────────────────────────────────────────
   Stacks at top of #gpsViewScreen (just below the banner area).
   Auto-dismiss in 3s; tap to dismiss early. New toasts append to the stack
   so rapid arm->land sequences don't clobber each other visually.
   No external CSS; inline styles only so this works without index.html edits. */
function _gvEnsureToastHost() {
  var host = document.getElementById('gpsToastHost');
  if (host) return host;
  var screen = document.getElementById('gpsViewScreen');
  if (!screen) return null;
  host = document.createElement('div');
  host.id = 'gpsToastHost';
  host.style.cssText = 'position:absolute;top:60px;left:0;right:0;z-index:200;'
    + 'display:flex;flex-direction:column;align-items:center;gap:6px;'
    + 'pointer-events:none;padding:0 12px';
  screen.appendChild(host);
  return host;
}
function _gvShowToast(msg, kind) {
  var host = _gvEnsureToastHost();
  if (!host) return;
  var bg = '#111', fg = '#fff', border = '#333';
  if (kind === 'success') { bg = '#0f3a1f'; fg = '#d4fce0'; border = '#22c55e'; }
  else if (kind === 'error') { bg = '#3a0f0f'; fg = '#fcd4d4'; border = '#ef4444'; }
  else if (kind === 'info')  { bg = '#0f1f3a'; fg = '#d4e4fc'; border = '#3b82f6'; }
  var t = document.createElement('div');
  t.style.cssText = 'pointer-events:auto;background:' + bg + ';color:' + fg + ';'
    + 'border:1px solid ' + border + ';border-radius:8px;'
    + 'padding:8px 14px;font-size:.75rem;font-weight:600;'
    + 'box-shadow:0 4px 12px rgba(0,0,0,.5);'
    + 'max-width:90%;text-align:center;'
    + 'opacity:0;transform:translateY(-6px);'
    + 'transition:opacity .18s ease, transform .18s ease;cursor:pointer';
  t.textContent = msg;
  var dismiss = function() {
    if (!t.parentNode) return;
    t.style.opacity = '0';
    t.style.transform = 'translateY(-6px)';
    setTimeout(function() {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 200);
  };
  t.addEventListener('click', dismiss);
  host.appendChild(t);
  /* Force reflow then animate in. */
  // eslint-disable-next-line no-unused-expressions
  void t.offsetHeight;
  t.style.opacity = '1';
  t.style.transform = 'translateY(0)';
  setTimeout(dismiss, 3000);
}

/* ─────────────────────────────────────────────────────────
   Open / close / toggle
   ───────────────────────────────────────────────────────── */

function gpsViewOpen() {
  var lr = window.lrState;
  if (!lr) return;
  /* Cancel any armed shot from a prior session is NOT desired — leave armed. */
  lr._gpsViewOpen = true;
  if (typeof window._lrPersist === 'function') window._lrPersist();
  /* No id-stash needed: the GPS canvas has its own id ('gpsMapCanvas'); MapView's
     _containerId is repointed in _renderMinimap before mount so the same MapView
     instance attaches to our container. The live #lrMapCanvas (if any) is left
     intact and will be reattached on gpsViewClose. */
  var live = document.getElementById('lrHoleScreen');
  if (live) live.style.display = 'none';
  var screen = document.getElementById('gpsViewScreen');
  if (screen) screen.style.display = 'flex';
  /* iOS compass permission (one-shot, cached). */
  _gpsViewMaybeRequestCompass();
  /* PHASE-B1: If tracker was on at last persist (e.g. user refreshed page mid-round
     while shot logging was active), restart GPS via MapView so chevron + aim line
     come back. Without this the user would tap "Map" and see a tracker-on banner
     but no user marker — confusing. _trackerOn implies _gpsOn must be true. */
  if (lr._trackerOn && !lr._gpsOn && lr._mapInstance
      && typeof lr._mapInstance.startGps === 'function') {
    try { lr._mapInstance.startGps(); lr._gpsOn = true; } catch(e) {}
  }
  /* PHASE-B5: Bug fix — only start the gps-view fallback watch when GPS is ON
     and MapView can't take it. Was: !lr._gpsOn || !lr._mapInstance which started
     the watch when GPS was OFF, making GPS impossible to actually disable. */
  if (lr._gpsOn && !lr._mapInstance) {
    if (_gpsWatchId == null) {
      _gpsWatchId = geomStartGpsWatch(_gpsViewOnTick, _gpsViewOnGpsError);
    }
  } else if (lr._gpsOn) {
    /* MapView is already watching. Read its last fix if present. */
    if (lr._mapInstance && Array.isArray(lr._mapInstance._userLonLat)) {
      _gpsLast = [lr._mapInstance._userLonLat[0], lr._mapInstance._userLonLat[1], 0];
      _gpsLastTickTs = Date.now();
    }
  }
  _puttMode = false;
  _onGreenPromptShown = false;
  _holeNAtPrompt = -1;
  /* LR-EXTRAS: wrap MapView's onAimChange so taps in tracker mode arm shots.
     The original callback (persists lrState._mapAim) is preserved and called first.
     IMPORTANT: this wrap handles ARMING ONLY. Landing is handled by the
     onMapClick wrap below — when a shot is armed the aim is LOCKED, so a
     second tap does not fire onAimChange (it surfaces via onMapClick instead). */
  if (lr._mapInstance && _gvOriginalAimCb === null) {
    _gvOriginalAimCb = lr._mapInstance._onAimChange || null;
    lr._mapInstance._onAimChange = function(lngLat) {
      if (_gvOriginalAimCb) { try { _gvOriginalAimCb(lngLat); } catch(e) {} }
      /* Tracker behaviour: only if explicitly enabled. */
      if (!lr._trackerOn) return;
      /* If somehow already armed (shouldn't happen because aim is locked once
         armed), do nothing — landing is the onMapClick wrap's job. */
      var armedAlready = (typeof window.stIsArmed === 'function') ? window.stIsArmed() : false;
      if (armedAlready) return;
      /* Arm: clear any prior dispersion overlay first so the user sees a fresh state. */
      if (lr._mapInstance && typeof lr._mapInstance.clearDispersionLines === 'function') {
        try { lr._mapInstance.clearDispersionLines(); } catch(e) {}
      }
      var current = _gpsLast ? [_gpsLast[0], _gpsLast[1]] : null;
      if (typeof window.stArmShot === 'function') {
        try { window.stArmShot(lngLat, '', current); } catch(e) {}
      }
      /* Inspect armed state to determine success and produce feedback. */
      var armedNow = (typeof window.stGetActive === 'function') ? window.stGetActive() : null;
      if (armedNow) {
        _gvJustArmedTs = Date.now();
        /* Lock the aim and pin the line start to the armed start so the visuals
           freeze at the moment of arming (no GPS jitter on the line). */
        if (lr._mapInstance) {
          if (typeof lr._mapInstance.setAimLocked === 'function') {
            try { lr._mapInstance.setAimLocked(true); } catch(e) {}
          }
          if (typeof lr._mapInstance.setLineStartOverride === 'function') {
            try { lr._mapInstance.setLineStartOverride(armedNow.startLngLat); } catch(e) {}
          }
        }
        /* Compute shot number for the toast. */
        var s = lr.players[lr.curPlayer].scores[lr.curHole];
        var n = (s && Array.isArray(s.shots)) ? (s.shots.length + 1) : 1;
        _gvShowToast('Shot ' + n + ' armed \u2192 tap landing', 'info');
      } else {
        _gvShowToast("Can't arm shot \u2014 no GPS or tee position yet", 'error');
      }
      if (typeof gpsViewRender === 'function') gpsViewRender();
    };
  }

  /* LR-EXTRAS: wrap MapView's onGpsTick so gps-view's _gpsLast stays fresh as
     the user walks. Without this, _gpsLast is seeded once at gpsViewOpen and
     never updated (MapView owns the watch; its tick goes only to its own
     consumer callback). Symptom: hazards/yardages frozen until toggle-cycle. */
  if (lr._mapInstance && _gvOriginalGpsTickCb === null) {
    _gvOriginalGpsTickCb = lr._mapInstance._onGpsTick || null;
    lr._mapInstance._onGpsTick = function(ll) {
      if (_gvOriginalGpsTickCb) { try { _gvOriginalGpsTickCb(ll); } catch(e) {} }
      if (Array.isArray(ll) && ll.length >= 2) {
        var prevWasNull = !_gpsLast;
        _gpsLast = [ll[0], ll[1], 0];
        _gpsLastTickTs = Date.now();
        /* If we just got our first fix, render immediately so hazards/yards
           appear without waiting for the next throttled cycle. Otherwise let
           the movement-aware schedule handle it. */
        if (prevWasNull) {
          if (typeof gpsViewRender === 'function') gpsViewRender();
        } else {
          _gpsViewScheduleRender(false);
        }
      }
    };
  }

  /* LR-EXTRAS: wrap MapView's onMapClick to handle LANDING taps when aim is
     locked (a shot is armed). The aim-locked branch in MapView._handleMapClick
     fires only this callback — onAimChange is suppressed — so this is the sole
     entry point for landing detection. */
  if (lr._mapInstance && _gvOriginalMapClickCb === null) {
    _gvOriginalMapClickCb = lr._mapInstance._onMapClick || null;
    lr._mapInstance._onMapClick = function(e) {
      if (_gvOriginalMapClickCb) { try { _gvOriginalMapClickCb(e); } catch(err) {} }
      if (!lr._trackerOn) return;
      var armed = (typeof window.stGetActive === 'function') ? window.stGetActive() : null;
      if (!armed) return;
      /* Reject the same physical tap that just armed the shot (onAimChange and
         onMapClick both fire on a single unlocked click; we only want LANDING
         to fire on the NEXT tap). 250ms guard window. */
      if (Date.now() - _gvJustArmedTs < 250) return;
      var lngLat = e && e.lngLat ? [e.lngLat.lng, e.lngLat.lat] : null;
      if (!lngLat) return;
      var rec = null;
      if (typeof window.stCloseShot === 'function') {
        try { rec = window.stCloseShot(lngLat); } catch(err) {}
      }
      /* Release the lock + line override regardless of whether stCloseShot
         succeeded — leaving the aim locked with no shot armed would be wedged. */
      if (lr._mapInstance) {
        if (typeof lr._mapInstance.setAimLocked === 'function') {
          try { lr._mapInstance.setAimLocked(false); } catch(err) {}
        }
        if (typeof lr._mapInstance.setLineStartOverride === 'function') {
          try { lr._mapInstance.setLineStartOverride(null); } catch(err) {}
        }
      }
      if (rec && rec.gps_flight) {
        /* Draw dispersion: intended (start->aim) green, actual (start->end) red.
           Stays visible until the next shot is armed (or hole change / cancel). */
        if (lr._mapInstance && typeof lr._mapInstance.setDispersionLines === 'function') {
          try {
            lr._mapInstance.setDispersionLines({
              startLL: rec.gps_flight.startLngLat,
              aimLL:   rec.gps_flight.aimLngLat,
              endLL:   rec.gps_flight.endLngLat
            });
          } catch(err) {}
        }
        /* Toast: distance + lie + dispersion direction. */
        var s2 = lr.players[lr.curPlayer].scores[lr.curHole];
        var n2 = (s2 && Array.isArray(s2.shots)) ? s2.shots.length : 1;
        var dispLat = rec.gps_flight.dispersionLat || 0;
        /* PHASE-B3: long/short component. dispLong = projected distance from start
           along aim direction. aimDist = total distance start->aim. vsAim positive
           = long of aim, negative = short. */
        var dispLong = rec.gps_flight.dispersionLong || 0;
        var aimDist = 0;
        try {
          if (typeof window.geomDistanceYds === 'function'
              && Array.isArray(rec.gps_flight.startLngLat)
              && Array.isArray(rec.gps_flight.aimLngLat)) {
            aimDist = window.geomDistanceYds(rec.gps_flight.startLngLat, rec.gps_flight.aimLngLat);
          }
        } catch(err) {}
        var vsAim = dispLong - aimDist;
        var dispParts = [];
        if (Math.abs(vsAim)   >= 1) dispParts.push(Math.round(Math.abs(vsAim))   + 'y ' + (vsAim   > 0 ? 'long'  : 'short'));
        if (Math.abs(dispLat) >= 1) dispParts.push(Math.round(Math.abs(dispLat)) + 'y ' + (dispLat > 0 ? 'right' : 'left'));
        var dispDir = dispParts.length ? ' \u00B7 ' + dispParts.join(', ') + ' of aim' : '';
        _gvShowToast(
          'Shot ' + n2 + ': ' + Math.round(rec.gps_flight.distanceYds) + 'y to ' + (rec.lie || 'unknown') + dispDir,
          'success'
        );
      } else {
        _gvShowToast('Shot logged', 'info');
      }
      /* PHASE-B3: Auto-engage putt mode when ball lands on green. Mirrors the
         GPS-geofence path (_maybePromptOnGreen) but triggered by lie tagging,
         which works for map-tracked shots regardless of where the phone is.
         Once on, gpsPuttBar shows; user adds putts; existing on_green flow
         (lrCompleteHole when shot_mode==='on_green') handles hole completion. */
      if (rec && rec.lie === 'green' && !_puttMode) {
        _puttMode = true;
      }
      if (typeof gpsViewRender === 'function') gpsViewRender();
      /* PHASE-B2: Refresh line baseline so next shot's strategic line starts
         from this shot's endLngLat. */
      _gvRefreshLineStart();
    };
  }
  /* Wire compass listener */
  window.addEventListener('deviceorientation', _gpsViewOnHeading, true);
  /* PHASE-B4: Force MapLibre to recompute projection. While #gpsViewScreen is
     display:none the map's container has 0x0 size; on reveal MapLibre still
     thinks it's that size until resize() is called. Stale projection is the
     root cause of: aim reticle offset, click->lngLat returning wrong coords
     (which made lie detection appear to misfire on correctly-tapped polygons).
     Microtask delay lets CSS layout settle after display:flex. */
  setTimeout(function() {
    if (lr._mapInstance && lr._mapInstance._map
        && typeof lr._mapInstance._map.resize === 'function') {
      try { lr._mapInstance._map.resize(); } catch(e) {}
    }
  }, 50);
  /* PHASE-B3: Set line baseline from last shot endLngLat (or null = tee fallback). */
  _gvRefreshLineStart();
  /* Start render loop */
  _gpsViewScheduleRender(true);
}

/* PHASE-B2: Resolve the strategic line baseline. Per spec: distance/line should
   start from where the BALL is (last shot's endLngLat), not from the phone's GPS
   position. For shot 1, tee is the baseline. MapView already falls back to tee
   for shot 1 via its existing _teeOverride logic; we only need to override when
   shot 2+ exists. */
function _gvRefreshLineStart() {
  var lr = window.lrState;
  if (!lr || !lr._mapInstance) return;
  if (typeof lr._mapInstance.setLineStartOverride !== 'function') return;
  var s = lr.players[lr.curPlayer].scores[lr.curHole];
  var shots = (s && Array.isArray(s.shots)) ? s.shots : [];
  /* Last shot's endLngLat = baseline for next shot's strategic line.
     If no shots yet, clear override -> MapView falls back to tee. */
  var baseline = null;
  for (var i = shots.length - 1; i >= 0; i--) {
    var sh = shots[i];
    if (sh && sh.gps_flight && Array.isArray(sh.gps_flight.endLngLat)) {
      baseline = sh.gps_flight.endLngLat;
      break;
    }
  }
  try { lr._mapInstance.setLineStartOverride(baseline); } catch(e) {}
}

function gpsViewClose() {
  var lr = window.lrState;
  if (lr) {
    lr._gpsViewOpen = false;
    if (typeof window._lrPersist === 'function') window._lrPersist();
  }
  var screen = document.getElementById('gpsViewScreen');
  if (screen) screen.style.display = 'none';
  var live = document.getElementById('lrHoleScreen');
  if (live) live.style.display = 'flex';
  if (_gpsWatchId != null) {
    geomStopGpsWatch(_gpsWatchId);
    _gpsWatchId = null;
  }
  if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
  window.removeEventListener('deviceorientation', _gpsViewOnHeading, true);
  /* LR-EXTRAS: restore MapView's pristine onAimChange callback. */
  if (lr && lr._mapInstance && _gvOriginalAimCb !== null) {
    lr._mapInstance._onAimChange = _gvOriginalAimCb;
    _gvOriginalAimCb = null;
  }
  /* LR-EXTRAS: restore the GPS-tick + map-click wraps too. Reset to null
     unconditionally so a subsequent gpsViewOpen re-installs cleanly. */
  if (lr && lr._mapInstance && _gvOriginalGpsTickCb !== null) {
    lr._mapInstance._onGpsTick = _gvOriginalGpsTickCb;
  }
  _gvOriginalGpsTickCb = null;
  if (lr && lr._mapInstance && _gvOriginalMapClickCb !== null) {
    lr._mapInstance._onMapClick = _gvOriginalMapClickCb;
  }
  _gvOriginalMapClickCb = null;
  _gvJustArmedTs = 0;
  /* Strip the toast host so it doesn't stack between sessions. */
  var th = document.getElementById('gpsToastHost');
  if (th && th.parentNode) { try { th.parentNode.removeChild(th); } catch(e) {} }
  /* PHASE-A: do NOT strip the canvas, do NOT reset _gvCanvasInjected, do NOT
     repoint _containerId. The MapLibre map stays mounted in #gpsMapCanvas across
     screen toggles. The chevron is re-attached lazily by _ensureCompassChevron on
     next render, so leaving _gvChevronInjected as-is is fine; we reset it only on
     a hard rebuild (round end / course re-pick), not on screen toggle.
     Original (deleted) cleanup preserved as comment:
  // var wrap = document.getElementById('gpsMapWrap');
  // if (wrap) wrap.innerHTML = '';
  // _gvResetCanvasState();
  // if (lr && lr._mapInstance) {
  //   lr._mapInstance._containerId = 'lrMapCanvas';
  // }
  */
  /* Refresh live-round screen so banner / classic scoring reflect current state. */
  if (typeof window.lrRenderHole === 'function') window.lrRenderHole();
}

function gpsViewToggle() {
  var lr = window.lrState;
  if (!lr) return;
  if (lr._gpsViewOpen) gpsViewClose(); else gpsViewOpen();
}

/* ─────────────────────────────────────────────────────────
   GPS tick + heading
   ───────────────────────────────────────────────────────── */

function _gpsViewOnTick(t) {
  if (!t) return;
  _gpsLast = t;
  _gpsLastTickTs = Date.now();
  if (_gpsLostFlag) {
    _gpsLostFlag = false;
    /* full re-render to clear "GPS lost" state */
    gpsViewRender();
    return;
  }
  /* Movement-aware throttle: full render if moved >3yds since last render. */
  if (_lastRenderLL && _gpsLast) {
    try {
      var moved = geomDistanceYds(_lastRenderLL, [_gpsLast[0], _gpsLast[1]]);
      if (moved > 3) {
        _gpsViewScheduleRender(true);
        return;
      }
    } catch (e) {}
  }
  _gpsViewScheduleRender(false);
}

function _gpsViewOnGpsError(/*err*/) {
  _gpsLostFlag = true;
  gpsViewRender();
}

function _gpsViewOnHeading(ev) {
  if (!ev) return;
  /* iOS provides webkitCompassHeading; others use alpha. */
  var deg = (typeof ev.webkitCompassHeading === 'number')
    ? ev.webkitCompassHeading
    : (typeof ev.alpha === 'number' ? (360 - ev.alpha) : null);
  if (deg == null || isNaN(deg)) return;
  if (_lastHeading != null && Math.abs(deg - _lastHeading) < 5) return;
  _lastHeading = deg;
  /* Only the chevron needs updating; cheap CSS rotate via DOM lookup. */
  var chev = document.getElementById('gpsPlayerChevron');
  if (chev) chev.setAttribute('transform', 'rotate(' + deg.toFixed(1) + ')');
}

function _gpsViewMaybeRequestCompass() {
  var cached = localStorage.getItem('gordy:compass');
  if (cached === 'granted' || cached === 'denied') return;
  /* iOS 13+ requires explicit permission. */
  if (typeof DeviceOrientationEvent !== 'undefined'
      && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(function(state){
      localStorage.setItem('gordy:compass', state === 'granted' ? 'granted' : 'denied');
    }).catch(function(){
      localStorage.setItem('gordy:compass', 'denied');
    });
  }
  /* Non-iOS: leave unset; events will arrive without permission. */
}

/* ─────────────────────────────────────────────────────────
   Render scheduling (3s moving / 10s stationary; skip if hidden)
   ───────────────────────────────────────────────────────── */

function _gpsViewScheduleRender(immediate) {
  if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
  if (immediate) { gpsViewRender(); return; }
  var delay = _gpsLast ? 3000 : 10000;
  _renderTimer = setTimeout(function(){
    _renderTimer = null;
    gpsViewRender();
  }, delay);
}

/* ─────────────────────────────────────────────────────────
   Banner / map / yards / hazards / shot-chip / putt-bar render
   ───────────────────────────────────────────────────────── */

function gpsViewRender() {
  var lr = window.lrState;
  if (!lr || !lr._gpsViewOpen) return;
  if (document.hidden) return;
  /* GPS-loss heuristic: position older than 30s = lost. */
  if (_gpsLast && _gpsLastTickTs && (Date.now() - _gpsLastTickTs) > 30000) {
    _gpsLostFlag = true;
  }
  _renderBanner();
  _renderModeBanner();        /* PHASE-B1: persistent armed/idle prompt above map */
  _renderMinimap();
  _ensureCompassChevron();   /* LR-EXTRAS: attach rotating chevron to MapView's user marker */
  _renderYards();
  _renderHazards();
  _renderShotChip();
  _renderPuttBar();
  _maybePromptOnGreen();
  if (_gpsLast) _lastRenderLL = [_gpsLast[0], _gpsLast[1]];
}

/* Append a rotating SVG chevron to MapView's user-marker DOM. Runs each render
   tick; cheap (early-out once attached). When the marker is recreated by MapView
   (which happens once on first GPS fix and then never; subsequent ticks just
   call setLngLat), we re-inject. */
function _ensureCompassChevron() {
  var lr = window.lrState;
  if (!lr || !lr._mapInstance || !lr._mapInstance._userMarker) return;
  var markerEl = null;
  try { markerEl = lr._mapInstance._userMarker.getElement(); } catch(e) { return; }
  if (!markerEl) return;
  /* If our chevron is still a child, just re-apply heading and exit. */
  var existing = markerEl.querySelector('#gpsPlayerChevron');
  if (existing) {
    if (_lastHeading != null) {
      existing.setAttribute('transform', 'rotate(' + (_lastHeading).toFixed(1) + ')');
    }
    return;
  }
  /* Inject a small SVG overlay anchored at the marker centre. The chevron sits
     above the default MapLibre dot; its <g id="gpsPlayerChevron"> is what the
     existing _gpsViewOnHeading handler rotates. */
  var ns = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  svg.setAttribute('viewBox', '-14 -14 28 28');
  svg.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none;overflow:visible;';
  var g = document.createElementNS(ns, 'g');
  g.setAttribute('id', 'gpsPlayerChevron');
  if (_lastHeading != null) {
    g.setAttribute('transform', 'rotate(' + _lastHeading.toFixed(1) + ')');
  }
  var poly = document.createElementNS(ns, 'polygon');
  poly.setAttribute('points', '0,-12 5,3 -5,3');
  poly.setAttribute('fill', '#1e90ff');
  poly.setAttribute('stroke', '#fff');
  poly.setAttribute('stroke-width', '1.2');
  g.appendChild(poly);
  svg.appendChild(g);
  markerEl.style.position = markerEl.style.position || 'relative';
  markerEl.appendChild(svg);
  _gvChevronInjected = true;
}

/* _renderBanner -- now a thin wrapper around the shared builder in live-round.js.
   The banner markup lives in window.lrxBannerHtml(mode); window.lrxRenderBanner()
   stamps it into both #lrxBanner (live screen) and #gpsBanner (this screen). */
function _renderBanner() {
  /* Track GPS-lost flag in a window-scoped slot so the shared builder can read it. */
  window._gpsViewLostFlag = !!_gpsLostFlag;
  if (typeof window.lrxRenderBanner === 'function') window.lrxRenderBanner();
}

/* OLD _renderBanner -- preserved per "comment, don't delete" rule. Replaced by the shared builder.
// function _renderBanner_OLD() {
//   var lr = window.lrState;
//   var hole = lr.holes[lr.curHole];
//   var collapsedEl = document.getElementById('gpsTopBanner');
//   if (!collapsedEl) return;
//   var collapsed = collapsedEl.dataset.collapsed === 'true';
//   var ydsToGreen = _calcYardsToGreen();
//   var trackerOn  = !!lr._trackerOn;
//   var styleMode  = (lr._mapInstance && typeof lr._mapInstance.getStyleMode === 'function')
//     ? lr._mapInstance.getStyleMode() : 'satellite';
//   // ...rest of old inline-HTML banner (Hole N + Par + tracker btn etc.) elided; see git history.
// } */

function gpsViewToggleBanner() {
  var el = document.getElementById('gpsBanner');
  if (!el) return;
  el.dataset.collapsed = (el.dataset.collapsed === 'true') ? 'false' : 'true';
  _renderBanner();
}

function gpsViewToggleMapMode() {
  var lr = window.lrState;
  if (!lr || !lr._mapInstance) return;
  var cur = (typeof lr._mapInstance.getStyleMode === 'function')
    ? lr._mapInstance.getStyleMode() : 'satellite';
  lr._mapInstance.setStyleMode(cur === 'satellite' ? 'plain' : 'satellite');
  if (typeof window._lrPersist === 'function') window._lrPersist();
  _renderBanner();
}

/* PHASE-B2: Explicit GPS toggle. Independent of tracker.
   - ON: prompt + start GPS via MapView.
   - OFF: stop GPS, also disable tracker (tracker requires GPS) and cancel any armed shot.
   Differs from gpsViewTrackingToggle: this controls only _gpsOn; tracker controls
   _trackerOn + auto-enables _gpsOn on the way ON. */
function gpsViewGpsToggle() {
  var lr = window.lrState;
  if (!lr) return;
  var goingOn = !lr._gpsOn;
  if (goingOn) {
    if (!('geolocation' in navigator)) {
      _gvShowToast('GPS not available on this device', 'warn');
      return;
    }
    /* PHASE-B5: Flip state + render IMMEDIATELY so the user sees feedback on
       first tap. Then request permission. If denied, revert. Avoids the
       "have to tap twice" UX where async resolved before render. */
    lr._gpsOn = true;
    if (typeof window._lrPersist === 'function') window._lrPersist();
    gpsViewRender();
    navigator.geolocation.getCurrentPosition(
      function(/*pos*/) {
        if (lr._mapInstance && typeof lr._mapInstance.startGps === 'function') {
          try { lr._mapInstance.startGps(); } catch(e) {}
        } else if (_gpsWatchId == null) {
          _gpsWatchId = geomStartGpsWatch(_gpsViewOnTick, _gpsViewOnGpsError);
        }
        gpsViewRender();
      },
      function(/*err*/) {
        /* Permission denied — revert. */
        lr._gpsOn = false;
        if (typeof window._lrPersist === 'function') window._lrPersist();
        _gvShowToast('GPS permission denied', 'warn');
        gpsViewRender();
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
    return;
  }
  /* Turning OFF: stop BOTH watches (MapView's AND gps-view's own). */
  if (lr._trackerOn) {
    lr._trackerOn = false;
    if (typeof window.stCancel === 'function') window.stCancel();
    if (lr._mapInstance) {
      if (typeof lr._mapInstance.setAimLocked === 'function') {
        try { lr._mapInstance.setAimLocked(false); } catch(e) {}
      }
      if (typeof lr._mapInstance.clearDispersionLines === 'function') {
        try { lr._mapInstance.clearDispersionLines(); } catch(e) {}
      }
    }
  }
  if (lr._mapInstance && typeof lr._mapInstance.stopGps === 'function') {
    try { lr._mapInstance.stopGps(); } catch(e) {}
  }
  if (_gpsWatchId != null) {
    try { geomStopGpsWatch(_gpsWatchId); } catch(e) {}
    _gpsWatchId = null;
  }
  lr._gpsOn = false;
  if (typeof window._lrPersist === 'function') window._lrPersist();
  gpsViewRender();
}

/* PHASE-B1: Unified user-facing tracking toggle. Replaces the two-toggle confusion
   (_gpsOn dish button + _trackerOn banner button). One button, one mental model.
   - ON: ensure GPS is running (auto-prompt if first time), then enable shot tracker.
   - OFF: disable shot tracker only. GPS stays on so chevron + aim line remain.
   Cancels any armed shot when going OFF (matches old gpsViewToggleTracker behaviour). */
function gpsViewTrackingToggle() {
  var lr = window.lrState;
  if (!lr) return;
  var goingOn = !lr._trackerOn;
  if (goingOn) {
    if (!lr._gpsOn) {
      if (!('geolocation' in navigator)) {
        _gvShowToast('GPS not available on this device', 'warn');
        return;
      }
      /* PHASE-B5: Synchronous flip first, then async permission. */
      lr._gpsOn = true;
      lr._trackerOn = true;
      if (typeof window._lrPersist === 'function') window._lrPersist();
      gpsViewRender();
      navigator.geolocation.getCurrentPosition(
        function(/*pos*/) {
          if (lr._mapInstance && typeof lr._mapInstance.startGps === 'function') {
            try { lr._mapInstance.startGps(); } catch(e) {}
          } else if (_gpsWatchId == null) {
            _gpsWatchId = geomStartGpsWatch(_gpsViewOnTick, _gpsViewOnGpsError);
          }
          gpsViewRender();
        },
        function(/*err*/) {
          lr._gpsOn = false;
          lr._trackerOn = false;
          if (typeof window._lrPersist === 'function') window._lrPersist();
          _gvShowToast('GPS permission denied; tracker needs GPS', 'warn');
          gpsViewRender();
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
      return;
    }
    lr._trackerOn = true;
  } else {
    lr._trackerOn = false;
    /* Cancel any armed shot. Mirrors old gpsViewToggleTracker exactly. */
    if (typeof window.stCancel === 'function') window.stCancel();
    if (lr._mapInstance) {
      if (typeof lr._mapInstance.setAimLocked === 'function') {
        try { lr._mapInstance.setAimLocked(false); } catch(e) {}
      }
      if (typeof lr._mapInstance.setLineStartOverride === 'function') {
        try { lr._mapInstance.setLineStartOverride(null); } catch(e) {}
      }
      if (typeof lr._mapInstance.clearDispersionLines === 'function') {
        try { lr._mapInstance.clearDispersionLines(); } catch(e) {}
      }
    }
    /* GPS stays on per spec -- user keeps chevron + live distances. */
  }
  if (typeof window._lrPersist === 'function') window._lrPersist();
  gpsViewRender();
}

function gpsViewToggleTracker() {
  var lr = window.lrState;
  if (!lr) return;
  lr._trackerOn = !lr._trackerOn;
  /* Turning tracker off cancels any armed shot. */
  if (!lr._trackerOn && typeof window.stCancel === 'function') window.stCancel();
  /* LR-EXTRAS: also release MapView's per-shot UI state if tracker goes off
     mid-shot. Without this the marker would stay red and the line stay
     pinned to the abandoned start position. */
  if (!lr._trackerOn && lr._mapInstance) {
    if (typeof lr._mapInstance.setAimLocked === 'function') {
      try { lr._mapInstance.setAimLocked(false); } catch(e) {}
    }
    if (typeof lr._mapInstance.setLineStartOverride === 'function') {
      try { lr._mapInstance.setLineStartOverride(null); } catch(e) {}
    }
    if (typeof lr._mapInstance.clearDispersionLines === 'function') {
      try { lr._mapInstance.clearDispersionLines(); } catch(e) {}
    }
  }
  if (typeof window._lrPersist === 'function') window._lrPersist();
  gpsViewRender();
}

/* LR-EXTRAS: unified cancel handler. The Cancel button on the armed-shot chip
   calls this so the shot record is cleared AND MapView's overlay state
   (locked aim, pinned line start, dispersion lines) is reset in lockstep. */
function gpsViewCancelShot() {
  var lr = window.lrState;
  if (typeof window.stCancel === 'function') window.stCancel();
  if (lr && lr._mapInstance) {
    if (typeof lr._mapInstance.setAimLocked === 'function') {
      try { lr._mapInstance.setAimLocked(false); } catch(e) {}
    }
    if (typeof lr._mapInstance.setLineStartOverride === 'function') {
      try { lr._mapInstance.setLineStartOverride(null); } catch(e) {}
    }
    if (typeof lr._mapInstance.clearDispersionLines === 'function') {
      try { lr._mapInstance.clearDispersionLines(); } catch(e) {}
    }
  }
  _gvJustArmedTs = 0;
  gpsViewRender();
}

/* Yards-to-green accessor for the shared banner builder (lrxBannerHtml('gps-collapsed')). */
function lrxYardsToGreen() {
  return _calcYardsToGreen();
}

/* ─────────────────────────────────────────────────────────
   Map: reuse the existing MapView (option A — rebuild on screen change).
   Strategy: when GPS view is active, inject an #lrMapCanvas div into #gpsMapWrap
   plus the floating distance-bubble/pill divs the live screen uses. Then call
   _lrMapMount() — MapView.mount() detects the new container and rebuilds itself
   there (per its existing line-92 container-changed check). showHole() handles
   tee→green orientation, tee marker, aim marker, distance bubbles, polygons.
   No SVG, no projection math, no parallel implementation. */
var _gvCanvasInjected = false;
var _gvLastShownHole  = -1;

function _renderMinimap() {
  var lr = window.lrState;
  var wrap = document.getElementById('gpsMapWrap');
  if (!wrap) return;
  if (!lr || !lr._mapInstance && !window._lrMapMount) {
    /* No MapView wired up yet (e.g. course geometry never loaded). */
    wrap.innerHTML = '<div style="padding:20px;text-align:center;color:var(--tx3)">Loading course map…</div>';
    return;
  }
  /* First call after gpsViewOpen: stamp the canvas + floating UI ids. We use a
     unique id ('gpsMapCanvas') and repoint MapView's _containerId so the same
     MapView instance attaches here without colliding with the live screen's
     #lrMapCanvas, which may also exist in the DOM at the same time (lrRenderHole
     rebuilds it on hole change even while GPS view is the visible screen). */
  if (!_gvCanvasInjected || !document.getElementById('gpsMapCanvas')) {
    wrap.innerHTML =
        '<div id="lrAimDistBubble" style="position:absolute;z-index:30;'
      +   'background:#ff9d00;color:#111;border-radius:999px;padding:4px 10px;'
      +   'font-family:\'DM Mono\',monospace;font-size:.7rem;'
      +   'font-weight:700;pointer-events:none;transform:translate(-50%,-140%);'
      +   'box-shadow:0 2px 8px rgba(0,0,0,.45);display:none">&mdash;</div>'
      + '<div id="lrPlayerDistPill" style="position:absolute;left:10px;bottom:10px;z-index:25;'
      +   'background:#fff;color:#111;border-radius:999px;'
      +   'padding:5px 12px 5px 5px;font-family:\'DM Mono\',monospace;font-size:.66rem;'
      +   'font-weight:700;display:flex;align-items:center;gap:8px;'
      +   'box-shadow:0 2px 8px rgba(0,0,0,.45);pointer-events:none">'
      +   '<span style="background:#111;color:#fff;border-radius:999px;padding:3px 9px;font-size:.68rem">&mdash;</span>'
      +   '<span style="font-size:.56rem;color:#444">to aim</span>'
      + '</div>'
      + '<div id="gpsMapCanvas" style="position:absolute;inset:0;background:#111"></div>';
    _gvCanvasInjected = true;
    _gvLastShownHole  = -1;
    /* PHASE-A: _containerId repoint removed. _lrMapMount now binds MapView to
       'gpsMapCanvas' from the constructor; no repoint needed. MapView mounts once
       per round and stays mounted across screen toggles. */
    if (typeof window._lrMapMount === 'function') {
      try { window._lrMapMount(); } catch(e) { /* surfaced on next tick if it failed */ }
    }
  }
  /* Snap to current hole on first render and on hole changes. */
  var holeN = lr.curHole + 1;
  if (holeN !== _gvLastShownHole && lr._mapInstance && typeof lr._mapInstance.showHole === 'function') {
    try { lr._mapInstance.showHole(holeN); } catch(e) {}
    _gvLastShownHole = holeN;
    /* PHASE-B2: New hole = new line baseline (no shots yet -> tee). */
    _gvRefreshLineStart();
  }
}

/* gpsViewClose resets _gvCanvasInjected so the next gpsViewOpen rebuilds cleanly. */
function _gvResetCanvasState() {
  _gvCanvasInjected = false;
  _gvLastShownHole  = -1;
}

/* OLD _renderMinimap — preserved per "comment, don't delete" rule. ~200 lines of pure-SVG
   rendering replaced by reuse of the existing MapView (option A). Nested-safe via line prefixes.
// function _renderMinimap_OLD() {
//   var lr = window.lrState;
//   var wrap = document.getElementById('gpsMapWrap');
//   if (!wrap) return;
//   var geo = _gvGetGeo();
//   if (!geo || !geo.holes) {
//     wrap.innerHTML = 'No course geometry loaded.';
//     return;
//   }
//   // ...full SVG implementation elided; see git history for the projection/rotation/poly path.
// }
// function _featureCenter_OLD(f) { ... } */


/* ─────────────────────────────────────────────────────────
   Big yards display
   ───────────────────────────────────────────────────────── */

function _calcYardsToGreen() {
  /* PHASE-B5: Strategic distance starts from BALL position (where the last
     shot ended, or tee for shot 1), NOT from phone GPS. Phone is for the
     chevron and live walking distance, not strategy. GPS is a fallback only
     when no ball position can be derived. */
  var geo = _gvGetGeo();
  if (!geo) return null;
  var holeEntry = _gvHoleEntry(geo);
  if (!holeEntry || !Array.isArray(holeEntry.green)) return null;
  var fromPt = null;
  /* Priority 1: last shot's endLngLat. */
  var lr = window.lrState;
  if (lr && lr.players && lr.players[lr.curPlayer]) {
    var s = lr.players[lr.curPlayer].scores[lr.curHole];
    if (s && Array.isArray(s.shots) && s.shots.length) {
      for (var i = s.shots.length - 1; i >= 0; i--) {
        var sh = s.shots[i];
        if (sh && sh.gps_flight && Array.isArray(sh.gps_flight.endLngLat)) {
          fromPt = sh.gps_flight.endLngLat;
          break;
        }
      }
    }
  }
  /* Priority 2: tee. */
  if (!fromPt && Array.isArray(holeEntry.tee)) fromPt = holeEntry.tee;
  /* Priority 3: hole line start. */
  if (!fromPt && Array.isArray(holeEntry.line) && holeEntry.line.length) fromPt = holeEntry.line[0];
  /* Priority 4: phone GPS (last-resort fallback only). */
  if (!fromPt && _gpsLast) fromPt = [_gpsLast[0], _gpsLast[1]];
  if (!fromPt) return null;
  try { return geomDistanceYds(fromPt, holeEntry.green); } catch(e) { return null; }
}

function _renderYards() {
  var el = document.getElementById('gpsYards');
  if (!el) return;
  var y = _calcYardsToGreen();
  el.innerHTML = '<div style="text-align:center;padding:14px 8px">'
    + '<div style="font-family:\'DM Mono\',monospace;font-size:2.4rem;font-weight:700;color:var(--tx);line-height:1">'
    + (y != null ? y : '\u2014') + '</div>'
    + '<div style="font-size:.55rem;color:var(--tx3);letter-spacing:.12em;text-transform:uppercase;margin-top:2px">yds to green</div>'
    + '</div>';
}

/* ─────────────────────────────────────────────────────────
   Hazards in play
   ───────────────────────────────────────────────────────── */

/* LR-EXTRAS: corridor projection helper used by _renderHazards.
   Returns { inCorridor, lr } where lr is 'L'|'R'|'' relative to the start->end
   axis. Returns null for degenerate (zero-length) axes. */
function _gvCorridorCheck(startLL, endLL, hazardCentroid) {
  if (!startLL || !endLL || !hazardCentroid) return null;
  var lat0 = startLL[1] * Math.PI / 180;
  var R = 6371000, M_TO_YDS = 1.0936133;
  var ax = (endLL[0] - startLL[0]) * Math.PI / 180 * Math.cos(lat0) * R;
  var ay = (endLL[1] - startLL[1]) * Math.PI / 180 * R;
  var aLen = Math.sqrt(ax * ax + ay * ay);
  if (aLen < 1e-3) return null;
  var ux = ax / aLen, uy = ay / aLen;
  var rx = uy, ry = -ux;
  var hx = (hazardCentroid[0] - startLL[0]) * Math.PI / 180 * Math.cos(lat0) * R;
  var hy = (hazardCentroid[1] - startLL[1]) * Math.PI / 180 * R;
  var t = (hx * ux + hy * uy) / aLen;
  var perp = Math.abs(hx * rx + hy * ry);
  var perpYds = perp * M_TO_YDS;
  var inCorridor = (t >= 0 && t <= 1 && perpYds <= 60);
  var cross = ux * hy - uy * hx;
  var lr_label = cross > 0 ? 'L' : (cross < 0 ? 'R' : '');
  return { inCorridor: inCorridor, lr: lr_label };
}

function _renderHazards() {
  var el = document.getElementById('gpsHazards');
  if (!el) return;
  var lr = window.lrState;
  if (!lr || !lr._mapInstance) { el.innerHTML = ''; return; }
  var geo = _gvGetGeo();
  if (!geo || !geo.polygons || !geo.polygons.features) { el.innerHTML = ''; return; }
  var holeEntry = _gvHoleEntry(geo);
  /* PHASE-B5: Corridor 1 baseline = ball position (last shot end / tee), NOT
     phone GPS. Mirrors _calcYardsToGreen and _gvRefreshLineStart so the strategic
     line is consistent across UI. */
  var ballPt = null;
  if (lr.players && lr.players[lr.curPlayer]) {
    var sc = lr.players[lr.curPlayer].scores[lr.curHole];
    if (sc && Array.isArray(sc.shots) && sc.shots.length) {
      for (var bi = sc.shots.length - 1; bi >= 0; bi--) {
        var bsh = sc.shots[bi];
        if (bsh && bsh.gps_flight && Array.isArray(bsh.gps_flight.endLngLat)) {
          ballPt = bsh.gps_flight.endLngLat;
          break;
        }
      }
    }
  }
  if (!ballPt && holeEntry && Array.isArray(holeEntry.tee)) ballPt = holeEntry.tee;
  if (!ballPt && holeEntry && Array.isArray(holeEntry.line) && holeEntry.line.length) ballPt = holeEntry.line[0];
  if (!ballPt && _gpsLast) ballPt = [_gpsLast[0], _gpsLast[1]];
  var aim = (lr._mapAim && Array.isArray(lr._mapAim))
    ? lr._mapAim
    : (holeEntry && Array.isArray(holeEntry.green) ? holeEntry.green : null);
  var greenC = (holeEntry && Array.isArray(holeEntry.green)) ? holeEntry.green : null;
  if (!ballPt || !aim) { el.innerHTML = ''; return; }
  var allFeats = geo.polygons.features;
  /* PHASE-B5: build TWO row lists, one per corridor. Same hazard can appear in
     both if its centroid is in both corridors — informative, not duplication.
     Both corridors are ALWAYS evaluated; both columns ALWAYS render. */
  var rowsToAim = [];
  var rowsAimToGreen = [];
  for (var i = 0; i < allFeats.length; i++) {
    var f = allFeats[i];
    if (!f || !f.properties) continue;
    var typ = f.properties.golf;
    if (!GPS_HAZARDS[typ]) continue;
    var c = _gvPolyCentroid(f);
    if (!c) continue;
    /* Corridor 1: ball -> aim */
    var c1 = _gvCorridorCheck(ballPt, aim, c);
    if (c1 && c1.inCorridor) {
      var d1 = 0;
      try { d1 = geomDistanceYds(ballPt, c); } catch(e) {}
      rowsToAim.push({ typ: typ, dist: Math.round(d1), lr: c1.lr || '' });
    }
    /* Corridor 2: aim -> green */
    if (greenC) {
      var c2 = _gvCorridorCheck(aim, greenC, c);
      if (c2 && c2.inCorridor) {
        var d2 = 0;
        try { d2 = geomDistanceYds(aim, c); } catch(e) {}
        rowsAimToGreen.push({ typ: typ, dist: Math.round(d2), lr: c2.lr || '' });
      }
    }
  }
  rowsToAim.sort(function(a,b){ return a.dist - b.dist; });
  rowsAimToGreen.sort(function(a,b){ return a.dist - b.dist; });
  /* Cap each column at 4 rows. */
  var capped1 = rowsToAim.slice(0, 4);
  var capped2 = rowsAimToGreen.slice(0, 4);
  var renderRows = function(rows) {
    if (!rows.length) {
      return '<div style="font-size:.62rem;color:var(--tx3);padding:6px 0">None</div>';
    }
    return rows.map(function(rw) {
      var meta = GPS_HAZARDS[rw.typ];
      return '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--br);font-size:.65rem">'
        +   '<span style="color:' + meta.color + '">' + meta.icon + '</span>'
        +   '<span style="color:var(--tx);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + meta.label + '</span>'
        +   '<span style="font-family:\'DM Mono\',monospace;color:var(--tx2);flex:0 0 auto">'
        +     rw.dist + 'y' + (rw.lr ? ' ' + rw.lr : '')
        +   '</span>'
        + '</div>';
    }).join('');
  };
  /* PHASE-B5: Always render both columns. Empty column shows "None" rather
     than collapsing -- the structure must stay constant so the user always
     knows where to look. */
  var html = '<div style="padding:6px 12px;display:grid;grid-template-columns:1fr 1fr;gap:10px">'
    + '<div>'
    +   '<div style="font-size:.55rem;color:var(--tx3);letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px">To Aim</div>'
    +   renderRows(capped1)
    + '</div>'
    + '<div>'
    +   '<div style="font-size:.55rem;color:var(--tx3);letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px">Aim → Green</div>'
    +   renderRows(capped2)
    + '</div>'
    + '</div>';
  el.innerHTML = html;
}

/* ─────────────────────────────────────────────────────────
   Active shot chip + putt bar + on-green prompt
   ───────────────────────────────────────────────────────── */

/* PHASE-B1: Persistent mode banner. Three states:
   - tracker off: hidden entirely (no DOM impact)
   - tracker on, no shot armed: "Tap target to arm shot N"
   - tracker on, shot armed: "Tap landing for shot N"
   Replaces the easy-to-miss toast as the primary affordance for shot logging.
   Toasts still fire for confirmation events; this strip stays put across them. */
function _renderModeBanner() {
  var el = document.getElementById('gpsModeBanner');
  if (!el) return;
  var lr = window.lrState;
  if (!lr || !lr._trackerOn || _puttMode) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  var armed = (typeof window.stGetActive === 'function') ? window.stGetActive() : null;
  var s     = lr.players[lr.curPlayer].scores[lr.curHole];
  var n     = (s && Array.isArray(s.shots)) ? (s.shots.length + 1) : 1;
  var msg, bg;
  if (armed) {
    msg = '\uD83C\uDFAF Tap landing for Shot ' + n;
    bg  = 'linear-gradient(90deg, var(--ac2), var(--ac3))';
  } else {
    msg = '\uD83C\uDFAF Tap target to arm Shot ' + n;
    bg  = 'var(--sf)';
  }
  /* PHASE-B3: Club chip row -- shown only when shot is armed and no club set yet.
     Tap a chip to assign club to the armed shot. Reads bag from window.bag. */
  var clubChips = '';
  if (armed && !armed.club && window.bag && window.bag.length) {
    var chips = window.bag.map(function(c) {
      var label = c.name || c.id;
      return '<button class="btn sec" style="font-size:.62rem;padding:4px 10px;'
        + 'border-radius:14px;flex:0 0 auto" '
        + 'onclick="gpsViewSetArmedClub(\'' + (c.id || '').replace(/'/g, "\\'") + '\')">'
        + label + '</button>';
    }).join('');
    clubChips =
        '<div style="padding:6px 10px 8px;background:var(--bg);border-bottom:1px solid var(--br);'
      +   'display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch">'
      + chips + '</div>';
  }
  /* PHASE-B4: Lie quick-correct row -- shown after a shot lands (not armed) so user
     can correct auto-detected lie when polygon mapping is wrong. Tapping writes via
     stOverrideLie which mutates the most-recent shot in place. */
  var lieChips = '';
  if (!armed && s && Array.isArray(s.shots) && s.shots.length) {
    var last = s.shots[s.shots.length - 1];
    var lies = ['fairway','rough','sand','recovery','green','tee'];
    var lieRow = lies.map(function(L) {
      var active = last.lie === L;
      return '<button class="btn ' + (active ? 'pri' : 'sec') + '" '
        + 'style="font-size:.6rem;padding:3px 9px;border-radius:12px;flex:0 0 auto" '
        + 'onclick="gpsViewCorrectLie(\'' + L + '\')">' + L + '</button>';
    }).join('');
    lieChips =
        '<div style="padding:5px 10px 7px;background:var(--bg);border-bottom:1px solid var(--br);'
      +   'display:flex;gap:5px;align-items:center;overflow-x:auto;-webkit-overflow-scrolling:touch">'
      +   '<span style="font-size:.6rem;color:var(--tx3);flex:0 0 auto">Lie:</span>'
      + lieRow
      + '</div>';
  }
  /* PHASE-B4: Flight pattern chip row -- shown when armed AND club chosen.
     Persists onto rec.flight_path via stCloseShot reading lr._shotArmed.flight_path. */
  var flightChips = '';
  if (armed && armed.club) {
    var paths = ['straight','draw','fade','hook','slice','push','pull'];
    var cur = armed.flight_path || '';
    var pRow = paths.map(function(p) {
      var on = cur === p;
      return '<button class="btn ' + (on ? 'pri' : 'sec') + '" '
        + 'style="font-size:.6rem;padding:3px 9px;border-radius:12px;flex:0 0 auto" '
        + 'onclick="gpsViewSetArmedFlight(\'' + p + '\')">' + p + '</button>';
    }).join('');
    flightChips =
        '<div style="padding:5px 10px 7px;background:var(--bg);border-bottom:1px solid var(--br);'
      +   'display:flex;gap:5px;align-items:center;overflow-x:auto;-webkit-overflow-scrolling:touch">'
      +   '<span style="font-size:.6rem;color:var(--tx3);flex:0 0 auto">Shape:</span>'
      + pRow + '</div>';
  }
  /* PHASE-B4: Penalty prompt -- shown after a shot lands in hazard. */
  var penaltyChips = '';
  if (!armed && s && Array.isArray(s.shots) && s.shots.length) {
    var lst = s.shots[s.shots.length - 1];
    if (lst && (lst.lie === 'recovery' || lst.lie === 'sand') && !lst.penalty_strokes && !lst._penaltyDismissed) {
      penaltyChips =
          '<div style="padding:5px 10px 7px;background:var(--ac3);border-bottom:1px solid var(--br);'
        +   'display:flex;gap:5px;align-items:center">'
        +   '<span style="font-size:.62rem;color:var(--tx);font-weight:600;flex:0 0 auto">Penalty?</span>'
        +   '<button class="btn sec" style="font-size:.6rem;padding:3px 9px;border-radius:12px" onclick="gpsViewApplyPenalty(0)">No</button>'
        +   '<button class="btn sec" style="font-size:.6rem;padding:3px 9px;border-radius:12px" onclick="gpsViewApplyPenalty(1)">+1</button>'
        +   '<button class="btn sec" style="font-size:.6rem;padding:3px 9px;border-radius:12px" onclick="gpsViewApplyPenalty(2)">+2</button>'
        + '</div>';
    }
  }
  /* PHASE-B4: End-hole button -- always available when shots exist. */
  var endHole = '';
  if (s && Array.isArray(s.shots) && s.shots.length) {
    endHole =
        '<div style="padding:4px 10px;background:var(--bg);display:flex;justify-content:flex-end">'
      +   '<button class="btn sec" style="font-size:.6rem;padding:3px 12px;border-radius:12px" '
      +     'onclick="gpsViewEndHole()">End hole</button>'
      + '</div>';
  }
  el.style.display = '';
  el.innerHTML =
      '<div style="padding:6px 12px;background:' + bg + ';'
    +   'border-bottom:1px solid var(--br);font-size:.7rem;font-weight:600;'
    +   'color:var(--tx);text-align:center;letter-spacing:.02em">'
    +   msg + '</div>'
    + clubChips + flightChips + lieChips + penaltyChips + endHole;
}

/* PHASE-B4: Correct the auto-detected lie of the most-recent shot. */
function gpsViewCorrectLie(lie) {
  if (typeof window.stOverrideLie === 'function') window.stOverrideLie(lie);
  if (lie === 'green') _puttMode = true;
  gpsViewRender();
}

/* PHASE-B4: Set flight pattern on the armed shot. Lands in rec.flight_path on close. */
function gpsViewSetArmedFlight(p) {
  var lr = window.lrState;
  if (!lr || !lr._shotArmed) return;
  lr._shotArmed.flight_path = p || '';
  if (typeof window._lrPersist === 'function') window._lrPersist();
  gpsViewRender();
}

/* PHASE-B4: Apply (or dismiss) penalty on the most-recent shot. 0 = dismiss prompt. */
function gpsViewApplyPenalty(strokes) {
  var lr = window.lrState;
  if (!lr) return;
  var s = lr.players[lr.curPlayer].scores[lr.curHole];
  if (!s || !Array.isArray(s.shots) || !s.shots.length) return;
  var last = s.shots[s.shots.length - 1];
  if (strokes > 0) {
    if (typeof window.stApplyPenalty === 'function') window.stApplyPenalty(strokes, false);
  } else {
    last._penaltyDismissed = true;  /* hide the prompt without applying */
    if (typeof window._lrPersist === 'function') window._lrPersist();
  }
  gpsViewRender();
}

/* PHASE-B4: Explicit end-hole. Calls live-round's lrCompleteHole which handles
   FIR/GIR derivation, putts folding, score finalisation, and hole advance. */
function gpsViewEndHole() {
  if (typeof window.lrCompleteHole === 'function') {
    try { window.lrCompleteHole(); } catch(e) {}
  }
}

/* PHASE-B3: Assign a club to the armed shot. Mutates lrState._shotArmed.club
   in place and re-renders so the mode banner hides the chip row. The club
   value lands in the shot record on stCloseShot since stArmShot stores armed.club. */
function gpsViewSetArmedClub(clubId) {
  var lr = window.lrState;
  if (!lr || !lr._shotArmed) return;
  lr._shotArmed.club = clubId || '';
  if (typeof window._lrPersist === 'function') window._lrPersist();
  gpsViewRender();
}

function _renderShotChip() {
  var el = document.getElementById('gpsShotChip');
  if (!el) return;
  var armed = (typeof window.stGetActive === 'function') ? window.stGetActive() : null;
  if (!armed || _puttMode) { el.style.display = 'none'; el.innerHTML = ''; return; }
  /* PHASE-B1: Slimmed to Cancel-only. The "shot armed" message now lives in
     the mode banner above the map (gpsModeBanner) so it's seen at a glance.
     This chip retains only the cancel affordance, kept small and right-aligned.
     Original (preserved as comment):
  // el.innerHTML = '<div style="padding:8px 12px;background:var(--ac3);border-top:1px solid var(--br);font-size:.7rem;display:flex;align-items:center;gap:8px">'
  //   + '<span style="color:var(--tx)">\u25CB Shot armed</span>'
  //   + (armed.club ? '<span style="color:var(--tx2)">\u00B7 ' + armed.club + '</span>' : '')
  //   + '<span style="margin-left:auto;color:var(--tx3);font-size:.6rem">tap landing to log</span>'
  //   + '<button class="btn sec" style="font-size:.6rem;padding:2px 8px" onclick="gpsViewCancelShot()">Cancel</button>'
  //   + '</div>';
  */
  el.style.display = '';
  el.innerHTML = '<div style="padding:6px 12px;border-top:1px solid var(--br);'
    + 'font-size:.7rem;display:flex;align-items:center;gap:8px;background:var(--bg)">'
    + (armed.club ? '<span style="color:var(--tx2)">' + armed.club + '</span>' : '')
    + '<button class="btn sec" style="font-size:.62rem;padding:3px 12px;margin-left:auto" '
    +   'onclick="gpsViewCancelShot()">Cancel shot</button>'
    + '</div>';
}

function _renderPuttBar() {
  var el = document.getElementById('gpsPuttBar');
  if (!el) return;
  if (!_puttMode) { el.style.display = 'none'; el.innerHTML = ''; return; }
  var lr = window.lrState;
  var s = lr.players[lr.curPlayer].scores[lr.curHole];
  var cnt = s.chip_putt_count || 0;
  el.style.display = '';
  el.innerHTML = '<div style="padding:8px 12px;background:var(--sf);border-top:1px solid var(--br);display:flex;align-items:center;gap:10px">'
    + '<span style="font-size:.7rem;color:var(--tx)">Putts</span>'
    + '<button class="lr-step-btn sm" onclick="gpsViewLogPutt(-1)">\u2212</button>'
    + '<span style="font-family:\'DM Mono\',monospace;font-weight:700;color:var(--tx);min-width:18px;text-align:center">' + cnt + '</span>'
    + '<button class="lr-step-btn sm" onclick="gpsViewLogPutt(1)">+</button>'
    + '</div>';
}

function gpsViewLogPutt(delta) {
  if (typeof window.stLogPutt === 'function') window.stLogPutt(delta);
  /* lrAdjChipPutt calls lrRenderHole; we still need to refresh GPS view. */
  gpsViewRender();
}

/* On-green detection: when the player's GPS position falls inside the green polygon,
   prompt once per hole. */
function _maybePromptOnGreen() {
  var lr = window.lrState;
  if (!lr || !_gpsLast) return;
  if (lr.curHole !== _holeNAtPrompt) {
    _onGreenPromptShown = false;
    _puttMode = false;
    _holeNAtPrompt = lr.curHole;
  }
  if (_onGreenPromptShown || _puttMode) return;
  var geo = _gvGetGeo();
  if (!geo) return;
  var holeEntry = _gvHoleEntry(geo);
  var greenPoly = _gvHoleGreenPoly(geo, holeEntry);
  if (!greenPoly) return;
  var inGreen = false;
  try { inGreen = geomPointInPolygon([_gpsLast[0], _gpsLast[1]], greenPoly); } catch(e) {}
  if (!inGreen) return;
  _onGreenPromptShown = true;
  gpsViewOnGreenPrompt();
}

function gpsViewOnGreenPrompt() {
  if (typeof window.showConfirmModal === 'function') {
    window.showConfirmModal('On Green', 'Switch to putt logging?', function(){
      _puttMode = true;
      gpsViewRender();
    }, false);
  } else {
    /* Fallback: enter putt mode silently */
    _puttMode = true;
    gpsViewRender();
  }
}

/* ─────────────────────────────────────────────────────────
   Map tap handlers
   ───────────────────────────────────────────────────────── */

function gpsViewOnMapTap(lngLat) {
  var lr = window.lrState;
  if (!lr) return;
  var armed = (typeof window.stIsArmed === 'function') ? window.stIsArmed() : false;
  if (lr._trackerOn && armed) {
    /* Landing tap: close shot. */
    if (typeof window.stCloseShot === 'function') window.stCloseShot(lngLat);
    gpsViewRender();
    return;
  }
  /* Otherwise: set aim. */
  lr._mapAim = lngLat;
  if (typeof window._lrPersist === 'function') window._lrPersist();
  gpsViewRender();
}

function gpsViewOnMapDoubleTap(lngLat) {
  var lr = window.lrState;
  if (!lr) return;
  if (!lr._trackerOn) {
    /* Tracker off: double-tap also just sets aim. */
    lr._mapAim = lngLat;
    if (typeof window._lrPersist === 'function') window._lrPersist();
    gpsViewRender();
    return;
  }
  /* Tracker on, no shot armed: arm. */
  if (typeof window.stIsArmed === 'function' && window.stIsArmed()) return;
  /* Set aim too so visual feedback is consistent. */
  lr._mapAim = lngLat;
  var current = _gpsLast ? [_gpsLast[0], _gpsLast[1]] : null;
  if (typeof window.stArmShot === 'function') window.stArmShot(lngLat, '', current);
  if (typeof window._lrPersist === 'function') window._lrPersist();
  gpsViewRender();
}

/* Expose to window. Keep names matching live-round.js convention. */
Object.assign(window, {
  gpsViewOpen, gpsViewClose, gpsViewToggle, gpsViewRender,
  gpsViewToggleBanner, gpsViewToggleMapMode, gpsViewToggleTracker, gpsViewTrackingToggle, gpsViewGpsToggle,
  gpsViewSetArmedClub, gpsViewCorrectLie, gpsViewSetArmedFlight, gpsViewApplyPenalty, gpsViewEndHole,
  gpsViewOnMapTap, gpsViewOnMapDoubleTap, gpsViewLogPutt, gpsViewOnGreenPrompt,
  gpsViewCancelShot,
  lrxYardsToGreen
});
