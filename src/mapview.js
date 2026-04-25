/* mapview.js -- G2.5
   Reusable map UI primitives (mount, aim reticle, distance bubbles, GPS marker,
   tee marker, polygon styling). Extracted from live-round.js post-G2.

   Pure refactor: every behaviour preserved byte-for-byte from live-round.js.
   Consumers (live-round, future viz, future courses preview) instantiate MapView
   with their own state callbacks; MapView owns view-state (markers, GPS watch,
   map instance) and exposes view-state via instance methods.

   Round-specific state (e.g. lrState._mapAim, _mapTeeLonLat) lives with the
   consumer. MapView reads/writes via setAim/getAim/setTeeOverride etc. and
   notifies the consumer via the onAimChange / onGpsTick callbacks.

   Dependencies: window.maplibregl, window.turf (transitively via geomap.js).
   Imports geomap.js helpers that wrap MapLibre + turf calls.
*/

import { geomCreateMap, geomRenderPath, geomDistanceYds, geomBearingDeg,
         geomStartGpsWatch, geomStopGpsWatch } from './geomap.js';

export class MapView {
  /* opts:
     - containerId   (string, required) -- id of the DOM element to mount the map in
     - geo           (object, optional) -- initial geometry: { holes, polygons, center, bounds, boundary? }
     - holeN         (number, optional) -- initial hole number (1-indexed); default 1
     - idPrefix      (string, optional) -- DOM id prefix for floating bubble/pill; default 'mv'
                                            (live-round consumer passes 'lr' to preserve existing CSS)
     - onAimChange   (fn, optional)     -- called with [lng,lat] when aim moves (drag end / tap)
                                            and on persist-events (drag end, dragend on tee).
                                            Consumer typically uses this to call _lrPersist().
     - onTeeChange   (fn, optional)     -- called with [lng,lat] when tee override moves
     - onGpsTick     (fn, optional)     -- called with [lng,lat] on each GPS fix
     - onGpsError    (fn, optional)     -- called with err on watchPosition error
     - onMapClick    (fn, optional)     -- called with the MapLibre click event after
                                            internal aim-update logic runs. Mostly unused;
                                            present for symmetry / future use.
  */
  constructor(opts) {
    opts = opts || {};
    this._containerId = opts.containerId;
    this._geo         = opts.geo || null;
    this._holeN       = opts.holeN || 1;        /* 1-indexed hole number */
    this._idPrefix    = opts.idPrefix || 'mv';

    this._onAimChange = opts.onAimChange || null;
    this._onTeeChange = opts.onTeeChange || null;
    this._onGpsTick   = opts.onGpsTick   || null;
    this._onGpsError  = opts.onGpsError  || null;
    this._onMapClick  = opts.onMapClick  || null;

    /* View-owned state -- markers, map instance, GPS watch */
    this._map           = null;     /* MapLibre Map instance */
    this._userMarker    = null;
    this._targetMarker  = null;     /* G2b-R retained for legacy unmount; no longer placed */
    this._teeMarker     = null;
    this._aimMarker     = null;
    this._gpsWatchId    = null;
    this._userLonLat    = null;     /* [lng,lat] latest GPS fix */
    this._gpsOn         = false;

    /* Round-anchored state cached locally so MapView can render without
       coupling to consumer state on every internal call. Mutated via
       setAim / setTeeOverride / clearAim / clearTeeOverride. */
    this._aim           = null;     /* [lng,lat] aim reticle position */
    this._teeOverride   = null;     /* [lng,lat] user-dragged tee, or null */
    this._minimized     = false;

    /* Bind event handlers once so add/remove listener references match. */
    this._handleMapClick     = this._handleMapClick.bind(this);
    this._handleMapMove      = this._handleMapMove.bind(this);
    this._handleGpsTickInner = this._handleGpsTickInner.bind(this);
    this._handleGpsErrorInner= this._handleGpsErrorInner.bind(this);
  }

  /* ============================================================
     Lifecycle
     ============================================================ */

  mount() {
    if (!this._geo) return;
    var el = document.getElementById(this._containerId);
    if (!el) return;
    /* If an existing instance's container was replaced by innerHTML, rebuild */
    if (this._map && this._map.getContainer && this._map.getContainer() !== el) {
      try { this._map.remove(); } catch(e) {}
      this._map         = null;
      this._userMarker  = null;
      this._targetMarker= null;
      this._teeMarker   = null;
      this._aimMarker   = null;
    }
    var self = this;
    if (!this._map) {
      /* G2b-R -- initial zoom tightened from 16 to 18 (tee-level satellite detail). */
      this._map = geomCreateMap(el, { center: this._geo.center, zoom: 17 });
      /* G2b-R2 -- inline polygon-source set, skipping geomRenderGeometry's fitBounds
         which would zoom out to the entire course. We only want hole-level framing
         in live round; showHole below handles the per-hole flyTo. */
      var applyPolys = function(){
        try {
          var src = self._map.getSource('course-polygons');
          if (src && self._geo && self._geo.polygons) src.setData(self._geo.polygons);
        } catch(e) {}
      };
      this._map.on('load', function(){
        applyPolys();
        self._showHoleInternal(self._holeN);
        self._placeTeeMarker();
        self._placeAimMarker();
        self._renderAimLine();
        self._updateFloatingDists();
      });
      if (this._map.isStyleLoaded && this._map.isStyleLoaded()) {
        applyPolys();
        this._showHoleInternal(this._holeN);
        this._placeTeeMarker();
        this._placeAimMarker();
        this._renderAimLine();
        this._updateFloatingDists();
      }
      this._map.on('click', this._handleMapClick);
      /* G2b-R -- floating aim-distance bubble tracks aim marker on map move/zoom. */
      this._map.on('move', this._handleMapMove);
    } else {
      /* Same instance being re-shown (e.g. after hole change returns scroll html) */
      this._placeTeeMarker();
      this._placeAimMarker();
      this._renderAimLine();
      this._updateFloatingDists();
    }
    if (this._userLonLat) this._placeUserMarker(this._userLonLat);
  }

  unmount() {
    /* Always stop GPS first so watchPosition does not leak across instances. */
    this.stopGps();
    if (this._userMarker)   { try { this._userMarker.remove();   } catch(e) {} this._userMarker   = null; }
    if (this._targetMarker) { try { this._targetMarker.remove(); } catch(e) {} this._targetMarker = null; }
    if (this._teeMarker)    { try { this._teeMarker.remove();    } catch(e) {} this._teeMarker    = null; }
    if (this._aimMarker)    { try { this._aimMarker.remove();    } catch(e) {} this._aimMarker    = null; }
    if (this._map)          { try { this._map.remove();          } catch(e) {} this._map          = null; }
    this._userLonLat = null;
  }

  isMounted() {
    return !!this._map;
  }

  /* ============================================================
     Geometry
     ============================================================ */

  setGeometry(geo) {
    this._geo = geo;
    if (this._map && geo && geo.polygons) {
      try {
        var src = this._map.getSource('course-polygons');
        if (src) src.setData(geo.polygons);
      } catch(e) {}
    }
  }

  getGeometry() { return this._geo; }

  /* showHole(holeN, opts):
     - holeN: 1-indexed hole number
     - opts.resetAim: if true, clears the aim so next placeAimMarker picks midpoint
  */
  showHole(holeN, opts) {
    this._holeN = holeN;
    if (opts && opts.resetAim) {
      this._aim = null;
      this._teeOverride = null;
      /* Clear rendered aim line; marker will be replaced on next placeAimMarker */
      if (this._map) { try { geomRenderPath(this._map, []); } catch(e) {} }
      if (this._aimMarker) { try { this._aimMarker.remove(); } catch(e) {} this._aimMarker = null; }
      if (this._teeMarker) { try { this._teeMarker.remove(); } catch(e) {} this._teeMarker = null; }
    }
    this._showHoleInternal(holeN);
    /* If map is ready, also re-place tee + aim markers for new hole. */
    if (this._map && this._geo) {
      this._placeTeeMarker();
      this._placeAimMarker();
      this._renderAimLine();
      this._updateFloatingDists();
    }
  }

  /* G2b-R2 -- per-hole flyTo. Replaces geomShowHole's internal flyTo (zoom 17.5)
     with a single tighter flyTo (zoom 18.5). Avoids competing-flyTo jank.
     [Note: code uses zoom 16; preserved byte-for-byte from live-round.js _lrMapShowHole.] */
  _showHoleInternal(n) {
    if (!this._map || !this._geo) return;
    try {
      var hole = this._curHoleGeo();
      if (hole && hole.tee && hole.green) {
        var brg = geomBearingDeg(hole.tee, hole.green);
        this._map.flyTo({ center: hole.tee, zoom: 16, bearing: brg, pitch: 0 });
      }
    } catch(e) {}
  }

  /* ============================================================
     Aim reticle
     ============================================================ */

  setAim(lngLat) {
    this._aim = lngLat;
    if (this._aimMarker) {
      try { this._aimMarker.setLngLat(lngLat); } catch(e) {}
    } else {
      this._placeAimMarker();
    }
    this._renderAimLine();
    this._updateFloatingDists();
    if (this._onAimChange) { try { this._onAimChange(lngLat); } catch(e) {} }
  }

  getAim() { return this._aim; }

  clearAim() {
    this._aim = null;
    if (this._aimMarker) { try { this._aimMarker.remove(); } catch(e) {} this._aimMarker = null; }
    if (this._map) { try { geomRenderPath(this._map, []); } catch(e) {} }
    this._updateFloatingDists();
  }

  /* ============================================================
     Tee override
     ============================================================ */

  setTeeOverride(lngLat) {
    this._teeOverride = lngLat;
    if (this._teeMarker) {
      try { this._teeMarker.setLngLat(lngLat); } catch(e) {}
    } else {
      this._placeTeeMarker();
    }
    this._renderAimLine();
    this._updateFloatingDists();
    if (this._onTeeChange) { try { this._onTeeChange(lngLat); } catch(e) {} }
  }

  getTeeOverride() { return this._teeOverride; }

  clearTeeOverride() {
    this._teeOverride = null;
    if (this._teeMarker) { try { this._teeMarker.remove(); } catch(e) {} this._teeMarker = null; }
  }

  /* ============================================================
     GPS
     ============================================================ */

  startGps() {
    if (this._gpsWatchId != null) return;   /* already on */
    this._gpsWatchId = geomStartGpsWatch(this._handleGpsTickInner, this._handleGpsErrorInner);
    this._gpsOn = true;
  }

  stopGps() {
    if (this._gpsWatchId != null) {
      try { geomStopGpsWatch(this._gpsWatchId); } catch(e) {}
      this._gpsWatchId = null;
    }
    if (this._userMarker) { try { this._userMarker.remove(); } catch(e) {} this._userMarker = null; }
    this._userLonLat = null;
    this._gpsOn = false;
  }

  isGpsOn() { return this._gpsOn; }

  /* ============================================================
     Visibility / lifecycle helpers
     ============================================================ */

  minimize() {
    /* G2b-R -- Once loaded, map persists. Minimize hides via consumer's panel
       toggle; the instance + state survive. We track _minimized so consumers
       can query, but no MapLibre calls happen here -- the consumer controls
       the DOM panel that holds the canvas. */
    this._minimized = true;
  }

  resume() {
    this._minimized = false;
    /* If consumer re-renders the panel, mount() will detect container change
       and re-attach. Caller should invoke mount() after resume(). */
  }

  isMinimized() { return this._minimized; }

  /* ============================================================
     Distance helpers (pure)
     ============================================================ */

  distanceAimToGreen() {
    if (!this._aim) return null;
    var hole = this._curHoleGeo();
    if (!hole || !hole.green) return null;
    return geomDistanceYds(this._aim, hole.green);
  }

  distancePlayerToAim() {
    if (!this._aim) return null;
    var hole = this._curHoleGeo();
    if (!hole) return null;
    var startPt = this._gpsOn && this._userLonLat
      ? this._userLonLat
      : (this._teeOverride || hole.tee);
    if (!startPt) return null;
    return geomDistanceYds(startPt, this._aim);
  }

  playerSourceLabel() {
    if (this._gpsOn && this._userLonLat) return 'from GPS';
    if (this._teeOverride) return 'from tee*';
    return 'from tee';
  }

  /* ============================================================
     Internals (private by convention)
     ============================================================ */

  _curHoleGeo() {
    if (!this._geo || !this._geo.holes) return null;
    var want = String(this._holeN);
    for (var key in this._geo.holes) {
      if (String(this._geo.holes[key].ref) === want) return this._geo.holes[key];
    }
    return null;
  }

  /* G2b-R -- draggable tee; dragend updates line + floating distances. */
  _placeTeeMarker() {
    if (!this._map || !window.maplibregl) return;
    var hole = this._curHoleGeo();
    if (!hole || !hole.tee) return;
    var ll = this._teeOverride || hole.tee;
    if (this._teeMarker) { try { this._teeMarker.remove(); } catch(e) {} this._teeMarker = null; }
    var el = document.createElement('div');
    el.style.cssText = 'width:14px;height:14px;background:#d0d8e0;'
      + 'border:2px solid #fff;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,.5);cursor:grab';
    var self = this;
    this._teeMarker = new window.maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(ll).addTo(this._map);
    this._teeMarker.on('dragend', function(){
      var p = self._teeMarker.getLngLat();
      self._teeOverride = [p.lng, p.lat];
      if (self._onTeeChange) { try { self._onTeeChange(self._teeOverride); } catch(e) {} }
      self._renderAimLine();
      self._updateFloatingDists();
    });
  }

  /* G2b-R -- aim reticle. Initial position = midpoint of start(tee or user-tee) and green.
     Draggable; drag/dragend update line + floating distances. */
  _placeAimMarker() {
    if (!this._map || !window.maplibregl) return;
    var hole = this._curHoleGeo();
    if (!hole || !hole.green) return;
    var startPt = this._teeOverride || hole.tee;
    if (!startPt) return;
    /* Initialize aim at fairway line centroid if not set; fall back to tee->green midpoint. */
    if (!this._aim) {
      if (hole.line && hole.line.length >= 2 && window.turf) {
        try {
          var lineFc = window.turf.lineString(hole.line);
          var ctr = window.turf.centroid(lineFc);
          this._aim = ctr.geometry.coordinates;
        } catch(e) {
          this._aim = [(startPt[0] + hole.green[0]) / 2, (startPt[1] + hole.green[1]) / 2];
        }
      } else {
        this._aim = [(startPt[0] + hole.green[0]) / 2, (startPt[1] + hole.green[1]) / 2];
      }
      if (this._onAimChange) { try { this._onAimChange(this._aim); } catch(e) {} }
    }
    if (this._aimMarker) { try { this._aimMarker.remove(); } catch(e) {} this._aimMarker = null; }
    /* Reticle: 44px crosshair circle, matches screenshot aesthetic. */
    var el = document.createElement('div');
    el.style.cssText = 'width:44px;height:44px;border-radius:50%;'
      + 'border:2px solid #fff;background:rgba(255,255,255,.08);'
      + 'box-shadow:0 0 6px rgba(0,0,0,.6);cursor:grab;position:relative';
    el.innerHTML = ''
      + '<div style="position:absolute;left:50%;top:50%;width:6px;height:6px;'
      +   'background:#fff;border-radius:50%;transform:translate(-50%,-50%);'
      +   'box-shadow:0 0 3px rgba(0,0,0,.6)"></div>'
      /* 4 tick marks */
      + '<div style="position:absolute;left:50%;top:0;width:2px;height:6px;background:#fff;transform:translateX(-50%)"></div>'
      + '<div style="position:absolute;left:50%;bottom:0;width:2px;height:6px;background:#fff;transform:translateX(-50%)"></div>'
      + '<div style="position:absolute;top:50%;left:0;width:6px;height:2px;background:#fff;transform:translateY(-50%)"></div>'
      + '<div style="position:absolute;top:50%;right:0;width:6px;height:2px;background:#fff;transform:translateY(-50%)"></div>';
    var self = this;
    this._aimMarker = new window.maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(this._aim).addTo(this._map);
    this._aimMarker.on('drag', function(){
      var p = self._aimMarker.getLngLat();
      self._aim = [p.lng, p.lat];
      self._renderAimLine();
      self._updateFloatingDists();
    });
    this._aimMarker.on('dragend', function(){
      var p = self._aimMarker.getLngLat();
      self._aim = [p.lng, p.lat];
      if (self._onAimChange) { try { self._onAimChange(self._aim); } catch(e) {} }
    });
  }

  /* G2b-R -- render the aim line: start(GPS|userTee|geomTee) -> aim -> green. */
  _renderAimLine() {
    if (!this._map || !this._geo) return;
    var hole = this._curHoleGeo();
    if (!hole || !hole.green) { try { geomRenderPath(this._map, []); } catch(e){} return; }
    var gpsActive = !!(this._gpsOn && this._userLonLat);
    var startPt = gpsActive ? this._userLonLat : (this._teeOverride || hole.tee);
    var aim = this._aim;
    if (!startPt || !aim) { try { geomRenderPath(this._map, []); } catch(e){} return; }
    try { geomRenderPath(this._map, [startPt, aim, hole.green]); } catch(e) {}
  }

  /* G2b-R -- update the two floating labels.
     #<idPrefix>AimDistBubble: yards from aim to green, positioned at aim's screen coords.
     #<idPrefix>PlayerDistPill: yards from start(GPS|Tee) to aim, bottom-left label. */
  _updateFloatingDists() {
    if (!this._map) return;
    var hole = this._curHoleGeo();
    if (!hole || !hole.green) return;
    var aim = this._aim;
    var gpsActive = !!(this._gpsOn && this._userLonLat);
    var startPt = gpsActive ? this._userLonLat : (this._teeOverride || hole.tee);

    var bubble = document.getElementById(this._idPrefix + 'AimDistBubble');
    var pill   = document.getElementById(this._idPrefix + 'PlayerDistPill');

    /* Aim -> green bubble: light green background, floats above reticle. */
    if (bubble) {
      if (aim && hole.green) {
        var aimToGreen = geomDistanceYds(aim, hole.green);
        bubble.style.background = 'rgba(40,160,80,.85)';
        bubble.style.color = '#fff';
        bubble.innerHTML = ''
          + '<span style="font-size:.68rem;font-weight:700">' + aimToGreen + 'y</span>'
          + '<span style="font-size:.52rem;opacity:.85;margin-left:4px">to hole</span>';
        try {
          var pt = this._map.project(aim);
          bubble.style.left = pt.x + 'px';
          bubble.style.top = pt.y + 'px';
          bubble.style.display = 'block';
        } catch(e) { bubble.style.display = 'none'; }
      } else {
        bubble.style.display = 'none';
      }
    }

    /* Start -> aim pill (always shown when geometry available). */
    if (pill) {
      var label = gpsActive ? 'from GPS' : (this._teeOverride ? 'from tee*' : 'from tee');
      var startToAim = (startPt && aim) ? geomDistanceYds(startPt, aim) : null;
      pill.innerHTML = ''
        + '<span style="background:#111;color:#fff;border-radius:999px;padding:3px 9px;font-size:.68rem">'
        +   (startToAim === null ? '\u2014' : startToAim + 'y')
        + '</span>'
        + '<span style="font-size:.56rem;color:#444">' + label + '</span>';
    }
  }

  /* G2b-R -- tap-to-move aim. Cheaper than dragging for small adjustments. */
  _handleMapClick(e) {
    this._aim = [e.lngLat.lng, e.lngLat.lat];
    if (this._aimMarker) {
      try { this._aimMarker.setLngLat(this._aim); } catch(err) {}
    } else {
      this._placeAimMarker();
    }
    this._renderAimLine();
    this._updateFloatingDists();
    if (this._onAimChange) { try { this._onAimChange(this._aim); } catch(err) {} }
    if (this._onMapClick)  { try { this._onMapClick(e);          } catch(err) {} }
  }

  _handleMapMove() {
    this._updateFloatingDists();
  }

  _placeUserMarker(ll) {
    if (!this._map) return;
    if (this._userMarker) this._userMarker.setLngLat(ll);
    else this._userMarker = new window.maplibregl.Marker({ color: '#4a90e2' }).setLngLat(ll).addTo(this._map);
  }

  _handleGpsTickInner(tick) {
    this._userLonLat = [tick[0], tick[1]];
    this._placeUserMarker(this._userLonLat);
    /* G2b -- cheap refresh: update path geometry + distance panel in place. */
    this._renderAimLine();
    this._updateFloatingDists();
    if (this._onGpsTick) { try { this._onGpsTick(this._userLonLat); } catch(e) {} }
  }

  _handleGpsErrorInner(err) {
    /* Reset GPS state so consumer can show "off" UI without leaking the watch. */
    this._gpsWatchId = null;
    this._gpsOn = false;
    if (this._userMarker) { try { this._userMarker.remove(); } catch(e) {} this._userMarker = null; }
    this._userLonLat = null;
    if (this._onGpsError) { try { this._onGpsError(err); } catch(e) {} }
  }

  /* ============================================================
     Convenience: zoom to green (used by live-round's zoom shortcut)
     ============================================================ */

  zoomGreen() {
    if (!this._map) return;
    var hole = this._curHoleGeo();
    if (!hole || !hole.green) return;
    this._map.flyTo({ center: hole.green, zoom: 17.5, pitch: 0 });
  }
}
