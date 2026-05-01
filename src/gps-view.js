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
var _gvChevronInjected = false; /* did we attach our SVG to _userMarker.getElement() */
var _holeNAtPrompt = -1;

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
  /* Ensure GPS watch is running for live position. Reuse MapView's GPS if already on,
     else start our own. */
  if (!lr._gpsOn || !lr._mapInstance) {
    if (_gpsWatchId == null) {
      _gpsWatchId = geomStartGpsWatch(_gpsViewOnTick, _gpsViewOnGpsError);
    }
  } else {
    /* MapView is already watching. Read its last fix if present. */
    if (lr._mapInstance && Array.isArray(lr._mapInstance._userLonLat)) {
      _gpsLast = [lr._mapInstance._userLonLat[0], lr._mapInstance._userLonLat[1], 0];
      _gpsLastTickTs = Date.now();
    }
  }
  _puttMode = false;
  _onGreenPromptShown = false;
  _holeNAtPrompt = -1;
  /* LR-EXTRAS: wrap MapView's onAimChange so taps in tracker mode arm/land shots.
     The original callback (persists lrState._mapAim) is preserved and called first. */
  if (lr._mapInstance && _gvOriginalAimCb === null) {
    _gvOriginalAimCb = lr._mapInstance._onAimChange || null;
    lr._mapInstance._onAimChange = function(lngLat) {
      if (_gvOriginalAimCb) { try { _gvOriginalAimCb(lngLat); } catch(e) {} }
      /* Tracker behaviour: only if explicitly enabled. */
      if (!lr._trackerOn) return;
      var armed = (typeof window.stIsArmed === 'function') ? window.stIsArmed() : false;
      if (!armed) {
        /* No shot armed -> arm at this aim point. */
        var current = _gpsLast ? [_gpsLast[0], _gpsLast[1]] : null;
        if (typeof window.stArmShot === 'function') {
          try { window.stArmShot(lngLat, '', current); } catch(e) {}
        }
      } else {
        /* Shot already armed -> land here, write the record. */
        if (typeof window.stCloseShot === 'function') {
          try { window.stCloseShot(lngLat); } catch(e) {}
        }
      }
      /* Refresh shot chip + putt bar etc. */
      if (typeof gpsViewRender === 'function') gpsViewRender();
    };
  }
  /* Wire compass listener */
  window.addEventListener('deviceorientation', _gpsViewOnHeading, true);
  /* Start render loop */
  _gpsViewScheduleRender(true);
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
  _gvChevronInjected = false;
  /* Strip our GPS-screen #lrMapCanvas so the live screen's lrRenderHole() can recreate
     a fresh #lrMapCanvas in its own DOM subtree without id collision. The stashed
     live canvas (lrMapCanvas--stashed) is left in place; lrRenderHole() will overwrite
     #lrScroll innerHTML anyway, removing it. */
  var wrap = document.getElementById('gpsMapWrap');
  if (wrap) wrap.innerHTML = '';
  _gvResetCanvasState();
  /* Repoint MapView's containerId back to the live screen's canvas so the rebuilt
     live #lrMapCanvas (created by lrRenderHole when in map mode) gets the map. */
  if (lr && lr._mapInstance) {
    lr._mapInstance._containerId = 'lrMapCanvas';
  }
  /* Refresh live-round screen so GPS chip / banner are up to date and the live map
     (if user is in map mode) re-mounts via _lrMapMount on its rebuilt canvas. */
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

function gpsViewToggleTracker() {
  var lr = window.lrState;
  if (!lr) return;
  lr._trackerOn = !lr._trackerOn;
  /* Turning tracker off cancels any armed shot. */
  if (!lr._trackerOn && typeof window.stCancel === 'function') window.stCancel();
  if (typeof window._lrPersist === 'function') window._lrPersist();
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
    /* Repoint MapView at our container, then mount. MapView.mount() detects the
       container change via its line-93 check and rebuilds the underlying MapLibre
       map in our element. */
    if (lr._mapInstance) {
      lr._mapInstance._containerId = 'gpsMapCanvas';
    }
    if (typeof window._lrMapMount === 'function') {
      try { window._lrMapMount(); } catch(e) { /* surfaced on next tick if it failed */ }
    }
  }
  /* Snap to current hole on first render and on hole changes. */
  var holeN = lr.curHole + 1;
  if (holeN !== _gvLastShownHole && lr._mapInstance && typeof lr._mapInstance.showHole === 'function') {
    try { lr._mapInstance.showHole(holeN); } catch(e) {}
    _gvLastShownHole = holeN;
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
  if (!_gpsLast) return null;
  var geo = _gvGetGeo();
  if (!geo) return null;
  var holeEntry = _gvHoleEntry(geo);
  if (!holeEntry || !Array.isArray(holeEntry.green)) return null;
  try { return geomDistanceYds([_gpsLast[0], _gpsLast[1]], holeEntry.green); } catch(e) { return null; }
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

function _renderHazards() {
  var el = document.getElementById('gpsHazards');
  if (!el) return;
  var lr = window.lrState;
  if (!lr || !lr._mapInstance || !_gpsLast || !lr._mapAim) {
    el.innerHTML = '';
    return;
  }
  var geo = _gvGetGeo();
  if (!geo || !geo.polygons || !geo.polygons.features) { el.innerHTML = ''; return; }
  var holeEntry = _gvHoleEntry(geo);
  var allFeats = geo.polygons.features;
  var player = [_gpsLast[0], _gpsLast[1]];
  var aim    = lr._mapAim;
  /* Pre-compute corridor basis. */
  var lat0 = player[1] * Math.PI / 180;
  var R = 6371000, M_TO_YDS = 1.0936133;
  var ax = (aim[0] - player[0]) * Math.PI / 180 * Math.cos(lat0) * R;
  var ay = (aim[1] - player[1]) * Math.PI / 180 * R;
  var aLen = Math.sqrt(ax * ax + ay * ay);
  if (aLen < 1e-3) { el.innerHTML = ''; return; }
  var ux = ax / aLen, uy = ay / aLen;
  var rx = uy, ry = -ux;  /* right-perpendicular */
  /* Green centre for the "within 50y of green" rule. */
  var greenC = holeEntry && Array.isArray(holeEntry.green) ? holeEntry.green : null;
  /* Iterate hazard polygons (course-wide; corridor + near-green filters select per-hole relevance). */
  var rows = [];
  for (var i = 0; i < allFeats.length; i++) {
    var f = allFeats[i];
    if (!f || !f.properties) continue;
    var typ = f.properties.golf;
    if (!GPS_HAZARDS[typ]) continue;
    var c = _gvPolyCentroid(f);
    if (!c) continue;
    /* Player→hazard vector in metres. */
    var hx = (c[0] - player[0]) * Math.PI / 180 * Math.cos(lat0) * R;
    var hy = (c[1] - player[1]) * Math.PI / 180 * R;
    /* Project onto aim line. */
    var t = (hx * ux + hy * uy) / aLen;        /* 0..1 along player→aim */
    var perp = Math.abs(hx * rx + hy * ry);     /* perpendicular metres */
    var perpYds = perp * M_TO_YDS;
    var inCorridor = (t >= 0 && t <= 1 && perpYds <= 60);
    var nearGreen = false;
    if (greenC) {
      try { nearGreen = geomDistanceYds(c, greenC) <= 50; } catch(e) {}
    }
    if (!inCorridor && !nearGreen) continue;
    var distYds = 0;
    try { distYds = geomDistanceYds(player, c); } catch(e) {}
    /* L/R via cross product (player→aim) × (player→hazard). */
    var cross = ux * hy - uy * hx;
    var lr_label = cross > 0 ? 'L' : (cross < 0 ? 'R' : '');
    rows.push({ typ: typ, dist: distYds, lr: lr_label, nearGreen: nearGreen });
  }
  /* Sort ascending by distance; near-green entries always shown. */
  rows.sort(function(a,b){ return a.dist - b.dist; });
  var visible = [];
  var extras = 0;
  for (var r = 0; r < rows.length; r++) {
    if (visible.length < 5 || rows[r].nearGreen) visible.push(rows[r]);
    else extras++;
  }
  if (!visible.length) { el.innerHTML = ''; return; }
  var html = '<div style="padding:6px 12px"><div style="font-size:.55rem;color:var(--tx3);letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px">Hazards in play</div>';
  visible.forEach(function(rw){
    var meta = GPS_HAZARDS[rw.typ];
    html += '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--br);font-size:.7rem">'
      + '<span style="color:' + meta.color + '">' + meta.icon + '</span>'
      + '<span style="color:var(--tx)">' + meta.label + '</span>'
      + '<span style="margin-left:auto;font-family:\'DM Mono\',monospace;color:var(--tx2)">'
      + rw.dist + ' yds' + (rw.lr ? ' ' + rw.lr : '') + '</span>'
      + '</div>';
  });
  if (extras > 0) html += '<div style="font-size:.6rem;color:var(--tx3);padding:4px 0">+ ' + extras + ' more</div>';
  html += '</div>';
  el.innerHTML = html;
}

/* ─────────────────────────────────────────────────────────
   Active shot chip + putt bar + on-green prompt
   ───────────────────────────────────────────────────────── */

function _renderShotChip() {
  var el = document.getElementById('gpsShotChip');
  if (!el) return;
  var armed = (typeof window.stGetActive === 'function') ? window.stGetActive() : null;
  if (!armed || _puttMode) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = '<div style="padding:8px 12px;background:var(--ac3);border-top:1px solid var(--br);font-size:.7rem;display:flex;align-items:center;gap:8px">'
    + '<span style="color:var(--tx)">\u25CB Shot armed</span>'
    + (armed.club ? '<span style="color:var(--tx2)">\u00B7 ' + armed.club + '</span>' : '')
    + '<span style="margin-left:auto;color:var(--tx3);font-size:.6rem">tap landing to log</span>'
    + '<button class="btn sec" style="font-size:.6rem;padding:2px 8px" onclick="(window.stCancel&&window.stCancel(),gpsViewRender())">Cancel</button>'
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
  gpsViewToggleBanner, gpsViewToggleMapMode, gpsViewToggleTracker,
  gpsViewOnMapTap, gpsViewOnMapDoubleTap, gpsViewLogPutt, gpsViewOnGreenPrompt,
  lrxYardsToGreen
});
