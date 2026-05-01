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
  /* Refresh live-round screen so GPS chip / banner are up to date. */
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
  _renderYards();
  _renderHazards();
  _renderShotChip();
  _renderPuttBar();
  _maybePromptOnGreen();
  if (_gpsLast) _lastRenderLL = [_gpsLast[0], _gpsLast[1]];
}

function _renderBanner() {
  var lr = window.lrState;
  var hole = lr.holes[lr.curHole];
  var collapsedEl = document.getElementById('gpsTopBanner');
  if (!collapsedEl) return;
  var collapsed = collapsedEl.dataset.collapsed === 'true';
  var ydsToGreen = _calcYardsToGreen();
  var trackerOn  = !!lr._trackerOn;
  var styleMode  = (lr._mapInstance && typeof lr._mapInstance.getStyleMode === 'function')
    ? lr._mapInstance.getStyleMode() : 'satellite';
  var gpsLostBadge = _gpsLostFlag
    ? '<span style="color:#c00;font-size:.55rem;margin-left:6px">GPS lost</span>' : '';
  var gpsDot = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;'
    + 'background:' + (_gpsLostFlag ? '#c00' : '#2ca02c') + ';margin-right:6px"></span>';
  var trackerBtn = '<button class="btn sec" style="font-size:.6rem;padding:2px 8px"'
    + ' onclick="gpsViewToggleTracker()">'
    + (trackerOn ? '\u25CF Tracker On' : '\u25CB Tracker Off') + '</button>';
  var html;
  if (collapsed) {
    html = '<div onclick="gpsViewToggleBanner()" style="cursor:pointer;padding:8px 12px;'
      + 'display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--br);'
      + 'background:var(--sf)">'
      + '<div style="font-weight:700;color:var(--tx)">Hole ' + hole.n + '</div>'
      + '<div style="color:var(--tx2);font-family:\'DM Mono\',monospace;font-size:.75rem">'
      + (ydsToGreen != null ? ydsToGreen + ' yds' : '\u2014') + '</div>'
      + gpsDot + gpsLostBadge
      + '<div style="margin-left:auto">' + trackerBtn + '</div>'
      + '</div>';
  } else {
    html = '<div style="padding:10px 12px;border-bottom:1px solid var(--br);background:var(--sf)">'
      + '<div onclick="gpsViewToggleBanner()" style="cursor:pointer;display:flex;align-items:center;gap:10px;margin-bottom:6px">'
      + '<div style="font-weight:700;color:var(--tx);font-size:1rem">Hole ' + hole.n + '</div>'
      + '<div style="color:var(--tx2);font-size:.7rem">Par ' + hole.par
      + (hole.yards ? ' \u00B7 ' + hole.yards + ' yds' : '') + '</div>'
      + gpsDot + gpsLostBadge
      + '<div style="margin-left:auto;color:var(--tx3);font-size:.6rem">tap to collapse</div>'
      + '</div>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
      + trackerBtn
      + '<button class="btn sec" style="font-size:.6rem;padding:2px 8px"'
      + ' onclick="gpsViewToggleMapMode()">'
      + (styleMode === 'plain' ? 'No Map' : 'Satellite') + '</button>'
      + '<button class="btn sec" style="font-size:.6rem;padding:2px 8px"'
      + ' onclick="gpsViewClose()">\u2190 Scoring</button>'
      + '</div></div>';
  }
  collapsedEl.innerHTML = html;
}

function gpsViewToggleBanner() {
  var el = document.getElementById('gpsTopBanner');
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

/* ─────────────────────────────────────────────────────────
   Minimap (pure SVG)
   ───────────────────────────────────────────────────────── */

function _renderMinimap() {
  var lr = window.lrState;
  var wrap = document.getElementById('gpsMapWrap');
  if (!wrap) return;
  var geo = lr._mapInstance && (typeof lr._mapInstance.getGeometry === 'function'
    ? lr._mapInstance.getGeometry() : lr._mapInstance._geo);
  if (!geo || !geo.features) {
    wrap.innerHTML = '<div style="padding:20px;text-align:center;color:var(--tx3)">No course geometry loaded.</div>';
    return;
  }
  var holeN = lr.curHole + 1;
  var holeFeats = geo.features.filter(function(f){
    if (!f || !f.properties) return false;
    var ref = f.properties.ref || f.properties.hole;
    if (ref != null && +ref !== holeN) return false;
    return true;
  });
  /* Bounding box. */
  var coords = [];
  var collect = function(g) {
    if (!g) return;
    if (g.type === 'Point') coords.push(g.coordinates);
    else if (g.type === 'LineString') for (var i=0;i<g.coordinates.length;i++) coords.push(g.coordinates[i]);
    else if (g.type === 'Polygon') for (var j=0;j<g.coordinates[0].length;j++) coords.push(g.coordinates[0][j]);
  };
  holeFeats.forEach(function(f){ collect(f.geometry); });
  if (_gpsLast) coords.push([_gpsLast[0], _gpsLast[1]]);
  if (lr._mapAim) coords.push(lr._mapAim);
  if (!coords.length) {
    wrap.innerHTML = '<div style="padding:20px;text-align:center;color:var(--tx3)">No hole geometry.</div>';
    return;
  }
  /* Compute tee→green bearing for rotation. */
  var teeFeat = holeFeats.find(function(f){ return f.properties && f.properties.golf === 'tee'; });
  var greenFeat = holeFeats.find(function(f){ return f.properties && f.properties.golf === 'green'; });
  var teeLL = teeFeat ? _featureCenter(teeFeat) : null;
  var grnLL = greenFeat ? _featureCenter(greenFeat) : null;
  var rotDeg = 0;
  if (teeLL && grnLL) {
    try { rotDeg = geomBearingDeg(teeLL, grnLL); } catch(e) {}
  }
  /* Project each [lon,lat] to local metres around bbox centre, then rotate so
     tee→green points up (north on screen). Then scale to SVG. */
  var W = wrap.clientWidth || 320;
  var H = Math.max(180, Math.min(320, (wrap.clientHeight || 220)));
  var pad = 10;
  /* bbox centre */
  var minX = coords[0][0], maxX = coords[0][0], minY = coords[0][1], maxY = coords[0][1];
  for (var k=1;k<coords.length;k++) {
    if (coords[k][0] < minX) minX = coords[k][0];
    if (coords[k][0] > maxX) maxX = coords[k][0];
    if (coords[k][1] < minY) minY = coords[k][1];
    if (coords[k][1] > maxY) maxY = coords[k][1];
  }
  var cLon = (minX + maxX) / 2;
  var cLat = (minY + maxY) / 2;
  var lat0 = cLat * Math.PI / 180;
  var R = 6371000;
  /* Rotation: we want tee→green to point up (negative Y in SVG). */
  var theta = -((90 - rotDeg) * Math.PI / 180);  /* rotate so green-bearing aligns to up */
  var cosT = Math.cos(theta), sinT = Math.sin(theta);
  var project = function(ll) {
    var dx = (ll[0] - cLon) * Math.PI / 180 * Math.cos(lat0) * R;
    var dy = (ll[1] - cLat) * Math.PI / 180 * R;
    /* Rotate */
    var rx = dx * cosT - dy * sinT;
    var ry = dx * sinT + dy * cosT;
    return [rx, ry];
  };
  /* Rotated bbox */
  var pts = coords.map(project);
  var rMinX = pts[0][0], rMaxX = pts[0][0], rMinY = pts[0][1], rMaxY = pts[0][1];
  for (var p=1;p<pts.length;p++) {
    if (pts[p][0] < rMinX) rMinX = pts[p][0];
    if (pts[p][0] > rMaxX) rMaxX = pts[p][0];
    if (pts[p][1] < rMinY) rMinY = pts[p][1];
    if (pts[p][1] > rMaxY) rMaxY = pts[p][1];
  }
  var dxR = rMaxX - rMinX || 1;
  var dyR = rMaxY - rMinY || 1;
  var sx = (W - 2 * pad) / dxR;
  var sy = (H - 2 * pad) / dyR;
  var s = Math.min(sx, sy);
  var toSvg = function(ll) {
    var pp = project(ll);
    var x = pad + (pp[0] - rMinX) * s;
    /* Flip Y so north-up shows correctly (SVG y grows downward). */
    var y = H - pad - (pp[1] - rMinY) * s;
    return [x, y];
  };
  /* Build SVG content. */
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '"'
    + ' style="display:block;background:var(--bg2)" xmlns="http://www.w3.org/2000/svg">';
  /* Polygons by golf type */
  var polyOrder = ['fairway','rough','bunker','water','lateral_water_hazard','woods','green'];
  var polyStyle = {
    fairway:               'fill:#86b86d;stroke:none',
    rough:                 'fill:#5a8c4a;stroke:none',
    bunker:                'fill:#e6d28a;stroke:#b8a05e;stroke-width:1',
    water:                 'fill:#5fb4e8;stroke:#2f7da8;stroke-width:1',
    lateral_water_hazard:  'fill:#5fb4e8;stroke:#2f7da8;stroke-width:1',
    woods:                 'fill:#3b6d11;stroke:none;opacity:.55',
    green:                 'fill:#a4d49a;stroke:#4f7a45;stroke-width:1.2'
  };
  for (var po = 0; po < polyOrder.length; po++) {
    var typ = polyOrder[po];
    var feats = holeFeats.filter(function(f){ return f.properties && f.properties.golf === typ && f.geometry && f.geometry.type === 'Polygon'; });
    feats.forEach(function(f){
      var ring = f.geometry.coordinates[0];
      var d = ring.map(function(c, i){ var xy = toSvg(c); return (i === 0 ? 'M' : 'L') + xy[0].toFixed(1) + ',' + xy[1].toFixed(1); }).join(' ') + ' Z';
      svg += '<path d="' + d + '" style="' + polyStyle[typ] + '"/>';
    });
  }
  /* Tee marker */
  if (teeLL) {
    var t = toSvg(teeLL);
    svg += '<circle cx="' + t[0].toFixed(1) + '" cy="' + t[1].toFixed(1) + '" r="4" fill="#fff" stroke="#333" stroke-width="1.5"/>';
  }
  /* Aim reticle + dashed player→aim line */
  if (lr._mapAim && _gpsLast) {
    var pa = toSvg(lr._mapAim);
    var pp2 = toSvg([_gpsLast[0], _gpsLast[1]]);
    svg += '<line x1="' + pp2[0].toFixed(1) + '" y1="' + pp2[1].toFixed(1)
      + '" x2="' + pa[0].toFixed(1) + '" y2="' + pa[1].toFixed(1)
      + '" stroke="#ff9d00" stroke-width="1.5" stroke-dasharray="4 3"/>';
    svg += '<circle cx="' + pa[0].toFixed(1) + '" cy="' + pa[1].toFixed(1) + '" r="6" fill="none" stroke="#ff9d00" stroke-width="1.8"/>';
    svg += '<circle cx="' + pa[0].toFixed(1) + '" cy="' + pa[1].toFixed(1) + '" r="2" fill="#ff9d00"/>';
  }
  /* Player dot + chevron (rotated) */
  if (_gpsLast) {
    var pp = toSvg([_gpsLast[0], _gpsLast[1]]);
    svg += '<g transform="translate(' + pp[0].toFixed(1) + ',' + pp[1].toFixed(1) + ')">';
    svg += '<circle r="6" fill="#1e90ff" stroke="#fff" stroke-width="2"/>';
    /* Chevron: rotated by compass heading. SVG <g id> for cheap updates. */
    var hdg = _lastHeading != null ? _lastHeading : 0;
    /* Compass heading is relative to true north; minimap is rotated so green-bearing is up.
       To keep chevron pointing toward true facing direction within the rotated frame,
       subtract the rotation we applied. */
    var chevDeg = hdg - rotDeg;
    svg += '<g id="gpsPlayerChevron" transform="rotate(' + chevDeg.toFixed(1) + ')">'
      + '<polygon points="0,-10 4,2 -4,2" fill="#1e90ff" stroke="#fff" stroke-width="1"/>'
      + '</g>';
    svg += '</g>';
  }
  /* North-up label fallback when compass denied/unsupported */
  var compassPerm = localStorage.getItem('gordy:compass');
  if (compassPerm !== 'granted') {
    svg += '<text x="' + (W - 8) + '" y="14" font-size="10" fill="var(--tx3)" text-anchor="end">N\u2191</text>';
  }
  svg += '</svg>';
  /* Tap handlers — use a transparent overlay to capture taps and convert to lng/lat. */
  wrap.innerHTML = svg;
  /* Map taps: project click x/y back to a [lon,lat] using inverse of the same transform. */
  var svgEl = wrap.querySelector('svg');
  if (svgEl) {
    var tapTimeout = null;
    var unprojectXY = function(x, y) {
      var rx = (x - pad) / s + rMinX;
      var ry = ((H - pad) - y) / s + rMinY;
      /* Inverse rotation */
      var cosI = Math.cos(-theta), sinI = Math.sin(-theta);
      var dx = rx * cosI - ry * sinI;
      var dy = rx * sinI + ry * cosI;
      var lon = cLon + (dx / (Math.cos(lat0) * R)) * (180 / Math.PI);
      var lat = cLat + (dy / R) * (180 / Math.PI);
      return [lon, lat];
    };
    var handleTap = function(ev, isDouble) {
      var rect = svgEl.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      var y = ev.clientY - rect.top;
      var ll = unprojectXY(x, y);
      if (isDouble) gpsViewOnMapDoubleTap(ll); else gpsViewOnMapTap(ll);
    };
    svgEl.onclick = function(ev) {
      if (tapTimeout) { clearTimeout(tapTimeout); tapTimeout = null; handleTap(ev, true); return; }
      tapTimeout = setTimeout(function(){ tapTimeout = null; handleTap(ev, false); }, 260);
    };
  }
}

function _featureCenter(f) {
  if (!f || !f.geometry) return null;
  var g = f.geometry;
  if (g.type === 'Point') return g.coordinates;
  if (g.type === 'Polygon' && g.coordinates[0]) {
    var ring = g.coordinates[0];
    var sx = 0, sy = 0, n = 0;
    for (var i = 0; i < ring.length; i++) { sx += ring[i][0]; sy += ring[i][1]; n++; }
    if (n) return [sx / n, sy / n];
  }
  return null;
}

/* ─────────────────────────────────────────────────────────
   Big yards display
   ───────────────────────────────────────────────────────── */

function _calcYardsToGreen() {
  var lr = window.lrState;
  if (!lr || !lr._mapInstance || !_gpsLast) return null;
  var geo = (typeof lr._mapInstance.getGeometry === 'function')
    ? lr._mapInstance.getGeometry() : lr._mapInstance._geo;
  if (!geo || !geo.features) return null;
  var holeN = lr.curHole + 1;
  var greenFeat = geo.features.find(function(f){
    if (!f.properties || f.properties.golf !== 'green') return false;
    var ref = f.properties.ref || f.properties.hole;
    return ref == null || +ref === holeN;
  });
  var c = greenFeat ? _featureCenter(greenFeat) : null;
  if (!c) return null;
  try { return geomDistanceYds([_gpsLast[0], _gpsLast[1]], c); } catch(e) { return null; }
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
  var geo = (typeof lr._mapInstance.getGeometry === 'function')
    ? lr._mapInstance.getGeometry() : lr._mapInstance._geo;
  if (!geo || !geo.features) { el.innerHTML = ''; return; }
  var holeN = lr.curHole + 1;
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
  var greenFeat = geo.features.find(function(f){
    if (!f.properties || f.properties.golf !== 'green') return false;
    var ref = f.properties.ref || f.properties.hole;
    return ref == null || +ref === holeN;
  });
  var greenC = greenFeat ? _featureCenter(greenFeat) : null;
  /* Iterate hazards. */
  var rows = [];
  for (var i = 0; i < geo.features.length; i++) {
    var f = geo.features[i];
    if (!f || !f.properties) continue;
    var typ = f.properties.golf;
    if (!GPS_HAZARDS[typ]) continue;
    var ref2 = f.properties.ref || f.properties.hole;
    if (ref2 != null && +ref2 !== holeN) continue;
    var c = _featureCenter(f);
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
  var geo = lr._mapInstance && (typeof lr._mapInstance.getGeometry === 'function'
    ? lr._mapInstance.getGeometry() : lr._mapInstance._geo);
  if (!geo || !geo.features) return;
  var holeN = lr.curHole + 1;
  var greenFeat = geo.features.find(function(f){
    if (!f.properties || f.properties.golf !== 'green') return false;
    var ref = f.properties.ref || f.properties.hole;
    return ref == null || +ref === holeN;
  });
  if (!greenFeat) return;
  var inGreen = false;
  try { inGreen = geomPointInPolygon([_gpsLast[0], _gpsLast[1]], greenFeat); } catch(e) {}
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
  gpsViewOnMapTap, gpsViewOnMapDoubleTap, gpsViewLogPutt, gpsViewOnGreenPrompt
});
